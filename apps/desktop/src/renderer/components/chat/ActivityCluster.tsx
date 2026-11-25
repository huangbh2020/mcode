/**
 * ActivityCluster — 输入框上方的三段式活动托盘（方案 B「部分拆开」）。
 *
 * 按紧急度与关注频率将原右上角胶囊拆分为三层，贴合输入框上沿渲染：
 *   1. 左侧 · 实时焦点芯片（服务 / 命令 / 子代理 / 注意态 / 运行中定时任务）
 *   2. 左侧 · 任务进度芯片（todos 迷你进度条 + done/total）
 *   3. 右侧 · 静态资产收纳（计划 / 书签 / 子会话 / 定时排期）+ 流式速率 (tok/s)
 *
 * 点击任意芯片在输入框上方就地向上弹出 ActivityConsole；移动端/Web 壳
 * 保留底部的 ActivitySheet 交互。
 */
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { isElectron } from "@renderer/lib/platform.js";
import { useNow } from "@renderer/hooks/useNow.js";
import { STREAM_RATE_STALE_MS, type StreamRateSnapshot, type TodoItem } from "@renderer/stores/sessionStore.js";
import type { SubagentSnapshot, BashTaskSnapshot, ServiceSnapshot } from "@contracts/runtime";
import type { Session, SessionBookmark } from "@contracts/session";
import { ActivitySheet } from "@renderer/components/mobile/ActivitySheet.js";
import { IconCheck, IconChevronUp, IconLayoutGrid, IconServer, IconTerminal2, PiRobot } from "@renderer/lib/icons.js";
import { ActivityPopoverCard } from "./ActivityPopoverCard.js";
import {
  primaryKind,
  useActivityTabs,
  type ActivityNodeKey,
  type PlanBlock,
} from "./activityShared.js";
import type { Automation } from "@contracts/automation";
import { isInFlightAutomation } from "@renderer/components/automation/automationFormat.js";

type ChipTone = "default" | "accent" | "warning" | "success";

function TrayChip({
  active,
  tone = "default",
  onClick,
  title,
  ariaExpanded,
  children,
}: {
  active?: boolean;
  tone?: ChipTone;
  onClick: () => void;
  title?: string;
  ariaExpanded?: boolean;
  children: ReactNode;
}) {
  const toneCls =
    tone === "warning"
      ? active
        ? "border-warning bg-warning/20 text-warning ring-2 ring-warning/20"
        : "border-warning/50 bg-warning/10 text-warning hover:bg-warning/20"
      : tone === "success"
        ? active
          ? "border-success bg-success/15 text-success"
          : "border-success/40 bg-success/10 text-success hover:bg-success/15"
        : tone === "accent"
          ? active
            ? "border-accent bg-accent/15 text-accent"
            : "border-edge bg-surface text-content hover:border-accent/50"
          : active
            ? "border-accent bg-accent/12 text-accent"
            : "border-edge bg-surface/80 text-content-muted hover:border-content-subtle/50 hover:text-content";

  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-haspopup="dialog"
      aria-expanded={ariaExpanded}
      className={cn(
        "inline-flex h-7 cursor-pointer select-none items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-[11.5px] font-medium transition-all duration-150 active:scale-[0.98]",
        toneCls,
      )}
    >
      {children}
    </button>
  );
}

