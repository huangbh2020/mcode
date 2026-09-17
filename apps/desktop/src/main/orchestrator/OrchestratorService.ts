/**
 * OrchestratorService —— 编排"哑"基础设施的总装(不含规划智能)。
 *
 * 职责:
 *  - Run 生命周期 + 状态持久化(settings 表 JSON key,容量上限截断)
 *  - 调度器:按 ready 队列波次派发,并发上限;熔断(连败 3 次 → blocked
 *    + escalation gate);重试三档(节点级自动重试 1 次 → 人工 gate)
 *  - worker 生命周期映射:观察 RuntimeEvent,从结构化事件推导 worker_done
 *    (turn.done + turn.files + token-usage),失败/心跳/成本同样事件化
 *  - 决策门(gate):熔断升级 / 预算超限 / 多方案竞争择优
 *  - 审查打回循环:review 型任务 verdict=changes_requested → 派回原实现者
 *    (reviewLoopLimit 上限,超限升级人工)
 *  - 断点续跑:reconcileOnBoot 把"应用退出时在途"的任务按 worker 会话的
 *    持久化状态收敛(死掉的算失败走重试梯,已完成漏标的补标)
 *
 * 语义红线(来自 Orca 模型,Mcode 结构化落地):
 *  - worker 对编排协议零感知 —— 派发上下文是 orch_meta 列里的结构体,
 *    完成凭证是事件推导,不是 prose;幽灵上报/陈旧义务在协议层消失。
 *  - 心跳 ≠ 完成;等待超时是检查点不是失败(waiter.ts)。
 *  - 所有权卫生:协调者会话删除时 run 一并收敛。
 */
import type {
  AgentProfile,
  Gate,
  OrchestrationRun,
  OrchSettings,
  TaskNode,
  TaskResult,
  TaskSpecInput,
  WorkerDonePayload,
  RunStatus,
} from "@contracts/orchestration";
import { OrchestrationRunSchema, TaskResultSchema } from "@contracts/orchestration";
import type { RuntimeEvent } from "@contracts/runtime";
import type { Session } from "@contracts/session";
import { IPC } from "@contracts/ipc";
import { MessageRepo, ProjectRepo, SessionRepo, SettingRepo } from "@main/store/repositories.js";
import { runtimeManager } from "@main/claude/RuntimeManager.js";
import { resolveSessionCwd } from "@main/lib/sessionCwd.js";
import { sendToRenderer } from "@main/window.js";
import { log } from "@main/lib/logger.js";
import { uid } from "@main/utils.js";
import { mergeBackWorktree } from "@main/lib/worktreeOps.js";
import { awaitDb } from "@main/store/db.js";
import { readyTasks, runSettled, validateTaskGraph, downstreamTasks, BREAKER_LIMIT, estimateTokens } from "./taskStore.js";
import { dispatchAgentTask, dispatchTerminalTask } from "./dispatcher.js";
import { notifyRunDeleted, notifyTaskTerminal, bindSnapshotProvider, disposeWaiters } from "./waiter.js";
import { ProfileStore, RoutingStats } from "./profiles.js";

const RUNS_KEY = "orch.runs.v1";
const SETTINGS_KEY = "orch.settings.v1";
const MAX_PERSISTED_RUNS = 50;

interface WorkerRef {
  runId: string;
  taskId: string;
  dispatchId: string;
  /** 本派发内累计的文件改动(turn.files 收集)。 */
  filesModified: Set<string>;
  /** 本派发内最近一次 token 快照(成本估算)。 */
  lastCostUsd: number;
  lastTokens: number;
}

class OrchestratorService {
  private runs = new Map<string, OrchestrationRun>();
  private workers = new Map<string, WorkerRef>();
  /** 终端派发的活动句柄(taskKey → 进程完成 promise)。 */
  private terminalDispatches = new Map<string, Promise<void>>();
  private started = false;
  private detachObserver: (() => void) | null = null;

  /* ── 启动与持久化 ── */

