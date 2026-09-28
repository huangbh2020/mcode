/**
 * Headless smoke for the per-model thinking declarations (issue #10):
 *
 *  - contracts/customModel: inferModelThinking's provider keyword table
 *    (incl. hostname-only matching & the unknown→none default),
 *    resolveModelThinking's explicit-declaration-wins rule,
 *    effortLevelValuesForModel's level sets per mode, and the save schema's
 *    thinking shape;
 *  - bridge requestTranslator: applyThinkingControl's per-mode field
 *    emission and its drop-unknown-level guard;
 *  - customEnv buildCustomEnv: the x-mcode-effort internal header on
 *    openai-protocol configs (inherited-env merge, invalid value dropped,
 *    anthropic protocol untouched);
 *  - renderer thinkingLevels: resolveEffortLevels' model-scoped filtering.
 *
 * Pure functions — bundled with esbuild and run in Node, no stubs needed.
 */
import {
  inferModelThinking,
  resolveModelThinking,
  effortLevelValuesForModel,
  reasoningEffortLevels,
  type CustomModelEntry,
  type CustomModelThinkingMode,
  type ApiConfig,
} from "@contracts/customModel";
import { SaveCustomModelSchema } from "@contracts/ipc";
import { applyThinkingControl } from "@main/providers/bridge/requestTranslator.js";
import type { OpenAIRequest } from "@main/providers/bridge/types.js";
import { BridgeRegistry } from "@main/providers/bridge/bridgeRegistry.js";
import { buildCustomEnv } from "@main/providers/claude-sdk/customEnv.js";
import { MCODE_EFFORT_HEADER } from "@main/providers/upstreamHeaders.js";
import { resolveEffortLevels } from "@renderer/lib/thinkingLevels.js";
import type { ThinkingLevelOption } from "@contracts/provider";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean): void {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`FAIL: ${name}`);
  }
}

function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/* ── inferModelThinking: keyword table ── */
check("infer: qwen host", inferModelThinking("https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen3-max").mode === "enable_thinking");
check("infer: qwen model id", inferModelThinking("https://gw.example.com/v1", "Qwen3-235B-A22B").mode === "enable_thinking");
check("infer: openai host", inferModelThinking("https://api.openai.com/v1", "whatever").mode === "reasoning_effort");
check("infer: openrouter host", inferModelThinking("https://openrouter.ai/api/v1", "vendor/model").mode === "reasoning_effort");
check("infer: o-series model id", inferModelThinking("https://gw.example.com/v1", "o3-mini").mode === "reasoning_effort");
check("infer: gpt-5 model id", inferModelThinking("https://gw.example.com/v1", "gpt-5-mini").mode === "reasoning_effort");
check("infer: o-series needs a boundary", inferModelThinking("https://gw.example.com/v1", "foo3-bar").mode === "none");
check("infer: deepseek", inferModelThinking("https://api.deepseek.com/v1", "deepseek-chat").mode === "none");
check("infer: glm", inferModelThinking("https://open.bigmodel.cn/api/paas/v4", "glm-4.6").mode === "none");
check("infer: kimi", inferModelThinking("https://api.moonshot.cn/v1", "kimi-k2-thinking").mode === "none");
check("infer: unknown → none", inferModelThinking("https://my-gateway.example.com/v1", "my-model").mode === "none");
// Hostname-only matching: a path segment can't masquerade as a provider host.
check("infer: path spoof is not a host", inferModelThinking("https://evil.com/openai.com/v1", "m").mode === "none");
// Table order: the explicit qwen entry wins over later rows for a mixed id.
check("infer: qwen wins over openai row", inferModelThinking("https://gw.example.com/v1", "openrouter/qwen3").mode === "enable_thinking");

/* ── resolveModelThinking: explicit declaration wins ── */
const declared: CustomModelEntry = { id: "m", thinking: { mode: "reasoning_effort", levels: ["low", "high"], defaultLevel: "high" } };
check("resolve: explicit declaration wins", eq(resolveModelThinking(declared, "https://api.deepseek.com/v1"), { mode: "reasoning_effort", levels: ["low", "high"], defaultLevel: "high" }));
check("resolve: absent → inferred", resolveModelThinking({ id: "deepseek-chat" }, "https://api.deepseek.com/v1").mode === "none");
// A hand-edited record whose thinking object lost its mode falls back to inference.
check("resolve: mode-less thinking object → inferred", resolveModelThinking({ id: "o3", thinking: {} } as unknown as CustomModelEntry, "https://api.openai.com/v1").mode === "reasoning_effort");
check("resolve: undefined entry → inferred from baseUrl", resolveModelThinking(undefined, "https://api.openai.com/v1").mode === "reasoning_effort");

