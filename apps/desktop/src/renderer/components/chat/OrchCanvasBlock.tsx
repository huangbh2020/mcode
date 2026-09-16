import { useEffect, useMemo, useState, type ReactNode } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import type { MessageId } from "@renderer/lib/i18n/core.js";
import { api } from "@renderer/lib/api.js";
import { isElectron } from "@renderer/lib/platform.js";
import type { TaskNode } from "@contracts/orchestration";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import {
  IconCheck,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlayerStop,
  IconPlus,
  IconRefresh,
  IconX,
} from "@renderer/lib/icons.js";

/**
 * 编排画布 —— 聊天流内的任务 DAG 卡片(自动编排流第②-④步的载体)。
 *
 * 块数据只锚定 runId/goal(会话重开后从持久化消息原样恢复);节点与运行
 * 状态实时读 `orchRunsBySession`(main 的 run.updated 推送 → ingestOrchEvent
 * 已驱动更新),run 不在内存时经 `ensureOrchRun` 按 id 拉取,超出本地保留
 * 上限(最近 50 条)则降级为「已归档」占位卡。
 *
 * 布局:按 deps 分层(layer = 1 + max(dep.layer)),同层纵向居中;依赖边是
 * 全幅 SVG 上的三次贝塞尔(随上游完成:虚线流动 → 变绿),节点卡绝对定位
 * 在 SVG 之上,整体横向滚动。点击节点 → `selectOrchNode`(右栏 orch 页签
 * 切到节点详情);点击画布空白 → 运行总览。纯展示组件不持轮询,唯一的
 * 定时器是运行中的秒级耗时刷新。
 */

const NODE_W = 172;
const NODE_H = 86;
const GAP_X = 56;
const GAP_Y = 44;
const PAD = 24;
const BODY_H = 288;

/** 节点展示标题 = spec 首行(与 worker 简报、结果整理的口径一致)。 */
function titleOf(task: TaskNode): string {
  const line = task.spec.split("\n")[0].trim();
  return (line.length > 34 ? `${line.slice(0, 34)}…` : line) || task.id;
}

function taskElapsed(task: TaskNode, now: number): number | null {
  const d = task.dispatches[task.dispatches.length - 1];
  if (!d) return null;
  return (task.status === "running" ? now : (d.endedAt ?? now)) - d.injectedAt;
}

