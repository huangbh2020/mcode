/**
 * 协调者工具集(方案 B:主会话 agent 当协调者)。
 *
 * 以进程内 MCP server(createSdkMcpServer)注入协调者会话的工具:
 *   orch_list_profiles / orch_create_run / orch_get_run / orch_add_tasks /
 *   orch_wait_tasks / orch_task_control / orch_resolve_gate / orch_get_artifacts
 *
 * 语义对齐 docs/orchestration-plan.md:
 *  - 「模型提案、用户审批」:orch_create_run 创建的 run 即计划提案,
 *    renderer 的 DAG 面板/确认卡承担审批面;协调者只能等 gate/用户。
 *  - check-wait:orch_wait_tasks 阻塞到终态或超时(检查点),返回快照。
 *  - 审查者不越权:review 型任务的产出只是 findings(verdict),打回
 *    派发由服务按 verdict 自动执行,协调者不亲自改文件。
 *
 * 仅 Claude provider 接线(Pi 无 createSdkMcpServer 等价物;Pi 会话仍可
 * 通过向导 UI 发起编排,worker 本身可以是任意 provider)。
 */
import { z } from "zod";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { TaskSpecInput } from "@contracts/orchestration";
import { orchestrator } from "./OrchestratorService.js";
import { ProfileStore, RoutingStats } from "./profiles.js";
import { SessionRepo } from "@main/store/repositories.js";

type CreateMcpServer = typeof import("@anthropic-ai/claude-agent-sdk").createSdkMcpServer;

/** MCP 工具结果的通用文本封装。 */
function text(content: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: content }] };
}

function taskBrief(t: { id: string; spec: string; status: string; profileId?: string | null; failureCount?: number }): string {
  return `${t.id} [${t.status}]${t.profileId ? ` agent=${t.profileId}` : ""}${t.failureCount ? ` fails=${t.failureCount}` : ""}: ${t.spec.slice(0, 160)}`;
}

interface RunBriefShape {
  id: string;
  status: string;
  spentUsd?: number;
  budgetUsd?: number | null;
  tasks: { id: string; spec: string; status: string; profileId?: string | null; failureCount?: number; result?: { summary?: string } | null }[];
  gates?: { id: string; kind: string; status: string; question: string }[];
}

function runBrief(run: RunBriefShape): string {
  const lines = [
    `runId: ${run.id}`,
    `status: ${run.status}`,
    `cost: ${Number(run.spentUsd ?? 0).toFixed(4)}${run.budgetUsd ? ` / ${run.budgetUsd}` : ""}`,
    `tasks:`,
    ...run.tasks.map((t) => `  - ${taskBrief(t)}${t.result?.summary ? `\n    结果: ${t.result.summary.slice(0, 200)}` : ""}`),
  ];
  const open = (run.gates ?? []).filter((g) => g.status === "open");
  if (open.length > 0) {
    lines.push(`待决 gate:`);
    for (const g of open) lines.push(`  - ${g.id} (${g.kind}): ${g.question}`);
  }
  return lines.join("\n");
}

/** 解析协调者给出的任务描述(允许省略 id —— 按序补 t1..tN)。 */
const TaskInputSchema = z.object({
  spec: z.string().min(1).describe("任务简报:目标、约束、产物路径、验收标准"),
  deps: z.array(z.string()).optional().describe("依赖的任务 id 列表"),
  profileId: z.string().optional().describe("承担者 agent id(orch_list_profiles 查询)"),
  providerId: z.string().nullable().optional().describe("节点级厂商覆盖(claude-sdk/pi-sdk/codex-sdk);缺省跟随"),
  model: z.string().nullable().optional().describe("节点级模型覆盖;缺省跟随"),
  effort: z.string().nullable().optional().describe("节点级思考级别覆盖;缺省跟随默认"),
  permissionMode: z.string().nullable().optional().describe("节点级权限模式覆盖;缺省跟随默认"),
  customModelId: z.string().nullable().optional().describe("节点级模型配置覆盖(模型配置 id);缺省跟随会话默认"),
  tags: z.array(z.string()).optional().describe("能力标签(planning/coding/writing/image/review),省略 profileId 时用于路由"),
  reviewOf: z.string().optional().describe("本任务是审查哪个任务的产出"),
  variantGroup: z.string().optional().describe("多方案竞争组(同组任务各自出方案)"),
  runner: z.enum(["agent", "terminal"]).optional().describe("执行形态,默认 agent"),
  terminalCommand: z.string().optional().describe("runner=terminal 时的命令"),
});

/** 按 tags 路由 profile(用户显式指定 > 学习到的偏好 > 内置兜底)。 */
function routeProfile(tags: string[], explicit?: string): string | null {
  if (explicit) return explicit;
  for (const tag of tags) {
    const learned = RoutingStats.topProfiles(tag);
    if (learned.length > 0) return learned[0];
  }
  const profiles = ProfileStore.list();
  for (const tag of tags) {
    const hit = profiles.find((p) => p.tags.includes(tag as never));
    if (hit) return hit.id;
  }
  const impl = profiles.find((p) => p.id === "builtin-implementer");
  return impl?.id ?? profiles[0]?.id ?? null;
}

