/**
 * 编排域 IPC 处理器(RPC):角色管理 / 设置 / run 创建与控制 / gate 解决 /
 * worktree merge-back / 完全移交 / worker 会话查询 / 模板。
 *
 * 自动拆解不在这里 —— 它已改为会话内回合(orchestration 标记 +
 * orchestrator/planTool.ts 的 orch_submit_plan 工具),不再有无头 RPC。
 *
 * 全部经 contracts 的 zod schema 校验(安全边界),业务收敛在
 * OrchestratorService 单例里。
 */
import type { IpcMain } from "electron";
import {
  IPC,
  OrchCreateRunSchema,
  OrchListRunsSchema,
  OrchGetRunSchema,
  OrchRunControlSchema,
  OrchTaskControlSchema,
  OrchUpdateTaskSchema,
  OrchAddTasksSchema,
  OrchRemoveTaskSchema,
  OrchResolveGateSchema,
  OrchMergeTaskSchema,
  OrchHandoffSchema,
  OrchWorkerSessionSchema,
  OrchSettingsSaveSchema,
} from "@contracts/ipc";
import { orchestrator } from "@main/orchestrator/OrchestratorService.js";
import { SessionRepo, ProjectRepo } from "@main/store/repositories.js";
import { runtimeManager } from "@main/claude/RuntimeManager.js";
import { createOrReuseSession } from "@main/lib/sessionStart.js";
import { resolveSessionCwd } from "@main/lib/sessionCwd.js";
import { log } from "@main/lib/logger.js";


