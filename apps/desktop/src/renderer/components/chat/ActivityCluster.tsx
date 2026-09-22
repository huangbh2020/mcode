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
import type { SubagentSnapshot, BashTaskSnapshot, ServiceSnapshot } from "@contracts/runtime";
import type { SessionBookmark } from "@contracts/session";
import type { TodoItem } from "@renderer/stores/sessionStore.js";
import { ActivitySheet } from "@renderer/components/mobile/ActivitySheet.js";
import { IconBookmark, IconCheck, IconChevronDown, IconClipboard } from "@renderer/lib/icons.js";
import { ActivityConsole, hasNodeData } from "./ActivityConsole.js";
import {
  primaryKind,
  useActivityTabs,
  type ActivityNodeKey,
  type PlanBlock,
} from "./activityShared.js";
import type { Automation } from "@contracts/automation";
import { isInFlightAutomation } from "@renderer/components/automation/automationFormat.js";

export function ActivityCluster({
  subagents,
  todos,
  planBlocks,
  bookmarks,
  bashTasks,
  services,
  automations = [],
  waiting,
  isBookmarkStale,
  onPickBookmark,
  onRemoveBookmark,
  onRenameBookmark,
  onPickSubagent,
  onPickPlan,
  onStopBashTask,
  onStopService,
  onOpenService,
  onOpenSchedPanel,
  onNewSched,
  bookmarkNodeRef,
}: {
  subagents: SubagentSnapshot[];
  todos: TodoItem[];
  planBlocks: PlanBlock[];
  bookmarks: SessionBookmark[];
  bashTasks?: BashTaskSnapshot[];
  services?: ServiceSnapshot[];
  automations?: Automation[];
  waiting?: boolean;
  isBookmarkStale?: (b: SessionBookmark) => boolean;
  onPickBookmark?: (b: SessionBookmark) => void;
  onRemoveBookmark?: (b: SessionBookmark) => void;
  onRenameBookmark?: (b: SessionBookmark, title: string) => void;
  onPickSubagent?: (agent: SubagentSnapshot) => void;
  onPickPlan: (plan: string) => void;
  onStopBashTask?: (task: BashTaskSnapshot) => void;
  onStopService?: (service: ServiceSnapshot) => void;
  onOpenService?: (service: ServiceSnapshot) => void;
  onOpenSchedPanel?: () => void;
  onNewSched?: () => void;
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

  const commands = bashTasks ?? [];
  const serviceList = services ?? [];
  const inFlightSched = automations.filter(isInFlightAutomation);
  const hasAny =
    subagents.length > 0 ||
    todos.length > 0 ||
    planBlocks.length > 0 ||
    bookmarks.length > 0 ||
    commands.length > 0 ||
    serviceList.length > 0 ||
    automations.length > 0;
  if (!hasAny) return null;

  const running = subagents.filter((a) => a.status === "running");
  const failed = subagents.filter((a) => a.status === "failed");
  const runningCommands = commands.filter((c) => c.status === "running");
  const done = todos.filter((x) => x.status === "completed").length;
  const pct = todos.length > 0 ? Math.round((done / todos.length) * 100) : 0;
  const primary = primaryKind(subagents, todos, planBlocks, bookmarks, commands, serviceList);

  // Attention outranks activity: a pending question or a failed subagent is the
  // reason the bar exists at all. A failed agent while others still run keeps
  // the running copy (per the design doc's rule) — the console lists it.
  const attn = !!waiting || (running.length === 0 && failed.length > 0);
  const expanded = running.length > 0 || runningCommands.length > 0 || serviceList.length > 0 || inFlightSched.length > 0 || attn;
  const attnText = waiting
    ? t("chatStream.activity.cluster.waiting")
    : t("chatStream.activity.cluster.failed", { n: failed.length });

  const openConsole = (kind: ActivityNodeKey) => {
    if (isElectron) setOpenKind((prev) => (prev === kind ? null : kind));
    else setSheetNode((prev) => (prev === kind ? null : kind));
  };

  const isAllSettled = running.length === 0 && runningCommands.length === 0 && serviceList.length === 0 && inFlightSched.length === 0 && !attn;
  const hasLiveRunning = running.length > 0 || runningCommands.length > 0 || serviceList.length > 0 || inFlightSched.length > 0 || attn;
  const hasSatelliteData = todos.length > 0 || planBlocks.length > 0;
  const isSplit = hasLiveRunning && hasSatelliteData;

  const cluster = (
    <div
      ref={bookmarkNodeRef}
      className={cn(
        "group pointer-events-auto relative inline-flex items-center gap-1.5 transition-all duration-300 ease-[cubic-bezier(0.34,1.4,0.64,1)]",
        isSplit && "hover:gap-2.5",
      )}
    >
      {/* ── 主岛 (Main Island) ── */}
      <div
        onClick={() => openConsole(primary)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openConsole(primary);
          }
        }}
        aria-haspopup="dialog"
        aria-expanded={isElectron ? !!openKind : !!sheetNode}
        aria-label={t("chatStream.activity.cluster.aria")}
        className={cn(
          "relative inline-flex h-[34px] cursor-pointer select-none items-center gap-2 rounded-full px-3 py-1",
          "border backdrop-blur-2xl transition-all duration-300 ease-[cubic-bezier(0.34,1.3,0.64,1)]",
          "shadow-[0_4px_16px_rgba(0,0,0,0.22),inset_0_1px_0_rgba(255,255,255,0.2)]",
          "hover:scale-[1.02] active:scale-[0.98]",
          attn
            ? "border-warning/60 bg-warning/20 text-warning shadow-[0_0_16px_rgb(var(--warning)/0.35)]"
            : "border-black/[0.08] bg-[#000000]/90 text-white dark:border-white/[0.14] dark:bg-[#000000]/95",
        )}
      >
        {/* 1. Attention State */}
        {attn ? (
          <div className="flex items-center gap-2">
            <span className="apple-live-dot bg-warning" />
            <span className="whitespace-nowrap text-[12px] font-bold text-warning">{attnText}</span>
            <IconChevronDown
              size={11}
              strokeWidth={2.4}
              className="text-warning/80 transition-transform duration-200 group-hover:translate-y-0.5"
            />
          </div>
        ) : isSplit ? (
          /* 2. Split State: Main Island focuses on live running core */
          <div className="flex items-center gap-2">
            {serviceList.length > 0 ? (
              <div className="flex items-center gap-1.5">
                <span className="dynamic-island-wave text-success">
                  <span />
                  <span />
                  <span />
                </span>
                <span className="font-mono text-[11.5px] font-bold text-success">
                  :{serviceList[0]?.port ?? 3000}
                </span>
                {serviceList.length > 1 && (
                  <span className="text-[11px] font-medium text-white/70">
                    +{serviceList.length - 1}
                  </span>
                )}
              </div>
            ) : runningCommands.length > 0 ? (
              <div className="flex items-center gap-1.5">
                <span className="apple-live-dot bg-accent" />
                <span className="whitespace-nowrap text-[11.5px] font-bold text-white">
                  {t("chatStream.activity.deck.shortCommands", { n: runningCommands.length })}
                </span>
              </div>
            ) : running.length > 0 ? (
              <div className="flex items-center gap-1.5">
                <span className="apple-live-dot bg-warning" />
                <span className="whitespace-nowrap text-[11.5px] font-bold text-warning">
                  {t("chatStream.activity.deck.shortAgents", { n: running.length })}
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-1.5">
                <span className="apple-live-dot bg-sky-400" />
                <span className="whitespace-nowrap text-[11.5px] font-bold text-sky-400">
                  {t("chatStream.activity.cluster.schedRunning")}
                </span>
              </div>
            )}

            {/* Additional mini badge if multiple distinct live types */}
            {serviceList.length > 0 && runningCommands.length > 0 && (
              <>
                <span aria-hidden className="h-2.5 w-px bg-white/20" />
                <span className="text-[11px] font-semibold text-white/80">
                  {t("chatStream.activity.deck.shortCommands", { n: runningCommands.length })}
                </span>
              </>
            )}

            <IconChevronDown
              size={11}
              strokeWidth={2.4}
              className="text-white/60 transition-transform duration-200 group-hover:translate-y-0.5 group-hover:text-white"
            />
          </div>
        ) : !isAllSettled ? (
          /* 3. Single Merged Island with Live tasks */
          <div className="flex items-center gap-2">
            <span className="apple-live-dot bg-accent" />
            <span className="text-[12px] font-bold text-white">
              {todos.length > 0 ? `${done}/${todos.length}` : t("chatStream.activity.node.tasks")}
            </span>
            <IconChevronDown
              size={11}
              strokeWidth={2.4}
              className="text-white/60 transition-transform duration-200 group-hover:translate-y-0.5 group-hover:text-white"
            />
          </div>
        ) : (
          /* 4. Ambient / All Settled State (Single Merged Pebble Island) */
          <div className="flex items-center gap-2 text-white">
            {/* Emblem Icon Dock */}
            {todos.length > 0 && pct === 100 ? (
              <span className="grid h-[20px] w-[20px] shrink-0 place-items-center rounded-full bg-emerald-500/20 text-emerald-400 shadow-sm">
                <IconCheck size={12} strokeWidth={2.8} />
              </span>
            ) : todos.length > 0 ? (
              <span className="relative grid h-[20px] w-[20px] shrink-0 place-items-center">
                <svg className="-rotate-90" width="18" height="18">
                  <circle
                    cx="9"
                    cy="9"
                    r="6.5"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    fill="none"
                    className="text-white/20"
                  />
                  <circle
                    cx="9"
                    cy="9"
                    r="6.5"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    fill="none"
                    className="text-emerald-400"
                    strokeDasharray="40.84"
                    strokeDashoffset={`${40.84 * (1 - pct / 100)}`}
                    strokeLinecap="round"
                  />
                </svg>
              </span>
            ) : planBlocks.length > 0 ? (
              <span className="grid h-[20px] w-[20px] shrink-0 place-items-center rounded-full bg-indigo-500/20 text-indigo-300 shadow-sm">
                <IconClipboard size={11} strokeWidth={2.2} />
              </span>
            ) : bookmarks.length > 0 ? (
              <span className="grid h-[20px] w-[20px] shrink-0 place-items-center rounded-full bg-amber-500/20 text-amber-300 shadow-sm">
                <IconBookmark size={11} strokeWidth={2.2} />
              </span>
            ) : (
              <span className="grid h-[20px] w-[20px] shrink-0 place-items-center rounded-full bg-white/10 text-white/80 shadow-sm">
                <IconCheck size={11} strokeWidth={2.4} />
              </span>
            )}

            {/* Typography */}
            {todos.length > 0 ? (
              <div className="flex items-center gap-1.5 leading-none">
                <span className="font-mono text-[12px] font-bold tabular-nums tracking-tight text-white">
                  {done}/{todos.length}
                </span>
                <span className="text-[11px] font-medium text-white/70">
                  {pct === 100 ? t("chatStream.activity.groupCompleted") : t("chatStream.activity.node.tasks")}
                </span>
              </div>
            ) : planBlocks.length > 0 ? (
              <span className="text-[11.5px] font-semibold tracking-tight text-white">
                {t("chatStream.activity.deck.shortPlans", { n: planBlocks.length })}
              </span>
            ) : bookmarks.length > 0 ? (
              <span className="text-[11.5px] font-semibold tracking-tight text-white">
                {t("chatStream.activity.deck.shortBookmarks", { n: bookmarks.length })}
              </span>
            ) : (
              <span className="text-[11.5px] font-semibold tracking-tight text-white">
                {t("chatStream.activity.deck.allSettled")}
              </span>
            )}

            {/* Secondary plans tag alongside settled todos */}
            {todos.length > 0 && planBlocks.length > 0 && (
              <>
                <span aria-hidden className="h-1 w-1 rounded-full bg-white/30" />
                <span className="text-[11px] font-medium text-white/70">
                  {t("chatStream.activity.deck.shortPlans", { n: planBlocks.length })}
                </span>
              </>
            )}

            <IconChevronDown
              size={11}
              strokeWidth={2.4}
              className="text-white/60 transition-all duration-200 group-hover:translate-y-0.5 group-hover:text-white"
            />
          </div>
        )}
      </div>

      {/* ── 伴随卫星岛 (Satellite Island) ──
          Only renders when split: displays task progress or secondary stats */}
      {isSplit && (
        <div
          onClick={() => openConsole(todos.length > 0 ? "tasks" : "plans")}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              openConsole(todos.length > 0 ? "tasks" : "plans");
            }
          }}
          title={
            todos.length > 0
              ? `${done}/${todos.length} (${pct}%)`
              : t("chatStream.activity.deck.shortPlans", { n: planBlocks.length })
          }
          className={cn(
            "relative grid h-[34px] w-[34px] cursor-pointer select-none place-items-center rounded-full",
            "border border-black/[0.08] bg-[#000000]/90 text-white dark:border-white/[0.14] dark:bg-[#000000]/95",
            "shadow-[0_4px_16px_rgba(0,0,0,0.22),inset_0_1px_0_rgba(255,255,255,0.2)]",
            "backdrop-blur-2xl transition-all duration-300 ease-[cubic-bezier(0.34,1.3,0.64,1)]",
            "hover:scale-[1.08] active:scale-[0.95]",
          )}
        >
          {todos.length > 0 ? (
            <svg className="-rotate-90" width="18" height="18">
              <circle
                cx="9"
                cy="9"
                r="6.5"
                stroke="currentColor"
                strokeWidth="2.2"
                fill="none"
                className="text-white/20"
              />
              <circle
                cx="9"
                cy="9"
                r="6.5"
                stroke="currentColor"
                strokeWidth="2.2"
                fill="none"
                className="text-accent"
                strokeDasharray="40.84"
                strokeDashoffset={`${40.84 * (1 - pct / 100)}`}
                strokeLinecap="round"
              />
            </svg>
          ) : (
            <IconClipboard size={12} className="text-white/80" />
          )}
        </div>
      )}
    </div>
  );

  // Mobile / web shell: a 390px panel does not fit a phone, so the same console
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
            bashTasks={commands}
            onStopBashTask={onStopBashTask}
            services={serviceList}
            onStopService={onStopService}
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
    <div ref={rootRef} className="pointer-events-none absolute right-5 top-2 z-30 flex items-center">
      {cluster}
      {openKind && (
        <div
          ref={panelRef}
          className={cn(
            "pointer-events-auto absolute right-0 top-[42px] z-40 flex max-h-[78dvh] w-[390px]",
            "max-w-[calc(100vw-40px)] flex-col overflow-hidden rounded-[26px] border border-white/[0.14] bg-[#0c0d12]/94",
            "backdrop-blur-3xl text-white shadow-[0_28px_64px_-12px_rgba(0,0,0,0.7),inset_0_1px_0_rgba(255,255,255,0.18)]",
            "animate-[capsule-pop-in_240ms_cubic-bezier(0.34,1.3,0.64,1)]",
          )}
        >
          <ActivityConsole
            node={openKind}
            nodeTabs
            onPickNode={setOpenKind}
            subagents={subagents}
            todos={todos}
            planBlocks={planBlocks}
            bookmarks={bookmarks}
            bashTasks={commands}
            onStopBashTask={onStopBashTask}
            services={serviceList}
            onStopService={onStopService}
            onOpenService={onOpenService}
            automations={automations}
            onOpenSchedPanel={onOpenSchedPanel}
            onNewSched={onNewSched}
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
