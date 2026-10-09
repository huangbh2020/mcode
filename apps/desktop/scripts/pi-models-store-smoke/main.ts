/**
 * Headless smoke for the Pi models.json store (main/lib/piModelsStore.ts),
 * focused on the saveProvider merge contract:
 *
 *   - fields the settings FORM manages (thinkingLevelMap / reasoning /
 *     maxTokens / name at model level; authHeader / name at provider level)
 *     are form-owned — absence in the incoming config CLEARS the stored key
 *     (the "set off→不支持, change back to 默认, still 不支持 after reopen" bug);
 *   - fields the form never edits (compat / cost / headers / model-level
 *     api·baseUrl overrides / provider modelOverrides·headers) still survive;
 *   - apiKey lifecycle: required on create, never written to models.json,
 *     preserved on empty update, replaceable, decryptable via resolveApiKey.
 *
 * Bundled with esbuild. No electron / sqlite: repositories, secretStore and
 * logger are aliased to in-memory stubs; the models.json path is redirected
 * by pointing HOME/USERPROFILE at a temp dir from run.sh.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { PiModelsStore } from "@main/lib/piModelsStore.js";
import { settings } from "./stub-store.js";
import { decrypt } from "./stub-secret.js";
import type { PiProviderConfig, PiModelDefinition } from "@contracts/piModel";

let passed = 0;
const failures: string[] = [];
function ok(cond: boolean, label: string): void {
  if (cond) passed++;
  else {
    failures.push(label);
    console.error(`FAIL: ${label}`);
  }
}
function deepEq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const modelsFile = path.join(homedir(), ".pi", "agent", "models.json");
const readProviders = (): Record<string, PiProviderConfig> =>
  (JSON.parse(readFileSync(modelsFile, "utf-8")) as { providers: Record<string, PiProviderConfig> }).providers;
const readModel = (provider: string, id: string): PiModelDefinition =>
  readProviders()[provider].models?.find((m) => m.id === id) ?? {};

const BASE = "http://120.77.13.237:3099/v1";

/* ── 1. create: off→null lands in the file, key encrypted, file stays clean ── */
await PiModelsStore.saveProvider(
  "浩联云",
  {
    name: "浩联云",
    baseUrl: BASE,
    api: "openai-completions",
    models: [
      {
        id: "MiniMax-M3.1-Flash-Preview",
        contextWindow: 1_000_000,
        input: ["text", "image"],
        reasoning: true,
        thinkingLevelMap: { off: null },
      },
    ],
  },
  "sk-test-1",
);
ok(deepEq(readModel("浩联云", "MiniMax-M3.1-Flash-Preview").thinkingLevelMap, { off: null }), "create: thinkingLevelMap {off:null} written");
ok(readModel("浩联云", "MiniMax-M3.1-Flash-Preview").reasoning === true, "create: reasoning written");
ok(!("apiKey" in readProviders()["浩联云"]), "create: apiKey never lands in models.json");
const keyMapRaw = settings.get("piProviderKeys");
ok(typeof keyMapRaw === "string" && keyMapRaw.includes("浩联云"), "create: key stored in settings map");

/* ── 2. THE BUG: form cleared the map (all rows 默认) + unchecked reasoning ── */
await PiModelsStore.saveProvider("浩联云", {
  name: "浩联云",
  baseUrl: BASE,
  api: "openai-completions",
  models: [{ id: "MiniMax-M3.1-Flash-Preview", contextWindow: 1_000_000, input: ["text", "image"] }],
});
ok(!("thinkingLevelMap" in readModel("浩联云", "MiniMax-M3.1-Flash-Preview")), "clear map: thinkingLevelMap dropped (was resurrected before the fix)");
ok(!("reasoning" in readModel("浩联云", "MiniMax-M3.1-Flash-Preview")), "clear map: unchecked reasoning dropped");

/* ── 3. partial map + per-model independence ── */
await PiModelsStore.saveProvider("浩联云", {
  name: "浩联云",
  baseUrl: BASE,
  api: "openai-completions",
  models: [
    { id: "MiniMax-M3.1-Flash-Preview", contextWindow: 1_000_000, input: ["text", "image"], thinkingLevelMap: { low: "max" } },
    { id: "MiniMax-M3", contextWindow: 200_000, input: ["text"], thinkingLevelMap: { high: "max", off: null } },
  ],
});
ok(deepEq(readModel("浩联云", "MiniMax-M3.1-Flash-Preview").thinkingLevelMap, { low: "max" }), "remap: map replaced wholesale (no stale off:null)");
ok(deepEq(readModel("浩联云", "MiniMax-M3").thinkingLevelMap, { high: "max", off: null }), "remap: second model keeps its own map");

/* ── 4. clear one model's map while the sibling keeps its own ── */
await PiModelsStore.saveProvider("浩联云", {
  name: "浩联云",
  baseUrl: BASE,
  api: "openai-completions",
  models: [
    { id: "MiniMax-M3.1-Flash-Preview", contextWindow: 1_000_000, input: ["text", "image"] },
    { id: "MiniMax-M3", contextWindow: 200_000, input: ["text"], thinkingLevelMap: { high: "max" } },
  ],
});
ok(!("thinkingLevelMap" in readModel("浩联云", "MiniMax-M3.1-Flash-Preview")), "sibling clear: A's map cleared");
ok(deepEq(readModel("浩联云", "MiniMax-M3").thinkingLevelMap, { high: "max" }), "sibling clear: B's map intact (off:null not resurrected)");

