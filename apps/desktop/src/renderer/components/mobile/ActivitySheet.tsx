/**
 * ActivitySheet — mobile bottom sheet for the chat activity console.
 *
 * On desktop the rail's console is a 380px panel anchored beside the node; on a
 * ~375px phone viewport that overflows (and the rail itself gets cramped), so
 * the phone shell opens this bottom sheet instead: full width, capped at 85dvh.
 *
 * The sheet owns only its chrome — scrim, grabber, frame — and renders the SAME
 * `ActivityConsole` the desktop panel uses, with `nodeTabs` turned on because
 * the rail is not on screen here: the node strip is how the phone moves between
 * tasks / subagents / plans / bookmarks. The console's body is the single scroll
 * area, so there are no nested scrollers on touch.
 *
 * Rendered through a portal to document.body — the in-tree anchor spot lives
 * inside `[data-chat-root]`, whose `container-type: inline-size` establishes
 * layout containment and would otherwise become the containing block for
 * fixed-position descendants (the sheet would stop short of the top bar and
 * bottom nav).
 */
import { createPortal } from "react-dom";
import type { SubagentSnapshot, BashTaskSnapshot, ServiceSnapshot } from "@contracts/runtime";
import type { SessionBookmark } from "@contracts/session";
import type { TodoItem } from "@renderer/stores/sessionStore.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { ActivityConsole } from "@renderer/components/chat/ActivityConsole.js";
import type { ActivityNodeKey, ActivityTabs, PlanBlock } from "@renderer/components/chat/activityShared.js";

export function ActivitySheet({
  node,
  onPickNode,
  subagents,
  todos,
  planBlocks,
  bookmarks,
  bashTasks,
  isBookmarkStale,
  tabs,
  onTabChange,
  onClose,
  onPickPlan,
  onRemoveBookmark,
  onStopBashTask,
  services,
  onStopService,
}: {
  node: ActivityNodeKey;
  /** Switch kind — the node strip inside the console calls this. */
  onPickNode: (node: ActivityNodeKey) => void;
  subagents: SubagentSnapshot[];
  todos: TodoItem[];
  planBlocks: PlanBlock[];
  /** Omit/empty to hide the bookmarks tab. The phone shell has no virtual-list
   *  jump plumbing, so entries are list/delete only (no pick/jump callback). */
  bookmarks?: SessionBookmark[];
  /** Agent-started bash commands (the「运行命令」node); stop rides the same
   *  mobile RPC channel as interrupt. */
  bashTasks?: BashTaskSnapshot[];
  onStopBashTask?: (task: BashTaskSnapshot) => void;
  /** Discovered agent-started services (the「服务」node); stop rides the same
   *  mobile RPC channel as stopTask. No "open in browser" here — the phone
   *  shell has no in-app browser. */
  services?: ServiceSnapshot[];
  onStopService?: (service: ServiceSnapshot) => void;
  isBookmarkStale?: (b: SessionBookmark) => boolean;
  tabs: ActivityTabs;
  onTabChange: (node: ActivityNodeKey, tab: string) => void;
  onClose: () => void;
  onPickPlan: (plan: string) => void;
  onRemoveBookmark?: (b: SessionBookmark) => void;
}) {
  const { t } = useI18n();
  return createPortal(
    <div className="fixed inset-0 z-50">
      {/* Backdrop — tap to dismiss. */}
      <button
        type="button"
        aria-label={t("chatStream.activity.close")}
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
      />
      <div className="absolute inset-x-0 bottom-0 flex max-h-[85dvh] flex-col rounded-t-3xl border-t border-slate-300 bg-white/95 text-slate-900 shadow-2xl backdrop-blur-2xl dark:border-white/[0.14] dark:bg-[#0c0d12]/95 dark:text-white">
        {/* Grabber handle — visual affordance for the sheet, matching the
            bottom-sheet idiom; dismissal is via scrim/back. */}
        <div className="flex shrink-0 justify-center pb-1 pt-2">
          <button
            type="button"
            onClick={onClose}
            aria-label={t("chatStream.activity.close")}
            className="grid h-4 w-full place-items-center"
          >
            <span className="h-1 w-8 rounded-full bg-slate-300 dark:bg-white/20" />
          </button>
        </div>
        {/* The console brings its own header/stats/tabs/body/footer; its body is
            the sheet's only scroll area. */}
        <div className="flex min-h-0 flex-1 flex-col pb-2">
          <ActivityConsole
            node={node}
            nodeTabs
            onPickNode={onPickNode}
            subagents={subagents}
            todos={todos}
            planBlocks={planBlocks}
            bookmarks={bookmarks ?? []}
            bashTasks={bashTasks}
            onStopBashTask={onStopBashTask}
            services={services}
            onStopService={onStopService}
            isBookmarkStale={isBookmarkStale}
            tabs={tabs}
            onTabChange={onTabChange}
            onClose={onClose}
            onPickPlan={onPickPlan}
            onRemoveBookmark={onRemoveBookmark}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}