function fmtDur(ms: number): string {
  if (ms < 0) ms = 0;
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

export function OrchCanvasBlock({ runId, goal }: { canvasId: string; runId: string; goal: string }) {
  const { t } = useI18n();
  const runsMap = useSessionStore((s) => s.orchRunsBySession);
  const agents = useSessionStore((s) => s.orchAgents);
  const customModels = useSessionStore((s) => s.customModels);
  const ensureOrchRun = useSessionStore((s) => s.ensureOrchRun);
  const selectOrchNode = useSessionStore((s) => s.selectOrchNode);
  const orchRunControl = useSessionStore((s) => s.orchRunControl);
  const selectedNodeId = useSessionStore((s) =>
    s.orchNodeSelection?.runId === runId ? s.orchNodeSelection.taskId : null,
  );

  const run = useMemo(() => {
    for (const list of Object.values(runsMap)) {
      const hit = list.find((r) => r.id === runId);
      if (hit) return hit;
    }
    return undefined;
  }, [runsMap, runId]);

  // 重开会话:画布块在消息里,但 run 不在 per-session 列表里 → 按 id 拉一次。
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    if (hydrated || run || !isElectron) return;
    setHydrated(true);
    void ensureOrchRun(runId);
  }, [hydrated, run, runId, ensureOrchRun]);

  // 运行中:秒级心跳刷新节点耗时(elapsed 从 dispatch 时间戳推导,不落状态)。
  const [, setTick] = useState(0);
  const anyRunning = run?.tasks.some((x) => x.status === "running" || x.status === "dispatched") ?? false;
  useEffect(() => {
    if (!anyRunning) return;
    const iv = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(iv);
  }, [anyRunning]);

  /* ── 分层布局(layer = 1 + max(dep.layer)),同层纵向居中 ──
   * hook 必须全部位于 `if (!run) return` 早退之前(React hooks 规则)——
   * run 从未加载到已加载的首次渲染会改变 hook 数量,否则触发
   * "Rendered more hooks than during the previous render"。run 为空时给
   * 空布局占位。 */
  const layout = useMemo(() => {
    if (!run) return { pos: new Map<string, { x: number; y: number }>(), addPos: { x: 0, y: 0 }, width: 0, height: 0 };
    const layerOf = new Map<string, number>();
    const layerOfNode = (id: string): number => {
      const memo = layerOf.get(id);
      if (memo !== undefined) return memo;
      const task = run.tasks.find((x) => x.id === id);
      const l =
        !task || task.deps.length === 0
          ? 0
          : 1 + Math.max(...task.deps.map((d) => layerOfNode(d)));
      layerOf.set(id, l);
      return l;
    };
    run.tasks.forEach((x) => layerOfNode(x.id));
    const byLayer: TaskNode[][] = [];
    for (const x of run.tasks) {
      const l = layerOf.get(x.id) ?? 0;
      (byLayer[l] ??= []).push(x);
    }
    const maxLayer = Math.max(0, byLayer.length - 1);
    const rows = Math.max(1, ...byLayer.map((c) => c.length ?? 0));
    const height = Math.max(BODY_H, rows * (NODE_H + GAP_Y) + PAD * 2);
    // 宽度多算一列:末层右侧的「＋ 任务」占位卡(与原型一致)。
    const width = PAD * 2 + (maxLayer + 2) * NODE_W + (maxLayer + 1) * GAP_X;
    const pos = new Map<string, { x: number; y: number }>();
    byLayer.forEach((col, li) => {
      const totalH = col.length * NODE_H + (col.length - 1) * GAP_Y;
      const y0 = Math.max(PAD, (height - totalH) / 2 - 6);
      col.forEach((x, ri) => {
        pos.set(x.id, { x: PAD + li * (NODE_W + GAP_X), y: y0 + ri * (NODE_H + GAP_Y) });
      });
    });
    // 占位卡纵向对齐末层中点(末层单节点时即与其同行)。
    const lastCol = byLayer[maxLayer] ?? [];
    const lastTotal = lastCol.length * NODE_H + (lastCol.length - 1) * GAP_Y;
    const lastY0 = Math.max(PAD, (height - lastTotal) / 2 - 6);
    const addPos = {
      x: PAD + (maxLayer + 1) * (NODE_W + GAP_X),
      y: lastY0 + Math.max(0, (lastCol.length - 1) * (NODE_H + GAP_Y)) / 2,
    };
    return { pos, addPos, width, height };
  }, [run]);

  if (!run) {
    // run 未加载(拉取中)或已归档 —— 拉取窗口极短,统一按归档卡呈现。
    return (
      <div className="oc-archived" data-archived="1">
        <div className="oc-archived-title">{t("orch.canvas.archived")}</div>
        <div className="oc-archived-desc">{goal}</div>
        <div className="oc-archived-desc">{t("orch.canvas.archivedDesc")}</div>
      </div>
    );
  }

  const now = Date.now();
  const doneCount = run.tasks.filter((x) => x.status === "completed").length;
  const taskById = (id: string) => run.tasks.find((x) => x.id === id);

  const profileOf = (task: TaskNode) => (task.profileId ? agents.find((a) => a.id === task.profileId) : undefined);
  // 节点执行者标签:厂商/模型覆盖优先,回退 agent 角色(@@ 目标),全空 = 未指派。
  const modelLabelOf = (task: TaskNode): string => {
    if (task.providerId) {
      if (task.customModelId) {
        const cfg = customModels.find((c) => c.id === task.customModelId);
        if (cfg) return task.model && task.model !== "default" ? `${cfg.name} · ${task.model}` : cfg.name;
      }
      if (task.model && task.model !== "default") return `${task.providerId} · ${task.model}`;
      return task.providerId;
    }
    const p = profileOf(task);
    if (p) return `${p.providerId}/${p.model === "default" ? "跟随" : p.model}`;
    return t("orch.canvas.nodeUnassigned");
  };

  const statusChip = () => {
    const map: Record<string, { key: MessageId; cls: string }> = {
      planning: { key: "orch.canvas.status.planning", cls: "planning" },
      running: { key: "orch.canvas.status.running", cls: "running" },
      paused: { key: "orch.canvas.status.paused", cls: "paused" },
      completed: { key: "orch.canvas.status.completed", cls: "done" },
      failed: { key: "orch.canvas.status.failed", cls: "failed" },
      canceled: { key: "orch.canvas.status.canceled", cls: "canceled" },
    };
    const m = map[run.status];
    return (
      <span className={cn("oc-status", m.cls)}>
        {run.status === "running" && <span className="oc-dot" />}
        {t(m.key, { n: run.tasks.length })}
      </span>
    );
  };

  const runButton = () => {
    if (!isElectron) return null;
    const btn = (action: "start" | "pause" | "resume" | "cancel" | "restart", label: string, icon: ReactNode, cls: string) => (
      <button
        className={cn("oc-btn", cls)}
        onClick={(e) => {
          e.stopPropagation();
          void orchRunControl(run.id, action);
        }}
      >
        {icon}
        {label}
      </button>
    );
    switch (run.status) {
      case "planning":
        return btn("start", t("orch.canvas.run"), <IconPlayerPlay size={13} fill="currentColor" />, "primary");
      case "running":
        return (
          <>
            {btn("pause", t("orch.canvas.pause"), <IconPlayerPause size={13} fill="currentColor" />, "warn")}
            {btn("cancel", t("orch.canvas.stop"), <IconPlayerStop size={13} fill="currentColor" />, "danger")}
          </>
        );
      case "paused":
        return (
          <>
            {btn("resume", t("orch.canvas.resume"), <IconPlayerPlay size={13} fill="currentColor" />, "primary")}
            {btn("cancel", t("orch.canvas.stop"), <IconPlayerStop size={13} fill="currentColor" />, "danger")}
          </>
        );
      default:
        return btn("restart", t("orch.canvas.restart"), <IconRefresh size={13} />, "primary");
    }
  };

  const addTask = () => {
    void api.orch
      .addTasks({
        runId: run.id,
        tasks: [
          {
            id: `n${Date.now().toString(36)}`,
            spec: goal || t("orch.node.spec"),
            deps: [],
            profileId: null,
            customModelId: null,
            providerId: null,
            model: null,
            effort: null,
            permissionMode: null,
            reviewOf: null,
            variantGroup: null,
            tags: [],
            runner: "agent",
          },
        ],
      })
      .then(({ run: updated }) => {
        const fresh = updated.tasks.filter((x) => !run.tasks.some((old) => old.id === x.id));
        if (fresh.length > 0) selectOrchNode(run.id, fresh[0].id);
      })
      .catch((err) => console.error("orch.addTasks failed:", err));
  };

  return (
    <div className="orch-canvas" data-orch-canvas-run={run.id}>
      {/* ── 头部:标题 / 状态 / 统计 / 控制 ── */}
      <div className="oc-head">
        <span className="oc-title" title={goal}>
          {goal.length > 30 ? `${goal.slice(0, 30)}…` : goal || run.title}
        </span>
        {statusChip()}
        <span className="oc-stats">
          {t("orch.canvas.stats", {
            done: doneCount,
            total: run.tasks.length,
            concurrency: run.concurrency,
            budget: run.budgetUsd != null ? `$${run.budgetUsd.toFixed(2)}` : t("orch.canvas.budgetNone"),
          })}
        </span>
        <div className="oc-actions">
          {isElectron && (
            <button
              className="oc-btn"
              onClick={(e) => {
                e.stopPropagation();
                addTask();
              }}
            >
              <IconPlus size={13} />
              {t("orch.canvas.addTask")}
            </button>
          )}
          {runButton()}
        </div>
      </div>
      <div className="oc-progress">
        <i style={{ width: `${run.tasks.length > 0 ? (doneCount / run.tasks.length) * 100 : 0}%` }} />
      </div>

      {/* ── 画布主体:依赖边(SVG) + 节点卡(绝对定位) ── */}
      <div
        className="oc-body"
        onClick={(e) => {
          if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains("oc-inner")) {
            selectOrchNode(run.id, null);
          }
        }}
      >
        <div className="oc-inner" style={{ width: layout.width, height: layout.height }}>
          <svg className="oc-edges" width={layout.width} height={layout.height}>
            <defs>
              <marker id={`oc-arw-${run.id}`} viewBox="0 0 8 8" refX={7} refY={4} markerWidth={7} markerHeight={7} orient="auto">
                <path d="M0 0L8 4L0 8z" fill="currentColor" />
              </marker>
            </defs>
            {run.tasks.flatMap((task) =>
              task.deps.map((dep) => {
                const a = layout.pos.get(dep);
                const b = layout.pos.get(task.id);
                if (!a || !b) return null;
                const x1 = a.x + NODE_W;
                const y1 = a.y + NODE_H / 2;
                const x2 = b.x - 4;
                const y2 = b.y + NODE_H / 2;
                const mx = (x1 + x2) / 2;
                const upstreamDone = taskById(dep)?.status === "completed";
                const cls = task.status === "completed" ? "done" : upstreamDone ? "flow" : "";
                return (
                  <path
                    key={`${dep}-${task.id}`}
                    className={cls}
                    markerEnd={`url(#oc-arw-${run.id})`}
                    d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`}
                  />
                );
              }),
            )}
          </svg>
          {run.tasks.map((task) => {
            const a = layout.pos.get(task.id);
            if (!a) return null;
            const p = profileOf(task);
            const elapsed = taskElapsed(task, now);
            return (
              <div
                key={task.id}
                data-task-id={task.id}
                className={cn(
                  "oc-node",
                  task.status === "running" && "running",
                  task.status === "completed" && "done",
                  task.status === "canceled" && "canceled",
                  task.status === "failed" && "failed",
                  task.status === "blocked" && "failed",
                  selectedNodeId === task.id && "selected",
                )}
                style={{ left: a.x, top: a.y, width: NODE_W }}
                onClick={(e) => {
                  e.stopPropagation();
                  selectOrchNode(run.id, task.id);
                }}
              >
                <div className="oc-node-top">
                  <span className="oc-node-id">{task.id}</span>
                  {task.variantGroup && <span className="oc-node-variant">{task.variantGroup}</span>}
                  <span className="oc-node-st">
                    {task.status === "running" && <span className="oc-spin" />}
                    {task.status === "completed" && <IconCheck size={12} />}
                    {(task.status === "failed" || task.status === "blocked") && <IconX size={12} />}
                    <span>
                      {task.status === "running" && elapsed != null && fmtDur(elapsed)}
                      {task.status === "completed" && elapsed != null && fmtDur(elapsed)}
                      {task.status === "paused" && t("orch.canvas.status.paused")}
                      {(task.status === "failed" || task.status === "blocked") && t("orch.canvas.status.failed")}
                      {task.status === "canceled" && t("orch.canvas.status.canceled")}
                    </span>
                  </span>
                </div>
                <div className="oc-node-title" title={task.spec}>
                  {titleOf(task)}
                </div>
                <div className="oc-node-sub">
                  <span className={cn(!task.providerId && !task.profileId && "oc-node-unassigned")}>
                    {modelLabelOf(task)}
                  </span>
                </div>
                <div className="oc-node-foot">
                  <div className="oc-node-bar">
                    <i
                      className={cn(task.status === "running" && "indeterminate")}
                      style={{ width: task.status === "completed" ? "100%" : undefined }}
                    />
                  </div>
                  {(task.status === "completed" || task.status === "running") && task.result?.usage && (
                    <span>
                      {t("orch.canvas.tokens", {
                        n: ((task.result.usage.inputTokens ?? 0) + (task.result.usage.outputTokens ?? 0)).toLocaleString(),
                      })}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
          {/* 末层右侧「＋ 任务」占位卡(仅 Electron;点击与头部按钮同路) */}
          {isElectron && (
            <button
              className="oc-add-node"
              style={{ left: layout.addPos.x, top: layout.addPos.y, width: NODE_W, height: NODE_H }}
              onClick={(e) => {
                e.stopPropagation();
                addTask();
              }}
            >
              <IconPlus size={13} />
              {t("orch.canvas.addTask")}
            </button>
          )}
        </div>
      </div>

      {/* ── 脚注:图例 + 提示 ── */}
      <div className="oc-foot">
        <span className="oc-lg">
          <i className="pending" />
          {t("orch.canvas.legendPending")}
        </span>
        <span className="oc-lg">
          <i className="running" />
          {t("orch.canvas.legendRunning")}
        </span>
        <span className="oc-lg">
          <i className="done" />
          {t("orch.canvas.legendDone")}
        </span>
        <span className="oc-hint">{t("orch.canvas.hint")}</span>
      </div>
    </div>
  );
}
