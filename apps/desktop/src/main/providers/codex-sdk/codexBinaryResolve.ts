/**
 * Resolve the path to the vendored `codex` binary shipped by the `@openai/codex`
 * npm package (platform-specific optionalDependencies like
 * `@openai/codex-darwin-arm64` carry the actual executable).
 *
 * WHY THIS EXISTS — same story as sdkBinaryPath.ts (Claude): in a packaged
 * Electron app the resolved path lives INSIDE `app.asar`, and
 * child_process.spawn cannot execute a binary inside the asar virtual
 * filesystem. electron-builder's `asarUnpack` copies matching files to
 * `app.asar.unpacked/...` on disk; Electron does NOT rewrite the path a
 * library hands to spawn, so we do the `app.asar` → `app.asar.unpacked`
 * rewrite ourselves.
 *
 * Layout notes (verified against @openai/codex 0.153.x):
 *   - the platform package ships `vendor/<triple>/bin/codex[.exe]` (new
 *     layout; `<pkg>/codex-package.json` marks it) with a legacy fallback of
 *     `<pkg>/codex/codex[.exe]` — we probe both.
 *   - the wrapper package `@openai/codex` lists platform packages in
 *     `optionalDependencies`; under pnpm they land in the virtual store, so
 *     we resolve via the wrapper's package.json directory when possible and
 *     fall back to direct require.resolve of the platform package.
 */
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { basename as pathBasename, join } from "node:path";

/** The platform-package suffix, e.g. "darwin-arm64" / "win32-x64". */
function platformSuffix(): string {
  return `${process.platform}-${process.arch}`;
}

/** The vendored triple directory per platform (vendor/<triple>/bin layout). */
function vendorTriple(): string | null {
  switch (`${process.platform}-${process.arch}`) {
    case "darwin-arm64": return "aarch64-apple-darwin";
    case "darwin-x64": return "x86_64-apple-darwin";
    case "linux-arm64": return "aarch64-unknown-linux-musl";
    case "linux-x64": return "x86_64-unknown-linux-musl";
    case "win32-x64": return "x86_64-pc-windows-msvc";
    case "win32-arm64": return "aarch64-pc-windows-msvc";
    default: return null;
  }
}

function binaryName(): string {
  return process.platform === "win32" ? "codex.exe" : "codex";
}

/** Map an asar-internal path to its on-disk unpacked counterpart. */
function toUnpackedPath(p: string): string {
  return p.includes("app.asar") ? p.replace("app.asar", "app.asar.unpacked") : p;
}

/** Probe a package dir for the vendored binary (new vendor layout first,
 *  legacy flat layout second). Returns null when neither exists. */
function findBinaryInPackage(pkgDir: string): string | null {
  const triple = vendorTriple();
  if (triple) {
    const vendorPath = join(pkgDir, "vendor", triple, "bin", binaryName());
    if (existsSync(vendorPath)) return vendorPath;
  }
  const legacyPath = join(pkgDir, "codex", binaryName());
  if (existsSync(legacyPath)) return legacyPath;
  return null;
}

/**
 * Resolve the codex binary path. In dev, resolves from node_modules (pnpm
 * layout aware). In a packaged app, returns the real on-disk path under
 * `app.asar.unpacked`. Returns null when nothing can be located (caller
 * surfaces a "Codex CLI 未安装" error).
 */
export function resolveCodexBinaryPath(): string | null {
  const req = createRequire(import.meta.url);
  const pkg = `@openai/codex-${platformSuffix()}`;

  // 1) Direct require.resolve of the platform package from the main chunk's
  //    context. Works under npm/yarn hoisted layouts; under pnpm the platform
  //    package is NOT hoisted into apps/desktop/node_modules, so this usually
  //    fails and we fall through to (2).
  try {
    const pkgJson = req.resolve(`${pkg}/package.json`);
    const dir = join(pkgJson, "..");
    const found = findBinaryInPackage(dir);
    if (found) return toUnpackedPath(found);
  } catch {
    // fall through
  }

  // 2) Resolve the platform package FROM the wrapper package's context —
  //    exactly how the wrapper's own bin/codex.js finds the binary. This
  //    handles pnpm's scope-sibling layout (the platform package lives at
  //    .pnpm/.../node_modules/@openai/codex-darwin-arm64, a SIBLING of
  //    @openai/codex, NOT a nested node_modules under it) and every hoisted
  //    layout alike, because it delegates to Node's own resolution.
  try {
    const wrapperJson = req.resolve("@openai/codex/package.json");
    const wrapperRequire = createRequire(wrapperJson);
    const platformJson = wrapperRequire.resolve(`${pkg}/package.json`);
    const dir = join(platformJson, "..");
    const found = findBinaryInPackage(dir);
    if (found) return toUnpackedPath(found);
  } catch {
    // fall through
  }

  // 3) pnpm store-direct probe. pnpm's symlink for the wrapper's aliased
  //    optional dep (`@openai/codex-darwin-arm64: npm:@openai/codex@x-plat`)
  //    is observed to DANGLE (it targets .../node_modules/@openai/codex while
  //    the store entry dir is .../@openai/codex-darwin-arm64), and pnpm
  //    reinstalls keep reverting manual repairs — so Node resolution (2)
  //    can't be trusted for this layout. Instead, locate the store entry by
  //    its deterministic directory name (@openai+codex@<ver>-<suffix>) and
  //    probe the package inside directly.
  try {
    const wrapperJson = req.resolve("@openai/codex/package.json");
    let dir = join(wrapperJson, "..");
    for (let i = 0; i < 8 && dir !== join(dir, ".."); i++) {
      if (pathBasename(dir) === ".pnpm") {
        const suffix = platformSuffix();
        for (const entry of readdirSync(dir)) {
          if (!entry.startsWith("@openai+codex@") || !entry.endsWith(`-${suffix}`)) continue;
          const candidate = join(dir, entry, "node_modules", "@openai", "codex-darwin-arm64");
          const found = findBinaryInPackage(candidate);
          if (found) return toUnpackedPath(found);
        }
        break;
      }
      dir = join(dir, "..");
    }
  } catch {
    // fall through
  }

  // 4) Packaged-app fallback: construct directly from process.resourcesPath
  //    (covers require.resolve failing to walk to node_modules from the main
  //    chunk's location).
  if (process.resourcesPath) {
    const direct = join(
      process.resourcesPath,
      "app.asar.unpacked",
      "node_modules",
      pkg,
    );
    if (existsSync(direct)) {
      const found = findBinaryInPackage(direct);
      if (found) return found;
    }
  }

  return null;
}
