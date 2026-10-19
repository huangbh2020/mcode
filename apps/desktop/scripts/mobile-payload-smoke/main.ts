/**
 * Headless smoke for the mobile payload optimizations (off-LAN load
 * reliability for the phone):
 *
 *  1. `main/mobile/httpJson.ts` — gzip negotiation for JSON RPC responses
 *     (Accept-Encoding parsing, size threshold, round-trip + ratio).
 *  2. `main/lib/sessionSync.ts#toSlimSession` — the slim projection the
 *     mobile list RPCs send instead of fat rows (heavy payloads nulled,
 *     list-visible fields + orchMeta kept, wire-size effect demonstrated).
 *
 * No electron, no server: @main/window.js is aliased to a local stub (see
 * run.sh) for sessionSync's broadcast helper.
 */
import { gunzipSync } from "node:zlib";
import { acceptsGzip, encodeJsonBody, JSON_GZIP_MIN_BYTES } from "@main/mobile/httpJson.js";
import { toSlimSession } from "@main/lib/sessionSync.js";
import type { Session } from "@contracts/session";

let pass = 0;
let fail = 0;
function assert(cond: boolean, label: string): void {
  if (cond) {
    pass++;
    console.log(`  ok - ${label}`);
  } else {
    fail++;
    console.error(`  FAIL - ${label}`);
  }
}

/* ── acceptsGzip ─────────────────────────────────────────────────────── */
console.log("acceptsGzip:");
assert(acceptsGzip(undefined) === false, "absent header → false");
assert(acceptsGzip("") === false, "empty header → false");
assert(acceptsGzip("gzip") === true, "bare gzip → true");
assert(acceptsGzip("gzip, deflate, br") === true, "browser-style list → true");
assert(acceptsGzip("deflate, br") === false, "no gzip token → false");
assert(acceptsGzip("gzip;q=0") === false, "gzip;q=0 → false (explicitly disabled)");
assert(acceptsGzip("gzip; q=0.000, identity") === false, "spaced q=0.000 → false");
assert(acceptsGzip("gzip;q=0.5, br") === true, "gzip;q=0.5 → true");
assert(acceptsGzip("GZIP, DEFLATE") === true, "case-insensitive token → true");
assert(acceptsGzip(["gzip", "br"] as unknown as string) === true, "array form → true");

/* ── encodeJsonBody ──────────────────────────────────────────────────── */
console.log("encodeJsonBody:");
{
  const small = await encodeJsonBody("gzip", '{"ok":true}');
  assert(typeof small.body === "string" && !small.contentEncoding, "below threshold stays identity");
  assert('{"ok":true}'.length < JSON_GZIP_MIN_BYTES, "small fixture is actually below the threshold");
}
{
  const big = JSON.stringify({
    messages: Array.from({ length: 500 }, (_, i) => ({ id: i, text: "x".repeat(200) })),
  });
  assert(big.length >= JSON_GZIP_MIN_BYTES, "big fixture is actually above the threshold");
  const res = await encodeJsonBody("gzip, deflate, br", big);
  assert(res.contentEncoding === "gzip" && Buffer.isBuffer(res.body), "big JSON + gzip → gzip buffer");
  assert(
    gunzipSync(res.body as Buffer).toString("utf8") === big,
    "gunzip round-trips to the original payload",
  );
  assert((res.body as Buffer).length < big.length / 3, "compression ratio > 3x on repetitive chat JSON");
}
{
  const big = "y".repeat(JSON_GZIP_MIN_BYTES + 1);
  const res = await encodeJsonBody(undefined, big);
  assert(typeof res.body === "string" && !res.contentEncoding, "no accept-encoding → identity regardless of size");
  const res2 = await encodeJsonBody("deflate", big);
  assert(typeof res2.body === "string" && !res2.contentEncoding, "client without gzip → identity");
}

/* ── toSlimSession ───────────────────────────────────────────────────── */
console.log("toSlimSession:");
// A deliberately fat row: turnFiles.before carries whole file contents,
// subagentTranscripts full transcripts — the payloads that made mobile list
// pages multi-MB. Cast, not any: the shape matches Session field-for-field.
const fileBody = "const x = 1;\n".repeat(4000); // ~52KB of "file content"
const fat = {
  id: "s1",
  projectId: "p1",
  providerId: "claude-sdk",
  claudeSessionId: "c1",
  kind: "chat",
  parentSessionId: null,
  automationId: null,
  title: "fat row",
  status: "idle",
  model: "default",
  effort: "medium",
  permissionMode: "default",
  customModelId: null,
  archived: false,
  pinnedAt: null,
  contextSnapshot: { totalTokens: 190_000, usedTokens: 120_000 } as Session["contextSnapshot"],
  todos: [{ content: "t", status: "completed", priority: "high" }] as Session["todos"],
  subagents: [{ name: "a", status: "completed" }] as Session["subagents"],
  planDraft: { phase: "ready", plan: "p" } as Session["planDraft"],
  usageHistory: [{ inputTokens: 1, outputTokens: 2 }] as Session["usageHistory"],
  turnFiles: [
    { path: "a.ts", action: "modified", adds: 1, dels: 0, before: fileBody },
  ] as Session["turnFiles"],
  bookmarks: [{ id: "b1" }] as Session["bookmarks"],
  subagentTranscripts: { "t1": [{ type: "text", text: fileBody }] } as Session["subagentTranscripts"],
  orchMeta: { runId: "r1" },
  envMode: "local",
  worktreePath: null,
  wtStyle: null,
  createdAt: 1,
  updatedAt: 2,
} as unknown as Session;

const slim = toSlimSession(fat);
assert(slim.contextSnapshot === null, "contextSnapshot nulled");
assert(slim.todos === null, "todos nulled");
assert(slim.subagents === null, "subagents nulled");
assert(slim.planDraft === null, "planDraft nulled");
assert(slim.turnFiles === null, "turnFiles nulled");
assert(slim.usageHistory === null, "usageHistory nulled");
assert(slim.bookmarks === null, "bookmarks nulled");
assert(slim.subagentTranscripts === null, "subagentTranscripts nulled");
assert(slim.id === "s1" && slim.title === "fat row" && slim.status === "idle", "light fields kept");
assert(slim.worktreePath === null && slim.envMode === "local", "routing fields kept");
assert(slim.orchMeta != null, "orchMeta kept (rides session.changed too)");
assert(slim.pinnedAt === null && slim.archived === false, "pin/routing fields kept");

const fatJson = JSON.stringify(fat);
const slimJson = JSON.stringify(slim);
assert(slimJson.length < fatJson.length / 10, "slim row < 10% of the fat row's wire size");
assert(
  (await encodeJsonBody("gzip", slimJson)).body instanceof Buffer ||
    slimJson.length < JSON_GZIP_MIN_BYTES,
  "slim rows still gzip when big enough (both optimizations compose)",
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
