/**
 * OpenCode CLI terminal-session resume reconciliation — the opencode
 * counterpart of codexSession.ts / agySession.ts.
 *
 * opencode has NO first-run session pin: `opencode -s <id>` REQUIRES an
 * existing session ("Session not found" otherwise — verified live on
 * 1.17.13), so the first terminal open launches a bare `opencode` and the
 * session id is only discoverable after the fact. opencode 1.x stores all
 * sessions in ONE SQLite database (~/.local/share/opencode/opencode.db,
 * WAL mode) — the `session` table carries `directory` (the launch cwd,
 * forward-slashed, e.g. "D:/proj") and `time_created` (epoch ms), which is
 * a tighter anchor than codex/agy's filesystem mtimes: candidates are
 * filtered by project directory FIRST, so an unrelated opencode window in
 * another project can never steal the adoption. The session row itself is
 * created lazily on the first message (a bare TUI open creates nothing),
 * which the throttled re-runs absorb naturally.
 *
 * Read via node:sqlite (NOT better-sqlite3): the host database must be
 * opened READ-ONLY — never checkpoint another app's WAL — and node:sqlite
 * is dependency-free, so the smoke can build a real fixture database
 * without an Electron-ABI native module (better-sqlite3 here is compiled
 * for Electron and refuses to load under plain node).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Session } from "@contracts/session";
import { SessionRepo } from "@main/store/repositories.js";
import { broadcastSessionChanged } from "@main/lib/sessionSync.js";
import { log } from "@main/lib/logger.js";

const RECONCILE_THROTTLE_MS = 30_000;
const reconcileLastAttempt = new Map<string, number>();
const RECONCILE_CREATED_SLACK_MS = 60_000;

function defaultDbPath(): string {
  return join(homedir(), ".local", "share", "opencode", "opencode.db");
}

/** Normalize a directory for comparison: opencode stores forward slashes
 *  ("D:/proj"); Mcode's project paths are native ("D:\proj"); drive-letter
 *  case drifts with how the CLI was invoked. Lowercase only on win32 —
 *  POSIX paths are case-sensitive. */
function normDirKey(p: string): string {
  const slashed = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? slashed.toLowerCase() : slashed;
}

/** One candidate row from the `session` table (only the fields we read). */
interface OpenCodeSessionRow {
  id: string;
  directory: string | null;
  time_created: number;
}

/** Read + filter in one pass so the caller sees only the adoptable winner.
 *  Split from reconcile for smoke steerability (fixture db path). */
function findNewestProjectSession(
  dbPath: string,
  projectKey: string,
  createdAfterMs: number,
  claimed: Set<string>,
): string | null {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const stmt = db.prepare(
      // parent_id excludes child sessions (opencode spawns subagent
      // sessions with a parent link); time_archived excludes sessions the
      // user archived inside opencode.
      "SELECT id, directory, time_created FROM session " +
        "WHERE parent_id IS NULL AND time_archived IS NULL AND time_created >= ? " +
        "ORDER BY time_created DESC",
    );
    const rows = stmt.all(createdAfterMs) as unknown as OpenCodeSessionRow[];
    for (const row of rows) {
      if (!row.id || claimed.has(row.id)) continue;
      if (!row.directory || normDirKey(row.directory) !== projectKey) continue;
      return row.id;
    }
    return null;
  } finally {
    db.close();
  }
}

export function reconcileOpenCodeTerminalSessionId(
  session: Session,
  /** Mcode project path — matched against opencode's session.directory. */
  projectPath: string,
  /** DB path override (smoke fixture). */
  dbPath = defaultDbPath(),
): string | null {
  if (session.kind !== "terminal" || session.providerId !== "opencode") return null;
  const now = Date.now();
  const last = reconcileLastAttempt.get(session.id) ?? 0;
  if (now - last < RECONCILE_THROTTLE_MS) return null;
  reconcileLastAttempt.set(session.id, now);

  try {
    // Idempotence: once adopted, the id is in the claimed set (this row
    // references it) and gets skipped like any other claimed session.
    const claimed = new Set(SessionRepo.listTerminalClaudeSessionIds());
    const projectKey = normDirKey(projectPath);
    const best = findNewestProjectSession(
      dbPath,
      projectKey,
      session.createdAt - RECONCILE_CREATED_SLACK_MS,
      claimed,
    );
    if (!best) return null;

    SessionRepo.updateClaudeSessionId(session.id, best);
    const updated = SessionRepo.get(session.id);
    if (updated) broadcastSessionChanged(updated);
    log.info(`terminal session ${session.id}: adopted opencode session id ${best}`);
    return best;
  } catch (err) {
    // DB not created yet (opencode never ran), locked, or schema drift —
    // all retryable on a later save tick; never propagate.
    log.warn(
      `opencode session reconcile failed for ${session.id}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
