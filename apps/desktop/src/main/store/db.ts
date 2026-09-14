/**
 * SQLite persistence layer (better-sqlite3, native driver).
 *
 * History: P1 used sql.js (SQLite compiled to asm.js) so `pnpm dev` worked on
 * any machine with zero native compilation. sql.js is an in-memory database
 * that flushes by exporting the WHOLE file (`db.export()`) on every write —
 * which made the main process's RSS a linear function of database size: with
 * a ~210MB history the export copies alone pushed main to ~1.6GB (memory
 * analysis of 2026-09-14). This machine now has an MSVC toolchain, so the
 * original "no way to compile native addons" constraint is gone and we run
 * better-sqlite3: real SQLite accessing the file page-by-page, memory bounded
 * by the page cache instead of the whole database.
 *
 * The database FILE is unchanged — sql.js wrote standard SQLite format, so an
 * existing claude-gui.db opens as-is. On the first start after this migration
 * a one-time backup copy (`claude-gui.db.sqljs-era.bak`) is written before the
 * new driver opens the file; delete it once you trust the new build.
 *
 * ABI: better-sqlite3 is a native addon and the binary under node_modules
 * must match ELECTRON's ABI (NODE_MODULE_VERSION 130 for Electron 33), not
 * plain Node's. `pnpm install` re-provisions a Node-ABI binary (its own
 * postinstall builds for the running Node), so `pnpm-workspace.yaml` allows
 * better-sqlite3's build scripts and our `scripts/ensure-better-sqlite3-electron-abi.mjs`
 * postinstall (apps/desktop/package.json) swaps in the Electron prebuild after
 * every install. Symptom when that step is skipped: main crashes at startup
 * with "was compiled against a different Node.js version".
 *
 * Write model: every statement commits straight to the WAL (journal_mode=WAL,
 * synchronous=NORMAL — durable across app crashes; a power cut may roll back
 * the tail end, the standard trade-off for desktop apps). The old `persist()`
 * export-and-write dance is gone, but the call stays as a no-op so the
 * repository code reads the same as it always did.
 */
import { app } from "electron";
import Database from "better-sqlite3";
import { join } from "node:path";
import { copyFileSync, existsSync } from "node:fs";
import { log } from "@main/lib/logger.js";

let db: Database.Database | null = null;
let dbPath: string | null = null;

/**
 * Resolves once `initDb()` has finished opening the file + migrating. IPC
 * handlers `await` this before touching the DB so the window can be created
 * before DB init completes (startup decoupling). Null until `initDb()` is
 * first called; `awaitDb()` then returns a resolved promise.
 */
let dbReadyPromise: Promise<void> | null = null;

/** Wait for the DB to be ready. Safe to call before `initDb()` - returns a
 *  resolved promise in that case (callers must still handle the "not yet
 *  initialized" path via `getDb()`'s throw). */
export function awaitDb(): Promise<void> {
  return dbReadyPromise ?? Promise.resolve();
}

/** One-time safety net for the sql.js → better-sqlite3 migration: copy the
 *  database file before the new driver opens it for the first time. The copy
 *  doubles as the marker — once it exists this never runs again. Failures are
 *  logged but not fatal: the backup guards against a buggy driver, not a
 *  correctness requirement, and must not block startup. */
function backupOnceBeforeMigration(path: string): void {
  const backupPath = `${path}.sqljs-era.bak`;
  if (existsSync(backupPath)) return;
  try {
    copyFileSync(path, backupPath);
    log.info(`sqlite: one-time pre-migration backup written: ${backupPath}`);
  } catch (err) {
    log.warn(`sqlite: pre-migration backup failed (continuing): ${(err as Error).message}`);
  }
}

/** Initialize (or reuse) the singleton database. Must be called after
 * `app.whenReady()` (uses `app.getPath`). Opens the existing file if present,
 * else creates empty. The work itself is synchronous; the Promise keeps the
 * historical async contract (`awaitDb()` / `void initDb()` callers unchanged).
 *
 * Returns a Promise<Database> for callers that need the handle, but also
 * populates `dbReadyPromise` so IPC handlers can `await awaitDb()` without
 * holding the handle. Safe to fire-and-forget (`void initDb()`) to start DB
 * init in the background while the window loads. */
