/**
 * Shared claude SDK lazy-loader (the piSdkLoader pattern applied to the
 * claude JS wrapper — docs/agent-runtime-update.md §6).
 *
 * The wrapper (@anthropic-ai/claude-agent-sdk, a dep-free sdk.mjs) used to be
 * loaded only from the app bundle / dev node_modules, while the platform
 * BINARY was runtime-updatable — leaving wrapper and CLI permanently locked
 * to different release trains. Since installRuntime pairs the wrapper into
 * the SAME managed version dir as the binary, this loader prefers the
 * managed copy so wrapper + CLI always update (and roll back) together.
 * Falls back to the bare specifier (dev node_modules / the asar-bundled
 * copy) when no managed wrapper exists.
 *
 * The binary path is ALWAYS decided by the host via
 * `options.pathToClaudeCodeExecutable` (see sdkBinaryPath.ts) — the managed
 * wrapper's internal platform-package resolution never fires.
 *
 * Every runtime `import()` of the SDK goes through loadClaudeSdk() so a
 * managed install is honored consistently (provider, titleGen, customModel,
 * git commit-msg generation, automation intent parser). Type-only imports
 * stay on the dev dependency — compile-time types don't load code.
 */
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { log } from "@main/lib/logger.js";
import { getManagedRuntimeRoot, listManagedVersions } from "@main/runtimes/managedRuntimeRoots.js";

type ClaudeSdkModule = typeof import("@anthropic-ai/claude-agent-sdk");

let sdkModule: ClaudeSdkModule | null = null;

/** Import the managed wrapper (newest version dir that actually carries
 *  sdk.mjs — older installs from before the pairing change have the binary
 *  only, and are skipped by the existsSync check). Returns null when none. */
async function importManagedClaudeSdk(): Promise<ClaudeSdkModule | null> {
  const root = getManagedRuntimeRoot();
  if (!root) return null;
  for (const version of listManagedVersions("claude")) {
    const entryPath = join(root, "claude", version, "sdk.mjs");
    if (!existsSync(entryPath)) continue;
    return (await import(pathToFileURL(entryPath).href)) as ClaudeSdkModule;
  }
  return null;
}

/** Lazy-load the claude SDK. Prefers the managed (downloaded, version-paired
 *  with the binary) wrapper; falls back to the bare specifier (dev
 *  node_modules / asar copy). Returns the cached module on subsequent calls
 *  — the SDK has no known reload-safe pattern, so a runtime update applies
 *  from the next app launch (turn-level consistency is preserved: every
 *  caller in one session sees the same module). */
export async function loadClaudeSdk(): Promise<ClaudeSdkModule> {
  if (!sdkModule) {
    const managed = await importManagedClaudeSdk().catch((err) => {
      throw new Error(
        `Claude runtime failed to load from the managed install: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    if (managed) {
      sdkModule = managed;
      log.info("claude sdk: loaded from the managed runtime install (version-paired with the binary)");
    } else {
      sdkModule = await import("@anthropic-ai/claude-agent-sdk");
    }
  }
  return sdkModule;
}
