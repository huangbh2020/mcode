import type { Session } from "@contracts/session";
import { DEFAULT_PROVIDER_ID, type StartSessionInput } from "@contracts/ipc";
import { uid } from "@main/utils.js";
import { SessionRepo } from "@main/store/repositories.js";
import { runtimeManager } from "@main/claude/RuntimeManager.js";
import { log } from "@main/lib/logger.js";
import { broadcastSessionChanged } from "@main/lib/sessionSync.js";

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
export function createOrReuseSession(
  input: StartSessionInput,
  source: "desktop" | "mobile",
): { session: Session; reused: boolean } {
  // Side-chat Q&A sessions: every request creates a fresh row (one main
  // session → many side chats). No fresh-row reuse, no session.changed
  // broadcast — the desktop ask tab consumes the IPC return value directly
  // and mobile doesn't manage side chats at all.
  if (input.kind === "side") {
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
      });
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
  runtimeManager.bindSession(session);
  broadcastSessionChanged(session);
  log.info(`session started: ${session.id} (provider ${session.providerId}, project ${input.projectId}, ${source})`);
  return { session, reused: false };
}
