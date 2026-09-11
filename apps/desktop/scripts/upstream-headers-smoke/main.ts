/**
 * Headless smoke for the custom-endpoint request-header policy
 * (`providers/upstreamHeaders.ts`) and its two delivery paths.
 *
 * The bug this protects against: an OpenAI-protocol custom endpoint pointing at
 * a gateway that requires a per-conversation session header (OpenCode Zen's
 * "Go" plan) answered every request with
 * `400 {"type":"error","error":{"type":"MissingSessionID"}}`, which surfaced in
 * the UI as "Claude Code returned an error result". The bridge forwarded only
 * Content-Type / Accept / Authorization.
 *
 * The bridge cases run against a REAL bridge server over real HTTP, with
 * `globalThis.fetch` stubbed so the outgoing upstream request can be inspected
 * without touching the network — that is the exact hop that used to drop the
 * header.
 *
 * Run: scripts/upstream-headers-smoke/run.sh
 */
import {
  formatCustomHeaderLines,
  parseCustomHeaderLines,
  requiresSessionHeader,
  resolveUpstreamHeaders,
  sanitizeCustomHeaders,
  SESSION_HEADER,
} from "@main/providers/upstreamHeaders.js";
import { buildCustomEnv } from "@main/providers/claude-sdk/customEnv.js";
import { startBridge } from "@main/providers/bridge/bridgeServer.js";
import type { ApiConfig } from "@contracts/customModel";

