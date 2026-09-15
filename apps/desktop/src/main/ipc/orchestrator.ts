/**
 * 编排域 IPC 处理器(RPC):角色管理 / 设置 / run 创建与控制 / gate 解决 /
 * worktree merge-back / 完全移交 / worker 会话查询 / 模板 / 向导自动拆解。
 *
 * 全部经 contracts 的 zod schema 校验(安全边界),业务收敛在
 * OrchestratorService / ProfileStore / TemplateStore 单例里。
 */
import type { IpcMain } from "electron";
import {
  IPC,
  OrchAgentSaveSchema,
  OrchAgentDeleteSchema,
  OrchCreateRunSchema,
  OrchListRunsSchema,
  OrchRunControlSchema,
  OrchTaskControlSchema,
  OrchResolveGateSchema,
  OrchMergeTaskSchema,
  OrchHandoffSchema,
  OrchWorkerSessionSchema,
  OrchTemplateSaveSchema,
  OrchTemplateDeleteSchema,
  OrchProposePlanSchema,
  OrchSettingsSaveSchema,
} from "@contracts/ipc";
import { TaskSpecInputSchema } from "@contracts/orchestration";
import { orchestrator } from "@main/orchestrator/OrchestratorService.js";
import { ProfileStore } from "@main/orchestrator/profiles.js";
import { TemplateStore } from "@main/orchestrator/templates.js";
import { SessionRepo, ProjectRepo, MessageRepo } from "@main/store/repositories.js";
import { runtimeManager } from "@main/claude/RuntimeManager.js";
import { createOrReuseSession } from "@main/lib/sessionStart.js";
import { resolveSessionCwd } from "@main/lib/sessionCwd.js";
import { log } from "@main/lib/logger.js";
import { z } from "zod";

/** 向导「自动拆解」的提案 JSON 契约(模型输出,宽松解析 + 修复)。 */
const ProposalSchema = z.object({
  tasks: z
    .array(
      z.object({
        spec: z.string().min(1),
        deps: z.array(z.string()).optional(),
        profileId: z.string().nullable().optional(),
        tags: z.array(z.string()).optional(),
        reviewOf: z.string().nullable().optional(),
        variantGroup: z.string().nullable().optional(),
      }),
    )
    .min(1),
});

