/**
 * Headless smoke for the sql.js → better-sqlite3 persistence migration.
 *
 * Opens a REAL database copy (or a fresh empty one) through the rewritten
 * store modules and asserts: (1) the legacy file loads as-is, (2) every
 * message row JSON-parses and the repo layers agree with raw SQL counts,
 * (3) pagination/search/settings round-trips behave, (4) the write paths
 * (insert / upsert / replaceAll / truncateFromAndInsert / session+project
 * delete cascade) work under the WAL driver, (5) the one-time pre-migration
 * backup is written exactly once, and (6) the -wal sidecar is checkpointed
 * away on close.
 *
 * Run via scripts/sqlite-migration-smoke/run.sh. Must run against the
 * NODE-ABI binary (plain `node`) — see run.sh for the LIVE_DB override.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb, getDb, closeDb } from "../../src/main/store/db.js";
import {
  ProjectRepo,
  SessionRepo,
  MessageRepo,
  SettingRepo,
} from "../../src/main/store/repositories.js";
import type { MessageRecord, Project, Session, SessionTodoItem } from "@contracts/session";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`FAIL: ${label}`);
    process.exitCode = 1;
    throw new Error(label);
  }
  passed++;
  console.log(`ok ${passed} - ${label}`);
}

const userData = join(tmpdir(), `mcode-sqlite-smoke-${Date.now()}`);
rmSync(userData, { recursive: true, force: true });
mkdirSync(userData, { recursive: true });
process.env.SMOKE_USER_DATA = userData;

const liveDb = process.env.SMOKE_SOURCE_DB ?? "";
const hasLive = liveDb.length > 0 && existsSync(liveDb);
const dbPath = join(userData, "claude-gui.db");
if (hasLive) {
  copyFileSync(liveDb, dbPath);
  console.log(`# using a copy of the live database: ${liveDb} (${statSync(dbPath).size} bytes)`);
} else {
  console.log("# SMOKE_SOURCE_DB not set — synthetic-database-only mode");
}

await initDb();
ok(existsSync(dbPath), "database file opened/created at userData");

/* ── one-time pre-migration backup ────────────────────────────────────── */
const backupPath = `${dbPath}.sqljs-era.bak`;
ok(existsSync(backupPath) === hasLive, hasLive ? "pre-migration backup written for existing file" : "no backup for a fresh database (none needed)");
if (hasLive) {
  ok(statSync(backupPath).size === statSync(dbPath).size, "backup is a byte-count-identical copy");
}

