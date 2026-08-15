import { useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import {
  PiRobot,
  IconListDetails,
  IconClipboard,
  IconChevronDown,
} from "@renderer/lib/icons.js";
import type { SubagentSnapshot } from "@contracts/runtime";
import type { TodoItem, Block } from "@renderer/stores/sessionStore.js";
import { isElectron } from "@renderer/lib/platform.js";
import { ActivityPopover } from "./ActivityPopover.js";
import { ActivitySheet } from "@renderer/components/mobile/ActivitySheet.js";

/** A `kind: "plan"` block - the frozen per-turn plan in the message stream. */
type PlanBlock = Extract<Block, { kind: "plan" }>;

/**
 * Unified status capsule for the sticky top-right of the chat stream.
 * Consolidates what used to be separate chips (SubagentsChip + TaskRing
 * button) into ONE glassy pill, so the top-right stays calm even when
 * subagents + todos + plans are all active.
 *
 * Layout (collapsed): a single rounded pill with up to three compact segments
 * separated by thin dividers. Each segment is an icon + a count - no text
 * labels, so the pill stays narrow. Segments are omitted when their source is
 * empty; the capsule renders nothing at all when every segment is empty.
 *
 *  - Plan segment:  📋 ×N   (N = number of plan blocks in this session's history)
 *  - Subagents:     🤖 N    (running count pulses; else total)
 *  - Tasks:         ☰ done/total
 *
 * Click the pill to open the ActivityPopover. In the popover, each plan is a
 * clickable title row - clicking it calls `onPickPlan(plan)` which opens the
 * right-side PlanDrawer with the full plan content.
 */

/** Derive a short title from the plan markdown. Prefers the first `#`/`##`
 *  heading line; falls back to the first non-empty line (stripped of leading
 *  markdown list/bullet markers). Returns "" when the plan is empty.
 *  Exported so ActivityPopover can reuse the same extraction. */
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

export function StatusCapsule({
  subagents,
  todos,
  planCount,
  planBlocks,
  onPickPlan,
}: {
  subagents: SubagentSnapshot[];
  todos: TodoItem[];
  /** Number of plan blocks in this session's message history. Drives the
   *  collapsed-pill count so the user sees at a glance how many plans exist. */
  planCount: number;
  /** All plan blocks (for the popover's title list). */
  planBlocks: PlanBlock[];
  /** Called when the user clicks a plan title in the popover - opens the
   *  right-side PlanDrawer with that plan's full content. */
  onPickPlan: (plan: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const runningAgents = subagents.filter((a) => a.status === "running").length;
  const hasSubagents = subagents.length > 0;
  const hasTodos = todos.length > 0;
  const hasPlan = planCount > 0;
  const todoDone = todos.filter((t) => t.status === "completed").length;

  // At least one segment must be present, else render nothing.
  if (!hasSubagents && !hasTodos && !hasPlan) return null;

  // Count of segments already rendered, to decide whether a divider is
  // needed before the next segment.
  let segmentsRendered = 0;
  const needDivider = () => segmentsRendered++ > 0;

  return (
    <div className="pointer-events-auto relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-medium shadow-md transition-all",
          open
            ? "border-accent/50 bg-accent/15 text-accent"
            : "border-content-subtle/40 bg-surface-hover text-content hover:brightness-95 dark:hover:brightness-110",
        )}
        title="查看活动详情（计划 / 任务 / 子代理）"
      >
        {/* Plan segment - icon + count only. Renders first so the plan reads
            as the primary activity when present. */}
        {hasPlan && (
          <>
            <span className="flex shrink-0 items-center gap-1 tabular-nums">
              <IconClipboard size={13} className="opacity-90" />
              <span>×{planCount}</span>
            </span>
            {needDivider() && <Divider />}
          </>
        )}

        {/* Subagents segment - only when any exist. Pulsing dot while running. */}
        {hasSubagents && (
          <>
            <span className="flex shrink-0 items-center gap-1 tabular-nums">
              {runningAgents > 0 && (
                <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-warning" />
              )}
              <PiRobot size={13} className={runningAgents > 0 ? "text-warning" : "opacity-90"} />
              <span>{runningAgents > 0 ? runningAgents : subagents.length}</span>
            </span>
            {needDivider() && <Divider />}
          </>
        )}

        {/* Tasks segment - completed / total. */}
        {hasTodos && (
          <span className="flex shrink-0 items-center gap-1 tabular-nums">
            <IconListDetails size={13} className="opacity-90" />
            <span>{todoDone}/{todos.length}</span>
          </span>
        )}

        {/* Expand/collapse affordance - a chevron that flips when the
            popover is open. Separated from the segments by a thin divider
            so it reads as a control, not another metric. */}
        <span className="ml-0.5 h-3 w-px bg-edge/60" />
        <IconChevronDown
          size={12}
          className={cn(
            "shrink-0 opacity-60 transition-transform duration-150",
            open && "rotate-180",
          )}
        />
      </button>
      {open &&
        (isElectron ? (
          <ActivityPopover
            todos={todos}
            planBlocks={planBlocks}
            subagents={subagents}
            onPickPlan={(plan) => {
              // Close the popover, then open the drawer via the callback.
              setOpen(false);
              onPickPlan(plan);
            }}
          />
        ) : (
          // Mobile shell: a 384px anchored popover would overflow the phone
          // viewport - expand into a full-width bottom sheet instead.
          <ActivitySheet
            todos={todos}
            planBlocks={planBlocks}
            subagents={subagents}
            onClose={() => setOpen(false)}
            onPickPlan={(plan) => {
              // Close the sheet, then open the plan viewer via the callback.
              setOpen(false);
              onPickPlan(plan);
            }}
          />
        ))}
    </div>
  );
}

/** Thin vertical divider between capsule segments. */
function Divider() {
  return <span className="h-3 w-px bg-edge/60" />;
}
