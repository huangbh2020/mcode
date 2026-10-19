/**
 * Antigravity CLI (`agy`) terminal-session resume reconciliation — the agy
 * counterpart of codexSession.ts.
 *
 * Like codex, agy has NO first-run session pin: the first terminal open
 * launches a bare `agy`, and the conversation uuid is only discoverable
 * after the fact. agy stores one SQLite file per conversation under
 * ~/.gemini/antigravity-cli/conversations/<uuid>.db (the Antigravity CLI
 * shares the Gemini CLI's home directory — observed on agy 1.4.2). Driven
 * from the scrollback-save path (throttled), this adopts the newest
 * conversation file whose mtime postdates the session row's creation and
 * that no other terminal session claims, persisting it into
 * claudeSessionId — restarts then run `agy --conversation <uuid>`.
 */
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Session } from "@contracts/session";
import { SessionRepo } from "@main/store/repositories.js";
import { broadcastSessionChanged } from "@main/lib/sessionSync.js";
import { log } from "@main/lib/logger.js";

const RECONCILE_THROTTLE_MS = 30_000;
const reconcileLastAttempt = new Map<string, number>();
const RECONCILE_CREATED_SLACK_MS = 60_000;

export function reconcileAgyTerminalSessionId(
  session: Session,
  /** conversations dir override (smoke fixture). */
  conversationsRoot = join(homedir(), ".gemini", "antigravity-cli", "conversations"),
): string | null {
  if (session.kind !== "terminal" || session.providerId !== "antigravity") return null;
  const now = Date.now();
  const last = reconcileLastAttempt.get(session.id) ?? 0;
  if (now - last < RECONCILE_THROTTLE_MS) return null;
  reconcileLastAttempt.set(session.id, now);

  try {
    // Idempotence: once adopted, the uuid is in the claimed set.
    const claimed = new Set(SessionRepo.listTerminalClaudeSessionIds());
    let best: { id: string; mtime: number } | null = null;
    let files: string[];
    try {
      files = readdirSync(conversationsRoot);
    } catch {
      return null; // agy never ran yet — nothing to adopt
    }
    for (const name of files) {
      if (!name.endsWith(".db")) continue;
      const id = name.slice(0, -".db".length);
      if (!id || claimed.has(id)) continue;
      let mtime: number;
      try {
        mtime = statSync(join(conversationsRoot, name)).mtimeMs;
      } catch {
        continue;
      }
      if (mtime < session.createdAt - RECONCILE_CREATED_SLACK_MS) continue;
      if (!best || mtime > best.mtime) best = { id, mtime };
    }
    if (!best) return null;

    SessionRepo.updateClaudeSessionId(session.id, best.id);
    const updated = SessionRepo.get(session.id);
    if (updated) broadcastSessionChanged(updated);
    log.info(`terminal session ${session.id}: adopted agy conversation id ${best.id}`);
    return best.id;
  } catch (err) {
    log.warn(
      `agy session reconcile failed for ${session.id}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