const OPENCODE = "https://opencode.ai/zen/go/v1";
const DEEPSEEK = "https://api.deepseek.com/anthropic";

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    return;
  }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(
    name,
    JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

/* ───────────────────────── host detection ───────────────────────── */

check("opencode.ai: session header required", requiresSessionHeader(OPENCODE));
check(
  "subdomain of opencode.ai: required",
  requiresSessionHeader("https://api.opencode.ai/v1"),
);
check(
  "lookalike host (opencode.ai.evil.com): NOT required",
  !requiresSessionHeader("https://opencode.ai.evil.com/v1"),
);
check(
  "prefix lookalike (notopencode.ai): NOT required",
  !requiresSessionHeader("https://notopencode.ai/v1"),
);
check("deepseek: NOT required", !requiresSessionHeader(DEEPSEEK));
check("garbage baseUrl: NOT required (no throw)", !requiresSessionHeader("not a url"));
check("Azure-style path on the opencode host: required", requiresSessionHeader(OPENCODE + "/chat/completions"));

/* ───────────────────── header resolution / sanitizing ───────────────────── */

eq(
  "no custom headers + non-session gateway → empty",
  resolveUpstreamHeaders(undefined, DEEPSEEK, "sid"),
  {},
);
eq(
  "custom headers pass through",
  resolveUpstreamHeaders({ "x-foo": "bar" }, DEEPSEEK, "sid"),
  { "x-foo": "bar" },
);
eq(
  "session header auto-added for opencode",
  resolveUpstreamHeaders(undefined, OPENCODE, "mcode-sess1"),
  { [SESSION_HEADER]: "mcode-sess1" },
);
eq(
  "no session id → no session header",
  resolveUpstreamHeaders(undefined, OPENCODE, ""),
  {},
);
eq(
  "user-supplied session header wins (any casing → no duplicate)",
  resolveUpstreamHeaders({ "X-Opencode-Session": "mine" }, OPENCODE, "mcode-sess1"),
  { "X-Opencode-Session": "mine" },
);
eq(
  "user session header kept even on a non-session gateway",
  resolveUpstreamHeaders({ "x-opencode-session": "mine" }, DEEPSEEK, "mcode-sess1"),
  { "x-opencode-session": "mine" },
);
eq(
  "sanitize drops bad names/values, keeps good rows",
  sanitizeCustomHeaders({
    "x-good": "ok",
    "bad name": "v",
    "x:colon": "v",
    "x-newline": "a\nb",
    "x-empty": "",
  }),
  { "x-good": "ok", "x-empty": "" },
);
eq(
  "sanitize tolerates undefined",
  sanitizeCustomHeaders(undefined),
  {},
);

const roundTrip = { "x-a": "1", "x-b": "two words" };
eq(
  "format/parse round-trip (ANTHROPIC_CUSTOM_HEADERS wire form)",
  parseCustomHeaderLines(formatCustomHeaderLines(roundTrip)),
  roundTrip,
);
eq("parse ignores garbage lines", parseCustomHeaderLines("no-colon\nx-ok: yes"), { "x-ok": "yes" });

/* ───────────────────── path 1: env (anthropic protocol) ───────────────────── */

function cfgFor(protocol: "anthropic" | "openai", baseUrl: string, headers?: Record<string, string>): ApiConfig {
  const cfg: ApiConfig = {
    baseUrl,
    authToken: "tok",
    authMode: "auth_token",
    protocol,
    selectedModel: "m1",
    models: [{ id: "m1" }],
    disableNonEssentialTraffic: true,
  };
  if (headers) cfg.customHeaders = headers;
  return cfg;
}

{
  const env = buildCustomEnv(cfgFor("anthropic", DEEPSEEK, { "x-foo": "bar" }));
  eq("anthropic: custom headers on ANTHROPIC_CUSTOM_HEADERS", env.ANTHROPIC_CUSTOM_HEADERS, "x-foo: bar");
  eq("anthropic: baseUrl still set", env.ANTHROPIC_BASE_URL, DEEPSEEK);
  eq("anthropic: auth still set", env.ANTHROPIC_AUTH_TOKEN, "tok");
  eq("anthropic: model still pinned", env.ANTHROPIC_MODEL, "m1");
}

{
  const env = buildCustomEnv(cfgFor("anthropic", OPENCODE), { sessionId: "sess-42" });
  eq(
    "anthropic + opencode: session header named after the Mcode session",
    env.ANTHROPIC_CUSTOM_HEADERS,
    `${SESSION_HEADER}: mcode-sess-42`,
  );
}

{
  const env = buildCustomEnv(cfgFor("anthropic", OPENCODE));
  const raw = env.ANTHROPIC_CUSTOM_HEADERS ?? "";
  check(
    "anthropic + opencode without a session: stable process-wide id",
    /^x-opencode-session: mcode-[0-9a-f]{12}$/.test(raw),
    raw,
  );
  const again = buildCustomEnv(cfgFor("anthropic", OPENCODE)).ANTHROPIC_CUSTOM_HEADERS;
  eq("…and it is stable across calls", again, raw);
}

{
  const env = buildCustomEnv(cfgFor("anthropic", DEEPSEEK));
  eq("anthropic + no headers: env var untouched", env.ANTHROPIC_CUSTOM_HEADERS, undefined);
}

{
  // An inherited OS-level value (someone's pre-existing workaround or another
  // tool's config) must survive, with the config's own row winning on conflict.
  const prev = process.env.ANTHROPIC_CUSTOM_HEADERS;
  process.env.ANTHROPIC_CUSTOM_HEADERS = "x-inherited: yes\nx-foo: old";
  try {
    const env = buildCustomEnv(cfgFor("anthropic", DEEPSEEK, { "x-foo": "new" }));
    eq(
      "inherited ANTHROPIC_CUSTOM_HEADERS merged, config wins on conflict",
      parseCustomHeaderLines(env.ANTHROPIC_CUSTOM_HEADERS),
      { "x-inherited": "yes", "x-foo": "new" },
    );
    const env2 = buildCustomEnv(cfgFor("anthropic", OPENCODE), { sessionId: "s1" });
    eq(
      "inherited value also survives the opencode auto-injection",
      parseCustomHeaderLines(env2.ANTHROPIC_CUSTOM_HEADERS),
      { "x-inherited": "yes", "x-foo": "old", [SESSION_HEADER]: "mcode-s1" },
    );
  } finally {
    if (prev === undefined) delete process.env.ANTHROPIC_CUSTOM_HEADERS;
    else process.env.ANTHROPIC_CUSTOM_HEADERS = prev;
  }
}

{
  const env = buildCustomEnv(cfgFor("openai", "http://127.0.0.1:12345", { "x-foo": "bar" }));
  eq(
    "openai protocol: env var left alone (the bridge owns upstream headers)",
    env.ANTHROPIC_CUSTOM_HEADERS,
    undefined,
  );
}

/* ───────────────────── path 2: the bridge (openai protocol) ───────────────────── */

const realFetch = globalThis.fetch;
let captured: Array<Record<string, string>> = [];
(globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url, init) => {
  captured.push({ ...((init?.headers ?? {}) as Record<string, string>), __url: String(url) });
  const sse = [
    'data: {"choices":[{"delta":{"content":"ok"}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    "data: [DONE]",
    "",
  ].join("\n\n");
  return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}) as typeof fetch;

