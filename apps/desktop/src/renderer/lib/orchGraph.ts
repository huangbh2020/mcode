/**
 * 画布拖线编辑的纯函数层(无 React、无 IO)—— 逻辑唯一风险区,从组件
 * 拆出以便冒烟直接驱动。
 *
 * 语义与 main 侧 taskStore.validateTaskGraph / OrchestratorService.
 * updateTask 的门禁对齐(后端仍是权威);这里的拦截只为体验:让非法落点
 * 在松手之前就被标出来,而不是拖完才挨骂。
 *
 * 边的语义:A → B 表示「B 依赖 A」——箭头端是 B(下游),尾巴端是 A。
 *
 * 拖拽会话由三元组 + 角色描述:
 *  - fixed:   锚定端(不动的那头)所在任务;
 *  - dragged: 拖动端原本连接的任务(从端口拉新线时 === fixed);
 *  - target:  拖动端要落到的任务;
 *  - role:    拖动端扮演的角色 —— "downstream"(抓的是箭头端,最终边
 *             target 依赖 fixed)或 "upstream"(抓的是尾巴端,最终边
 *             fixed 依赖 target)。锚定端的角色由此相反。
 */

import type { TaskNode } from "@contracts/orchestration";

/** 与 main 侧 MAX_DAG_DEPTH 同值(复制而非导入:main 模块不能进 renderer 包)。 */
export const MAX_DAG_DEPTH = 4;

/** 节点是否可编辑依赖(镜像 OrchestratorService.updateTask 的门禁;
 *  completed 是硬终态、dispatched/running 行内状态正被调度器消费)。 */
export function taskEditable(t: TaskNode): boolean {
  return (
    t.status === "pending" ||
    t.status === "blocked" ||
    t.status === "canceled" ||
    t.status === "paused" ||
    t.status === "failed"
  );
}

export type DraggedEnd = "downstream" | "upstream";

export type DropVerdict =
  | { ok: true }
  | { ok: false; reason: "locked" | "cycle" | "depth" | "duplicate" | "self" };

/** 应用拖拽后的最终 deps 副本(role 感知;新建线 dragged===fixed 无旧边可删)。 */
function applyEdge(tasks: TaskNode[], fixed: string, dragged: string, target: string, role: DraggedEnd) {
  if (role === "upstream") {
    // 最终边 target→fixed:fixed 的 deps 换血(摘 dragged、补 target),单任务原子变更。
    return tasks.map((t) => {
      if (t.id !== fixed) return t;
      const base = dragged !== fixed ? t.deps.filter((d) => d !== dragged) : t.deps;
      return { ...t, deps: base.includes(target) ? base : [...base, target] };
    });
  }
  // 最终边 fixed→target:target 加 dep fixed;旧边 fixed→dragged 摘除。
  return tasks.map((t) => {
    if (t.id === target && !t.deps.includes(fixed)) return { ...t, deps: [...t.deps, fixed] };
    if (t.id === dragged && dragged !== fixed && dragged !== target && t.deps.includes(fixed)) {
      return { ...t, deps: t.deps.filter((d) => d !== fixed) };
    }
    return t;
  });
}

/**
 * 拖拽落点合法性:把「最终边」应用到 tasks 副本上判定。
 * 可编辑性只要求**将被写库的任务**:
 *  - downstream 改接:target(加 dep)与 dragged(删 dep);
 *  - upstream 改接:仅 fixed(换血);target 只是被引用,不写库
 *    (把新上游指到已完成任务上是合法且有价值的:依赖立即满足)。
 */
export function dropVerdict(
  tasks: TaskNode[],
  fixed: string,
  dragged: string,
  target: string,
  role: DraggedEnd,
): DropVerdict {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const fixedTask = byId.get(fixed);
  const targetTask = byId.get(target);
  const draggedTask = byId.get(dragged);
  if (!fixedTask || !targetTask || !draggedTask) return { ok: false, reason: "locked" };

  if (target === fixed) return { ok: false, reason: "self" };

  if (role === "upstream") {
    if (!taskEditable(fixedTask)) return { ok: false, reason: "locked" };
    // 重复:最终边已存在(且不是拖回原位的 no-op)。
    if (target !== dragged && fixedTask.deps.includes(target)) return { ok: false, reason: "duplicate" };
    // 成环:fixed 的传递下游里出现 target(fixed⇝target 加 target→fixed 闭环)。
    // 旧边 dragged→fixed 指向 fixed,不在 fixed 出发的任何路径上,原图判定即安全。
    if (reaches(tasks, fixed, target)) return { ok: false, reason: "cycle" };
  } else {
    if (!taskEditable(targetTask)) return { ok: false, reason: "locked" };
    const rewiresOld = dragged !== fixed && draggedTask.deps.includes(fixed);
    if (rewiresOld && !taskEditable(draggedTask)) return { ok: false, reason: "locked" };
    if (target !== dragged && targetTask.deps.includes(fixed)) return { ok: false, reason: "duplicate" };
    // 成环:target 的传递下游里出现 fixed(加 fixed→target 闭环)。旧边
    // fixed→dragged 从 fixed 出发,不在进入 fixed 的路径上,原图判定即安全。
    if (reaches(tasks, target, fixed)) return { ok: false, reason: "cycle" };
  }

  // 深度:应用最终边后全图重算(镜像 validateTaskGraph 口径 —— 任一节点
  // 超限即拒绝,不是只看落点链)。
  if (maxDepth(applyEdge(tasks, fixed, dragged, target, role)) > MAX_DAG_DEPTH) {
    return { ok: false, reason: "depth" };
  }
  return { ok: true };
}

