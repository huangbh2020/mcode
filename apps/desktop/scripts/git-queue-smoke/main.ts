/**
 * Headless smoke for main/lib/gitQueue.ts — the per-repo git operation mutex
 * + stale index.lock recovery behind the git IPC handlers.
 *
 * Covers:
 *  A. runGitOp serialization — same-repo ops never overlap (tracked with
 *     manual gates, no sleeps), a failed op doesn't poison the chain, its
 *     rejection still reaches its own caller, different repos run
 *     concurrently, win32 case-insensitive repo keys.
 *  B. Verdict pieces — extractIndexLockPath against the REAL user-reported
 *     fatal (parent + submodule git-dir shapes), age gate of
 *     isStaleIndexLock (missing file / fresh mtime).
 *  C. End-to-end with REAL git — a genuinely old `.git/index.lock` blocking
 *     `git add` gets removed and the add retried to success; a FRESH lock is
 *     left alone and the original git error surfaces; the submodule-shaped
 *     `.git/modules/<sub>/index.lock` path is extracted and removed; exactly
 *     one retry (op called twice) when the failure persists; five concurrent
 *     queued `git add`s all succeed.
 *  D. isGitProcessRunning — true while a spawned `git cat-file --batch`
 *     (reads stdin, stays alive) is running, false after it is killed. Runs
 *     LAST so the standing process can't skew the C verdicts.
 */
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { mkdtemp, rm, utimes, writeFile, stat, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { simpleGit } from "simple-git";
import {
  extractIndexLockPath,
  isGitProcessRunning,
  isStaleIndexLock,
  runGitOp,
  STALE_LOCK_GRACE_MS,
  withStaleLockRetry,
} from "@main/lib/gitQueue.js";
import { warnings } from "./stub-logger.js";

const execFileAsync = promisify(execFile);

let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed += 1;
  } else {
    console.log(`ok: ${msg}`);
  }
}

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mcode-git-queue-smoke-"));
  await execFileAsync("git", ["init", "--quiet", dir]);
  return dir;
}

/** Old-mtime lock file (2× grace) — unambiguously stale on age grounds. */
async function placeOldLock(lockPath: string): Promise<void> {
  await mkdir(join(lockPath, ".."), { recursive: true });
  await writeFile(lockPath, "stale");
  const past = new Date(Date.now() - 2 * STALE_LOCK_GRACE_MS);
  await utimes(lockPath, past, past);
}

async function placeFreshLock(lockPath: string): Promise<void> {
  await mkdir(join(lockPath, ".."), { recursive: true });
  await writeFile(lockPath, "fresh");
}

/* ───────────────── A. per-repo serialization ───────────────── */

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** True when `p` settles within `ms`, else "timeout" — lets a CORRECTLY
 *  blocked queued op fail an assertion instead of hanging the smoke. */
function within<T>(p: Promise<T>, ms: number): Promise<T | "timeout"> {
  return Promise.race([
    p,
    new Promise<"timeout">((r) => setTimeout(() => r("timeout"), ms)),
  ]);
}

async function testSerialization(): Promise<void> {
  const repo = join(tmpdir(), "mcode-git-queue-smoke-virtual-repo-A");

  // 1. Same-repo ops run strictly sequentially, in submission order: B must
  //    not even START while A is gated.
  {
    const events: string[] = [];
    const gate = deferred();
    const opA = runGitOp(repo, async () => {
      events.push("a:start");
      await gate.promise;
      events.push("a:end");
    });
    const opB = runGitOp(repo, async () => {
      events.push("b:start");
      events.push("b:end");
    });
    // One beat of the event loop — a broken mutex would let B start here.
    await new Promise((r) => setTimeout(r, 30));
    assert(!events.includes("b:start"), "B did not start while A held the queue");
    gate.resolve();
    await opA;
    await opB;
    assert(
      events.join(",") === "a:start,a:end,b:start,b:end",
      `same-repo ops strictly ordered (got: ${events.join(",")})`,
    );
  }

  // 2. A failed op doesn't poison the chain — the next op still runs, and
  //    the failure reaches its own caller only.
  {
    let ranAfter = false;
    const boom = runGitOp(repo, async () => {
      throw new Error("boom");
    });
    const after = runGitOp(repo, async () => {
      ranAfter = true;
      return "ok";
    });
    let rejected = false;
    await boom.catch(() => {
      rejected = true;
    });
    assert(rejected, "failing op's rejection reaches its own caller");
    assert((await after) === "ok", "next queued op runs after a failed one");
    assert(ranAfter, "failure did not skip the successor");
  }

  // 3. Different repos run concurrently: B finishes while A is gated.
  {
    const repoB = join(tmpdir(), "mcode-git-queue-smoke-virtual-repo-B");
    const gate = deferred();
    let aDone = false;
    const opA = runGitOp(repo, async () => {
      await gate.promise;
      aDone = true;
    });
    const opB = runGitOp(repoB, async () => "b");
    const outcome = await within(opB, 300);
    assert(outcome === "b", "other-repo op finished while first repo still gated");
    assert(!aDone, "first repo op still gated when the other repo finished");
    gate.resolve();
    await opA;
  }

  // 4. win32 case-insensitive repo key: same repo in different case shares
  //    the queue (host is win32; the assertion only runs there).
  {
    if (process.platform === "win32") {
      const lower = join(tmpdir(), "mcode-git-queue-smoke-virtual-repo-c");
      const upper = lower.toLowerCase() === lower ? lower.toUpperCase() : lower;
      const gate = deferred();
      let aDone = false;
      const opA = runGitOp(lower, async () => {
        await gate.promise;
        aDone = true;
      });
      const opB = runGitOp(upper, async () => "b");
      const outcome = await within(opB, 300);
      assert(outcome === "timeout", "case-variant repo path shares one queue on win32");
      gate.resolve();
      await opA;
    }
  }
}

