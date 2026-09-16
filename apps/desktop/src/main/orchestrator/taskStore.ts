/**
 * 任务表纯函数:DAG 校验 / 就绪计算 / 深度与并发约束。
 *
 * 无副作用、无 IO —— 运行纪律(熔断/重试/波次派发)的状态机部分集中在
 * 这里,OrchestratorService 负责副作用(持久化/派发/事件)。
 */
import type { OrchestrationRun, TaskNode, TaskStatus } from "@contracts/orchestration";

/** DAG 深度上限(运行纪律:深度 ≤ 4)。 */
export const MAX_DAG_DEPTH = 4;

/** 同任务连续失败熔断阈值。 */
export const BREAKER_LIMIT = 3;

/** task 的全部传递下游(直接 + 间接,沿 deps 反向边)。 */
export function downstreamTasks(tasks: TaskNode[], taskId: string): TaskNode[] {
  const byDep = new Map<string, string[]>();
  for (const t of tasks) {
    for (const d of t.deps) {
      const list = byDep.get(d);
      if (list) list.push(t.id);
      else byDep.set(d, [t.id]);
    }
  }
  const seen = new Set<string>();
  const stack = [taskId];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    for (const nxt of byDep.get(cur) ?? []) {
      if (!seen.has(nxt)) {
        seen.add(nxt);
        stack.push(nxt);
      }
    }
  }
  return tasks.filter((t) => seen.has(t.id));
}


/** 终态集合:进入任一状态后不再被调度器触碰。 */
const TERMINAL: ReadonlySet<TaskStatus> = new Set([
  "completed",
  "failed",
  "blocked",
  "canceled",
  "superseded",
]);

export function isTerminal(t: TaskNode): boolean {
  return TERMINAL.has(t.status);
}

/** 任务图校验:未知依赖 / 自依赖 / 环 / 深度超限。返回错误列表(空 = 通过)。 */
export function validateTaskGraph(
  tasks: { id: string; deps: string[] }[],
): string[] {
  const errors: string[] = [];
  const ids = new Set(tasks.map((t) => t.id));
  for (const t of tasks) {
    for (const d of t.deps) {
      if (!ids.has(d)) errors.push(`任务 ${t.id} 依赖不存在的任务 ${d}`);
      if (d === t.id) errors.push(`任务 ${t.id} 不能依赖自身`);
    }
  }
  // 环检测:DFS 三色标记。
  const color = new Map<string, 1 | 2>(); // 1 = in-stack, 2 = done
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const visit = (id: string, stack: string[]): boolean => {
    const c = color.get(id);
    if (c === 2) return false;
    if (c === 1) {
      errors.push(`依赖成环:${[...stack, id].join(" → ")}`);
      return true;
    }
    color.set(id, 1);
    for (const d of byId.get(id)?.deps ?? []) {
      if (visit(d, [...stack, id])) {
        color.set(id, 2);
        return true;
      }
    }
    color.set(id, 2);
    return false;
  };
  for (const t of tasks) visit(t.id, []);

  // 深度检查(无环前提下才有效)。
  if (errors.length === 0) {
    const depth = new Map<string, number>();
    const depthOf = (id: string): number => {
      const memo = depth.get(id);
      if (memo !== undefined) return memo;
      const t = byId.get(id);
      const d = t && t.deps.length > 0 ? 1 + Math.max(...t.deps.map(depthOf)) : 1;
      depth.set(id, d);
      return d;
    };
    for (const t of tasks) {
      const d = depthOf(t.id);
      if (d > MAX_DAG_DEPTH) errors.push(`任务 ${t.id} 的依赖深度为 ${d},超过上限 ${MAX_DAG_DEPTH}`);
    }
  }
  return errors;
}

/** 就绪任务:依赖全部 completed、自身 pending。(review 打回重做等场景
 *  会把任务重置回 pending,复用同一条路径。) */
export function readyTasks(run: OrchestrationRun): TaskNode[] {
  const byId = new Map(run.tasks.map((t) => [t.id, t]));
  return run.tasks.filter((t) => {
    if (t.status !== "pending") return false;
    return t.deps.every((d) => byId.get(d)?.status === "completed");
  });
}

/** 活跃任务数(dispatched/running)—— 并发上限的占用计数。 */
export function activeCount(run: OrchestrationRun): number {
  return run.tasks.filter((t) => t.status === "dispatched" || t.status === "running").length;
}

/** run 是否全部收尾(无活跃、无就绪、无 pending)。 */
export function runSettled(run: OrchestrationRun): boolean {
  return !run.tasks.some((t) => t.status === "pending" || t.status === "ready" || t.status === "dispatched" || t.status === "running");
}

/** 从任务简报文本粗估 token(展示用启发式:字符数 × 2,下限 2k)。 */
export function estimateTokens(spec: string): number {
  return Math.max(2000, Math.ceil(spec.length * 2));
}
