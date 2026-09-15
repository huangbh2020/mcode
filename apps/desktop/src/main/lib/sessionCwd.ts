import type { Project, Session } from "@contracts/session";
import { SessionRepo } from "@main/store/repositories.js";
import { log } from "@main/lib/logger.js";
import { broadcastSessionChanged } from "@main/lib/sessionSync.js";
import { createBranchedWorktree, createDetachedWorktree, nextWorktreeDir } from "@main/lib/worktreeOps.js";
import { stat } from "node:fs/promises";
import { join } from "node:path";

/** In-flight materializations, keyed by session id. Concurrent first turns
 *  (double-send, desktop + mobile racing) both observe `worktreePath: null`
 *  and would independently probe the disk for the next free directory — an
 *  interleaving that creates TWO worktrees, one of which the DB race orphans.
 *  The second caller awaits the first caller's promise instead.
 *
 *  Extracted from ipc/claude.ts (2026-09-15) so the orchestrator dispatcher
 *  can create worker sessions with the exact same environment semantics as
 *  user-driven turns. */
const materializing = new Map<string, Promise<string>>();

/** Resolve the working directory a session's turn must run in.
 *
 *  - local session → the project root (unchanged historical behavior);
 *  - worktree session, not yet materialized → create the detached worktree
 *    NOW (intent-first, materialize-on-first-turn), persist its path BEFORE
 *    the turn is dispatched (a crash between creation and turn-start still
 *    leaves the session pointing at its worktree), and return it. Concurrent
 *    materializations for the same session ride ONE in-flight promise;
 *  - materialized worktree session → its recorded path (restart-safe),
 *    with a friendly error when the directory has since disappeared.
 *
 *  Every downstream mechanism (write guard, bash guard, MCP injection,
 *  file snapshot) keys off this cwd, so isolation between parallel worktree
 *  sessions — and from the local checkout — rides on this single value. */
export async function resolveSessionCwd(session: Session, project: Project): Promise<string> {
  if (session.envMode !== "worktree") return project.path;

  if (!session.worktreePath) {
    const inFlight = materializing.get(session.id);
    if (inFlight) return inFlight;
    const p = materializeWorktreeSession(session, project).finally(() => {
      materializing.delete(session.id);
    });
    materializing.set(session.id, p);
    return p;
  }

  // Already materialized: verify the directory still exists.
  const exists = await stat(session.worktreePath).then(() => true).catch(() => false);
  if (!exists) {
    throw new Error(
      `会话的工作树目录已不存在:${session.worktreePath}(可能被手动删除)。请在 Git 面板清理后新建会话。`,
    );
  }
  return session.worktreePath;
}

/** The materialization half of resolveSessionCwd (un-materialized worktree
 *  intent only). Always called under the per-session in-flight lock above. */
async function materializeWorktreeSession(session: Session, project: Project): Promise<string> {
  // Materialize. The project root itself must be a git repo (the base is
  // HEAD as seen from the user's checkout). When it isn't, DEGRADE to
  // local instead of throwing (see ipc/claude.ts history for rationale).
  const hasGit = await stat(join(project.path, ".git"))
    .then(() => true)
    .catch(() => false);
  if (!hasGit) {
    log.warn(
      `worktree intent for session ${session.id} dropped — project root is not a git repo (${project.path}); running locally`,
    );
    SessionRepo.updateSettings(session.id, { envMode: "local", wtStyle: null });
    const downgraded = SessionRepo.get(session.id) ?? { ...session, envMode: "local" as const };
    broadcastSessionChanged(downgraded);
    return project.path;
  }
  // Form fork: "branch" materializes on a generated mcode/* ref (durable
  // named commits), anything else keeps the classic detached checkout.
  // nextWorktreeDir's branchStyle probe guarantees the branch name is free
  // BEFORE worktree add -b ever runs.
  const branchStyle = session.wtStyle === "branch";
  const target = await nextWorktreeDir(project.path, session.id, { branchStyle });
  const res = branchStyle
    ? await createBranchedWorktree(project.path, target)
    : await createDetachedWorktree(project.path, target);
  if (!res.ok) {
    throw new Error(`创建隔离工作树失败:${res.error}`);
  }
  SessionRepo.updateWorktreePath(session.id, target);
  // Re-read so the broadcast + the returned session snapshot both carry
  // the materialized path (renderer flips its badge off this).
  const updatedRow = SessionRepo.get(session.id) ?? session;
  broadcastSessionChanged(updatedRow);
  log.info(`worktree session materialized: ${session.id} -> ${target}`);
  return target;
}
