/**
 * Claude CLI transcript surgery — the claude-sdk half of conversation-level
 * revision (edit / retract of sent user messages, 2026-10-20).
 *
 * GUI turns run the bundled CLI with `CLAUDE_CONFIG_DIR=~/.mcode`, so every
 * Mcode chat session accumulates its full history in ONE append-only jsonl:
 *   `~/.mcode/projects/<encoded-cwd>/<providerSessionId>.jsonl`
 * Each turn spawns a new process that `--resume`s this file, so the file IS
 * the model's context. Truncating it at a user-prompt boundary is the only
 * way to make an edit or retract actually reach the model — the GUI-side
 * truncation alone (the pre-2026-10-20 edit-resend) left the stale exchange
 * in context forever.
 *
 * Line format (from real transcripts, CLI 2.1.258 → 2.1.293+): every line is
 * JSON with `parentUuid`/`uuid` forming a chain, `isSidechain` marking
 * subagent rows, plus free-form bookkeeping types (attachment /
 * queue-operation / last-prompt / mode / cost-state / api-request …) that
 * carry no message content. The rows we anchor on are the ones the CLI
 * writes for a REAL user prompt: `type:"user"` + `promptSource:"sdk"` —
 * distinct from tool_result user rows (no source), the CLI's synthetic
 * task-notification/scheduled prompts (`promptSource:"system"`), interrupt
 * markers, and human-typed prompts in terminal sessions (`turnOrigin:"human"`).
 *
 * Rewriting the file into a shortened state is a shape the CLI itself
 * produces natively (its TUI rewind does the same), so `--resume` accepts it.
 * The revision surgery is a pure TAIL CUT (scope "from-message" only): a
 * suffix of a valid parentUuid chain is itself valid, so no re-linking is
 * ever needed.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import {
  alignPromptSequences,
  positionalCandidate,
  type PromptCandidate,
} from "@main/lib/promptAlign.js";

/** A transcript line: the raw string (rewritten verbatim when untouched) plus
 *  its parsed shape when the line is valid JSON. Parse failures keep the raw
 *  line in place — a torn tail line must not block surgery of earlier rows. */
export interface TranscriptRow {
  raw: string;
  parsed?: TranscriptEntry;
}

/** The subset of transcript fields surgery cares about. Transcript-first:
 *  unknown extra fields are intentionally ignored (forward compatibility —
 *  the CLI appends new bookkeeping types over time). */
export interface TranscriptEntry {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  isSidechain?: boolean;
  isMeta?: boolean;
  turnOrigin?: string;
  promptSource?: string;
  timestamp?: string;
  message?: { role?: string; content?: unknown };
}

export function parseTranscript(text: string): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    let parsed: TranscriptEntry | undefined;
    try {
      const obj: unknown = JSON.parse(line);
      if (obj && typeof obj === "object") parsed = obj as TranscriptEntry;
    } catch {
      parsed = undefined;
    }
    rows.push({ raw: line, parsed });
  }
  return rows;
}

/** Is this row the CLI's record of a REAL user prompt driven by Mcode (as
 *  opposed to tool_result carriers, synthetic task-notification/scheduled
 *  turns, interrupts, or subagent rows)?
 *
 *  Keyed on `promptSource === "sdk"` — empirically present on every CLI
 *  version Mcode has bundled (2.1.258 wrote it before `turnOrigin` existed,
 *  observed across 138 real prompt rows; 2.1.281+ write both), and exclusive
 *  to SDK-driven prompts: the CLI's own synthetic injections carry
 *  promptSource "system" (task-notification recovery, scheduled turns) or no
 *  source at all (interrupt markers). `turnOrigin === "sdk"` is accepted as
 *  an alternative so a future CLI dropping promptSource stays covered;
 *  "human" (terminal-typed prompts, only ever seen in ~/.claude transcripts)
 *  is explicitly excluded. */
export function isSdkPromptRow(row: TranscriptRow): boolean {
  const p = row.parsed;
  return !!p && p.type === "user" && !p.isSidechain && !p.isMeta && p.turnOrigin !== "human" &&
    (p.promptSource === "sdk" || p.turnOrigin === "sdk");
}

/** Concatenated text of a user row's message content — string content
 *  verbatim, block content's text blocks joined. Empty for image-only or
 *  malformed rows. */
