/**
 * 会话内编排拆解(方案:普通回合 + 结构化输出工具)。
 *
 * composer 的自动编排开关打开时,该回合照常走本会话的模型回合(历史/审批/
 * 停止全部复用普通回合管线,多轮调整天然携带上下文);provider 为这类回合:
 *  1. 在系统提示追加 buildOrchPlanNudge 产出的「编排规划者」指令(可用模型
 *     面 / agent 清单 / 硬约束 —— 原无头 planner 提示词的同类内容);
 *  2. 经 createSdkMcpServer 挂上 orch_submit_plan 工具(进程内 MCP server,
 *     模式取自已删除的 coordinatorTools)。模型调工具提交任务图 → 这里钳制
 *     (clampNodeExecConfig 白名单校验 + 模型选举 + 缺省补值)→ 创建 paused
 *     run → plan.proposed 推回渲染端挂画布。工具本身是纯数据提交,canUseTool
 *     全模式免审批;真正有风险的动作发生在 worker 会话,各自带自己的权限。
 *
 * 仅 Claude provider 接线(Pi 无 createSdkMcpServer 等价物)。
 */
import { z } from "zod";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { Session } from "@contracts/session";
import type { TaskSpecInput } from "@contracts/orchestration";
import { TaskSpecInputSchema } from "@contracts/orchestration";
import { IPC } from "@contracts/ipc";
// 注意:对同目录兄弟模块走 @main 别名而非相对路径 —— 冒烟脚本(esbuild
// alias 打桩)依赖这套说明符。
import { orchestrator } from "@main/orchestrator/OrchestratorService.js";
import { SessionRepo } from "@main/store/repositories.js";
import { providerRegistry } from "@main/providers/registry.js";
import { CustomModelStore } from "@main/lib/secretStore.js";
import { PiModelsStore } from "@main/lib/piModelsStore.js";
import { CodexModelsStore } from "@main/lib/codexModelsStore.js";
import { sendToRenderer } from "@main/window.js";
import { log } from "@main/lib/logger.js";

type CreateMcpServer = typeof import("@anthropic-ai/claude-agent-sdk").createSdkMcpServer;

/** MCP server 名与工具全名(canUseTool 侧的 `mcp__<server>__<tool>`)。 */
export const ORCH_PLAN_MCP_SERVER = "mcode-orchestrator";
export const ORCH_PLAN_TOOL_NAME = "orch_submit_plan";
export const ORCH_PLAN_TOOL_FULL = `mcp__${ORCH_PLAN_MCP_SERVER}__${ORCH_PLAN_TOOL_NAME}`;

/** canUseTool 判定:是否编排规划工具(纯数据提交,全模式免审批)。 */
export function isOrchPlanTool(toolName: string): boolean {
  return toolName === ORCH_PLAN_TOOL_FULL;
}

/** 工具入参的节点形状(模型结构化给出,不再需要剥围栏/截取 JSON)。 */
const OrchPlanTaskSchema = z.object({
  spec: z.string().min(1).describe("任务简报:目标、约束、产物路径、验收标准"),
  deps: z.array(z.string()).optional().describe("依赖的任务编号列表(t1、t2…按提交顺序)"),
  providerId: z.string().nullable().optional().describe("厂商 id(claude-sdk/pi-sdk/codex-sdk)"),
  model: z.string().nullable().optional().describe("模型 id"),
  customModelId: z.string().nullable().optional().describe("该模型所属的模型配置 id(仅 claude)"),
  effort: z.string().nullable().optional().describe("思考级别档位"),
  permissionMode: z.string().nullable().optional().describe("节点权限模式"),
  tags: z.array(z.string()).optional().describe("能力标签(coding/writing/review…)"),
  reviewOf: z.string().nullable().optional().describe("审查哪个任务的产出"),
  variantGroup: z.string().nullable().optional().describe("多方案竞争组"),
});

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

