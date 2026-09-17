/**
 * 编排面板(右栏「编排」tab)—— 双视图。
 *
 * 总览:当前会话(协调者)的 OrchestrationRun 卡片列表(状态/成本/决策门/
 *   任务清单),数据来自 store 的 orchRunsBySession(run.updated 推送保鲜)。
 * 节点详情:画布点节点(store.orchNodeSelection)后进入 —— 「配置」页编辑
 *   spec/agent/模型/依赖(pending 才可改),「运行输出」页看统计/产物/
 *   worker 输出控制台(worker 会话消息桶:prefetch 水合 + 实时事件天然续流)。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { api } from "@renderer/lib/api.js";
import { MessageBlocks } from "@renderer/components/chat/MessageBlocks.js";
import type { ChatMessage } from "@renderer/stores/sessionStore.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { planEdgeDelete, taskEditable } from "@renderer/lib/orchGraph.js";
import type { Gate, OrchestrationRun, TaskNode } from "@contracts/orchestration";
import type { CustomModelPublic } from "@contracts/customModel";
import {
  IconArrowLeft,
  IconCheck,
  IconExternalLink,
  IconGitFork,
  IconPlayerPause,
  IconPlayerPlay,
  IconRefresh,
  IconTrash,
  IconX,
} from "@renderer/lib/icons.js";

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

/** 执行者标签:节点级 厂商/模型 覆盖(历史 run 可能仍带 profileId,仅显示原值)。 */
function execLabelOf(task: TaskNode, customModels: CustomModelPublic[]): string {
  if (task.providerId) {
    if (task.customModelId) {
      const cfg = customModels.find((c) => c.id === task.customModelId);
      if (cfg) return task.model && task.model !== "default" ? `${cfg.name} · ${task.model}` : cfg.name;
    }
    if (task.model && task.model !== "default") return `${task.providerId} · ${task.model}`;
    return task.providerId;
  }
  if (task.profileId) return task.profileId;
  return "";
}

/** 节点展示标题 = spec 首行(与画布节点卡、结果整理同一口径)。 */
function taskTitle(task: TaskNode): string {
  return task.spec.split("\n")[0].trim() || task.id;
}

export function OrchPanel() {
  const { t } = useI18n();
  const sessionId = useSessionStore((s) => s.activeSessionId);
  const runs = useSessionStore((s) => (sessionId ? s.orchRunsBySession[sessionId] : undefined));
  const loadOrchRuns = useSessionStore((s) => s.loadOrchRuns);
  const selection = useSessionStore((s) => s.orchNodeSelection);
  // 选中可能来自后台 keep-alive 画布/整理卡 —— 跨会话桶按 id 找 run,
  // 不止看当前会话(找不到 = run 已被清理或 selection 过期 → 回落列表)。
  const runsMap = useSessionStore((s) => s.orchRunsBySession);
  const selectedRun = useMemo(() => {
    if (!selection) return undefined;
    for (const list of Object.values(runsMap)) {
      const hit = list.find((r) => r.id === selection.runId);
      if (hit) return hit;
    }
    return undefined;
  }, [runsMap, selection]);
  const selectedTask =
    selectedRun && selection?.taskId
      ? selectedRun.tasks.find((x) => x.id === selection.taskId)
      : undefined;

  useEffect(() => {
    if (sessionId) void loadOrchRuns(sessionId);
  }, [sessionId, loadOrchRuns, runs === undefined]);

  // 三级视图:节点详情(taskId 非空)→ 连线详情(edge 存在)→ 运行总览
  // (点画布空白/整理卡进入)→ 会话级 runs 列表。切会话时 selection 指向
  // 别的会话的 run 也能命中(跨桶查找),不再静默回落。
  if (selectedRun && selectedTask && selection?.taskId) {
    return (
      <NodeDetail
        key={`${selectedRun.id}:${selectedTask.id}`}
        run={selectedRun}
        task={selectedTask}
      />
    );
  }

  // 连线详情:edge 指向的两端任一已不存在(被删/被重跑清空)→ 回落总览。
  if (selectedRun && selection && !selection.taskId && selection.edge) {
    const up = selectedRun.tasks.find((x) => x.id === selection.edge!.upstream);
    const down = selectedRun.tasks.find((x) => x.id === selection.edge!.downstream);
    if (up && down) {
      return (
        <EdgeDetail
          key={`${selectedRun.id}:${up.id}->${down.id}`}
          run={selectedRun}
          upstream={up}
          downstream={down}
        />
      );
    }
  }

  if (selectedRun && selection && !selection.taskId) {
    return <RunOverview key={selectedRun.id} run={selectedRun} />;
  }

  if (!sessionId || !runs || runs.length === 0) {
    return <EmptyState title={t("orch.panel.empty")} desc={t("orch.node.overviewEmpty")} />;
  }

  return (
    <div className="h-full overflow-y-auto px-3 py-3" style={{ fontSize: "var(--right-panel-font-size)" }}>
      <div className="space-y-4">
        {runs.map((run) => (
          <RunCard key={run.id} run={run} />
        ))}
      </div>
    </div>
  );
}

