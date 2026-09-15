/**
 * 编排 DAG 面板(右栏「编排」tab)。
 *
 * 展示当前会话(协调者)的 OrchestrationRun:任务图状态色标、节点级控制
 * (暂停/终止/重试/换模型重跑)、实时成本 vs 预算、决策门解决、worker 报告
 * (filesModified/reportPath/verdict)、worktree merge-back。数据全部来自
 * store 的 orchRunsBySession(main 的 run.updated 推送保持新鲜)。
 */
import { useEffect, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import type { Gate, OrchestrationRun, TaskNode } from "@contracts/orchestration";
import { IconGitFork, IconPlayerPause, IconPlayerPlay, IconRefresh, IconX, IconCheck, IconExternalLink } from "@renderer/lib/icons.js";

const STATUS_DOT: Record<TaskNode["status"], string> = {
  pending: "bg-content-subtle/50",
  ready: "bg-info/80",
  dispatched: "bg-accent/70",
  running: "bg-accent animate-pulse",
  completed: "bg-success",
  failed: "bg-danger",
  blocked: "bg-warning",
  paused: "bg-content-subtle",
  canceled: "bg-content-subtle/40",
  superseded: "bg-content-subtle/40",
};

const RUN_BADGE: Record<OrchestrationRun["status"], string> = {
  planning: "text-content-subtle",
  running: "text-accent",
  paused: "text-warning",
  completed: "text-success",
  failed: "text-danger",
  canceled: "text-content-subtle",
};

export function OrchPanel() {
  const { t } = useI18n();
  const sessionId = useSessionStore((s) => s.activeSessionId);
  const runs = useSessionStore((s) => (sessionId ? s.orchRunsBySession[sessionId] : undefined));
  const loadOrchRuns = useSessionStore((s) => s.loadOrchRuns);
  const agents = useSessionStore((s) => s.orchAgents);

  useEffect(() => {
    if (sessionId) void loadOrchRuns(sessionId);
  }, [sessionId, loadOrchRuns, runs === undefined]);

  const agentName = (id: string | null) =>
    id ? (agents.find((a) => a.id === id)?.name ?? id) : t("orch.wizard.agentNone");

  if (!sessionId || !runs || runs.length === 0) {
    return (
      <EmptyState title={t("orch.panel.empty")} desc={t("orch.panel.emptyDesc")} />
    );
  }

  return (
    <div className="h-full overflow-y-auto px-3 py-3" style={{ fontSize: "var(--right-panel-font-size)" }}>
      <div className="space-y-4">
        {runs.map((run) => (
          <RunCard key={run.id} run={run} agentName={agentName} />
        ))}
      </div>
    </div>
  );
}

function RunCard({ run, agentName }: { run: OrchestrationRun; agentName: (id: string | null) => string }) {
  const { t } = useI18n();
  const runControl = useSessionStore((s) => s.orchRunControl);
  const [expanded, setExpanded] = useState<string | null>(null);
  const openGates = run.gates.filter((g) => g.status === "open");

  return (
    <div className="rounded-lg border border-edge bg-surface">
      {/* 头部:标题 + 状态 + 成本 + run 级控制 */}
      <div className="flex items-center gap-2 px-3 py-2">
        <span className={cn("min-w-0 flex-1 truncate font-medium", RUN_BADGE[run.status])}>
          {run.title}
        </span>
        <span className="shrink-0 text-[0.7143em] text-content-subtle">{t(`orch.runstatus.${run.status}`)}</span>
      </div>
      <div className="flex items-center gap-2 px-3 pb-2 text-[0.7143em] text-content-subtle">
        <span>
          {t("orch.panel.cost")} ${run.spentUsd.toFixed(3)}
          {run.budgetUsd != null ? ` / ${run.budgetUsd}` : ` · ${t("orch.panel.noBudget")}`}
        </span>
        <span className="ml-auto flex gap-1">
          {run.status === "running" && (
            <IconBtn title={t("orch.panel.pause")} onClick={() => void runControl(run.id, "pause")}>
              <IconPlayerPause size={13} />
            </IconBtn>
          )}
          {run.status === "paused" && (
            <IconBtn title={t("orch.panel.resume")} onClick={() => void runControl(run.id, "resume")}>
              <IconPlayerPlay size={13} />
            </IconBtn>
          )}
          {(run.status === "running" || run.status === "paused") && (
            <IconBtn title={t("orch.panel.cancelRun")} onClick={() => void runControl(run.id, "cancel")}>
              <IconX size={13} />
            </IconBtn>
          )}
          <IconBtn title={t("orch.panel.deleteRun")} onClick={() => void runControl(run.id, "delete")}>
            <IconRefresh size={13} />
          </IconBtn>
        </span>
      </div>

      {/* 决策门 */}
      {openGates.length > 0 && (
        <div className="border-t border-edge px-3 py-2">
          <div className="mb-1 text-[0.7143em] font-medium uppercase tracking-wide text-content-subtle">
            {t("orch.panel.gates")}
          </div>
          <div className="space-y-2">
            {openGates.map((gate) => (
              <GateRow key={gate.id} runId={run.id} gate={gate} tasks={run.tasks} />
            ))}
          </div>
        </div>
      )}

      {/* 任务列表 */}
      <div className="border-t border-edge px-3 py-2">
        <div className="space-y-1">
          {run.tasks.map((task) => (
            <TaskRow
              key={task.id}
              runId={run.id}
              task={task}
              agentName={agentName}
              expanded={expanded === task.id}
              onToggle={() => setExpanded((x) => (x === task.id ? null : task.id))}
              hasOpenGate={openGates.some((g) => g.taskId === task.id)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function GateRow({ runId, gate, tasks }: { runId: string; gate: Gate; tasks: TaskNode[] }) {
  const { t } = useI18n();
  const resolveGate = useSessionStore((s) => s.orchResolveGate);
  // 择优 gate 的选项是任务 id —— 展示成任务摘录更可读。
  const label = (opt: string) => {
    const task = tasks.find((x) => x.id === opt);
    return task ? `${opt} · ${task.spec.slice(0, 40)}…` : opt;
  };
  return (
    <div className="rounded-md border border-warning/40 bg-warning/10 px-2 py-1.5">
      <div className="flex items-center gap-1.5 text-[0.7143em] font-medium text-warning">
        {t(`orch.gate.${gate.kind}`)}
      </div>
      <div className="mt-0.5 whitespace-pre-wrap text-[0.7143em] text-content-muted">{gate.question}</div>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {gate.options.map((opt) => (
          <button
            key={opt}
            onClick={() => void resolveGate(runId, gate.id, opt)}
            className="rounded-full border border-edge px-2 py-0.5 text-[0.686em] hover:border-accent hover:text-accent"
          >
            {label(opt)}
          </button>
        ))}
      </div>
    </div>
  );
}

function TaskRow({
  runId,
  task,
  agentName,
  expanded,
  onToggle,
  hasOpenGate,
}: {
  runId: string;
  task: TaskNode;
  agentName: (id: string | null) => string;
  expanded: boolean;
  onToggle: () => void;
  hasOpenGate: boolean;
}) {
  const { t } = useI18n();
  const taskControl = useSessionStore((s) => s.orchTaskControl);
  const orchMergeTask = useSessionStore((s) => s.orchMergeTask);
  const openOrchWorker = useSessionStore((s) => s.openOrchWorker);
  const [merging, setMerging] = useState(false);
  const lastDispatch = task.dispatches[task.dispatches.length - 1];

  const merge = async () => {
    setMerging(true);
    const err = await orchMergeTask(runId, task.id);
    setMerging(false);
    if (err) window.alert(t("orch.panel.mergeFailed") + ": " + err);
  };

  return (
    <div className="rounded-md px-1.5 py-1 hover:bg-surface-hover">
      <button onClick={onToggle} className="flex w-full items-start gap-1.5 text-left">
        <span className={cn("mt-[0.45em] h-1.5 w-1.5 shrink-0 rounded-full", STATUS_DOT[task.status])} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="text-[0.7143em] font-medium">{task.id}</span>
            {task.reviewOf && (
              <span className="rounded bg-info/15 px-1 text-[0.686em] text-info">review→{task.reviewOf}</span>
            )}
            {task.variantGroup && (
              <span className="rounded bg-violet-500/15 px-1 text-[0.686em] text-violet-500">{task.variantGroup}</span>
            )}
            {task.reviewRound > 0 && (
              <span className="text-[0.686em] text-warning">{t("orch.panel.reviewRound", { n: task.reviewRound })}</span>
            )}
            {task.failureCount > 0 && (
              <span className="text-[0.686em] text-danger">{t("orch.panel.failures", { n: task.failureCount })}</span>
            )}
            {hasOpenGate && <span className="text-[0.686em] text-warning">⏸ gate</span>}
          </span>
          <span className="mt-0.5 block truncate text-[0.7143em] text-content-muted">{task.spec}</span>
        </span>
        <span className="shrink-0 text-[0.686em] text-content-subtle">{agentName(task.profileId)}</span>
        <span className={cn("shrink-0 text-[0.686em]", STATUS_DOT[task.status].replace("bg-", "text-"))}>
          {t(`orch.status.${task.status}`)}
        </span>
      </button>

      {expanded && (
        <div className="mt-1 space-y-1.5 pl-3 text-[0.7143em]">
          {/* 节点控制 */}
          <div className="flex flex-wrap gap-1">
            {(task.status === "failed" || task.status === "blocked" || task.status === "canceled") && (
              <MiniBtn onClick={() => void taskControl(runId, task.id, "retry")}>
                <IconRefresh size={11} /> {t("orch.panel.retry")}
              </MiniBtn>
            )}
            {(task.status === "dispatched" || task.status === "running") && (
              <>
                <MiniBtn onClick={() => void taskControl(runId, task.id, "pause")}>
                  <IconPlayerPause size={11} /> {t("orch.panel.taskPause")}
                </MiniBtn>
                <MiniBtn onClick={() => void taskControl(runId, task.id, "cancel")}>
                  <IconX size={11} /> {t("orch.panel.taskCancel")}
                </MiniBtn>
              </>
            )}
            {task.status === "paused" && (
              <MiniBtn onClick={() => void taskControl(runId, task.id, "resume")}>
                <IconPlayerPlay size={11} /> {t("orch.panel.taskResume")}
              </MiniBtn>
            )}
            {(task.status === "completed" || task.status === "failed" || task.status === "canceled") && (
              <MiniBtn onClick={() => void taskControl(runId, task.id, "rerun")}>
                <IconRefresh size={11} /> {t("orch.panel.rerun")}
              </MiniBtn>
            )}
            {task.status !== "completed" && task.status !== "canceled" && (
              <MiniBtn onClick={() => void taskControl(runId, task.id, "markCompleted")}>
                <IconCheck size={11} /> {t("orch.panel.markDone")}
              </MiniBtn>
            )}
          </div>

          {/* worker 报告 */}
          {task.result?.summary && (
            <div className="rounded border border-edge bg-surface-muted/50 px-2 py-1.5">
              <div className="mb-0.5 font-medium text-content-subtle">{t("orch.panel.workerReport")}</div>
              <div className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-content-muted">
                {task.result.summary}
              </div>
              {task.result.verdict && (
                <div
                  className={cn(
                    "mt-1 font-medium",
                    task.result.verdict === "pass" ? "text-success" : "text-warning",
                  )}
                >
                  {t(`orch.panel.verdict.${task.result.verdict}`)}
                </div>
              )}
            </div>
          )}

          {/* 文件改动 */}
          {(task.result?.filesModified?.length ?? 0) > 0 && (
            <div>
              <div className="text-content-subtle">{t("orch.panel.files")}({task.result?.filesModified.length})</div>
              <div className="max-h-28 overflow-y-auto font-mono text-[0.686em] text-content-muted">
                {task.result?.filesModified.map((f) => (
                  <div key={f} className="truncate">{f}</div>
                ))}
              </div>
            </div>
          )}

          {/* worktree + worker 入口 */}
          <div className="flex flex-wrap gap-1">
            {lastDispatch?.workerSessionId && task.runner === "agent" && (
              <MiniBtn onClick={() => void openOrchWorker(lastDispatch.workerSessionId!)}>
                <IconExternalLink size={11} /> {t("orch.panel.openWorker")}
              </MiniBtn>
            )}
            {task.worktreePath && task.status === "completed" && (
              <MiniBtn disabled={merging} onClick={() => void merge()}>
                <IconGitFork size={11} /> {merging ? t("orch.panel.merging") : t("orch.panel.merge")}
              </MiniBtn>
            )}
          </div>
          {task.worktreePath && (
            <div className="truncate font-mono text-[0.686em] text-content-subtle">{task.worktreePath}</div>
          )}
        </div>
      )}
    </div>
  );
}

function IconBtn({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      title={title}
      onClick={onClick}
      className="rounded p-1 text-content-subtle hover:bg-surface-hover hover:text-content"
    >
      {children}
    </button>
  );
}

function MiniBtn({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex items-center gap-1 rounded border border-edge px-1.5 py-0.5 text-[0.686em] text-content-muted hover:border-accent hover:text-accent disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function EmptyState({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center" style={{ fontSize: "var(--right-panel-font-size)" }}>
      <div className="text-xs font-medium text-content-muted">{title}</div>
      <div className="text-[0.7143em] text-content-subtle">{desc}</div>
    </div>
  );
}