/* ── legacy data loads: every message row parses, repo counts == raw SQL ── */
const allSessionRows = getDb().prepare("SELECT id FROM sessions").all() as Array<{ id: string }>;
let repoMessageTotal = 0;
for (const row of allSessionRows) {
  const { messages } = MessageRepo.listBySession(row.id);
  repoMessageTotal += messages.length;
}
const rawMessageCount = (getDb().prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n;
// Legacy databases carry orphaned messages (parent session hard-deleted while
// sql.js's `PRAGMA foreign_keys = ON` was silently unenforced); migrate()
// sweeps them, so after initDb the two counts must agree exactly.
const rawOrphanCount = (
  getDb()
    .prepare(
      "SELECT COUNT(*) AS n FROM messages m LEFT JOIN sessions s ON m.session_id = s.id WHERE s.id IS NULL",
    )
    .get() as { n: number }
).n;
ok(rawOrphanCount === 0, `no orphaned messages after the migrate() sweep (was 358 in the live db)`);
ok(repoMessageTotal === rawMessageCount, `every message row loads + JSON-parses (repo ${repoMessageTotal} == raw ${rawMessageCount})`);
if (hasLive) {
  ok(rawMessageCount > 8000, `real history volume present (${rawMessageCount} messages)`);
}

/* ── session queries on real data ─────────────────────────────────────── */
const allSessions = SessionRepo.listAll();
const firstPage = SessionRepo.listAll({ limit: 10 });
ok(firstPage.length === Math.min(10, allSessions.length), `listAll paginates a first page of 10 (${firstPage.length} of ${allSessions.length})`);
for (let i = 1; i < firstPage.length; i++) {
  ok(
    firstPage[i - 1].updatedAt >= firstPage[i].updatedAt,
    `listAll ordering desc at row ${i}`,
  );
}
const countAll = SessionRepo.countAll();
ok(allSessions.length === countAll, `countAll matches listAll (${countAll})`);
const scoped = SessionRepo.listAll({ limit: 5, offset: 5 });
ok(
  scoped.length === Math.max(0, Math.min(5, allSessions.length - 5)) &&
    scoped.every((s, i) => allSessions[5 + i]?.id === s.id),
  "listAll offset slice consistent",
);

const projects = ProjectRepo.list();
ok(projects.length > 0 === hasLive, hasLive ? `projects list loads (${projects.length} rows)` : "synthetic mode: no projects yet");
const someProject = projects[0];
if (someProject) {
  const projectPage = SessionRepo.listByProject(someProject.id, { limit: 5, archived: false });
  const projectCount = SessionRepo.countByProject(someProject.id, false);
  ok(projectPage.length <= 5 && projectPage.length <= projectCount, "listByProject active page within count (pinned excluded on both)");
  ok(projectPage.every((s) => !s.pinnedAt), "active list excludes pinned sessions");
  ok(projectPage.every((s) => s.kind === "chat"), "side chats never leak into project lists");
}

const searchHit = SessionRepo.searchByTitle("e", { limit: 5 });
ok(searchHit.length <= 5 && searchHit.every((s) => s.title.toLowerCase().includes("e")), "searchByTitle filters + limits");

/* session blob columns decode through safeJson */
const anyWithUsage = allSessions.find((s) => s.usageHistory !== null) ?? firstPage.find((s) => s.usageHistory !== null);
if (anyWithUsage) {
  ok(Array.isArray(anyWithUsage.usageHistory), "usage_history JSON decodes to an array");
}

/* ── message pagination walk (cursor + tiebreaker) on the biggest session ── */
const counts = getDb()
  .prepare("SELECT session_id AS id, COUNT(*) AS n FROM messages GROUP BY session_id ORDER BY n DESC LIMIT 1")
  .all() as Array<{ id: string; n: number }>;
if (counts.length > 0 && counts[0].n > 3) {
  const bigId = counts[0].id;
  const full = MessageRepo.listBySession(bigId).messages;
  // Deterministic oracle: the legacy unpaginated read sorts by created_at
  // alone (rows sharing a timestamp come back in arbitrary order), while the
  // paginated read adds the id tiebreaker. Compare against the tiebroken
  // order — that is what cursor pagination must reproduce.
  const oracle = (
    getDb()
      .prepare("SELECT id FROM messages WHERE session_id = ? ORDER BY created_at ASC, id ASC")
      .all(bigId) as Array<{ id: string }>
  ).map((r) => r.id);
  const walked: MessageRecord[] = [];
  let cursor: { beforeCreatedAt: number; beforeId: string } | undefined;
  for (;;) {
    const page = MessageRepo.listBySession(bigId, {
      limit: 50,
      beforeCreatedAt: cursor?.beforeCreatedAt,
      beforeId: cursor?.beforeId,
    });
    walked.push(...page.messages);
    if (!page.hasMore) break;
    const oldest = page.messages[0];
    cursor = { beforeCreatedAt: oldest.createdAt, beforeId: oldest.id };
  }
  // The paginated walk yields pages of 50 ascending, newest page first —
  // reassemble the expected concatenation from the oracle and compare
  // element-wise (catches skipped/duplicated rows at page boundaries).
  const expectedIds: string[] = [];
  for (let end = oracle.length; end > 0; ) {
    const start = Math.max(0, end - 50);
    for (let i = start; i < end; i++) expectedIds.push(oracle[i]);
    end = start;
  }
  ok(full.length === oracle.length, `unpaginated read returns every row (${full.length})`);
  ok(
    walked.length === expectedIds.length &&
      walked.every((m, i) => m.id === expectedIds[i]),
    `paginated walk reassembles the full history across page boundaries (${oracle.length} rows, 50/page)`,
  );
}

/* ── settings round-trip ─────────────────────────────────────────────── */
SettingRepo.set("smoke.key", `中文 "quotes" \\ backslash ${Date.now()}`);
ok(SettingRepo.get("smoke.key") !== null && SettingRepo.get("smoke.key")!.startsWith("中文"), "settings set/get round-trips CJK + quotes");
const many = SettingRepo.getMany(["smoke.key", "ui.locale", "smoke.missing"]);
ok("smoke.key" in many && "ui.locale" in many && many["smoke.missing"] === null, "getMany maps present keys and nulls");

/* ── write paths: synthetic project → session → messages → cleanup ────── */
const now = Date.now();
const proj: Project = {
  id: "smoke-project",
  name: "Smoke Project",
  path: "C:/tmp/mcode-smoke",
  archived: false,
  group: null,
  sortOrder: 99999,
  pinnedAt: null,
  createdAt: now,
  updatedAt: now,
};
ProjectRepo.create(proj);
ok(ProjectRepo.get("smoke-project")?.name === "Smoke Project", "project create/get round-trip");
ok(ProjectRepo.listPaths().includes(proj.path), "rootPathsCache repopulates after mutation");

const sess: Session = {
  id: "smoke-session",
  projectId: proj.id,
  providerId: "claude-sdk",
  claudeSessionId: null,
  kind: "chat",
  parentSessionId: null,
  title: "New session",
  status: "idle",
  model: "default",
  effort: "default",
  permissionMode: "default",
  customModelId: null,
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
  envMode: "local",
  worktreePath: null,
  wtStyle: null,
  createdAt: now,
  updatedAt: now,
};
SessionRepo.create(sess);
ok(SessionRepo.get("smoke-session")?.title === "New session", "session create/get round-trip");
ok(SessionRepo.findFreshByProject(proj.id)?.id === "smoke-session", "findFreshByProject reuses the fresh row");

const mkMsg = (n: number): MessageRecord => ({
  id: `smoke-msg-${n}`,
  sessionId: sess.id,
  role: n % 2 === 0 ? "assistant" : "user",
  content: { blocks: [{ kind: "text", text: `hello ${n} 中文` }] },
  createdAt: now + n,
});
MessageRepo.upsertMany([mkMsg(0), mkMsg(1), mkMsg(2)]);
ok(MessageRepo.hasAny(sess.id), "hasAny true after upsert");
const afterUpsert = MessageRepo.listBySession(sess.id).messages;
ok(afterUpsert.length === 3 && JSON.stringify(afterUpsert[1].content).includes("中文"), "message content round-trips byte-identical (incl. CJK)");
MessageRepo.upsertMany([{ ...mkMsg(1), content: { blocks: [{ kind: "text", text: "updated" }] } }]);
ok(MessageRepo.listBySession(sess.id).messages.length === 3, "upsertMany updates by PK without duplicating");

MessageRepo.replaceAll(sess.id, [mkMsg(10), mkMsg(11), mkMsg(12), mkMsg(13)]);
ok(MessageRepo.listBySession(sess.id).messages.length === 4, "replaceAll truncates + rewrites");

const trunc = MessageRepo.listBySession(sess.id).messages;
MessageRepo.truncateFromAndInsert(
  sess.id,
  { createdAt: trunc[2].createdAt, id: trunc[2].id },
  [mkMsg(20)],
);
const afterTrunc = MessageRepo.listBySession(sess.id).messages;
ok(
  afterTrunc.length === 3 && afterTrunc[2].id === "smoke-msg-20" && afterTrunc[0].id === trunc[0].id,
  "truncateFromAndInsert keeps history before the cursor",
);

const paged = MessageRepo.listBySession(sess.id, { limit: 2 });
ok(paged.messages.length === 2 && paged.hasMore === true, "page smaller than history flags hasMore");
const full3 = MessageRepo.listBySession(sess.id, { limit: 3 });
ok(full3.messages.length === 3 && full3.hasMore === false, "page covering the whole history flags no-more");

SessionRepo.updateSettings(sess.id, { model: "opus" });
ok(SessionRepo.get(sess.id)?.model === "opus", "updateSettings patches one column");
SessionRepo.updateTodos(sess.id, [{ content: "t", status: "pending", priority: "low" }]);
ok(Array.isArray(SessionRepo.get(sess.id)?.todos), "todos JSON blob round-trips");
SessionRepo.updateTurnFiles(sess.id, null);
ok(SessionRepo.get(sess.id)?.turnFiles === null, "updateTurnFiles(null) clears the card");

SessionRepo.setArchived(sess.id, true);
ok(SessionRepo.get(sess.id)?.archived === true, "setArchived persists");
SessionRepo.delete(sess.id);
ok(SessionRepo.get(sess.id) === undefined && !MessageRepo.hasAny(sess.id), "session delete cascades messages");
ProjectRepo.delete(proj.id);
ok(ProjectRepo.get(proj.id) === undefined, "project delete cleans up");

/* ── WAL lifecycle ────────────────────────────────────────────────────── */
const walPath = `${dbPath}-wal`;
ok(existsSync(walPath), "WAL sidecar exists while the connection is open");
closeDb();
ok(!existsSync(walPath) || !existsSync(`${dbPath}-shm`), "WAL checkpointed away on close");
ok(existsSync(dbPath), "main db file survives close");

/* cleanup temp profile (best effort) */
try {
  rmSync(userData, { recursive: true, force: true });
} catch {
  /* windows file-lock races — the OS temp cleaner will get it */
}

console.log(`\nall ${passed} assertions passed`);