/** 系统当前可用的厂商/模型白名单(单一权威来源,提示词与解析后校验共用)。
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

/** 把白名单渲染成提示词一段(给规划者读)。"厂商 → 模型"分组,附各厂商
 *  声明的思考级别与权限模式(权限模式只列 AI 可指派的安全子集)。 */
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

  // 缺省档的厂商推断:节点 providerId → 协调者会话。
  const effProviderId = pid ?? coordinator.providerId ?? null;
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

  // 模型补值链(claude 选举兜底):profile 的模型 → 协调者会话模型 → 该
  //  归属,归属不到配置(builtin 别名)时保持与协调者同源(协调者走官方则
  //  同走官方)。该厂商一个已配置模型都没有时 model 保持 null,派发链兜底。
  if (effProviderId) {
    const allowed = plannerAllowedModels(effProviderId, coordinator, surface);
    if (!model) {
      const candidates = [
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

/** 编排规划者的系统提示段(provider 在 orchestration 回合追加到 systemPrompt)。
 *  内容 = 角色与工具用法 + 可用模型面 + 硬约束。原无头 planner 的提示词资产
 *  在此回收;关键差别:模型在本会话内执行,看得见全部对话历史 —— 用户的调整
 *  要求("简单一些")天然带着此前目标与上一轮任务图。 */
export async function buildOrchPlanNudge(sessionId: string): Promise<string> {
  const coordinator = SessionRepo.get(sessionId);
  if (!coordinator) return "";
  const surface = await buildAvailableModelSurface();
  const surfaceDescription = describeSurface(surface, coordinator);
  return [
    "【编排规划模式】",
    "本轮你担任 Mcode 的编排规划者:把用户提出的总体目标拆解为编排任务图,并调用 " +
      ORCH_PLAN_TOOL_FULL +
      " 工具提交(这是本轮唯一的提交入口,不要把任务图输出成普通文本)。",
    "- 结合会话内的全部上下文理解目标:若用户在之前轮次提交过任务图、本轮给出的是调整要求(如\"简单一些\"),产出修订后的【完整】任务图,而非只改动的增量。",
    "- 若用户的消息是提问、闲聊或与拆解无关,正常回答,不要调用该工具。",
    "- 工具只调用一次;提交后用一句话总结拆解思路即结束,绝不亲自执行这些任务(它们由用户在画布上检查后另行派发)。",
    "",
    "每个任务节点字段:spec(简报:目标/约束/产物路径/验收标准)、deps(依赖编号 t1…tN,能并行的并行,写码任务尽量独立)、providerId、model、customModelId、effort、permissionMode、tags、reviewOf、variantGroup。任务图深度 ≤ 4。",
    "",
    surfaceDescription,
    "",
    "硬约束:",
    "- providerId/model/effort/permissionMode 四项每个节点都必须给出明确值,绝不允许 null、省略或留空(claude 节点还必须给 customModelId 与 model 三元组配对);值只能逐字取自上面清单,编造的值会被整项作废。",
    "- 【模型选举】为每个节点选举最合适的 model:重推理/架构/写码给高档模型,轻量机械任务给轻量模型;不要把所有节点都丢给同一个模型。",
    "- effort 按任务轻重:重推理/架构/写码给高档(xhigh/max),轻量整理给 low/medium。permissionMode 建议该厂商的免审批档(claude/pi = bypassPermissions,codex = full-access);仅当某节点要收敛权限时才给 default/acceptEdits/read-only。",
  ].join("\n");
}

/** 异步构建(调用方 ClaudeAgentSdkProvider 已持有 lazy-load 的构造函数)。
 *  工具 handler:钳制 → 创建 paused run → plan.proposed 推渲染端 → 给模型
 *  文本回执。run 创建在 main 侧一次完成(渲染端只消费事件,多客户端不会
 *  重复建卡)。 */
export async function buildOrchPlanMcpServerAsync(
  sessionId: string,
  createSdkMcpServer: CreateMcpServer,
): Promise<McpSdkServerConfigWithInstance> {
  return createSdkMcpServer({
    name: ORCH_PLAN_MCP_SERVER,
    version: "1.0.0",
    instructions:
      "Mcode 编排规划工具:把总体目标拆解为任务图并提交。提交后由用户在画布上检查并手动开始运行。",
    alwaysLoad: true,
    tools: [
      {
        name: ORCH_PLAN_TOOL_NAME,
        description:
          "提交编排任务图(任务 DAG)。结合会话上下文产出完整的任务列表:每个任务给简报+依赖+承担者与执行配置;id 自动编号(t1..tN,deps 按此引用)。提交后等待用户在画布上确认,不会立即执行。",
        inputSchema: {
          goal: z.string().min(1).describe("总体目标(结合会话上下文完整转述,含用户历次调整的意图)"),
          tasks: z.array(OrchPlanTaskSchema).min(1).describe("任务列表"),
        },
        handler: async (args: Record<string, unknown>) => {
          const coordinator = SessionRepo.get(sessionId);
          if (!coordinator) return text(`会话不存在:${sessionId}`);
          const goal = String(args.goal ?? "").trim();
          const rawTasks = (args.tasks as z.infer<typeof OrchPlanTaskSchema>[]) ?? [];
          if (!goal) return text("goal 不能为空。");
          if (rawTasks.length === 0) return text("tasks 不能为空。");
          await orchestrator.start(); // 幂等;观察者/持久化未起时兜底
          // 钳制 + 补 id(按序 t1..tN,deps 引用顺序号),再经契约 schema 收口。
          const surface = await buildAvailableModelSurface();
          const tasks: TaskSpecInput[] = rawTasks.map((t, i) => {
            const exec = clampNodeExecConfig(t, surface, coordinator);
            return TaskSpecInputSchema.parse({
              id: `t${i + 1}`,
              spec: t.spec,
              deps: t.deps ?? [],
              profileId: null, // agent 角色域已退役;历史 run 的字段保留兼容
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
          // 设置页「默认预算」在此接线:非 0 时自动拆解出的 run 自带预算闸
          // (超限 pause + budget gate)—— 无人值守 worker 的节流手段。
          const defaultBudget = orchestrator.getSettings().budgetUsd;
          const res = orchestrator.createRun({
            parentSessionId: sessionId,
            projectId: coordinator.projectId,
            goal,
            tasks,
            budgetUsd: defaultBudget > 0 ? defaultBudget : null,
            autoStart: false, // planning 态:用户在画布上检查后手动开跑
          });
          if ("error" in res) {
            log.warn(`orch_submit_plan: createRun failed: ${res.error}`);
            return text(`任务图未通过校验,未创建:${res.error}`);
          }
          sendToRenderer(IPC.ORCH_EVENT, {
            channel: IPC.ORCH_EVENT,
            event: { kind: "plan.proposed", sessionId, run: res.run },
          });
          log.info(
            `orch_submit_plan: session ${sessionId} proposed ${res.run.tasks.length} tasks (run ${res.run.id})`,
          );
          return text(
            `任务图已提交(共 ${res.run.tasks.length} 个任务)。画布已生成,等待用户检查;不要自行执行这些任务,用一句话总结拆解思路即可。`,
          );
        },
      },
    ],
  });
}

/** MCP 工具结果的通用文本封装。 */
function text(content: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: content }] };
}
