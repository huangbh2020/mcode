/**
 * Headless smoke for the terminal Pi session importer
 * (main/lib/piSessionImport.ts):
 *
 *  1. Fresh import — full-session fixture (user / assistant thinking+text+
 *     toolCall / toolResult incl. isError + image / compaction /
 *     session_info name) maps to a chat session row + message records with
 *     the same block shapes the live Pi adapter produces; the session row's
 *     claudeSessionId carries the JSONL file path (the resume handle).
 *  2. Skips — header-only files, unknown-project cwds; subdir cwds match the
 *     containing project; path-prefix boundaries (a vs a-sfx).
 *  3. Idempotent re-scan.
 *  4. Terminal delta growth — entries beyond the registry count upsert as
 *     new rows without duplicating existing ids.
 *  5. Mcode-turn bump — turn.done (observer, 3s debounce) advances the
 *     baseline over entries the renderer already persisted, so the next scan
 *     does NOT re-import them (the anti-duplication core).
 *  6. Dismissal — deleting the GUI session moves the file to the dismissed
 *     list; the session is never resurrected.
 *  7. Rebuild — a shrank/rewritten file re-imports from scratch, replacing
 *     only the piimp- rows.
 *  8. Same-millisecond entries keep file order (monotonic createdAt).
 *
 * No electron, no sqlite — repositories/sessionSync/RuntimeManager/db are
 * aliased to in-memory stubs; the Pi SDK is never loaded (the importer
 * hand-parses the JSONL).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

process.env["MCODE_PI_SESSIONS_DIR"] = ""; // set below, after the tmpdir exists

import { scanPiSessions, initPiSessionImport } from "@main/lib/piSessionImport.js";
import { runtimeManager } from "@main/claude/RuntimeManager.js";
import { sessions, messages, settings, projects } from "@main/store/repositories.js";
import { broadcasted } from "@main/lib/sessionSync.js";
import { logCalls } from "@main/lib/logger.js";
import type { Session, Project } from "@contracts/session";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean): void {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`FAIL: ${name}`);
  }
}

/* ── fixture helpers ── */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-pi-import-smoke."));
const SESSIONS_ROOT = path.join(TMP, "sessions");
const PROJECT_A = path.join(TMP, "proj-a");
const PROJECT_A_SFX = PROJECT_A + "-sfx";
fs.mkdirSync(SESSIONS_ROOT, { recursive: true });
fs.mkdirSync(PROJECT_A, { recursive: true });
fs.mkdirSync(PROJECT_A_SFX, { recursive: true });
process.env["MCODE_PI_SESSIONS_DIR"] = SESSIONS_ROOT;

const DIR_A = path.join(SESSIONS_ROOT, "--tmp-proj-a--");
const DIR_A_SFX = path.join(SESSIONS_ROOT, "--tmp-proj-a-sfx--");
const DIR_OTHER = path.join(SESSIONS_ROOT, "--tmp-nowhere--");
for (const d of [DIR_A, DIR_A_SFX, DIR_OTHER]) fs.mkdirSync(d, { recursive: true });

const SID1 = "11111111-2222-3333-4444-555555555555";
const SID4 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const SID_SFX = "99999999-8888-7777-6666-555555555555";

const T0 = "2026-08-15T10:04:35.000Z";

function line(entry: Record<string, unknown>): string {
  return JSON.stringify(entry);
}

function header(id: string, cwd: string, ts = T0): Record<string, unknown> {
  return { type: "session", version: 3, id, timestamp: ts, cwd };
}

function writeJsonl(filePath: string, entries: Record<string, unknown>[]): void {
  fs.writeFileSync(filePath, entries.map(line).join("\n") + "\n", "utf8");
}

function appendJsonl(filePath: string, entries: Record<string, unknown>[]): void {
  fs.appendFileSync(filePath, entries.map(line).join("\n") + "\n", "utf8");
}

