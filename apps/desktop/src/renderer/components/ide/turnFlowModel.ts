/**
 * Pure derivation helpers for the Turn Flow panel (right-panel "turns" tab).
 *
 * The panel renders every turn of the active session as a vertical timeline —
 * the user prompt, each model action (thinking / tool call / subagent / plan /
 * touched files / final reply), and the per-turn token usage. All of that
 * already lives in the session store; this module only *derives* view-shaped
 * groupings from it. No React, no store access, no i18n — the component layer
 * owns rendering and locale.
 */
import type { Block, ChatMessage, TurnMeta } from "@renderer/stores/sessionStore.js";
import type { SubagentSnapshot, TurnUsageRecord } from "@contracts/runtime";

/** One turn = a user message + the assistant messages after it, up to the
 * next user message. Turn boundaries are implicit in the stream (there is no
 * turn id); `turnMeta` lives on the turn's first assistant message. */
export interface TurnGroup {
  /** 1-based position within the loaded message window (not the session
   * lifetime — older pages not yet loaded shift every number down). */
  index: number;
  /** The user prompt that opened the turn. Null for a leading assistant run
   * with no user message ahead of it (legacy data / compact edge cases). */
  userMessage: ChatMessage | null;
  assistantMessages: ChatMessage[];
  /** From the first assistant message carrying one; null while the turn has
   * produced no assistant output yet (prompt sent, model not yet streaming). */
  turnMeta: TurnMeta | null;
  /** turnMeta exists and endedAt is unset — the turn is streaming right now. */
  running: boolean;
}

/** Group the (chronologically ordered) message list into turns. A user
 * message opens a new group; assistant messages append to the current one.
 * The array from the store is already sorted by (createdAt, id), so a single
 * forward pass suffices. */
export function buildTurnGroups(messages: ChatMessage[]): TurnGroup[] {
  const groups: TurnGroup[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      groups.push({ index: 0, userMessage: m, assistantMessages: [], turnMeta: null, running: false });
      continue;
    }
    if (groups.length === 0) {
      groups.push({ index: 0, userMessage: null, assistantMessages: [], turnMeta: null, running: false });
    }
    const g = groups[groups.length - 1];
    g.assistantMessages.push(m);
    if (!g.turnMeta && m.turnMeta) g.turnMeta = m.turnMeta;
  }
  groups.forEach((g, i) => {
    g.index = i + 1;
    g.running = g.turnMeta !== null && g.turnMeta.endedAt === undefined;
  });
  return groups;
}

/** Tail-align completed turns with the append-only usage history (both are
 * ordered by completion time, and history is never truncated on message
 * edit-resend — hence aligning from the END, where both sequences agree). A
 * record only binds to a turn when their endedAt stamps are within the window;
 * otherwise the turn renders without usage rather than with wrong numbers.
 * Returns turn index (1-based) → record. */
const USAGE_MATCH_WINDOW_MS = 30_000;

export function matchUsageRecords(
  groups: TurnGroup[],
  history: TurnUsageRecord[],
): Map<number, TurnUsageRecord> {
  const completed = groups.filter((g) => typeof g.turnMeta?.endedAt === "number");
  const out = new Map<number, TurnUsageRecord>();
  const offset = completed.length - history.length;
  for (let i = 0; i < completed.length; i++) {
    const recIndex = i - offset;
    if (recIndex < 0 || recIndex >= history.length) continue;
    const turn = completed[i];
    const rec = history[recIndex];
    if (Math.abs(rec.endedAt - (turn.turnMeta?.endedAt ?? 0)) > USAGE_MATCH_WINDOW_MS) continue;
    out.set(turn.index, rec);
  }
  return out;
}

/* ── flow rows (expanded turn body) ─────────────────────────────────── */

/** One renderable step on a turn's timeline: a block plus the anchors the
 * panel needs to act on it — the message that carries the block (the
 * jump-to-chat target) and its position inside the SDK's concurrency
 * grouping. */
export interface FlowStep {
  key: string;
  block: Block;
  /** Message carrying the block; clicking the step locates this message in
   * the chat stream. */
  messageId: string;
  /** Total tool_use blocks in the SAME assistant message. The SDK executes
   * same-message tool calls concurrently, so >1 marks a parallel batch. */
  batchTotal: number;
  /** 0-based index within that batch (non-tool blocks are singletons 0/1). */
  batchIndex: number;
}