export function promptRowText(entry: TranscriptEntry | undefined): string {
  const content = entry?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const b of content) {
      if (b && typeof b === "object" && "text" in b && typeof (b as { text?: unknown }).text === "string") {
        parts.push((b as { text: string }).text);
      }
    }
    return parts.join("\n");
  }
  return "";
}

function rowTimestampMs(entry: TranscriptEntry | undefined): number | null {
  if (!entry?.timestamp) return null;
  const t = Date.parse(entry.timestamp);
  return Number.isNaN(t) ? null : t;
}

/** Collect the transcript's real-prompt rows as alignment candidates
 *  (key = row uuid). */
export function promptCandidates(rows: TranscriptRow[]): PromptCandidate[] {
  const out: PromptCandidate[] = [];
  for (const r of rows) {
    if (!isSdkPromptRow(r) || !r.parsed?.uuid) continue;
    out.push({
      key: r.parsed.uuid,
      timestampMs: rowTimestampMs(r.parsed),
      text: promptRowText(r.parsed),
    });
  }
  return out;
}

/**
 * Align the session's GUI user rows to the transcript's sdk prompt rows.
 * Both sequences are append-ordered and 1:1 by construction, but history can
 * desync (orphan transcript rows from the legacy GUI-only edit-resend; GUI
 * rows from failed sendTurns) — see lib/promptAlign.ts for the LCS core.
 * Returns guiIndex → row INDEX in `rows`. */
export function alignPrompts(
  gui: { id: string; createdAt: number; text: string }[],
  rows: TranscriptRow[],
): Map<number, number> {
  const candidates = promptCandidates(rows);
  const byKey = new Map(candidates.map((c, i) => [c.key, i]));
  const promptRowIdx: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (isSdkPromptRow(rows[i]) && rows[i].parsed?.uuid) promptRowIdx.push(i);
  }
  const aligned = alignPromptSequences(gui, candidates);
  const out = new Map<number, number>();
  for (const [guiIdx, key] of aligned) {
    const candIdx = byKey.get(key);
    if (candIdx !== undefined && promptRowIdx[candIdx] !== undefined) {
      out.set(guiIdx, promptRowIdx[candIdx]);
    }
  }
  return out;
}

/**
 * Positional fallback for targets the LCS could not place (image-only prompts
 * carry no text signal). Counts from the TAIL (see lib/promptAlign.ts).
 * Returns the row index or null. */
export function positionalPromptRow(
  guiCount: number,
  guiIndex: number,
  rows: TranscriptRow[],
): number | null {
  const key = positionalCandidate(
    guiCount,
    guiIndex,
    promptCandidates(rows),
  );
  if (key == null) return null;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].parsed?.uuid === key) return i;
  }
  return null;
}

/** Keep rows [0, cutIdx) — the tail cut behind edit / retract. The chain
 *  stays walkable by construction (a suffix of a valid chain is valid: every
 *  kept row's parentUuid points at another kept row or null). */
export function planTailCut(rows: TranscriptRow[], cutIdx: number): TranscriptRow[] {
  return rows.slice(0, Math.max(0, Math.min(cutIdx, rows.length)));
}

/** Serialize rows back to file content — untouched lines rewrite their
 *  original text verbatim so unknown fields survive byte-for-byte. */
export function serializeTranscript(rows: TranscriptRow[]): string {
  const lines: string[] = [];
  for (const r of rows) lines.push(r.raw);
  return lines.length > 0 ? lines.join("\n") + "\n" : "";
}

/** Count of real user prompts remaining — zero means the conversation was
 *  wiped to its pre-first-message state and the session should restart fresh
 *  (an empty transcript file is not a resumable conversation). */
export function countSdkPromptRows(rows: TranscriptRow[]): number {
  let n = 0;
  for (const r of rows) if (isSdkPromptRow(r)) n++;
  return n;
}

/** Atomic-ish rewrite: write a sibling temp file, then rename over the
 *  target. On Windows, renameSync replaces the destination (libuv uses
 *  MOVEFILE_REPLACE_EXISTING); a torn state can only ever leave the .tmp
 *  behind, never a half-written transcript. Throws on failure — the caller
 *  aborts the revision (and thus the DB surgery) rather than splitting
 *  GUI state from provider context. */
export function rewriteTranscriptFile(path: string, content: string): void {
  const tmp = `${path}.mcode-tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

/** Read + parse, or null when the file is missing/unreadable. */
export function loadTranscript(path: string): TranscriptRow[] | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  return parseTranscript(text);
}