export function ActivityCluster({
  subagents,
  todos,
  planBlocks,
  bookmarks,
  bashTasks,
  services,
  sideChats,
  sideChatRunningIds,
  onOpenSideChat,
  automations = [],
  streamRate = null,
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
  sideChats?: Session[];
  sideChatRunningIds?: ReadonlySet<string>;
  onOpenSideChat?: (s: Session) => void;
  automations?: Automation[];
  streamRate?: StreamRateSnapshot | null;
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
  const now = useNow();
  const [openKind, setOpenKind] = useState<ActivityNodeKey | null>(null);
  const [alignRight, setAlignRight] = useState(false);
  const [sheetNode, setSheetNode] = useState<ActivityNodeKey | null>(null);
  const { tabs, setTab } = useActivityTabs();
  const panelRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Escape / outside-press dismissal (capture phase)
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
  const sideChatList = sideChats ?? [];
  const inFlightSched = automations.filter(isInFlightAutomation);
  const rateFresh = !!streamRate && now - streamRate.lastDeltaAt <= STREAM_RATE_STALE_MS;
  const rateText = streamRate
    ? t("chatStream.streamRate", {
        n: streamRate.tokensPerSec >= 100 ? String(Math.round(streamRate.tokensPerSec)) : streamRate.tokensPerSec.toFixed(1),
      })
    : "";

  const hasAny =
    subagents.length > 0 ||
    todos.length > 0 ||
    planBlocks.length > 0 ||
    bookmarks.length > 0 ||
    commands.length > 0 ||
    serviceList.length > 0 ||
    sideChatList.length > 0 ||
    automations.length > 0 ||
    rateFresh;
  if (!hasAny) return null;

  const running = subagents.filter((a) => a.status === "running");
  const failed = subagents.filter((a) => a.status === "failed");
  const runningCommands = commands.filter((c) => c.status === "running");
  const runningSideChats = sideChatList.filter((s) => sideChatRunningIds?.has(s.id));
  const done = todos.filter((x) => x.status === "completed").length;
  const pct = todos.length > 0 ? Math.round((done / todos.length) * 100) : 0;
  const primary = primaryKind(subagents, todos, planBlocks, bookmarks, commands, serviceList);

  const attn = !!waiting || (running.length === 0 && failed.length > 0);
  const attnText = waiting
    ? t("chatStream.activity.cluster.waiting")
    : t("chatStream.activity.cluster.failed", { n: failed.length });

  const assetsCount =
    planBlocks.length + bookmarks.length + sideChatList.length + automations.length;

  const openConsole = (kind: ActivityNodeKey, right = false) => {
    if (!isElectron) {
      setSheetNode((prev) => (prev === kind ? null : kind));
      return;
    }
    setAlignRight(right);
    setOpenKind((prev) => (prev === kind ? null : kind));
  };

  // Mobile / web shell: render a compact trigger row that opens the bottom sheet.
  if (!isElectron) {
    return (
      <>
        <div ref={rootRef} className="mb-1.5 flex items-center justify-between gap-2 px-0.5">
          <div ref={bookmarkNodeRef} className="flex flex-wrap items-center gap-1.5">
            {attn && (
              <TrayChip tone="warning" onClick={() => openConsole(waiting ? primary : "subagents")}>
                <span className="apple-live-dot bg-warning" />
                <span>{attnText}</span>
              </TrayChip>
            )}
            {running.length > 0 && (
              <TrayChip tone="accent" onClick={() => openConsole("subagents")}>
                <span className="apple-live-dot bg-warning" />
                <span>{t("chatStream.activity.cluster.running", { n: running.length })}</span>
              </TrayChip>
            )}
            {todos.length > 0 && (
              <TrayChip tone={pct === 100 ? "success" : "accent"} onClick={() => openConsole("tasks")}>
                <span className="font-mono font-semibold">{done}/{todos.length}</span>
                <span>{t("chatStream.activity.node.tasks")}</span>
              </TrayChip>
            )}
            {!attn && running.length === 0 && todos.length === 0 && (
              <TrayChip onClick={() => openConsole(primary)}>
                <span>{t("chatStream.activity.cluster.aria")}</span>
              </TrayChip>
            )}
          </div>
          {rateFresh && (
            <span className="shrink-0 text-[11px] font-medium tabular-nums text-content-subtle">
              {rateText}
            </span>
          )}
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
            sideChats={sideChatList}
            sideChatRunningIds={sideChatRunningIds}
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
    <div ref={rootRef} className="relative mb-1.5 flex w-full items-center justify-between gap-2 px-0.5">
      {/* ── 左侧：实时焦点 + 任务进度 ── */}
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {/* 1. 注意/阻塞态 */}
        {attn && (
          <TrayChip
            tone="warning"
            active={openKind === (waiting ? primary : "subagents")}
            ariaExpanded={openKind === (waiting ? primary : "subagents")}
            onClick={() => openConsole(waiting ? primary : "subagents")}
          >
            <span className="apple-live-dot bg-warning" />
            <span>{attnText}</span>
          </TrayChip>
        )}

        {/* 2. 实时服务 */}
        {serviceList.length > 0 && (
          <TrayChip
            tone="success"
            active={openKind === "services"}
            ariaExpanded={openKind === "services"}
            onClick={() => openConsole("services")}
          >
            <IconServer size={12} />
            <span className="font-mono font-semibold">:{serviceList[0]?.port ?? 3000}</span>
            {serviceList.length > 1 && <span className="opacity-75">+{serviceList.length - 1}</span>}
          </TrayChip>
        )}

        {/* 3. 运行中命令 */}
        {runningCommands.length > 0 && (
          <TrayChip
            tone="accent"
            active={openKind === "commands"}
            ariaExpanded={openKind === "commands"}
            onClick={() => openConsole("commands")}
          >
            <span className="apple-live-dot bg-accent" />
            <IconTerminal2 size={12} />
            <span>{t("chatStream.activity.deck.shortCommands", { n: runningCommands.length })}</span>
          </TrayChip>
        )}

        {/* 4. 子代理（运行中突出；仅历史时轻量展示） */}
        {running.length > 0 ? (
          <TrayChip
            tone="accent"
            active={openKind === "subagents"}
            ariaExpanded={openKind === "subagents"}
            onClick={() => openConsole("subagents")}
          >
            <span className="apple-live-dot bg-warning" />
            <span>{t("chatStream.activity.cluster.running", { n: running.length })}</span>
          </TrayChip>
        ) : subagents.length > 0 && !attn ? (
          <TrayChip
            active={openKind === "subagents"}
            ariaExpanded={openKind === "subagents"}
            onClick={() => openConsole("subagents")}
          >
            <PiRobot size={12} />
            <span>{t("chatStream.activity.deck.shortAgents", { n: subagents.length })}</span>
          </TrayChip>
        ) : null}

        {/* 5. 运行中子会话 */}
        {runningSideChats.length > 0 && (
          <TrayChip
            tone="accent"
            active={openKind === "sidechats"}
            ariaExpanded={openKind === "sidechats"}
            onClick={() => openConsole("sidechats")}
          >
            <span className="apple-live-dot bg-indigo-500 dark:bg-indigo-400" />
            <span>{t("chatStream.activity.deck.shortSideChats", { n: runningSideChats.length })}</span>
          </TrayChip>
        )}

        {/* 6. 执行中定时任务 */}
        {inFlightSched.length > 0 && (
          <TrayChip
            tone="accent"
            active={openKind === "sched"}
            ariaExpanded={openKind === "sched"}
            onClick={() => openConsole("sched")}
          >
            <span className="apple-live-dot bg-sky-400" />
            <span>{t("chatStream.activity.cluster.schedRunning")}</span>
          </TrayChip>
        )}

        {/* 7. 任务进度（独立拆出） */}
        {todos.length > 0 && (
          <TrayChip
            tone={pct === 100 ? "success" : "accent"}
            active={openKind === "tasks"}
            ariaExpanded={openKind === "tasks"}
            onClick={() => openConsole("tasks")}
            title={`${done}/${todos.length} (${pct}%)`}
          >
            {pct === 100 ? (
              <IconCheck size={12} strokeWidth={2.5} />
            ) : (
              <span className="h-1.5 w-7 overflow-hidden rounded-full bg-edge">
                <span className="block h-full rounded-full bg-accent transition-all duration-300" style={{ width: `${pct}%` }} />
              </span>
            )}
            <span className="font-mono font-semibold tabular-nums">
              {done}/{todos.length}
            </span>
            <span className="text-content-muted">{t("chatStream.activity.node.tasks")}</span>
          </TrayChip>
        )}
      </div>

      {/* ── 右侧：静态资产收纳 + 流式速率 ── */}
      <div ref={bookmarkNodeRef} className="flex shrink-0 items-center gap-1.5">
        {assetsCount > 0 && (
          <TrayChip
            active={openKind === "overview"}
            ariaExpanded={openKind === "overview"}
            onClick={() => openConsole("overview", true)}
            title={t("chatStream.activity.deck.assets")}
          >
            <IconLayoutGrid size={12} />
            <span>{t("chatStream.activity.deck.assetsCount", { n: assetsCount })}</span>
            <IconChevronUp
              size={11}
              className={cn("transition-transform duration-150", openKind === "overview" && "rotate-180")}
            />
          </TrayChip>
        )}
        {rateFresh && (
          <span
            className="whitespace-nowrap px-1 text-[11px] font-medium tabular-nums text-content-subtle"
            title={t("chatStream.streamRateHint")}
          >
            {rateText}
          </span>
        )}
      </div>

      {/* ── 向上弹出的专属详情卡片 ── */}
      {openKind && (
        <div
          ref={panelRef}
          className={cn(
            "pointer-events-auto absolute bottom-[calc(100%+8px)] z-40",
            alignRight ? "right-0" : "left-0",
            "animate-[capsule-pop-up_200ms_cubic-bezier(0.22,1,0.36,1)]",
          )}
        >
          <ActivityPopoverCard
            node={openKind}
            subagents={subagents}
            todos={todos}
            planBlocks={planBlocks}
            bookmarks={bookmarks}
            bashTasks={commands}
            services={serviceList}
            sideChats={sideChatList}
            sideChatRunningIds={sideChatRunningIds}
            automations={automations}
            isBookmarkStale={isBookmarkStale}
            onClose={() => setOpenKind(null)}
            onPickPlan={onPickPlan}
            onPickSubagent={onPickSubagent}
            onStopBashTask={onStopBashTask}
            onStopService={onStopService}
            onOpenService={onOpenService}
            onPickBookmark={onPickBookmark}
            onRemoveBookmark={onRemoveBookmark}
            onRenameBookmark={onRenameBookmark}
            onOpenSideChat={onOpenSideChat}
            onOpenSchedPanel={onOpenSchedPanel}
            onNewSched={onNewSched}
          />
        </div>
      )}
    </div>
  );
}
