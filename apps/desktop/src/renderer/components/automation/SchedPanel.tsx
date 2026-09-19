/**
 * SchedPanel — the right panel's「定时任务」tab (v2「任务即会话」).
 *
 * Scope: ONLY the current session's tasks (schedFilterParent — set by the
 * left-bar initiator badge — overrides; a banner marks that case). The
 * layout reads as containment: the TASK card on top, its「运行历史」ledger
 * and「运行输出」transcript nested beneath a left rail — task ⊃ runs ⊃
 * output.
 *
 *  - task card: selected task's name / status / schedule + its actions
 *    (pause · run now · edit · delete live WITH the task, not in a detached
 *    footer).
 *  - run history: collapsible ledger (Automation.runLog — one entry per
 *    fire), 10 rows per page; clicking a row marks that run as「viewed」and
 *    jumps the transcript below to its anchor message (bookmark-jump
 *    channel: scroll + flash). Auto-expands on a failed task.
 *  - run output: the task session via the real ChatPane, view-only
 *    (hideComposer — runs are scheduler-driven; approval/question/plan
 *    prompts stay). Header shows which run is on display (live by default).
 *
 * The transcript IS the run history; the ledger above is its index.
 */
import { useEffect, useMemo, useState } from "react";
import type { Automation, AutomationRunEntry } from "@contracts/automation";
import type { ChatMessage } from "@renderer/stores/sessionStore.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { ChatPane } from "@renderer/components/chat/ChatPane.js";
import { formatDuration } from "@renderer/components/chat/activityShared.js";
import { ConfirmDialog } from "@renderer/components/ui/index.js";
import { IconClock, IconChevronDown, IconEdit, IconPlus, IconX } from "@renderer/lib/icons.js";
import { cn } from "@renderer/lib/cn.js";
import {
  describeSchedule,
  findRunAnchor,
  fmtClock,
  sortAutomations,
  statusMeta,
  taskNextLine,
} from "./automationFormat.js";
import { AutomationEditor } from "./AutomationEditor.js";