/** from 的传递下游里是否含 to(沿 deps 反向遍历:B deps A ⇒ A 的下游含 B)。 */
function reaches(tasks: TaskNode[], from: string, to: string): boolean {
  const byDep = new Map<string, string[]>();
  for (const t of tasks) {
    for (const d of t.deps) {
      const list = byDep.get(d);
      if (list) list.push(t.id);
      else byDep.set(d, [t.id]);
    }
  }
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    for (const nxt of byDep.get(cur) ?? []) {
      if (nxt === to) return true;
      if (!seen.has(nxt)) {
        seen.add(nxt);
        stack.push(nxt);
      }
    }
  }
  return false;
}

/** 全图最大依赖深度(叶子=1;与 validateTaskGraph 的 depthOf 同口径)。 */
function maxDepth(tasks: { id: string; deps: string[] }[]): number {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const memo = new Map<string, number>();
  const depthOf = (id: string): number => {
    const hit = memo.get(id);
    if (hit !== undefined) return hit;
    const t = byId.get(id);
    const d = t && t.deps.length > 0 ? 1 + Math.max(...t.deps.map(depthOf)) : 1;
    memo.set(id, d);
    return d;
  };
  let max = 0;
  for (const t of tasks) max = Math.max(max, depthOf(t.id));
  return max;
}

/* ── 提交计划:一次手势 = 0..2 次 updateTask 调用,带失败回滚 ── */

export interface DepsMutation {
  taskId: string;
  deps: string[];
}

export interface CommitPlan {
  /** 按序执行的变更(空 = 无操作,如落点即原位)。 */
  mutations: DepsMutation[];
  /** 回滚序列(已成功步骤的原 deps,逆序执行)。 */
  rollback: DepsMutation[];
}

/**
 * 把拖拽编译成最小提交序列。
 *  - upstream 改接:fixed 的 deps 原子换血 —— 单次 updateTask;
 *  - downstream 改接:两次调用,**先删后加** —— 删边只会缩短链,中间态
 *    永不超深(先加的话,落点悬挂在旧链下方时合法的最终态会被中间态
 *    深度校验误拒);最终深度已在 dropVerdict 预检;
 *  - 从端口新建(dragged === fixed):仅加 dep 一次;
 *  - 落回原位(target === dragged):无操作。
 */
export function planEdgeMove(
  tasks: TaskNode[],
  fixed: string,
  dragged: string,
  target: string,
  role: DraggedEnd,
): CommitPlan {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  if (target === dragged) return { mutations: [], rollback: [] };

  if (role === "upstream") {
    const fixedTask = byId.get(fixed);
    if (!fixedTask) return { mutations: [], rollback: [] };
    const base = dragged !== fixed ? fixedTask.deps.filter((d) => d !== dragged) : fixedTask.deps;
    const deps = base.includes(target) ? base : [...base, target];
    if (deps.join("\u0000") === fixedTask.deps.join("\u0000")) return { mutations: [], rollback: [] };
    return {
      mutations: [{ taskId: fixed, deps }],
      rollback: [{ taskId: fixed, deps: fixedTask.deps }],
    };
  }

  const targetTask = byId.get(target);
  const draggedTask = byId.get(dragged);
  const mutations: DepsMutation[] = [];
  const rollback: DepsMutation[] = [];
  // 先删:旧边 fixed→dragged。
  if (draggedTask && dragged !== fixed && draggedTask.deps.includes(fixed)) {
    mutations.push({ taskId: dragged, deps: draggedTask.deps.filter((d) => d !== fixed) });
    rollback.push({ taskId: dragged, deps: draggedTask.deps });
  }
  // 后加:新边 fixed→target。
  if (targetTask && !targetTask.deps.includes(fixed)) {
    mutations.push({ taskId: target, deps: [...targetTask.deps, fixed] });
    rollback.push({ taskId: target, deps: targetTask.deps });
  }
  return { mutations, rollback };
}

/** 删除一条依赖边(downstream 依赖 upstream)→ 单次 updateTask。 */
export function planEdgeDelete(tasks: TaskNode[], upstream: string, downstream: string): CommitPlan {
  const d = tasks.find((t) => t.id === downstream);
  if (!d || !d.deps.includes(upstream)) return { mutations: [], rollback: [] };
  return {
    mutations: [{ taskId: downstream, deps: d.deps.filter((x) => x !== upstream) }],
    rollback: [{ taskId: downstream, deps: d.deps }],
  };
}