/* ═══════════════════ 连线详情(点画布连线进入,可删除) ═══════════════════ */

function EdgeDetail({ run, upstream, downstream }: { run: OrchestrationRun; upstream: TaskNode; downstream: TaskNode }) {
  const { t } = useI18n();
  const selectOrchNode = useSessionStore((s) => s.selectOrchNode);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState(false);
  // 依赖写在下游任务的 deps 里:删除 = 改下游任务 → 下游必须可编辑;
  // 上游只被引用,已完成的上游不影响删除。
  const editable = taskEditable(downstream);
  const backToOverview = () => selectOrchNode(run.id, null);

  const remove = async () => {
    setDeleting(true);
    setError("");
    try {
      const plan = planEdgeDelete(run.tasks, upstream.id, downstream.id);
      for (const m of plan.mutations) {
        await api.orch.updateTask({ runId: run.id, taskId: m.taskId, deps: m.deps });
      }
      // 连线已消失 → 回落运行总览。
      backToOverview();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDeleting(false);
    }
  };

  const statusChipCls = (s: TaskNode["status"]) =>
    s === "completed" ? "text-accent" : s === "running" || s === "dispatched" ? "text-sky" : "text-content-subtle";

  return (
    <div className="h-full overflow-y-auto px-3 py-3" style={{ fontSize: "var(--right-panel-font-size)" }}>
      {/* 头部:返回总览 + 标题 */}
      <div className="mb-3 flex items-center gap-1.5">
        <button
          onClick={backToOverview}
          className="rounded p-1 text-content-subtle hover:bg-surface-hover hover:text-content"
          title={t("orch.node.overviewTitle")}
        >
          <IconArrowLeft size={14} />
        </button>
        <span className="min-w-0 flex-1 truncate font-medium">{t("orch.edge.panelTitle")}</span>
      </div>

      {/* 两端卡片:A → B */}
      <div className="mb-3 space-y-1.5">
        <button
          className="w-full rounded-md border border-edge bg-surface-muted/50 px-2.5 py-2 text-left transition-colors hover:border-accent/50"
          onClick={() => selectOrchNode(run.id, upstream.id)}
        >
          <div className="flex items-center gap-1.5">
            <span className="font-mono text-[0.686em] font-bold text-content-muted">{upstream.id}</span>
            <span className={cn("ml-auto text-[0.686em]", statusChipCls(upstream.status))}>
              {t(`orch.status.${upstream.status}`)}
            </span>
          </div>
          <div className="mt-0.5 truncate text-[0.7857em] font-medium" title={upstream.spec}>
            {taskTitle(upstream)}
          </div>
        </button>
        <div className="flex items-center gap-1.5 pl-3 text-[0.686em] text-content-subtle">
          <span className="inline-block h-3 w-px bg-current" aria-hidden />
          {t("orch.edge.upstreamLabel")}
        </div>
        <button
          className="w-full rounded-md border border-edge bg-surface-muted/50 px-2.5 py-2 text-left transition-colors hover:border-accent/50"
          onClick={() => selectOrchNode(run.id, downstream.id)}
        >
          <div className="flex items-center gap-1.5">
            <span className="font-mono text-[0.686em] font-bold text-content-muted">{downstream.id}</span>
            <span className={cn("ml-auto text-[0.686em]", statusChipCls(downstream.status))}>
              {t(`orch.status.${downstream.status}`)}
            </span>
          </div>
          <div className="mt-0.5 truncate text-[0.7857em] font-medium" title={downstream.spec}>
            {taskTitle(downstream)}
          </div>
        </button>
        <div className="pl-3 text-[0.686em] text-content-subtle">{t("orch.edge.downstreamLabel")}</div>
      </div>

      {/* 语义说明 */}
      <div className="mb-3 rounded-md border border-edge bg-surface-muted/50 px-2.5 py-2 text-[0.7143em] leading-relaxed text-content-muted">
        {t("orch.edge.effect", { up: upstream.id, down: downstream.id })}
      </div>

      {/* 删除 */}
      <button
        className={cn(
          "w-full rounded-md border px-2.5 py-1.5 text-[0.7857em] font-medium transition-colors",
          editable
            ? "border-danger/50 text-danger hover:bg-danger/10 disabled:opacity-50"
            : "cursor-not-allowed border-edge text-content-subtle",
        )}
        disabled={!editable || deleting}
        onClick={() => void remove()}
        title={editable ? undefined : t("orch.edge.dropLocked")}
      >
        {deleting ? "…" : t("orch.edge.deleteBtn")}
      </button>
      {!editable && (
        <div className="mt-1.5 text-[0.686em] text-content-subtle">{t("orch.edge.dropLocked")}</div>
      )}
      {error && <div className="mt-1.5 text-[0.686em] text-danger">{error}</div>}
    </div>
  );
}

