import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import type { MessageId } from "@renderer/lib/i18n/core.js";
import { api } from "@renderer/lib/api.js";
import { isElectron } from "@renderer/lib/platform.js";
import type { TaskNode } from "@contracts/orchestration";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useToastStore } from "@renderer/stores/toastStore.js";
import { OrchWorkerConsole, orchFormatDuration as fmtDur, orchTaskTitle as titleOf } from "./OrchWorkerConsole.js";
import {
  dropVerdict,
  planEdgeDelete,
  planEdgeMove,
  taskEditable,
  type CommitPlan,
  type DraggedEnd,
  type DropVerdict,
} from "@renderer/lib/orchGraph.js";
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
 * 切到节点详情);点击画布空白 → 运行总览。
 *
 * 拖线编辑:边可抓两端改接(抓靠近哪端就 detach 哪端),节点端口可拉新线,
 * 线中点 ✕ 删边。拖拽中节点实时标注合法性(合法 accent 光圈 / 非法压暗 /
 * 已连接压暗);空点与 Esc 回弹。仅可编辑任务(pending/blocked/canceled/
 * paused/failed)参与,运行中的边锁定。合法性判定与提交序列在
 * lib/orchGraph.ts 纯函数层,后端 updateTask 是权威。
 */

const NODE_W = 172;
const NODE_H = 86;
const GAP_X = 56;
const GAP_Y = 44;
const PAD = 24;
const BODY_H = 288;

function taskElapsed(task: TaskNode, now: number): number | null {
  const d = task.dispatches[task.dispatches.length - 1];
  if (!d) return null;
  return (task.status === "running" ? now : (d.endedAt ?? now)) - d.injectedAt;
}

/** 拖拽会话:一条被抓住的边或端口。 */
interface DragState {
  /** 锚定端任务(不动的那头)。 */
  fixed: string;
  /** 拖动端原任务(新建连线时 === fixed)。 */
  dragged: string;
  /** 拖动端扮演的角色:箭头端(下游)或尾巴端(上游)—— 决定最终边方向。 */
  role: DraggedEnd;
  /** 拖动端锚在哪个任务上(橡皮筋当前指向;null = 悬空)。 */
  hover: string | null;
  /** 指针在画布内坐标(oc-inner 系)。 */
  x: number;
  y: number;
  /** 按下点(oc-inner 系):位移阈值内松手 = 点击而非拖拽。 */
  originX: number;
  originY: number;
  /** 从边热区发起的拖拽记录边身份(位移阈值内松手 → 选中连线)。 */
  edgeKey?: string;
}

/** 点击 vs 拖拽的位移阈值(oc-inner px)。 */
const CLICK_SLOP = 5;

/** 边的几何(oc-inner 坐标):上游右缘中点 → 下游左缘中点。 */
function edgeGeometry(
  pos: Map<string, { x: number; y: number }>,
  upstream: string,
  downstream: string,
): { x1: number; y1: number; x2: number; y2: number } | null {
  const a = pos.get(upstream);
  const b = pos.get(downstream);
  if (!a || !b) return null;
  return { x1: a.x + NODE_W, y1: a.y + NODE_H / 2, x2: b.x - 4, y2: b.y + NODE_H / 2 };
}

function edgePath(g: { x1: number; y1: number; x2: number; y2: number }): string {
  const mx = (g.x1 + g.x2) / 2;
  return `M ${g.x1} ${g.y1} C ${mx} ${g.y1}, ${mx} ${g.y2}, ${g.x2} ${g.y2}`;
}

