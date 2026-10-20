/**
 * Headless smoke for main/lib/claudeTranscript.ts — the transcript-surgery
 * half of conversation-level revision (edit / retract, 2026-10-20).
 *
 * Covers, against fixtures shaped like REAL transcripts observed across CLI
 * 2.1.258 → 2.1.293 (see the module docstring for the row taxonomy):
 *   - prompt-row identification (promptSource=sdk on old CLIs, turnOrigin=sdk
 *     on new ones; tool_result / task_notification / interrupt / human /
 *     sidechain / meta rows all excluded)
 *   - prompt-row text extraction (string content + block content)
 *   - LCS alignment: clean 1:1, orphan prompt rows left behind by the legacy
 *     GUI-only edit-resend, duplicated texts kept in order, the timestamp
 *     floor rejecting rows written before the GUI row existed, prefix
 *     compatibility of display text vs full model prompt
 *   - positional tail-count fallback (image-only prompts carry no text)
 *   - tail cut / middle excision with parentUuid re-linking; serialization
 *     keeps untouched lines byte-identical and re-stringifies re-linked ones
 *   - the "wiped empty" detector (countSdkPromptRows === 0)
 *   - atomic file rewrite round-trip
 *
 * Pure module — no electron, no DB.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseTranscript,
  isSdkPromptRow,
  promptRowText,
  alignPrompts,
  positionalPromptRow,
  planTailCut,
  serializeTranscript,
  countSdkPromptRows,
  rewriteTranscriptFile,
  loadTranscript,
} from "@main/lib/claudeTranscript.js";

let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed += 1;
  } else {
    console.log(`ok: ${msg}`);
  }
}

/** Chained-line builder: every line's parentUuid points at the previous
 *  line's uuid, mirroring the real transcript's parent chain (the excision
 *  re-link test depends on a genuine chain, not null parents). */
class Chain {
  private prev: string | null = null;
  private lines: string[] = [];
  push(seq: number, over: Record<string, unknown> = {}): number {
    const uuid = `row-${seq}`;
    this.lines.push(
      JSON.stringify({
        parentUuid: this.prev,
        isSidechain: false,
        type: "user",
        message: { role: "user", content: [{ type: "text", text: `prompt-${seq}` }] },
        uuid,
        timestamp: new Date(1_000 + seq * 1000).toISOString(),
        ...over,
      }),
    );
    this.prev = uuid;
    return this.lines.length - 1;
  }
  attachment(seq: number): number {
    return this.push(seq, { type: "attachment", message: undefined, attachment: { type: "environment" } });
  }
  prompt(seq: number): number {
    return this.push(seq, { promptSource: "sdk", turnOrigin: "sdk", turnPosition: { promptIndex: 0, turnIndex: 1 } });
  }
  assistant(seq: number): number {
    return this.push(seq, {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "reply" }] },
    });
  }
  toolResult(seq: number): number {
    return this.push(seq, {
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    });
  }
  /** A realistic turn: attachment → sdk prompt → assistant → tool_result.
   *  Returns the prompt row's index. */
  turn(seq: number): number {
    this.attachment(seq + 1);
    const p = this.prompt(seq + 2);
    this.assistant(seq + 3);
    this.toolResult(seq + 4);
    return p;
  }
  text(): string {
    return this.lines.join("\n") + "\n";
  }
}

/** Single unchained line (for identification tests that don't need a chain). */
function line(seq: number, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    type: "user",
    message: { role: "user", content: [{ type: "text", text: `prompt-${seq}` }] },
    uuid: `row-${seq}`,
    timestamp: new Date(1_000 + seq * 1000).toISOString(),
    ...over,
  });
}

const ts = (ms: number): string => new Date(ms).toISOString();