/** One timeline row: a single step, or a bracketed group of same-message
 * tool_use blocks that ran in parallel (`parallel` ⇔ steps.length > 1). */
export interface FlowRow {
  key: string;
  steps: FlowStep[];
  parallel: boolean;
}

/** Flatten a turn's assistant messages into timeline rows. Tool calls that
 * arrived in one assistant message become ONE bracketed row (they genuinely
 * execute concurrently); every other block becomes a singleton row in stream
 * order. Tool rows keep their batch position so the renderer never has to
 * re-derive grouping. */
export function buildFlowRows(assistantMessages: ChatMessage[]): FlowRow[] {
  const rows: FlowRow[] = [];
  for (const m of assistantMessages) {
    let batch: FlowStep[] = [];
    const flushBatch = () => {
      if (batch.length === 0) return;
      rows.push(
        batch.length > 1
          ? { key: `batch-${batch[0].key}`, steps: batch, parallel: true }
          : { key: batch[0].key, steps: batch, parallel: false },
      );
      batch = [];
    };
    let toolCount = 0;
    for (const b of m.blocks) if (b.kind === "tool_use") toolCount++;
    let toolIdx = 0;
    m.blocks.forEach((b, i) => {
      if (b.kind === "tool_use") {
        batch.push({
          key: `${m.id}:${i}`,
          block: b,
          messageId: m.id,
          batchTotal: toolCount,
          batchIndex: toolIdx++,
        });
      } else {
        flushBatch();
        rows.push({
          key: `${m.id}:${i}`,
          steps: [{ key: `${m.id}:${i}`, block: b, messageId: m.id, batchTotal: 1, batchIndex: 0 }],
          parallel: false,
        });
      }
    });
    flushBatch();
  }
  return rows;
}

/** Resolve the live subagent snapshot for a Task tool_use block. The adapter
 * correlates snapshots via the originating tool_use id (synthetic- prefixed
 * for progress-only agents the CLI spawns without a Task call in-stream). */
export function findSubagentSnapshot(
  subagents: SubagentSnapshot[],
  block: Block,
): SubagentSnapshot | undefined {
  if (block.kind !== "tool_use") return undefined;
  return subagents.find(
    (a) => a.toolUseId === block.toolCallId || a.toolUseId === `synthetic:${block.toolCallId}`,
  );
}

/** Left-accent treatment for steps the user should not scroll past without
 * noticing: hard errors (danger) and human-in-the-loop gates — questions and
 * plan-approval submissions (attention amber). Null = plain step. */
export type StepAccent = "danger" | "attention" | null;

export function stepAccent(block: Block): StepAccent {
  if (block.kind === "error") return "danger";
  if (block.kind === "tool_use") {
    if (QUESTION_TOOLS.has(block.toolName) || block.toolName === "ExitPlanMode") return "attention";
  }
  return null;
}

/* ── tool classification ────────────────────────────────────────────── */

/** Tool names that render as dedicated node kinds rather than plain tools. */
export const QUESTION_TOOLS = new Set(["AskUserQuestion"]);
export const SUBAGENT_TOOLS = new Set(["Task"]);
export const PLAN_TOOLS = new Set(["EnterPlanMode", "ExitPlanMode"]);

/** Visual bucket for a tool-use timeline dot (drives its tint). "other"
 * covers MCP / unknown tools — they all share the neutral gray dot. */
export type ToolCategory =
  | "read"
  | "write"
  | "search"
  | "terminal"
  | "web"
  | "subagent"
  | "question"
  | "plan"
  | "other";

const TOOL_CATEGORY: Record<string, ToolCategory> = {
  Read: "read",
  Glob: "read",
  TodoWrite: "read",
  TaskCreate: "read",
  TaskUpdate: "read",
  Write: "write",
  Edit: "write",
  MultiEdit: "write",
  NotebookEdit: "write",
  Grep: "search",
  Bash: "terminal",
  PowerShell: "terminal",
  WebSearch: "web",
  WebFetch: "web",
  Task: "subagent",
  AskUserQuestion: "question",
  EnterPlanMode: "plan",
  ExitPlanMode: "plan",
  // Pi lowercase aliases (pi tool names are lowercase).
  read: "read",
  find: "read",
  ls: "read",
  grep: "search",
  bash: "terminal",
  write: "write",
  edit: "write",
};