/* ───────────────── B. verdict pieces ───────────────── */

async function testVerdictPieces(): Promise<void> {
  // The exact fatal from the user report (parent repo index).
  const parentMsg =
    "fatal: Unable to create 'D:/workspace/lfl/.git/index.lock': File exists. Another git process seems to be running in this repository.";
  assert(
    extractIndexLockPath(parentMsg) === "D:/workspace/lfl/.git/index.lock",
    "lock path extracted from parent-repo fatal",
  );

  // The reported failure shape: SUBMODULE git dir under .git/modules/.
  const subMsg =
    "fatal: Unable to create 'D:/workspace/lfl/.git/modules/lfl-core/index.lock': File exists. Another git process seems to be running in this repository, e.g. an editor opened by 'git commit'. Please make sure all processes are terminated then try again. If it still fails, a git process may have crashed in this repository earlier: remove the file manually to continue.";
  assert(
    extractIndexLockPath(subMsg) === "D:/workspace/lfl/.git/modules/lfl-core/index.lock",
    "lock path extracted from submodule git-dir fatal",
  );

  // Unrelated errors → null (no lock removal, no retry).
  assert(
    extractIndexLockPath("error: pathspec 'x' did not match any file(s) known to git") === null,
    "non-lock git error yields null lock path",
  );
  assert(
    extractIndexLockPath("fatal: Unable to create 'C:/r/.git/config.lock': File exists.") === null,
    "non-index .lock files are never matched (config.lock)",
  );

  const missing = join(tmpdir(), "mcode-git-queue-smoke-nope", "index.lock");
  assert(
    (await isStaleIndexLock(missing)) === false,
    "missing lock file is not 'stale' (retry simply runs)",
  );

  const freshRepo = await makeRepo();
  try {
    const fresh = join(freshRepo, ".git", "index.lock");
    await placeFreshLock(fresh);
    assert(
      (await isStaleIndexLock(fresh)) === false,
      "fresh-mtime lock is never treated as stale (age gate short-circuits)",
    );
  } finally {
    await rm(freshRepo, { recursive: true, force: true });
  }
}

/* ───────────────── C. real-git end-to-end ───────────────── */