/** POST one Anthropic-shaped turn through a fresh bridge and return the headers
 *  the bridge sent upstream (plus the upstream URL under `__url`).
 *
 *  `captured` is shared by the stub, so calls must stay sequential — the
 *  awaited body read guarantees the upstream request has already been made
 *  before we inspect it. */
async function postThroughBridge(
  baseUrl: string,
  customHeaders?: Record<string, string>,
): Promise<Record<string, string>> {
  captured = [];
  const bridge = await startBridge({
    baseUrl,
    authToken: "tok",
    authMode: "auth_token",
    ...(customHeaders ? { customHeaders } : {}),
  });
  try {
    const res = await realFetch(`${bridge.localUrl}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "m1",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 16,
        stream: true,
      }),
    });
    await res.text();
  } finally {
    bridge.close();
  }
  check("bridge: exactly one upstream request captured", captured.length === 1, String(captured.length));
  return captured[0] ?? {};
}

try {
  const plain = await postThroughBridge(DEEPSEEK, { "x-foo": "bar" });
  eq("bridge: user headers reach the upstream request", plain["x-foo"], "bar");
  eq("bridge: derived bearer auth preserved", plain["Authorization"], "Bearer tok");
  eq("bridge: content type preserved", plain["Content-Type"], "application/json");
  eq("bridge: no session header on a non-session gateway", plain[SESSION_HEADER], undefined);
  eq(
    "bridge: upstream URL is the documented chat-completions path",
    plain.__url,
    "https://api.deepseek.com/anthropic/v1/chat/completions",
  );

  const overridden = await postThroughBridge(DEEPSEEK, { Authorization: "Custom zz" });
  eq("bridge: a user Authorization overrides the derived one", overridden["Authorization"], "Custom zz");

  const injected = await postThroughBridge(OPENCODE);
  check(
    "bridge + opencode, nothing configured: session header injected",
    /^mcode-[0-9a-f]{12}$/.test(injected[SESSION_HEADER] ?? ""),
    injected[SESSION_HEADER],
  );
  eq(
    "bridge: upstream URL for the zen/go endpoint",
    injected.__url,
    "https://opencode.ai/zen/go/v1/chat/completions",
  );

  const configured = await postThroughBridge(OPENCODE, { [SESSION_HEADER]: "mine-conversation" });
  eq("bridge: configured session header is not overwritten", configured[SESSION_HEADER], "mine-conversation");

  const first = await postThroughBridge(OPENCODE);
  const second = await postThroughBridge(OPENCODE);
  check(
    "bridge: each bridge gets its own stable id",
    first[SESSION_HEADER] !== second[SESSION_HEADER],
    `${first[SESSION_HEADER]}, ${second[SESSION_HEADER]}`,
  );
} finally {
  globalThis.fetch = realFetch;
}

/* ───────────────────────────── report ───────────────────────────── */

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} failed, ${passed} passed`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ upstream-headers smoke: ${passed} assertions passed`);
