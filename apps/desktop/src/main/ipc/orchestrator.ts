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
  OrchTemplateSaveSchema,
  OrchTemplateDeleteSchema,
  OrchProposePlanSchema,
  OrchAbortPlanSchema,
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
import { sendToRenderer } from "@main/window.js";
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
        /** 节点级执行配置(全部可选;经 clampNodeExecConfig 白名单校验后落节点)。
         *  customModelId = 该节点选举的网关配置 id(claude 侧),与 model 配对。 */
        providerId: z.string().nullable().optional(),
        model: z.string().nullable().optional(),
        customModelId: z.string().nullable().optional(),
        effort: z.string().nullable().optional(),
        permissionMode: z.string().nullable().optional(),
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
    const res = orchestrator.taskControl(input.runId, input.taskId, input.action, input.profileId);
    if (res.error) throw new Error(res.error);
    return { run: res.run ?? null };
  });
  ipcMain.handle(IPC.ORCH_UPDATE_TASK, async (_evt, raw) => {
    await ready();
    const input = OrchUpdateTaskSchema.parse(raw);
    const res = orchestrator.updateTask(input.runId, input.taskId, {
      spec: input.spec,
      deps: input.deps,
      profileId: input.profileId,
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
    const profile = input.profileId ? ProfileStore.get(input.profileId) : undefined;
    // 继承来源会话的执行配置 —— 与 worker 派发同款:customModelId 不带的话
    // 第三方网关用户的新会话落官方 OAuth,首轮即 /login。
    const from = input.fromSessionId ? SessionRepo.get(input.fromSessionId) : undefined;
    const { session } = createOrReuseSession(
      {
        projectId: input.projectId,
        title: input.title ?? `${input.briefing.slice(0, 36)}${input.briefing.length > 36 ? "…" : ""}`,
        providerId: profile?.providerId ?? from?.providerId,
        model: profile?.model ?? from?.model,
        effort: profile?.effort ?? from?.effort ?? "default",
        permissionMode: profile?.permissionMode ?? from?.permissionMode ?? "default",
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
    const surfaceDescription = describeSurface(surface, coordinator);
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
      "格式:{\"tasks\":[{\"spec\":\"任务简报\",\"deps\":[\"t1\"],\"profileId\":\"agent id 或 null\",\"providerId\":\"<厂商 id>\",\"model\":\"<模型 id>\",\"customModelId\":\"<配置 id 或 null>\",\"effort\":\"<档位>\",\"permissionMode\":\"<权限模式>\",\"tags\":[\"coding\"],\"reviewOf\":null,\"variantGroup\":null}]}",
      "deps 引用前面任务的编号(t1、t2…按出现顺序);能并行的并行;写码任务尽量独立。",
      `可用厂商(providerId):${[...surface.keys()].join("、")}`,
      surfaceDescription,
      `可选 agent:${agentDescription || "(系统中尚无 agent)"}`,
      "硬约束:profileId 必须是上面列出的 agent id 之一,或 null;绝不要自己造 agent id,也不要建议未在上面模型表里出现的模型或配置 id。",
      "【执行配置必填】每个节点的 providerId、model、effort、permissionMode 四个字段都【必须给出明确值】,绝不允许写 null、省略或留空(claude 节点还必须给 customModelId):",
      "- 所有值只能逐字取自上面列出的清单:providerId ∈ 可用厂商;model ∈ 该厂商名下的模型;effort ∈ 该厂商的 effort 可选值;permissionMode ∈ 该厂商的 permissionMode 可选值。编造的值会被整项作废,节点将无法按你的意图运行。",
      "- 【模型选举】为每个节点从该厂商已配置的模型中选举一个最合适的 model:重推理/架构/写码类给高档模型,轻量机械任务(整理、摘要、简单格式转换)给轻量模型;不要把所有节点都丢给同一个模型。",
      "- claude 节点必须三元组配对:{\"providerId\":\"claude-sdk\",\"customModelId\":\"<该模型所属配置的 id>\",\"model\":\"<模型 id>\"};只写 model 不写 customModelId 时,系统也会在已配置模型中自动归属,但归属不明的会被丢弃。",
      "- effort 按任务轻重选择:重推理/架构/写码类给高档(xhigh/max),轻量整理类给 low/medium。permissionMode 建议给该厂商的免审批档(claude/pi = bypassPermissions,codex = full-access),节点自动执行、不弹审批;仅当某个节点要收敛权限时才给 default/acceptEdits/read-only。",
      "- 已选 profileId 的节点同样必须给出这四项(可以沿用该 profile 的厂商/模型/档位);仅当想让同一 profile 以不同模型或档位运行时才另选。",
      input.hint ? `补充要求:${input.hint}` : "",
      `【总体目标】\n${input.goal}`,
    ]
      .filter(Boolean)
      .join("\n\n");

    const result = await generateProposal({
      customModelId: plannerCustomModelId,
      userPrompt,
      sessionId: input.sessionId,
    });
    if (!result.ok) {
      return { tasks: [], error: result.error };
    }
    const parsed = parseProposal(result.text);
    if (!parsed) {
      return { tasks: [], error: "无法解析规划输出" };
    }
    // 补齐 id(按顺序 t1..tN,deps 引用顺序号);节点级执行配置经白名单钳制,
    // 非法值一律回退「跟随会话默认」而不是让整份 plan 报废,再经缺省补值
    // 链(节点 → profile → 协调者会话)把空字段落成已配置的具体值;模型选举
    // (model → 所属网关配置)也在钳制里完成。
    const tasks = parsed.tasks.map((t, i) => {
      const exec = clampNodeExecConfig(t, surface, coordinator);
      return TaskSpecInputSchema.parse({
        id: `t${i + 1}`,
        spec: t.spec,
        deps: t.deps ?? [],
        profileId: t.profileId ?? null,
        providerId: exec.providerId,
        model: exec.model,
        customModelId: exec.customModelId,
        effort: exec.effort,
        permissionMode: exec.permissionMode,
        tags: t.tags ?? [],
        reviewOf: t.reviewOf ?? null,
        variantGroup: t.variantGroup ?? null,
      });
    });
    return { tasks, model: result.model };
  });

  /* ── 停止自动拆解:中止该会话在途的 planner query(没有在途查询时是
   *  幂等 no-op —— 停止键与查询完成之间的竞态在这里收敛)。 */
  ipcMain.handle(IPC.ORCH_ABORT_PLAN, (_evt, raw) => {
    const input = OrchAbortPlanSchema.parse(raw);
    const abort = planQueries.get(input.sessionId);
    if (abort) {
      abort();
      log.info(`orch.proposePlan: aborted by user for session ${input.sessionId}`);
    }
    return { ok: true };
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
  // registry 注册了全部三家(含 pi-sdk/codex-sdk),必须**并入**上面已水合
  // 的桶而不是 set 覆盖 —— 覆盖会把 Pi/Codex 的真实模型清单打回各自的
  // capabilities.builtinModels(两者都是空),planner 就看不到它们的模型了。
  for (const p of providerRegistry.list()) {
    const bucket = surface.get(p.id) ?? {
      builtin: new Set<string>(),
      custom: new Set<string>(),
      builtinLabels: new Map<string, string>(),
    };
    for (const m of p.capabilities.builtinModels ?? []) {
      bucket.builtin.add(m.id);
      bucket.builtinLabels.set(m.id, m.label ?? m.id);
    }
    surface.set(p.id, bucket);
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

/** 把白名单渲染成 prompt 一段(给规划者读)。"厂商 → 模型"分组,附各厂商
 *  声明的思考级别与权限模式(权限模式只列 AI 可指派的安全子集)。 */
/** 已配置的 claude 网关模型目录(配置 id/名 → 模型 id 列表),供节点模型
 *  选举:planner 从这里列出的模型里挑,pair (customModelId, model) 落节点。 */
function customModelCatalog(): Array<{ id: string; name: string; models: string[] }> {
  return CustomModelStore.listPublic()
    .map((c) => ({
      id: c.id,
      name: c.name,
      models: (c.models ?? []).map((m) => m.id.trim()).filter((id) => id),
    }))
    .filter((c) => c.models.length > 0);
}

function describeSurface(
  surface: Awaited<ReturnType<typeof buildAvailableModelSurface>>,
  coordinator: Session,
): string {
  const lines: string[] = ["可用模型(providerId → models):"];
  for (const [pid, s] of surface) {
    const caps = providerRegistry.get(pid)?.capabilities;
    const parts: string[] = [];
    if (pid === "claude-sdk") {
      // claude 侧:已配置网关模型按「配置」列出(带 cfgId,planner 选举时
      // 配对引用)。builtin 官方别名只在会话未走网关时列出 —— 走网关的
      // 会话里它们不可用,列出来只会诱导 planner 选出会被钳掉的值。
      const catalog = customModelCatalog();
      for (const c of catalog) parts.push(`已配置模型 配置「${c.name}」(${c.id}): ${c.models.join(", ")}`);
      if (!coordinator.customModelId) {
        const builtinList = [...s.builtin].map((id) => {
          const label = s.builtinLabels?.get(id);
          return label && label !== id ? `${label}(${id})` : id;
        });
        if (builtinList.length > 0) parts.push(`builtin: ${builtinList.join(", ")}`);
      }
      if (parts.length === 0) {
        lines.push(`  ${pid}: (当前没有已配置的模型,节点将跟随会话默认)`);
        continue;
      }
    } else {
      // 其他厂商:label ≠ id 时两者都给 —— label 给模型语义,id 是它必须
      // 写进 JSON 的值(Pi 的合成 id 形如 pi-remote/pi-large,只给 label
      // 它就没法引用)。
      const builtinList = [...s.builtin].map((id) => {
        const label = s.builtinLabels?.get(id);
        return label && label !== id ? `${label}(${id})` : id;
      });
      const customList = [...s.custom];
      if (builtinList.length === 0 && customList.length === 0) {
        lines.push(`  ${pid}: (当前没有可用模型,跳过此厂商)`);
        continue;
      }
      if (builtinList.length > 0) parts.push(`builtin: ${builtinList.join(", ")}`);
      if (customList.length > 0) parts.push(`custom: ${customList.join(", ")}`);
    }
    const levels = caps?.thinkingLevels?.map((l) => l.value) ?? [];
    if (levels.length > 0) parts.push(`effort 可选: ${levels.join("/")}`);
    const modes = (caps?.permissionModes ?? [])
      .filter((m) => !PLANNER_FORBIDDEN_PERMISSION_MODES.has(m.value))
      .map((m) => m.value);
    if (modes.length > 0) parts.push(`permissionMode 可选: ${modes.join("/")}`);
    lines.push(`  ${pid}: ${parts.join("; ")}`);
  }
  return lines.join("\n");
}

/** AI 可给节点指派的权限模式黑名单。免审批档(bypassPermissions/claude·pi、
 *  full-access/codex)是编排节点的**缺省档**,允许 planner 显式指派;唯独
 *  dontAsk 仍挡(文件守卫侧的内部豁免档,语义与 bypass 重叠且不走模型)。 */
const PLANNER_FORBIDDEN_PERMISSION_MODES = new Set([
  "dontAsk",
]);

/** 各厂商的"免审批"档(节点缺省权限):worker 无人值守执行,不逐个弹审批。 */
const NO_PROMPT_MODE_BY_PROVIDER: Record<string, string> = {
  "claude-sdk": "bypassPermissions",
  "pi-sdk": "bypassPermissions",
  "codex-sdk": "full-access",
};

/** 节点最终继承的模型面里,model 字段的合法值域。
 *  - claude-sdk:协调者带 customModelId 时 worker 必然继承同一份网关配置,
 *    官方别名落不进 resolveApiConfig(静默回第一个模型),所以只认该配置
 *    内的模型 id;无网关(官方端点)才认 builtin 别名。
 *  - 其余厂商:白名单即已水合的 builtin 桶(Pi 为 providerId/model 合成 id)。 */
function plannerAllowedModels(
  providerId: string,
  coordinator: Session,
  surface: Awaited<ReturnType<typeof buildAvailableModelSurface>>,
): Set<string> {
  if (providerId === "claude-sdk" && coordinator.customModelId) {
    const cfg = CustomModelStore.listPublic().find((c) => c.id === coordinator.customModelId);
    if (cfg) {
      return new Set(cfg.models.map((m) => m.id).filter((id) => id.trim()));
    }
  }
  const bucket = surface.get(providerId);
  return new Set([...(bucket?.builtin ?? []), ...(bucket?.custom ?? [])]);
}

/** AI 提案节点级执行配置的白名单校验 + 模型选举 + 缺省补值。planner 可能是
 *  弱模型,自报值只能信白名单:任何不在合法值域内的字段先钳掉,再沿
 *  「节点 → profile → 协调者会话」的已配置链补齐空字段 —— 输出节点不允许
 *  空配置(画布上每个节点都携带具体可执行的 providerId/model/档位),补出的
 *  值与派发时「跟随会话默认」的继承链同源,只是把继承结果在计划期写实。
 *
 *  模型选举(claude-sdk 节点):planner 可给 (customModelId, model) 配对,
 *  或只给 model 由系统在全部已配置网关模型里自动归属。配对校验:配置不
 *  存在 → 丢弃走自动归属;模型不在该配置里 → 保配置弃模型(跟随该配置
 *  默认)。归属不到任何配置的 model,仅当会话未走网关(官方端点)才允许
 *  builtin 别名,否则钳空。
 *
 *  缺省档(无人值守执行):planner 未给或给了无效值时 —— effort 缺省
 *  high;permissionMode 缺省该厂商的免审批档(claude/pi = bypassPermissions,
 *  codex = full-access),worker 不再逐个弹审批。providerId 编造或不在线时
 *  视为未给,整节点按「跟随」处理后再补值,不再整体作废。 */
function clampNodeExecConfig(
  t: {
    providerId?: string | null;
    model?: string | null;
    customModelId?: string | null;
    effort?: string | null;
    permissionMode?: string | null;
    profileId?: string | null;
  },
  surface: Awaited<ReturnType<typeof buildAvailableModelSurface>>,
  coordinator: Session,
): {
  providerId: string | null;
  model: string | null;
  customModelId: string | null;
  effort: string | null;
  permissionMode: string | null;
} {
  let pid = t.providerId?.trim() || null;
  if (pid && !surface.has(pid)) pid = null; // 厂商编造/不在线:视为未给,交给补值链

  let customModelId = t.customModelId?.trim() || null;
  let model = t.model?.trim() || null;

  if (pid && pid !== "claude-sdk") {
    // 网关配置仅 claude 侧存在;其余厂商忽略 customModelId,模型走 builtin 白名单。
    customModelId = null;
    if (model && !plannerAllowedModels(pid, coordinator, surface).has(model)) model = null;
  } else if (pid === "claude-sdk") {
    const catalog = customModelCatalog();
    if (customModelId) {
      const cfg = catalog.find((c) => c.id === customModelId);
      if (!cfg) {
        // 配置 id 编造 → 丢弃,让 model 走下方自动归属。
        customModelId = null;
      } else if (model && !cfg.models.includes(model)) {
        // 配置对、模型名不在其中 → 保配置弃模型(跟随该配置默认)。
        model = null;
      }
    }
    if (!customModelId && model) {
      // 选举:在全部已配置模型里找 model 的归属配置;协调者自己的配置优先。
      const picked = model; // 窄化不进回调,接成常量。
      const hits = catalog.filter((c) => c.models.includes(picked));
      if (hits.length > 0) {
        customModelId = (hits.find((c) => c.id === coordinator.customModelId) ?? hits[0]).id;
      } else if (!plannerAllowedModels(pid, coordinator, surface).has(picked)) {
        // 不属于任何配置,也不在继承面(builtin)里 → 钳成跟随会话默认。
        model = null;
      }
    }
  } else {
    // providerId 缺省:planner 自报的模型/配置失去归属依据,先清空待补值。
    customModelId = null;
    model = null;
  }

  // 缺省档的厂商推断:节点 providerId → profile → 协调者会话。
  const profile = t.profileId ? ProfileStore.get(t.profileId) : undefined;
  const effProviderId = pid ?? profile?.providerId ?? coordinator.providerId ?? null;
  const effCaps = effProviderId ? providerRegistry.get(effProviderId)?.capabilities : undefined;
  const levels = effCaps?.thinkingLevels ?? [];
  const modes = effCaps?.permissionModes ?? [];

  let effort = t.effort?.trim() || null;
  if (effort && levels.length > 0 && !levels.some((l) => l.value === effort)) effort = null;
  if (!effort && (levels.length === 0 || levels.some((l) => l.value === "high"))) effort = "high";

  let permissionMode = t.permissionMode?.trim() || null;
  if (
    permissionMode &&
    (PLANNER_FORBIDDEN_PERMISSION_MODES.has(permissionMode) ||
      (modes.length > 0 && !modes.some((m) => m.value === permissionMode)))
  ) {
    permissionMode = null;
  }
  if (!permissionMode) {
    const noPrompt = effProviderId ? NO_PROMPT_MODE_BY_PROVIDER[effProviderId] : undefined;
    if (noPrompt && (modes.length === 0 || modes.some((m) => m.value === noPrompt))) {
      permissionMode = noPrompt;
    }
  }

  // ── 缺省补值(「必须要有值」):model 候选必须与生效厂商同源(跨厂商的
  //  会话模型不是合法值),profile/协调者都没有时取该厂商已配置模型清单的
  //  首个("default" 占位除外);claude 节点的 customModelId 与 model 配对
  //  归属,归属不到配置(builtin 别名)时保持与协调者同源(协调者走官方则
  //  同走官方)。该厂商一个已配置模型都没有时 model 保持 null,派发链兜底。
  if (effProviderId) {
    const allowed = plannerAllowedModels(effProviderId, coordinator, surface);
    if (!model) {
      const candidates = [
        ...(profile?.providerId === effProviderId && profile.model ? [profile.model] : []),
        ...(coordinator.providerId === effProviderId && coordinator.model ? [coordinator.model] : []),
      ];
      model =
        candidates.find((m) => m !== "default" && allowed.has(m)) ??
        [...allowed].find((m) => m !== "default") ??
        null;
    }
    if (effProviderId === "claude-sdk" && !customModelId) {
      // 窄化不进回调,接成常量(TS 不追踪回调内的 let 收窄)。
      const pickedModel = model;
      const owner = pickedModel ? customModelCatalog().find((c) => c.models.includes(pickedModel)) : undefined;
      customModelId = owner?.id ?? coordinator.customModelId ?? null;
    }
  }

  return { providerId: effProviderId, model, customModelId, effort, permissionMode };
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
  "2. 字段:tasks 数组,每项 { spec, deps?, profileId?, providerId?, model?, customModelId?, effort?, permissionMode?, tags?, reviewOf?, variantGroup? }。",
  "3. deps 引用前面任务的编号(t1/t2/...按出现顺序);能并行的并行。",
  "4. profileId 必须是 user 消息列出的 agent id,或 null;绝不要自己造 agent id,也不要建议未列出的模型。",
  "5. 任务图深度 ≤ 4(spec/约束/产物路径/验收标准,避免子任务间隐式耦合)。",
  "6. 每个任务都必须给出 providerId、model、effort、permissionMode 的明确值(claude 任务再加 customModelId):值只能逐字取自 user 消息列出的合法清单,禁止 null、禁止省略、禁止自造任何清单之外的值。",
].join("\n");

/** 在途 planner query 登记(sessionId → 中止入口),orch:abortPlan 消费。
 *  编排期间 composer 显示停止键,点击必须能真正中止 planner 的无头 query,
 *  而不是只冻结渲染层。同一会话同时至多一场拆解(orchDecomposing 门控)。 */
const planQueries = new Map<string, () => void>();

/** 空闲超时:规划模型连续这么久没有任何输出(stream/thinking/assistant 均
 *  算活动)才判定卡死。深度思考型模型一次思考就能超过旧的 180s 硬超时
 *  ("Claude Code process aborted by user" 即它触发后的 SDK abort 文案),
 *  有流式输出就一直续期。 */
const PLANNER_IDLE_TIMEOUT_MS = 120_000;
/** 绝对上限:兜底防无限流,正常拆解远用不到。 */
const PLANNER_ABSOLUTE_TIMEOUT_MS = 600_000;

/** 直接 query() 调一次 SDK,走 buildCustomEnv → 用户的 Anthropic 兼容端点,
 * 不创建 side session、不依赖 session 行 customModelId。
 * 模式与 generateCommitMessageForRepo 一致(同样单轮/产纯文本),
 * 复用它的 resolveModelForGitOp + buildCustomEnv 路径。
 *
 * 过程可观测:includePartialMessages 打开后,把 text/thinking 增量经
 * orch:event 通道推回渲染端(planner.delta),聊天流里的「拆解中」占位
 * 气泡原地长出规划过程 —— 仍是同一次无头 query(),只是旁观其流。
 *
 * 取消三通道:idle 超时 / 绝对上限 / 用户停止(orch:abortPlan),abort 前
 * 记下原因,把 SDK 的 "aborted by user" 译成可读的中文错误。 */
async function generateProposal(input: {
  customModelId: string;
  userPrompt: string;
  sessionId: string;
}): Promise<{ ok: true; text: string; model?: string } | { ok: false; error: string }> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const ac = new AbortController();
  type CancelReason = "idle-timeout" | "absolute-timeout" | "user";
  let cancelReason: CancelReason | null = null;
  const cancel = (reason: CancelReason): void => {
    if (cancelReason) return;
    cancelReason = reason;
    ac.abort();
  };
  let idleTimer: NodeJS.Timeout | undefined;
  const armIdleTimer = (): void => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => cancel("idle-timeout"), PLANNER_IDLE_TIMEOUT_MS);
    idleTimer.unref?.();
  };
  const absoluteTimer = setTimeout(() => cancel("absolute-timeout"), PLANNER_ABSOLUTE_TIMEOUT_MS);
  absoluteTimer.unref?.();
  const cancelUser = () => cancel("user");
  planQueries.set(input.sessionId, cancelUser);
  let releaseBridge: (() => void) | undefined;
  const pushDelta = (seg: "text" | "thinking", text: string): void => {
    sendToRenderer(IPC.ORCH_EVENT, {
      channel: IPC.ORCH_EVENT,
      event: { kind: "planner.delta", sessionId: input.sessionId, seg, text },
    });
  };
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
        includePartialMessages: true,
        ...(binaryPath ? { pathToClaudeCodeExecutable: binaryPath } : {}),
      },
    });
    let message = "";
    armIdleTimer();
    for await (const m of q) {
      armIdleTimer(); // 任何消息都算模型活动,空闲计时重新起算
      if (m.type === "stream_event") {
        const ev = (m as { event?: { type?: string; delta?: { type?: string; text?: string; thinking?: string } } }).event;
        if (ev?.type === "content_block_delta" && ev.delta) {
          if (ev.delta.type === "text_delta" && ev.delta.text) pushDelta("text", ev.delta.text);
          else if (ev.delta.type === "thinking_delta" && ev.delta.thinking) pushDelta("thinking", ev.delta.thinking);
        }
      } else if (m.type === "assistant") {
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
    if (!message.trim()) {
      return { ok: false, error: "模型未返回有效内容" };
    }
    // 剥模型套的代码围栏(与 commit message 行为一致)。
    return {
      ok: true,
      text: message.trim().replace(/^```\w*\n?/, "").replace(/\n?```$/, "").trim(),
      model,
    };
  } catch (err) {
    const msg = (err as Error).message || String(err);
    log.warn(`orch.proposePlan: query failed: ${msg}`);
    // 自家取消通道优先翻译 —— SDK 对 abort 一律抛 "Claude Code process
    // aborted by user",原样透传会被当成莫名失败(2026-09-17 实测:180s 硬
    // 超时打断深度思考型规划模型,报错卡就显示这句)。
    if (cancelReason === "user") {
      return { ok: false, error: "已停止自动拆解" };
    }
    if (cancelReason === "idle-timeout") {
      return {
        ok: false,
        error: `自动拆解超时:规划模型连续 ${Math.round(PLANNER_IDLE_TIMEOUT_MS / 1000)} 秒没有任何输出,已取消。可重试,或在设置里换更快的规划模型`,
      };
    }
    if (cancelReason === "absolute-timeout") {
      return {
        ok: false,
        error: `自动拆解超时:规划超过 ${Math.round(PLANNER_ABSOLUTE_TIMEOUT_MS / 60000)} 分钟未完成,已取消。建议缩减目标规模,或手动添加任务`,
      };
    }
    if (/401|unauthorized|invalid.*key/i.test(msg)) {
      return { ok: false, error: "认证失败,请检查模型配置的 Token/Key" };
    }
    if (/503|no available channel/i.test(msg)) {
      return { ok: false, error: "网关无此模型渠道,请检查模型名配置" };
    }
    return { ok: false, error: msg };
  } finally {
    clearTimeout(idleTimer);
    clearTimeout(absoluteTimer);
    // 只清自己的登记(极端并发下后一场拆解的入口不能被顺手删掉)。
    if (planQueries.get(input.sessionId) === cancelUser) planQueries.delete(input.sessionId);
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