const EMPTY_RUNS: AutomationRunEntry[] = [];
const EMPTY_MESSAGES: ChatMessage[] = [];
/** Run-history rows shown per page (default load; 「加载更多」 appends +10). */
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
  const runAutomationNow = useSessionStore((s) => s.runAutomationNow);
  const prefetchSessionMessages = useSessionStore((s) => s.prefetchSessionMessages);
  const loadOlderMessages = useSessionStore((s) => s.loadOlderMessages);
  const setPendingBookmarkJump = useSessionStore((s) => s.setPendingBookmarkJump);

  /* Scope = the CURRENT session (its id, or the initiator's id when the
   * active thread is itself a task transcript). schedFilterParent — set by
   * the left-bar initiator badge — overrides so a badge click lands on that
   * session's tasks; the banner marks the "other session" case. */
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

  const tasks = useMemo(
    () =>
      sortAutomations(
        scope ? automations.filter((a) => a.parentSessionId === scope) : [],
      ),
    [automations, scope],
  );

  /* Selected derives from the scoped list — a stale selection outside it
   * must never keep playing in the output pane (list/detail mismatch). */
  const selected: Automation | null =
    tasks.find((a) => a.id === selectedId) ?? tasks[0] ?? null;
  const taskSessionId = selected?.taskSessionId ?? null;
  const canCreate = scope != null;

  /* Hydrate the freshly selected task session's transcript — the ChatPane
   * below renders straight from the store and never prefetches itself. */
  useEffect(() => {
    if (taskSessionId) void prefetchSessionMessages(taskSessionId);
  }, [taskSessionId, prefetchSessionMessages]);

  /* ── Run history: collapse state + paged ledger rows ── */
  const [runsOpen, setRunsOpen] = useState(false);
  const [runsVisible, setRunsVisible] = useState(RUN_HISTORY_PAGE);
  // Which run the output pane displays: null = follow the latest/live tail.
  const [viewedRunAt, setViewedRunAt] = useState<number | null>(null);
  // Reset per selected task; auto-expand when that task last failed so the
  // failure is the first thing the user sees.
  useEffect(() => {
    setRunsOpen(selected?.lastStatus === "failed");
    setRunsVisible(RUN_HISTORY_PAGE);
    setViewedRunAt(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);
  const runLog = selected?.runLog ?? EMPTY_RUNS;
  const runsNewestFirst = useMemo(() => [...runLog].reverse(), [runLog]);
  const runsShown = runsNewestFirst.slice(0, runsVisible);
  const runsHidden = runsNewestFirst.length - runsShown.length;
  const latestFiredAt = runLog.length > 0 ? (runLog[runLog.length - 1]?.firedAt ?? null) : null;
  const viewedIndex =
    viewedRunAt != null ? runLog.findIndex((e) => e.firedAt === viewedRunAt) : -1;

  /* ── Jump-to-run: resolve the ledger entry's anchor message, then ride
   * the bookmark-jump channel (ChatPane scrolls + flashes). Message ids
   * live renderer-side only, so the entry's firedAt is matched by
   * proximity against loaded messages; pages are pulled as needed. ── */
  const [pendingRun, setPendingRun] = useState<{ firedAt: number; tries: number } | null>(null);
  const messages =
    useSessionStore((s) => (taskSessionId ? s.messagesBySession[taskSessionId] : undefined)) ??
    EMPTY_MESSAGES;
  const historyLoaded = useSessionStore((s) =>
    taskSessionId ? !!s.historyLoadedBySession[taskSessionId] : false,
  );
  const hasMore = useSessionStore((s) =>
    taskSessionId ? !!s.hasMoreMessagesBySession[taskSessionId] : false,
  );
  const loadingOlder = useSessionStore((s) =>
    taskSessionId ? !!s.loadingOlderBySession[taskSessionId] : false,
  );

  useEffect(() => {
    if (!pendingRun || !taskSessionId) return;
    // Prefetch still in flight — wait for hydration before deciding.
    if (!historyLoaded && messages.length === 0) return;
    const anchor = findRunAnchor(messages, pendingRun.firedAt);
    if (anchor) {
      // Set the jump only once the target message is in the store, so
      // ChatPane's jump effect finds it on its first pass (it gives up
      // once history is loaded and the message is missing).
      setPendingBookmarkJump({ sessionId: taskSessionId, messageId: anchor.id });
      setPendingRun(null);
      return;
    }
    if (!historyLoaded) return; // more rows may still land
    if (hasMore && pendingRun.tries < 2) {
      // A page pull in flight will re-run this effect with the merged
      // messages — wait for it instead of giving up (or double-firing).
      if (loadingOlder) return;
      setPendingRun({ ...pendingRun, tries: pendingRun.tries + 1 });
      void loadOlderMessages(taskSessionId);
      return;
    }
    setPendingRun(null); // anchor beyond retention — nothing to scroll to
  }, [
    pendingRun,
    taskSessionId,
    messages,
    historyLoaded,
    hasMore,
    loadingOlder,
    loadOlderMessages,
    setPendingBookmarkJump,
  ]);

  /* ── Create / edit dialog ── */
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorTask, setEditorTask] = useState<Automation | null>(null);
  const hasProjects = useSessionStore((s) => s.projects.length > 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* scope banner — only when a badge click aimed the panel at another
          session; × returns to the current session's tasks */}
      {viewingOther && (
        <div className="flex items-center gap-2 border-b border-edge bg-surface-muted px-2.5 py-1.5 text-[11px] text-content-muted">
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

      {/* task list — the current session's tasks */}
      <div className="shrink-0 border-b border-edge px-1.5 pb-1.5 pt-1">
        <div className="flex items-center gap-1.5 px-1 pb-1">
          <span className="text-[11px] font-bold uppercase tracking-wide text-content-subtle">
            {t("automation.taskListTitle")}
            {tasks.length > 0 ? ` (${tasks.length})` : ""}
          </span>
          <button
            type="button"
            disabled={!canCreate || !hasProjects}
            title={
              !hasProjects
                ? t("automation.needProject")
                : !canCreate
                  ? t("automation.needSession")
                  : undefined
            }
            onClick={() => {
              setEditorTask(null);
              setEditorOpen(true);
            }}
            className="ml-auto flex items-center gap-0.5 rounded-md border border-input-edge px-1.5 py-0.5 text-[10.5px] font-semibold text-content-muted hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            <IconPlus size={11} />
            {t("automation.newTask")}
          </button>
        </div>
        <div className="max-h-36 overflow-y-auto">
          {tasks.length === 0 && (
            <div className="px-2 py-3 text-center text-[11.5px] text-content-subtle">
              {scope ? t("automation.emptyScopeTasks") : t("automation.emptyTasks")}
            </div>
          )}
          {tasks.map((task) => {
            const meta = statusMeta(task.lastStatus);
            const on = selected?.id === task.id;
            return (
              <button
                key={task.id}
                type="button"
                onClick={() => setSchedSelected(task.id)}
                className={cn(
                  "flex w-full flex-col gap-0.5 rounded-lg px-2 py-1.5 text-left transition-colors",
                  on ? "bg-accent/10" : "hover:bg-surface-hover",
                )}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <IconClock
                    size={12}
                    className={cn("shrink-0", task.enabled ? "text-accent" : "text-content-subtle")}
                  />
                  <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold">
                    {task.title}
                  </span>
                  <span className={cn("rounded-full px-1.5 text-[10px] font-semibold", meta.badgeClass)}>
                    {meta.label}
                  </span>
                </span>
                <span className="flex min-w-0 items-center gap-1.5 pl-[18px] text-[10.5px] text-content-subtle">
                  <span className="min-w-0 flex-1 truncate">
                    {describeSchedule(task.schedule)}
                    {taskNextLine(task) ? ` · ${taskNextLine(task)}` : ""}
                  </span>
                  {task.runLog.length > 0 && (
                    <span className="shrink-0">{t("automation.runCount", { n: task.runLog.length })}</span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {selected ? (
        <>
          {/* task card — the「任务」the sections below belong to; its actions
              live here, not in a detached footer */}
          <div className="shrink-0 border-b border-edge bg-surface-muted/40 px-2.5 py-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <IconClock
                size={13}
                className={cn("shrink-0", selected.enabled ? "text-accent" : "text-content-subtle")}
              />
              <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold">
                {selected.title}
              </span>
              <span
                className={cn(
                  "rounded-full px-1.5 text-[10px] font-semibold",
                  statusMeta(selected.lastStatus).badgeClass,
                )}
              >
                {statusMeta(selected.lastStatus).label}
              </span>
            </div>
            <div className="mt-0.5 truncate pl-[19px] text-[10.5px] text-content-subtle">
              {describeSchedule(selected.schedule)}
              {taskNextLine(selected) ? ` · ${taskNextLine(selected)}` : ""}
              {selected.runLog.length > 0
                ? ` · ${t("automation.runCount", { n: selected.runLog.length })}`
                : ""}
            </div>
            <div className="mt-1.5 flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => void setAutomationEnabled(selected.id, !selected.enabled)}
                className={cn(
                  "rounded-md border px-2 py-1 text-[11px] font-semibold",
                  selected.enabled
                    ? "border-warning/50 text-warning hover:bg-warning/10"
                    : "border-accent/50 text-accent hover:bg-accent/10",
                )}
              >
                {selected.enabled ? t("automation.pause") : t("automation.resume")}
              </button>
              <button
                type="button"
                onClick={() => void runAutomationNow(selected.id)}
                className="rounded-md border border-input-edge px-2 py-1 text-[11px] font-semibold text-content-muted hover:bg-surface-hover hover:text-content"
              >
                {t("automation.runNow")}
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditorTask(selected);
                  setEditorOpen(true);
                }}
                className="rounded-md border border-input-edge px-2 py-1 text-[11px] font-semibold text-content-muted hover:bg-surface-hover hover:text-content"
              >
                <span className="flex items-center gap-1">
                  <IconEdit size={11} />
                  {t("automation.edit")}
                </span>
              </button>
              <DeleteTaskButton
                taskTitle={selected.title}
                onDelete={() => void deleteAutomation(selected.id)}
              />
            </div>
          </div>

          {/* everything below belongs to the task — the left rail draws the
              containment (task ⊃ run history ⊃ run output) */}
          <div className="ml-3 flex min-h-0 flex-1 flex-col border-l border-edge pl-2.5">
            {/* run history */}
            <div className="shrink-0 border-b border-edge">
              <button
                type="button"
                onClick={() => setRunsOpen((o) => !o)}
                className="flex w-full items-center gap-1.5 px-1 py-1.5 text-[11px] hover:bg-surface-hover"
              >
                <span className="font-bold uppercase tracking-wide text-content-subtle">
                  {t("automation.runHistory")}
                </span>
                {runLog.length > 0 && (
                  <span className="text-content-subtle">
                    · {t("automation.runCount", { n: runLog.length })}
                  </span>
                )}
                {latestFiredAt !== null && (
                  <span
                    className={cn(
                      "size-1.5 rounded-full",
                      statusMeta(runLog[runLog.length - 1]?.status ?? selected.lastStatus).dotClass,
                    )}
                  />
                )}
                <IconChevronDown
                  size={12}
                  className={cn(
                    "ml-auto text-content-subtle transition-transform",
                    runsOpen && "rotate-180",
                  )}
                />
              </button>
              {runsOpen && (
                <div className="max-h-44 overflow-y-auto px-0.5 pb-1.5">
                  {runsShown.length === 0 && (
                    <div className="px-2 py-2 text-center text-[10.5px] text-content-subtle">
                      {t("automation.runs.empty")}
                    </div>
                  )}
                  {runsShown.map((entry, i) => {
                    const number = runLog.length - i; // newest = highest retained index
                    const meta = statusMeta(entry.status ?? null);
                    const viewed = entry.firedAt === (viewedRunAt ?? latestFiredAt);
                    return (
                      <button
                        key={`${entry.firedAt}:${i}`}
                        type="button"
                        onClick={() => {
                          setViewedRunAt(entry.firedAt);
                          setPendingRun({ firedAt: entry.firedAt, tries: 0 });
                        }}
                        title={t("automation.runs.view")}
                        className={cn(
                          "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[10.5px] transition-colors",
                          viewed ? "bg-accent/10" : "hover:bg-surface-hover",
                        )}
                      >
                        <span className="w-7 shrink-0 text-content-subtle">#{number}</span>
                        <span className="shrink-0 text-content-muted">{fmtClock(entry.firedAt)}</span>
                        <span className={cn("size-1.5 shrink-0 rounded-full", meta.dotClass)} />
                        {entry.durationMs !== undefined && (
                          <span className="shrink-0 text-content-subtle">
                            {formatDuration(entry.durationMs)}
                          </span>
                        )}
                        {entry.firedAt === latestFiredAt && (
                          <span className="shrink-0 rounded-full bg-accent/10 px-1.5 text-[9.5px] font-semibold text-accent">
                            {t("automation.runsLatest")}
                          </span>
                        )}
                        {entry.manual && (
                          <span className="shrink-0 rounded-full bg-surface-hover px-1.5 text-[9.5px] text-content-subtle">
                            {t("automation.runs.trigger.manual")}
                          </span>
                        )}
                      </button>
                    );
                  })}
                  {runsHidden > 0 && (
                    <button
                      type="button"
                      onClick={() => setRunsVisible((v) => v + RUN_HISTORY_PAGE)}
                      className="mt-0.5 w-full rounded-md px-2 py-1 text-center text-[10.5px] text-content-muted hover:bg-surface-hover hover:text-content"
                    >
                      {t("layout.loadMore")}
                      <span className="text-content-subtle">
                        {" "}
                        {t("layout.loadMoreRemaining", { n: runsHidden })}
                      </span>
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* run output — the viewed run (live tail by default) */}
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="live-head-h flex items-center gap-1.5 px-1 pb-1 pt-2">
                <span className="flex-1 text-[11px] font-bold uppercase tracking-wide text-content-subtle">
                  {t("automation.liveOutput")}
                  {viewedIndex >= 0 && runLog[viewedIndex] ? (
                    <span className="ml-1.5 font-semibold normal-case tracking-normal text-content-muted">
                      #{viewedIndex + 1} · {fmtClock(viewedRunAt ?? 0)}
                    </span>
                  ) : (
                    <span className="ml-1.5 font-semibold normal-case tracking-normal text-accent">
                      {t("automation.outputLive")}
                    </span>
                  )}
                </span>
                {viewedRunAt != null && (
                  <button
                    type="button"
                    onClick={() => {
                      setViewedRunAt(null);
                      if (latestFiredAt != null) {
                        setPendingRun({ firedAt: latestFiredAt, tries: 0 });
                      }
                    }}
                    className="rounded px-1.5 py-0.5 text-[10px] text-content-muted hover:bg-surface-hover hover:text-content"
                  >
                    {t("automation.backToLatest")}
                  </button>
                )}
              </div>
              <div className="min-h-0 flex-1">
                {taskSessionId ? (
                  <ChatPane sessionId={taskSessionId} isActive chipsMode="collapsed" hideComposer />
                ) : (
                  <div className="flex h-full items-center justify-center px-4 text-center text-[11.5px] text-content-subtle">
                    {t("automation.taskSessionMissing")}
                  </div>
                )}
              </div>
            </div>
          </div>
        </>
      ) : null}

      <AutomationEditor
        open={editorOpen}
        task={editorTask}
        scopeSessionId={scope}
        onClose={() => setEditorOpen(false)}
        onSaved={(saved) => {
          // A fresh create should become the visible task immediately.
          if (!editorTask) setSchedSelected(saved.id);
        }}
      />
    </div>
  );
}

/* Local delete-confirm state: bridge keeps ConfirmDialog's open flag so the
 * row buttons stay one-liners. */
function DeleteTaskButton({ taskTitle, onDelete }: { taskTitle: string; onDelete: () => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="ml-auto rounded-md border border-danger/40 px-2 py-1 text-[11px] font-semibold text-danger hover:bg-danger/10"
      >
        {t("automation.delete")}
      </button>
      <ConfirmDialog
        open={open}
        title={t("automation.deleteConfirmTitle")}
        description={t("automation.deleteConfirmBody", { title: taskTitle })}
        confirmText={t("automation.delete")}
        danger
        onOpenChange={setOpen}
        onConfirm={onDelete}
      />
    </>
  );
}
