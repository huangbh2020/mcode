/**
 * 事件驱动阻塞等待(check-wait 语义,非轮询)。
 *
 * - waitForTasks(runId, taskIds, timeoutMs):所有目标任务进入终态,或
 *   超时到达 —— 超时是**检查点不是失败**,返回当时的任务快照,调用方
 *   (协调者工具/服务)自行决定继续等或介入。
 * - 心跳判定:活动流有输出只说明活着;完成只看 worker_done(服务侧从
 *   turn.done 推导)。这里只提供等待原语。
 */
import type { OrchestrationRun, TaskNode } from "@contracts/orchestration";

interface Waiter {
  runId: string;
  taskIds: Set<string>;
  resolve: (tasks: TaskNode[] | null) => void;
  timer: NodeJS.Timeout;
}

const waiters = new Set<Waiter>();

/** 等待一组任务终态。run 消失(删除)时以 null resolve。 */
export function waitForTasks(
  runId: string,
  taskIds: string[],
  timeoutMs: number,
): Promise<TaskNode[] | null> {
  return new Promise((resolve) => {
    const waiter: Waiter = {
      runId,
      taskIds: new Set(taskIds),
      resolve,
      timer: setTimeout(() => {
        waiters.delete(waiter);
        // 超时 = 检查点:以当前快照 resolve(调用方再读一次 run)。
        resolve(latestSnapshot(waiter));
      }, timeoutMs),
    };
    waiters.add(waiter);
  });
}

/** 服务在任务进入终态时调用:释放满足条件的等待者。 */
export function notifyTaskTerminal(run: OrchestrationRun): void {
  const terminalIds = new Set(run.tasks.filter((t) => isTerminalStatus(t.status)).map((t) => t.id));
  for (const w of [...waiters]) {
    if (w.runId !== run.id) continue;
    const satisfied = [...w.taskIds].every((id) => terminalIds.has(id));
    if (satisfied) {
      clearTimeout(w.timer);
      waiters.delete(w);
      w.resolve(run.tasks.filter((t) => w.taskIds.has(t.id)));
    }
  }
}

/** run 被删除时以 null 释放其全部等待者。 */
export function notifyRunDeleted(runId: string): void {
  for (const w of [...waiters]) {
    if (w.runId === runId) {
      clearTimeout(w.timer);
      waiters.delete(w);
      w.resolve(null);
    }
  }
}

function isTerminalStatus(s: TaskNode["status"]): boolean {
  return (
    s === "completed" || s === "failed" || s === "blocked" || s === "canceled" || s === "superseded"
  );
}

type SnapshotProvider = (runId: string) => OrchestrationRun | undefined;
let snapshotProvider: SnapshotProvider | null = null;

/** 服务注册 run 快照读取器(超时检查点用)。 */
export function bindSnapshotProvider(fn: SnapshotProvider): void {
  snapshotProvider = fn;
}

function latestSnapshot(waiter: Waiter): TaskNode[] | null {
  const run = snapshotProvider?.(waiter.runId);
  if (!run) return null;
  return run.tasks.filter((t) => waiter.taskIds.has(t.id));
}/** 应用退出时清空等待者(以 null resolve,防止悬挂 promise)。 */
export function disposeWaiters(): void {
  for (const w of [...waiters]) {
    clearTimeout(w.timer);
    w.resolve(null);
  }
  waiters.clear();
}
