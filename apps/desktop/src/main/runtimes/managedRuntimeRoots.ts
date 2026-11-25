/**
 * Registration + scan helpers for the managed agent-runtime directory.
 *
 * The agent runtimes (the codex binary, the pi JS library) are NOT bundled
 * with the installer anymore — they are downloaded on demand into
 * `<userData>/runtimes/<agent>/<version>/` by runtimeInstaller.ts. The
 * resolvers (codex-sdk/codexBinaryResolve.ts, pi-sdk/piSdkLoader.ts) look
 * there FIRST and fall back to their legacy bundled lookups.
 *
 * Claude left the managed set on 2026-11-24: Claude sessions run the user's
 * own `claude` CLI (lib/claudeExecutable.ts), nothing is downloaded for it,
 * and the panel no longer offers it (ipc/runtimes.ts). The download pipeline
 * still knows the agent — see `removeOrphanedClaudeRuntime` for what happens
 * to copies earlier Mcode versions left on disk.
 *
 * This module is deliberately PURE node (no electron import): the codex
 * resolver participates in the headless app-server smoke bundle, which must
 * stay electron-free. main/index.ts calls `setManagedRuntimeRoot()` early
 * with `join(app.getPath("userData"), "runtimes")`; until that runs (or in
 * the smoke harness) the managed branch is a no-op.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import type { RuntimeAgentId } from "@contracts/ipc";

let managedRoot: string | null = null;

/** Called once from main/index.ts after the userData path is finalized. */
export function setManagedRuntimeRoot(root: string): void {
  managedRoot = root;
}

/** Root of the managed runtimes dir, or null before registration. */
export function getManagedRuntimeRoot(): string | null {
  return managedRoot;
}

/** Delete `<root>/claude` — the managed Claude runtime that earlier Mcode
 *  versions downloaded (200MB+ per version dir, two kept) and nothing reads
 *  any more. Only ever that one directory, which holds nothing but what the
 *  installer itself extracted. Best effort and asynchronous (it runs once
 *  per machine, off the startup path): a locked file (an older Mcode
 *  instance still running) leaves the rest for the next start. Resolves true
 *  when the directory is gone. */
export async function removeOrphanedClaudeRuntime(): Promise<boolean> {
  if (!managedRoot) return false;
  const dir = join(managedRoot, "claude");
  try {
    if (!existsSync(dir)) return false;
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    return !existsSync(dir);
  } catch {
    return false;
  }
}

/** "0.3.258" style compare — numeric per dot segment, non-numeric segments
 *  (shouldn't occur in our pinned versions) fall back to string compare.
 *  Returns <0 / 0 / >0 like a comparator. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".");
  const pb = b.split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const sa = pa[i] ?? "";
    const sb = pb[i] ?? "";
    const na = Number(sa);
    const nb = Number(sb);
    if (Number.isFinite(na) && Number.isFinite(nb) && sa !== "" && sb !== "") {
      if (na !== nb) return na - nb;
    } else if (sa !== sb) {
      return sa < sb ? -1 : 1;
    }
  }
  return 0;
}

/** Version subdirectories of `<root>/<agent>/` that actually exist on disk,
 *  sorted NEWEST first. A directory counts only when it's a real dir (guards
 *  against a stray file or a partially-renamed staging dir). */
export function listManagedVersions(agent: RuntimeAgentId): string[] {
  if (!managedRoot) return [];
  const dir = join(managedRoot, agent);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const versions: string[] = [];
  for (const entry of entries) {
    try {
      if (!statSync(join(dir, entry)).isDirectory()) continue;
    } catch {
      continue;
    }
    versions.push(entry);
  }
  versions.sort((a, b) => compareVersions(b, a));
  return versions;
}

/** Absolute path of the newest installed version dir for an agent (its
 *  payload existence is verified by the caller, who knows the layout). */
export function newestManagedVersionDir(agent: RuntimeAgentId): string | null {
  for (const version of listManagedVersions(agent)) {
    return join(managedRoot!, agent, version);
  }
  return null;
}
