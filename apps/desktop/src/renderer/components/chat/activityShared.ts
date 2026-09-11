/**
 * Shared vocabulary for the chat activity rail + console.
 *
 * Extracted from the old StatusCapsule/ActivityPopover pair so the rail, the
 * console, the mobile sheet and unrelated surfaces (SideChatPanel,
 * TurnFlowPanel, PlanStreamBlock) read the SAME subagent metadata, usage
 * formatting and plan-title extraction. One copy is what keeps "运行中" the
 * same colour and wording everywhere, and it makes the rail/console pair pure
 * views over a shared model.
 */
import { useCallback, useState } from "react";
import type { SubagentSnapshot } from "@contracts/runtime";
import type { Block, TodoItem } from "@renderer/stores/sessionStore.js";
import type { SessionBookmark } from "@contracts/session";
import type { MessageId } from "@renderer/lib/i18n/index.js";
import { IconBookmark, IconClipboard, IconListDetails, PiRobot } from "@renderer/lib/icons.js";
import type { ComponentType } from "react";

/** A `kind: "plan"` block - the frozen per-turn plan in the message stream. */
export type PlanBlock = Extract<Block, { kind: "plan" }>;

/** Translator signature matching the `t` returned by `useI18n`, so pure helpers
 *  and row components can localize without reaching for the hook themselves. */
export type Translate = (key: MessageId, params?: Record<string, string | number>) => string;

/* ── Rail geometry ──────────────────────────────────────────────────── */

/** The four node kinds, in the rail's top-to-bottom order. Tasks lead
 *  (progress is what people glance at); bookmarks sit last because they are
 *  an archive rather than live state. Nodes whose source is empty are omitted
 *  entirely, so the rail only ever shows what the session actually has. */
export type ActivityNodeKey = "tasks" | "subagents" | "plans" | "bookmarks";
export const RAIL_NODE_ORDER: readonly ActivityNodeKey[] = [
  "tasks",
  "subagents",
  "plans",
  "bookmarks",
];

/** Per-kind chrome: glyph, display name and accent tint. ONE mapping feeds the
 *  rail node, the hover label and the console header, so a kind can never be
 *  named or coloured differently in the two places it appears. */
export const NODE_META: Record<
  ActivityNodeKey,
  {
    /** Deliberately NOT TablerIconProps: the subagent node uses react-icons'
     *  Phosphor robot, whose props type is not assignable to Tabler's (their
     *  `stroke` widths differ). Only `size` and `className` are ever passed. */
    ico: ComponentType<{ size?: number | string; className?: string }>;
    labelKey: MessageId;
    icoCls: string;
  }
> = {
  tasks: {
    ico: IconListDetails,
    labelKey: "chatStream.activity.node.tasks",
    icoCls: "bg-accent/15 text-accent-strong",
  },
  subagents: {
    ico: PiRobot,
    labelKey: "chatStream.activity.node.subagents",
    icoCls: "bg-warning/15 text-warning",
  },
  plans: {
    ico: IconClipboard,
    labelKey: "chatStream.activity.node.plans",
    icoCls: "bg-info/15 text-info",
  },
  bookmarks: {
    ico: IconBookmark,
    labelKey: "chatStream.activity.node.bookmarks",
    icoCls: "bg-warning/15 text-warning",
  },
};



/** Which kind the cluster's core opens: whatever is most urgent/perishable.
 *  Running subagents first (they change second to second), then the task
 *  board, then plans, then bookmarks. Same rule for the corner cluster's core
 *  and for the sheet's initial tab. */
export function primaryKind(
  subagents: readonly SubagentSnapshot[],
  todos: readonly TodoItem[],
  planBlocks: readonly PlanBlock[],
  bookmarks: readonly SessionBookmark[],
): ActivityNodeKey {
  if (subagents.length > 0) return "subagents";
  if (todos.length > 0) return "tasks";
  if (planBlocks.length > 0) return "plans";
  return "bookmarks";
}

/* ── Subagent metadata ──────────────────────────────────────────────── */

/** Status tints per subagent lifecycle state. Display labels are `labelKey`s
 *  resolved via t() at render time (module constants can't hold locale-bound
 *  strings). Shared with SideChatPanel / TurnFlowPanel. */
export const SUBAGENT_STATUS_META: Record<
  SubagentSnapshot["status"],
  { labelKey: MessageId; cls: string; spin?: boolean }
> = {
  running: { labelKey: "chatStream.subagent.statusRunning", cls: "text-warning", spin: true },
  completed: { labelKey: "chatStream.subagent.statusCompleted", cls: "text-accent" },
  failed: { labelKey: "chatStream.subagent.statusFailed", cls: "text-danger" },
  killed: { labelKey: "chatStream.subagent.statusKilled", cls: "text-danger" },
};

/** Compact "1.2k tokens · 5 tools · 12s" string, still used by the side
 *  panel's subagent header. */
export function fmtUsage(snap: SubagentSnapshot): string {
  const parts: string[] = [];
  if (typeof snap.totalTokens === "number") parts.push(`${(snap.totalTokens / 1000).toFixed(1)}k tokens`);
  if (typeof snap.toolUses === "number") parts.push(`${snap.toolUses} tools`);
  if (typeof snap.durationMs === "number") parts.push(`${Math.round(snap.durationMs / 1000)}s`);
  return parts.join(" · ");
}