export function registerOrchestratorHandlers(ipcMain: IpcMain): void {
  /** Ensure the service (runs load + boot reconcile + observer) is up before
   *  any state-mutating call — start() is idempotent and resolves instantly
   *  after the boot pass. */
  const ready = () => orchestrator.start();

  /* ── 设置 ── */
  ipcMain.handle(IPC.ORCH_GET_SETTINGS, () => ({ settings: orchestrator.getSettings() }));
  ipcMain.handle(IPC.ORCH_SAVE_SETTINGS, (_evt, raw) => {
    const input = OrchSettingsSaveSchema.parse(raw);
    return { settings: orchestrator.saveSettings(input.settings) };
  });

  /* ── Run 生命周期 ── */
  ipcMain.handle(IPC.ORCH_CREATE_RUN, async (_evt, raw) => {
    await ready();
    const input = OrchCreateRunSchema.parse(raw);
    const res = orchestrator.createRun({
      parentSessionId: input.sessionId,
      projectId: sessionIdToProject(input.sessionId),
      title: input.title,
      goal: input.goal,
      tasks: input.tasks,
      budgetUsd: input.budgetUsd ?? null,
      concurrency: input.concurrency,
      worktreePolicy: input.worktreePolicy,
      autoStart: input.autoStart,
    });
    if ("error" in res) throw new Error(res.error);
    return { run: res.run };
  });
  ipcMain.handle(IPC.ORCH_LIST_RUNS, async (_evt, raw) => {
    const input = OrchListRunsSchema.parse(raw);
    await ready(); // 幂等;首帧早于启动钩子时兜底
    return { runs: orchestrator.listRuns(input.sessionId) };
  });
  ipcMain.handle(IPC.ORCH_GET_RUN, async (_evt, raw) => {
    await ready();
    const input = OrchGetRunSchema.parse(raw);
    return { run: orchestrator.getRun(input.runId) ?? null };
  });
  ipcMain.handle(IPC.ORCH_RUN_CONTROL, async (_evt, raw) => {
    await ready();
    const input = OrchRunControlSchema.parse(raw);
    const res = orchestrator.runControl(input.runId, input.action);
    if (res.error) throw new Error(res.error);
    return { run: res.run ?? null };
  });
  ipcMain.handle(IPC.ORCH_TASK_CONTROL, async (_evt, raw) => {
    await ready();
    const input = OrchTaskControlSchema.parse(raw);
    const res = orchestrator.taskControl(input.runId, input.taskId, input.action);
    if (res.error) throw new Error(res.error);
    return { run: res.run ?? null };
  });
  ipcMain.handle(IPC.ORCH_UPDATE_TASK, async (_evt, raw) => {
    await ready();
    const input = OrchUpdateTaskSchema.parse(raw);
    const res = orchestrator.updateTask(input.runId, input.taskId, {
      spec: input.spec,
      deps: input.deps,
      customModelId: input.customModelId,
      providerId: input.providerId,
      model: input.model,
      effort: input.effort,
      permissionMode: input.permissionMode,
    });
    if (res.error) throw new Error(res.error);
    return { run: res.run ?? null };
  });
  ipcMain.handle(IPC.ORCH_ADD_TASKS, async (_evt, raw) => {
    await ready();
    const input = OrchAddTasksSchema.parse(raw);
    const res = orchestrator.addTasks(input.runId, input.tasks);
    if (res.error) throw new Error(res.error);
    return { run: res.run ?? null };
  });
  ipcMain.handle(IPC.ORCH_REMOVE_TASK, async (_evt, raw) => {
    await ready();
    const input = OrchRemoveTaskSchema.parse(raw);
    const res = orchestrator.removeTask(input.runId, input.taskId);
    if (res.error) throw new Error(res.error);
    return { run: res.run ?? null };
  });
  ipcMain.handle(IPC.ORCH_RESOLVE_GATE, async (_evt, raw) => {
    await ready();
    const input = OrchResolveGateSchema.parse(raw);
    const res = orchestrator.resolveGate(input.runId, input.gateId, input.resolution);
    if (res.error) throw new Error(res.error);
    return { run: res.run ?? null };
  });
  ipcMain.handle(IPC.ORCH_MERGE_TASK, async (_evt, raw) => {
    const input = OrchMergeTaskSchema.parse(raw);
    return orchestrator.mergeTask(input.runId, input.taskId);
  });

  /* ── 完全移交(Handoff):普通新会话 + 简报,不建任务行、不追踪 ── */
  ipcMain.handle(IPC.ORCH_HANDOFF, async (_evt, raw) => {
    const input = OrchHandoffSchema.parse(raw);
    // 继承来源会话的执行配置 —— 与 worker 派发同款:customModelId 不带的话
    // 第三方网关用户的新会话落官方 OAuth,首轮即 /login。
    const from = input.fromSessionId ? SessionRepo.get(input.fromSessionId) : undefined;
    const { session } = createOrReuseSession(
      {
        projectId: input.projectId,
        title: input.title ?? `${input.briefing.slice(0, 36)}${input.briefing.length > 36 ? "…" : ""}`,
        providerId: from?.providerId,
        model: from?.model,
        effort: from?.effort ?? "default",
        permissionMode: from?.permissionMode ?? "default",
        customModelId: from?.customModelId ?? undefined,
        kind: "chat",
        // 移交不绑 worktree 意图 —— 需要时用户在那个会话里自己开。
      },
      "desktop",
    );
    // 立即发送简报首轮(移交 = 一次性转移,原会话不再监控)。
    const project = ProjectRepo.get(session.projectId);
    if (!project) throw new Error(`project not found: ${session.projectId}`);
    SessionRepo.updateStatus(session.id, "running");
    const cwd = await resolveSessionCwd(session, project);
    runtimeManager.bindSession(session);
    await runtimeManager.sendTurn(session, {
      prompt: [
        "【任务移交简报】",
        input.briefing,
        input.fromSessionId ? `(由会话 ${input.fromSessionId} 移交)` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
      cwd,
    });
    log.info(`orch handoff: session ${session.id} created from ${input.fromSessionId ?? "?"}`);
    return { session };
  });

  /* ── worker 会话行(面板打开 transcript) ── */
  ipcMain.handle(IPC.ORCH_WORKER_SESSION, (_evt, raw) => {
    const input = OrchWorkerSessionSchema.parse(raw);
    return { session: orchestrator.workerSession(input.sessionId) };
  });

  /* ── 自动拆解(原 orch.proposePlan / orch.abortPlan)已退役 ──
   *  拆解改为会话内回合:composer 的自动编排开关 → 普通发送(orchestration
   *  标记),main 在该回合注入规划者提示 + orch_submit_plan 工具,见
   *  orchestrator/planTool.ts。无头 query()、planner.delta 流与单独的中止
   *  通道随之删除 —— 会话回合的中断/审批/历史全部复用普通回合管线。 */
}


function sessionIdToProject(sessionId: string): string {
  const session = SessionRepo.get(sessionId);
  if (!session) throw new Error(`session not found: ${sessionId}`);
  return session.projectId;
}