/* ── effortLevelValuesForModel ── */
check("levels: reasoning_effort default set", eq(effortLevelValuesForModel({ id: "o3", thinking: { mode: "reasoning_effort" } }, "https://api.openai.com/v1"), ["default", "minimal", "low", "medium", "high"]));
check("levels: declared narrow set", eq(effortLevelValuesForModel(declared, "https://x/v1"), ["default", "low", "high"]));
check("levels: enable_thinking tri-state", eq(effortLevelValuesForModel({ id: "qwen3" }, "https://dashscope.aliyuncs.com/v1"), ["default", "off", "on"]));
check("levels: none is empty", eq(effortLevelValuesForModel({ id: "deepseek-chat" }, "https://api.deepseek.com/v1"), []));
check("levels: REASONING_EFFORT_LEVELS export", eq([...reasoningEffortLevels()], ["minimal", "low", "medium", "high"]));

/* ── save schema round-trip ── */
const parsed = SaveCustomModelSchema.safeParse({
  name: "gw",
  baseUrl: "https://gw.example.com/v1",
  authToken: "sk-x",
  protocol: "openai",
  models: [{ id: "o3", thinking: { mode: "reasoning_effort", defaultLevel: "high" } }],
});
check("schema: thinking accepted", parsed.success && (parsed as { data?: { models: { thinking?: { mode: string } }[] } }).data?.models[0]?.thinking?.mode === "reasoning_effort");
const badMode = SaveCustomModelSchema.safeParse({
  name: "gw",
  baseUrl: "https://gw.example.com/v1",
  authToken: "sk-x",
  models: [{ id: "o3", thinking: { mode: "bogus" } }],
});
check("schema: bogus mode rejected", !badMode.success);
const noThinking = SaveCustomModelSchema.safeParse({
  name: "gw",
  baseUrl: "https://gw.example.com/v1",
  authToken: "sk-x",
  models: [{ id: "o3" }],
});
check("schema: legacy rows still pass", noThinking.success);

/* ── applyThinkingControl ── */
const mkReq = (): OpenAIRequest => ({ model: "m", messages: [], max_tokens: 64 });

let r = mkReq();
applyThinkingControl(r, { mode: "reasoning_effort" }, "high");
check("bridge: reasoning_effort emitted", r.reasoning_effort === "high" && r.enable_thinking === undefined);

r = mkReq();
applyThinkingControl(r, { mode: "reasoning_effort" }, "xhigh");
check("bridge: level outside the declared set dropped", r.reasoning_effort === undefined);

r = mkReq();
applyThinkingControl(r, { mode: "reasoning_effort", levels: ["low", "high"] }, "medium");
check("bridge: narrow declared set enforced", r.reasoning_effort === undefined);

r = mkReq();
applyThinkingControl(r, { mode: "enable_thinking" }, "off");
check("bridge: enable_thinking off", r.enable_thinking === false && r.reasoning_effort === undefined);

r = mkReq();
applyThinkingControl(r, { mode: "enable_thinking" }, "on");
check("bridge: enable_thinking on", r.enable_thinking === true);

r = mkReq();
applyThinkingControl(r, { mode: "enable_thinking" }, "default");
check("bridge: default sentinel sends nothing", r.enable_thinking === undefined);

r = mkReq();
applyThinkingControl(r, { mode: "none" }, "high");
check("bridge: none sends nothing", r.reasoning_effort === undefined && r.enable_thinking === undefined);

r = mkReq();
applyThinkingControl(r, { mode: "reasoning_effort" }, undefined);
check("bridge: absent header sends nothing", r.reasoning_effort === undefined);

r = mkReq();
applyThinkingControl(r, undefined, "high");
check("bridge: no declaration sends nothing", r.reasoning_effort === undefined && r.enable_thinking === undefined);

/* ── buildCustomEnv: the internal effort header ── */
const baseCfg = (protocol: "anthropic" | "openai", models: CustomModelEntry[]): ApiConfig => ({
  baseUrl: "https://gw.example.com/v1",
  authToken: "sk-x",
  authMode: "auth_token",
  protocol,
  selectedModel: models[0]?.id ?? "m",
  models,
  disableNonEssentialTraffic: true,
});

let env = buildCustomEnv(baseCfg("openai", [{ id: "o3", thinking: { mode: "reasoning_effort" } }]), { sessionId: "s1", thinkingEffort: "high" });
check("env: openai sets x-mcode-effort", env.ANTHROPIC_CUSTOM_HEADERS?.includes(`${MCODE_EFFORT_HEADER}: high`) === true);

// Inherited OS-level ANTHROPIC_CUSTOM_HEADERS must merge, not clobber.
const prevHeaders = process.env.ANTHROPIC_CUSTOM_HEADERS;
process.env.ANTHROPIC_CUSTOM_HEADERS = "X-Custom: 1";
try {
  env = buildCustomEnv(baseCfg("openai", [{ id: "o3" }]), { thinkingEffort: "low" });
  const lines = env.ANTHROPIC_CUSTOM_HEADERS ?? "";
  check("env: inherited headers merged", lines.includes("X-Custom: 1") && lines.includes(`${MCODE_EFFORT_HEADER}: low`));

  // No effort picked → the inherited value stays untouched, no internal header.
  env = buildCustomEnv(baseCfg("openai", [{ id: "o3" }]), { sessionId: "s1" });
  check("env: no effort → inherited value untouched", env.ANTHROPIC_CUSTOM_HEADERS === "X-Custom: 1");

  // A mangled effort value must not become a header.
  env = buildCustomEnv(baseCfg("openai", [{ id: "o3" }]), { sessionId: "s1", thinkingEffort: "high; rm -rf" });
  check("env: invalid effort value dropped", !env.ANTHROPIC_CUSTOM_HEADERS?.includes(MCODE_EFFORT_HEADER));
} finally {
  if (prevHeaders === undefined) delete process.env.ANTHROPIC_CUSTOM_HEADERS;
  else process.env.ANTHROPIC_CUSTOM_HEADERS = prevHeaders;
}

