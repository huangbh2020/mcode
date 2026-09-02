import type { Session } from "@contracts/session";
import { DEFAULT_PROVIDER_ID, type StartSessionInput } from "@contracts/ipc";
import { uid } from "@main/utils.js";
import { ProjectRepo, SessionRepo } from "@main/store/repositories.js";
import { runtimeManager } from "@main/claude/RuntimeManager.js";
import { log } from "@main/lib/logger.js";
import { broadcastSessionChanged } from "@main/lib/sessionSync.js";
import { normPathKey } from "@main/lib/pathNorm.js";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Shared implementation behind the desktop `claude:startSession` IPC and the
 *  mobile RPC of the same name: create a session row for a "new session"
 *  click — or REUSE the project's existing still-fresh row instead of
 *  stacking empty ones.
 *
 *  Reuse = bump the fresh row's `updated_at` (floating it back to the head of
 *  the project list, which sorts by `updated_at DESC`) and re-aim it at the
 *  requester's current config. A brand-new row is only created when the
 *  project has no fresh row left (first click, or the previous one was
 *  used/archived/deleted). */
/** Validate and apply a worktree BIND intent: the named directory must be
 *  an already-materialized worktree of some other session (never a raw
 *  arbitrary path — that would let a session escape the managed roots), and
 *  only meaningful with envMode="worktree". Writes the path onto the fresh
 *  row so its first turn reuses the checkout instead of creating one. */
function applyWorktreeBind(input: StartSessionInput, sessionId: string): void {
  if (input.envMode !== "worktree" || !input.worktreePath) return;
  const roots = SessionRepo.listWorktreeRoots();
  const target = normPathKey(input.worktreePath);
  if (!roots.some((r) => normPathKey(r) === target)) {
    log.warn(`worktree bind ignored — ${input.worktreePath} is not a managed worktree root`);
    return;
  }
  SessionRepo.updateWorktreePath(sessionId, input.worktreePath);
  log.info(`session ${sessionId} bound to existing worktree ${input.worktreePath}`);
}

/** Worktree intent can only materialize where the PROJECT ROOT is itself a
 *  git repo. The persisted new-session default (`session.worktreeDefault`)
 *  is project-agnostic, so a worktree choice made in one repo leaks into
 *  non-repo projects — where the composer chip is hidden and the user has no
 *  UI to flip it back, bricking the first turn (resolveSessionCwd). Coerce
 *  such rows to local right here. A BIND (explicit worktreePath) always
 *  survives: its checkout already exists, so the project root's repo-ness is
 *  irrelevant. */
function coerceEnvMode(input: StartSessionInput): "local" | "worktree" {
  if (input.envMode !== "worktree" || input.worktreePath) return input.envMode ?? "local";
  const project = ProjectRepo.get(input.projectId);
  // Unknown project: leave the intent alone, the turn path will fail loudly.
  if (!project) return "worktree";
  if (!existsSync(join(project.path, ".git"))) {
    log.warn(`worktree intent ignored — project root is not a git repo: ${project.path}`);
    return "local";
  }
  return "worktree";
}

