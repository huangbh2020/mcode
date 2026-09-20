/**
 * SchedPanel — the right panel's「定时任务」tab (重构版: 左右两栏布局 + 实例模型输出).
 *
 * Layout:
 *  - Left rail: 定时任务列表, 分为「活跃任务」与「已删除」分段切换.
 *    提供暂停/恢复、立即运行、软删除(移入已删除)、恢复任务、彻底删除操作.
 *  - Right rail: 选中的定时任务概览 + 运行实例列表(正在运行置顶).
 *    点击任意实例卡片切换至「实例模型输出详情视图」(参考子会话 SubagentView),
 *    以 MessageBlocks 高保真渲染该次运行的 Prompt 与模型输出(思考、工具调用、回复),
 *    运行中实例支持流式自动跟随滚动.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { Automation, AutomationRunEntry } from "@contracts/automation";
import type { ChatMessage } from "@renderer/stores/sessionStore.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { formatDuration } from "@renderer/components/chat/activityShared.js";
import { ConfirmDialog } from "@renderer/components/ui/index.js";
import { ChatPane } from "@renderer/components/chat/ChatPane.js";
import {
  IconClock,
  IconArrowLeft,
  IconTrash,
  IconRefresh,
  IconPlayerPlay,
  IconPlayerPause,
  IconMessages,
  IconX,
} from "@renderer/lib/icons.js";
import { cn } from "@renderer/lib/cn.js";
import {
  describeSchedule,
  findRunAnchor,
  fmtClock,
  sortAutomations,
  statusMeta,
  taskNextLine,
} from "./automationFormat.js";

const EMPTY_RUNS: AutomationRunEntry[] = [];
const EMPTY_MESSAGES: ChatMessage[] = [];
const RUN_HISTORY_PAGE = 10;

export function SchedPanel() {
  const { t } = useI18n();
  const automations = useSessionStore((s) => s.automations);
  const selectedId = useSessionStore((s) => s.schedSelectedId);
  const filterParent = useSessionStore((s) => s.schedFilterParent);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const setSchedSelected = useSessionStore((s) => s.setSchedSelected);
  const setSchedFilterParent = useSessionStore((s) => s.setSchedFilterParent);
  const setAutomationEnabled = useSessionStore((s) => s.setAutomationEnabled);
  const deleteAutomation = useSessionStore((s) => s.deleteAutomation);
  const restoreAutomation = useSessionStore((s) => s.restoreAutomation);
  const runAutomationNow = useSessionStore((s) => s.runAutomationNow);
  const prefetchSessionMessages = useSessionStore((s) => s.prefetchSessionMessages);
  const openTab = useSessionStore((s) => s.openTab);

  /* Tab for left task list: active vs deleted */
  const [listTab, setListTab] = useState<"active" | "deleted">("active");

  /* Scope handling */
  const baseScope = useMemo(() => {
    const st = useSessionStore.getState();
    const active = activeSessionId ? st.getSessionById(activeSessionId) : undefined;
    if (!active) return null;
    if (active.kind === "automation") return active.parentSessionId ?? active.id;
    return active.id;
  }, [activeSessionId]);
  const scope = filterParent ?? baseScope;
  const viewingOther = filterParent != null && filterParent !== baseScope;
  const scopeTitle = useSessionStore((s) =>
    scope ? (s.getSessionById(scope)?.title ?? null) : null,
  );

  const scopedAll = useMemo(
    () => (scope ? automations.filter((a) => a.parentSessionId === scope) : automations),
    [automations, scope],
  );

  const activeTasks = useMemo(
    () => sortAutomations(scopedAll.filter((a) => !a.deletedAt)),
    [scopedAll],
  );

  const deletedTasks = useMemo(
    () => scopedAll.filter((a) => a.deletedAt != null),
    [scopedAll],
  );

  const currentTasks = listTab === "active" ? activeTasks : deletedTasks;

  /* Selected derives from current category */
  const selected: Automation | null = useMemo(() => {
    if (selectedId) {
      const match = currentTasks.find((a) => a.id === selectedId);
      if (match) return match;
    }
    return currentTasks[0] ?? null;
  }, [currentTasks, selectedId]);

  const taskSessionId = selected?.taskSessionId ?? null;

  /* Prefetch transcript for selected task */
  useEffect(() => {
    if (taskSessionId) void prefetchSessionMessages(taskSessionId);
  }, [taskSessionId, prefetchSessionMessages]);

  /* Right pane: which run is currently being viewed (null = instance list view) */
  const [viewedRunAt, setViewedRunAt] = useState<number | null>(null);
  const [runsVisible, setRunsVisible] = useState(RUN_HISTORY_PAGE);

  /* Reset viewed run when task selection changes */
  useEffect(() => {
    setViewedRunAt(null);
    setRunsVisible(RUN_HISTORY_PAGE);
  }, [selected?.id]);

  /* Run log data */
  const runLog = selected?.runLog ?? EMPTY_RUNS;
  const runsNewestFirst = useMemo(() => [...runLog].reverse(), [runLog]);
  const runsShown = runsNewestFirst.slice(0, runsVisible);
  const runsHidden = runsNewestFirst.length - runsShown.length;

  /* Messages from store */
  const messages =
    useSessionStore((s) => (taskSessionId ? s.messagesBySession[taskSessionId] : undefined)) ??
    EMPTY_MESSAGES;

  /* Confirm dialogs */
  const [softDeleteTarget, setSoftDeleteTarget] = useState<Automation | null>(null);
  const [permDeleteTarget, setPermDeleteTarget] = useState<Automation | null>(null);

  /* Active running run entry (if any) */
  const isRunning =
    selected?.lastStatus === "running" || selected?.lastStatus === "waiting-approval";
  const activeRunEntry =
    runLog.length > 0 && isRunning ? runLog[runLog.length - 1] : null;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-row divide-x divide-edge">
      {/* ── Left Rail: Task List ── */}
      <div className="flex w-64 min-w-[230px] max-w-[280px] shrink-0 flex-col bg-surface">
        {/* Scope banner if filtered from another session */}
        {viewingOther && (
          <div className="flex items-center gap-1.5 border-b border-edge bg-surface-muted px-2 py-1 text-[11px] text-content-muted">
            <span className="truncate">
              {t("automation.filterBy")}: {scopeTitle ?? scope}
            </span>
            <button
              type="button"
              onClick={() => setSchedFilterParent(null)}
              title={t("automation.backToCurrent")}
              className="ml-auto rounded p-0.5 hover:bg-surface-hover"
            >
              <IconX size={11} />
            </button>
          </div>
        )}

        {/* Header & Tabs */}
        <div className="flex shrink-0 flex-col border-b border-edge p-2">
          <div className="flex items-center justify-between pb-1.5">
            <span className="text-xs font-bold uppercase tracking-wider text-content">
              {t("automation.taskListTitle")}
            </span>
            <span className="text-[10px] text-content-subtle">
              {activeTasks.length} / {scopedAll.length}
            </span>
          </div>
          {/* Segmented Control: Active vs Deleted */}
          <div className="flex rounded-md bg-surface-muted p-0.5 text-[11px] font-medium">
            <button
              type="button"
              onClick={() => {
                setListTab("active");
                if (activeTasks[0]) setSchedSelected(activeTasks[0].id);
              }}
              className={cn(
                "flex-1 rounded py-1 text-center transition-colors",
                listTab === "active"
                  ? "bg-surface font-semibold text-content shadow-sm"
                  : "text-content-muted hover:text-content",
              )}
            >
              {t("automation.tabActive")} ({activeTasks.length})
            </button>
            <button
              type="button"
              onClick={() => {
                setListTab("deleted");
                if (deletedTasks[0]) setSchedSelected(deletedTasks[0].id);
              }}
              className={cn(
                "flex-1 rounded py-1 text-center transition-colors",
                listTab === "deleted"
                  ? "bg-surface font-semibold text-content shadow-sm"
                  : "text-content-muted hover:text-content",
              )}
            >
              {t("automation.tabDeleted")} ({deletedTasks.length})
            </button>
          </div>
        </div>

        {/* Task rows list */}
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5 space-y-1">
          {currentTasks.length === 0 && (
            <div className="px-3 py-6 text-center text-xs text-content-subtle">
              {listTab === "active"
                ? t("automation.emptyActiveTasks")
                : t("automation.emptyDeletedTasks")}
            </div>
          )}

          {currentTasks.map((task) => {
            const meta = statusMeta(task.lastStatus);
            const isSelected = selected?.id === task.id;
            const isDeleted = task.deletedAt != null;

            return (
              <div
                key={task.id}
                onClick={() => setSchedSelected(task.id)}
                className={cn(
                  "group relative flex cursor-pointer flex-col gap-1 rounded-lg border p-2 transition-all text-left",
                  isSelected
                    ? "border-accent/40 bg-accent/10 shadow-xs"
                    : "border-transparent bg-surface-muted/30 hover:border-edge hover:bg-surface-hover",
                )}
              >
                <div className="flex items-center gap-1.5">
                  <IconClock
                    size={13}
                    className={cn(
                      "shrink-0",
                      isDeleted
                        ? "text-content-subtle"
                        : task.enabled
                          ? "text-accent"
                          : "text-content-subtle",
                    )}
                  />
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate text-xs font-semibold",
                      isDeleted && "text-content-muted line-through opacity-80",
                    )}
                    title={task.title}
                  >
                    {task.title}
                  </span>
                  <span
                    className={cn(
                      "shrink-0 rounded-full px-1.5 text-[9.5px] font-semibold",
                      meta.badgeClass,
                    )}
                  >
                    {meta.label}
                  </span>
                </div>

                <div className="flex items-center justify-between text-[10.5px] text-content-subtle">
                  <span className="truncate">
                    {isDeleted
                      ? t("automation.deletedAt", { time: fmtClock(task.deletedAt ?? 0) })
                      : describeSchedule(task.schedule)}
                  </span>
                  {!isDeleted && task.runLog.length > 0 && (
                    <span className="shrink-0 font-mono">
                      {t("automation.runCount", { n: task.runLog.length })}
                    </span>
                  )}
                </div>

                {/* Quick actions bar inside row */}
                <div
                  className="mt-1 flex items-center justify-end gap-1 pt-1 border-t border-edge/40"
                  onClick={(e) => e.stopPropagation()}
                >
                  {!isDeleted ? (
                    <>
                      <button
                        type="button"
                        onClick={() => void setAutomationEnabled(task.id, !task.enabled)}
                        title={task.enabled ? t("automation.pause") : t("automation.resume")}
                        className={cn(
                          "flex h-5 items-center gap-1 rounded px-1.5 text-[10px] font-medium transition-colors",
                          task.enabled
                            ? "text-warning hover:bg-warning/15"
                            : "text-accent hover:bg-accent/15",
                        )}
                      >
                        {task.enabled ? (
                          <>
                            <IconPlayerPause size={10} />
                            {t("automation.pause")}
                          </>
                        ) : (
                          <>
                            <IconPlayerPlay size={10} />
                            {t("automation.resume")}
                          </>
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => void runAutomationNow(task.id)}
                        title={t("automation.runNow")}
                        className="flex h-5 items-center gap-1 rounded px-1.5 text-[10px] font-medium text-content-muted hover:bg-surface-hover hover:text-content"
                      >
                        <IconPlayerPlay size={10} />
                        {t("automation.runNow")}
                      </button>
                      <button
                        type="button"
                        onClick={() => setSoftDeleteTarget(task)}
                        title={t("automation.delete")}
                        className="flex h-5 w-5 items-center justify-center rounded text-content-subtle hover:bg-danger/15 hover:text-danger"
                      >
                        <IconTrash size={11} />
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => void restoreAutomation(task.id)}
                        title={t("automation.restore")}
                        className="flex h-5 items-center gap-1 rounded px-1.5 text-[10px] font-medium text-accent hover:bg-accent/15"
                      >
                        <IconRefresh size={10} />
                        {t("automation.restore")}
                      </button>
                      <button
                        type="button"
                        onClick={() => setPermDeleteTarget(task)}
                        title={t("automation.permanentDelete")}
                        className="flex h-5 items-center gap-1 rounded px-1.5 text-[10px] font-medium text-danger hover:bg-danger/15"
                      >
                        <IconTrash size={10} />
                        {t("automation.permanentDelete")}
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Right Rail: Instances & Output Details ── */}
      <div className="flex min-h-0 flex-1 flex-col bg-surface-muted/20">
        {!selected ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-content-subtle">
            <IconClock size={28} className="opacity-40" />
            <p className="text-xs">{t("automation.selectTaskHint")}</p>
          </div>
        ) : viewedRunAt != null ? (
          /* View Mode 2: Instance Output Details (参考子会话 SubagentView) */
          <InstanceOutputDetailView
            task={selected}
            firedAt={viewedRunAt}
            messages={messages}
            onBack={() => setViewedRunAt(null)}
            onOpenSession={() => {
              if (selected.taskSessionId) void openTab(selected.taskSessionId);
            }}
          />
        ) : (
          /* View Mode 1: Task Overview & Instance History List */
          <TaskOverviewAndInstanceList
            task={selected}
            runLog={runLog}
            runsShown={runsShown}
            runsHidden={runsHidden}
            activeRunEntry={activeRunEntry}
            onSelectRun={(firedAt) => setViewedRunAt(firedAt)}
            onLoadMore={() => setRunsVisible((v) => v + RUN_HISTORY_PAGE)}
            onDelete={() => setSoftDeleteTarget(selected)}
            onRestore={() => void restoreAutomation(selected.id)}
            onPermDelete={() => setPermDeleteTarget(selected)}
          />
        )}
      </div>

      {/* Soft Delete Confirm Dialog */}
      <ConfirmDialog
        open={softDeleteTarget != null}
        title={t("automation.softDeleteConfirmTitle")}
        description={t("automation.softDeleteConfirmBody")}
        confirmText={t("common.delete")}
        onOpenChange={(open) => {
          if (!open) setSoftDeleteTarget(null);
        }}
        onConfirm={() => {
          if (softDeleteTarget) void deleteAutomation(softDeleteTarget.id, false);
        }}
      />

      {/* Permanent Hard Delete Confirm Dialog */}
      <ConfirmDialog
        open={permDeleteTarget != null}
        danger
        title={t("automation.permanentDeleteConfirmTitle")}
        description={t("automation.permanentDeleteConfirmBody", {
          title: permDeleteTarget?.title ?? "",
        })}
        confirmText={t("automation.permanentDelete")}
        onOpenChange={(open) => {
          if (!open) setPermDeleteTarget(null);
        }}
        onConfirm={() => {
          if (permDeleteTarget) void deleteAutomation(permDeleteTarget.id, true);
        }}
      />
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
 * View Mode 1: Task Overview Card + Instances List
 * ────────────────────────────────────────────────────────────────────────── */

function TaskOverviewAndInstanceList({
  task,
  runLog,
  runsShown,
  runsHidden,
  activeRunEntry,
  onSelectRun,
  onLoadMore,
  onDelete,
  onRestore,
  onPermDelete,
}: {
  task: Automation;
  runLog: AutomationRunEntry[];
  runsShown: AutomationRunEntry[];
  runsHidden: number;
  activeRunEntry: AutomationRunEntry | null;
  onSelectRun: (firedAt: number) => void;
  onLoadMore: () => void;
  onDelete: () => void;
  onRestore: () => void;
  onPermDelete: () => void;
}) {
  const { t } = useI18n();
  const setAutomationEnabled = useSessionStore((s) => s.setAutomationEnabled);
  const runAutomationNow = useSessionStore((s) => s.runAutomationNow);
  const meta = statusMeta(task.lastStatus);
  const isDeleted = task.deletedAt != null;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-y-auto p-4 space-y-4">
      {/* Task Overview Card */}
      <div className="rounded-xl border border-edge bg-surface p-3.5 shadow-xs">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <IconClock
                size={16}
                className={cn(
                  "shrink-0",
                  isDeleted ? "text-content-subtle" : task.enabled ? "text-accent" : "text-content-subtle",
                )}
              />
              <h2
                className={cn(
                  "truncate text-sm font-bold text-content",
                  isDeleted && "line-through opacity-80",
                )}
              >
                {task.title}
              </h2>
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-[10.5px] font-semibold",
                  meta.badgeClass,
                )}
              >
                {meta.label}
              </span>
            </div>

            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-content-muted">
              <span>{describeSchedule(task.schedule)}</span>
              {!isDeleted && taskNextLine(task) && <span>· {taskNextLine(task)}</span>}
              {task.model && <span>· {task.model}</span>}
              {runLog.length > 0 && (
                <span>· {t("automation.runCount", { n: runLog.length })}</span>
              )}
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex shrink-0 items-center gap-1.5">
            {!isDeleted ? (
              <>
                <button
                  type="button"
                  onClick={() => void setAutomationEnabled(task.id, !task.enabled)}
                  className={cn(
                    "rounded-md border px-2.5 py-1 text-xs font-semibold transition-colors",
                    task.enabled
                      ? "border-warning/40 text-warning hover:bg-warning/10"
                      : "border-accent/40 text-accent hover:bg-accent/10",
                  )}
                >
                  {task.enabled ? t("automation.pause") : t("automation.resume")}
                </button>
                <button
                  type="button"
                  onClick={() => void runAutomationNow(task.id)}
                  className="rounded-md border border-input-edge bg-surface px-2.5 py-1 text-xs font-semibold text-content hover:bg-surface-hover"
                >
                  {t("automation.runNow")}
                </button>
                <button
                  type="button"
                  onClick={onDelete}
                  title={t("automation.delete")}
                  className="rounded-md border border-danger/30 px-2 py-1 text-xs font-semibold text-danger hover:bg-danger/10"
                >
                  {t("automation.delete")}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={onRestore}
                  className="rounded-md border border-accent/40 bg-accent/10 px-2.5 py-1 text-xs font-semibold text-accent hover:bg-accent/20"
                >
                  {t("automation.restore")}
                </button>
                <button
                  type="button"
                  onClick={onPermDelete}
                  className="rounded-md border border-danger/40 bg-danger/10 px-2.5 py-1 text-xs font-semibold text-danger hover:bg-danger/20"
                >
                  {t("automation.permanentDelete")}
                </button>
              </>
            )}
          </div>
        </div>

        {/* Prompt preview */}
        {task.prompt && (
          <div className="mt-3 rounded-lg border border-edge/60 bg-surface-muted/40 p-2.5 text-xs text-content-muted leading-relaxed line-clamp-3">
            {task.prompt}
          </div>
        )}
      </div>

      {/* Instances Section */}
      <div className="flex min-h-0 flex-1 flex-col rounded-xl border border-edge bg-surface p-3.5 shadow-xs">
        <div className="flex items-center justify-between pb-2 border-b border-edge">
          <span className="text-xs font-bold uppercase tracking-wider text-content">
            {t("automation.instancesTitle")}
          </span>
          <span className="text-xs text-content-subtle">
            {t("automation.runCount", { n: runLog.length })}
          </span>
        </div>

        <div className="mt-2.5 flex-1 space-y-2 overflow-y-auto">
          {/* Live running instance banner if in flight */}
          {activeRunEntry && (
            <div
              onClick={() => onSelectRun(activeRunEntry.firedAt)}
              className="flex cursor-pointer items-center justify-between rounded-lg border border-[#0284c7]/40 bg-[#0284c7]/10 p-2.5 transition-all hover:bg-[#0284c7]/15"
            >
              <div className="flex items-center gap-2">
                <span className="size-2 rounded-full bg-[#0284c7] animate-pulse" />
                <span className="text-xs font-semibold text-[#0369a1] dark:text-[#38bdf8]">
                  {t("automation.instanceRunning")} (#{runLog.length})
                </span>
                <span className="text-[11px] text-content-muted">
                  {fmtClock(activeRunEntry.firedAt)}
                </span>
              </div>
              <button
                type="button"
                className="flex items-center gap-1 rounded bg-accent px-2 py-0.5 text-[11px] font-semibold text-white shadow-xs"
              >
                {t("automation.instanceViewOutput")} →
              </button>
            </div>
          )}

          {/* Historical instance rows */}
          {runsShown.length === 0 && !activeRunEntry ? (
            <div className="py-8 text-center text-xs text-content-subtle">
              {t("automation.noInstances")}
            </div>
          ) : (
            <div className="space-y-1">
              {runsShown.map((entry, i) => {
                const number = runLog.length - i;
                const entryMeta = statusMeta(entry.status ?? null);
                const isEntryRunning = entry.status === "running" || entry.status === "waiting-approval";

                return (
                  <button
                    key={`${entry.firedAt}:${i}`}
                    type="button"
                    onClick={() => onSelectRun(entry.firedAt)}
                    className="flex w-full items-center justify-between rounded-lg border border-transparent p-2 text-left transition-colors hover:border-edge hover:bg-surface-hover"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className="w-8 shrink-0 font-mono text-xs font-semibold text-content-subtle">
                        #{number}
                      </span>
                      <span
                        className={cn(
                          "size-2 shrink-0 rounded-full",
                          isEntryRunning ? "animate-pulse bg-[#0284c7]" : entryMeta.dotClass,
                        )}
                      />
                      <span className="text-xs text-content font-medium">
                        {fmtClock(entry.firedAt)}
                      </span>
                      {entry.durationMs !== undefined && (
                        <span className="text-[11px] text-content-subtle">
                          · {formatDuration(entry.durationMs)}
                        </span>
                      )}
                      {entry.manual && (
                        <span className="rounded bg-surface-muted px-1.5 py-0.5 text-[9.5px] text-content-muted">
                          {t("automation.runs.trigger.manual")}
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <span
                        className={cn(
                          "rounded-full px-2 py-0.5 text-[10px] font-semibold",
                          entryMeta.badgeClass,
                        )}
                      >
                        {entryMeta.label}
                      </span>
                      <span className="text-xs text-content-subtle">→</span>
                    </div>
                  </button>
                );
              })}

              {runsHidden > 0 && (
                <button
                  type="button"
                  onClick={onLoadMore}
                  className="mt-2 w-full rounded-md border border-edge py-1.5 text-center text-xs font-medium text-content-muted hover:bg-surface-hover hover:text-content"
                >
                  {t("layout.loadMore")} ({runsHidden})
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
 * View Mode 2: Instance Output Detail View (参考子会话 SubagentView)
 * ────────────────────────────────────────────────────────────────────────── */

/* ──────────────────────────────────────────────────────────────────────────
 * View Mode 2: Instance Output Detail View (参考子会话 SideChatView)
 * ────────────────────────────────────────────────────────────────────────── */

function InstanceOutputDetailView({
  task,
  firedAt,
  messages,
  onBack,
  onOpenSession,
}: {
  task: Automation;
  firedAt: number;
  messages: ReadonlyArray<ChatMessage>;
  onBack: () => void;
  onOpenSession: () => void;
}) {
  const { t } = useI18n();

  /* Find run ledger entry */
  const runLog = task.runLog ?? EMPTY_RUNS;
  const entryIndex = runLog.findIndex((e) => e.firedAt === firedAt);
  const entry = entryIndex >= 0 ? runLog[entryIndex] : null;
  const instanceNumber = entryIndex >= 0 ? entryIndex + 1 : 1;
  const meta = statusMeta(entry?.status ?? task.lastStatus);
  const isRunning = entry?.status === "running" || entry?.status === "waiting-approval";

  /* Find run anchor user message for scrolling */
  const anchor = useMemo(() => findRunAnchor(messages, firedAt), [messages, firedAt]);
  const targetMessageId = anchor?.id ?? null;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-surface">
      {/* Header: 对齐子会话 SideChatView 规范 (h-9, border-b, bg-surface, px-2) */}
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-edge bg-surface px-2">
        <button
          type="button"
          onClick={onBack}
          title={t("automation.backToInstances")}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-content-muted transition-colors hover:bg-surface-hover hover:text-content"
        >
          <IconArrowLeft size={15} />
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-xs font-medium text-content">
              {task.title} · {t("automation.instanceDetailTitle", { n: instanceNumber })}
            </span>
            <span className={cn("rounded-full px-1.5 py-0.2 text-[9.5px] font-semibold", meta.badgeClass)}>
              {isRunning && (
                <span className="inline-block size-1.5 animate-pulse rounded-full bg-current mr-1" />
              )}
              {meta.label}
            </span>
          </div>

          <div className="flex items-center gap-1.5 text-[10px] text-content-subtle">
            <span>{fmtClock(firedAt)}</span>
            {entry?.durationMs !== undefined && (
              <span>· {formatDuration(entry.durationMs)}</span>
            )}
            {entry?.manual && (
              <span className="rounded bg-surface-muted px-1 py-0.2 text-[9px] text-content-muted">
                {t("automation.runs.trigger.manual")}
              </span>
            )}
          </div>
        </div>

        {task.taskSessionId && (
          <button
            type="button"
            onClick={onOpenSession}
            title={t("automation.openInSession")}
            className="flex h-6 items-center gap-1 rounded px-1.5 text-xs text-content-muted transition-colors hover:bg-surface-hover hover:text-content"
          >
            <IconMessages size={13} />
            <span className="hidden sm:inline">{t("automation.openInSession")}</span>
          </button>
        )}
      </div>

      {/* Main chat view — 完整的真实会话排版(含定时发送的 User 气泡及 Assistant 思考/工具/回复) */}
      <div className="min-h-0 flex-1">
        {task.taskSessionId ? (
          <ChatPane
            sessionId={task.taskSessionId}
            isActive
            chipsMode="collapsed"
            hideComposer
            targetMessageId={targetMessageId}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-content-subtle">
            {t("automation.taskSessionMissing")}
          </div>
        )}
      </div>
    </div>
  );
}