function recordsOf(guiSessionId: string): Array<{ id: string; role: string; content: unknown[]; createdAt: number }> {
  const out = [];
  for (const m of messages.values()) {
    if (m.sessionId === guiSessionId) out.push(m as { id: string; role: string; content: unknown[]; createdAt: number });
  }
  return out.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/* ── fixtures ── */

const S1_PATH = path.join(DIR_A, `2026-08-15T10-04-35-343Z_${SID1}.jsonl`);
writeJsonl(S1_PATH, [
  header(SID1, PROJECT_A),
  { type: "model_change", id: "e0000001", parentId: null, timestamp: T0, provider: "ds", modelId: "deepseek-v4-flash" },
  { type: "thinking_level_change", id: "e0000002", parentId: "e0000001", timestamp: T0, thinkingLevel: "high" },
  {
    type: "message", id: "e0000003", parentId: "e0000002", timestamp: "2026-08-15T10:04:36.000Z",
    message: { role: "user", content: [{ type: "text", text: "帮我看看移动端配对实现" }], timestamp: 1786788276000 },
  },
  {
    type: "message", id: "e0000004", parentId: "e0000003", timestamp: "2026-08-15T10:04:47.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "先查 PairingManager。" },
        { type: "text", text: "我先快速查一下相关实现。" },
        { type: "toolCall", id: "call_aaa", name: "bash", arguments: { command: "rg -il pairing" } },
        { type: "toolCall", id: "call_bbb", name: "read", arguments: { path: "/tmp/x.ts" } },
      ],
      timestamp: 1786788287000,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse",
    },
  },
  {
    type: "message", id: "e0000005", parentId: "e0000004", timestamp: "2026-08-15T10:05:00.000Z",
    message: { role: "toolResult", toolCallId: "call_aaa", toolName: "bash", content: [{ type: "text", text: "PairingManager.ts" }], isError: false, timestamp: 1786788300000 },
  },
  {
    type: "message", id: "e0000006", parentId: "e0000005", timestamp: "2026-08-15T10:05:01.000Z",
    message: {
      role: "toolResult", toolCallId: "call_bbb", toolName: "read",
      content: [{ type: "text", text: "boom" }, { type: "image", data: "QUJD", mimeType: "image/png" }],
      isError: true, timestamp: 1786788301000,
    },
  },
  {
    type: "message", id: "e0000007", parentId: "e0000006", timestamp: "2026-08-15T10:05:10.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "配对逻辑在 PairingManager。" }], timestamp: 1786788310000, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop" },
  },
  { type: "compaction", id: "e0000008", parentId: "e0000007", timestamp: "2026-08-15T10:06:00.000Z", summary: "摘要", firstKeptEntryId: "e0000003", tokensBefore: 12345, details: null, usage: undefined },
  { type: "session_info", id: "e0000009", parentId: "e0000008", timestamp: "2026-08-15T10:06:01.000Z", name: "移动端配对调研" },
]);

