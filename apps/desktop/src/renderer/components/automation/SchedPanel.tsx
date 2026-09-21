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
import { AutomationEditor } from "./AutomationEditor.js";
import {
  IconClock,
  IconArrowLeft,
  IconFolder,
  IconTrash,
  IconRefresh,
  IconPlayerPlay,
  IconPlayerPause,
  IconPlayerStop,
  IconPencil,
  IconMessages,
  IconPlus,
  IconX,
  IconCopy,
  IconCheck,
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

export function SchedPanel({
  variant = "panel",
  onNewTaskSession,
  openSessionInWorkspace,
}: {
  /** Host shape: "panel" = the right-panel session tab (session-scoped task
   *  list + 新建); "page" = the fullscreen 定时任务 viewer opened from the
   *  sidebar (ALL tasks, same row toolkit, no create). Everything else —
   *  task rows, editors, confirm dialogs, run instances — is identical
   *  between the two; there is exactly one implementation. */
  variant?: "panel" | "page";
  /** Page variant only: the header「新建」then starts a BLANK chat session
   *  and hands over to the workspace (the v2 flow composes and schedules the
   *  task from that session's composer) instead of opening the editor here.
   *  Omitting it keeps the page without a 新建 button. */
  onNewTaskSession?: () => void;
  /** Override for the instance-detail「在会话中打开」action. Default opens the
   *  task session as a workspace tab and stays put (right-panel tab); the
   *  fullscreen page passes a drill-out that also closes itself, otherwise
   *  the opened tab would sit invisibly behind the overlay. */
  openSessionInWorkspace?: (sessionId: string) => void;
} = {}) {
  const { t } = useI18n();
  const page = variant === "page";
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
  const stopAutomationRun = useSessionStore((s) => s.stopAutomationRun);
  const prefetchSessionMessages = useSessionStore((s) => s.prefetchSessionMessages);
  const openTab = useSessionStore((s) => s.openTab);
  /* Project attribution: the list (and the global viewer page especially)
   * mixes tasks from several projects — each row carries a folder+name tag. */
  const projects = useSessionStore((s) => s.projects);
  const projectNameById = useMemo(
    () => new Map(projects.map((p) => [p.id, p.name])),
    [projects],
  );

  /* Tab for left task list: active vs deleted */
  const [listTab, setListTab] = useState<"active" | "deleted">("active");

  /* Scope handling ("page" = the fullscreen global viewer: no session filter) */
  const baseScope = useMemo(() => {
    const st = useSessionStore.getState();
    const active = activeSessionId ? st.getSessionById(activeSessionId) : undefined;
    if (!active) return null;
    if (active.kind === "automation") return active.parentSessionId ?? active.id;
    return active.id;
  }, [activeSessionId]);
  const scope = page ? null : (filterParent ?? baseScope);
  const viewingOther = !page && filterParent != null && filterParent !== baseScope;
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

  /* Editor dialog: closed | editing `task` | creating (task = null). Holds a
   * SNAPSHOT of the row from click time — scheduler refreshes replace the
   * `automations` array (fresh objects), and a live binding would re-init the
   * editor draft mid-edit; the id is all the save channel needs. */
  const [editorState, setEditorState] = useState<{ open: boolean; task: Automation | null }>({
    open: false,
    task: null,
  });

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
        <div className="flex h-[72px] shrink-0 flex-col justify-between border-b border-edge/60 bg-surface px-3 py-2.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-content tracking-tight">
              {t("automation.taskListTitle")}
            </span>
            {!page || onNewTaskSession ? (
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    if (page && onNewTaskSession) onNewTaskSession();
                    else setEditorState({ open: true, task: null });
                  }}
                  className="flex h-5.5 items-center gap-1 rounded-md border border-accent/30 bg-accent/10 px-2 text-[11px] font-medium text-accent transition-all hover:bg-accent/20 shadow-2xs"
                  title={page ? t("automation.newTaskSessionTitle") : t("automation.newTask")}
                >
                  <IconPlus size={11} />
                  <span>{t("automation.newTask")}</span>
                </button>
                <span className="rounded-md border border-edge/40 bg-surface-muted/60 px-1.5 py-0.5 text-[10px] font-medium text-content-subtle">
                  {activeTasks.length} / {scopedAll.length}
                </span>
              </div>
            ) : (
              <span className="rounded-md border border-edge/40 bg-surface-muted/60 px-1.5 py-0.5 text-[10px] font-medium text-content-subtle">
                {activeTasks.length} / {scopedAll.length}
              </span>
            )}
          </div>
          {/* Segmented Control: Active vs Deleted (Apple Inset Slider) */}
          <div className="grid grid-cols-2 gap-0.5 rounded-xl border border-edge/40 bg-surface-muted/60 dark:bg-surface-muted/30 p-0.5 text-[11px]">
            <button
              type="button"
              onClick={() => {
                setListTab("active");
                if (activeTasks[0]) setSchedSelected(activeTasks[0].id);
              }}
              className={cn(
                "rounded-[9px] py-1 text-center font-medium transition-all select-none",
                listTab === "active"
                  ? "bg-surface text-content shadow-xs border border-edge/60 dark:bg-surface-hover dark:border-white/10 dark:text-white"
                  : "text-content-muted hover:text-content hover:bg-surface-muted/40",
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
                "rounded-[9px] py-1 text-center font-medium transition-all select-none",
                listTab === "deleted"
                  ? "bg-surface text-content shadow-xs border border-edge/60 dark:bg-surface-hover dark:border-white/10 dark:text-white"
                  : "text-content-muted hover:text-content hover:bg-surface-muted/40",
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
                  "group relative flex cursor-pointer flex-col gap-1.5 rounded-xl border p-2.5 transition-all text-left",
                  isSelected
                    ? "border-edge/70 bg-surface shadow-apple-card dark:bg-surface-hover/80 dark:border-white/10"
                    : "border-transparent bg-surface-muted/30 hover:border-edge/50 hover:bg-surface-hover/50",
                )}
              >
                {/* 选中态左侧微指示条 */}
                {isSelected && (
                  <div className="absolute left-0 top-2.5 bottom-2.5 w-[3px] rounded-r-full bg-accent" />
                )}

                <div className="flex items-center gap-2 pl-0.5">
                  <div
                    className={cn(
                      "flex h-5 w-5 shrink-0 items-center justify-center rounded-md border text-xs shadow-2xs",
                      isDeleted
                        ? "border-edge/40 bg-surface-muted text-content-subtle"
                        : task.enabled
                          ? "border-accent/30 bg-accent/10 text-accent dark:bg-accent/15"
                          : "border-edge/40 bg-surface-muted text-content-subtle",
                    )}
                  >
                    <IconClock size={11} />
                  </div>
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate text-xs font-semibold text-content",
                      isDeleted && "text-content-muted line-through opacity-80",
                    )}
                    title={task.title}
                  >
                    {task.title}
                  </span>
                  <span
                    className={cn(
                      "shrink-0 rounded-full px-1.5 py-0.5 text-[9.5px] font-semibold",
                      meta.badgeClass,
                    )}
                  >
                    {meta.label}
                  </span>
                </div>

                {(() => {
                  const projectName = projectNameById.get(task.projectId) ?? null;
                  const showCount = !isDeleted && task.runLog.length > 0;
                  return (
                    <div className="space-y-0.5 pl-0.5 text-[11px] text-content-muted">
                      {(projectName || showCount) && (
                        <div className="flex items-center justify-between gap-1">
                          {projectName && (
                            <div className="flex items-center gap-1 min-w-0 text-content-subtle">
                              <IconFolder size={10} className="shrink-0" />
                              <span className="truncate" title={projectName}>
                                {projectName}
                              </span>
                            </div>
                          )}
                          {showCount && (
                            <span className="ml-auto shrink-0 font-mono text-[10px] text-content-subtle">
                              {t("automation.runCount", { n: task.runLog.length })}
                            </span>
                          )}
                        </div>
                      )}
                      <div className="truncate text-[10.5px] text-content-subtle">
                        {isDeleted
                          ? t("automation.deletedAt", { time: fmtClock(task.deletedAt ?? 0) })
                          : describeSchedule(task.schedule)}
                      </div>
                    </div>
                  );
                })()}

                {/* Quick actions bar inside row (pause / run / edit / delete) */}
                <div
                  className="mt-1 flex items-center justify-end gap-1 pt-1.5 border-t border-edge/30"
                  onClick={(e) => e.stopPropagation()}
                >
                  {!isDeleted ? (
                    <>
                      <button
                        type="button"
                        onClick={() => void setAutomationEnabled(task.id, !task.enabled)}
                        title={task.enabled ? t("automation.pause") : t("automation.resume")}
                        className={cn(
                          "flex h-5.5 items-center gap-1 rounded-md px-1.5 text-[10px] font-medium transition-all shadow-2xs border",
                          task.enabled
                            ? "border-warning/30 bg-warning/10 text-warning hover:bg-warning/20"
                            : "border-accent/30 bg-accent/10 text-accent hover:bg-accent/20",
                        )}
                      >
                        {task.enabled ? (
                          <>
                            <IconPlayerPause size={9} />
                            <span>{t("automation.pause")}</span>
                          </>
                        ) : (
                          <>
                            <IconPlayerPlay size={9} />
                            <span>{t("automation.resume")}</span>
                          </>
                        )}
                      </button>
                      {task.lastStatus === "running" || task.lastStatus === "waiting-approval" ? (
                        <button
                          type="button"
                          onClick={() => void stopAutomationRun(task.id)}
                          title={t("automation.stopRun")}
                          className="flex h-5.5 items-center gap-1 rounded-md border border-danger/30 bg-danger/10 px-1.5 text-[10px] font-medium text-danger hover:bg-danger/20 transition-all shadow-2xs"
                        >
                          <IconPlayerStop size={9} />
                          <span>{t("automation.stopRun")}</span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void runAutomationNow(task.id)}
                          title={t("automation.runNow")}
                          className="flex h-5.5 items-center gap-1 rounded-md border border-edge/60 bg-surface dark:bg-surface-muted/40 px-1.5 text-[10px] font-medium text-content-muted hover:bg-surface-hover hover:text-content transition-all shadow-2xs"
                        >
                          <IconPlayerPlay size={9} className="text-accent" />
                          <span>{t("automation.runNow")}</span>
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setEditorState({ open: true, task })}
                        title={t("automation.edit")}
                        className="flex h-5.5 w-5.5 items-center justify-center rounded-md border border-edge/60 bg-surface dark:bg-surface-muted/40 text-content-subtle hover:text-content hover:bg-surface-hover transition-all shadow-2xs"
                      >
                        <IconPencil size={10} />
                      </button>
                      <button
                        type="button"
                        onClick={() => setSoftDeleteTarget(task)}
                        title={t("automation.delete")}
                        className="flex h-5.5 w-5.5 items-center justify-center rounded-md border border-edge/60 bg-surface dark:bg-surface-muted/40 text-content-subtle hover:text-danger hover:border-danger/30 hover:bg-danger/10 transition-all shadow-2xs"
                      >
                        <IconTrash size={10} />
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => void restoreAutomation(task.id)}
                        title={t("automation.restore")}
                        className="flex h-5.5 items-center gap-1 rounded-md border border-accent/30 bg-accent/10 px-1.5 text-[10px] font-medium text-accent hover:bg-accent/20 transition-all shadow-2xs"
                      >
                        <IconRefresh size={9} />
                        <span>{t("automation.restore")}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setPermDeleteTarget(task)}
                        title={t("automation.permanentDelete")}
                        className="flex h-5.5 items-center gap-1 rounded-md border border-danger/30 bg-danger/10 px-1.5 text-[10px] font-medium text-danger hover:bg-danger/20 transition-all shadow-2xs"
                      >
                        <IconTrash size={9} />
                        <span>{t("automation.permanentDelete")}</span>
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
          <div className="flex h-full flex-col">
            <div className="h-[72px] shrink-0 border-b border-edge bg-surface px-4 py-2" />
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-content-subtle">
              <IconClock size={28} className="opacity-40" />
              <p className="text-xs">{t("automation.selectTaskHint")}</p>
            </div>
          </div>
        ) : viewedRunAt != null ? (
          /* View Mode 2: Instance Output Details (参考子会话 SubagentView) */
          <InstanceOutputDetailView
            task={selected}
            firedAt={viewedRunAt}
            messages={messages}
            onBack={() => setViewedRunAt(null)}
            onOpenSession={() => {
              if (!selected.taskSessionId) return;
              if (openSessionInWorkspace) openSessionInWorkspace(selected.taskSessionId);
              else void openTab(selected.taskSessionId);
            }}
          />
        ) : (
          <>
            {/* ── Right-rail Header: Task Detail & Action Toolbar (h-[72px] strictly aligned with left rail) ── */}
            <div className="flex h-[72px] shrink-0 flex-col justify-between border-b border-edge/60 bg-surface px-4 py-2.5">
              {/* Row 1: Title + Status Badge & Action Toolbar */}
              <div className="flex items-center justify-between gap-3 min-h-0">
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <div
                    className={cn(
                      "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border text-sm shadow-2xs",
                      selected.deletedAt
                        ? "border-edge/40 bg-surface-muted text-content-subtle"
                        : selected.enabled
                          ? "border-accent/30 bg-accent/10 text-accent dark:bg-accent/15"
                          : "border-edge/40 bg-surface-muted text-content-subtle",
                    )}
                  >
                    <IconClock size={15} />
                  </div>
                  <h2
                    className={cn(
                      "truncate text-sm font-semibold text-content",
                      selected.deletedAt && "line-through opacity-75",
                    )}
                    title={selected.title}
                  >
                    {selected.title}
                  </h2>
                  <span
                    className={cn(
                      "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold flex items-center gap-1",
                      statusMeta(selected.lastStatus).badgeClass,
                    )}
                  >
                    {isRunning && (
                      <span className="inline-block size-1.5 animate-pulse rounded-full bg-current" />
                    )}
                    {statusMeta(selected.lastStatus).label}
                  </span>
                </div>

                {/* Actions Toolbar (Apple HIG Buttons) */}
                <div className="flex shrink-0 items-center gap-1.5">
                  {!selected.deletedAt ? (
                    <>
                      <button
                        type="button"
                        onClick={() => void setAutomationEnabled(selected.id, !selected.enabled)}
                        title={selected.enabled ? t("automation.pause") : t("automation.resume")}
                        className={cn(
                          "flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium transition-all border shadow-2xs",
                          selected.enabled
                            ? "border-warning/30 bg-warning/10 text-warning hover:bg-warning/20"
                            : "border-accent/30 bg-accent/10 text-accent hover:bg-accent/20",
                        )}
                      >
                        {selected.enabled ? (
                          <>
                            <IconPlayerPause size={11} />
                            <span className="hidden sm:inline">{t("automation.pause")}</span>
                          </>
                        ) : (
                          <>
                            <IconPlayerPlay size={11} />
                            <span className="hidden sm:inline">{t("automation.resume")}</span>
                          </>
                        )}
                      </button>

                      {isRunning ? (
                        <button
                          type="button"
                          onClick={() => void stopAutomationRun(selected.id)}
                          title={t("automation.stopRun")}
                          className="flex h-7 items-center gap-1.5 rounded-lg border border-danger/30 bg-danger/10 px-2.5 text-xs font-medium text-danger hover:bg-danger/20 transition-all shadow-2xs"
                        >
                          <IconPlayerStop size={11} />
                          <span className="hidden sm:inline">{t("automation.stopRun")}</span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void runAutomationNow(selected.id)}
                          title={t("automation.runNow")}
                          className="flex h-7 items-center gap-1.5 rounded-lg border border-edge/70 bg-surface px-2.5 text-xs font-medium text-content hover:bg-surface-hover hover:border-edge transition-all shadow-2xs"
                        >
                          <IconPlayerPlay size={11} className="text-accent" />
                          <span className="hidden sm:inline">{t("automation.runNow")}</span>
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={() => setEditorState({ open: true, task: selected })}
                        title={t("automation.edit")}
                        className="flex h-7 items-center gap-1.5 rounded-lg border border-edge/70 bg-surface px-2.5 text-xs font-medium text-content-muted hover:text-content hover:bg-surface-hover transition-all shadow-2xs"
                      >
                        <IconPencil size={11} />
                        <span className="hidden sm:inline">{t("automation.edit")}</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => setSoftDeleteTarget(selected)}
                        title={t("automation.delete")}
                        className="flex h-7 w-7 items-center justify-center rounded-lg border border-edge/70 bg-surface text-content-subtle hover:text-danger hover:border-danger/30 hover:bg-danger/10 transition-all shadow-2xs"
                      >
                        <IconTrash size={12} />
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => void restoreAutomation(selected.id)}
                        title={t("automation.restore")}
                        className="flex h-7 items-center gap-1.5 rounded-lg border border-accent/30 bg-accent/10 px-2.5 text-xs font-medium text-accent hover:bg-accent/20 transition-all shadow-2xs"
                      >
                        <IconRefresh size={11} />
                        <span>{t("automation.restore")}</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => setPermDeleteTarget(selected)}
                        title={t("automation.permanentDelete")}
                        className="flex h-7 items-center gap-1.5 rounded-lg border border-danger/30 bg-danger/10 px-2.5 text-xs font-medium text-danger hover:bg-danger/20 transition-all shadow-2xs"
                      >
                        <IconTrash size={11} />
                        <span>{t("automation.permanentDelete")}</span>
                      </button>
                    </>
                  )}
                </div>
              </div>

              {/* Row 2: Metadata Strip (Inspector style) */}
              <div className="flex items-center gap-x-2 text-[11px] text-content-muted leading-tight truncate">
                {(() => {
                  const projectName = projectNameById.get(selected.projectId) ?? null;
                  return (
                    <>
                      {projectName && (
                        <span className="inline-flex items-center gap-1 shrink-0 text-content-subtle" title={projectName}>
                          <IconFolder size={11} className="shrink-0" />
                          <span className="max-w-[130px] truncate">{projectName}</span>
                        </span>
                      )}
                      {projectName && <span className="text-edge/60">·</span>}
                      <span className="inline-flex items-center gap-1 font-medium text-content shrink-0">
                        {describeSchedule(selected.schedule)}
                      </span>
                      {taskNextLine(selected) && (
                        <>
                          <span className="text-edge/60">·</span>
                          <span className="text-content-subtle shrink-0">{taskNextLine(selected)}</span>
                        </>
                      )}
                      {selected.model && (
                        <>
                          <span className="text-edge/60">·</span>
                          <span className="rounded-md border border-edge/40 bg-surface-muted/60 px-1.5 py-0.2 text-[10px] font-mono text-content-muted shrink-0">
                            {selected.model}
                          </span>
                        </>
                      )}
                      {runLog.length > 0 && (
                        <>
                          <span className="text-edge/60">·</span>
                          <span className="text-content-subtle shrink-0">
                            {t("automation.runCount", { n: runLog.length })}
                          </span>
                        </>
                      )}
                      {selected.deletedAt && (
                        <>
                          <span className="text-edge/60">·</span>
                          <span className="text-danger/80 shrink-0">
                            {t("automation.deletedAt", { time: fmtClock(selected.deletedAt) })}
                          </span>
                        </>
                      )}
                    </>
                  );
                })()}
              </div>
            </div>

            {/* View Mode 1: Task Overview & Instance History List */}
            <TaskOverviewAndInstanceList
              task={selected}
              runLog={runLog}
              runsShown={runsShown}
              runsHidden={runsHidden}
              activeRunEntry={activeRunEntry}
              onSelectRun={(firedAt) => setViewedRunAt(firedAt)}
              onLoadMore={() => setRunsVisible((v) => v + RUN_HISTORY_PAGE)}
            />
          </>
        )}
      </div>

      {/* Create / edit dialog — shared by both hosts. The row edit button
          opens edit mode; 新建 (panel tab only) opens create mode and the
          fresh row gets selected on save. Clicking a task row itself only
          selects. */}
      <AutomationEditor
        open={editorState.open}
        task={editorState.task}
        scopeSessionId={scope}
        onClose={() => setEditorState((s) => ({ ...s, open: false }))}
        onSaved={(saved) => setSchedSelected(saved.id)}
      />

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

