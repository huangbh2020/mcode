/**
 * Shared Pi SDK lazy-loader with the worker_threads polyfill.
 *
 * Both the IPC handlers (piModels.listAvailable) and the provider
 * (PiAgentSdkProvider.startTurn) need to load @earendil-works/pi-coding-agent.
 * They must share a single loader so the polyfill runs exactly once and
 * before the first import — otherwise whichever caller imports first
 * triggers undici's module-init crash (see polyfillWorkerThreads).
 */
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { log } from "@main/lib/logger.js";
import { getManagedRuntimeRoot, listManagedVersions } from "@main/runtimes/managedRuntimeRoots.js";

let sdkModule: typeof import("@earendil-works/pi-coding-agent") | null = null;

/**
 * Polyfill `markAsUncloneable` on `node:worker_threads` before the Pi SDK
 * loads. The SDK pulls in undici@8.x, whose webidl module destructures
 * `markAsUncloneable` from `node:worker_threads` at module-init time and
 * calls it in the CacheStorage constructor (undici/index.js:179). That API
 * only exists on Node >= 22.14, but Electron 33 ships Node 20 — so the
 * import resolves to `undefined` and crashes at load time. Polyfilling
 * with a no-op (the real API only matters when the object is sent across a
 * MessageChannel, which Mcode never does with CacheStorage) lets the SDK
 * boot. Must run BEFORE the first `import("@earendil-works/pi-coding-agent")`.
 */
let polyfillApplied = false;
export function polyfillWorkerThreads(): void {
  if (polyfillApplied) return;
  polyfillApplied = true;
  try {
    const wt = require("node:worker_threads") as { markAsUncloneable?: unknown };
    if (typeof wt.markAsUncloneable !== "function") {
      wt.markAsUncloneable = function markAsUncloneable() {
        /* no-op — see jsdoc above */
      };
      log.info("pi: polyfilled worker_threads.markAsUncloneable for Node < 22.14");
    }
  } catch {
    /* worker_threads always available in main; ignore */
  }
}

/**
 * Resolve the pi library from the managed runtime dir
 * (`<userData>/runtimes/pi/<version>/node_modules/@earendil-works/
 * pi-coding-agent`) and import it by absolute file URL. This is how PACKAGED
 * builds load pi — the package is no longer bundled (its ~44MB dependency
 * closure is downloaded on demand; see runtimeInstaller.ts +
 * build/pack-pi-runtime.cjs). Bare-specifier resolution can't find it there,
 * so we read the package entry from its exports map ourselves. Dependency
 * imports inside the tree resolve via normal node_modules walking-up from
 * that dir.
 *
 * Versions are tried newest-first, and one whose module graph can't even be
 * IMPORTED steps down to the next version instead of killing pi outright.
 * This is the load-side twin of rollbackRuntime's "resolvers pick the newest
 * surviving dir" rule: keep-2 retention leaves the previous version on disk,
 * and a version that fails at import time fails for THIS app build
 * deterministically (e.g. pi 0.87.x statically imports `globSync` from
 * `node:fs` — Node ≥ 22.14 only, while Electron 33's main-process Node is
 * 20.x, so the ESM link step rejects the whole graph). Whole version dirs are
 * self-contained, so running the runner-up has no cross-version pairing
 * hazard (unlike claude, where wrapper and binary must stay on one train).
 *
 * Returns null when no managed install exists (caller falls back to the bare
 * specifier, which works in dev); throws only when versions exist but every
 * one of them failed to import.
 */
async function importManagedPiSdk(): Promise<typeof import("@earendil-works/pi-coding-agent") | null> {
  const root = getManagedRuntimeRoot();
  if (!root) return null;
  const failures: string[] = [];
  for (const version of listManagedVersions("pi")) {
    const pkgDir = join(root, "pi", version, "node_modules", "@earendil-works", "pi-coding-agent");
    const pkgJsonPath = join(pkgDir, "package.json");
    if (!existsSync(pkgJsonPath)) continue;
    let entryRel = "dist/index.js";
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
        exports?: Record<string, { import?: string; default?: string } | string>;
      };
      const rootExport = pkg.exports?.["."];
      const entry =
        typeof rootExport === "string" ? rootExport : rootExport?.import ?? rootExport?.default;
      if (typeof entry === "string" && entry.length > 0) entryRel = entry;
    } catch {
      // keep the default entry — layout matches the pinned version anyway
    }
    const entryPath = join(pkgDir, entryRel);
    if (!existsSync(entryPath)) continue;
    try {
      return await import(pathToFileURL(entryPath).href);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push(`v${version}: ${msg}`);
      log.warn(
        `pi: managed runtime v${version} failed to import, stepping down the version ladder: ${msg}`,
      );
    }
  }
  if (failures.length > 0) {
    throw new Error(`no loadable managed pi version — ${failures.join(" | ")}`);
  }
  return null;
}

/** Lazy-load the Pi SDK. Applies the worker_threads polyfill on the first
 *  call. Prefers the managed (downloaded) runtime and falls back to the bare
 *  specifier (dev node_modules). Throws a friendly error when neither exists
 *  — packaged builds without an installed runtime. Returns the cached module
 *  on subsequent calls. */
export async function loadPiSdk(): Promise<typeof import("@earendil-works/pi-coding-agent")> {
  if (!sdkModule) {
    polyfillWorkerThreads();
    const managed = await importManagedPiSdk().catch((err) => {
      throw new Error(
        `Pi runtime failed to load from the managed install: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    if (managed) {
      sdkModule = managed;
    } else {
      try {
        sdkModule = await import("@earendil-works/pi-coding-agent");
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === "ERR_MODULE_NOT_FOUND") {
          throw new Error(
            "Pi is not installed. Open Settings → Agent and install it (设置 → Agent → 安装).",
          );
        }
        throw err;
      }
    }
  }
  return sdkModule;
}