async function testRealGit(): Promise<void> {
  // 1. Old stale lock blocking `git add` → removed + retried to success.
  {
    const repo = await makeRepo();
    try {
      await writeFile(join(repo, "base.txt"), "base");
      const lock = join(repo, ".git", "index.lock");
      await placeOldLock(lock);
      await writeFile(join(repo, "new.txt"), "new");
      const git = simpleGit(repo);
      let addErr = "";
      await runGitOp(repo, () => git.add(["."])).catch((e: Error) => {
        addErr = e.message;
      });
      assert(addErr === "", `recovery let git add through a stale lock (got: ${addErr.split("\n")[0]})`);
      const after = simpleGit(repo);
      const status = await after.status();
      assert(
        status.files.some((f) => f.path.replace(/\\/g, "/") === "new.txt" && f.index === "A"),
        "stale parent index.lock removed, retried git add staged the file",
      );
      let lockGone = false;
      try {
        await stat(lock);
      } catch {
        lockGone = true;
      }
      assert(lockGone, "stale lock file actually removed from disk");
      assert(
        warnings.some((w) => w.includes("removed stale index.lock")),
        "stale-lock removal logged a warning",
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }

  // 2. Fresh lock → left alone, git's original error surfaces.
  {
    const repo = await makeRepo();
    try {
      const lock = join(repo, ".git", "index.lock");
      await placeFreshLock(lock);
      await writeFile(join(repo, "new.txt"), "new");
      const git = simpleGit(repo);
      let errText = "";
      await runGitOp(repo, () => git.add(["."])).catch((e: Error) => {
        errText = e.message;
      });
      assert(
        /index\.lock/.test(errText),
        "fresh lock: original git error surfaces (no removal attempted)",
      );
      let stillThere = false;
      try {
        await stat(lock);
        stillThere = true;
      } catch {
        stillThere = false;
      }
      assert(stillThere, "fresh lock file was NOT removed");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }

  // 3. Submodule-shaped lock path (.git/modules/<sub>/index.lock): an op
  //    failing with that path (the exact reported bug shape) gets the nested
  //    lock removed and retries to success.
  {
    const repo = await makeRepo();
    try {
      const subLock = join(repo, ".git", "modules", "lfl-core", "index.lock");
      await placeOldLock(subLock);
      let calls = 0;
      const result = await runGitOp(repo, async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error(
            `fatal: Unable to create '${subLock.replace(/\\/g, "/")}': File exists. ` +
              "Another git process seems to be running in this repository.",
          );
        }
        return "committed";
      });
      assert(result === "committed", "submodule lock: op retried to success");
      assert(calls === 2, "submodule lock: exactly one retry");
      let gone = false;
      try {
        await stat(subLock);
      } catch {
        gone = true;
      }
      assert(gone, "nested .git/modules/<sub>/index.lock removed");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }

  // 4. Persisting lock failure → exactly one retry, then the error surfaces.
  {
    const repo = await makeRepo();
    try {
      const lock = join(repo, ".git", "index.lock");
      await placeOldLock(lock);
      let calls = 0;
      let rejected = false;
      await withStaleLockRetry(async () => {
        calls += 1;
        throw new Error(
          `fatal: Unable to create '${lock.replace(/\\/g, "/")}': File exists.`,
        );
      }).catch(() => {
        rejected = true;
      });
      assert(rejected, "persisting lock failure still rejects");
      assert(calls === 2, "retry is capped at exactly one extra attempt");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }

  // 5. Five concurrent queued `git add`s on one real repo — all succeed
  //    (serialized, so no index.lock collision is even possible).
  {
    const repo = await makeRepo();
    try {
      const git = simpleGit(repo);
      for (let i = 0; i < 5; i++) {
        await writeFile(join(repo, `f${i}.txt`), String(i));
      }
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          runGitOp(repo, () => git.add([`f${i}.txt`])).then(() => i),
        ),
      );
      assert(
        results.join(",") === "0,1,2,3,4",
        "five concurrent queued adds all succeeded",
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }
}

/* ───────────────── D. git process detection ───────────────── */

async function testProcessDetection(): Promise<void> {
  assert(
    typeof (await isGitProcessRunning()) === "boolean",
    "isGitProcessRunning returns a boolean on this platform",
  );

  // A `git cat-file --batch` reads stdin commands and stays alive — a
  // deterministic long-lived git.exe for the "process running" half.
  const child = spawn("git", ["cat-file", "--batch"], {
    stdio: ["pipe", "ignore", "ignore"],
  });
  try {
    await new Promise((r) => setTimeout(r, 500));
    assert(
      (await isGitProcessRunning()) === true,
      "live git.exe detected while cat-file --batch runs",
    );
  } finally {
    child.kill();
    await new Promise<void>((resolve) => {
      child.on("close", () => resolve());
      setTimeout(() => resolve(), 2000); // don't hang the smoke on exit races
    });
    await new Promise((r) => setTimeout(r, 500));
  }
  assert(
    (await isGitProcessRunning()) === false,
    "no git process detected after kill (environment-dependent: fails if another git.exe is genuinely running)",
  );
}

async function main(): Promise<void> {
  await testSerialization();
  await testVerdictPieces();
  await testRealGit();
  await testProcessDetection();
  if (failed > 0) {
    console.error(`\n${failed} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\nall git-queue-smoke assertions passed");
  process.exit(0);
}

void main();
