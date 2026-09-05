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
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

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

  // 1) Direct require.resolve of the platform package's binary.
  const pkg = `@openai/codex-${platformSuffix()}`;
  try {
    // Resolve the platform package's package.json to get its directory —
    // robust across pnpm's virtual-store layout.
    const pkgJson = req.resolve(`${pkg}/package.json`);
    const dir = join(pkgJson, "..");
    const found = findBinaryInPackage(dir);
    if (found) return toUnpackedPath(found);
  } catch {
    // fall through
  }

  // 2) pnpm fallback: sibling node_modules next to the wrapper package.
  try {
    const wrapperJson = req.resolve("@openai/codex/package.json");
    const wrapperDir = join(wrapperJson, "..");
    const sibling = join(wrapperDir, "node_modules", pkg);
    if (existsSync(sibling)) {
      const found = findBinaryInPackage(sibling);
      if (found) return toUnpackedPath(found);
    }
  } catch {
    // fall through
  }

  // 3) Packaged-app fallback: construct directly from process.resourcesPath
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