/** 异步构建(需要先加载 SDK 的 createSdkMcpServer —— 调用方是
 *  ClaudeAgentSdkProvider,它已持有 lazy-load 的构造函数)。 */
export async function buildOrchestratorMcpServerAsync(
  coordinatorSessionId: string,
  createSdkMcpServer: CreateMcpServer,
): Promise<McpSdkServerConfigWithInstance> {
  // run 的 projectId 从协调者会话行解析(创建 run 时使用)。
  return createSdkMcpServer({
    name: "mcode-orchestrator",
    version: "1.0.0",
    instructions:
      "Mcode 编排工具集:你可以作为协调者把大任务拆给多个 agent 并行/流水线执行。工作流:orch_list_profiles 查看可用角色 → orch_create_run 提交任务图(创建即开始派发,用户可在面板看到并干预)→ orch_wait_tasks 等待(check-wait,超时返回快照不是失败)→ 读取结果汇总。审查节点只报 findings,修复自动派回原实现者;连败 3 次熔断为 gate 等人决策。",
    alwaysLoad: true,
    tools: [
      {
        name: "orch_list_profiles",
        description: "列出可用的 agent 角色模板(id/名称/厂商/模型/能力标签/每百万 token 成本)。",
        inputSchema: {},
        handler: async () => {
            const list = ProfileStore.list().map(
              (p) => `${p.id} | ${p.name} | ${p.providerId}/${p.model} | tags=${p.tags.join(",")}`,
            );
          return text(list.join("\n") || "(无可用角色)");
        },
      },
      {
        name: "orch_create_run",
        description:
          "创建并启动一个编排运行(任务 DAG)。tasks 里每个任务给简报+依赖+承担者;id 可省略(自动编号)。创建后任务按依赖波次派发,并发上限默认 4。",
        inputSchema: {
          goal: z.string().min(1).describe("总体目标"),
          tasks: z.array(TaskInputSchema).min(1).describe("任务列表"),
          budgetUsd: z.number().positive().optional().describe("预算上限(美元)"),
          concurrency: z.number().int().positive().optional().describe("并发上限,默认 4"),
          worktreePolicy: z.enum(["auto", "always_new", "active_only"]).optional().describe("worktree 策略,默认 auto"),
        },
        handler: async (args: Record<string, unknown>) => {
          const session = SessionRepo.get(coordinatorSessionId);
          if (!session) return text("协调者会话不存在,无法创建编排运行。");
          const rawTasks = (args.tasks as (Record<string, unknown> & { spec: string })[]) ?? [];
          const tasks: TaskSpecInput[] = rawTasks.map((t, i) => {
            const tags = (t.tags as string[] | undefined) ?? [];
            return {
              id: `t${i + 1}`,
              spec: t.spec,
              deps: (t.deps as string[] | undefined) ?? [],
              profileId: routeProfile(tags, t.profileId as string | undefined),
              providerId: (t.providerId as string | null | undefined) ?? null,
              model: (t.model as string | null | undefined) ?? null,
              effort: (t.effort as string | null | undefined) ?? null,
              permissionMode: (t.permissionMode as string | null | undefined) ?? null,
              customModelId: (t.customModelId as string | null | undefined) ?? null,
              reviewOf: (t.reviewOf as string | undefined) ?? null,
              variantGroup: (t.variantGroup as string | undefined) ?? null,
              tags,
              runner: (t.runner as "agent" | "terminal" | undefined) ?? "agent",
              terminalCommand: t.terminalCommand as string | undefined,
            };
          });
          const res = orchestrator.createRun({
            parentSessionId: coordinatorSessionId,
            projectId: session.projectId,
            goal: args.goal as string,
            tasks,
            budgetUsd: (args.budgetUsd as number | undefined) ?? null,
            concurrency: args.concurrency as number | undefined,
            worktreePolicy: args.worktreePolicy as "auto" | "always_new" | "active_only" | undefined,
          });
          if ("error" in res) return text(`创建失败:${res.error}`);
          return text(`编排运行已创建并开始派发。\n${runBrief(res.run)}`);
        },
      },
      {
        name: "orch_get_run",
        description: "读取编排运行快照(省略 runId = 本会话最近一个 run)。",
        inputSchema: {
          runId: z.string().optional().describe("run id,省略取最近"),
        },
        handler: async (args: Record<string, unknown>) => {
          const id = (args.runId as string | undefined) ?? orchestrator.listRuns(coordinatorSessionId)[0]?.id;
          if (!id) return text("本会话还没有编排运行。");
          const run = orchestrator.getRun(id);
          return run ? text(runBrief(run)) : text(`run not found: ${id}`);
        },
      },
      {
        name: "orch_add_tasks",
        description: "向运行中的 run 追加任务(中途补充拆解)。",
        inputSchema: {
          runId: z.string().describe("目标 run id"),
          tasks: z.array(TaskInputSchema).min(1),
        },
        handler: async (args: Record<string, unknown>) => {
          const runId = args.runId as string;
          const rawTasks = (args.tasks as (Record<string, unknown> & { spec: string })[]) ?? [];
          const existing = new Set((orchestrator.getRun(runId)?.tasks ?? []).map((t) => t.id));
          const tasks: TaskSpecInput[] = rawTasks.map((t, i) => {
            const tags = (t.tags as string[] | undefined) ?? [];
            return {
              id: `n${Date.now().toString(36)}_${i + 1}`,
              spec: t.spec,
              deps: (t.deps as string[] | undefined) ?? [],
              profileId: routeProfile(tags, t.profileId as string | undefined),
              providerId: (t.providerId as string | null | undefined) ?? null,
              model: (t.model as string | null | undefined) ?? null,
              effort: (t.effort as string | null | undefined) ?? null,
              permissionMode: (t.permissionMode as string | null | undefined) ?? null,
              customModelId: (t.customModelId as string | null | undefined) ?? null,
              reviewOf: (t.reviewOf as string | undefined) ?? null,
              variantGroup: (t.variantGroup as string | undefined) ?? null,
              tags,
              runner: (t.runner as "agent" | "terminal" | undefined) ?? "agent",
              terminalCommand: t.terminalCommand as string | undefined,
            };
          });
          const res = orchestrator.addTasks(runId, tasks);
          if ("error" in res && res.error) return text(`追加失败:${res.error}`);
          return text(`已追加 ${tasks.length} 个任务。\n${runBrief(res.run!)}`);
        },
      },
      {
        name: "orch_wait_tasks",
        description:
          "等待一组任务到达终态(check-wait)。全部终态或超时到达即返回当前快照 —— 超时是检查点不是失败,应读取快照后决定继续等或介入。默认 120 秒,上限 10 分钟。",
        inputSchema: {
          runId: z.string().describe("run id"),
          taskIds: z.array(z.string()).min(1).describe("要等待的任务 id"),
          timeoutMs: z.number().int().positive().optional().describe("超时毫秒数,默认 120000"),
        },
        handler: async (args: Record<string, unknown>) => {
          const runId = args.runId as string;
          const taskIds = args.taskIds as string[];
          const timeoutMs = (args.timeoutMs as number | undefined) ?? 120_000;
          const tasks = await orchestrator.waitTasks(runId, taskIds, timeoutMs);
          if (!tasks) return text("运行已被删除。");
          const done = tasks.every((t) => isTerminal(t.status));
          return text(
            (done ? "全部到达终态。\n" : "超时(检查点):部分任务仍在运行。\n") +
              tasks.map((t) => `${taskBrief(t)}${t.result?.summary ? `\n  结果: ${t.result.summary.slice(0, 400)}` : ""}`).join("\n"),
          );
        },
      },
      {
        name: "orch_task_control",
        description: "节点控制:重试(retry)/ 换 agent 重跑(rerun,需给 profileId)/ 取消(cancel)。",
        inputSchema: {
          runId: z.string(),
          taskId: z.string(),
          action: z.enum(["retry", "rerun", "cancel"]),
          profileId: z.string().optional().describe("action=rerun 时的新 agent id"),
        },
        handler: async (args: Record<string, unknown>) => {
          const res = orchestrator.taskControl(
            args.runId as string,
            args.taskId as string,
            args.action as "retry" | "rerun" | "cancel",
            args.profileId as string | null | undefined,
          );
          if (res.error) return text(`操作失败:${res.error}`);
          return text(`已执行 ${args.action}。\n${runBrief(res.run!)}`);
        },
      },
      {
        name: "orch_resolve_gate",
        description: "解决一个待决决策门(escalation/budget/review_pick)。resolution 必须是 gate 列出的选项之一(择优 gate 为任务 id)。",
        inputSchema: {
          runId: z.string(),
          gateId: z.string(),
          resolution: z.string().min(1),
        },
        handler: async (args: Record<string, unknown>) => {
          const res = orchestrator.resolveGate(
            args.runId as string,
            args.gateId as string,
            args.resolution as string,
          );
          if (res.error) return text(`解决失败:${res.error}`);
          return text("gate 已解决。");
        },
      },
      {
        name: "orch_get_artifacts",
        description: "读取任务的产物(修改文件清单 + 结果摘要)。",
        inputSchema: {
          runId: z.string(),
          taskId: z.string(),
        },
        handler: async (args: Record<string, unknown>) => {
          const run = orchestrator.getRun(args.runId as string);
          const task = run?.tasks.find((t) => t.id === (args.taskId as string));
          if (!task) return text("task not found");
          const lines = [
            `状态: ${task.status}`,
            `修改文件(${task.result?.filesModified?.length ?? 0}):`,
            ...(task.result?.filesModified ?? []).map((f) => `  - ${f}`),
            task.result?.summary ? `摘要:\n${task.result.summary}` : "",
          ];
          return text(lines.filter(Boolean).join("\n"));
        },
      },
    ],
  });
}

function isTerminal(s: string): boolean {
  return s === "completed" || s === "failed" || s === "blocked" || s === "canceled" || s === "superseded";
}
