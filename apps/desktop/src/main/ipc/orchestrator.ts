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
import { providerRegistry } from "@main/providers/registry.js";
import { createOrReuseSession } from "@main/lib/sessionStart.js";
import { resolveSessionCwd } from "@main/lib/sessionCwd.js";
import { CustomModelStore } from "@main/lib/secretStore.js";
import { PiModelsStore } from "@main/lib/piModelsStore.js";
import { CodexModelsStore } from "@main/lib/codexModelsStore.js";
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
    await ready();
    const input = OrchProposePlanSchema.parse(raw);
    const coordinator = SessionRepo.get(input.sessionId);
    if (!coordinator) throw new Error(`session not found: ${input.sessionId}`);
    // Resolve planner profile: user-picked wins; fall back to builtin-planner.
    // A picked profile that no longer exists (deleted between pick and
    // invoke) silently degrades to builtin-planner rather than erroring
    // — the user can re-pick on retry.
    const surface = await buildAvailableModelSurface();
    let plannerProfile = input.plannerProfileId
      ? ProfileStore.get(input.plannerProfileId)
      : undefined;
    if (!plannerProfile) {
      // User-picked but not found (deleted between pick and invoke) — fall
      // back to builtin-planner silently; the wizard UI will show the error
      // and let the user re-pick on retry.
      if (input.plannerProfileId) {
        log.warn(
          `orch.proposePlan: plannerProfileId ${input.plannerProfileId} not found, falling back to builtin-planner`,
        );
      }
      plannerProfile = ProfileStore.get("builtin-planner");
    }
    if (!plannerProfile) {
      return { tasks: [], error: "内置规划者 agent 不存在,请重置 Agent 角色" };
    }
    // 规划者自己也要走白名单:profileId/model 必须在当前可用集合里,
    // 否则让它落 null 让协调者后续在 panel 里手动指定。
    const plannerSurface = surface.get(plannerProfile.providerId);
    const plannerModelOk = plannerSurface
      ? plannerProfile.model === "default" || plannerSurface.builtin.has(plannerProfile.model) || plannerSurface.custom.has(plannerProfile.model)
      : false;
    const plannerProviderOk = !!plannerSurface;
    if (!plannerProviderOk) {
      return {
        tasks: [],
        error: `规划者厂商 ${plannerProfile.providerId} 在系统中不可用`,
      };
    }
    if (!plannerModelOk) {
      return {
        tasks: [],
        error: `规划者模型 ${plannerProfile.providerId}/${plannerProfile.model} 不在系统当前可用列表中`,
      };
    }
    // 规划者的 side session 必须继承 customModelId —— 任何走 claude-sdk
    // 厂商的 profile(无论 model 是 "default" 还是具体 id,如
    // "GLM-5.3-Flash"/"deepseek-v4-pro" 等)都依赖 baseUrl+token 才能打通:
    // 用户从来不该让 Mcode 走到官方 Claude OAuth 凭据,我们的目的就是走
    // 他在「模型配置」里配的 Anthropic 兼容端点。
    //
    // 兜底顺序:
    //  1) 协调者主会话当前生效的 customModelId(用户已在主 chat 选过)
    //  2) 设置里第一个已配 model 的 customModel
    //  3) 都没有:报"请去设置 → 模型配置 添加端点"
    //
    // 只对 claude-sdk 厂商应用此规则(其它厂商走自己的端点,不该被覆盖;
    // 比如 pi-sdk 走 ~/.pi/agent/models.json,codex-sdk 走 config.toml)。
    let plannerCustomModelId: string | null = null;
    if (plannerProfile.providerId === "claude-sdk") {
      if (coordinator.customModelId) {
        plannerCustomModelId = coordinator.customModelId;
      } else {
        // 协调者主会话从未选过 customModelId(只有 AgentProfile model 列表
        // 里有 customModel,但该 session 行 customModelId 仍为 null)。
        // 兜底取任何配置好的 customModel,跳过 0 个 model 的空配置。
        const fallback =
          CustomModelStore.listPublic().find((c) => c.models.some((m) => m.id.trim())) ?? null;
        if (fallback) plannerCustomModelId = fallback.id;
      }
      // 仍为 null 说明用户在「模型配置」里也没配任何端点 —— 让侧 session
      // 走官方凭据,SDK 会因 /login 失败;我们把这条信息透传回 wizard 即可
      // 提示「先去设置 → 模型配置 添加一个 Anthropic 兼容端点」。
      if (!plannerCustomModelId) {
        return {
          tasks: [],
          error:
            "自动拆解需要自定义端点:请先在「设置 → 模型配置」里添加一个 Anthropic 兼容端点(网关或 OpenAI 协议桥),再回到这里点自动拆解",
        };
      }
    }
    const { session: side } = createOrReuseSession(
      {
        projectId: coordinator.projectId,
        kind: "side",
        parentSessionId: coordinator.id,
        providerId: plannerProfile.providerId,
        model: plannerProfile.model,
        customModelId: plannerCustomModelId,
        effort: plannerProfile.effort ?? "default",
        permissionMode: "default",
      },
      "desktop",
    );
    const project = ProjectRepo.get(side.projectId);
    if (!project) throw new Error(`project not found: ${side.projectId}`);
    const surfaceDescription = describeSurface(surface);
    const agentDescription = ProfileStore.list()
      .filter((p) => surface.has(p.providerId))
      .map(
        (p) =>
          `${p.id}(${p.tags.join("/") || "generic"},${p.providerId}/${p.model}${
            p.builtin ? ",内置" : ""
          })`,
      )
      .join("、");
    const prompt = [
      "把下面的总体目标拆解为编排任务图(最多 4 层依赖深度)。只输出 JSON,不要其他文字。",
      "格式:{\"tasks\":[{\"spec\":\"任务简报\",\"deps\":[\"t1\"],\"profileId\":\"agent id 或 null\",\"tags\":[\"coding\"],\"reviewOf\":null,\"variantGroup\":null}]}",
      "deps 引用前面任务的编号(t1、t2…按出现顺序);能并行的并行;写码任务尽量独立。",
      `可用厂商(providerId):${[...surface.keys()].join("、")}`,
      surfaceDescription,
      `可选 agent:${agentDescription || "(系统中尚无 agent)"}`,
      "硬约束:profileId 必须是上面列出的 agent id 之一,或 null;绝不要自己造 agent id,也不要建议未在上面模型表里出现的模型。",
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
    // 服务端二次校验:每个 profileId 必须在系统里、其 providerId/model
    // 必须在当前可用白名单里;任一不满足,profileId 重置为 null(模型
    // 表随时可被用户清空定制,这里静默降级比报错安全)。
    const filtered: typeof parsed.tasks = [];
    const dropped: string[] = [];
    for (const t of parsed.tasks) {
      const pid = t.profileId ?? null;
      if (!pid) {
        filtered.push(t);
        continue;
      }
      const agent = ProfileStore.get(pid);
      if (!agent) {
        dropped.push(`${pid} (agent 不存在)`);
        filtered.push({ ...t, profileId: null });
        continue;
      }
      const agentSurface = surface.get(agent.providerId);
      if (!agentSurface) {
        dropped.push(`${pid} (厂商 ${agent.providerId} 不可用)`);
        filtered.push({ ...t, profileId: null });
        continue;
      }
      const modelOk =
        agent.model === "default" ||
        agentSurface.builtin.has(agent.model) ||
        agentSurface.custom.has(agent.model);
      if (!modelOk) {
        dropped.push(`${pid} (模型 ${agent.providerId}/${agent.model} 不可用)`);
        filtered.push({ ...t, profileId: null });
        continue;
      }
      filtered.push(t);
    }
    // 补齐 id(按顺序 t1..tN,deps 引用顺序号)。
    const tasks = filtered.map((t, i) =>
      TaskSpecInputSchema.parse({
        id: `t${i + 1}`,
        spec: t.spec,
        deps: t.deps ?? [],
        profileId: t.profileId ?? null,
        tags: t.tags ?? [],
        reviewOf: t.reviewOf ?? null,
        variantGroup: t.variantGroup ?? null,
      }),
    );
    if (dropped.length > 0) {
      log.warn(
        `orch.proposePlan: planner 输出 ${dropped.length} 个不可用 profile,已置 null:${dropped.join("; ")}`,
      );
    }
    return { tasks };
  });
}