export function OrchCanvasBlock({ runId, goal }: { canvasId: string; runId: string; goal: string }) {
  const { t } = useI18n();
  const runsMap = useSessionStore((s) => s.orchRunsBySession);
  const agents = useSessionStore((s) => s.orchAgents);
  const customModels = useSessionStore((s) => s.customModels);
  const ensureOrchRun = useSessionStore((s) => s.ensureOrchRun);
  const selectOrchNode = useSessionStore((s) => s.selectOrchNode);
  const selectOrchEdge = useSessionStore((s) => s.selectOrchEdge);
  const orchRunControl = useSessionStore((s) => s.orchRunControl);
  const selectedNodeId = useSessionStore((s) =>
    s.orchNodeSelection?.runId === runId ? s.orchNodeSelection.taskId : null,
  );
  // 选中的连线(点边 → 右栏连线详情);节点选中会清掉 edge,两者互斥。
  const selection = useSessionStore((s) => s.orchNodeSelection);
  const selectedEdge =
    selection?.runId === runId && selection.taskId === null && selection.edge ? selection.edge : null;

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

  /* ── 拖线状态机 ──
   * 悬停态(hoverEdge / hoverNode)本地即可;拖拽态(drag)用 ref + state
   * 双写(pointermove 高频走 ref,state 驱动重渲染)。
   * 提交序列经 planEdgeMove/planEdgeDelete 编译,updateTask 逐个执行,
   * 失败按 rollback 逆序回滚(run.updated 推送会自愈快照)。 */
  const [hoverEdge, setHoverEdge] = useState<string | null>(null); // `${upstream}->${downstream}`
  const [hoverNode, setHoverNode] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [committing, setCommitting] = useState(false);

  useEffect(() => {
    dragRef.current = drag;
  }, [drag]);

  /** 节点中心近似命中(端口吸附前的粗判):点到节点矩形内 → 该节点。 */
  const taskAt = useCallback(
    (x: number, y: number): string | null => {
      if (!run) return null;
      for (const task of run.tasks) {
        const p = layout.pos.get(task.id);
        if (!p) continue;
        if (x >= p.x && x <= p.x + NODE_W && y >= p.y && y <= p.y + NODE_H) return task.id;
      }
      return null;
    },
    [run, layout],
  );

  /** 指针事件坐标 → oc-inner 坐标(补偿滚动与容器偏移)。 */
  const innerPoint = useCallback((clientX: number, clientY: number): { x: number; y: number } | null => {
    const el = innerRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  }, []);

  /** 拖拽中所有节点的落点判定(一次性算好,渲染层只查表)。 */
  const verdicts = useMemo(() => {
    const map = new Map<string, DropVerdict>();
    if (!drag || !run) return map;
    for (const task of run.tasks) {
      map.set(task.id, dropVerdict(run.tasks, drag.fixed, drag.dragged, task.id, drag.role));
    }
    return map;
  }, [drag, run]);

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const cur = dragRef.current;
      if (!cur) return;
      const p = innerPoint(e.clientX, e.clientY);
      if (!p) return;
      const next: DragState = { ...cur, ...p, hover: taskAt(p.x, p.y) };
      dragRef.current = next;
      setDrag(next);
    },
    [innerPoint, taskAt],
  );

  /** 执行提交计划:mutations 顺序执行,失败按 rollback 逆序回滚。 */
  const commit = useCallback(
    async (plan: CommitPlan, runIdArg: string) => {
      if (plan.mutations.length === 0) return;
      setCommitting(true);
      const done: typeof plan.rollback = [];
      try {
        for (const m of plan.mutations) {
          await api.orch.updateTask({ runId: runIdArg, taskId: m.taskId, deps: m.deps });
          done.push(plan.rollback.find((r) => r.taskId === m.taskId) ?? { taskId: m.taskId, deps: m.deps });
        }
      } catch (err) {
        console.error("orch edge edit failed:", err);
        useToastStore.getState().push({ kind: "error", title: t("orch.edge.dropFailed"), body: (err as Error).message });
        for (const r of done.reverse()) {
          try {
            await api.orch.updateTask({ runId: runIdArg, taskId: r.taskId, deps: r.deps });
          } catch {
            // 回滚失败:run.updated 快照与后端权威仍一致,不再递归兜底。
          }
        }
      } finally {
        setCommitting(false);
      }
    },
    [t],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      const cur = dragRef.current;
      if (!cur) return;
      const p = innerPoint(e.clientX, e.clientY);
      const target = p ? taskAt(p.x, p.y) : null;
      setDrag(null);
      dragRef.current = null;
      // 位移阈值内松手 = 点击:从边热区发起 → 选中连线(右栏连线详情)。
      const moved = p ? Math.hypot(p.x - cur.originX, p.y - cur.originY) : Infinity;
      if (moved < CLICK_SLOP) {
        if (cur.edgeKey) {
          const [upstream, downstream] = cur.edgeKey.split("->");
          selectOrchEdge(runId, upstream, downstream);
        }
        return; // 端口/手柄上的原地点击 = 无操作(取消)。
      }
      if (!run || target === null || target === cur.dragged) return; // 空点/原位 → 回弹
      const verdict = dropVerdict(run.tasks, cur.fixed, cur.dragged, target, cur.role);
      if (!verdict.ok) {
        const key: Record<Exclude<typeof verdict.reason, never>, string> = {
          self: t("orch.edge.dropSelf"),
          locked: t("orch.edge.dropLocked"),
          cycle: t("orch.edge.dropCycle"),
          depth: t("orch.edge.dropDepth", { n: 4 }),
          duplicate: t("orch.edge.dropDup"),
        };
        useToastStore.getState().push({ kind: "warning", title: key[verdict.reason] });
        return;
      }
      void commit(planEdgeMove(run.tasks, cur.fixed, cur.dragged, target, cur.role), run.id);
    },
    [innerPoint, taskAt, run, commit, t, selectOrchEdge, runId],
  );

  // Esc 取消拖拽(回弹)。
  useEffect(() => {
    if (!drag) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setDrag(null);
        dragRef.current = null;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drag]);

  /** 边是否锁定(任一端不可编辑 → 整条边不可拖,但 hover 提示仍可见)。 */
  const edgeLocked = useCallback(
    (upstream: string, downstream: string): boolean => {
      if (!run) return true;
      const u = run.tasks.find((x) => x.id === upstream);
      const d = run.tasks.find((x) => x.id === downstream);
      return !u || !d || !taskEditable(u) || !taskEditable(d);
    },
    [run],
  );

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
    // 有选中节点 → 新任务作为它的下级(deps=[选中节点],布局自动落到
    // 下一层);无选中 → 自由任务(原行为)。依赖加在新任务身上,不改动
    // 选中节点,所以选中节点是否可编辑/已完成都无所谓(依赖已满足即就绪)。
    const parent = selectedNodeId;
    void api.orch
      .addTasks({
        runId: run.id,
        tasks: [
          {
            id: `n${Date.now().toString(36)}`,
            spec: goal || t("orch.node.spec"),
            deps: parent ? [parent] : [],
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

  /* 拖拽中的橡皮筋:role 决定锚定端在哪个口 —— downstream(拖箭头端):
   * 锚在 fixed 右缘(输出),自由端吸附 hover 左缘(输入);upstream(拖
   * 尾巴端):镜像,锚在 fixed 左缘,自由端吸附 hover 右缘。边始终从
   * 上游画到下游(左 → 右)。 */
  const dragGeom = (() => {
    if (!drag) return null;
    const a = layout.pos.get(drag.fixed);
    const h = drag.hover ? layout.pos.get(drag.hover) : undefined;
    if (!a) return null;
    const fxLeft = { x: a.x - 4, y: a.y + NODE_H / 2 };
    const fxRight = { x: a.x + NODE_W, y: a.y + NODE_H / 2 };
    const hLeft = h ? { x: h.x - 4, y: h.y + NODE_H / 2 } : null;
    const hRight = h ? { x: h.x + NODE_W, y: h.y + NODE_H / 2 } : null;
    if (drag.role === "downstream") {
      return { x1: fxRight.x, y1: fxRight.y, x2: hLeft?.x ?? drag.x, y2: hLeft?.y ?? drag.y };
    }
    return { x1: hRight?.x ?? drag.x, y1: hRight?.y ?? drag.y, x2: fxLeft.x, y2: fxLeft.y };
  })();
  const dragTargetOk = drag?.hover ? verdicts.get(drag.hover)?.ok === true : false;

  return (
    <div
      className="orch-canvas"
      data-orch-canvas-run={run.id}
      onContextMenu={(e) => {
        // 画布有自己的交互体系(拖线改依赖 / 点击选中 → 右栏详情):
        // 右键节点不再冒泡到消息流的上下文菜单,也不弹浏览器默认菜单。
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {/* ── 头部:标题 / 状态 / 统计 / 控制 ── */}
      <div className="oc-head">
        <span className="oc-title" title={goal}>
          {goal.length > 30 ? `${goal.slice(0, 30)}…` : goal || run.title}
        </span>
        {statusChip()}
        <span className="oc-stats">
          {/* 只留任务进度;并发/预算字样已随「不限并发」移除(调度器不再设
              并发上限,run.concurrency 仅存于数据形态)。 */}
          {t("orch.canvas.stats", { done: doneCount, total: run.tasks.length })}
        </span>
        <div className="oc-actions">
          {isElectron && (
            <button
              className="oc-btn"
              title={selectedNodeId ? t("orch.canvas.addChild") : undefined}
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
        data-dragging={drag ? "1" : undefined}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={(e) => {
          // 指针离开画布 = 悬空松手,统一走回弹(onPointerUp 的 null 分支)。
          if (dragRef.current) onPointerUp(e);
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains("oc-inner")) {
            selectOrchNode(run.id, null);
          }
        }}
      >
        <div className="oc-inner" ref={innerRef} style={{ width: layout.width, height: layout.height }}>
          <svg className="oc-edges" width={layout.width} height={layout.height}>
            <defs>
              <marker id={`oc-arw-${run.id}`} viewBox="0 0 8 8" refX={7} refY={4} markerWidth={7} markerHeight={7} orient="auto">
                <path d="M0 0L8 4L0 8z" fill="currentColor" />
              </marker>
            </defs>
            {run.tasks.flatMap((task) =>
              task.deps.map((dep) => {
                const g = edgeGeometry(layout.pos, dep, task.id);
                if (!g) return null;
                const edgeKey = `${dep}->${task.id}`;
                const upstreamDone = taskById(dep)?.status === "completed";
                const cls = task.status === "completed" ? "done" : upstreamDone ? "flow" : "";
                const locked = edgeLocked(dep, task.id);
                const hovered = hoverEdge === edgeKey && !drag && !locked && !committing;
                // 被抓的边:渲染成半透明残影(橡皮筋是权威)。改接中旧边
                // (fixed→dragged)按 role 两端比对。
                const isDraggedEdge =
                  drag != null &&
                  drag.dragged !== drag.fixed &&
                  ((drag.role === "downstream" && task.id === drag.dragged && dep === drag.fixed) ||
                    (drag.role === "upstream" && dep === drag.dragged && task.id === drag.fixed));
                // 端点手柄位置(锚定端不动,拖动端跟橡皮筋)。
                const midX = (g.x1 + g.x2) / 2;
                const midY = (g.y1 + g.y2) / 2;
                return (
                  <g key={edgeKey} className={cn("oc-edge-g", hovered && "hovered", locked && "locked")}>
                    {/* 命中热区:粗透明描边路径(14px),可见线在下层。 */}
                    <path
                      className={cn("oc-edge-hit", locked && "locked")}
                      d={edgePath(g)}
                      onPointerEnter={() => !drag && setHoverEdge(edgeKey)}
                      onPointerLeave={() => setHoverEdge((c) => (c === edgeKey ? null : c))}
                      onPointerDown={(e) => {
                        if (committing) return;
                        e.preventDefault();
                        (e.target as Element).releasePointerCapture?.(e.pointerId);
                        const p = innerPoint(e.clientX, e.clientY);
                        if (!p) return;
                        // 锁定的边不可拖,但点击仍选中(右栏详情里给出
                        // 锁定原因 + 禁用删除)。
                        if (locked) {
                          selectOrchEdge(runId, dep, task.id);
                          return;
                        }
                        // 抓靠近哪端就 detach 哪端:中点分界。抓箭头端 =
                        // 改这条边的下游归属;抓尾巴端 = 改上游。
                        const nearDownstream =
                          Math.abs(p.x - g.x2) + Math.abs(p.y - g.y2) < Math.abs(p.x - g.x1) + Math.abs(p.y - g.y1);
                        const next: DragState = nearDownstream
                          ? { fixed: dep, dragged: task.id, role: "downstream", hover: task.id, x: p.x, y: p.y, originX: p.x, originY: p.y, edgeKey }
                          : { fixed: task.id, dragged: dep, role: "upstream", hover: dep, x: p.x, y: p.y, originX: p.x, originY: p.y, edgeKey };
                        dragRef.current = next;
                        setDrag(next);
                      }}
                    />
                    {/* 可见线。选中态(accent)优先级最高,拖拽残影次之。 */}
                    <path
                      className={cn(
                        "oc-edge",
                        cls,
                        selectedEdge?.upstream === dep && selectedEdge?.downstream === task.id && "selected",
                        hovered && "hovered",
                        locked && "locked",
                        isDraggedEdge && "ghost",
                      )}
                      d={edgePath(g)}
                      markerEnd={`url(#oc-arw-${run.id})`}
                    />
                    {hovered && (
                      <>
                        {/* 两端手柄 + 中点删除钮。尾巴端(上游):拖它换上游。 */}
                        <circle
                          className="oc-edge-handle"
                          cx={g.x1}
                          cy={g.y1}
                          r={5}
                          onPointerDown={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            const next: DragState = {
                              fixed: task.id,
                              dragged: dep,
                              role: "upstream",
                              hover: dep,
                              x: g.x1,
                              y: g.y1,
                              originX: g.x1,
                              originY: g.y1,
                            };
                            dragRef.current = next;
                            setDrag(next);
                          }}
                        />
                        {/* 箭头端(下游):拖它换下游归属。 */}
                        <circle
                          className="oc-edge-handle"
                          cx={g.x2}
                          cy={g.y2}
                          r={5}
                          onPointerDown={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            const next: DragState = {
                              fixed: dep,
                              dragged: task.id,
                              role: "downstream",
                              hover: task.id,
                              x: g.x2,
                              y: g.y2,
                              originX: g.x2,
                              originY: g.y2,
                            };
                            dragRef.current = next;
                            setDrag(next);
                          }}
                        />
                        <g
                          className="oc-edge-del"
                          transform={`translate(${midX}, ${midY})`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setHoverEdge(null);
                            void commit(planEdgeDelete(run.tasks, dep, task.id), run.id);
                          }}
                        >
                          <circle r={8} />
                          <path d="M-3.2,-3.2 L3.2,3.2 M3.2,-3.2 L-3.2,3.2" />
                        </g>
                      </>
                    )}
                  </g>
                );
              }),
            )}
            {/* 橡皮筋(拖拽中的预览边)。 */}
            {dragGeom && (
              <path
                className={cn("oc-edge-rubber", dragTargetOk ? "ok" : "no")}
                d={edgePath(dragGeom)}
                markerEnd={`url(#oc-arw-${run.id})`}
              />
            )}
          </svg>
          {run.tasks.map((task) => {
            const a = layout.pos.get(task.id);
            if (!a) return null;
            const p = profileOf(task);
            const elapsed = taskElapsed(task, now);
            const verdict = drag ? verdicts.get(task.id) : undefined;
            const isDragSelf = drag?.dragged === task.id && drag.dragged !== drag.fixed;
            const dimmed = drag != null && !verdict?.ok && !isDragSelf;
            const lit = drag != null && verdict?.ok === true && !isDragSelf;
            const editableTask = taskEditable(task);
            const showPorts = editableTask && !committing && (drag != null || hoverEdge != null || hoverNode === task.id);
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
                  dimmed && "oc-drop-dim",
                  lit && "oc-drop-ok",
                  drag?.hover === task.id && "oc-drop-hover",
                  !drag && "oc-node-anim",
                )}
                style={{ left: a.x, top: a.y, width: NODE_W }}
                onPointerEnter={() => !drag && setHoverNode(task.id)}
                onPointerLeave={() => setHoverNode((c) => (c === task.id ? null : c))}
                onClick={(e) => {
                  e.stopPropagation();
                  selectOrchNode(run.id, task.id);
                }}
              >
                {/* 连接端口:悬停节点/边或拖拽中浮现;可拉出新依赖
                 * (out 口 = 本节点当上游;in 口 = 本节点当下游)。 */}
                {showPorts && (
                  <>
                    <span
                      className="oc-port oc-port-in"
                      title={t("orch.canvas.hint")}
                      onPointerDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const pt = innerPoint(e.clientX, e.clientY);
                        if (!pt) return;
                        const next: DragState = {
                          fixed: task.id,
                          dragged: task.id,
                          role: "upstream",
                          hover: task.id,
                          x: pt.x,
                          y: pt.y,
                          originX: pt.x,
                          originY: pt.y,
                        };
                        dragRef.current = next;
                        setDrag(next);
                      }}
                    />
                    <span
                      className="oc-port oc-port-out"
                      onPointerDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const pt = innerPoint(e.clientX, e.clientY);
                        if (!pt) return;
                        const next: DragState = {
                          fixed: task.id,
                          dragged: task.id,
                          role: "downstream",
                          hover: task.id,
                          x: pt.x,
                          y: pt.y,
                          originX: pt.x,
                          originY: pt.y,
                        };
                        dragRef.current = next;
                        setDrag(next);
                      }}
                    />
                  </>
                )}
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
              title={selectedNodeId ? t("orch.canvas.addChild") : undefined}
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

      {/* ── 内联 worker 控制台:运行中的 agent 任务实时输出(过程可观测) ── */}
      {(() => {
        const active = run.tasks.filter(
          (x) => (x.status === "running" || x.status === "dispatched") && x.runner === "agent",
        );
        if (active.length === 0) return null;
        return (
          <div className="oc-consoles">
            <div className="oc-consoles-label">{t("orch.console.title")}</div>
            {active.map((task) => {
              const d = task.dispatches[task.dispatches.length - 1];
              // 键带 dispatchId:重试/重跑产生新派发时控制台重挂(旧桶内容不再残留)。
              return <OrchWorkerConsole key={`${task.id}:${d?.dispatchId ?? "none"}`} task={task} />;
            })}
          </div>
        );
      })()}

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
        <span className="oc-hint" title={t("orch.edge.hint")}>
          {t("orch.canvas.hint")}
        </span>
      </div>
    </div>
  );
}
