/**
 * ActivityCluster — the chat's activity cluster in the stream's top-right
 * corner (方案 B「收放」, `prototypes/chat-activity-capsule-directions.html`).
 *
 * The design lets the control's SIZE follow urgency instead of parking a
 * fixed-width strip:
 *
 *   idle / all tasks done → a 30px round button: a conic progress ring around
 *                           three quiet dots, saying "nothing needs you";
 *   something running     → a text bar grows out of the button (the button
 *                           stays its head): "2 个子代理运行中", the task
 *                           fraction with a 34px mini progress bar, and a
 *                           plain "3 计划" link;
 *   needs attention       → the same bar turns amber and says what is wrong
 *                           ("2 个子代理失败" / "等待你的回答") instead of
 *                           making the user hover to find out.
 *
 * Why it replaced the vertical rail: the rail reserved a strip of every row
 * and read as an index (icons + counts, hover to learn what they mean). This
 * cluster is almost invisible when there is nothing to say, and says the
 * thing in words when there is — no hover required. It is an OVERLAY in the
 * corner again, so its bar can cover the tail of the first row while it is
 * open; that is the deliberate trade for "空闲时几乎不可见" (the rail's
 * zero-occlusion property is gone, and 方案 D in the same doc is the variant
 * that keeps it).
 *
 * Everything below the cluster is unchanged: clicking any part opens the
 * ActivityConsole, dropped straight down from the cluster with a notch on its
 * top edge — the console owns its own content, this file owns the chrome.
 */
import { useEffect, useRef, useState, type RefObject } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { isElectron } from "@renderer/lib/platform.js";
import type { SubagentSnapshot } from "@contracts/runtime";
import type { SessionBookmark } from "@contracts/session";
import type { TodoItem } from "@renderer/stores/sessionStore.js";
import { ActivitySheet } from "@renderer/components/mobile/ActivitySheet.js";
import { ActivityConsole, hasNodeData } from "./ActivityConsole.js";
import {
  primaryKind,
  useActivityTabs,
  type ActivityNodeKey,
  type PlanBlock,
} from "./activityShared.js";