/** 系统当前可用的厂商/模型白名单(单一权威来源,prompt 与解析后校验共用)。
 *  - builtin = provider.capabilities.builtinModels + Pi/Codex 已水合的
 *    可用模型清单(Pi/Codex 走 PiModelsStore/CodexModelsStore,Claude 走
 *    providerRegistry 的 capabilities);
 *  - custom = 用户在自定义模型面板里配置的网关模型 id(仅 claude)。 */
async function buildAvailableModelSurface(): Promise<Map<
  string,
  { builtin: Set<string>; custom: Set<string>; builtinLabels: Map<string, string> }
>> {
  const surface = new Map<string, { builtin: Set<string>; custom: Set<string>; builtinLabels: Map<string, string> }>();
  // Pi: 每条 PiProviderConfig 是 { id, models: [{id,label}] },user 视角
  // 看到的是 "providerId/modelId" 的合成 id —— 把它拆回顶层 provider
  // "pi-sdk",把合成 id 直接放进 builtin(与 hasSelectableModel 视图一致)。
  try {
    const pi = await PiModelsStore.listPublic();
    const builtin = new Set<string>();
    const labels = new Map<string, string>();
    for (const [providerId, cfg] of Object.entries(pi)) {
      for (const m of cfg.models ?? []) {
        const compositeId = `${providerId}/${m.id}`;
        builtin.add(compositeId);
        labels.set(compositeId, m.name ?? compositeId);
      }
    }
    surface.set("pi-sdk", { builtin, custom: new Set(), builtinLabels: labels });
  } catch (err) {
    log.warn(`surface: pi list failed: ${(err as Error).message}`);
  }
  // Codex: 顶层 provider 是 codex-sdk,模型 id 在 cfg.models[].id。
  try {
    const codex = await CodexModelsStore.listPublic();
    const builtin = new Set<string>();
    const labels = new Map<string, string>();
    for (const cfg of codex) {
      for (const m of cfg.models ?? []) {
        builtin.add(m.id);
        labels.set(m.id, m.label ?? m.id);
      }
    }
    surface.set("codex-sdk", { builtin, custom: new Set(), builtinLabels: labels });
  } catch (err) {
    log.warn(`surface: codex list failed: ${(err as Error).message}`);
  }
  // Claude + 任何其他 provider: providerRegistry 给出 capabilities.builtinModels;
  // 用户自定义配置 = CustomModelStore.listPublic() 里的 models[].id(各 cfg
  // 平铺,多 cfg 时不再用合成 id —— AgentsPanel 同样做平铺)。
  for (const p of providerRegistry.list()) {
    const builtin = new Set<string>();
    const labels = new Map<string, string>();
    for (const m of p.capabilities.builtinModels ?? []) {
      builtin.add(m.id);
      labels.set(m.id, m.label ?? m.id);
    }
    surface.set(p.id, { builtin, custom: new Set(), builtinLabels: labels });
  }
  try {
    const customs = CustomModelStore.listPublic();
    const bucket = surface.get("claude-sdk");
    if (bucket) {
      for (const cfg of customs) {
        for (const m of cfg.models ?? []) {
          if (m.id.trim()) bucket.custom.add(m.id);
        }
      }
    }
  } catch (err) {
    log.warn(`surface: custom list failed: ${(err as Error).message}`);
  }
  return surface;
}

/** 把白名单渲染成 prompt 一段(给规划者读)。"厂商 → 模型"分组。 */
function describeSurface(
  surface: Awaited<ReturnType<typeof buildAvailableModelSurface>>,
): string {
  const lines: string[] = ["可用模型(providerId → models):"];
  for (const [pid, s] of surface) {
    const builtinList = [...s.builtin].map((id) => s.builtinLabels?.get(id) ?? id);
    const customList = [...s.custom];
    const parts: string[] = [];
    if (builtinList.length > 0) parts.push(`builtin: ${builtinList.join(", ") || "(空)"}`);
    if (customList.length > 0) parts.push(`custom: ${customList.join(", ") || "(空)"}`);
    if (parts.length === 0) {
      lines.push(`  ${pid}: (当前没有可用模型,跳过此厂商)`);
    } else {
      lines.push(`  ${pid}: ${parts.join("; ")}`);
    }
  }
  return lines.join("\n");
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
