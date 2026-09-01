/**
 * Git worktree lifecycle for isolated agent sessions.
 *
 * Minimal single-direction flow (a deliberate trim of the full production
 * playbook): a "worktree" session materializes a DETACHED checkout (no
 * branch — git forbids the same branch in two worktrees, and branch naming
 * is a user-level decision deferred to merge time), works in isolation
 * (isolation rides on the per-turn cwd: every path guard eats req.cwd), then
 * merges its HEAD commit back into the local checkout and is removed.
 *
 * Managed root: <userData>/worktrees/<repo>/<sessionId-tail> — OUTSIDE every
 * registered project root, so the project-scoped IPC guards never see these
 * paths and no "second legal root" plumbing is needed for the MVP.
 *
 * Safety rails kept from the full design: dirty worktrees are never silently
 * destroyed (remove refuses unless force; merge-back auto-commits first), a
 * running turn blocks removal, and remove can export the uncommitted diff as
 * a patch before deleting (last-resort recovery).
 */
import { app } from "electron";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type simpleGitFn from "simple-git";
import type { GitWorktreeInfo, GitWorktreeMergeBackResult } from "@contracts/ipc";
import { WORKTREE_ROOT_SETTING_KEY } from "@contracts/ipc";
import { SessionRepo, SettingRepo } from "@main/store/repositories.js";
import { runtimeManager } from "@main/claude/RuntimeManager.js";
import { broadcastSessionChanged } from "@main/lib/sessionSync.js";
import { log } from "@main/lib/logger.js";

// Own lazy loader (mirrors git.ts's) — importing it from ipc/git.ts would
// create a cycle once the handlers there pull this module in.
let simpleGitLoader: typeof simpleGitFn | null = null;
async function loadSimpleGit(): Promise<typeof simpleGitFn> {
  if (!simpleGitLoader) {
    const mod = await import("simple-git");
    simpleGitLoader = mod.default;
  }
  return simpleGitLoader;
}

/** Normalize a path for map lookups (case-insensitive on win32, unified
 *  separators) — porcelain output vs. DB values may differ in surface form. */
function normKey(p: string): string {
  const ci = process.platform === "win32" || process.platform === "darwin";
  const n = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return ci ? n.toLowerCase() : n;
}

/** The managed root all worktrees live under: the configured directory
 *  (settings key `worktree.root`, read fresh each call so a change only
 *  affects future creations) or <userData>/worktrees by default. */
function managedWorktreeRoot(): string {
  const configured = SettingRepo.get(WORKTREE_ROOT_SETTING_KEY);
  if (configured && configured.trim()) return resolve(configured.trim());
  return join(app.getPath("userData"), "worktrees");
}

/** The managed directory a session's worktree lives in. Derived from the
 *  session id → replaying the materialization for the same session always
 *  derives the same path (idempotent by construction, for a given root).
 *  Now only the FALLBACK shape (detached HEAD / unresolvable branch). */
export function worktreeDirFor(repoPath: string, sessionId: string): string {
  const repoName = basename(repoPath).replace(/[^A-Za-z0-9._-]+/g, "-") || "repo";
  return join(managedWorktreeRoot(), repoName, sessionId.slice(-12));
}

/** Next managed worktree directory: `<managedRoot>/<repoName>/<branch>-<n>`
 *  — the repo's CURRENT checkout branch plus the lowest free sequence
 *  number, so a worktree's name says which branch it grew from ("用户可读
 *  目录名"). The branch is sanitized for filesystem use (Unicode letters
 *  and digits kept, everything else → `-`, matching the repoName rule);
 *  `n` starts at 1 and skips names already taken on disk (removal frees the
 *  number for reuse). Falls back to the legacy session-id tail when the
 *  branch can't be resolved (detached HEAD, not a repo). Async because the
 *  name must probe the filesystem for uniqueness — the old id-derived path
 *  was sync-idempotent, but a session materializes exactly once, so the
 *  loss of that property costs nothing. */