env = buildCustomEnv(baseCfg("anthropic", [{ id: "o3" }]), { sessionId: "s1", thinkingEffort: "high" });
check("env: anthropic protocol never carries the internal header", !env.ANTHROPIC_CUSTOM_HEADERS?.includes(MCODE_EFFORT_HEADER));

/* ── renderer resolveEffortLevels ── */
const providerLevels: ThinkingLevelOption[] = [
  { value: "default", label: "Auto" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Med" },
  { value: "high", label: "High" },
];
const customModels = [
  {
    id: "cfg-openai",
    name: "OpenAI gw",
    baseUrl: "https://gw.example.com/v1",
    authMode: "auth_token" as const,
    protocol: "openai" as const,
    authTokenMasked: "sk",
    models: [
      { id: "o3", thinking: { mode: "reasoning_effort" } },
      { id: "qwen3" },
      { id: "deepseek-r1" },
    ],
    disableNonEssentialTraffic: true,
    createdAt: 0,
  },
  {
    id: "cfg-anthropic",
    name: "DeepSeek /anthropic",
    baseUrl: "https://api.deepseek.com/anthropic",
    authMode: "auth_token" as const,
    protocol: "anthropic" as const,
    authTokenMasked: "sk",
    models: [{ id: "deepseek-chat" }],
    disableNonEssentialTraffic: true,
    createdAt: 0,
  },
];

check("ui: no provider declaration → undefined", resolveEffortLevels({ providerLevels: undefined, customModels, customModelId: null, model: "default" }) === undefined);
check(
  "ui: no custom model → provider list",
  eq(resolveEffortLevels({ providerLevels, customModels, customModelId: null, model: "default" }), providerLevels),
);
check(
  "ui: anthropic-protocol custom model keeps provider list",
  eq(resolveEffortLevels({ providerLevels, customModels, customModelId: "cfg-anthropic", model: "deepseek-chat" }), providerLevels),
);
const o3Levels = resolveEffortLevels({ providerLevels, customModels, customModelId: "cfg-openai", model: "o3" });
check("ui: declared reasoning_effort model", eq(o3Levels?.map((l) => l.value), ["default", "minimal", "low", "medium", "high"]));
const qwenLevels = resolveEffortLevels({ providerLevels, customModels, customModelId: "cfg-openai", model: "qwen3" });
check("ui: inferred enable_thinking model", eq(qwenLevels?.map((l) => l.value), ["default", "off", "on"]));
check("ui: on/off labels", qwenLevels?.[1]?.label === "Off" && qwenLevels?.[2]?.label === "On");
const r1Levels = resolveEffortLevels({ providerLevels, customModels, customModelId: "cfg-openai", model: "deepseek-r1" });
check("ui: inferred none model hides the chip", eq(r1Levels, []));

/* ── BridgeRegistry.ensureCurrent: in-place rebuild on config drift ──
 * The scenario from the 2026-09-28 log: a session reuses a bridge across
 * turns while the user edits the model's thinking declaration — the reused
 * server must pick the change up (rebuild), and the old server must be gone. */
const regCfg = (mode: CustomModelThinkingMode): ApiConfig => ({
  baseUrl: "https://gw.example.com/v1",
  authToken: "sk-x",
  authMode: "auth_token",
  protocol: "openai",
  selectedModel: "m",
  models: [{ id: "m", thinking: { mode } }],
  disableNonEssentialTraffic: true,
});

const h1 = await BridgeRegistry.acquire("smoke-reg", regCfg("reasoning_effort"));
const h2 = await BridgeRegistry.ensureCurrent("smoke-reg", regCfg("reasoning_effort"));
check("registry: no drift → same handle", h2 === h1);
const h3 = await BridgeRegistry.ensureCurrent("smoke-reg", regCfg("enable_thinking"));
check("registry: drift → rebuilt handle + new port", h3 !== null && h3 !== h1 && h3.localUrl !== h1.localUrl);
let oldGone = false;
try {
  await fetch(h1.localUrl);
} catch {
  oldGone = true;
}
check("registry: old server closed after rebuild", oldGone);
let newAlive = false;
try {
  const res = await fetch(h3 ? h3.localUrl : "http://127.0.0.1:1");
  newAlive = res.status === 404; // GET → the bridge's 404 branch (alive, just not /v1/messages)
} catch {
  newAlive = false;
}
check("registry: rebuilt server listening", newAlive);
BridgeRegistry.release("smoke-reg");

console.log(`thinking-levels smoke: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
