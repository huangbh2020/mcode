/**
 * ActivitySheet — mobile bottom-sheet shell for the chat status capsule.
 *
 * The desktop ActivityPopover is a 384px popover anchored below the capsule
 * pill; on a ~375px phone viewport that overflows and its stacked sections
 * can run past the bottom of the screen. On the mobile shell the capsule
 * opens this bottom sheet instead: full-width, capped at 85dvh with the
 * section stack scrolling as one body, dismissed by the scrim tap.
 *
 * Rendered through a portal to document.body — the in-tree anchor spot lives
 * inside `[data-chat-root]`, whose `container-type: inline-size` establishes
 * layout containment and would otherwise become the containing block for
 * fixed-position descendants (the sheet would stop short of the top bar and
 * bottom nav).
 */
import { createPortal } from "react-dom";
import type { SubagentSnapshot } from "@contracts/runtime";
import type { TodoItem, Block } from "@renderer/stores/sessionStore.js";
import { ActivitySections } from "@renderer/components/chat/ActivityPopover.js";

/** A `kind: "plan"` block - the frozen per-turn plan in the message stream. */
type PlanBlock = Extract<Block, { kind: "plan" }>;

export function ActivitySheet({
  todos,
  planBlocks,
  subagents,
  onClose,
  onPickPlan,
}: {
  todos: TodoItem[];
  planBlocks: PlanBlock[];
  subagents: SubagentSnapshot[];
  onClose: () => void;
  /** Called when the user taps a plan title - opens the plan viewer with
   *  that plan's full markdown content. The sheet is closed by the caller
   *  (StatusCapsule) before this fires. */
  onPickPlan: (plan: string) => void;
}) {
  return createPortal(
    <div className="fixed inset-0 z-50">
      {/* Backdrop — tap to dismiss. */}
      <button
        type="button"
        aria-label="关闭活动面板"
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
      />
      <div className="absolute inset-x-0 bottom-0 flex max-h-[85dvh] flex-col rounded-t-2xl border-t border-edge bg-surface text-content shadow-2xl">
        {/* Grabber handle — visual affordance for the sheet, matching the
            bottom-sheet idiom; dismissal is via scrim/back. */}
        <div className="flex shrink-0 justify-center pt-2 pb-1">
          <span className="h-1 w-8 rounded-full bg-edge" />
        </div>
        {/* One scroll body for all sections (scrollLists=false drops the
            per-section max-h so there are no nested scroll areas on touch). */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-4">
          <ActivitySections
            todos={todos}
            planBlocks={planBlocks}
            subagents={subagents}
            onPickPlan={onPickPlan}
            scrollLists={false}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}