export async function nextWorktreeDir(
  repoPath: string,
  sessionId: string,
): Promise<string> {
  const root = join(
    managedWorktreeRoot(),
    basename(repoPath).replace(/[^A-Za-z0-9._-]+/g, "-") || "repo",
  );
  let branch = "";
  try {
    const git = (await loadSimpleGit())(repoPath);
    branch = (await git.raw(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  } catch {
    // detached HEAD reads fine here too; only a broken repo throws — the
    // legacy fallback below still yields a valid directory.
  }
  if (!branch || branch === "HEAD") {
    return worktreeDirFor(repoPath, sessionId);
  }
  const safe =
    branch
      .replace(/[^\p{L}\p{N}._-]+/gu, "-")
      .replace(/^-+|-+$/g, "") || "wt";
  for (let n = 1; ; n++) {
    const candidate = join(root, `${safe}-${n}`);
    const taken = await stat(candidate)
      .then(() => true)
      .catch(() => false);
    if (!taken) return candidate;
  }
}

/** Directory for pre-removal patch exports. */
function snapshotDir(): string {
  return join(app.getPath("userData"), "worktree-snapshots");
}

/** exit-code probe: is `commit` an ancestor of (or equal to) `ref`?
 *
 *  Deliberately NOT `merge-base --is-ancestor`: simple-git 3.36's `raw()`
 *  does NOT reject on a non-zero exit when stderr is empty (or even with
 *  merge-conflict stderr) — the probe's "no" answer (exit 1, no output)
 *  resolves silently, so a try/catch probe ALWAYS read as "ancestor". That
 *  made merge-back's already-merged guard fire on every call: ok without
 *  merging, no log line, dialog claiming success. Instead compare
 *  merge-base output: `commit` is an ancestor iff their best common
 *  ancestor IS `commit` itself (callers pass full SHAs; an abbreviated
 *  input would just compare unequal → false → merge proceeds → benign
 *  "Already up to date" no-op). */
async function isAncestor(
  git: import("simple-git").SimpleGit,
  commit: string,
  ref: string,
): Promise<boolean> {
  try {
    const base = (await git.raw(["merge-base", commit, ref])).trim();
    return !!base && base.toLowerCase() === commit.trim().toLowerCase();
  } catch {
    return false;
  }
}

/* ───────────────────────────── create ───────────────────────────── */

/** Create a detached worktree at `targetPath` based on `baseRef` (default:
 *  HEAD as seen from `repoPath` — the caller passes the USER's checkout, so
 *  the base is what the user was looking at, not some other worktree's HEAD).
 *  Returns the full HEAD commit of the new worktree. */
export async function createDetachedWorktree(
  repoPath: string,
  targetPath: string,
  baseRef = "HEAD",
): Promise<{ ok: true; head: string; path: string } | { ok: false; error: string }> {
  try {
    const git = (await loadSimpleGit())(repoPath);
    // Resolve the base to a concrete commit first — makes the checkout
    // immune to ref movement between resolve and add, and rejects bad refs
    // with a clean error instead of a half-created worktree.
    const base = (await git.revparse(["--verify", "--end-of-options", `${baseRef}^{commit}`])).trim();
    await mkdir(dirname(targetPath), { recursive: true });
    await git.raw(["worktree", "add", "--detach", targetPath, base]);
    const wtGit = (await loadSimpleGit())(targetPath);
    const head = (await wtGit.revparse(["HEAD"])).trim();
    log.info(`worktree created: ${targetPath} (base ${base.slice(0, 7)} from ${repoPath})`);
    return { ok: true, head, path: targetPath };
  } catch (err) {
    const msg = (err as Error).message || String(err);
    log.warn(`worktree create failed for ${repoPath} -> ${targetPath}: ${msg}`);
    return { ok: false, error: msg };
  }
}

/* ───────────────────────────── list ───────────────────────────── */

/** Parse `git worktree list --porcelain` blocks. */
function parsePorcelain(raw: string): Array<{ path: string; head: string; branch: string }> {
  const out: Array<{ path: string; head: string; branch: string }> = [];
  for (const block of raw.split(/\n\s*\n/)) {
    let path = "";
    let head = "";
    let branch = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice("worktree ".length).trim();
      else if (line.startsWith("HEAD ")) head = line.slice("HEAD ".length).trim();
      else if (line.startsWith("branch ")) branch = line.slice("branch ".length).replace(/^refs\/heads\//, "").trim();
    }
    if (path) out.push({ path, head, branch });
  }
  return out;
}

/** List the repo's worktrees (main first) enriched with lifecycle state:
 *  dirty / missing / session-reference count / already-merged. */
export async function listWorktrees(repoPath: string): Promise<GitWorktreeInfo[]> {
  const git = (await loadSimpleGit())(repoPath);
  const raw = await git.raw(["worktree", "list", "--porcelain"]);
  const entries = parsePorcelain(raw);
  const mainHead = entries[0]?.head ?? "";
  const refCounts = SessionRepo.worktreeReferenceCounts();
  const refCountMap = new Map(Object.entries(refCounts).map(([p, n]) => [normKey(p), n]));
  const gitFn = await loadSimpleGit();

  const enriched = await Promise.all(
    entries.map(async (e, idx) => {
      const missing = !(await stat(e.path).then(() => true).catch(() => false));
      let dirty = false;
      if (!missing) {
        dirty = await gitFn(e.path)
          .status()
          .then((st) => st.files.length > 0)
          .catch(() => false);
      }
      // "Merged" = NOTHING left to merge: HEAD contained in the MAIN
      // worktree's HEAD AND the tree clean. The ancestor probe alone is
      // trivially true in the dominant flow (worktrees detach at the main
      // HEAD and the agent edits WITHOUT committing, so HEADs stay equal
      // until merge-back's auto-commit) — it would badge a tree full of
      // unmerged uncommitted work as "merged", and the panel renders merged
      // INSTEAD of dirty, i.e. a green "safe to delete" signal. Skipped for
      // the main entry itself (idx 0).
      const merged =
        idx > 0 && !missing && e.head && !dirty
          ? await isAncestor(git, e.head, mainHead).catch(() => false)
          : false;
      return {
        path: e.path,
        head: e.head.slice(0, 7),
        branch: e.branch,
        main: idx === 0,
        dirty,
        missing,
        referencedBy: refCountMap.get(normKey(e.path)) ?? 0,
        merged,
      } satisfies GitWorktreeInfo;
    }),
  );
  return enriched;
}

/* ─────────────────────────── merge back ─────────────────────────── */

/** Commit-on-detached-HEAD helper. Falls back to inline identity config
 *  when the repo has no user.name/email configured (fresh clones often
 *  don't) — without this the auto-commit would fail and block the merge. */
async function commitAll(
  wtGit: import("simple-git").SimpleGit,
  message: string,
): Promise<void> {
  try {
    await wtGit.raw(["add", "-A"]);
    await wtGit.commit(message);
  } catch (err) {
    const msg = (err as Error).message || "";
    if (/author identity|user\.name|user\.email/i.test(msg)) {
      await wtGit.raw([
        "-c", "user.name=Mcode",
        "-c", "user.email=mcode@local",
        "commit", "-m", message,
      ]);
    } else {
      throw err;
    }
  }
}

/** Default commit message for the pre-merge auto-commit (used when the user
 *  left the dialog's message input blank). */
function autoCommitMessage(worktreePath: string): string {
  return `worktree: auto-commit before merge back (${basename(worktreePath)})`;
}

/** Merge a worktree's work back into the local checkout's CURRENT branch:
 *  auto-commit uncommitted changes on the detached HEAD, then
 *  `git merge --no-edit <worktree HEAD>` in the local repo. Conflicts are
 *  reported (the repo is left merging; the existing conflict-resolution UI
 *  applies) and do NOT remove the worktree — the user resolves and retries
 *  or aborts. */
export async function mergeBackWorktree(
  repoPath: string,
  worktreePath: string,
  opts: { message?: string } = {},
): Promise<GitWorktreeMergeBackResult> {
  try {
    const wtGit = (await loadSimpleGit())(worktreePath);
    const st = await wtGit.status();
    let committedChanges = false;
    if (st.files.length > 0) {
      const message = opts.message?.trim() || autoCommitMessage(worktreePath);
      await commitAll(wtGit, message);
      committedChanges = true;
    }
    const head = (await wtGit.revparse(["HEAD"])).trim();

    const git = (await loadSimpleGit())(repoPath);
    const targetBranch = (await git.revparse(["--abbrev-ref", "HEAD"])).trim();
    const targetLabel = targetBranch === "HEAD" || !targetBranch ? "(detached)" : targetBranch;

    // Already-merged guard: merge would be a no-op.
    if (await isAncestor(git, head, "HEAD")) {
      log.info(`worktree merge-back no-op (already merged): ${worktreePath}`);
      return { ok: true, committedChanges, targetBranch: targetLabel, fastForward: false };
    }

    const headBefore = (await git.revparse(["HEAD"])).trim();
    // simple-git 3.36's raw() does NOT reject `git merge` on a non-zero
    // exit — a conflicted merge (and other aborts) RESOLVE silently — so the
    // old try/catch around the merge never fired and conflicts were
    // reported as success. Run it, then interrogate the repo state instead
    // of trusting the promise.
    let mergeThrew: unknown = null;
    try {
      await git.raw(["merge", "--no-edit", head]);
    } catch (err) {
      mergeThrew = err;
    }
    const st2 = await git.status().catch(() => null);
    const conflicted = st2?.conflicted ?? [];
    if (conflicted.length > 0) {
      log.warn(`worktree merge-back produced ${conflicted.length} conflict(s) in ${repoPath}`);
      return {
        ok: true,
        committedChanges,
        targetBranch: targetLabel,
        conflict: true,
        conflictedFiles: conflicted,
      };
    }
    if (mergeThrew) throw mergeThrew;
    // Swallowed non-conflict failures (e.g. "local changes would be
    // overwritten" abort) leave HEAD unchanged with no exception — verify
    // the merge actually landed via the (throw-independent) ancestor probe
    // instead of reporting a fake success.
    const headAfter = (await git.revparse(["HEAD"])).trim();
    if (headAfter === headBefore && !(await isAncestor(git, head, "HEAD"))) {
      throw new Error(
        "合并未生效:主仓库当前分支的未提交改动可能与待合并文件冲突,请先提交或暂存(stash)后重试",
      );
    }
    const fastForward = headAfter === head;
    log.info(
      `worktree merged back: ${worktreePath} -> ${repoPath}@${targetLabel} ` +
        `(${fastForward ? "fast-forward" : "merge commit"}${committedChanges ? ", auto-committed" : ""})`,
    );
    return { ok: true, committedChanges, targetBranch: targetLabel, fastForward };
  } catch (err) {
    const msg = (err as Error).message || String(err);
    log.warn(`worktree merge-back failed for ${worktreePath}: ${msg}`);
    return { ok: false, error: msg };
  }
}

/* ───────────────────────────── remove ───────────────────────────── */

/** Remove a linked worktree. Guards: (1) sessions referencing the path with
 *  running turns block removal; (2) a dirty worktree refuses unless `force`;
 *  (3) `exportPatch` persists the uncommitted diff under
 *  userData/worktree-snapshots/ before deleting. A missing directory is
 *  self-healed via `git worktree prune`. */
export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  opts: { force?: boolean; exportPatch?: boolean } = {},
): Promise<{ ok: boolean; error?: string; patchPath?: string }> {
  try {
    // (1) Never yank the directory out from under a running agent turn.
    const refs = SessionRepo.listByWorktreePath(worktreePath);
    if (refs.length > 0) {
      const running = new Set(runtimeManager.runningSessionIds());
      if (refs.some((s) => running.has(s.id))) {
        return { ok: false, error: "该工作树下有正在运行的会话回合,请先停止后再删除" };
      }
    }

    const dirExists = await stat(worktreePath).then(() => true).catch(() => false);
    let patchPath: string | undefined;

    // Is the path still a REGISTERED worktree? A previously FAILED remove
    // can leave a half-torn state behind on Windows (file locks): git drops
    // the .git/worktrees registration, then dies mid-directory-delete with
    // "Permission denied". Re-running `git worktree remove` then aborts with
    // "is not a working tree" even though only stale junk remains — detect
    // that case and fall through to plain directory cleanup instead of
    // surfacing the fatal to the user.
    const git = (await loadSimpleGit())(repoPath);
    const normTarget = normKey(worktreePath);
    const registered = await git
      .raw(["worktree", "list", "--porcelain"])
      .then((raw) => parsePorcelain(raw).some((w) => normKey(w.path) === normTarget))
      .catch(() => true); // probe failure → assume registered, try the git way

    if (registered && dirExists) {
      const wtGit = (await loadSimpleGit())(worktreePath);
      const st = await wtGit.status().catch(() => null);
      const dirty = !!st && st.files.length > 0;
      if (dirty && !opts.force) {
        return {
          ok: false,
          error: `工作树有 ${st!.files.length} 个未提交的更改,请先合并回、或勾选强制删除/导出补丁`,
        };
      }
      if (dirty && opts.exportPatch) {
        try {
          const patch = await wtGit.diff(["--binary", "--full-index", "HEAD"]);
          if (patch.trim()) {
            await mkdir(snapshotDir(), { recursive: true });
            const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
            patchPath = join(snapshotDir(), `${basename(worktreePath)}-${stamp}.patch`);
            await writeFile(patchPath, patch, "utf8");
            log.info(`worktree patch exported: ${patchPath}`);
          }
        } catch (patchErr) {
          // Patch export is a safety net, not a blocker — log and continue.
          log.warn(`worktree patch export failed: ${(patchErr as Error).message}`);
          patchPath = undefined;
        }
      }
    }

    if (registered) {
      try {
        await git.raw([
          "worktree",
          "remove",
          ...(opts.force ? ["--force"] : []),
          worktreePath,
        ]);
      } catch (removeErr) {
        // Directory already gone (deleted outside git) → prune self-heals.
        if (dirExists) throw removeErr;
        log.info(`worktree remove: dir missing for ${worktreePath}, pruning stale entry`);
      }
    } else {
      log.info(
        `worktree remove: ${worktreePath} is no longer a registered worktree — cleaning stale directory`,
      );
    }
    await git.raw(["worktree", "prune"]).catch(() => {});

    // Stale leftover directory (interrupted earlier remove, or an already-
    // unregistered path): git no longer owns it — delete it directly so the
    // second attempt actually finishes the first one's job.
    if (await stat(worktreePath).then(() => true).catch(() => false)) {
      try {
        await rm(worktreePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
      } catch (rmErr) {
        throw new Error(
          `清理残留目录失败:${(rmErr as Error).message}(目录可能仍被编辑器/终端占用,请关闭占用它的程序后重试)`,
        );
      }
    }

    // Degenerate referencing sessions back to local (worktreePath = NULL) so
    // their next turn doesn't hit the "directory missing" wall — the
    // conversation history stays intact and reusable. Broadcast each patched
    // row so the renderers drop their worktree badges.
    for (const s of refs) {
      SessionRepo.clearWorktreePath(s.id);
      const patched = SessionRepo.get(s.id);
      if (patched) broadcastSessionChanged(patched);
    }

    log.info(`worktree removed: ${worktreePath} (from ${repoPath})`);
    return { ok: true, patchPath };
  } catch (err) {
    const msg = (err as Error).message || String(err);
    log.warn(`worktree remove failed for ${worktreePath}: ${msg}`);
    return { ok: false, error: msg };
  }
}
