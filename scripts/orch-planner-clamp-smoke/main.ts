/**
 * Headless smoke for the in-session auto-decompose pipeline (see run.sh).
 *
 * Drives the REAL orch_submit_plan tool handler (orchestrator/planTool.ts)
 * end to end: model surface build (pi/codex hydration + registry merge), the
 * planner nudge rendering, per-node whitelist clamp + 缺省补值链(「必须要有值」:
 * clamped/dropped fields refill from the node → profile → coordinator chain
 * of USER-CONFIGURED values; claude models re-attribute to their owning
 * gateway config), run creation (paused), and the plan.proposed push.
 * Every runtime dependency is aliased to stubs.ts; the fake SDK
 * createSdkMcpServer hands the tool list back so the handler is invoked
 * directly — exactly what the model's tool call does in production.
 */
import {
  buildOrchPlanMcpServerAsync,
  buildOrchPlanNudge,
  ORCH_PLAN_TOOL_NAME,
  ORCH_PLAN_TOOL_FULL,
} from "@main/orchestrator/planTool.js";
import { IPC } from "@contracts/ipc";
import { pushedEvents } from "./stubs.js";
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`ok - ${name}`);
  } else {
    failures++;
    console.error(`FAIL - ${name}`, detail === undefined ? "" : JSON.stringify(detail));
  }
}

// Coordinator session carries customModelId "cfg1" (models: deepseek-v4-pro,
// glm-5) — claude-sdk worker nodes inherit it by default, but the planner's
// model ELECTION may land nodes on ANY configured config (cfg1/cfg2 pair).
// Official aliases like "sonnet" must clamp to null.
const tasks = [
  { spec: "valid claude custom", providerId: "claude-sdk", model: "deepseek-v4-pro", effort: "high", permissionMode: "acceptEdits", profileId: "builtin-implementer", tags: ["coding"] },
  { spec: "claude official alias on gateway", providerId: "claude-sdk", model: "sonnet", effort: "ultra", permissionMode: "bypassPermissions" },
  { spec: "unknown provider", providerId: "gemini-sdk", model: "pro", effort: "high", permissionMode: "default" },
  { spec: "effort without provider", effort: "high", permissionMode: "plan" },
  { spec: "valid codex", providerId: "codex-sdk", model: "gpt-5.2-codex", effort: "ultra", permissionMode: "read-only" },
  { spec: "codex full-access denied", providerId: "codex-sdk", effort: "high", permissionMode: "full-access", model: "nope-model" },
  { spec: "valid pi composite model", providerId: "pi-sdk", model: "pi-remote/pi-large", effort: "off", permissionMode: "default" },
  { spec: "lone provider override", providerId: "claude-sdk" },
  // ── 模型选举(已配置模型中选) ──
  { spec: "explicit pair on the OTHER config", providerId: "claude-sdk", customModelId: "cfg2", model: "other-gateway-model" },
  { spec: "bogus cfg id falls back to model election", providerId: "claude-sdk", customModelId: "bogus", model: "glm-5" },
  { spec: "valid cfg + bogus model keeps cfg", providerId: "claude-sdk", customModelId: "cfg1", model: "not-in-cfg" },
  { spec: "model-only election finds its config", providerId: "claude-sdk", model: "glm-5" },
  { spec: "non-claude node drops customModelId", providerId: "pi-sdk", customModelId: "cfg1", model: "pi-remote/pi-large" },
];

// ── MCP server 形状:服务名/工具名/alwaysLoad,handler 可直接调用。 ──
const server = await buildOrchPlanMcpServerAsync("s1", createSdkMcpServer);
check("server registered under the orchestrator name", server.name === "mcode-orchestrator", server.name);
const tool = server.tools.find((x) => x.name === ORCH_PLAN_TOOL_NAME);
check("submit tool present", !!tool, server.tools.map((x) => x.name));

const receipt = await tool!.handler({ goal: "demo goal", tasks });
const receiptText = receipt.content[0]?.text ?? "";
check("receipt reports the submitted task count", receiptText.includes("共 13 个任务"), receiptText);

// ── plan.proposed 推送:run 创建在 main 侧一次完成(planning 态)。 ──
const proposed = pushedEvents
  .map((p) => p.event as { kind?: string; sessionId?: string; run?: Record<string, unknown> })
  .filter((e) => e.kind === "plan.proposed");
check("exactly one plan.proposed pushed", proposed.length === 1, proposed.length);
const run = proposed[0]?.run ?? {};
check("plan.proposed carries the session id", proposed[0]?.sessionId === "s1", proposed[0]?.sessionId);
check("run created paused (planning)", run.status === "planning", run.status);
check("run goal is the submitted goal", run.goal === "demo goal", run.goal);

const res = { tasks: (run.tasks as Array<Record<string, unknown>>) ?? [] };
check("handler returns without error", receiptText.includes("已提交"), receiptText);
check("all 13 tasks came back", res.tasks.length === 13, res.tasks.length);

const t = (i: number) => res.tasks[i] ?? {};
const ids = res.tasks.map((x) => x.id);
check("ids renumbered t1..t13", ids.join(",") === "t1,t2,t3,t4,t5,t6,t7,t8,t9,t10,t11,t12,t13", ids);