function main(): void {
  // ── 1. Prompt-row identification ──
  {
    const rows = parseTranscript(
      [
        line(1, { promptSource: "sdk", turnOrigin: "sdk" }), // 2.1.281+ shape
        line(2, { promptSource: "sdk" }), // 2.1.258 shape (no turnOrigin)
        line(3, { turnOrigin: "sdk" }), // hypothetical future: source dropped
        line(4, { turnOrigin: "task_notification", promptSource: "system", message: { role: "user", content: "<task-notification/>" } }),
        line(5, { message: { role: "user", content: "[Request interrupted by user]" } }),
        line(6, { promptSource: "sdk", isSidechain: true }),
        line(7, { promptSource: "sdk", isMeta: true }),
        line(8, { turnOrigin: "human", promptSource: "typed" }), // terminal session row
        line(9, { message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "x" }] } }),
        line(10, { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "reply" }] } }),
        "not json at all",
      ].join("\n") + "\n",
    );
    const flags = rows.map((r) => isSdkPromptRow(r));
    assert(flags[0] === true && flags[1] === true && flags[2] === true, "sdk prompt rows identified across CLI versions");
    assert(!flags[3] && !flags[4] && !flags[8], "task_notification / interrupt / tool_result rows excluded");
    assert(!flags[5] && !flags[6], "sidechain + meta rows excluded");
    assert(!flags[7], "human-typed rows excluded");
    assert(!flags[10] && rows[10].parsed === undefined, "torn line kept verbatim, never a prompt row");
    assert(promptRowText(rows[0].parsed) === "prompt-1", "block content text extracted");
    assert(
      promptRowText({ message: { role: "user", content: "string content" } }) === "string content",
      "string content extracted",
    );
  }

  // ── 2. LCS alignment: clean session ──
  {
    const c = new Chain();
    const p1 = c.turn(10);
    const p2 = c.turn(20);
    const p3 = c.turn(30);
    const rows = parseTranscript(c.text());
    assert(p1 === 1 && p2 === 5 && p3 === 9, "fixture sanity: prompt rows at 1/5/9");
    const gui = [
      { id: "g1", createdAt: 12_000, text: "prompt-12" },
      { id: "g2", createdAt: 22_000, text: "prompt-22" },
      { id: "g3", createdAt: 32_000, text: "prompt-32" },
    ];
    const map = alignPrompts(gui, rows);
    assert(map.get(0) === 1 && map.get(1) === 5 && map.get(2) === 9, "clean 1:1 alignment across turns");
  }

  // ── 3. Orphan prompt rows (legacy GUI-only edit-resend) ──
  // GUI has 3 rows; the transcript carries 5 prompt rows — turns 2/3 were
  // truncated GUI-side by the OLD edit-resend but stayed in the transcript,
  // then turns 4/5 were sent fresh. The LCS must skip the orphans.
  {
    const c = new Chain();
    c.turn(10);
    c.turn(20);
    c.turn(30);
    c.turn(40);
    c.turn(50);
    const rows = parseTranscript(c.text());
    const gui = [
      { id: "g1", createdAt: 12_000, text: "prompt-12" },
      { id: "g4", createdAt: 42_000, text: "prompt-42" },
      { id: "g5", createdAt: 52_000, text: "prompt-52" },
    ];
    const map = alignPrompts(gui, rows);
    assert(map.get(0) === 1 && map.get(1) === 13 && map.get(2) === 17, "orphan prompt rows skipped by LCS");
  }

  // ── 4. Duplicate texts stay in order; timestamp floor rejects older rows ──
  {
    const rows = parseTranscript(
      [
        line(1, { promptSource: "sdk", message: { role: "user", content: [{ type: "text", text: "继续" }] }, timestamp: ts(1000) }),
        line(2, { promptSource: "sdk", message: { role: "user", content: [{ type: "text", text: "继续" }] }, timestamp: ts(2000) }),
        line(3, { promptSource: "sdk", message: { role: "user", content: [{ type: "text", text: "继续" }] }, timestamp: ts(3000) }),
      ].join("\n") + "\n",
    );
    const gui = [
      { id: "a", createdAt: 1000, text: "继续" },
      { id: "b", createdAt: 2000, text: "继续" },
      { id: "c", createdAt: 3000, text: "继续" },
    ];
    const map = alignPrompts(gui, rows);
    assert(map.get(0) === 0 && map.get(1) === 1 && map.get(2) === 2, "identical texts align in order");

    // A GUI row whose only text-compatible candidate was written a MINUTE
    // before the GUI row existed (a stale orphan of an old edit) must NOT
    // match it. (A second or two early is inside the skew window and fine —
    // that's the floor's purpose.)
    const gui2 = [{ id: "late", createdAt: 60_000, text: "继续" }];
    const rows2 = parseTranscript(
      line(1, { promptSource: "sdk", message: { role: "user", content: [{ type: "text", text: "继续" }] }, timestamp: ts(1000) }) + "\n",
    );
    assert(!alignPrompts(gui2, rows2).has(0), "timestamp floor rejects rows written long before the GUI row");
    const gui3 = [{ id: "skewOk", createdAt: 2500, text: "继续" }];
    assert(
      alignPrompts(gui3, parseTranscript(line(2, { promptSource: "sdk", message: { role: "user", content: [{ type: "text", text: "继续" }] }, timestamp: ts(2000) }) + "\n")).get(0) === 0,
      "small early skew stays inside the floor window",
    );
  }

  // ── 5. Display text vs model prompt: prefix compatibility ──
  {
    const rows = parseTranscript(
      line(1, {
        promptSource: "sdk",
        message: { role: "user", content: [{ type: "text", text: "fix the bug\n\n<approved-plan>\ndo it\n</approved-plan>" }] },
      }) + "\n",
    );
    const gui = [{ id: "g", createdAt: 1000, text: "fix the bug" }];
    assert(alignPrompts(gui, rows).get(0) === 0, "GUI display text aligns as a prefix of the model prompt");
  }

  // ── 6. Positional fallback (image-only prompt: no text signal) ──
  {
    const c = new Chain();
    c.turn(10);
    c.turn(20);
    c.turn(30);
    const rows = parseTranscript(c.text());
    // guiIndex is counted from the tail: with 3 gui rows, index 1 (the
    // middle) is 1-from-end → the SECOND-to-last prompt row (index 5).
    assert(positionalPromptRow(3, 1, rows) === 5, "middle gui row maps to the middle prompt row positionally");
    assert(positionalPromptRow(3, 0, rows) === 1, "first gui row maps to the first prompt row positionally");
    assert(positionalPromptRow(3, 2, rows) === 9, "last gui row maps to the last prompt row positionally");
    assert(positionalPromptRow(5, 1, rows) === null, "out-of-range from-end returns null");
  }

  // ── 7. Tail cut ──
  {
    const c = new Chain();
    c.turn(10);
    c.turn(20);
    const p3 = c.turn(30);
    const rows = parseTranscript(c.text());
    const cut = planTailCut(rows, p3); // cut at turn 3's prompt row
    assert(cut.length === p3, "tail cut keeps the prefix");
    assert(cut.every((r, i) => r === rows[i]), "cut rows keep original references (raw untouched)");
    assert(countSdkPromptRows(cut) === 2, "two prompt rows remain after the cut");
    const text = serializeTranscript(cut);
    const round = parseTranscript(text);
    assert(round.length === p3 && round.every((r, i) => r.raw === rows[i].raw), "serialization is byte-identical for untouched rows");
  }

  // ── 8. Tail cut at the LAST prompt keeps everything before it (retract of
  //    the final exchange — chain-walkability is structural for tail cuts). ──
  {
    const c = new Chain();
    c.turn(10);
    const p2 = c.turn(20);
    const p3 = c.turn(30);
    const rows = parseTranscript(c.text());
    const cut = planTailCut(rows, p3);
    assert(cut.length === p3, "cut at the last prompt keeps the full prefix");
    const keptUuids = new Set(cut.map((r) => r.parsed?.uuid).filter(Boolean));
    assert(
      cut.every((r) => !r.parsed?.parentUuid || keptUuids.has(r.parsed.parentUuid)),
      "post-cut chain is fully walkable (no dangling parentUuid)",
    );
    assert(countSdkPromptRows(cut) === 2, "two prompt rows remain after the cut");
  }

  // ── 9. Wiped-empty detection ──
  {
    const c = new Chain();
    c.attachment(1);
    const p = c.prompt(2);
    c.assistant(3);
    const rows = parseTranscript(c.text());
    const cut = planTailCut(rows, p); // cut before the only prompt row
    assert(countSdkPromptRows(cut) === 0, "cutting the only prompt leaves a non-resumable transcript");
  }

  // ── 10. Atomic rewrite round-trip + missing-file load ──
  {
    const dir = mkdtempSync(join(tmpdir(), "mcode-revise-smoke-"));
    try {
      const file = join(dir, "session.jsonl");
      const c = new Chain();
      c.turn(10);
      const p2 = c.turn(20);
      writeFileSync(file, c.text(), "utf8");
      const rows = loadTranscript(file);
      assert(rows != null && rows.length === 8, "loadTranscript reads the file");
      const cut = planTailCut(rows!, p2);
      rewriteTranscriptFile(file, serializeTranscript(cut));
      const after = readFileSync(file, "utf8");
      assert((after.match(/\n/g) ?? []).length === p2, "rewritten file has exactly the kept lines");
      assert(!existsSync(`${file}.mcode-tmp`), "temp file renamed away");
      assert(loadTranscript(join(dir, "nope.jsonl")) === null, "missing file loads as null");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  if (failed > 0) {
    console.error(`\n${failed} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\nall revise-smoke assertions passed");
}

main();
