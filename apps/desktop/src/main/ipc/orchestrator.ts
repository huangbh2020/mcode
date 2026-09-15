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
import type { Session } from "@contracts/session";
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
import { buildCustomEnv, resolveActiveModel } from "@main/providers/claude-sdk/customEnv.js";
import { resolveModelForGitOp } from "@main/ipc/git.js";
import { resolveSdkBinaryPath } from "@main/providers/claude-sdk/sdkBinaryPath.js";
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

  /* ── 向导自动拆解:复用 generateCommitMessageForRepo 的模式直接 query() ──
   *
   * 之前用 createOrReuseSession + RuntimeManager.sendTurn 走 side session,
   * 怎么 inherit customModelId 都拿不到,SDK 还是落官方凭据报 /login。
   * 这里改用 git.ts 的 generateCommitMessageForRepo 模式:直接 query()
   * + resolveModelForGitOp + buildCustomEnv,完全跳过 session 行。
   * —— 这条路径 git 已经实测跑通了(用户用来 AI 生成 commit message),
   * planner 与 commit 一样的"单轮 / 产纯文本"模式,直接复用。
   */
  ipcMain.handle(IPC.ORCH_PROPOSE_PLAN, async (_evt, raw) => {
    await ready();
    const input = OrchProposePlanSchema.parse(raw);
    const coordinator = SessionRepo.get(input.sessionId);
    if (!coordinator) throw new Error(`session not found: ${input.sessionId}`);

    // 解析自定义端点配置:沿协调者主会话的 customModelId 选 + 兜底取
    // 任意已配 customModel。claude-sdk 必须有 customModelId,否则
    // SDK 走官方 OAuth 凭据必然 /login —— 这正是用户之前遇到的失败模式。
    // Pi/Codex 走自家端点配置,不带 customModelId 也能跑(但目前
    // 协调者主会话默认是 claude-sdk,所以这里基本只走 anthropic/openai 协议)。
    const plannerCustomModelId = pickPlannerCustomModelId(coordinator);
    if (!plannerCustomModelId) {
      return {
        tasks: [],
        error:
          "自动拆解需要自定义端点:请先在「设置 → 模型配置」里添加一个 Anthropic 兼容端点(网关或 OpenAI 协议桥),再回到这里点自动拆解",
      };
    }

    const surface = await buildAvailableModelSurface();
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
    const userPrompt = [
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

    const result = await generateProposal({
      customModelId: plannerCustomModelId,
      userPrompt,
    });
    if (!result.ok) {
      return { tasks: [], error: result.error };
    }
    const parsed = parseProposal(result.text);
    if (!parsed) {
      return { tasks: [], error: "无法解析规划输出" };
    }
    // 补齐 id(按顺序 t1..tN,deps 引用顺序号)。
    const tasks = parsed.tasks.map((t, i) =>
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

/** 解析 planner 用的 customModelId:
 *  - 协调者主会话当前生效的 customModelId(用户已在主 chat 选过)
 *  - 兜底取设置里第一个已配 model 的 customModel(协调者从未选过)
 *  - 都没有:返回 null,wizard 提示"请去设置 → 模型配置 添加端点"
 *
 * 不论用户选的 planner profile 是 builtin-planner 还是别的 claude-sdk
 * profile,只要走 claude-sdk 都必须拿 customModelId —— 否则 SDK 走
 * 官方 OAuth 凭据 → /login。Pi/Codex 走自家端点配置,理论上不用这条
 * 兜底链;但目前协调者主会话默认是 claude-sdk,planner 也基本只走
 * 这个,先不区分,拿到就传。 */
function pickPlannerCustomModelId(coordinator: Session): string | null {
  if (coordinator.customModelId) return coordinator.customModelId;
  const fallback =
    CustomModelStore.listPublic().find((c) => c.models.some((m) => m.id.trim())) ?? null;
  return fallback?.id ?? null;
}

/** Planner 提示词:沿用 generateCommitMessageForRepo 的"硬系统约束 +
 * 可变 user 偏好"分层(system 不可被 user 覆盖)。 */
const PLANNER_SYSTEM_PROMPT = [
  "你是一个任务规划专家。接收一个总体目标,产出结构化、可独立验收的子任务拆解(JSON)。",
  "",
  "硬输出约束:",
  "1. 只输出 JSON 本身,不要任何前导语、问候、解释或代码围栏(``` ... ```)。",
  "2. 字段:tasks 数组,每项 { spec, deps?, profileId, tags?, reviewOf?, variantGroup? }。",
  "3. deps 引用前面任务的编号(t1/t2/...按出现顺序);能并行的并行。",
  "4. profileId 必须是 user 消息列出的 agent id,或 null;绝不要自己造 agent id,也不要建议未列出的模型。",
  "5. 任务图深度 ≤ 4(spec/约束/产物路径/验收标准,避免子任务间隐式耦合)。",
].join("\n");

/** 直接 query() 调一次 SDK,走 buildCustomEnv → 用户的 Anthropic 兼容端点,
 * 不创建 side session、不依赖 session 行 customModelId。
 * 模式与 generateCommitMessageForRepo 一致(同样单轮/产纯文本),
 * 复用它的 resolveModelForGitOp + buildCustomEnv 路径。 */
async function generateProposal(input: {
  customModelId: string;
  userPrompt: string;
}): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 180_000); // 3 min
  let releaseBridge: (() => void) | undefined;
  try {
    const resolved = await resolveModelForGitOp(input.customModelId, undefined);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    releaseBridge = resolved.releaseBridge;
    const cfg = resolved.config;
    const env = buildCustomEnv(cfg);
    const model = resolveActiveModel(cfg);
    const binaryPath = resolveSdkBinaryPath();
    const q = query({
      prompt: input.userPrompt,
      options: {
        abortController: ac,
        maxTurns: 1,
        model,
        env,
        systemPrompt: PLANNER_SYSTEM_PROMPT,
        settingSources: ["project", "local"],
        includePartialMessages: false,
        ...(binaryPath ? { pathToClaudeCodeExecutable: binaryPath } : {}),
      },
    });
    let message = "";
    for await (const m of q) {
      if (m.type === "assistant") {
        const content = (m as { message?: { content?: Array<{ type: string; text?: string }> } }).message?.content;
        if (Array.isArray(content)) {
          message = content
            .filter((b) => b.type === "text" && b.text)
            .map((b) => b.text!)
            .join("\n");
        }
      }
      if (m.type === "result") break;
    }
    clearTimeout(timer);
    if (!message.trim()) {
      return { ok: false, error: "模型未返回有效内容" };
    }
    // 剥模型套的代码围栏(与 commit message 行为一致)。
    return {
      ok: true,
      text: message.trim().replace(/^```\w*\n?/, "").replace(/\n?```$/, "").trim(),
    };
  } catch (err) {
    const msg = (err as Error).message || String(err);
    log.warn(`orch.proposePlan: query failed: ${msg}`);
    if (/401|unauthorized|invalid.*key/i.test(msg)) {
      return { ok: false, error: "认证失败,请检查模型配置的 Token/Key" };
    }
    if (/503|no available channel/i.test(msg)) {
      return { ok: false, error: "网关无此模型渠道,请检查模型名配置" };
    }
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
    releaseBridge?.();
  }
}

/** 宽松解析模型输出的提案 JSON(剥代码围栏 / 截取首个 { 到末个 })。
 *  返回 ProposalSchema(去重后);parse 失败返回 null,handler 透出
 *  "无法解析规划输出"错误。 */
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