/* ── 5. name / maxTokens are form-owned too ── */
await PiModelsStore.saveProvider("浩联云", {
  name: "浩联云",
  baseUrl: BASE,
  api: "openai-completions",
  models: [
    { id: "MiniMax-M3.1-Flash-Preview", name: "显示名", maxTokens: 8192, contextWindow: 1_000_000, input: ["text", "image"] },
  ],
});
const named = readModel("浩联云", "MiniMax-M3.1-Flash-Preview");
ok(named.name === "显示名" && named.maxTokens === 8192, "name/maxTokens: written");
await PiModelsStore.saveProvider("浩联云", {
  name: "浩联云",
  baseUrl: BASE,
  api: "openai-completions",
  models: [{ id: "MiniMax-M3.1-Flash-Preview", contextWindow: 1_000_000, input: ["text", "image"] }],
});
const unnamed = readModel("浩联云", "MiniMax-M3.1-Flash-Preview");
ok(!("name" in unnamed) && !("maxTokens" in unnamed), "name/maxTokens: cleared when the form omits them");

/* ── 6. hand-written fields the form never edits still survive ── */
writeFileSync(
  modelsFile,
  JSON.stringify({
    providers: {
      hand: {
        baseUrl: "https://gateway.example",
        api: "openai-completions",
        headers: { "X-Trace": "1" },
        modelOverrides: { m1: { contextWindow: 5 } },
        models: [
          {
            id: "m1",
            api: "openai-responses",
            baseUrl: "https://override.example",
            compat: { streaming: true },
            cost: { in: 1, out: 2 },
            headers: { "X-M": "1" },
            thinkingLevelMap: { off: "disabled" },
          },
        ],
      },
    },
  }),
  "utf-8",
);
await PiModelsStore.saveProvider(
  "hand",
  { baseUrl: "https://gateway.example", api: "openai-completions", models: [{ id: "m1", contextWindow: 100_000, input: ["text"] }] },
  "sk-hand",
);
const m1 = readModel("hand", "m1");
ok(m1.api === "openai-responses" && m1.baseUrl === "https://override.example", "hand-written: model-level api/baseUrl preserved");
ok(deepEq(m1.compat, { streaming: true }) && deepEq(m1.cost, { in: 1, out: 2 }), "hand-written: compat/cost preserved");
ok(deepEq(m1.headers, { "X-M": "1" }), "hand-written: model headers preserved");
ok(!("thinkingLevelMap" in m1), "hand-written: form-managed thinkingLevelMap replaced by form state (cleared)");
const hand = readProviders().hand;
ok(deepEq(hand.headers, { "X-Trace": "1" }) && deepEq(hand.modelOverrides, { m1: { contextWindow: 5 } }), "hand-written: provider headers/modelOverrides preserved");

/* ── 7. provider-level authHeader is form-owned ── */
await PiModelsStore.saveProvider("hand", {
  authHeader: true,
  baseUrl: "https://gateway.example",
  api: "openai-completions",
  models: [{ id: "m1", contextWindow: 100_000, input: ["text"] }],
});
ok(readProviders().hand.authHeader === true, "authHeader: true written");
await PiModelsStore.saveProvider("hand", {
  baseUrl: "https://gateway.example",
  api: "openai-completions",
  models: [{ id: "m1", contextWindow: 100_000, input: ["text"] }],
});
ok(!("authHeader" in readProviders().hand), "authHeader: cleared when the form omits it");

/* ── 8. apiKey lifecycle ── */
let rejected = false;
try {
  await PiModelsStore.saveProvider("fresh", { baseUrl: BASE, api: "openai-completions", models: [{ id: "m", contextWindow: 1 }] });
} catch {
  rejected = true;
}
ok(rejected, "apiKey: create without key rejected");
ok(PiModelsStore.resolveApiKey("hand") === "sk-hand", "apiKey: resolveApiKey decrypts");
await PiModelsStore.saveProvider("hand", {
  baseUrl: "https://gateway.example",
  api: "openai-completions",
  models: [{ id: "m1", contextWindow: 100_000, input: ["text"] }],
});
ok(PiModelsStore.resolveApiKey("hand") === "sk-hand", "apiKey: empty update preserves existing key");
await PiModelsStore.saveProvider("hand", {
  baseUrl: "https://gateway.example",
  api: "openai-completions",
  models: [{ id: "m1", contextWindow: 100_000, input: ["text"] }],
}, "sk-hand-2");
ok(PiModelsStore.resolveApiKey("hand") === "sk-hand-2", "apiKey: new key replaces");

/* ── 9. listPublic: presence flag, no cleartext ── */
const pub = await PiModelsStore.listPublic();
ok(pub.hand?.hasApiKey === true, "listPublic: hasApiKey true");
ok(!("apiKey" in pub.hand!), "listPublic: no apiKey field");

/* ── summary ── */
console.log(`\npi-models-store smoke: ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  process.exit(1);
}