/* ═══════════════════ 运行总览(点画布空白 / 整理卡「查看运行详情」) ═══════════════════ */

function RunOverview({ run }: { run: OrchestrationRun }) {
  const { t } = useI18n();
  const closeOrchSelection = useSessionStore((s) => s.closeOrchSelection);
  const done = run.tasks.filter((x) => x.status === "completed").length;
  // 耗时 = 最早派发 → 最晚收尾(跨任务并行的墙钟口径;未派发过 = —)。
  let startedAt = Infinity;
  let endedAt = 0;
  for (const task of run.tasks) {
    for (const d of task.dispatches) {
      startedAt = Math.min(startedAt, d.injectedAt);
      endedAt = Math.max(endedAt, d.endedAt ?? d.injectedAt);
    }
  }
  const duration = Number.isFinite(startedAt)
    ? endedAt - startedAt < 60_000
      ? `${Math.max(1, Math.round((endedAt - startedAt) / 1000))}s`
      : `${Math.floor((endedAt - startedAt) / 60_000)}m${Math.round(((endedAt - startedAt) % 60_000) / 1000)}s`
    : null;

  return (
    <div className="h-full overflow-y-auto px-3 py-3" style={{ fontSize: "var(--right-panel-font-size)" }}>
      {/* 头部:返回列表 + 总览标题 */}
      <div className="mb-3 flex items-center gap-1.5">
        <button
          onClick={closeOrchSelection}
          className="rounded p-1 text-content-subtle hover:bg-surface-hover hover:text-content"
          title={t("orch.node.backToList")}
        >
          <IconArrowLeft size={14} />
        </button>
        <span className="min-w-0 flex-1 truncate font-medium">
          {t("orch.node.overviewTitle")}
        </span>
      </div>

      {/* 目标 */}
      <div className="mb-3 rounded-md border border-edge bg-surface-muted/50 px-2.5 py-2 text-[0.7143em] leading-relaxed text-content-muted">
        {run.goal || run.title}
      </div>

      {/* 统计格:进度 / 状态 / 花费 / 耗时 */}
      <div className="mb-3 grid grid-cols-2 gap-1.5">
        <Stat k={t("orch.node.statProgress")} v={`${done}/${run.tasks.length}`} />
        <Stat k={t("orch.node.statStatus")} v={t(`orch.runstatus.${run.status}`)} />
        <Stat k={t("orch.node.statElapsed")} v={duration ?? "—"} />
      </div>

      {/* 任务清单(点击行 → 节点详情) */}
      <div className="mb-1 text-[0.686em] font-medium uppercase tracking-wide text-content-subtle">
        {t("orch.node.taskList")}
      </div>
      <div className="space-y-1">
        {run.tasks.map((task) => (
          <TaskRow
            key={task.id}
            runId={run.id}
            task={task}
            hasOpenGate={run.gates.some((g) => g.status === "open" && g.taskId === task.id)}
          />
        ))}
      </div>

      {/* 派发规则 */}
      <div className="mb-1 mt-3 text-[0.686em] font-medium uppercase tracking-wide text-content-subtle">
        {t("orch.panel.rules")}
      </div>
      <div className="text-[0.686em] leading-relaxed text-content-subtle">
        {/* 不限并发后不再有上限参数可填。 */}
        {t("orch.node.rules")}
      </div>
    </div>
  );
}

