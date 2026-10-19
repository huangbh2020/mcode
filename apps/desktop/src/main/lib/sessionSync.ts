/**
 * sessionSync — broadcast session-list mutations to every connected client.
 *
 * `RuntimeManager.emit` fans out events from INSIDE a turn only. Session-row
 * mutations (create / title / delete / archive / pin / rename) happen in the
 * desktop IPC handlers and the mobile RPC handlers — outside any turn — so
 * without this helper one client's list would go stale the moment the other
 * client mutates a row (mobile-created sessions never appearing on the
 * desktop until restart, and vice versa).
 *
 * The two transport channels mirror `RuntimeManager.emit` exactly:
 *  - `sendToRenderer(IPC.CLAUDE_EVENT, …)` → desktop renderer's `ingestEvent`
 *    (same channel the per-turn stream already uses; no new IPC surface).
 *  - `mobileEventBus.broadcast(e)` → every paired phone over SSE.
 *
 * Only SLIM rows are broadcast (see `SessionListEntry` in contracts/runtime):
 * the heavy per-session payloads (`turnFiles.before` can hold whole file
 * contents) must not ride a list-sync event.
 */
import { IPC } from "@contracts/ipc";
import type { RuntimeEvent, SessionListEntry } from "@contracts/runtime";
import type { Session } from "@contracts/session";
import { sendToRenderer } from "@main/window.js";
import { mobileEventBus } from "@main/mobile/MobileEventBus.js";

/** Strip the heavy per-session payloads, keeping only list-visible fields. */
export function toSessionListEntry(s: Session): SessionListEntry {
  const {
    contextSnapshot: _cs,
    todos: _td,
    subagents: _sa,
    planDraft: _pd,
    usageHistory: _uh,
    turnFiles: _tf,
    bookmarks: _bm,
    subagentTranscripts: _st,
    ...entry
  } = s;
  return entry;
}

/** A full {@link Session} SHAPE with the heavy per-session payloads nulled.
 * Used by the mobile RPC list endpoints (project:sessions / listPinned /
 * search): those responses cross the network — often an off-LAN tunnel with
 * a few Mbps — and a fat row can be hundreds of KB (`turnFiles.before` holds
 * whole file contents, `subagentTranscripts` full transcripts). Nulling keeps
 * the `Session` structural type (all heavy fields are nullable) so the
 * renderer's buckets accept the rows unchanged; the phone re-fetches the
 * full row via `session:get` when a session is actually opened. Mirrors
 * `materializeSessionEntry` on the renderer side (broadcast-created rows
 * have been slim-shaped since forever — this extends that to list loads). */
export function toSlimSession(s: Session): Session {
  return {
    ...toSessionListEntry(s),
    contextSnapshot: null,
    todos: null,
    subagents: null,
    planDraft: null,
    usageHistory: null,
    turnFiles: null,
    bookmarks: null,
    subagentTranscripts: null,
  };
}

/** Fan a generic out-of-turn RuntimeEvent out to every client — the desktop
 *  renderer over `claude:event` and every paired phone over the SSE bus.
 *  Out-of-turn here means events NOT flowing through a session runtime's own
 *  `emit` (session-list mutations, pending-request resolutions) — both
 *  transports receive the same envelope the in-turn stream uses. */
export function broadcastRuntimeEvent(e: RuntimeEvent): void {
  sendToRenderer(IPC.CLAUDE_EVENT, { channel: IPC.CLAUDE_EVENT, sessionId: e.sessionId, event: e });
  mobileEventBus.broadcast(e);
}

/** A session row was created or mutated — upsert it on every client. */
export function broadcastSessionChanged(session: Session): void {
  broadcastRuntimeEvent({ type: "session.changed", sessionId: session.id, session: toSessionListEntry(session) });
}

/** A session row was hard-deleted — drop it from every client's list. */
export function broadcastSessionDeleted(sessionId: string): void {
  broadcastRuntimeEvent({ type: "session.deleted", sessionId });
}

/** A repo's git state changed (commit / stage / unstage / push / pull /
 *  discard — issued by the desktop panel OR a paired phone). Every client
 *  bumps its per-repo git-change version so its git surfaces (status panel,
 *  commit history) re-fetch instead of going stale until a manual refresh.
 *  The mutating client also receives the echo — harmless, its own refresh is
 *  idempotent. */
export function broadcastGitChanged(repoPath: string): void {
  broadcastRuntimeEvent({ type: "git.changed", sessionId: "", repoPath });
}
