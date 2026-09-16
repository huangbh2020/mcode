/**
 * Agent 编排域契约（Orchestration domain contracts）。
 *
 * 语义模型来自 Orca（所有权二分 / 完成权威 / decision gate / 运行纪律），
 * 传输层按 Mcode 的结构化架构重设计：
 *  - 编排层是"哑"基础设施：任务表（DAG + 状态机）、消息、决策门、派发器、
 *    阻塞等待；拆解智能在协调者（主会话 agent 或内置向导）。
 *  - 监督编排（Supervised，建任务行、等 worker_done）与完全移交（Handoff，
 *    不建任务行、不追踪）在协议层就是两种形态。
 *  - 完成权威：完成凭证 = runId + taskId + dispatchId + coordinatorSessionId，
 *    worker 的完成由基础设施从结构化事件（turn.done / turn.files /
 *    token-usage）推导，worker 无需感知编排协议。
 *  - 心跳 ≠ 完成；等待超时是检查点不是失败。
 */
import { z } from "zod";

/* ------------------------------------------------------------------ */
/* AgentProfile — 用户定义的"角色"模板                                 */
/* ------------------------------------------------------------------ */

export const AgentProfileTagSchema = z.enum([
  "planning",
  "coding",
  "writing",
  "image",
  "review",
  "testing",
  "generic",
]);
export type AgentProfileTag = z.infer<typeof AgentProfileTagSchema>;

export const WorktreePreferenceSchema = z.enum(["active", "new", "none"]);
export type WorktreePreference = z.infer<typeof WorktreePreferenceSchema>;

export const AgentProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** 展示用 emoji/tabler 图标名（简单起见存 emoji 或空）。 */
  icon: z.string().default("🤖"),
  /** 主题色（tailwind 调色板名或 hex）。 */
  color: z.string().default("sky"),
  providerId: z.string().default("claude-sdk"),
  model: z.string().default("default"),
  effort: z.string().default("default"),
  /** 角色指令：作为 worker 简报的 system 段注入。 */
  systemPrompt: z.string().default(""),
  /** 工具白名单（空 = 不限制；仅对支持的工具集生效的提示性约束）。 */
  allowedTools: z.array(z.string()).default([]),
  permissionMode: z.string().default("default"),
  defaultWorktree: WorktreePreferenceSchema.default("none"),
  tags: z.array(AgentProfileTagSchema).default(["generic"]),
  /** 内置模板标记：内置模板可被用户覆盖，但不允许删除原始定义。 */
  builtin: z.boolean().default(false),
  createdAt: z.number().default(0),
  updatedAt: z.number().default(0),
});
export type AgentProfile = z.infer<typeof AgentProfileSchema>;

/* ------------------------------------------------------------------ */
/* 任务图（TaskGraph）                                                 */
/* ------------------------------------------------------------------ */

