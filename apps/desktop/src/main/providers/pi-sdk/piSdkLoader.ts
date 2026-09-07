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
 * Returns null when no managed install exists (caller falls back to the bare
 * specifier, which works in dev).
 */
async function importManagedPiSdk(): Promise<typeof import("@earendil-works/pi-coding-agent") | null> {
  const root = getManagedRuntimeRoot();
  if (!root) return null;
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
    return await import(pathToFileURL(entryPath).href);
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
