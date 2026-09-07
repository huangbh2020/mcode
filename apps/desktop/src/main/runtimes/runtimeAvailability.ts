/**
 * Display-oriented runtime availability probes for the settings panel.
 *
 * The resolvers answer "where do we spawn/load from" (managed first, then
 * fallbacks). The panel needs the SAME truth phrased for humans: which source
 * is active, and (for fallbacks) what version it is — otherwise a dev
 * checkout shows "not installed" while every agent works fine via
 * node_modules. `probeRuntimeAvailability` returns the effective source:
 *
 *   managed  — the on-demand install under userData/runtimes (this panel's
 *              install/remove operate on it)
 *   dev      — node_modules of a development checkout (pi/codex devDeps,
 *              claude's SDK platform optionalDependency); absent in packaged
 *              builds
 *   bundled  — a legacy build that still ships the payload in
 *              app.asar.unpacked
 *
 * Pure node — no electron import (shares modules with the headless codex
 * smoke chain).
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RuntimeAgentId } from "@contracts/ipc";
import {
  getManagedRuntimeRoot,
  listManagedVersions,
} from "./managedRuntimeRoots.js";
import {
  findCodexBinaryInPackage,
  resolveBundledCodexBinaryPath,
} from "@main/providers/codex-sdk/codexBinaryResolve.js";

export type RuntimeSource = "managed" | "dev" | "bundled";

export interface RuntimeAvailability {
  source: RuntimeSource;
  /** Version of the ACTIVE copy when cheaply readable (managed dir name /
   *  package.json); null when unknown (codex fallback binaries don't carry a
   *  cheaply-readable version). */
  version: string | null;
  /** Absolute path of the payload entry (binary / package.json). */
  path: string;
}

/** Map an asar-internal path to its on-disk unpacked counterpart. */
function toUnpackedPath(p: string): string {
  return p.includes("app.asar") ? p.replace("app.asar", "app.asar.unpacked") : p;
}

function classifyFallbackPath(path: string): RuntimeSource {
  return path.includes("app.asar") ? "bundled" : "dev";
}

function readPkgVersion(pkgJsonPath: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as { version?: string };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

/** Payload entry of an extracted/copied package dir — what a good runtime
 *  must contain. claude/codex = the spawned binary; pi = the library's
 *  package.json (the ESM entry resolves from its exports). */
export function payloadEntryPath(agent: RuntimeAgentId, packageDir: string): string | null {
  switch (agent) {
    case "claude":
      return join(packageDir, process.platform === "win32" ? "claude.exe" : "claude");
    case "codex":
      return findCodexBinaryInPackage(packageDir);
    case "pi":
      return join(packageDir, "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
  }
}

/** The newest managed version dir whose payload exists. */
export function installedManagedPayload(
  agent: RuntimeAgentId,
): { version: string; dir: string; entry: string } | null {
  const root = getManagedRuntimeRoot();
  if (!root) return null;
  for (const version of listManagedVersions(agent)) {
    const dir = join(root, agent, version);
    const entry = payloadEntryPath(agent, dir);
    if (entry && existsSync(entry)) return { version, dir, entry };
  }
  return null;
}

/* ── fallback probes (dev node_modules / legacy bundled) ── */

function probeClaudeFallback(): RuntimeAvailability | null {
  try {
    // The SDK's exports map doesn't expose ./package.json — resolve its main
    // entry instead, then switch to ITS require so pnpm's virtual-store
    // siblings (the platform binary package) resolve.
    const req = createRequire(import.meta.url);
    const sdkEntry = req.resolve("@anthropic-ai/claude-agent-sdk");
    const sdkReq = createRequire(sdkEntry);
    const suffix = `${process.platform}-${process.arch}`;
    const names = process.platform === "win32" ? ["claude.exe"] : ["claude"];
    for (const name of names) {
      let resolved: string | null = null;
      try {
        resolved = sdkReq.resolve(`@anthropic-ai/claude-agent-sdk-${suffix}/${name}`);
      } catch {
        continue;
      }
      const unpacked = toUnpackedPath(resolved);
      if (!existsSync(unpacked)) continue;
      return {
        source: classifyFallbackPath(unpacked),
        // The binary sits at the platform package root — version next to it.
        version: readPkgVersion(join(dirname(unpacked), "package.json")),
        path: unpacked,
      };
    }
  } catch {
    // SDK package not reachable from this context
  }
  return null;
}

function probeCodexFallback(): RuntimeAvailability | null {
  const binary = resolveBundledCodexBinaryPath();
  if (!binary) return null;
  // Version: the wrapper package's package.json (dev checkout only — in a
  // legacy bundled build it sits inside the asar, readable either way).
  let version: string | null = null;
  try {
    const req = createRequire(import.meta.url);
    version = readPkgVersion(req.resolve("@openai/codex/package.json"));
  } catch {
    // wrapper absent — leave version unknown
  }
  return { source: classifyFallbackPath(binary), version, path: binary };
}

function probePiFallback(): RuntimeAvailability | null {
  try {
    // pi is ESM-only (exports map has only "import" conditions), so
    // require.resolve CAN'T see it — the error is ERR_PACKAGE_PATH_NOT_EXPORTED
    // even when the package is right there. Use import.meta.resolve, which
    // follows the same ESM conditions as the bare dynamic import in
    // piSdkLoader: dev finds the devDependency, packaged builds (no package)
    // throw → null.
    const entryUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
    const entry = fileURLToPath(entryUrl);
    // entry = <pkg>/dist/index.js → package root two levels up.
    const pkgDir = dirname(dirname(entry));
    return {
      source: classifyFallbackPath(entry),
      version: readPkgVersion(join(pkgDir, "package.json")),
      path: join(pkgDir, "package.json"),
    };
  } catch {
    return null;
  }
}

/** Effective source for one agent: managed install first, then the fallback
 *  the resolvers would use. null = not available anywhere. */
export function probeRuntimeAvailability(agent: RuntimeAgentId): RuntimeAvailability | null {
  const managed = installedManagedPayload(agent);
  if (managed) return { source: "managed", version: managed.version, path: managed.entry };
  switch (agent) {
    case "claude":
      return probeClaudeFallback();
    case "codex":
      return probeCodexFallback();
    case "pi":
      return probePiFallback();
  }
}
