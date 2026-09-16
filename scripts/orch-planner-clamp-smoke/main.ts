/**
 * Headless smoke for the auto-decompose node-config pipeline (see run.sh).
 *
 * Drives the REAL ORCH_PROPOSE_PLAN handler end to end: model surface build
 * (pi/codex hydration + registry merge), planner prompt rendering, proposal
 * parsing, and the per-node whitelist clamp. Every runtime dependency is
 * aliased to stubs.ts; the fake SDK query() replays a canned proposal that
 * mixes legal and illegal provider/model/effort/permissionMode values.
 */
import { registerOrchestratorHandlers } from "@main/ipc/orchestrator.js";
import { IPC } from "@contracts/ipc";
import { setPlannerReply, lastQueryPrompt } from "./stubs.js";

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
// glm-5) — claude-sdk worker nodes inherit it, so official aliases like
// "sonnet" must clamp to null.
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
  ],
};
setPlannerReply(JSON.stringify(proposal));

const res = (await handlers.get(IPC.ORCH_PROPOSE_PLAN)(null, {
  sessionId: "s1",
  goal: "demo goal",
})) as { tasks: Array<Record<string, unknown>>; error?: string };

check("handler returns without error", !res.error, res.error);
check("all 8 tasks came back", res.tasks.length === 8, res.tasks.length);

const t = (i: number) => res.tasks[i] ?? {};
const ids = res.tasks.map((x) => x.id);
check("ids renumbered t1..t8", ids.join(",") === "t1,t2,t3,t4,t5,t6,t7,t8", ids);

check(
  "t1: legal claude custom model + effort + safe mode all kept",
  t(0).providerId === "claude-sdk" && t(0).model === "deepseek-v4-pro" && t(0).effort === "high" && t(0).permissionMode === "acceptEdits",
  t(0),
);
check(
  "t1: profileId/tags pass through",
  t(0).profileId === "builtin-implementer" && Array.isArray(t(0).tags) && (t(0).tags as string[])[0] === "coding",
  t(0),
);
check(
  "t2: official alias / unknown level / bypass all clamp, providerId kept",
  t(1).providerId === "claude-sdk" && t(1).model === null && t(1).effort === null && t(1).permissionMode === null,
  t(1),
);
check(
  "t3: unknown provider clears everything",
  t(2).providerId === null && t(2).model === null && t(2).effort === null && t(2).permissionMode === null,
  t(2),
);
check(
  "t4: level/mode without providerId cleared",
  t(3).providerId === null && t(3).effort === null && t(3).permissionMode === null,
  t(3),
);
check(
  "t5: legal codex model + ultra + read-only kept",
  t(4).providerId === "codex-sdk" && t(4).model === "gpt-5.2-codex" && t(4).effort === "ultra" && t(4).permissionMode === "read-only",
  t(4),
);
check(
  "t6: full-access and unknown model clamp, legal codex effort kept",
  t(5).providerId === "codex-sdk" && t(5).permissionMode === null && t(5).model === null && t(5).effort === "high",
  t(5),
);
check(
  "t7: pi composite model + off level kept",
  t(6).providerId === "pi-sdk" && t(6).model === "pi-remote/pi-large" && t(6).effort === "off" && t(6).permissionMode === "default",
  t(6),
);
check(
  "t8: lone providerId kept, rest null (follow session default)",
  t(7).providerId === "claude-sdk" && t(7).model === null && t(7).effort === null && t(7).permissionMode === null,
  t(7),
);

// Prompt-side assertions: capability lines rendered per provider, dangerous
// modes filtered out, and the pi hydration survives the registry merge.
const prompt = lastQueryPrompt;
check("prompt lists claude effort values", prompt.includes("effort 可选: default/low/medium/high/xhigh/max"), prompt);
check("prompt lists codex read-only but not full-access", prompt.includes("permissionMode 可选: read-only/default") && !prompt.includes("full-access"), prompt);
check("prompt keeps hydrated pi composite models (registry merge)", prompt.includes("pi-remote/pi-large"), prompt);
check("prompt keeps claude gateway models", prompt.includes("deepseek-v4-pro"), prompt);
check("prompt output format mentions node config fields", prompt.includes('"providerId":null,"model":null,"effort":null,"permissionMode":null'), prompt);

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nall assertions passed");