export function registerOrchestratorHandlers(ipcMain: IpcMain): void {
  /** Ensure the service (runs load + boot reconcile + observer) is up before
   *  any state-mutating call — start() is idempotent and resolves instantly
   *  after the boot pass. */
  const ready = () => orchestrator.start();

  /* ── 角色管理 ── */
  ipcMain.handle(IPC.ORCH_AGENT_LIST, () => ({ agents: ProfileStore.list() }));
  ipcMain.handle(IPC.ORCH_AGENT_SAVE, (_evt, raw) => {
    const input = OrchAgentSaveSchema.parse(raw);
    return { agents: ProfileStore.save(input.agent) };
  });
  ipcMain.handle(IPC.ORCH_AGENT_DELETE, (_evt, raw) => {
    const input = OrchAgentDeleteSchema.parse(raw);
    return { agents: ProfileStore.delete(input.id) };
  });

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
      templateId: input.templateId ?? null,
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
    const res = orchestrator.taskControl(input.runId, input.taskId, input.action, input.profileId);
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
    const profile = input.profileId ? ProfileStore.get(input.profileId) : undefined;
    const { session } = createOrReuseSession(
      {
        projectId: input.projectId,
        title: input.title ?? `${input.briefing.slice(0, 36)}${input.briefing.length > 36 ? "…" : ""}`,
        providerId: profile?.providerId,
        model: profile?.model,
        effort: profile?.effort ?? "default",
        permissionMode: profile?.permissionMode ?? "default",
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
        profile?.systemPrompt?.trim(),
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

  /* ── 模板 ── */
  ipcMain.handle(IPC.ORCH_TEMPLATES_LIST, () => ({ templates: TemplateStore.list() }));
  ipcMain.handle(IPC.ORCH_TEMPLATE_SAVE, (_evt, raw) => {
    const input = OrchTemplateSaveSchema.parse(raw);
    return { templates: TemplateStore.save(input.template) };
  });
  ipcMain.handle(IPC.ORCH_TEMPLATE_DELETE, (_evt, raw) => {
    const input = OrchTemplateDeleteSchema.parse(raw);
    return { templates: TemplateStore.delete(input.id) };
  });

  /* ── 向导自动拆解:side 会话跑一次规划,解析 JSON 提案 ── */
  ipcMain.handle(IPC.ORCH_PROPOSE_PLAN, async (_evt, raw) => {
    const input = OrchProposePlanSchema.parse(raw);
    const coordinator = SessionRepo.get(input.sessionId);
    if (!coordinator) throw new Error(`session not found: ${input.sessionId}`);
    const plannerProfile = ProfileStore.get("builtin-planner");
    const { session: side } = createOrReuseSession(
      {
        projectId: coordinator.projectId,
        kind: "side",
        parentSessionId: coordinator.id,
        providerId: plannerProfile?.providerId,
        model: plannerProfile?.model,
        effort: plannerProfile?.effort ?? "default",
        permissionMode: "default",
      },
      "desktop",
    );
    const project = ProjectRepo.get(side.projectId);
    if (!project) throw new Error(`project not found: ${side.projectId}`);
    const prompt = [
      "把下面的总体目标拆解为编排任务图(最多 4 层依赖深度)。只输出 JSON,不要其他文字。",
      "格式:{\"tasks\":[{\"spec\":\"任务简报\",\"deps\":[\"t1\"],\"profileId\":\"agent id 或 null\",\"tags\":[\"coding\"],\"reviewOf\":null,\"variantGroup\":null}]}",
      "deps 引用前面任务的编号(t1、t2…按出现顺序);能并行的并行;写码任务尽量独立。",
      `可选 agent:${ProfileStore.list().map((p) => `${p.id}(${p.tags.join("/")})`).join("、")}`,
      input.hint ? `补充要求:${input.hint}` : "",
      `【总体目标】\n${input.goal}`,
    ]
      .filter(Boolean)
      .join("\n\n");
    SessionRepo.updateStatus(side.id, "running");
    const cwd = await resolveSessionCwd(side, project);
    runtimeManager.bindSession(side);
    await runtimeManager.sendTurn(side, { prompt, cwd });
    // 等待规划回合结束(上限 3 分钟),再从最新 assistant 消息解析 JSON。
    const finished = await waitForSessionIdle(side.id, 180_000);
    if (!finished) {
      runtimeManager.interrupt(side.id);
      return { tasks: [], error: "规划超时" };
    }
    const text = latestAssistantText(side.id);
    const parsed = parseProposal(text);
    if (!parsed) return { tasks: [], error: "无法解析规划输出" };
    // 补齐 id(按顺序 t1..tN,deps 引用顺序号)。
    const tasks = parsed.tasks.map((t, i) => TaskSpecInputSchema.parse({
      id: `t${i + 1}`,
      spec: t.spec,
      deps: t.deps ?? [],
      profileId: t.profileId ?? null,
      tags: t.tags ?? [],
      reviewOf: t.reviewOf ?? null,
      variantGroup: t.variantGroup ?? null,
    }));
    return { tasks };
  });
}

function sessionIdToProject(sessionId: string): string {
  const session = SessionRepo.get(sessionId);
  if (!session) throw new Error(`session not found: ${sessionId}`);
  return session.projectId;
}

/** 轮询等会话回合一分钟内空闲(runtime 无 handle 且 DB 状态非 running)。
 *  简单但足够 —— 规划是一次性的 side 会话。 */
async function waitForSessionIdle(sessionId: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const running = runtimeManager.runningSessionIds().includes(sessionId);
    if (!running) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function latestAssistantText(sessionId: string): string {
  if (!SessionRepo.get(sessionId)) return "";
  const msgs = MessageRepo.listBySession(sessionId, { limit: 10 });
  const assistant = msgs.messages.find((m) => m.role === "assistant");
  if (!assistant) return "";
  const content = assistant.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) =>
      b && typeof b === "object" && "kind" in b && (b as { kind: string }).kind === "text"
        ? String((b as { text?: unknown }).text ?? "")
        : "",
    )
    .join("\n")
    .trim();
}

/** 宽松解析模型输出的提案 JSON(剥代码围栏 / 截取首个 { 到末个 })。 */
function parseProposal(text: string): z.infer<typeof ProposalSchema> | null {
  if (!text) return null;
  const stripped = text.replace(/```(?:json)?/g, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const v = ProposalSchema.parse(JSON.parse(stripped.slice(start, end + 1)));
    return v;
  } catch {
    return null;
  }
}