export function initDb(): Promise<Database.Database> {
  if (db) return Promise.resolve(db);
  if (dbReadyPromise) return dbReadyPromise.then(() => db!);

  dbReadyPromise = (async () => {
    dbPath = join(app.getPath("userData"), "claude-gui.db");
    if (existsSync(dbPath)) backupOnceBeforeMigration(dbPath);
    db = new Database(dbPath);
    // WAL: writers append to -wal instead of rewriting the main file; on
    // last-connection close SQLite checkpoints the WAL back in and removes
    // the sidecar files, so the .db alone stays complete for backups/copying.
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("foreign_keys = ON");
    migrate(db);
    log.info(`sqlite opened (better-sqlite3, WAL): ${dbPath}`);
  })();

  return dbReadyPromise.then(() => db!);
}

/** Get the initialized connection. Throws if initDb() hasn't resolved yet. */
export function getDb(): Database.Database {
  if (!db) throw new Error("getDb() called before initDb() resolved");
  return db;
}

/** Create tables if missing. Idempotent — safe on every startup. */
function migrate(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      path        TEXT NOT NULL,
      archived    INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id                TEXT PRIMARY KEY,
      project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      provider_id       TEXT NOT NULL DEFAULT 'claude-sdk',
      claude_session_id TEXT,
      title             TEXT NOT NULL,
      status            TEXT NOT NULL,
      model             TEXT NOT NULL,
      effort            TEXT NOT NULL DEFAULT 'default',
      permission_mode   TEXT NOT NULL,
      custom_model_id   TEXT,
      archived          INTEGER NOT NULL DEFAULT 0,
      pinned_at         INTEGER,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);

    CREATE TABLE IF NOT EXISTS messages (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role        TEXT NOT NULL,
      content     TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  // Backward-compatible column adds for dbs created before these columns
  // existed (CREATE TABLE IF NOT EXISTS won't alter an existing table).
  addColumnIfMissing(database, "sessions", "effort", "TEXT NOT NULL DEFAULT 'default'");
  addColumnIfMissing(database, "sessions", "provider_id", "TEXT NOT NULL DEFAULT 'claude-sdk'");
  addColumnIfMissing(database, "sessions", "context_snapshot", "TEXT");
  // Capsule state (todos / subagents / plan draft) persisted so the
  // top-right status capsule reloads on session reopen. JSON-serialized,
  // nullable — same shape as context_snapshot.
  addColumnIfMissing(database, "sessions", "todos", "TEXT");
  addColumnIfMissing(database, "sessions", "subagents", "TEXT");
  addColumnIfMissing(database, "sessions", "plan_draft", "TEXT");
  addColumnIfMissing(database, "sessions", "custom_model_id", "TEXT");
  addColumnIfMissing(database, "sessions", "archived", "INTEGER NOT NULL DEFAULT 0");
  // Pin timestamp for project-scoped session pinning (NULL = not pinned).
  // Nullable so unpinned rows carry no value; listByProject orders by it DESC
  // (SQLite puts NULLs last in DESC) to float pinned sessions to the top.
  addColumnIfMissing(database, "sessions", "pinned_at", "INTEGER");
  // Per-turn modified-files snapshot (the "本轮修改" card). JSON blob of
  // TurnFileEntry[]; null after a rewind or for sessions that never edited.
  addColumnIfMissing(database, "sessions", "turn_files", "TEXT");
  // User-placed message bookmarks (capsule + timeline markers). JSON blob of
  // SessionBookmark[]; null for sessions with no bookmarks.
  addColumnIfMissing(database, "sessions", "bookmarks", "TEXT");
  // Final subagent transcripts of the most recent turn (side-panel viewer).
  // JSON blob of Record<toolUseId, SubagentTranscriptBlock[]>; cleared at
  // the start of each new turn.
  addColumnIfMissing(database, "sessions", "subagent_transcripts", "TEXT");
  // Per-turn token/cost history. JSON array of TurnUsageRecord; appended at
  // each turn-end so the context-stats history popover survives restart.
  addColumnIfMissing(database, "sessions", "usage_history", "TEXT");
  // Side-chat Q&A sessions (right-panel ask tab): role discriminator + the
  // owning main session. 'chat' is the default so pre-migration rows and all
  // existing creation paths stay main sessions. parent_session_id carries no
  // DB-level FK — deleting a main session nulls the pointer in SessionRepo
  // instead of cascading (the Q&A history is kept).
  addColumnIfMissing(database, "sessions", "kind", "TEXT NOT NULL DEFAULT 'chat'");
  addColumnIfMissing(database, "sessions", "parent_session_id", "TEXT");
  // Isolated-agent-session environment: 'worktree' rows run their turns in a
  // detached git worktree (created on first turn, path backfilled) instead of
  // the project root. 'local' keeps every pre-migration row as-is.
  addColumnIfMissing(database, "sessions", "env_mode", "TEXT NOT NULL DEFAULT 'local'");
  addColumnIfMissing(database, "sessions", "worktree_path", "TEXT");
  // Worktree FORM intent (only read while env_mode='worktree' and the path is
  // still NULL): 'branch' materializes on a generated mcode/* branch, NULL or
  // 'detached' keeps the classic detached checkout. Stops mattering once the
  // worktree exists — the form is self-evident from the checkout.
  addColumnIfMissing(database, "sessions", "wt_style", "TEXT");
  addColumnIfMissing(database, "projects", "archived", "INTEGER NOT NULL DEFAULT 0");
  // Optional user-assigned group name for the left-bar "grouped" view. NULL
  // means the project is ungrouped; the renderer treats "" / undefined as null.
  addColumnIfMissing(database, "projects", "group", "TEXT");
  // User-reorderable position (left-bar drag-to-reorder). Defaults to 0 so
  // pre-migration rows fall back to created_at ordering; new projects get
  // MAX(sort_order)+1 so they append to the end.
  addColumnIfMissing(database, "projects", "sort_order", "INTEGER NOT NULL DEFAULT 0");
  // Pin timestamp for the left bar's pinned-projects section (NULL = not
  // pinned). Pinned projects leave the flat list / their group and render
  // above the tree, most recent pin first; sort_order is untouched so the
  // unpinning returns the project to its drag-order position. Mirrors
  // sessions.pinned_at above.
  addColumnIfMissing(database, "projects", "pinned_at", "INTEGER");

  // Composite index for paginated message reads (cursor on created_at). The
  // single-column idx_messages_session above serves the same queries but
  // requires a sort; this index lets ORDER BY created_at LIMIT ? satisfy
  // cursor pagination without a filesort. Idempotent.
  database.exec(
    "CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages(session_id, created_at)",
  );

  // One-time legacy hygiene (2026-09-14 migration): sql.js never actually
  // enforced `PRAGMA foreign_keys = ON`, so hard-deleting a session left its
  // messages behind. This database held 358 such orphans — rows no UI path
  // can ever reach (the parent chat is gone). better-sqlite3 enforces the FK,
  // so new orphans can't form; this sweep removes the legacy garbage.
  // Idempotent: a no-op on clean databases. (Orphan SESSIONS — project row
  // deleted under the same hole — are deliberately KEPT: they may hold
  // valuable history and were visible in the stream sidebar.)
  database.exec(
    "DELETE FROM messages WHERE session_id NOT IN (SELECT id FROM sessions)",
  );
}

/** Add a column only if it isn't already present. SQLite has no ADD COLUMN IF
 * NOT EXISTS, so we check pragma_table_info first. The column and table names
 * are double-quoted so SQLite keywords (e.g. `group`) work as identifiers —
 * without the quotes, `ADD COLUMN group TEXT` is a syntax error. */
function addColumnIfMissing(database: Database.Database, table: string, column: string, def: string): void {
  const found = database
    .prepare("SELECT name FROM pragma_table_info(?) WHERE name = ?")
    .all(table, column);
  if (found.length === 0) {
    database.exec(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${def}`);
  }
}

/**
 * Historical no-op. The sql.js driver needed this flush (export the whole
 * in-memory database to disk after writes); better-sqlite3 commits every
 * statement straight to the WAL, so there is nothing left to flush. The call
 * sites are kept untouched — they mark "a logical write batch ended here",
 * which keeps the repository code stable across drivers.
 */
export function persist(): void {
  /* no-op */
}

/** Close the connection on shutdown. Closing the last connection checkpoints
 * the WAL back into the main file and removes the -wal/-shm sidecars. */
export function closeDb(): void {
  try {
    db?.close();
  } catch {
    /* ignore — shutting down anyway */
  }
  db = null;
}