export function ActivityCluster({
  subagents,
  todos,
  planBlocks,
  bookmarks,
  /** The turn is paused on an unanswered question (AskUserQuestion pending) —
   *  the strongest "this needs you" signal the app has. */
  waiting,
  isBookmarkStale,
  onPickBookmark,
  onRemoveBookmark,
  onRenameBookmark,
  onPickSubagent,
  onPickPlan,
  /** Landing target for the "fly to activity" bookmark animation. The cluster
   *  has no per-kind nodes, so the dot lands on the cluster itself. */
  bookmarkNodeRef,
}: {
  subagents: SubagentSnapshot[];
  todos: TodoItem[];
  planBlocks: PlanBlock[];
  bookmarks: SessionBookmark[];
  waiting?: boolean;
  isBookmarkStale?: (b: SessionBookmark) => boolean;
  onPickBookmark?: (b: SessionBookmark) => void;
  onRemoveBookmark?: (b: SessionBookmark) => void;
  onRenameBookmark?: (b: SessionBookmark, title: string) => void;
  onPickSubagent?: (agent: SubagentSnapshot) => void;
  onPickPlan: (plan: string) => void;
  bookmarkNodeRef?: RefObject<HTMLDivElement | null>;
}) {
  const { t } = useI18n();
  const [openKind, setOpenKind] = useState<ActivityNodeKey | null>(null);
  const [sheetNode, setSheetNode] = useState<ActivityNodeKey | null>(null);
  // Filter tabs per kind, owned here (the console unmounts on close).
  const { tabs, setTab } = useActivityTabs();
  const panelRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Escape / outside-press dismissal. Capture phase, so the panel closes before
  // any surface underneath reacts to the same press.
  useEffect(() => {
    if (!openKind && !sheetNode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpenKind(null);
        setSheetNode(null);
      }
    };
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      // Inside the console or on the cluster: keep it (the cluster's own click
      // decides, so switching kinds never flickers through a close).
      if (panelRef.current?.contains(target) || rootRef.current?.contains(target)) return;
      setOpenKind(null);
      setSheetNode(null);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [openKind, sheetNode]);

  const hasAny =
    subagents.length > 0 || todos.length > 0 || planBlocks.length > 0 || bookmarks.length > 0;
  if (!hasAny) return null;

  const running = subagents.filter((a) => a.status === "running");
  const failed = subagents.filter((a) => a.status === "failed");
  const done = todos.filter((x) => x.status === "completed").length;
  const pct = todos.length > 0 ? Math.round((done / todos.length) * 100) : 0;
  const primary = primaryKind(subagents, todos, planBlocks, bookmarks);

  // Attention outranks activity: a pending question or a failed subagent is the
  // reason the bar exists at all. A failed agent while others still run keeps
  // the running copy (per the design doc's rule) — the console lists it.
  const attn = !!waiting || (running.length === 0 && failed.length > 0);
  const expanded = running.length > 0 || attn;
  const attnText = waiting
    ? t("chatStream.activity.cluster.waiting")
    : t("chatStream.activity.cluster.failed", { n: failed.length });

  const openConsole = (kind: ActivityNodeKey) => {
    if (isElectron) setOpenKind((prev) => (prev === kind ? null : kind));
    else setSheetNode((prev) => (prev === kind ? null : kind));
  };

  const cluster = (
    <div
      ref={bookmarkNodeRef}
      className={cn(
        "pointer-events-auto relative inline-flex h-[30px] items-center overflow-hidden rounded-full",
        "border backdrop-blur-[14px] transition-[border-color,background-color,box-shadow] duration-[250ms] ease-[cubic-bezier(0.22,1,0.36,1)]",
        "shadow-[0_1px_2px_rgb(9_9_11/0.05),0_8px_22px_-12px_rgb(9_9_11/0.28)]",
        attn ? "border-warning/60 bg-warning/10" : "border-edge/85 bg-surface/75",
      )}
    >
      {/* The button stays the head of the bar: the ring reports task progress
          even when collapsed, so "almost nothing" still carries one number. */}
      <button
        type="button"
        onClick={() => openConsole(primary)}
        aria-haspopup="dialog"
        aria-expanded={isElectron ? !!openKind : !!sheetNode}
        aria-label={t("chatStream.activity.cluster.aria")}
        className={cn(
          "relative grid h-[30px] w-[30px] shrink-0 place-items-center transition-colors",
          attn
            ? "text-warning"
            : running.length > 0
              ? "text-accent-strong"
              : "text-content-muted hover:text-content",
        )}
      >
        <span
          aria-hidden
          className="absolute inset-[3px] rounded-full"
          style={{
            background: `conic-gradient(${
              attn ? "rgb(var(--warning))" : "rgb(var(--accent))"
            } ${pct}%, rgb(var(--edge)) 0)`,
            mask: "radial-gradient(farthest-side, transparent calc(100% - 2px), #000 0)",
            WebkitMask: "radial-gradient(farthest-side, transparent calc(100% - 2px), #000 0)",
          }}
        />
        <span aria-hidden className="relative z-[1] inline-flex h-[11px] items-center">
          <span className="h-[3px] w-[3px] rounded-[1px] bg-current opacity-60" />
          <span className="ml-[2px] h-[3px] w-[3px] rounded-[1px] bg-current opacity-60" />
          <span className="ml-[2px] h-[3px] w-[3px] rounded-[1px] bg-current opacity-60" />
        </span>
      </button>

      {/* The bar: max-width 0 → 280px. Its own width is the only thing that
          moves, so the cluster's right edge never leaves the corner. */}
      <div className={cn("activity-cluster-bar", expanded && "open")}>
        {attn ? (
          <span className="whitespace-nowrap text-[11px] font-semibold text-warning">{attnText}</span>
        ) : running.length > 0 ? (
          <span className="whitespace-nowrap text-[11px] font-semibold text-content-muted">
            {t("chatStream.activity.cluster.running", { n: running.length })}
          </span>
        ) : null}

        {!attn && todos.length > 0 && (
          <>
            <span aria-hidden className="h-3 w-px shrink-0 bg-edge" />
            <span className="whitespace-nowrap text-[11px] tabular-nums text-content-subtle">
              {t("chatStream.activity.cluster.tasks", { done, total: todos.length })}
            </span>
            <span aria-hidden className="activity-cluster-miniprog">
              <i style={{ width: `${pct}%` }} />
            </span>
          </>
        )}

        <span aria-hidden className="h-3 w-px shrink-0 bg-edge" />
        <button
          type="button"
          onClick={() => openConsole("plans")}
          title={t("chatStream.activity.cluster.openPlans")}
          className="whitespace-nowrap text-[11px] tabular-nums text-content-subtle transition-colors hover:text-content"
        >
          {planBlocks.length > 0
            ? t("chatStream.activity.cluster.plans", { n: planBlocks.length })
            : t("chatStream.activity.cluster.noPlans")}
        </button>
      </div>
    </div>
  );

  // Mobile / web shell: a 380px panel does not fit a phone, so the same console
  // opens in the existing bottom sheet instead.
  if (!isElectron) {
    return (
      <>
        <div ref={rootRef} className="pointer-events-none absolute right-5 top-2 z-30 flex items-center">
          {cluster}
        </div>
        {sheetNode && (
          <ActivitySheet
            node={sheetNode}
            onPickNode={setSheetNode}
            subagents={subagents}
            todos={todos}
            planBlocks={planBlocks}
            bookmarks={bookmarks}
            isBookmarkStale={isBookmarkStale}
            tabs={tabs}
            onTabChange={setTab}
            onClose={() => setSheetNode(null)}
            onPickPlan={onPickPlan}
            onRemoveBookmark={onRemoveBookmark}
          />
        )}
      </>
    );
  }

  return (
    // The console is nested in this corner box on purpose: its containing block
    // is then a box this file owns, so `right-0` lines its right edge up with
    // the cluster's and nothing above can re-anchor it.
    <div ref={rootRef} className="pointer-events-none absolute right-5 top-2 z-30 flex items-center">
      {cluster}
      {openKind && (
        <div
          ref={panelRef}
          className={cn(
            "pointer-events-auto absolute right-0 top-[38px] z-40 flex max-h-[70dvh] w-[380px]",
            "max-w-[calc(100vw-64px)] flex-col overflow-hidden rounded-2xl border border-edge bg-surface/95",
            "backdrop-blur-xl shadow-[inset_0_1px_0_rgb(255_255_255/0.08),0_24px_48px_-12px_rgb(0_0_0/0.35)]",
            "animate-[capsule-pop-in_180ms_cubic-bezier(0.2,0.8,0.3,1)]",
          )}
        >
          {/* Notch on the TOP edge, pointing up at the cluster. Fixed offset
              from the right: the cluster's right edge is pinned here too, so
              the notch always sits under it (no measurement). */}
          <span
            aria-hidden
            className="absolute -top-[5px] right-[34px] h-2.5 w-2.5 rotate-45 border-l border-t border-edge bg-surface"
          />
          <ActivityConsole
            node={openKind}
            // Node tabs keep all four kinds reachable: the cluster's core only
            // opens the primary one, and the bar exposes plans.
            nodeTabs
            onPickNode={setOpenKind}
            subagents={subagents}
            todos={todos}
            planBlocks={planBlocks}
            bookmarks={bookmarks}
            isBookmarkStale={isBookmarkStale}
            tabs={tabs}
            onTabChange={setTab}
            onClose={() => setOpenKind(null)}
            onPickPlan={onPickPlan}
            onPickSubagent={onPickSubagent}
            onPickBookmark={onPickBookmark}
            onRemoveBookmark={onRemoveBookmark}
            onRenameBookmark={onRenameBookmark}
            showKeyHint
          />
        </div>
      )}
    </div>
  );
}
