/**
 * Session auto-archiver — periodically archives stale sessions per the rules
 * persisted under AUTO_ARCHIVE_SETTING_KEY (see contracts/ipc.ts).
 *
 * A session is archived when its `updated_at` (bumped by every activity:
 * turns, renames, pins…) is older than its project's effective threshold —
 * `overrides[projectId]` when set, otherwise `defaultDays`; a threshold of 0
 * means "never". Pinned and in-flight (running/approving) sessions are always
 * excluded.
 *
 * The rules are re-read from the settings table on every tick, so a settings
 * change takes effect on the next tick without any push sync. Each archived
 * row goes through the same `session.changed` broadcast as the manual archive
 * IPC, so the desktop left bar and every paired phone move the row into their
 * archived bin automatically. `setArchived` bumps `updated_at`, which keeps a
 * restored session from being immediately re-archived by the next tick.
 *
 * Scheduling mirrors updater.ts: a delayed first run after boot plus a
 * recurring interval, guarded by a module-level `initialized` flag. Every run
 * is wrapped so an archive failure never crashes the app — this is a
 * convenience, not a core path.
 */
import { AUTO_ARCHIVE_SETTING_KEY, parseAutoArchiveConfig } from "@contracts/ipc";
import { SettingRepo, SessionRepo } from "@main/store/repositories.js";
import { awaitDb } from "@main/store/db.js";
import { broadcastSessionChanged } from "@main/lib/sessionSync.js";
import { log } from "@main/lib/logger.js";

/** Delay before the first auto-archive pass after boot (ms) — lets the DB
 *  settle and avoids competing with startup work. */
const FIRST_RUN_DELAY_MS = 60_000;
/** Interval between auto-archive passes (ms) — every hour. */
const RECURRING_RUN_INTERVAL_MS = 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

let initialized = false;

/** One archive pass. Reads the current rules, archives every stale eligible
 *  session, and broadcasts each change. Returns the number of sessions
 *  archived (0 when the feature is disabled or nothing qualifies). */
export async function runAutoArchive(): Promise<number> {
  await awaitDb();
  const config = parseAutoArchiveConfig(SettingRepo.get(AUTO_ARCHIVE_SETTING_KEY));
  if (!config.enabled) return 0;

  // One candidate query at the earliest effective threshold; per-project
  // thresholds (which may be stricter, or 0 = never) are applied below.
  const thresholds = [config.defaultDays, ...Object.values(config.overrides)].filter((d) => d > 0);
  if (thresholds.length === 0) return 0;
  const cutoff = Date.now() - Math.min(...thresholds) * DAY_MS;

  let archived = 0;
  for (const session of SessionRepo.listStale(cutoff)) {
    // Never archive an in-flight turn — `running` (agent loop active) or
    // `approving` (blocked on a canUseTool / AskUserQuestion / plan approval).
    if (session.status === "running" || session.status === "approving") continue;
    const days = config.overrides[session.projectId] ?? config.defaultDays;
    if (days <= 0) continue;
    if (session.updatedAt >= Date.now() - days * DAY_MS) continue;

    SessionRepo.setArchived(session.id, true);
    const row = SessionRepo.get(session.id);
    if (!row) continue; // deleted concurrently — nothing to broadcast
    broadcastSessionChanged(row);
    archived += 1;
  }
  if (archived > 0) log.info(`auto-archive: archived ${archived} stale session(s)`);
  return archived;
}

/** Wire the delayed first run and the recurring interval. Idempotent. */
export function initAutoArchiver(): void {
  if (initialized) return;
  initialized = true;
  setTimeout(() => {
    void runAutoArchive().catch((err) => log.error(`auto-archive run failed: ${err}`));
  }, FIRST_RUN_DELAY_MS);
  setInterval(() => {
    void runAutoArchive().catch((err) => log.error(`auto-archive run failed: ${err}`));
  }, RECURRING_RUN_INTERVAL_MS);
}