export const TaskStatusSchema = z.enum([
  "pending", // 等待依赖
  "ready", // 依赖满足，可派发
  "dispatched", // 已派发（worker 会话已建/简报已注入）
  "running", // worker 回合运行中
  "completed",
  "failed",
  "blocked", // 熔断/超限，等待人工决策（gate）
  "paused", // 用户暂停
  "canceled",
  "superseded", // 多方案竞争中被淘汰
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskVerdictSchema = z.enum(["pass", "fail", "changes_requested"]);
export type TaskVerdict = z.infer<typeof TaskVerdictSchema>;

export const TaskResultSchema = z.object({
  summary: z.string().optional(),
  /** worker 报告文件（worker 会话最终回复全文/终端日志）的落盘路径。 */
  reportPath: z.string().optional(),
  filesModified: z.array(z.string()).default([]),
  /** 审查节点的结论；review 型任务完成时由协调者/用户标注。 */
  verdict: TaskVerdictSchema.optional(),
  /** 终端 worker 的退出码。 */
  exitCode: z.number().optional(),
  usage: z
    .object({
      inputTokens: z.number().default(0),
      outputTokens: z.number().default(0),
      costUsd: z.number().default(0),
    })
    .optional(),
});
export type TaskResult = z.infer<typeof TaskResultSchema>;

export const DispatchRecordSchema = z.object({
  dispatchId: z.string(),
  workerSessionId: z.string(),
  injectedAt: z.number(),
  endedAt: z.number().optional(),
  outcome: z.enum(["done", "failed", "canceled"]).optional(),
});
export type DispatchRecord = z.infer<typeof DispatchRecordSchema>;

export const TaskRunnerSchema = z.enum(["agent", "terminal"]);
export type TaskRunner = z.infer<typeof TaskRunnerSchema>;

export const TaskNodeSchema = z.object({
  id: z.string().min(1),
  /** 任务简报（目标/约束/产物路径/验收标准 —— 模板化，不传完整对话）。 */
  spec: z.string().min(1),
  deps: z.array(z.string()).default([]),
  /** 承担者 AgentProfile id；runner=terminal 时可为空。 */
  profileId: z.string().nullable().default(null),
  /** 节点级模型配置覆盖（CustomModelMeta id）；null = 跟随会话默认。 */
  customModelId: z.string().nullable().default(null),
  /** 节点级厂商覆盖（provider id，如 claude-sdk/pi-sdk）；null = 跟随。 */
  providerId: z.string().nullable().default(null),
  /** 节点级模型覆盖；null = 跟随。 */
  model: z.string().nullable().default(null),
  /** 节点级思考级别覆盖；null = 跟随默认。 */
  effort: z.string().nullable().default(null),
  /** 节点级权限模式覆盖；null = 跟随默认。 */
  permissionMode: z.string().nullable().default(null),
  status: TaskStatusSchema.default("pending"),
  artifacts: z.array(z.string()).default([]),
  result: TaskResultSchema.nullable().default(null),
  failureCount: z.number().int().nonnegative().default(0),
  dispatches: z.array(DispatchRecordSchema).default([]),
  /** 该节点独占的 worktree（materialized 路径）。 */
  worktreePath: z.string().nullable().default(null),
  /** 审查回路：本节点审查的目标任务。 */
  reviewOf: z.string().nullable().default(null),
  reviewRound: z.number().int().nonnegative().default(0),
  /** 多方案竞争：同组 variant 任务共享一个 variantGroup id。 */
  variantGroup: z.string().nullable().default(null),
  tags: z.array(z.string()).default([]),
  /** 执行形态：agent = 子会话 worker；terminal = 直接跑命令（逃生舱）。 */
  runner: TaskRunnerSchema.default("agent"),
  /** runner=terminal 时的命令模板。 */
  terminalCommand: z.string().optional(),
  /** 预估 token（向导展示用）。 */
  estTokens: z.number().optional(),
});
export type TaskNode = z.infer<typeof TaskNodeSchema>;

/* ------------------------------------------------------------------ */
/* 决策门（Gate）                                                      */
/* ------------------------------------------------------------------ */

export const GateKindSchema = z.enum([
  "ask", // worker 的 AskUserQuestion 转译
  "escalation", // 熔断/重试升级：等人决策
  "budget", // 成本超限暂停
  "review_pick", // 多方案竞争择优
  "confirm_plan", // 向导确认卡片
]);
export type GateKind = z.infer<typeof GateKindSchema>;

export const GateStatusSchema = z.enum(["open", "resolved", "canceled"]);
export type GateStatus = z.infer<typeof GateStatusSchema>;

export const GateSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().nullable().default(null),
  kind: GateKindSchema,
  question: z.string().min(1),
  options: z.array(z.string()).default([]),
  status: GateStatusSchema.default("open"),
  /** 用户/协调者选择或自由回答。 */
  resolution: z.string().optional(),
  createdAt: z.number(),
  resolvedAt: z.number().optional(),
  /** 关联的 question.ask requestId（ask 型 gate 回答时路由回 worker）。 */
  requestId: z.string().optional(),
  /** 产生 gate 的 worker 会话（ask/escalation）。 */
  workerSessionId: z.string().optional(),
});
export type Gate = z.infer<typeof GateSchema>;

/* ------------------------------------------------------------------ */
/* OrchestrationRun                                                    */
/* ------------------------------------------------------------------ */