export function toolCategory(name: string): ToolCategory {
  if (TOOL_CATEGORY[name]) return TOOL_CATEGORY[name];
  if (name.startsWith("mcp__")) return "web";
  return "other";
}

/** Badge classes (bg tint + fg) for the timeline glyph of each tool
 * category. Kept here so the palette stays next to the classification it
 * serves; the component wraps them around its icon slot. */
export const TOOL_BADGE_CLS: Record<ToolCategory, string> = {
  read: "bg-accent/15 text-accent",
  write: "bg-warning/15 text-warning",
  search: "bg-violet-400/15 text-violet-400",
  terminal: "bg-emerald-500/15 text-emerald-500",
  web: "bg-cyan-400/15 text-cyan-400",
  subagent: "bg-fuchsia-400/15 text-fuchsia-400",
  question: "bg-amber-400/15 text-amber-400",
  plan: "bg-indigo-400/15 text-indigo-400",
  other: "bg-surface-muted text-content-muted",
};

/* ── collapsed-header summaries ──────────────────────────────────────── */

export interface ActionCounts {
  /** Plain tool calls (excludes question / subagent / plan tools, which get
   * their own counts on the collapsed header). */
  tools: number;
  questions: number;
  subagents: number;
  thinking: number;
}

export function countActions(blocks: Block[]): ActionCounts {
  const c: ActionCounts = { tools: 0, questions: 0, subagents: 0, thinking: 0 };
  for (const b of blocks) {
    if (b.kind === "thinking") c.thinking++;
    else if (b.kind === "tool_use") {
      if (QUESTION_TOOLS.has(b.toolName)) c.questions++;
      else if (SUBAGENT_TOOLS.has(b.toolName)) c.subagents++;
      else if (!PLAN_TOOLS.has(b.toolName)) c.tools++;
    }
  }
  return c;
}

/** First text block + attachment count of a user message (the "what the model
 * received" preview). Images pasted via the composer count as attachments. */
export function userMessagePreview(msg: ChatMessage): { text: string; attachments: number } {
  let text = "";
  let attachments = 0;
  for (const b of msg.blocks) {
    if (b.kind === "text" && !text) text = b.text.trim();
    else if (b.kind === "attachment" || b.kind === "image") attachments++;
  }
  return { text, attachments };
}

/** Aggregate +/- line counts over a turn's `turn-files` blocks (frozen cards
 * carry the totals for historical turns; the live card for the current one). */
export function turnFilesTotals(blocks: Block[]): { files: number; adds: number; dels: number } {
  let files = 0;
  let adds = 0;
  let dels = 0;
  for (const b of blocks) {
    if (b.kind !== "turn-files") continue;
    files += b.files.length;
    for (const f of b.files) {
      adds += f.adds;
      dels += f.dels;
    }
  }
  return { files, adds, dels };
}

/** Per-turn "input" isn't stored directly — derive it as the non-cached,
 * non-output share of totalProcessedTokens (same formula as the context
 * stats popover's history view). */
export function usageInputTokens(r: TurnUsageRecord): number {
  return Math.max(0, r.totalProcessedTokens - r.outputTokens - r.cacheReadTokens - r.cacheCreationTokens);
}

/** Cache hit rate for a turn: cache-read tokens as a share of all input-side
 * tokens (fresh input + cache read + cache write; output excluded). Null when
 * the turn had no input-side tokens at all. */
export function cacheHitRate(r: TurnUsageRecord): number | null {
  const denom = r.totalProcessedTokens - r.outputTokens;
  if (denom <= 0) return null;
  return Math.min(1, r.cacheReadTokens / denom);
}

/** Count tool-produced screenshots per toolCallId, so a tool node can show a
 * camera chip without rendering the (large base64) images themselves. */
export function imageCountsByToolCall(blocks: Block[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const b of blocks) {
    if (b.kind === "image" && b.toolCallId) {
      out.set(b.toolCallId, (out.get(b.toolCallId) ?? 0) + 1);
    }
  }
  return out;
}

/* ── formatting (shared by the panel's header and sections) ──────────── */

/** Wall-clock ms → "HH:mm" local time. */
export function fmtClockTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Duration ms → "12s" / "1m 03s" / "1h 02m". */
export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  }
  const h = Math.floor(s / 3600);
  return `${h}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}
