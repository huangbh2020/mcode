/**
 * Codex terminal-session resume reconciliation — the codex counterpart of
 * claudeCli.ts's reconcileTerminalClaudeSessionId.
 *
 * codex has NO first-run session pin (no --session-id equivalent), so the
 * first terminal open launches a bare `codex` and the rollout session uuid
 * is only discoverable after the fact: codex stores sessions under
 * ~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<ts>-<uuid>.jsonl. Driven from
 * the scrollback-save path (throttled), this adopts the newest rollout file
 * whose mtime postdates the session row's creation and that no other
 * terminal session claims, persisting it into claudeSessionId — restarts
 * then run `codex resume <uuid>`.
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

/** rollout-<ts>-<uuid>.jsonl → the uuid segment. */
function rolloutSessionId(fileName: string): string | null {
  if (!fileName.startsWith("rollout-") || !fileName.endsWith(".jsonl")) return null;
  const stem = fileName.slice("rollout-".length, -".jsonl".length);
  const m = stem.match(
    /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/,
  );
  return m ? m[1] : null;
}

export function reconcileCodexTerminalSessionId(
  session: Session,
  sessionsRoot = join(homedir(), ".codex", "sessions"),
): string | null {
  if (session.kind !== "terminal" || session.providerId !== "codex-sdk") return null;
  const now = Date.now();
  const last = reconcileLastAttempt.get(session.id) ?? 0;
  if (now - last < RECONCILE_THROTTLE_MS) return null;
  reconcileLastAttempt.set(session.id, now);

  try {
    // Idempotence: once adopted, the uuid is in the claimed set (this row
    // references it) and gets skipped like any other claimed file.
    const claimed = new Set(SessionRepo.listTerminalClaudeSessionIds());
    // Walk the yyyy/mm/dd tree collecting rollout candidates.
    let best: { id: string; mtime: number } | null = null;
    for (const year of readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (!year.isDirectory()) continue;
      const yearDir = join(sessionsRoot, year.name);
      for (const month of readdirSync(yearDir, { withFileTypes: true })) {
        if (!month.isDirectory()) continue;
        const monthDir = join(yearDir, month.name);
        for (const day of readdirSync(monthDir, { withFileTypes: true })) {
          if (!day.isDirectory()) continue;
          for (const name of readdirSync(join(monthDir, day.name))) {
            const id = rolloutSessionId(name);
            if (!id || claimed.has(id)) continue;
            let mtime: number;
            try {
              mtime = statSync(join(monthDir, day.name, name)).mtimeMs;
            } catch {
              continue;
            }
            if (mtime < session.createdAt - RECONCILE_CREATED_SLACK_MS) continue;
            if (!best || mtime > best.mtime) best = { id, mtime };
          }
        }
      }
    }
    if (!best) return null;

    SessionRepo.updateClaudeSessionId(session.id, best.id);
    const updated = SessionRepo.get(session.id);
    if (updated) broadcastSessionChanged(updated);
    log.info(`terminal session ${session.id}: adopted codex session id ${best.id}`);
    return best.id;
  } catch (err) {
    log.warn(
      `codex session reconcile failed for ${session.id}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