export const RunStatusSchema = z.enum([
  "planning",
  "running",
  "paused",
  "completed",
  "failed",
  "canceled",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const WorktreePolicySchema = z.enum(["auto", "always_new", "active_only"]);
export type WorktreePolicy = z.infer<typeof WorktreePolicySchema>;

export const OrchestrationRunSchema = z.object({
  id: z.string().min(1),
  /** 协调者会话（作用域 = 父会话，非全局）。 */
  parentSessionId: z.string().min(1),
  projectId: z.string().min(1),
  title: z.string().default(""),
  goal: z.string().default(""),
  status: RunStatusSchema.default("planning"),
  tasks: z.array(TaskNodeSchema).default([]),
  gates: z.array(GateSchema).default([]),
  /** 预算上限（美元；null = 不设限）。 */
  budgetUsd: z.number().positive().nullable().default(null),
  /** 累计已花费（按 provider/会话 token 估算）。 */
  spentUsd: z.number().nonnegative().default(0),
  concurrency: z.number().int().positive().default(4),
  worktreePolicy: WorktreePolicySchema.default("auto"),
  /** reviewer 打回硬上限（默认 3）。 */
  reviewLoopLimit: z.number().int().positive().default(3),
  /** worker 心跳：sessionId → 最近一次活动时间戳。 */
  heartbeat: z.record(z.string(), z.number()).default({}),
  templateId: z.string().nullable().default(null),
  /** 结果整理回合已派发的时间（一次性闩，防 checkRunCompletion 重入）。 */
  synthesizedAt: z.number().nullable().default(null),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type OrchestrationRun = z.infer<typeof OrchestrationRunSchema>;

/** 创建 run 的输入（向导/协调者工具共用）。tasks 为骨架（无 status 等运行态）。 */
export const TaskSpecInputSchema = z.object({
  id: z.string().min(1),
  spec: z.string().min(1),
  deps: z.array(z.string()).default([]),
  profileId: z.string().nullable().default(null),
  /** 节点级模型配置覆盖（CustomModelMeta id）；null = 跟随会话默认。 */
  customModelId: z.string().nullable().default(null),
  providerId: z.string().nullable().default(null),
  model: z.string().nullable().default(null),
  effort: z.string().nullable().default(null),
  permissionMode: z.string().nullable().default(null),
  reviewOf: z.string().nullable().default(null),
  variantGroup: z.string().nullable().default(null),
  tags: z.array(z.string()).default([]),
  runner: TaskRunnerSchema.default("agent"),
  terminalCommand: z.string().optional(),
});
export type TaskSpecInput = z.infer<typeof TaskSpecInputSchema>;

/* ------------------------------------------------------------------ */
/* 派发上下文（完成权威凭证，结构化注入 worker 会话）                    */
/* ------------------------------------------------------------------ */

export const DispatchContextSchema = z.object({
  runId: z.string(),
  taskId: z.string(),
  dispatchId: z.string(),
  coordinatorSessionId: z.string(),
});
export type DispatchContext = z.infer<typeof DispatchContextSchema>;

/** worker 完成凭证（基础设施从结构化事件推导，精确一次）。 */
export interface WorkerDonePayload {
  runId: string;
  taskId: string;
  dispatchId: string;
  coordinatorSessionId: string;
  status: "done" | "failed";
  summary: string;
  filesModified: string[];
  reportPath?: string;
  usage?: { inputTokens: number; outputTokens: number; costUsd: number };
}

/* ------------------------------------------------------------------ */
/* 编排模板（pipeline 保存复用 / 竞争 / fan-out）                       */
/* ------------------------------------------------------------------ */

export const OrchestrationTemplateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(""),
  builtin: z.boolean().default(false),
  /** 任务占位：spec 中的 {goal} 会被替换为运行目标。 */
  tasks: z.array(TaskSpecInputSchema).default([]),
  /** 默认预算/并发等覆盖。 */
  budgetUsd: z.number().positive().nullable().default(null),
  concurrency: z.number().int().positive().default(4),
  worktreePolicy: WorktreePolicySchema.default("auto"),
  createdAt: z.number().default(0),
  updatedAt: z.number().default(0),
});
export type OrchestrationTemplate = z.infer<typeof OrchestrationTemplateSchema>;

/* ------------------------------------------------------------------ */
/* 编排设置（触发档位等）                                              */
/* ------------------------------------------------------------------ */

export const OrchTriggerModeSchema = z.enum(["off", "ask", "auto"]);
export type OrchTriggerMode = z.infer<typeof OrchTriggerModeSchema>;

export const OrchSettingsSchema = z.object({
  /** 编排触发三档，默认"询问我"。 */
  triggerMode: OrchTriggerModeSchema.default("ask"),
  /** 默认并发上限。 */
  concurrency: z.number().int().positive().default(4),
  /** 默认预算（美元；0 = 不设限）。 */
  budgetUsd: z.number().nonnegative().default(0),
});
export type OrchSettings = z.infer<typeof OrchSettingsSchema>;

/* ------------------------------------------------------------------ */
/* 推送事件（orchestrator:event → renderer）                            */
/* ------------------------------------------------------------------ */

export type OrchestratorEvent =
  | { kind: "run.updated"; run: OrchestrationRun }
  | { kind: "gate.created"; runId: string; gate: Gate }
  | { kind: "gate.resolved"; runId: string; gateId: string; resolution: string }
  | { kind: "worker_done"; payload: WorkerDonePayload }
  | { kind: "suggest"; sessionId: string; reason: string };