// Header-only file — never imported.
writeJsonl(path.join(DIR_A, "empty.jsonl"), [header("dddddddd-0000-0000-0000-000000000000", PROJECT_A)]);
// Unknown project cwd — never imported.
writeJsonl(path.join(DIR_OTHER, "other.jsonl"), [
  header("cccccccc-0000-0000-0000-000000000000", "/nowhere/else"),
  { type: "message", id: "f0000001", parentId: null, timestamp: T0, message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 } },
]);
// Subdir-of-project cwd → imports under PROJECT_A.
const S4_PATH = path.join(DIR_A, `sub_${SID4}.jsonl`);
writeJsonl(S4_PATH, [
  header(SID4, path.join(PROJECT_A, "packages", "app")),
  { type: "message", id: "g0000001", parentId: null, timestamp: "2026-08-15T11:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "子目录里启动的会话" }], timestamp: 0 } },
  { type: "message", id: "g0000002", parentId: "g0000001", timestamp: "2026-08-15T11:00:05.000Z", message: { role: "assistant", content: [{ type: "text", text: "好的" }], timestamp: 0, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop" } },
]);
// cwd that is a STRING PREFIX of another project's path must match the exact project.
const SFX_PATH = path.join(DIR_A_SFX, `sfx_${SID_SFX}.jsonl`);
writeJsonl(SFX_PATH, [
  header(SID_SFX, PROJECT_A_SFX),
  { type: "message", id: "h0000001", parentId: null, timestamp: T0, message: { role: "user", content: [{ type: "text", text: "sfx" }], timestamp: 0 } },
]);

/* ── projects + init ── */

// init attaches the observer and runs an async first scan — with projects
// still empty it must be a harmless no-op (asserted by the fresh-import
// counts below, which then come entirely from the explicit scan).
initPiSessionImport();
await sleep(30);

projects.push(
  { id: "proj_a", name: "A", path: PROJECT_A, archived: false, group: null, sortOrder: 0, pinnedAt: null, createdAt: 0, updatedAt: 0 } as Project,
  { id: "proj_a_sfx", name: "A-sfx", path: PROJECT_A_SFX, archived: false, group: null, sortOrder: 0, pinnedAt: null, createdAt: 0, updatedAt: 0 } as Project,
);

/* ── 1+2. fresh import ── */

const first = scanPiSessions();
check("fresh scan imports 3 (s1 + subdir + sfx)", first.imported === 3);
check("fresh scan updates 0", first.updated === 0);

const row1 = sessions.get(`piimp-${SID1}`);
check("row1 exists", !!row1);
check("row1 provider pi-sdk", row1?.providerId === "pi-sdk");
check("row1 kind chat", row1?.kind === "chat");
check("row1 status idle", row1?.status === "idle");
check("row1 title from session_info", row1?.title === "移动端配对调研");
check("row1 claudeSessionId = file path (resume handle)", row1?.claudeSessionId === S1_PATH);
check("row1 permissionMode default", row1?.permissionMode === "default");
check("row1 effort default", row1?.effort === "default");
check("row1 customModelId null", row1?.customModelId === null);

const recs1 = recordsOf(`piimp-${SID1}`);
// user(e3) + assistant(e4) + assistant(e7) + compaction(e8); session_info skipped.
check("s1 has 4 records", recs1.length === 4);
// Order: user, assistant(tools), assistant(text), compaction.
check("s1 record 0 is user", recs1[0]?.role === "user");
const userBlocks = recs1[0]?.content as Array<{ kind: string; text?: string }>;
check("user block is text", userBlocks.length === 1 && userBlocks[0].kind === "text" && userBlocks[0].text === "帮我看看移动端配对实现");

const a1 = recs1[1]?.content as Array<{
  kind: string; text?: string; toolCallId?: string; status?: string; result?: { content?: unknown[] } | unknown;
}>;
// thinking + text + tool_use(aaa) + tool_use(bbb) + image (the error result's
// image rides as a sibling block — same shape the live tool.result reducer
// produces).
check("assistant 1 has 5 blocks", a1.length === 5);
check("assistant 1 thinking", a1[0]?.kind === "thinking" && a1[0].text === "先查 PairingManager。");
check("assistant 1 text", a1[1]?.kind === "text");
check("assistant 1 tool_use bash done", a1[2]?.kind === "tool_use" && a1[2].toolCallId === "call_aaa" && a1[2].status === "done");
check(
  "bash result is AgentToolResult wrapper",
  JSON.stringify((a1[2].result as { content: unknown[] }).content) === JSON.stringify([{ type: "text", text: "PairingManager.ts" }]),
);
check("assistant 1 tool_use read error", a1[3]?.kind === "tool_use" && a1[3].toolCallId === "call_bbb" && a1[3].status === "error");
// Image from the error result rides as a sibling image block AFTER the tool_use.
const a1After = (recs1[1]?.content as unknown[]).slice(4) as Array<{ kind: string; data?: string; toolCallId?: string }>;
check("image block after tool_use", a1After.length === 1 && a1After[0].kind === "image" && a1After[0].data === "QUJD" && a1After[0].toolCallId === "call_bbb");

check("assistant 2 text only", recs1[2]?.role === "assistant" && (recs1[2].content as Array<{ kind: string }>)[0]?.kind === "text");
const comp = recs1[3]?.content as Array<{ kind: string; preTokens?: number; trigger?: string }>;
check("compaction → compact-summary block", comp.length === 1 && comp[0].kind === "compact-summary" && comp[0].preTokens === 12345 && comp[0].trigger === "auto");

const recs4 = recordsOf(`piimp-${SID4}`);
check("subdir session imported 2 records", recs4.length === 2);
check("subdir session title = first user text", sessions.get(`piimp-${SID4}`)?.title === "子目录里启动的会话");
check("subdir session projectId = proj_a", sessions.get(`piimp-${SID4}`)?.projectId === "proj_a");
check("unknown-project file skipped", ![...sessions.values()].some((s) => s.id.includes("cccccccc")));
check("header-only file skipped", ![...sessions.values()].some((s) => s.id.includes("dddddddd")));

const rowSfx = sessions.get(`piimp-${SID_SFX}`);
check("prefix-boundary cwd matches exact project", rowSfx?.projectId === "proj_a_sfx");

check("fresh import broadcasts each new session", broadcasted.length === 3);
check("registry persisted", !!settings.get("pi.sessionImports"));

/* ── 3. idempotent re-scan ── */

const again = scanPiSessions();
check("re-scan is a no-op", again.imported === 0 && again.updated === 0);
check("no duplicate rows", sessions.size === 3);

/* ── 4. terminal delta growth ── */

appendJsonl(S1_PATH, [
  { type: "message", id: "e0000010", parentId: "e0000009", timestamp: "2026-08-15T12:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "终端里继续追问" }], timestamp: 0 } },
  { type: "message", id: "e0000011", parentId: "e0000010", timestamp: "2026-08-15T12:00:10.000Z", message: { role: "assistant", content: [{ type: "text", text: "终端里的回答" }, { type: "toolCall", id: "call_ccc", name: "bash", arguments: { command: "ls" } }], timestamp: 0, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse" } },
  { type: "message", id: "e0000012", parentId: "e0000011", timestamp: "2026-08-15T12:00:12.000Z", message: { role: "toolResult", toolCallId: "call_ccc", toolName: "bash", content: [{ type: "text", text: "out" }], isError: false, timestamp: 0 } },
]);

const delta = scanPiSessions();
check("delta scan updates 1", delta.updated === 1 && delta.imported === 0);
const recs1b = recordsOf(`piimp-${SID1}`);
// user(e10) + assistant(e11); the toolResult (e12) folds into e11 — no record.
check("delta appended 2 records", recs1b.length === recs1.length + 2);
check("delta ids unique (no dup)", new Set(recs1b.map((m) => m.id)).size === recs1b.length);
const a3 = recs1b.find((m) => m.id === `piimp-${SID1}-e0000011`);
check("delta assistant record exists", !!a3);
const a3blocks = a3?.content as Array<{ kind: string; toolCallId?: string; status?: string }>;
check("delta toolResult folded into tool_use", a3blocks.some((b) => b.kind === "tool_use" && b.toolCallId === "call_ccc" && b.status === "done"));

/* ── 5. Mcode-turn bump (anti-duplication core) ── */

const beforeBump = messages.size;
// The renderer persisted this turn already; the file grew with the same
// entries. The turn.done bump must advance the baseline past them.
appendJsonl(S1_PATH, [
  { type: "message", id: "e0000013", parentId: "e0000012", timestamp: "2026-08-15T13:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "GUI 里的追问" }], timestamp: 0 } },
  { type: "message", id: "e0000014", parentId: "e0000013", timestamp: "2026-08-15T13:00:05.000Z", message: { role: "assistant", content: [{ type: "text", text: "GUI 里的回答" }], timestamp: 0, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop" } },
]);
runtimeManager.emitTestEvent({ type: "turn.done", sessionId: `piimp-${SID1}` });
await sleep(3300); // BUMP_DEBOUNCE_MS = 3s

const afterBump = scanPiSessions();
check("bumped turn is NOT re-imported", afterBump.imported === 0 && afterBump.updated === 0);
check("no rows appeared for the GUI turn", messages.size === beforeBump);
check("no piimp row leaked for e0000013/14", !messages.has(`piimp-${SID1}-e0000013`) && !messages.has(`piimp-${SID1}-e0000014`));

/* ── 6. dismissal ── */

const sizeBeforeDismiss = sessions.size;
sessions.delete(`piimp-${SID4}`);
for (const [id, m] of messages) if (m.sessionId === `piimp-${SID4}`) messages.delete(id);
const dismissedScan = scanPiSessions();
check(
  "deleted session NOT resurrected",
  dismissedScan.imported === 0 && sessions.size === sizeBeforeDismiss - 1 && sessions.get(`piimp-${SID4}`) === undefined,
);
check("dismissed session row stays absent", sessions.get(`piimp-${SID4}`) === undefined);
const dismissedTwice = scanPiSessions();
check("dismissal is sticky", dismissedTwice.imported === 0 && sessions.get(`piimp-${SID4}`) === undefined);

/* ── 7. shrink → rebuild ── */

// After the delta: user, assistant(tools), assistant(text), compaction,
// delta-user, delta-assistant = 6 records.
const s1RecsBeforeRebuild = recordsOf(`piimp-${SID1}`).length;
check("pre-rebuild record count sane", s1RecsBeforeRebuild === 6);
writeJsonl(S1_PATH, [
  header(SID1, PROJECT_A),
  { type: "message", id: "r0000001", parentId: null, timestamp: "2026-08-15T14:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "重写后只有一轮" }], timestamp: 0 } },
  { type: "message", id: "r0000002", parentId: "r0000001", timestamp: "2026-08-15T14:00:05.000Z", message: { role: "assistant", content: [{ type: "text", text: "好的" }], timestamp: 0, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop" } },
]);
const rebuild = scanPiSessions();
check("rebuild reports updated", rebuild.updated === 1 && rebuild.imported === 0);
const recs1c = recordsOf(`piimp-${SID1}`);
check("rebuild replaced the imported rows", recs1c.length === 2);
check("rebuild kept the session row", sessions.get(`piimp-${SID1}`)?.claudeSessionId === S1_PATH);
check("rebuild ids are the new ones", recs1c.every((m) => m.id.startsWith(`piimp-${SID1}-r00000`)));

/* ── 8. same-millisecond ordering ── */

// Entries sharing one timestamp must keep file order: createdAt is clamped
// monotonic, so the (created_at, id) pagination tiebreak sees ascending
// deterministic ids instead of random-hex noise.
const sameMs = "2026-08-15T15:00:00.000Z";
const SID5 = "77777777-0000-0000-0000-000000000000";
const S5_PATH = path.join(DIR_A, `same_ms_${SID5}.jsonl`);
writeJsonl(S5_PATH, [
  header(SID5, PROJECT_A),
  { type: "message", id: "m0000001", parentId: null, timestamp: sameMs, message: { role: "user", content: [{ type: "text", text: "第一条" }], timestamp: 0 } },
  { type: "message", id: "m0000002", parentId: "m0000001", timestamp: sameMs, message: { role: "assistant", content: [{ type: "text", text: "第二条" }], timestamp: 0, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop" } },
]);
scanPiSessions();
const recs5 = recordsOf(`piimp-${SID5}`);
check("same-ms session imported", recs5.length === 2);
check("same-ms order preserved (stamp monotonic)", recs5[0].createdAt <= recs5[1].createdAt);
check("same-ms first row is the user message", recs5[0].role === "user");

/* ── error-free run ── */

check("no error-level logs", logCalls.filter((c) => c.level === "error").length === 0);

/* ── summary ── */

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\npi-import smoke: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
