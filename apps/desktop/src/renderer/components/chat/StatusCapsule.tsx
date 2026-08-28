import { useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import {
  PiRobot,
  IconListDetails,
  IconClipboard,
  IconChevronDown,
  IconBookmark,
} from "@renderer/lib/icons.js";
import type { SubagentSnapshot } from "@contracts/runtime";
import type { SessionBookmark } from "@contracts/session";
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
 * Layout (collapsed): a glass pill with up to four compact segments separated
 * by thin dividers. Each segment is an icon + a count - no text labels, so the
 * pill stays narrow. Segments are omitted when their source is empty; the
 * capsule renders nothing at all when every segment is empty.
 *
 *  - Plan segment:  📋 ×N   (N = number of plan blocks in this session's history)
 *  - Subagents:     🤖 N    (running count pulses; else total)
 *  - Tasks:         ☰ done/total
 *  - Bookmarks:     🔖 N
 *
 * Glass construction: a 1px gradient ring (p-px wrapper, bright top edge →
 * dark bottom edge) around a frosted surface (backdrop-blur + translucent
 * bg), plus a top inset highlight. While subagents run, an amber halo layer
 * behind the pill breathes (opacity-driven). Every count bounces on change
 * (key remount + capsule-count-pop). Click the pill to open the
 * ActivityPopover; in it, each plan is a clickable title row - clicking it
 * calls `onPickPlan(plan)` which opens the right-side PlanDrawer.
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
  bookmarks,
  isBookmarkStale,
  onPickBookmark,
  onRemoveBookmark,
  onRenameBookmark,
  onPickPlan,
}: {
  subagents: SubagentSnapshot[];
  todos: TodoItem[];
  /** Number of plan blocks in this session's message history. Drives the
   *  collapsed-pill count so the user sees at a glance how many plans exist. */
  planCount: number;
  /** All plan blocks (for the popover's title list). */
  planBlocks: PlanBlock[];
  /** The session's message bookmarks (drives the bookmark segment + popover
   *  list). Empty array hides the segment. */
  bookmarks: SessionBookmark[];
  /** Stale check (bookmarked message no longer in the stream) — the popover
   *  greys those rows out instead of offering a jump. */
  isBookmarkStale?: (b: SessionBookmark) => boolean;
  /** Jump to the bookmarked message (popover row click). */
  onPickBookmark?: (b: SessionBookmark) => void;
  /** Delete a bookmark (popover row hover button). Required for the section
   *  to render at all — a bookmark list without a delete path would be a
   *  dead end. */
  onRemoveBookmark?: (b: SessionBookmark) => void;
  /** Rename a bookmark (inline edit in the popover row). */
  onRenameBookmark?: (b: SessionBookmark, title: string) => void;
  /** Called when the user clicks a plan title in the popover - opens the
   *  right-side PlanDrawer with that plan's full content. */
  onPickPlan: (plan: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const { t } = useI18n();
  const runningAgents = subagents.filter((a) => a.status === "running").length;
  const hasSubagents = subagents.length > 0;
  const hasTodos = todos.length > 0;
  const hasPlan = planCount > 0;
  const hasBookmarks = bookmarks.length > 0;
  const todoDone = todos.filter((t) => t.status === "completed").length;
  // Displayed subagent count (running while any run, else total) — the count
  // span re-mounts on this value (key) so the bounce replays on any delta.
  const subagentCount = runningAgents > 0 ? runningAgents : subagents.length;

  // At least one segment must be present, else render nothing.
  if (!hasSubagents && !hasTodos && !hasPlan && !hasBookmarks) return null;

  // Count of segments already rendered, to decide whether a divider is
  // needed before the next segment.
  let segmentsRendered = 0;
  const needDivider = () => segmentsRendered++ > 0;

  return (
    <div className="pointer-events-auto relative animate-[capsule-in_160ms_ease-out]">
      {/* Running-agent halo: a blurred amber layer breathing behind the pill
          (opacity-driven — animating box-shadow would repaint every frame).
          Hidden while open so it doesn't fight the accent highlight. */}
      {runningAgents > 0 && !open && (
        <span
          aria-hidden
          className="capsule-breathe pointer-events-none absolute -inset-1.5 rounded-full bg-warning/20 blur-md"
        />
      )}
      {/* Glass ring: a 1px gradient border (bright top edge → dark bottom
          edge) via a p-px wrapper; the button inside fills it with the
          frosted surface. The open state keeps the same neutral colors —
          the flipped chevron alone signals it; the hover lift is suppressed
          while open so the pill doesn't drift away from the popover. */}
      <div
        className={cn(
          "rounded-full bg-gradient-to-b p-px transition-all duration-200",
          "from-black/20 to-black/5 dark:from-white/25 dark:to-white/[0.05] shadow-lg shadow-black/10",
          !open && "hover:-translate-y-0.5 hover:shadow-xl hover:shadow-black/15",
        )}
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={cn(
            "flex w-full items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium tabular-nums backdrop-blur-md transition-all",
            "shadow-[inset_0_1px_0_rgb(255_255_255/0.12)]",
            "hover:brightness-95 dark:hover:brightness-110",
            "bg-surface/75 text-content",
          )}
          title={t("chatStream.activity.capsuleTitle")}
        >
          {/* Plan segment - icon + count only. Renders first so the plan reads
              as the primary activity when present. */}
          {hasPlan && (
            <>
              <span className="flex shrink-0 items-center gap-1 tabular-nums">
                <IconClipboard size={13} className="opacity-90" />
                <span key={planCount} className="animate-[capsule-count-pop_180ms_ease-out]">
                  ×{planCount}
                </span>
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
                <span key={subagentCount} className="animate-[capsule-count-pop_180ms_ease-out]">
                  {subagentCount}
                </span>
              </span>
              {needDivider() && <Divider />}
            </>
          )}

          {/* Tasks segment - completed / total. */}
          {hasTodos && (
            <span className="flex shrink-0 items-center gap-1 tabular-nums">
              <IconListDetails size={13} className="opacity-90" />
              <span
                key={`${todoDone}/${todos.length}`}
                className="animate-[capsule-count-pop_180ms_ease-out]"
              >
                {todoDone}/{todos.length}
              </span>
            </span>
          )}

          {/* Bookmarks segment - icon + count. The divider condition is
              explicit (not the needDivider counter) because that counter's
              protocol assumes the LAST segment never calls it; appending a
              segment after Tasks without touching the others is safer this
              way. The count span re-mounts on change (key) so the pop
              keyframe replays on every add — the fly-to-capsule animation
              lands on a visible bounce. */}
          {(hasPlan || hasSubagents || hasTodos) && hasBookmarks && <Divider />}
          {hasBookmarks && (
            <span
              className="flex shrink-0 items-center gap-1 tabular-nums"
              title={t("chatStream.bookmark.capsuleTitle", { n: bookmarks.length })}
            >
              <IconBookmark size={13} className="text-warning opacity-90" />
              <span key={bookmarks.length} className="animate-[capsule-count-pop_180ms_ease-out]">
                {bookmarks.length}
              </span>
            </span>
          )}

          {/* Expand/collapse affordance - a chevron that flips when the
              popover is open. Separated from the segments by a thin divider
              so it reads as a control, not another metric. */}
          <span className="ml-0.5 h-3 w-px bg-gradient-to-b from-transparent via-edge/80 to-transparent" />
          <IconChevronDown
            size={12}
            className={cn(
              "shrink-0 opacity-60 transition-transform duration-200 ease-[cubic-bezier(0.2,0.8,0.3,1)]",
              open && "rotate-180",
            )}
          />
        </button>
      </div>
      {open &&
        (isElectron ? (
          <ActivityPopover
            todos={todos}
            planBlocks={planBlocks}
            subagents={subagents}
            bookmarks={bookmarks}
            isBookmarkStale={isBookmarkStale}
            onPickBookmark={(b) => {
              // Close the popover first, then scroll — the popover's anchor
              // would shift mid-flight otherwise.
              setOpen(false);
              onPickBookmark?.(b);
            }}
            onRemoveBookmark={onRemoveBookmark}
            onRenameBookmark={onRenameBookmark}
            onPickPlan={(plan) => {
              // Close the popover, then open the drawer via the callback.
              setOpen(false);
              onPickPlan(plan);
            }}
          />
        ) : (
          // Mobile shell: a 384px anchored popover would overflow the phone
          // viewport - expand into a full-width bottom sheet instead. The
          // mobile shell has no virtual-list jump plumbing, so bookmark rows
          // are list/delete only (no onPickBookmark).
          <ActivitySheet
            todos={todos}
            planBlocks={planBlocks}
            subagents={subagents}
            bookmarks={bookmarks}
            isBookmarkStale={isBookmarkStale}
            onRemoveBookmark={onRemoveBookmark}
            onClose={() => setOpen(false)}
            onPickPlan={(plan) => {
              setOpen(false);
              onPickPlan(plan);
            }}
          />
        ))}
    </div>
  );
}

/** Thin vertical divider between capsule segments — a vertical gradient
 * (transparent → edge → transparent) so the line fades out at both ends
 * instead of hard-stopping. */
function Divider() {
  return <span className="h-3 w-px bg-gradient-to-b from-transparent via-edge/80 to-transparent" />;
}