// ── 「必须要有值」:白名单钳掉非法值后,空字段沿 节点 → profile → 协调者
//    的已配置链补齐(claude 模型再归属到所属网关配置)——任何节点都不再
//    携带整段空配置。
check(
  "t1: legal claude custom model + effort + safe mode all kept, elected onto cfg1",
  t(0).providerId === "claude-sdk" && t(0).model === "deepseek-v4-pro" && t(0).effort === "high" && t(0).permissionMode === "acceptEdits" && t(0).customModelId === "cfg1",
  t(0),
);
check(
  "t1: profileId/tags pass through",
  t(0).profileId === "builtin-implementer" && Array.isArray(t(0).tags) && (t(0).tags as string[])[0] === "coding",
  t(0),
);
check(
  "t2: alias clamps then refills from the coordinator's configured model on cfg1, ultra falls back to high",
  t(1).providerId === "claude-sdk" && t(1).model === "deepseek-v4-pro" && t(1).customModelId === "cfg1" && t(1).effort === "high" && t(1).permissionMode === "bypassPermissions",
  t(1),
);
check(
  "t3: fabricated provider falls through to the coordinator's concrete config (claude-sdk/cfg1), valid effort+mode kept",
  t(2).providerId === "claude-sdk" && t(2).model === "deepseek-v4-pro" && t(2).customModelId === "cfg1" && t(2).effort === "high" && t(2).permissionMode === "default",
  t(2),
);
check(
  "t4: omitted providerId fills to claude-sdk + coordinator model, explicit plan mode kept",
  t(3).providerId === "claude-sdk" && t(3).model === "deepseek-v4-pro" && t(3).customModelId === "cfg1" && t(3).effort === "high" && t(3).permissionMode === "plan",
  t(3),
);
check(
  "t5: legal codex model + ultra + read-only kept, no customModelId",
  t(4).providerId === "codex-sdk" && t(4).model === "gpt-5.2-codex" && t(4).effort === "ultra" && t(4).permissionMode === "read-only" && t(4).customModelId === null,
  t(4),
);
check(
  "t6: codex unknown model refills from the codex bucket's only configured model, full-access electable",
  t(5).providerId === "codex-sdk" && t(5).permissionMode === "full-access" && t(5).model === "gpt-5.2-codex" && t(5).effort === "high" && t(5).customModelId === null,
  t(5),
);
check(
  "t7: pi composite model + off level kept",
  t(6).providerId === "pi-sdk" && t(6).model === "pi-remote/pi-large" && t(6).effort === "off" && t(6).permissionMode === "default",
  t(6),
);
check(
  "t8: lone providerId refills coordinator model + cfg1, defaults to high effort + no-prompt permission",
  t(7).providerId === "claude-sdk" && t(7).model === "deepseek-v4-pro" && t(7).customModelId === "cfg1" && t(7).effort === "high" && t(7).permissionMode === "bypassPermissions",
  t(7),
);
check(
  "t9: explicit pair on cfg2 kept verbatim (cross-config election)",
  t(8).providerId === "claude-sdk" && t(8).customModelId === "cfg2" && t(8).model === "other-gateway-model",
  t(8),
);
check(
  "t10: bogus cfg id dropped, model re-elected onto cfg1",
  t(9).providerId === "claude-sdk" && t(9).customModelId === "cfg1" && t(9).model === "glm-5",
  t(9),
);
check(
  "t11: valid cfg + bogus model keeps cfg, model refills from the coordinator's cfg1 model",
  t(10).providerId === "claude-sdk" && t(10).customModelId === "cfg1" && t(10).model === "deepseek-v4-pro",
  t(10),
);
check(
  "t12: model-only election lands on the owning config",
  t(11).providerId === "claude-sdk" && t(11).model === "glm-5" && t(11).customModelId === "cfg1",
  t(11),
);
check(
  "t13: pi node drops customModelId (claude-only field), model kept",
  t(12).providerId === "pi-sdk" && t(12).customModelId === null && t(12).model === "pi-remote/pi-large",
  t(12),
);

// ── 规划者 nudge(系统提示段):工具全名、按配置列出的模型面、选举职责、
//    执行配置必填规范、会话上下文修订语义。 ──
const nudge = await buildOrchPlanNudge("s1");
check("nudge names the submit tool by full id", nudge.includes(ORCH_PLAN_TOOL_FULL), ORCH_PLAN_TOOL_FULL);
check("nudge lists claude effort values", nudge.includes("effort 可选: default/low/medium/high/xhigh/max"), nudge);
check("nudge lists codex modes incl. full-access (no longer forbidden)", nudge.includes("permissionMode 可选: read-only/default/full-access"), nudge);
check("nudge keeps hydrated pi composite models (registry merge)", nudge.includes("pi-remote/pi-large"), nudge);
check("nudge lists configured models per config with cfgId", nudge.includes("配置「主网关」(cfg1): deepseek-v4-pro, glm-5") && nudge.includes("配置「备用网关」(cfg2): other-gateway-model"), nudge);
check("claude builtin aliases hidden while session rides a gateway", !nudge.includes("builtin: sonnet"), nudge);
check("nudge states the election duty", nudge.includes("【模型选举】"), nudge);
check("nudge mandates concrete node exec config (no null)", nudge.includes("绝不允许 null、省略或留空"), nudge);
check("nudge restricts values to the configured lists", nudge.includes("逐字取自上面清单"), nudge);
check("nudge instructs full-graph revision from session context", nudge.includes("修订后的【完整】任务图"), nudge);
check("nudge forbids executing the tasks itself", nudge.includes("绝不亲自执行这些任务"), nudge);
check("nudge keeps the planner out of Q&A turns", nudge.includes("不要调用该工具"), nudge);
check(
  "all pushes ride the orchestrator:event channel",
  pushedEvents.every((p) => p.channel === IPC.ORCH_EVENT),
  pushedEvents.map((p) => p.channel),
);

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nall assertions passed");