function RunCard({ run }: { run: OrchestrationRun }) {
  const { t } = useI18n();
  const runControl = useSessionStore((s) => s.orchRunControl);
  const selectOrchNode = useSessionStore((s) => s.selectOrchNode);
  const openGates = run.gates.filter((g) => g.status === "open");

  return (
    <div className="rounded-lg border border-edge bg-surface">
      {/* 头部:标题(点击 → 运行总览)+ 状态 + 成本 + run 级控制 */}
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          onClick={() => selectOrchNode(run.id, null)}
          title={t("orch.node.overviewTitle")}
          className={cn(
            "min-w-0 flex-1 truncate text-left font-medium hover:underline",
            RUN_BADGE[run.status],
          )}
        >
          {run.title}
        </button>
        <span className="shrink-0 text-[0.7143em] text-content-subtle">{t(`orch.runstatus.${run.status}`)}</span>
      </div>
      <div className="flex items-center gap-2 px-3 pb-2 text-[0.7143em] text-content-subtle">
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
            <IconTrash size={13} />
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

      {/* 任务清单(点击行 → 节点详情) */}
      <div className="border-t border-edge px-3 py-2">
        <div className="space-y-1">
          {run.tasks.map((task) => (
            <TaskRow
              key={task.id}
              runId={run.id}
              task={task}
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
  hasOpenGate,
}: {
  runId: string;
  task: TaskNode;
  hasOpenGate: boolean;
}) {
  const { t } = useI18n();
  const selectOrchNode = useSessionStore((s) => s.selectOrchNode);
  const customModels = useSessionStore((s) => s.customModels);

  return (
    <button
      onClick={() => selectOrchNode(runId, task.id)}
      className="flex w-full items-start gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-surface-hover"
    >
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
        <span className="mt-0.5 block truncate text-[0.7143em] text-content-muted">{taskTitle(task)}</span>
      </span>
      <span className="shrink-0 text-[0.686em] text-content-subtle">{execLabelOf(task, customModels)}</span>
      <span className={cn("shrink-0 text-[0.686em]", STATUS_DOT[task.status].replace("bg-", "text-"))}>
        {t(`orch.status.${task.status}`)}
      </span>
    </button>
  );
}

/* ═══════════════════ 节点详情 ═══════════════════ */

function NodeDetail({ run, task }: { run: OrchestrationRun; task: TaskNode }) {
  const { t } = useI18n();
  const selectOrchNode = useSessionStore((s) => s.selectOrchNode);
  const taskControl = useSessionStore((s) => s.orchTaskControl);
  // 详情页默认页签随生命周期:跑过 → 输出,待配置 → 配置。
  const [tab, setTab] = useState<"config" | "output">(
    task.status === "running" || task.status === "completed" ? "output" : "config",
  );

  return (
    <div className="h-full overflow-y-auto px-3 py-3" style={{ fontSize: "var(--right-panel-font-size)" }}>
      {/* 头部:返回 + 任务标识 + 状态 */}
      <div className="mb-3 flex items-center gap-1.5">
        <button
          onClick={() => selectOrchNode(run.id, null)}
          className="rounded p-1 text-content-subtle hover:bg-surface-hover hover:text-content"
          title={t("orch.node.backToOverview")}
        >
          <IconArrowLeft size={14} />
        </button>
        <span className="min-w-0 flex-1 truncate font-medium">{`${task.id} · ${taskTitle(task)}`}</span>
        <span className={cn("shrink-0 text-[0.7143em]", STATUS_DOT[task.status].replace("bg-", "text-"))}>
          {t(`orch.status.${task.status}`)}
        </span>
      </div>

      {/* 页签:配置 | 运行输出 */}
      <div className="mb-3 flex gap-1 rounded-lg border border-edge bg-surface-muted p-0.5">
        {(["config", "output"] as const).map((x) => (
          <button
            key={x}
            onClick={() => setTab(x)}
            className={cn(
              "flex-1 rounded-md py-1 text-[0.7143em] transition-colors",
              tab === x ? "bg-surface font-medium text-content shadow-sm" : "text-content-subtle hover:text-content",
            )}
          >
            {t(x === "config" ? "orch.node.tabConfig" : "orch.node.tabOutput")}
          </button>
        ))}
      </div>

      {tab === "config" ? (
        <TaskConfig run={run} task={task} />
      ) : (
        <TaskOutput run={run} task={task} />
      )}

      {/* 节点控制(两个页签共用,常驻底部)。重跑/重试可能被服务端拒绝
          (下游已开始)—— 错误用 alert 浮出,不静默。 */}
      <div className="mt-3 flex flex-wrap gap-1 border-t border-edge pt-2">
        {(task.status === "failed" || task.status === "blocked" || task.status === "canceled") && (
          <MiniBtn
            onClick={() => void taskControl(run.id, task.id, "retry").then((e) => e && window.alert(e))}
          >
            <IconRefresh size={11} /> {t("orch.panel.retry")}
          </MiniBtn>
        )}
        {(task.status === "completed" || task.status === "failed" || task.status === "canceled") && (
          <MiniBtn
            onClick={() => void taskControl(run.id, task.id, "rerun").then((e) => e && window.alert(e))}
          >
            <IconRefresh size={11} /> {t("orch.node.rerun")}
          </MiniBtn>
        )}
        {task.status !== "completed" && task.status !== "canceled" && (
          <MiniBtn onClick={() => void taskControl(run.id, task.id, "markCompleted")}>
            <IconCheck size={11} /> {t("orch.panel.markDone")}
          </MiniBtn>
        )}
      </div>
    </div>
  );
}

/** 配置页:agent / 模型配置 / 简报 / 依赖。仅未派发的任务可写 —— 运行中的
 *  改动会被服务端拒绝,这里直接禁用输入并给出提示。 */
function TaskConfig({ run, task }: { run: OrchestrationRun; task: TaskNode }) {
  const { t } = useI18n();
  const providers = useSessionStore((s) => s.providers);
  const customModels = useSessionStore((s) => s.customModels);
  const piAvailableModels = useSessionStore((s) => s.piAvailableModels);
  const codexAvailableModels = useSessionStore((s) => s.codexAvailableModels);
  const openOrchWorker = useSessionStore((s) => s.openOrchWorker);
  // 失败/取消/阻塞/暂停/待运行都可改配置(改完用「重跑此任务」重新开始);
  // dispatched/running/completed 不可改。
  const editable =
    task.status === "pending" ||
    task.status === "blocked" ||
    task.status === "canceled" ||
    task.status === "paused" ||
    task.status === "failed";
  const lastDispatch = task.dispatches[task.dispatches.length - 1];

  const [spec, setSpec] = useState(task.spec);
  const [providerId, setProviderId] = useState(task.providerId ?? "");
  // claude 网关模型编码为 "cfgId|modelId";其余厂商为裸 model id;空 = 跟随默认。
  const [modelSel, setModelSel] = useState(
    task.customModelId ? `${task.customModelId}|${task.model ?? "default"}` : (task.model ?? ""),
  );
  const [effort, setEffort] = useState(task.effort ?? "");
  const [permissionMode, setPermissionMode] = useState(task.permissionMode ?? "");
  const [deps, setDeps] = useState<string[]>(task.deps);
  const [saving, setSaving] = useState(false);
  const [savedTick, setSavedTick] = useState(false);
  const [error, setError] = useState("");

  // 当前厂商的能力声明:模型表 / 思考级别 / 权限模式全部来自 provider 自描述。
  const provider = providers.find((p) => p.id === providerId);
  const thinkingLevels = provider?.capabilities.thinkingLevels ?? [];
  const permissionModes = provider?.capabilities.permissionModes ?? [];
  const modelOptions = useMemo(() => {
    if (providerId === "claude-sdk") {
      // claude = 用户配置的自定义端点展开(端点名 · 模型 id)。
      return customModels.flatMap((c) =>
        c.models
          .filter((m) => m.id.trim())
          .map((m) => ({ value: `${c.id}|${m.id}`, label: `${c.name} · ${m.id}` })),
      );
    }
    if (providerId === "pi-sdk") {
      return piAvailableModels.map((m) => ({ value: m.id, label: m.label }));
    }
    if (providerId === "codex-sdk") {
      return codexAvailableModels.map((m) => ({ value: m.id, label: m.label }));
    }
    return [];
  }, [providerId, customModels, piAvailableModels, codexAvailableModels]);

  // 把选择解析回 {customModelId, model} 覆盖(claude 的 "|" 编码拆开)。
  const parseModel = (sel: string): { customModelId: string | null; model: string | null } => {
    if (providerId === "claude-sdk") {
      if (sel.includes("|")) {
        const [cfgId, model] = sel.split("|");
        return { customModelId: cfgId || null, model: model || null };
      }
      return { customModelId: null, model: null };
    }
    return { customModelId: null, model: sel || null };
  };
  const taskModelSel = task.customModelId
    ? `${task.customModelId}|${task.model ?? "default"}`
    : (task.model ?? "");
  const parsed = parseModel(modelSel);

  const dirty =
    spec !== task.spec ||
    deps.join(",") !== task.deps.join(",") ||
    (task.providerId ?? "") !== providerId ||
    taskModelSel !== modelSel ||
    (task.effort ?? "") !== effort ||
    (task.permissionMode ?? "") !== permissionMode;

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      await api.orch.updateTask({
        runId: run.id,
        taskId: task.id,
        ...(spec.trim() ? { spec: spec.trim() } : {}),
        deps,
        providerId: providerId || null,
        customModelId: parsed.customModelId,
        model: parsed.model,
        effort: effort || null,
        permissionMode: permissionMode || null,
      });
      setSavedTick(true);
      setTimeout(() => setSavedTick(false), 1600);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(t("orch.node.deleteConfirm"))) return;
    try {
      await api.orch.removeTask({ runId: run.id, taskId: task.id });
      useSessionStore.getState().selectOrchNode(run.id, null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const merge = async () => {
    const err = await useSessionStore.getState().orchMergeTask(run.id, task.id);
    if (err) window.alert(t("orch.panel.mergeFailed") + ": " + err);
  };

  const selectCls =
    "w-full rounded-md border border-edge bg-surface px-2 py-1 outline-none focus:border-accent disabled:opacity-60";

  return (
    <div className="space-y-3">
      <Field label={t("orch.node.provider")}>
        <select
          value={providerId}
          disabled={!editable}
          onChange={(e) => {
            // 切厂商:模型/级别/权限跨厂商无意义,一并收拢。
            setProviderId(e.target.value);
            setModelSel("");
            setEffort("");
            setPermissionMode("");
          }}
          className={selectCls}
        >
          <option value="">{t("orch.node.modelNone")}</option>
          {providers.map((pr) => (
            <option key={pr.id} value={pr.id}>
              {pr.displayName}
            </option>
          ))}
        </select>
      </Field>

      <Field label={t("orch.node.model")}>
        <select
          value={modelSel}
          disabled={!editable || !providerId}
          onChange={(e) => setModelSel(e.target.value)}
          className={selectCls}
        >
          <option value="">{providerId ? t("orch.node.followEmpty") : t("orch.node.modelNone")}</option>
          {modelOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </Field>

      {thinkingLevels.length > 0 && (
        <Field label={t("orch.node.effort")}>
          <select value={effort} disabled={!editable} onChange={(e) => setEffort(e.target.value)} className={selectCls}>
            <option value="">{t("orch.node.followEmpty")}</option>
            {thinkingLevels.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label ?? l.value}
              </option>
            ))}
          </select>
        </Field>
      )}

      {permissionModes.length > 0 && (
        <Field label={t("orch.node.permission")}>
          <select
            value={permissionMode}
            disabled={!editable}
            onChange={(e) => setPermissionMode(e.target.value)}
            className={selectCls}
          >
            <option value="">{t("orch.node.followEmpty")}</option>
            {permissionModes.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label ?? m.value}
              </option>
            ))}
          </select>
        </Field>
      )}

      <Field label={t("orch.node.spec")}>
        <textarea
          value={spec}
          disabled={!editable}
          onChange={(e) => setSpec(e.target.value)}
          rows={4}
          className="w-full resize-y rounded-md border border-edge bg-surface px-2 py-1 leading-relaxed outline-none focus:border-accent disabled:opacity-60"
        />
      </Field>

      <Field label={t("orch.node.deps")}>
        <div className="flex flex-wrap gap-1">
          {run.tasks.filter((x) => x.id !== task.id).map((x) => {
            const on = deps.includes(x.id);
            return (
              <button
                key={x.id}
                disabled={!editable}
                onClick={() => setDeps((d) => (on ? d.filter((v) => v !== x.id) : [...d, x.id]))}
                className={cn(
                  "rounded-full border px-2 py-0.5 font-mono text-[0.686em] disabled:opacity-60",
                  on ? "border-accent bg-accent/10 text-accent" : "border-edge text-content-subtle hover:border-accent hover:text-accent",
                )}
              >
                {x.id}
              </button>
            );
          })}
        </div>
      </Field>

      {!editable && <div className="text-[0.686em] text-content-subtle">{t("orch.node.lockedHint")}</div>}
      {error && <div className="text-[0.686em] text-danger">{error}</div>}

      <div className="flex flex-wrap gap-1">
        {editable && (
          <MiniBtn onClick={() => void save()} disabled={!dirty || saving}>
            {savedTick ? <IconCheck size={11} /> : null}
            {savedTick ? t("orch.node.saved") : t("orch.node.save")}
          </MiniBtn>
        )}
        {lastDispatch?.workerSessionId && task.runner === "agent" && (
          <MiniBtn onClick={() => void openOrchWorker(lastDispatch.workerSessionId!)}>
            <IconExternalLink size={11} /> {t("orch.node.openWorker")}
          </MiniBtn>
        )}
        {task.worktreePath && task.status === "completed" && (
          <MiniBtn onClick={() => void merge()}>
            <IconGitFork size={11} /> {t("orch.node.mergeBack")}
          </MiniBtn>
        )}
        {task.status === "pending" && (
          <MiniBtn onClick={() => void remove()} className="hover:border-danger hover:text-danger">
            <IconTrash size={11} /> {t("orch.node.delete")}
          </MiniBtn>
        )}
      </div>
    </div>
  );
}