/* ── Plan titles ────────────────────────────────────────────────────── */

/** Derive a short title from the plan markdown. Prefers the first `#`/`##`
 *  heading line; falls back to the first non-empty line (stripped of leading
 *  markdown list/bullet markers). Returns "" when the plan is empty. Shared
 *  with PlanStreamBlock (the in-stream plan card's header). */
export function extractPlanTitle(plan: string): string {
  const lines = plan.split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    // Match ATX headings: "# Title", "## Title", etc.
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading) return heading[1].trim();
  }
  // No heading - use the first non-empty line, trimmed of common markdown
  // list/bullet/quote prefixes so it reads as a clean title.
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    return line.replace(/^[-*+]\s+/, "").replace(/^>\s*/, "").replace(/^\d+\.\s+/, "");
  }
  return "";
}

/** Two-line excerpt for the console's plan index: the plan body with the
 *  title line removed, markdown noise flattened to plain text. Returns "" when
 *  the plan carries nothing beyond its title. */
export function extractPlanExcerpt(plan: string): string {
  const lines = plan.split("\n");
  const out: string[] = [];
  let skippedTitle = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (!skippedTitle) {
      skippedTitle = true; // drop the heading line the title already shows
      continue;
    }
    if (/^#{1,6}\s+/.test(line) && out.length === 0) continue; // drop a second heading
    out.push(
      line
        .replace(/^[-*+]\s+/, "")
        .replace(/^>\s*/, "")
        .replace(/^\d+\.\s+/, "")
        .replace(/`/g, "")
        .replace(/\*\*/g, ""),
    );
    if (out.join(" ").length > 140) break;
  }
  return out.join(" ").trim();
}

/* ── Time formatting ────────────────────────────────────────────────── */

/** Wall-clock HH:MM:SS (local), matching the run ledger's clock. */
export function formatClock(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Human duration, matching the run ledger's wording ("1m 12s"). */
export function formatDuration(ms: number): string {
  if (ms < 1000) return "<1s";
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m < 60) return `${m}m ${String(s).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h}h ${String(mm).padStart(2, "0")}m`;
}

/* ── Subagent timeline ──────────────────────────────────────────────── */

/** One subagent's slice of the session's agent timeline, in percent. */
export interface SubagentBar {
  leftPct: number;
  widthPct: number;
}

/** A subagent's [start, end] wall-clock window. A settled agent ends at its
 *  `endedAt`; a running one ends at `now` (it is still going). Both carry a
 *  cumulative `durationMs`, so the start is `end - durationMs` — the contract
 *  has no `startedAt` and does not need one. Shared by the row's clock label
 *  and the timeline bar so the two can never disagree. */
export function subagentEndpoints(
  a: SubagentSnapshot,
  now: number,
): { start: number; end: number } {
  const end = a.status === "running" ? now : (a.endedAt ?? now);
  return { start: end - Math.max(0, a.durationMs ?? 0), end };
}

/** Build the session's agent timeline from the roster alone — see
 *  `subagentEndpoints` for where each bar's span comes from. Keeps the
 *  timeline honest against the same numbers the rows print, instead of
 *  decorating the panel with a fake axis. */
export function subagentTimeline(
  agents: readonly SubagentSnapshot[],
  now: number,
): { start: number; end: number; bars: Map<string, SubagentBar> } {
  const bars = new Map<string, SubagentBar>();
  if (agents.length === 0) return { start: now - 1000, end: now, bars };

  const ends = agents.map((a) => subagentEndpoints(a, now));
  const end = Math.max(now, ...ends.map((e) => e.end));
  // Floor the axis at one second so a batch of zero-duration agents doesn't
  // collapse into a divide-by-zero.
  const start = Math.min(...ends.map((e) => e.start), end - 1000);
  const span = Math.max(1, end - start);

  for (const a of agents) {
    const win = subagentEndpoints(a, now);
    bars.set(a.taskId, {
      leftPct: ((win.start - start) / span) * 100,
      // A 2% floor keeps a sub-second agent visible instead of a zero-width
      // sliver; the printed duration stays exact.
      widthPct: Math.max(2, ((win.end - win.start) / span) * 100),
    });
  }
  return { start, end, bars };
}

/* ── Panel tab state ────────────────────────────────────────────────── */

/** Active filter tab per node kind. Owned by the always-mounted rail (not by
 *  the console, which unmounts on close) so the user's choice survives
 *  open/close cycles within the session pane. */
export type ActivityTabs = Record<ActivityNodeKey, string>;

export function useActivityTabs(): {
  tabs: ActivityTabs;
  setTab: (node: ActivityNodeKey, tab: string) => void;
} {
  const [tabs, setTabs] = useState<ActivityTabs>(() => ({
    tasks: "all",
    subagents: "all",
    plans: "all",
    bookmarks: "all",
  }));
  const setTab = useCallback((node: ActivityNodeKey, tab: string) => {
    setTabs((prev) => (prev[node] === tab ? prev : { ...prev, [node]: tab }));
  }, []);
  return { tabs, setTab };
}
