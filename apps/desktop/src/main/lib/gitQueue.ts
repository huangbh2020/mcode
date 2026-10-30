/**
 * gitQueue — per-repo git operation serialization + stale index.lock recovery.
 *
 * WHY THIS EXISTS (2026-10-30, "Unable to create '.../.git/modules/<sub>/
 * index.lock': File exists" on commit): every git op in the app ran fully
 * concurrently — the toolbar quick-commit widget polls `git status` every 10s
 * AND refetches on every git.changed broadcast (one fires the instant
 * `git add .` succeeds, racing the `git commit` that follows it), plus focus
 * refreshes, the right panel's GitRepoCard, and mobile RPC. In repos with
 * SUBMODULES, the parent repo's `git status` / `git add` / `git commit` all
 * descend into the submodule's git dir (`.git/modules/<name>/`) to refresh
 * its index — each needing a brief hold of that submodule's `index.lock`.
 * Two concurrent ops collide → git aborts with the fatal above. The lock
 * file is transient (gone once the winner finishes), so this reproduces
 * intermittently and no manual cleanup fixes it.
 *
 * Two layers:
 *
 * 1. `runGitOp(repoPath, op)` — a promise-chain mutex keyed by the resolved
 *    repo path. Mutating ops AND `git status` (which opportunistically
 *    writes the parent index stat-cache and submodule indexes) queue behind
 *    each other; different repos still run in parallel. Read-only object
 *    reads (log / show / diff / for-each-ref) stay unqueued so a slow push
 *    never freezes history browsing.
 *
 * 2. Stale-lock recovery — external actors (the user's terminal, an agent
 *    session's Bash git, an app-quit process-tree kill mid-index-write) can
 *    still hold or leave behind a lock. When an op fails with git's
 *    "Unable to create '<path>': File exists" and the reported path ends in
 *    `index.lock`, we consider removing it ONLY when it is unambiguously
 *    stale: mtime older than {@link STALE_LOCK_GRACE_MS} AND no local git
 *    process is currently running (the lock's owner would be one). Then the
 *    op is retried once — this is exactly the remedy git's own error message
 *    suggests, without the user having to open a terminal.
 */
import { execFile } from "node:child_process";
import { rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { log } from "@main/lib/logger.js";

const execFileAsync = promisify(execFile);

/* ───────────────────────── per-repo serialization ───────────────────────── */

/** Settled tail promises, keyed by resolved repo path. */
const queues = new Map<string, Promise<unknown>>();

function queueKey(repoPath: string): string {
  const abs = resolve(repoPath);
  // Windows paths are case-insensitive; D:\proj and d:\proj are one repo.
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

/**
 * Run `op` serialized against every other `runGitOp` on the same repo, with
 * stale-index.lock recovery around it. A predecessor's failure neither
 * poisons the chain nor skips this op; this op's own rejection still
 * propagates to its caller. The retry runs inside the queue slot — Mcode's
 * own ops can no longer collide with each other, so a lock error at that
 * point is by definition an external actor's.
 *
 * Acquire ONCE per user-visible operation at the handler/RPC layer — helpers
 * invoked inside an op must NOT re-acquire (awaiting the same queue from
 * inside a queued slot would deadlock on itself).
 */
export async function runGitOp<T>(repoPath: string, op: () => Promise<T>): Promise<T> {
  const key = queueKey(repoPath);
  const prev = queues.get(key) ?? Promise.resolve();
  const guarded = () => withStaleLockRetry(op);
  // `then(guarded, guarded)`: run after the predecessor settles either way —
  // a failed op must not poison the chain.
  const run = prev.then(guarded, guarded);
  // Store a never-rejecting tail so the chain outlives this op without
  // firing unhandled-rejection when the next op hasn't attached yet.
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  queues.set(key, tail);
  void tail.then(() => {
    // Prune the map entry once this op is the last one and has settled.
    if (queues.get(key) === tail) queues.delete(key);
  });
  return run;
}

/* ───────────────────────── stale index.lock recovery ───────────────────────── */

/** git's lock-contention fatal: `fatal: Unable to create '<path>': File
 *  exists.` — `<path>` is the exact lock git wanted to create (parent,
 *  worktree, or submodule git dir). Anchored to `index.lock` so we never
 *  auto-remove some other `.lock` (config.lock, HEAD.lock, …). */
const INDEX_LOCK_ERR_RE = /Unable to create '([^']+index\.lock)': File exists/;

/** Extract the lock path from an index.lock contention error, or null when
 *  the error is something else entirely. Exported for the smoke. */
export function extractIndexLockPath(message: string): string | null {
  return INDEX_LOCK_ERR_RE.exec(message)?.[1] ?? null;
}

/** A lock younger than this may belong to a live short git op (the git
 *  panel's own ops finish in well under a second; large adds take a few) —
 *  never touch it on age grounds alone. */
export const STALE_LOCK_GRACE_MS = 10_000;

/** Best-effort "is any local git command running right now?" — the
 *  conservative half of the staleness verdict: whoever holds an index.lock
 *  must be a git process, so any git process alive means we might be looking
 *  at a live lock (possibly for another repo — we stay out of it and let the
 *  user retry). Unverifiable (spawn failed) counts as "running". */
export async function isGitProcessRunning(): Promise<boolean> {
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync(
        "tasklist",
        ["/FI", "IMAGENAME eq git.exe", "/NH"],
        { timeout: 5_000 },
      );
      return /git\.exe/i.test(stdout);
    }
    const { stdout } = await execFileAsync("ps", ["-eo", "comm="], { timeout: 5_000 });
    return stdout.split("\n").some((line) => line.trim() === "git");
  } catch {
    return true;
  }
}

/** True when the lock at `lockPath` is unambiguously abandoned: it exists,
 *  its mtime is older than {@link STALE_LOCK_GRACE_MS}, and no git process
 *  is running that could own it. A missing lock file returns false — the
 *  retry will simply run against a free repo. */
export async function isStaleIndexLock(lockPath: string, now = Date.now()): Promise<boolean> {
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(lockPath)).mtimeMs;
  } catch {
    return false;
  }
  if (now - mtimeMs < STALE_LOCK_GRACE_MS) return false;
  return !(await isGitProcessRunning());
}

/**
 * Run `op` once; on an index.lock contention failure whose lock is verifiably
 * stale, remove the lock and retry once. Any other failure (or a lock that
 * looks live) surfaces the original git error untouched.
 */
export async function withStaleLockRetry<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const lockPath = extractIndexLockPath(msg);
    if (!lockPath) throw err;
    if (!(await isStaleIndexLock(lockPath))) throw err;
    try {
      await rm(lockPath, { force: true });
    } catch {
      throw err; // couldn't remove — let git's own error speak
    }
    log.warn(`gitQueue: removed stale index.lock at ${lockPath}, retrying git operation`);
    return await op();
  }
}
