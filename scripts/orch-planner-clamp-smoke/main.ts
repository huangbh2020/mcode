/**
 * Headless smoke for the auto-decompose node-config pipeline (see run.sh).
 *
 * Drives the REAL ORCH_PROPOSE_PLAN handler end to end: model surface build
 * (pi/codex hydration + registry merge), planner prompt rendering, proposal
 * parsing, and the per-node whitelist clamp + 缺省补值链 (「必须要有值」:
 * clamped/dropped fields refill from the node → profile → coordinator chain
 * of USER-CONFIGURED values; claude models re-attribute to their owning
 * gateway config). Every runtime dependency is aliased to stubs.ts; the fake
 * SDK query() replays a canned proposal that mixes legal and illegal
 * provider/model/effort/permissionMode values.
 */
import { registerOrchestratorHandlers } from "@main/ipc/orchestrator.js";
import { IPC } from "@contracts/ipc";
import { setPlannerReply, lastQueryPrompt, lastQuerySystemPrompt, lastQueryIncludePartial, pushedEvents } from "./stubs.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`ok - ${name}`);
  } else {
    failures++;
    console.error(`FAIL - ${name}`, detail === undefined ? "" : JSON.stringify(detail));
  }
}

const handlers = new Map<string, (evt: unknown, raw: unknown) => Promise<unknown>>();
registerOrchestratorHandlers({
  handle: (ch: string, fn: (evt: unknown, raw: unknown) => Promise<unknown>) => handlers.set(ch, fn),
} as never);

// Coordinator session carries customModelId "cfg1" (models: deepseek-v4-pro,
// glm-5) — claude-sdk worker nodes inherit it by default, but the planner's
// model ELECTION may land nodes on ANY configured config (cfg1/cfg2 pair).
// Official aliases like "sonnet" must clamp to null.
const proposal = {
  tasks: [
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
  ],
};
setPlannerReply(JSON.stringify(proposal));

const res = (await handlers.get(IPC.ORCH_PROPOSE_PLAN)(null, {
  sessionId: "s1",
  goal: "demo goal",
})) as { tasks: Array<Record<string, unknown>>; error?: string };

check("handler returns without error", !res.error, res.error);
check("all 13 tasks came back", res.tasks.length === 13, res.tasks.length);
check("handler returns the planner's effective model", res.model === "stub-model", res.model);

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

// Prompt-side assertions: configured models listed PER CONFIG (with cfgId for
// pair references), claude builtin aliases hidden while the session rides a
// gateway, election duty stated, and the pi hydration survives the registry
// merge. 「执行配置必填」规范:格式样例不再出现 null 占位,user/system 两层
// 提示词都要求每个节点给出全部执行配置字段。
const prompt = lastQueryPrompt;
const claudeLine = prompt.split("\n").find((l) => l.trim().startsWith("claude-sdk:")) ?? "";
check("prompt lists claude effort values", prompt.includes("effort 可选: default/low/medium/high/xhigh/max"), prompt);
check("prompt lists codex modes incl. full-access (no longer forbidden)", prompt.includes("permissionMode 可选: read-only/default/full-access"), prompt);
check("prompt keeps hydrated pi composite models (registry merge)", prompt.includes("pi-remote/pi-large"), prompt);
check("claude line lists configured models per config with cfgId", claudeLine.includes("配置「主网关」(cfg1): deepseek-v4-pro, glm-5") && claudeLine.includes("配置「备用网关」(cfg2): other-gateway-model"), claudeLine);
check("claude builtin aliases hidden while session rides a gateway", !claudeLine.includes("sonnet") && !claudeLine.includes("builtin:"), claudeLine);
check("prompt states the election duty", prompt.includes("【模型选举】"), prompt);
check("prompt mandates concrete node exec config (no null)", prompt.includes("【执行配置必填】") && prompt.includes("绝不允许写 null"), prompt);
check("prompt restricts values to the configured lists", prompt.includes("只能逐字取自上面列出的清单"), prompt);
check("prompt format sample carries concrete field placeholders", prompt.includes('"providerId":"<厂商 id>"') && prompt.includes('"customModelId":"<配置 id 或 null>"'), prompt.slice(0, 500));
check("prompt keeps the claude triple-pairing rule", prompt.includes('"providerId":"claude-sdk","customModelId"'), prompt);
check("system prompt mandates mandatory exec fields", lastQuerySystemPrompt.includes("都必须给出 providerId、model、effort、permissionMode 的明确值") && lastQuerySystemPrompt.includes("禁止 null、禁止省略、禁止自造"), lastQuerySystemPrompt);

// ── planner 过程流(includePartialMessages → orch:event 的 planner.delta)──
check("query ran with includePartialMessages on", lastQueryIncludePartial, lastQueryIncludePartial);
const deltas = pushedEvents
  .map((p) => p.event as { kind?: string; sessionId?: string; seg?: string; text?: string })
  .filter((e) => e.kind === "planner.delta");
check("3 planner deltas were pushed (1 thinking + 2 text)", deltas.length === 3, deltas.length);
check(
  "thinking delta carries sessionId + seg=thinking",
  deltas[0]?.sessionId === "s1" && deltas[0]?.seg === "thinking" && deltas[0]?.text === "思考中:",
  deltas[0],
);
check(
  "text deltas concatenate to the full proposal text",
  deltas[1]?.seg === "text" &&
    deltas[2]?.seg === "text" &&
    (deltas[1]?.text ?? "") + (deltas[2]?.text ?? "") === JSON.stringify(proposal),
  [deltas[1]?.text, deltas[2]?.text],
);
check(
  "all deltas ride the orchestrator:event channel",
  pushedEvents.every((p) => p.channel === IPC.ORCH_EVENT),
  pushedEvents.map((p) => p.channel),
);

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nall assertions passed");