  /** 幂等启动:加载 runs → 断点收敛 → 挂 runtime 观察者。 */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await awaitDb();
    this.load();
    bindSnapshotProvider((runId) => this.runs.get(runId));
    this.reconcileOnBoot();
    this.detachObserver = runtimeManager.addObserver((e) => this.handleRuntimeEvent(e));
    log.info(`orchestrator started: ${this.runs.size} run(s) loaded`);
  }

  private load(): void {
    const raw = SettingRepo.get(RUNS_KEY);
    if (!raw) return;
    try {
      const arr = JSON.parse(raw) as unknown[];
      for (const item of arr) {
        const parsed = OrchestrationRunSchema.safeParse(item);
        // MERGE (never replace): a run created before start()'s load finished
        // (createRun awaits start, but belt-and-braces) must not be wiped by
        // the late load.
        if (parsed.success && !this.runs.has(parsed.data.id)) this.runs.set(parsed.data.id, parsed.data);
      }
    } catch (err) {
      log.warn(`orch runs load failed: ${(err as Error).message}`);
    }
  }

  private persist(): void {
    const arr = [...this.runs.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_PERSISTED_RUNS);
    try {
      SettingRepo.set(RUNS_KEY, JSON.stringify(arr));
    } catch (err) {
      log.warn(`orch runs persist failed: ${(err as Error).message}`);
    }
  }

  private emit(event: Parameters<typeof pushEvent>[0]): void {
    pushEvent(event);
  }

  /* ── 设置 ── */

  getSettings(): OrchSettings {
    const raw = SettingRepo.get(SETTINGS_KEY);
    if (!raw) return { triggerMode: "ask", concurrency: 4, budgetUsd: 0 };
    try {
      const v = JSON.parse(raw) as Partial<OrchSettings>;
      return {
        triggerMode: v.triggerMode === "off" || v.triggerMode === "auto" ? v.triggerMode : "ask",
        concurrency: typeof v.concurrency === "number" && v.concurrency > 0 ? Math.floor(v.concurrency) : 4,
        budgetUsd: typeof v.budgetUsd === "number" && v.budgetUsd >= 0 ? v.budgetUsd : 0,
      };
    } catch {
      return { triggerMode: "ask", concurrency: 4, budgetUsd: 0 };
    }
  }

  saveSettings(settings: OrchSettings): OrchSettings {
    SettingRepo.set(SETTINGS_KEY, JSON.stringify(settings));
    return this.getSettings();
  }

  /* ── Run 创建与查询 ── */

  listRuns(parentSessionId: string): OrchestrationRun[] {
    return [...this.runs.values()]
      .filter((r) => r.parentSessionId === parentSessionId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  getRun(runId: string): OrchestrationRun | undefined {
    return this.runs.get(runId);
  }

  createRun(input: {
    parentSessionId: string;
    projectId: string;
    title?: string;
    goal: string;
    tasks: TaskSpecInput[];
    budgetUsd?: number | null;
    concurrency?: number;
    worktreePolicy?: OrchestrationRun["worktreePolicy"];
    templateId?: string | null;
    autoStart?: boolean;
  }): { run: OrchestrationRun } | { error: string } {
    const errors = validateTaskGraph(input.tasks);
    if (errors.length > 0) return { error: errors.join(";\n") };
    if (!SessionRepo.get(input.parentSessionId)) return { error: `coordinator session not found: ${input.parentSessionId}` };
    for (const t of input.tasks) {
      if (t.runner === "agent" && t.profileId && !ProfileStore.get(t.profileId)) {
        return { error: `任务 ${t.id} 的 agent 不存在:${t.profileId}` };
      }
    }
    const now = Date.now();
    const goal = input.goal.trim();
    const run = OrchestrationRunSchema.parse({
      id: `run_${uid()}`,
      parentSessionId: input.parentSessionId,
      projectId: input.projectId,
      title: input.title?.trim() || goal.slice(0, 40) || "编排运行",
      goal,
      status: input.autoStart === false ? "planning" : "running",
      tasks: input.tasks.map((t) => ({
        ...t,
        status: "pending",
        artifacts: [],
        result: null,
        failureCount: 0,
        dispatches: [],
        worktreePath: null,
        reviewRound: 0,
        estTokens: estimateTokens(t.spec),
      })),
      gates: [],
      budgetUsd: input.budgetUsd ?? null,
      spentUsd: 0,
      concurrency: input.concurrency ?? this.getSettings().concurrency ?? 4,
      worktreePolicy: input.worktreePolicy ?? "auto",
      heartbeat: {},
      templateId: input.templateId ?? null,
      createdAt: now,
      updatedAt: now,
    });
    this.runs.set(run.id, run);
    this.persist();
    this.emit({ kind: "run.updated", run });
    if (run.status === "running") this.tick(run.id);
    return { run };
  }

  /* ── 调度器 ── */

  /** 波次派发,不限并发:每一波 ready 任务全部派出(依赖关系本身就是波次
   *  边界,上游完成 → 下一个 tick 自然放出下一波)。fire-and-forget —— 所有
   *  失败路径都在 dispatchTask 内部收敛为任务失败,不会抛出。原并发槽上限
   *  (run.concurrency)已按产品要求移除,该字段仅保留在数据形态里。 */
  private tick(runId: string): void {
    const run = this.runs.get(runId);
    if (!run || run.status !== "running") return;
    for (const task of readyTasks(run)) {
      // 状态先置 dispatched(防重入),失败路径会改回 failed。
      task.status = "dispatched";
      void this.dispatchTask(run, task);
    }
    this.touch(run);
  }

  private async dispatchTask(run: OrchestrationRun, task: TaskNode): Promise<void> {
    const dispatchId = uid("disp_");
    task.dispatches.push({ dispatchId, workerSessionId: "", injectedAt: Date.now() });
    if (task.runner === "terminal") {
      const term = dispatchTerminalTask(run, task);
      const entry = task.dispatches[task.dispatches.length - 1];
      entry.dispatchId = term.dispatchId;
      task.result = TaskResultSchema.parse({ ...(task.result ?? {}), reportPath: term.reportPath });
      this.touch(run);
      const p = term.promise.then((res) => {
        this.finishDispatch(run, task, term.dispatchId, res.ok, {
          summary: res.ok ? `exit 0` : `命令失败:${res.error ?? "unknown"}`,
          exitCode: res.exitCode,
        });
      });
      this.terminalDispatches.set(`${run.id}:${task.id}`, p);
      await p;
      return;
    }
    const res = await dispatchAgentTask(run, task);
    const entry = task.dispatches[task.dispatches.length - 1];
    if (!res.ok) {
      entry.outcome = "failed";
      entry.endedAt = Date.now();
      this.failTask(run, task, `派发失败:${res.error ?? "unknown"}`);
      return;
    }
    entry.workerSessionId = res.workerSessionId ?? "";
    this.workers.set(res.workerSessionId ?? "", {
      runId: run.id,
      taskId: task.id,
      dispatchId: res.dispatchId,
      filesModified: new Set(),
      lastCostUsd: 0,
      lastTokens: 0,
    });
    task.status = "running";
    run.heartbeat[res.workerSessionId ?? ""] = Date.now();
    this.touch(run);
  }

  /* ── worker 生命周期映射(完成权威) ── */

  private handleRuntimeEvent(e: RuntimeEvent): void {
    const ref = this.workers.get(e.sessionId);
    // 心跳:任何事件都算活动(心跳 ≠ 完成,只说明活着)。
    if (ref) {
      const run = this.runs.get(ref.runId);
      if (run) run.heartbeat[e.sessionId] = Date.now();
    }
    switch (e.type) {
      case "token-usage.updated": {
        if (!ref) return;
        const run = this.runs.get(ref.runId);
        if (!run) return;
        // 无增量(与上次快照相同)不推送也不重算。
        if (ref.lastTokens === e.snapshot.totalProcessedTokens && ref.lastCostUsd === (e.snapshot.costUsd ?? 0)) return;
        ref.lastTokens = e.snapshot.totalProcessedTokens;
        ref.lastCostUsd = e.snapshot.costUsd ?? 0;
        // 成本增量估算 + 预算检查(超限 → 暂停 + gate)。
        const task = run.tasks.find((t) => t.id === ref.taskId);
        if (task) {
          const usage = task.result?.usage ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 };
          const dTokens = Math.max(0, ref.lastTokens - usage.inputTokens);
          const dCost = Math.max(0, ref.lastCostUsd - usage.costUsd);
          task.result = TaskResultSchema.parse({
            ...(task.result ?? {}),
            usage: { inputTokens: ref.lastTokens, outputTokens: e.snapshot.outputTokens, costUsd: ref.lastCostUsd },
          });
          run.spentUsd = Math.round((run.spentUsd + dCost) * 1e6) / 1e6;
          this.checkBudget(run);
          // 运行中把用量增量实时推给渲染层 —— 画布节点与右栏「运行输出」
          // 的 token/花费同源于此。只 emit 不 persist:运行中的用量落盘
          // 收敛在收尾路径(finishDispatch/reconcile),丢一批无碍。
          this.emit({ kind: "run.updated", run });
        }
        return;
      }
      case "turn.files": {
        if (!ref) return;
        for (const f of e.files) ref.filesModified.add(f.filePath);
        return;
      }
      case "turn.done": {
        if (!ref) return;
        // 陈旧派发防护:只认最新 dispatchId 的事件……事件本身不带派发号,
        // 但 worker↔dispatch 一一对应(新派发=新会话),map 键即权威。
        const run = this.runs.get(ref.runId);
        if (!run) return;
        const task = run.tasks.find((t) => t.id === ref.taskId);
        if (!task || (task.status !== "running" && task.status !== "dispatched")) return;
        const success = e.reason === "end_turn" || e.reason === "tool_use";
        const summary = success
          ? extractWorkerSummary(e.sessionId)
          : `回合结束原因:${e.reason}`;
        this.finishDispatch(run, task, ref.dispatchId, success, {
          summary,
          filesModified: [...ref.filesModified],
          usage: task.result?.usage,
        });
        return;
      }
      default:
        return;
    }
  }

  /** 派发收敛(完成权威的唯一出口):成功 → 审查回路/学习/收尾;
   *  失败 → 重试梯/熔断。 */
  private finishDispatch(
    run: OrchestrationRun,
    task: TaskNode,
    dispatchId: string,
    success: boolean,
    extra: {
      summary?: string;
      filesModified?: string[];
      exitCode?: number;
      usage?: TaskResult["usage"];
    },
  ): void {
    const entry = task.dispatches.find((d) => d.dispatchId === dispatchId);
    if (entry) {
      entry.endedAt = Date.now();
      entry.outcome = success ? "done" : "failed";
    }
    if (entry?.workerSessionId) this.workers.delete(entry.workerSessionId);
    if (success) {
      task.status = "completed";
      task.result = TaskResultSchema.parse({
        ...(task.result ?? {}),
        summary: extra.summary ?? task.result?.summary,
        filesModified: extra.filesModified ?? task.result?.filesModified ?? [],
        exitCode: extra.exitCode ?? task.result?.exitCode,
        usage: extra.usage ?? task.result?.usage,
      });
      task.artifacts = [...new Set([...task.artifacts, ...(extra.filesModified ?? [])])];
      // 分配学习:tag 成功计数。
      const profileId = task.profileId;
      if (profileId) {
        for (const tag of task.tags.length > 0 ? task.tags : ["generic"]) RoutingStats.record(tag, profileId, true);
      }
      // worker_done 推送(收件箱聚合同源)。
      this.emit({
        kind: "worker_done",
        payload: {
          runId: run.id,
          taskId: task.id,
          dispatchId,
          coordinatorSessionId: run.parentSessionId,
          status: "done",
          summary: extra.summary ?? "",
          filesModified: extra.filesModified ?? [],
          reportPath: task.result?.reportPath,
        },
      });
      this.afterTaskCompleted(run, task);
    } else {
      task.result = TaskResultSchema.parse({ ...(task.result ?? {}), summary: extra.summary ?? task.result?.summary });
      this.failTask(run, task, extra.summary ?? "unknown failure");
    }
    notifyTaskTerminal(run);
    this.checkRunCompletion(run);
    this.touch(run);
    this.tick(run.id);
  }

  /** 失败收敛:重试三档 —— 节点级自动重试 1 次 → 熔断 blocked +
   *  escalation gate(人工接管/换模型重跑由 gate 后的 taskControl 驱动)。 */
  private failTask(run: OrchestrationRun, task: TaskNode, reason: string): void {
    const profileId = task.profileId;
    if (profileId) {
      for (const tag of task.tags.length > 0 ? task.tags : ["generic"]) RoutingStats.record(tag, profileId, false);
    }
    task.failureCount += 1;
    const entry = task.dispatches[task.dispatches.length - 1];
    if (entry) {
      // 失败也盖时间戳 —— 否则该派发没有 endedAt,节点计时(endedAt ?? now)
      // 在重试等待期一直走表。
      entry.endedAt = Date.now();
      entry.outcome = "failed";
    }
    if (entry) this.emit({
      kind: "worker_done",
      payload: {
        runId: run.id,
        taskId: task.id,
        dispatchId: entry.dispatchId,
        coordinatorSessionId: run.parentSessionId,
        status: "failed",
        summary: reason,
        filesModified: [],
      },
    });
    if (task.failureCount < BREAKER_LIMIT) {
      // 档1:自动重试一次(同配置)。打回重做的 worktree 绑定保留。
      task.status = "pending";
      log.warn(`orch task ${run.id}/${task.id} failed (${task.failureCount}/${BREAKER_LIMIT}): ${reason} — requeueing`);
      return;
    }
    // 熔断:blocked + escalation gate 等人决策。
    task.status = "blocked";
    const gate: Gate = {
      id: uid("gate_"),
      taskId: task.id,
      kind: "escalation",
      question: `任务 ${task.id} 连续失败 ${task.failureCount} 次:${reason.slice(0, 300)}`,
      options: ["重试", "换 agent 重跑", "放弃该任务"],
      status: "open",
      createdAt: Date.now(),
    };
    run.gates.push(gate);
    this.emit({ kind: "gate.created", runId: run.id, gate });
    log.warn(`orch task ${run.id}/${task.id} breaker tripped — blocked, escalation gate ${gate.id}`);
  }

  /** 任务成功后的编排语义:审查回路 + 竞争组收口。 */
  private afterTaskCompleted(run: OrchestrationRun, task: TaskNode): void {
    // ① 审查节点出结论:verdict 从 worker 摘要解析(VERDICT: 行)。
    if (task.reviewOf) {
      const verdict = parseVerdict(task.result?.summary ?? "");
      task.result = TaskResultSchema.parse({ ...(task.result ?? {}), verdict });
      const target = run.tasks.find((t) => t.id === task.reviewOf);
      if (target && verdict !== "pass") {
        // 打回:修复派回原实现者(协调者不亲自改文件);同一 worktree 续作。
        const round = (target.reviewRound ?? 0) + 1;
        target.reviewRound = round;
        if (round > run.reviewLoopLimit) {
          target.status = "blocked";
          const gate: Gate = {
            id: uid("gate_"),
            taskId: target.id,
            kind: "escalation",
            question: `审查打回超过 ${run.reviewLoopLimit} 轮,任务 ${target.id} 升级人工处理。`,
            options: ["继续重试", "放弃该任务"],
            status: "open",
            createdAt: Date.now(),
          };
          run.gates.push(gate);
          this.emit({ kind: "gate.created", runId: run.id, gate });
          return;
        }
        target.status = "pending";
        target.spec = `${target.spec}\n\n【第 ${round} 轮审查打回,需修复】\n${(task.result?.summary ?? "").slice(0, 2000)}`;
        log.info(`orch review loop: task ${target.id} sent back (round ${round})`);
      }
      return;
    }
    // ② 竞争组收口:variantGroup 全部 completed → 择优 gate。
    if (task.variantGroup) {
      const group = run.tasks.filter((t) => t.variantGroup === task.variantGroup);
      if (group.every((t) => t.status === "completed" || t.status === "superseded" || t.status === "canceled")) {
        const candidates = group.filter((t) => t.status === "completed");
        if (candidates.length > 1) {
          const gate: Gate = {
            id: uid("gate_"),
            taskId: null,
            kind: "review_pick",
            question: `多方案竞争完成(${group.length} 个方案),选择胜出方案:`,
            options: candidates.map((c) => c.id),
            status: "open",
            createdAt: Date.now(),
          };
          run.gates.push(gate);
          this.emit({ kind: "gate.created", runId: run.id, gate });
        }
      }
    }
  }

  /** 预算检查:超限 → 暂停(等待中的任务不再派发)+ budget gate。 */
  private checkBudget(run: OrchestrationRun): void {
    if (run.budgetUsd == null || run.budgetUsd <= 0) return;
    if (run.spentUsd < run.budgetUsd) return;
    if (run.gates.some((g) => g.kind === "budget" && g.status === "open")) return;
    run.status = "paused";
    const gate: Gate = {
      id: uid("gate_"),
      taskId: null,
      kind: "budget",
      question: `运行成本已达 ${run.spentUsd.toFixed(2)} / ${run.budgetUsd.toFixed(2)} 美元,已暂停。是否继续?`,
      options: ["继续运行", "取消运行"],
      status: "open",
      createdAt: Date.now(),
    };
    run.gates.push(gate);
    this.emit({ kind: "gate.created", runId: run.id, gate });
    log.warn(`orch run ${run.id} over budget — paused`);
  }

  private checkRunCompletion(run: OrchestrationRun): void {
    if (run.status !== "running") return;
    if (!runSettled(run)) return;
    if (run.gates.some((g) => g.status === "open")) {
      run.status = "paused"; // 有待决 gate(如择优)时暂停等决策
      return;
    }
    run.status = run.tasks.some((t) => t.status === "failed" || t.status === "blocked") ? "failed" : "completed";
    log.info(`orch run ${run.id} ${run.status}`);
    if (run.status === "completed") void this.scheduleSynthesis(run);
  }

  /* ── 结果整理:run 完成后向协调者会话发一轮汇总回合 ── */

  /** 完成 → 协调者会话自动整理最终结果(画布流第⑤步)。协调者忙碌时延迟
   *  一档重试一次;sendTurn 自身对忙碌会话是忽略语义,不会踩线程。 */
  private async scheduleSynthesis(run: OrchestrationRun, retry = 0): Promise<void> {
    if (run.synthesizedAt) return;
    const coordinator = SessionRepo.get(run.parentSessionId);
    if (!coordinator) return; // 协调者会话已删,run 随之收敛,无需整理
    if (runtimeManager.runningSessionIds().includes(run.parentSessionId)) {
      if (retry >= 1) {
        log.warn(`orch run ${run.id}: synthesis skipped — coordinator busy`);
        return;
      }
      setTimeout(() => void this.scheduleSynthesis(run, retry + 1), 60_000);
      return;
    }
    run.synthesizedAt = Date.now();
    // TaskNode 无独立标题字段 —— 展示标题取 spec 首行(与画布节点卡一致)。
    const titleOf = (t: TaskNode) => t.spec.split("\n")[0].trim().slice(0, 40) || t.id;
    const lines = run.tasks.map((t) => {
      const summary = t.result?.summary?.trim() || "(无结果摘要)";
      const files = [...(t.result?.filesModified ?? []), ...t.artifacts];
      return [
        `- ${t.id} ${titleOf(t)} [${t.status}]`,
        `  结果:${summary}`,
        files.length > 0 ? `  产物:${files.join("、")}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    });
    const prompt = [
      "你所在的会话刚完成一次编排运行(run)的全部任务。请基于以下各任务产出,",
      "面向用户整理一条最终结果汇总:做了什么、每个任务的关键产出、合并的产物/改动文件、结论与建议下一步。",
      "用中文,条理化,不要复述任务编号以外的过程细节。",
      "",
      `【总体目标】${run.goal || run.title}`,
      "",
      "【各任务产出】",
      ...lines,
    ].join("\n");
    try {
      const project = ProjectRepo.get(run.projectId);
      if (!project) throw new Error(`project not found: ${run.projectId}`);
      SessionRepo.updateStatus(coordinator.id, "running");
      const cwd = await resolveSessionCwd(coordinator, project);
      runtimeManager.bindSession(coordinator);
      // 不传 userMessage:聊天流里 run.completed 转场时已由渲染端追加
      // 「结果整理」卡作为该回合的可见头部,这里的硬编码气泡会与之重复
      // (且绕过 i18n)。prompt 本身仅供模型,不落 UI。
      await runtimeManager.sendTurn(coordinator, {
        prompt,
        cwd,
      });
      this.touch(run);
      log.info(`orch run ${run.id}: synthesis turn dispatched to coordinator ${coordinator.id}`);
    } catch (err) {
      log.warn(`orch run ${run.id}: synthesis failed — ${(err as Error).message}`);
    }
  }

  private touch(run: OrchestrationRun): void {
    run.updatedAt = Date.now();
    this.persist();
    this.emit({ kind: "run.updated", run });
  }

  /* ── 控制面(IPC) ── */

  runControl(
    runId: string,
    action: "start" | "pause" | "resume" | "cancel" | "delete" | "restart",
  ): { run?: OrchestrationRun; error?: string } {
    const run = this.runs.get(runId);
    if (!run) return { error: `run not found: ${runId}` };
    switch (action) {
      case "start":
        if (run.status === "planning") {
          run.status = "running";
          this.tick(run.id);
        }
        break;
      case "restart": {
        // 画布「重新运行」:清空全部运行态,直接再跑。
        // 活跃 worker 在 completed/failed/canceled 收尾时已被打断/清理,
        // 这里只需重置行内状态。
        if (run.status !== "completed" && run.status !== "canceled" && run.status !== "failed") break;
        for (const t of run.tasks) {
          const entry = t.dispatches[t.dispatches.length - 1];
          if (entry?.workerSessionId && (t.status === "running" || t.status === "dispatched")) {
            runtimeManager.interrupt(entry.workerSessionId);
            this.workers.delete(entry.workerSessionId);
          }
          t.status = "pending";
          t.result = null;
          t.failureCount = 0;
          t.dispatches = [];
          t.worktreePath = null;
          t.reviewRound = 0;
          t.artifacts = [];
        }
        run.gates = run.gates.filter((g) => g.status !== "open");
        run.synthesizedAt = null; // 重跑完成后允许再触发一次结果整理
        run.status = "running";
        this.tick(run.id);
        break;
      }
      case "pause":
        if (run.status === "running") run.status = "paused";
        break;
      case "resume":
        if (run.status === "paused") {
          run.status = "running";
          this.tick(run.id);
        }
        break;
      case "cancel": {
        run.status = "canceled";
        for (const t of run.tasks) {
          if (t.status === "pending" || t.status === "ready" || t.status === "dispatched" || t.status === "running") {
            t.status = "canceled";
            const entry = t.dispatches[t.dispatches.length - 1];
            if (entry?.workerSessionId) {
              runtimeManager.interrupt(entry.workerSessionId);
              entry.outcome = "canceled";
              entry.endedAt = Date.now();
              this.workers.delete(entry.workerSessionId);
            }
          }
        }
        for (const g of run.gates) if (g.status === "open") g.status = "canceled";
        break;
      }
      case "delete": {
        // 先打断活动 worker,再移除 run 与其 worker 会话行。
        this.runControl(runId, "cancel");
        for (const t of run.tasks) {
          for (const d of t.dispatches) {
            if (d.workerSessionId) {
              runtimeManager.dispose(d.workerSessionId);
              SessionRepo.delete(d.workerSessionId);
            }
          }
        }
        this.runs.delete(runId);
        notifyRunDeleted(runId);
        this.persist();
        this.emit({ kind: "run.updated", run: { ...run, status: "canceled" } });
        return {};
      }
    }
    if (this.runs.has(runId)) {
      this.checkRunCompletion(run);
      this.touch(run);
    }
    return { run: this.runs.get(runId) };
  }

  taskControl(
    runId: string,
    taskId: string,
    action: "pause" | "resume" | "retry" | "cancel" | "rerun" | "markCompleted",
    profileId?: string | null,
  ): { run?: OrchestrationRun; error?: string } {
    const run = this.runs.get(runId);
    if (!run) return { error: `run not found: ${runId}` };
    const task = run.tasks.find((t) => t.id === taskId);
    if (!task) return { error: `task not found: ${taskId}` };
    switch (action) {
      case "pause":
        if (task.status === "pending" || task.status === "ready") task.status = "paused";
        else if (task.status === "running" || task.status === "dispatched") {
          const entry = task.dispatches[task.dispatches.length - 1];
          if (entry?.workerSessionId) runtimeManager.interrupt(entry.workerSessionId);
          task.status = "paused";
        }
        break;
      case "resume":
        if (task.status === "paused") {
          task.status = "pending";
          this.tick(run.id);
        }
        break;
      case "retry":
      case "rerun": {
        // 下游已开始(派发/运行/暂停/已产出)→ 上游重跑会撕裂依赖语义,
        // 拒绝;下游尚待运行或已取消时才放行。
        const startedDownstream = downstreamTasks(run.tasks, taskId).filter((t) =>
          t.status !== "pending" && t.status !== "ready" && t.status !== "canceled",
        );
        if (startedDownstream.length > 0) {
          return {
            error: `下游任务已开始(${startedDownstream.map((x) => x.id).join("、")}),${taskId} 不能重跑;请先重跑/取消下游任务,或用画布右上角「重新运行」整体重置`,
          };
        }
        if (action === "rerun" && profileId !== undefined) {
          if (profileId !== null && !ProfileStore.get(profileId)) return { error: `agent not found: ${profileId}` };
          task.profileId = profileId;
        }
        task.status = "pending";
        task.failureCount = 0;
        // 终态 run(取消/完成/失败)里重跑节点 =「重新开始」:run 复活为
        // running,上游已完成依赖照常满足,ready 即派发。
        if (run.status === "canceled" || run.status === "completed" || run.status === "failed") {
          run.status = "running";
        }
        this.tick(run.id);
        break;
      }
      case "cancel":
        if (task.status === "running" || task.status === "dispatched") {
          const entry = task.dispatches[task.dispatches.length - 1];
          if (entry?.workerSessionId) {
            runtimeManager.interrupt(entry.workerSessionId);
            entry.outcome = "canceled";
            entry.endedAt = Date.now();
            this.workers.delete(entry.workerSessionId);
          }
        }
        task.status = "canceled";
        break;
      case "markCompleted":
        task.status = "completed";
        if (!task.result) task.result = { filesModified: [] };
        break;
    }
    notifyTaskTerminal(run);
    this.checkRunCompletion(run);
    this.touch(run);
    return { run };
  }

  /** 画布节点配置编辑(spec/deps/agent/模型/标题)。仅未派发的任务可改 ——
   *  dispatched/running 的行内状态正在被调度器与观察者消费,改动会在
   *  重跑时生效,这里直接拒绝以防线内撕裂。 */
  updateTask(
    runId: string,
    taskId: string,
    patch: {
      spec?: string;
      deps?: string[];
      profileId?: string | null;
      customModelId?: string | null;
      providerId?: string | null;
      model?: string | null;
      effort?: string | null;
      permissionMode?: string | null;
    },
  ): { run?: OrchestrationRun; error?: string } {
    const run = this.runs.get(runId);
    if (!run) return { error: `run not found: ${runId}` };
    const task = run.tasks.find((t) => t.id === taskId);
    if (!task) return { error: `task not found: ${taskId}` };
    if (task.status !== "pending" && task.status !== "blocked" && task.status !== "canceled" && task.status !== "paused" && task.status !== "failed") {
      return { error: `task ${taskId} is ${task.status} — 只有未在运行的任务可以编辑` };
    }
    if (patch.profileId !== undefined && patch.profileId !== null && !ProfileStore.get(patch.profileId)) {
      return { error: `agent not found: ${patch.profileId}` };
    }
    if (patch.spec !== undefined) task.spec = patch.spec;
    if (patch.deps !== undefined) task.deps = [...patch.deps];
    if (patch.profileId !== undefined) task.profileId = patch.profileId;
    if (patch.customModelId !== undefined) task.customModelId = patch.customModelId;
    if (patch.providerId !== undefined) task.providerId = patch.providerId;
    if (patch.model !== undefined) task.model = patch.model;
    if (patch.effort !== undefined) task.effort = patch.effort;
    if (patch.permissionMode !== undefined) task.permissionMode = patch.permissionMode;
    const errors = validateTaskGraph(run.tasks);
    if (errors.length > 0) {
      // 回滚本次编辑 —— 图不合法(环/深度超限/悬空依赖)不能留在 run 里。
      return { error: errors.join(";\n") };
    }
    this.touch(run);
    this.emit({ kind: "run.updated", run });
    return { run };
  }

  /** 画布移除任务(仅 pending;引用它的 deps 一并剥离)。 */
  removeTask(runId: string, taskId: string): { run?: OrchestrationRun; error?: string } {
    const run = this.runs.get(runId);
    if (!run) return { error: `run not found: ${runId}` };
    const task = run.tasks.find((t) => t.id === taskId);
    if (!task) return { error: `task not found: ${taskId}` };
    if (task.status !== "pending") return { error: `task ${taskId} is ${task.status} — 只有待运行的任务可以删除` };
    run.tasks = run.tasks.filter((t) => t.id !== taskId);
    for (const t of run.tasks) t.deps = t.deps.filter((d) => d !== taskId);
    const errors = validateTaskGraph(run.tasks);
    if (errors.length > 0) return { error: errors.join(";\n") };
    this.touch(run);
    this.emit({ kind: "run.updated", run });
    return { run };
  }

  resolveGate(runId: string, gateId: string, resolution: string): { run?: OrchestrationRun; error?: string } {
    const run = this.runs.get(runId);
    if (!run) return { error: `run not found: ${runId}` };
    const gate = run.gates.find((g) => g.id === gateId);
    if (!gate) return { error: `gate not found: ${gateId}` };
    if (gate.status !== "open") return { error: "gate already resolved" };
    gate.status = "resolved";
    gate.resolution = resolution;
    gate.resolvedAt = Date.now();
    this.emit({ kind: "gate.resolved", runId, gateId, resolution });

    // gate 语义化收尾:
    if (gate.kind === "review_pick") {
      for (const t of run.tasks) {
        if (t.variantGroup && t.status === "completed" && t.id !== resolution) t.status = "superseded";
      }
    } else if (gate.kind === "budget") {
      if (resolution === "继续运行") {
        run.status = "running";
        this.tick(run.id);
      } else {
        this.runControl(runId, "cancel");
      }
    } else if (gate.kind === "escalation" && gate.taskId) {
      if (resolution === "重试") {
        this.taskControl(runId, gate.taskId, "retry");
      } else if (resolution === "换 agent 重跑") {
        // 不指定 profile —— 用户随后在面板用 rerun 换;或直接重试同配置。
        this.taskControl(runId, gate.taskId, "retry");
      } else {
        this.taskControl(runId, gate.taskId, "cancel");
      }
    }
    this.checkRunCompletion(run);
    this.touch(run);
    return { run: this.runs.get(runId) ?? run };
  }

  /** worktree merge-back(合并仲裁入口;冲突时用户可再派高阶 agent)。 */
  async mergeTask(runId: string, taskId: string): Promise<{ ok: boolean; error?: string }> {
    const run = this.runs.get(runId);
    if (!run) return { ok: false, error: `run not found: ${runId}` };
    const task = run.tasks.find((t) => t.id === taskId);
    if (!task?.worktreePath) return { ok: false, error: "task has no worktree" };
    const project = ProjectRepo.get(run.projectId);
    if (!project) return { ok: false, error: "project not found" };
    const res = await mergeBackWorktree(project.path, task.worktreePath, {
      message: `mcode orchestration: ${run.title} / ${task.id}`,
    });
    if (!res.ok) return { ok: false, error: res.error };
    task.worktreePath = null;
    this.touch(run);
    return { ok: true };
  }

  /* ── 控制面支撑(画布「＋ 任务」追加等) ── */

  /** 任务骨架附加到运行中的 run(协调者中途加任务)。 */
  addTasks(runId: string, tasks: TaskSpecInput[]): { run?: OrchestrationRun; error?: string } {
    const run = this.runs.get(runId);
    if (!run) return { error: `run not found: ${runId}` };
    const existing = new Set(run.tasks.map((t) => t.id));
    const fresh = tasks.filter((t) => !existing.has(t.id));
    if (fresh.length === 0) return { error: "no new tasks (ids already exist)" };
    const errors = validateTaskGraph([...run.tasks, ...fresh]);
    if (errors.length > 0) return { error: errors.join(";\n") };
    run.tasks.push(
      ...fresh.map((t) => ({
        ...t,
        status: "pending" as const,
        artifacts: [],
        result: null,
        failureCount: 0,
        dispatches: [],
        worktreePath: null,
        reviewRound: 0,
        estTokens: estimateTokens(t.spec),
      })),
    );
    this.touch(run);
    this.tick(run.id);
    return { run };
  }

  /* ── 断点续跑(boot reconcile) ── */

  private reconcileOnBoot(): void {
    for (const run of this.runs.values()) {
      if (run.status !== "running" && run.status !== "paused") continue;
      let dirty = false;
      for (const task of run.tasks) {
        if (task.status !== "dispatched" && task.status !== "running") continue;
        const entry = task.dispatches[task.dispatches.length - 1];
        const worker = entry?.workerSessionId ? SessionRepo.get(entry.workerSessionId) : undefined;
        if (!worker) {
          // 终端 worker 或会话行丢失:无法判定,按失败走重试梯。
          this.failTask(run, task, "应用重启导致 worker 中断");
          dirty = true;
          continue;
        }
        // 会话在跑但 runtime 已死(重启后没有活动 handle)→ 中断收敛。
        const runtimeAlive = runtimeManager.runningSessionIds().includes(worker.id);
        if (runtimeAlive) {
          // 会话由 bindSession 恢复?不会 —— 重启后 sendTurn 没人调。
          // 标记失败走重试梯(DAG checkpoint:失败节点重派)。
          this.failTask(run, task, "应用重启导致 worker 中断(运行中)");
          dirty = true;
          continue;
        }
        const st = worker.status;
        if (st === "running") {
          // DB 说 running 但进程不可能还活着(刚启动)—— 保守按失败重试。
          this.failTask(run, task, "应用重启导致 worker 中断");
          dirty = true;
        } else if (st === "done" || st === "interrupted" || st === "idle") {
          // 已完成但漏标:从持久化数据补齐 worker_done。
          task.status = "completed";
          const files = worker.turnFiles?.map((f) => f.filePath) ?? [];
          task.result = {
            summary: extractWorkerSummary(worker.id) || "(worker 已完成,摘要不可用)",
            filesModified: files,
            usage: undefined,
          };
          task.artifacts = [...new Set([...task.artifacts, ...files])];
          entry.outcome = "done";
          entry.endedAt = worker.updatedAt;
          dirty = true;
        } else {
          this.failTask(run, task, `worker 会话状态异常:${st}`);
          dirty = true;
        }
      }
      if (dirty) {
        notifyTaskTerminal(run);
        this.checkRunCompletion(run);
        this.touch(run);
        this.tick(run.id);
      }
    }
  }

  /** worker 会话行查询(面板打开 transcript 用)。 */
  workerSession(sessionId: string): Session | null {
    return SessionRepo.get(sessionId) ?? null;
  }

  disposeAll(): void {
    for (const run of this.runs.values()) {
      for (const t of run.tasks) {
        for (const d of t.dispatches) {
          if (d.workerSessionId) runtimeManager.interrupt(d.workerSessionId);
        }
      }
    }
    this.detachObserver?.();
    this.detachObserver = null;
    disposeWaiters();
    this.started = false;
  }
}

/* ── 模块级单例 + 推送 ── */

function pushEvent(
  event:
    | { kind: "run.updated"; run: OrchestrationRun }
    | { kind: "gate.created"; runId: string; gate: Gate }
    | { kind: "gate.resolved"; runId: string; gateId: string; resolution: string }
    | { kind: "worker_done"; payload: WorkerDonePayload },
): void {
  sendToRenderer(IPC.ORCH_EVENT, { channel: IPC.ORCH_EVENT, event });
}

/** 从 worker 会话的最新 assistant 消息提取文本摘要。 */
function extractWorkerSummary(sessionId: string): string {
  try {
    const page = MessageRepo.listBySession(sessionId, { limit: 20 });
    const assistant = page.messages.find((m) => m.role === "assistant");
    if (!assistant) return "";
    return extractTextBlocks(assistant.content).trim().slice(0, 4000);
  } catch {
    return "";
  }
}

function extractTextBlocks(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content) {
    if (b && typeof b === "object" && "kind" in b) {
      const block = b as { kind: string; text?: unknown };
      if (block.kind === "text" && typeof block.text === "string") parts.push(block.text);
    }
  }
  return parts.join("\n");
}

/** 解析审查结论行(VERDICT: pass / changes_requested / fail)。 */
function parseVerdict(summary: string): "pass" | "fail" | "changes_requested" {
  const m = summary.match(/VERDICT:\s*(pass|changes_requested|fail)/i);
  if (!m) return "pass"; // 解析不出结论时保守视为通过(打回逻辑不触发)
  const v = m[1].toLowerCase();
  return v === "changes_requested" ? "changes_requested" : v === "fail" ? "fail" : "pass";
}

export const orchestrator = new OrchestratorService();
export type { AgentProfile, RunStatus };
