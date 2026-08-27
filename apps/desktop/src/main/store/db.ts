/**
 * SQLite persistence layer (sql.js / WASM-compiled-to-asm.js).
 *
 * Why sql.js instead of better-sqlite3? better-sqlite3 is a native addon and
 * its prebuilt binary didn't match Electron's ABI on this machine, with no
 * MSVC toolchain to rebuild it. sql.js is pure JavaScript (we use the asm.js
 * build so there's not even a .wasm to load), so it runs anywhere with zero
 * native compilation — clone and `pnpm dev` works for everyone.
 *
 * Trade-off: the database lives in memory and we flush it to a file on writes
 * (see `persist()`). For our workload (session/message rows, low write rate)
 * this is instant and the file is always consistent.
 */
import { app } from "electron";
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js/dist/sql-asm.js";
import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { log } from "@main/lib/logger.js";

let SQL: SqlJsStatic | null = null;
let db: Database | null = null;
let dbPath: string | null = null;
/** True once persist() is already scheduled - collapses rapid writes into one flush. */
let persistPending = false;

/**
 * Resolves once `initDb()` has finished loading sql.js + opening the file +
 * migrating. IPC handlers `await` this before touching the DB so the window
 * can be created before DB init completes (startup decoupling). Null until
 * `initDb()` is first called; `awaitDb()` then returns a resolved promise.
 */
let dbReadyPromise: Promise<void> | null = null;

/** Wait for the DB to be ready. Safe to call before `initDb()` - returns a
 *  resolved promise in that case (callers must still handle the "not yet
 *  initialized" path via `getDb()`'s throw). */
export function awaitDb(): Promise<void> {
  return dbReadyPromise ?? Promise.resolve();
}

/** Initialize (or reuse) the singleton database. Must be called after
 * `app.whenReady()` (uses `app.getPath`). Loads the existing file if present,
 * else creates empty.
 *
 * Returns a Promise<Database> for callers that need the handle, but also
 * populates `dbReadyPromise` so IPC handlers can `await awaitDb()` without
 * holding the handle. Safe to fire-and-forget (`void initDb()`) to start DB
 * init in the background while the window loads. */
export function initDb(): Promise<Database> {
  if (db) return Promise.resolve(db);
  if (dbReadyPromise) return dbReadyPromise.then(() => db!);

  dbReadyPromise = (async () => {
    SQL = await initSqlJs();
    dbPath = join(app.getPath("userData"), "claude-gui.db");

    if (existsSync(dbPath)) {
      db = new SQL.Database(new Uint8Array(readFileSync(dbPath)));
      log.info(`sqlite opened from existing file: ${dbPath}`);
    } else {
      db = new SQL.Database();
      log.info(`sqlite created new database: ${dbPath}`);
    }
    db.run("PRAGMA foreign_keys = ON");
    migrate(db);
  })();

  return dbReadyPromise.then(() => db!);
}

/** Get the initialized connection. Throws if initDb() hasn't resolved yet. */
export function getDb(): Database {
  if (!db) throw new Error("getDb() called before initDb() resolved");
  return db;
}

/** Create tables if missing. Idempotent — safe on every startup. */
function migrate(database: Database): void {
  database.run(`
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
  addColumnIfMissing(database, "projects", "archived", "INTEGER NOT NULL DEFAULT 0");
  // Optional user-assigned group name for the left-bar "grouped" view. NULL
  // means the project is ungrouped; the renderer treats "" / undefined as null.
  addColumnIfMissing(database, "projects", "group", "TEXT");
  // User-reorderable position (left-bar drag-to-reorder). Defaults to 0 so
  // pre-migration rows fall back to created_at ordering; new projects get
  // MAX(sort_order)+1 so they append to the end.
  addColumnIfMissing(database, "projects", "sort_order", "INTEGER NOT NULL DEFAULT 0");

  // Composite index for paginated message reads (cursor on created_at). The
  // single-column idx_messages_session above serves the same queries but
  // requires a sort; this index lets ORDER BY created_at LIMIT ? satisfy
  // cursor pagination without a filesort. Idempotent.
  database.run(
    "CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages(session_id, created_at)",
  );
}

/** Add a column only if it isn't already present. SQLite has no ADD COLUMN IF
 * NOT EXISTS, so we check pragma_table_info first. The column and table names
 * are double-quoted so SQLite keywords (e.g. `group`) work as identifiers —
 * without the quotes, `ADD COLUMN group TEXT` is a syntax error. */
function addColumnIfMissing(database: Database, table: string, column: string, def: string): void {
  const stmt = database.prepare(`SELECT name FROM pragma_table_info(?) WHERE name = ?`);
  stmt.bind([table, column]);
  const exists = stmt.step();
  stmt.free();
  if (!exists) {
    database.run(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${def}`);
  }
}

/**
 * Flush the in-memory database to disk. Coalesced via the microtask queue so a
 * burst of writes (e.g. a replaceAll inside a transaction) hits the file once.
 * Call this after any write; readers don't need it.
 */
export function persist(): void {
  if (!db || !dbPath) return;
  if (persistPending) return;
  persistPending = true;
  // Defer to the next microtask so multiple synchronous writes in one tick
  // share a single export+write.
  queueMicrotask(() => {
    persistPending = false;
    try {
      const data = db!.export();
      // Ensure the userData dir exists (it should, but be defensive).
      const dir = join(dbPath!, "..");
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(dbPath!, data);
    } catch (err) {
      log.error(`sqlite persist failed: ${(err as Error).message}`);
    }
  });
}

/** Close the connection on shutdown. Persist first so nothing is lost. */
export function closeDb(): void {
  try {
    if (persistPending) {
      // Force an immediate flush rather than waiting for the queued microtask,
      // which may not run before the process exits.
      persistPending = false;
      if (db && dbPath) writeFileSync(dbPath, db.export());
    }
    db?.close();
  } catch {
    /* ignore — shutting down anyway */
  }
  db = null;
}