function TaskPromptCard({ prompt }: { prompt: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    void navigator.clipboard.writeText(prompt);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div className="shrink-0 rounded-2xl border border-edge/70 bg-surface p-4 shadow-apple-card">
      <div className="flex items-center justify-between pb-2.5 border-b border-edge/40">
        <span className="text-xs font-semibold text-content tracking-tight">
          {t("automation.card.taskPrompt")}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          title={copied ? t("common.copied") : t("common.copy")}
          className="flex h-6 items-center gap-1.5 rounded-lg border border-edge/60 bg-surface-muted/40 px-2.5 text-xs font-medium text-content-muted hover:bg-surface-hover hover:text-content transition-all shadow-2xs"
        >
          {copied ? (
            <>
              <IconCheck size={12} className="text-accent" />
              <span className="text-accent font-medium">{t("common.copied")}</span>
            </>
          ) : (
            <>
              <IconCopy size={12} />
              <span>{t("common.copy")}</span>
            </>
          )}
        </button>
      </div>
      <div className="mt-2.5 max-h-36 overflow-y-auto rounded-xl bg-surface-muted/40 dark:bg-surface-muted/20 border border-edge/50 p-3 text-xs leading-relaxed text-content select-text whitespace-pre-wrap font-mono">
        {prompt}
      </div>
    </div>
  );
}