export function createOrReuseSession(
  input: StartSessionInput,
  source: "desktop" | "mobile",
): { session: Session; reused: boolean } {
  // Side-chat Q&A sessions: reuse the parent's still-fresh "Quick ask" row
  // when one exists (same anti-stacking rule as main sessions below — a
  // placeholder title means the first question never landed, so the shell is
  // empty and refocusing it beats creating another one). No session.changed
  // broadcast — side chats are invisible to the left-bar/mobile lists by
  // design; the desktop ask tab consumes the IPC return value directly and
  // mobile doesn't manage side chats at all.
  if (input.kind === "side") {
    if (input.parentSessionId) {
      const fresh = SessionRepo.findFreshSideByParent(input.parentSessionId);
      if (fresh) {
        // Re-aim at the current composer config (updateSettings skips
        // undefined fields and bumps updated_at; the ask tab sorts by
        // created_at, so the row stays in place in its list).
        SessionRepo.updateSettings(fresh.id, {
          providerId: input.providerId,
          model: input.model,
          effort: input.effort,
          permissionMode: input.permissionMode,
          customModelId: input.customModelId ?? null,
        });
        const session = SessionRepo.get(fresh.id) ?? fresh;
        runtimeManager.bindSession(session);
        log.info(`side chat reused: ${session.id} (parent ${input.parentSessionId}, project ${input.projectId}, ${source})`);
        return { session, reused: true };
      }
    }
    const now = Date.now();
    const session: Session = {
      id: uid("sess_"),
      projectId: input.projectId,
      providerId: input.providerId ?? DEFAULT_PROVIDER_ID,
      claudeSessionId: null, // captured from system/init once the first turn runs
      kind: "side",
      parentSessionId: input.parentSessionId ?? null,
      // Placeholder until the first question rewrites it (sendTurn truncates
      // the first prompt to ~40 chars — same rule as main-session auto-title,
      // but no generateSessionTitle LLM call).
      title: "Quick ask",
      status: "idle",
      model: input.model ?? "default",
      effort: input.effort,
      permissionMode: input.permissionMode,
      customModelId: input.customModelId ?? null,
      archived: false,
      pinnedAt: null,
      contextSnapshot: null,
      todos: null,
      subagents: null,
      planDraft: null,
      turnFiles: null,
      usageHistory: null,
      bookmarks: null,
      subagentTranscripts: null,
      createdAt: now,
      updatedAt: now,
    };
    SessionRepo.create(session);
    runtimeManager.bindSession(session);
    log.info(
      `side chat started: ${session.id} (parent ${input.parentSessionId ?? "?"}, project ${input.projectId}, ${source})`,
    );
    return { session, reused: false };
  }

  // Coerced environment (non-repo projects can't carry worktree intent —
  // see coerceEnvMode); computed once for both write paths below.
  const envMode = coerceEnvMode(input);

  // Only a default-title request can reuse — an explicit title (none of our
  // UIs send one today) always deserves its own row.
  if (input.title === undefined || input.title === "New session") {
    const fresh = SessionRepo.findFreshByProject(input.projectId);
    if (fresh) {
      // Re-aim at the current composer config. `updateSettings` skips
      // undefined fields, so unset inputs keep the row's stored value; a
      // fresh row has no messages yet, so the per-session provider lock
      // doesn't apply. The write also bumps `updated_at`, which is what
      // floats the row back to the top of the list.
      SessionRepo.updateSettings(fresh.id, {
        providerId: input.providerId,
        model: input.model,
        effort: input.effort,
        permissionMode: input.permissionMode,
        customModelId: input.customModelId ?? null,
        envMode,
        // Worktree-form intent rides along with the environment flip; local
        // rows carry NULL so no stale intent survives a re-aim.
        wtStyle: envMode === "worktree" ? (input.wtStyle ?? "detached") : null,
        // A fresh row reused as a local thread must not keep a worktree path
        // left over from an earlier bind — it would render under the wrong
        // left-bar group with a fork badge while actually running in the
        // project root. Fresh rows are by definition un-materialized, so
        // clearing is always safe here.
        worktreePath: envMode === "worktree" ? undefined : null,
      });
      applyWorktreeBind(input, fresh.id);
      const session = SessionRepo.get(fresh.id) ?? fresh;
      runtimeManager.bindSession(session);
      broadcastSessionChanged(session);
      log.info(`session reused: ${session.id} (project ${input.projectId}, ${source})`);
      return { session, reused: true };
    }
  }

  const now = Date.now();
  const session: Session = {
    id: uid("sess_"),
    projectId: input.projectId,
    providerId: input.providerId ?? DEFAULT_PROVIDER_ID,
    claudeSessionId: null, // captured from system/init once the first turn runs
    kind: "chat",
    parentSessionId: null,
    title: input.title ?? "New session",
    status: "idle",
    model: input.model ?? "default",
    effort: input.effort,
    permissionMode: input.permissionMode,
    customModelId: input.customModelId ?? null,
    // Isolated-environment intent; the worktree materializes on first turn.
    // Coerced to local for non-repo projects (see coerceEnvMode).
    envMode,
    wtStyle: envMode === "worktree" ? (input.wtStyle ?? "detached") : null,
    worktreePath: null,
    archived: false,
    pinnedAt: null, // new sessions are never pinned
    contextSnapshot: null,
    todos: null,
    subagents: null,
    planDraft: null,
    turnFiles: null,
    usageHistory: null,
    bookmarks: null,
    subagentTranscripts: null,
    createdAt: now,
    updatedAt: now,
  };
  SessionRepo.create(session);
  applyWorktreeBind(input, session.id);
  // Re-read after the bind: applyWorktreeBind writes worktree_path directly
  // to the DB, and broadcasting/returning the stale in-memory object (which
  // carries worktreePath: null) made the renderer file the new session under
  // the project's flat list instead of its worktree group.
  const bound = SessionRepo.get(session.id) ?? session;
  runtimeManager.bindSession(bound);
  broadcastSessionChanged(bound);
  log.info(`session started: ${bound.id} (provider ${bound.providerId}, project ${input.projectId}, ${source})`);
  return { session: bound, reused: false };
}