/** 运行输出页:统计格 + 产物 + worker 输出控制台。 */
function TaskOutput({ run, task }: { run: OrchestrationRun; task: TaskNode }) {
  const { t } = useI18n();
  const messagesBySession = useSessionStore((s) => s.messagesBySession);
  const lastDispatch = task.dispatches[task.dispatches.length - 1];
  const workerSessionId = task.runner === "agent" ? lastDispatch?.workerSessionId : undefined;

  // 运行中秒级心跳:用时与画布节点同一口径(dispatches 时间戳),同步走表;
  // 结束后无心跳、且用时取 endedAt —— 计时自然冻结。
  const [, setTick] = useState(0);
  useEffect(() => {
    if (task.status !== "running" && task.status !== "dispatched") return;
    const iv = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(iv);
  }, [task.status]);

  // worker 会话历史水合(一次性;实时事件由 ingestEvent 持续入桶)。
  useEffect(() => {
    if (!workerSessionId) return;
    void useSessionStore.getState().prefetchSessionMessages(workerSessionId);
  }, [workerSessionId]);

  const workerMessages = workerSessionId ? messagesBySession[workerSessionId] : undefined;

  const elapsed = (() => {
    if (!lastDispatch) return null;
    const end = task.status === "running" || task.status === "dispatched" ? Date.now() : lastDispatch.endedAt;
    if (!end) return null;
    const ms = end - lastDispatch.injectedAt;
    return ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
  })();
  const tokens =
    task.result?.usage != null ? (task.result.usage.inputTokens ?? 0) + (task.result.usage.outputTokens ?? 0) : null;
  const files = [...(task.result?.filesModified ?? []), ...task.artifacts];

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-1.5">
        <Stat k={t("orch.node.statStatus")} v={t(`orch.status.${task.status}`)} />
        <Stat k={t("orch.node.statElapsed")} v={elapsed ?? "—"} />
        <Stat k={t("orch.node.statTokens")} v={tokens != null ? tokens.toLocaleString() : "—"} />
      </div>

      {task.runner === "terminal" && task.result?.exitCode != null && (
        <div className="rounded-md border border-edge bg-surface-muted/50 px-2 py-1.5 text-[0.7143em] text-content-muted">
          {t("orch.node.terminalResult", { code: task.result.exitCode })}
        </div>
      )}

      <div>
        <div className="mb-1 text-[0.686em] font-medium uppercase tracking-wide text-content-subtle">
          {t("orch.node.artifacts")}
        </div>
        {files.length > 0 ? (
          <div className="max-h-28 space-y-0.5 overflow-y-auto font-mono text-[0.686em] text-content-muted">
            {files.map((f) => (
              <div key={f} className="truncate">
                {f}
              </div>
            ))}
          </div>
        ) : (
          <div className="text-[0.686em] text-content-subtle">{t("orch.node.artifactsEmpty")}</div>
        )}
      </div>

      <div>
        <div className="mb-1 text-[0.686em] font-medium uppercase tracking-wide text-content-subtle">
          {t("orch.node.outputLog")}
        </div>
        <div className="max-h-[420px] overflow-hidden rounded-md border border-edge bg-surface">
          {!lastDispatch ? (
            <div className="px-3 py-4 text-[0.686em] text-content-subtle">{t("orch.node.outputEmpty")}</div>
          ) : task.status === "canceled" && !workerMessages?.length ? (
            <div className="px-3 py-4 text-[0.686em] text-content-subtle">{t("orch.node.outputCanceled")}</div>
          ) : (
            <WorkerTranscript
              messages={workerMessages ?? []}
              running={task.status === "running"}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/** worker 过程流:与子会话转录(SideChatPanel 的 SubagentView)同款 ——
 *  MessageBlocks 纯展示渲染(流式文本/思考/工具卡片),运行中自动跟随
 *  滚动到底部。worker 会话的 delta 经 ingestEvent 实时入桶,无需轮询。 */
function WorkerTranscript({
  messages,
  running,
}: {
  messages: ChatMessage[];
  running: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const blocks = useMemo(
    () => messages.filter((m) => m.role === "assistant").flatMap((m) => m.blocks),
    [messages],
  );
  // 运行中跟随尾部(与 SubagentView 同款意图):新块到达即滚到底。
  useEffect(() => {
    if (running) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [blocks, running]);

  return (
    <div ref={scrollRef} className="max-h-[420px] min-h-0 overflow-y-auto px-2.5 py-2">
      {blocks.length === 0 ? (
        <div className="flex items-center gap-2 px-2 py-4 text-[0.7143em] text-content-subtle">
          {running && <span className="chat-caret" aria-hidden />}
        </div>
      ) : (
        <>
          <MessageBlocks blocks={blocks} />
          {running && (
            <div className="mt-1 flex items-center gap-1.5">
              <span className="chat-caret" aria-hidden />
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1 text-[0.7143em] text-content-muted">{label}</div>
      {children}
    </label>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div className="rounded-md border border-edge bg-surface-muted px-2 py-1.5">
      <div className="text-[0.686em] text-content-subtle">{k}</div>
      <div className="mt-0.5 font-medium" style={{ fontSize: "1em" }}>
        {v}
      </div>
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

function MiniBtn({
  onClick,
  disabled,
  className,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex items-center gap-1 rounded border border-edge px-1.5 py-0.5 text-[0.686em] text-content-muted hover:border-accent hover:text-accent disabled:opacity-50",
        className,
      )}
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