function TaskOverviewAndInstanceList({
  task,
  runLog,
  runsShown,
  runsHidden,
  activeRunEntry,
  onSelectRun,
  onLoadMore,
}: {
  task: Automation;
  runLog: AutomationRunEntry[];
  runsShown: AutomationRunEntry[];
  runsHidden: number;
  activeRunEntry: AutomationRunEntry | null;
  onSelectRun: (firedAt: number) => void;
  onLoadMore: () => void;
}) {
  const { t } = useI18n();
  const stopAutomationRun = useSessionStore((s) => s.stopAutomationRun);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col gap-3 p-3 overflow-hidden">
      {/* Task Prompt Card (if prompt present) */}
      {task.prompt && <TaskPromptCard prompt={task.prompt} />}

      {/* Instances Section */}
      <div className="flex min-h-0 flex-1 flex-col rounded-2xl border border-edge/70 bg-surface p-4 shadow-apple-card">
        <div className="flex shrink-0 items-center justify-between pb-3 border-b border-edge/40">
          <span className="text-xs font-semibold text-content tracking-tight">
            {t("automation.instancesTitle")}
          </span>
          <span className="text-xs font-mono text-content-subtle">
            {t("automation.runCount", { n: runLog.length })}
          </span>
        </div>

        <div className="mt-2.5 min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-0.5">
          {/* Live running instance banner if in flight */}
          {activeRunEntry && (
            <div
              onClick={() => onSelectRun(activeRunEntry.firedAt)}
              className="flex cursor-pointer items-center justify-between rounded-xl border border-[#0284c7]/30 bg-[#0284c7]/10 p-3 shadow-2xs transition-all hover:bg-[#0284c7]/15"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="size-2 rounded-full bg-[#0284c7] animate-pulse shrink-0" />
                <span className="text-xs font-semibold text-[#0369a1] dark:text-[#38bdf8] truncate">
                  {t("automation.instanceRunning")} (#{runLog.length})
                </span>
                <span className="text-[11px] text-content-muted shrink-0">
                  {fmtClock(activeRunEntry.firedAt)}
                </span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void stopAutomationRun(task.id);
                  }}
                  title={t("automation.stopRun")}
                  className="flex h-6.5 items-center gap-1 rounded-lg border border-danger/30 bg-danger/10 px-2.5 text-xs font-medium text-danger hover:bg-danger/20 transition-all shadow-2xs"
                >
                  <IconPlayerStop size={11} />
                  <span>{t("automation.stopRun")}</span>
                </button>
                <button
                  type="button"
                  onClick={() => onSelectRun(activeRunEntry.firedAt)}
                  className="flex h-6.5 items-center gap-1 rounded-lg bg-accent px-3 text-xs font-medium text-white shadow-2xs hover:bg-accent/90 transition-colors"
                >
                  {t("automation.instanceViewOutput")} →
                </button>
              </div>
            </div>
          )}

          {/* Historical instance rows */}
          {runsShown.length === 0 && !activeRunEntry ? (
            <div className="py-10 text-center text-xs text-content-subtle">
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
                    className="group flex w-full items-center justify-between rounded-xl border border-transparent px-3 py-2 text-left transition-all hover:border-edge/50 hover:bg-surface-muted/50"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className="w-7 shrink-0 font-mono text-xs font-medium text-content-subtle">
                        #{number}
                      </span>
                      <span
                        className={cn(
                          "size-2 shrink-0 rounded-full",
                          isEntryRunning ? "animate-pulse bg-[#0284c7]" : entryMeta.dotClass,
                        )}
                      />
                      <span className="text-xs font-semibold text-content">
                        {fmtClock(entry.firedAt)}
                      </span>
                      {entry.durationMs !== undefined && (
                        <span className="text-[11px] text-content-subtle">
                          · {formatDuration(entry.durationMs)}
                        </span>
                      )}
                      {entry.manual && (
                        <span className="rounded-md border border-edge/40 bg-surface-muted/60 px-1.5 py-0.5 text-[9.5px] text-content-muted">
                          {t("automation.runs.trigger.manual")}
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <span
                        className={cn(
                          "rounded-full px-2 py-0.5 text-[10px] font-medium",
                          entryMeta.badgeClass,
                        )}
                      >
                        {entryMeta.label}
                      </span>
                      <span className="text-xs text-content-subtle group-hover:text-content group-hover:translate-x-0.5 transition-all">
                        →
                      </span>
                    </div>
                  </button>
                );
              })}

              {runsHidden > 0 && (
                <button
                  type="button"
                  onClick={onLoadMore}
                  className="mt-2 w-full rounded-xl border border-edge/70 bg-surface-muted/30 py-2 text-center text-xs font-medium text-content-muted hover:bg-surface-hover hover:text-content transition-all shadow-2xs"
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
  const stopAutomationRun = useSessionStore((s) => s.stopAutomationRun);

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

        <div className="flex items-center gap-1.5 shrink-0">
          {isRunning && (
            <button
              type="button"
              onClick={() => void stopAutomationRun(task.id)}
              title={t("automation.stopRun")}
              className="flex h-6 items-center gap-1 rounded-md border border-danger/30 bg-danger/10 px-2 text-xs font-medium text-danger hover:bg-danger/20 transition-all shadow-2xs"
            >
              <IconPlayerStop size={11} />
              <span className="hidden sm:inline">{t("automation.stopRun")}</span>
            </button>
          )}

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
