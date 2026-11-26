/**
 * Smoke test for the Antigravity ACP provider stack (`agy acp`), covering:
 *   1. `parseAntigravityModelListing` & `resolveAntigravityWireModel` folding.
 *   2. End-to-end scripted fake `agy` binary over stdio JSON-RPC (`AcpTransport`):
 *      - `initialize` + `session/new` + `session/set_model` (`gemini-4-hydrogen` + `xhigh` → `gemini-4-hydrogen-xhigh`)
 *      - `agent_thought_chunk`, retry notice → `upstream.issue`, `agent_message_chunk`
 *      - `plan` → `plan.update`, `usage_update` → `token-usage.updated`
 *      - `session/request_permission` with `agy.security.warning`
 *      - `interaction_` question (not bypassed even in `bypassPermissions`)
 *      - `elicitation/create` form mapping
 *      - `CommandLine` / `combinedOutput` / `exitCode` → `Bash` tool card
 *      - `-32000` authentication required → `AcpAuthRequiredError`
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { RuntimeEvent } from "@contracts/runtime";
import type { ProviderContext } from "@contracts/provider";
import {
  discardAgyListingSession,
  parseAntigravityModelListing,
  resolveAntigravityWireModel,
} from "@main/providers/antigravity-acp/antigravityModels.js";
import { parseAntigravityUsageStdout } from "@main/providers/antigravity-acp/antigravityUsage.js";
import {
  buildAgyHomeSettingsJson,
  buildAgyIsolatedHomeArgs,
  buildSanitizedAntigravityEnv,
} from "@main/providers/antigravity-acp/antigravityEnv.js";
import { AcpTransport } from "@main/providers/antigravity-acp/acpTransport.js";
import { AntigravityMessageAdapter } from "@main/providers/antigravity-acp/AntigravityMessageAdapter.js";
import {
  AcpAuthRequiredError,
  AcpRpcError,
} from "@main/providers/antigravity-acp/acpProtocol.js";
import { FileSnapshot } from "@main/lib/fileSnapshot.js";

async function run(): Promise<void> {
  // 1. Model folding unit checks
  const parsed = parseAntigravityModelListing(
    [
      "gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)",
      "gemini-4-hydrogen-xhigh\tGemini 4 Hydrogen (XHigh)",
      "gemini-4-hydrogen-medium\tGemini 4 Hydrogen (Medium)",
      "gemini-4-hydrogen-low\tGemini 4 Hydrogen (Low)",
      "claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)",
      "gpt-oss-120b-medium\tGPT-OSS 120B (Medium)",
    ].join("\n"),
  );
  assert.equal(parsed.options.length, 3, "should fold 4 hydrogen levels into 1 family + keep 2 others");
  assert.deepEqual(parsed.options[0], {
    id: "gemini-4-hydrogen",
    label: "Gemini 4 Hydrogen",
    variants: ["low", "medium", "high", "xhigh"],
  });
  assert.equal(parsed.options[1]?.id, "claude-sonnet-4-6");
  assert.equal(parsed.options[2]?.id, "gpt-oss-120b-medium", "single-level model should NOT fold");
  assert.equal(
    resolveAntigravityWireModel("gemini-4-hydrogen", "xhigh", parsed),
    "gemini-4-hydrogen-xhigh",
  );
  assert.equal(
    resolveAntigravityWireModel("gemini-4-hydrogen", "default", parsed),
    "gemini-4-hydrogen-medium",
  );

  // 2. Full ACP round-trip against scripted fake-agy.mjs
  const fakeAgy = resolve("scripts/antigravity-acp-smoke/fake-agy.mjs");
  const events: RuntimeEvent[] = [];
  let approvalDesc = "";
  let userInputCalls = 0;
  const ctx: ProviderContext = {
    emit: (e) => events.push(e),
    requestApproval: async (req) => {
      approvalDesc = req.description ?? "";
      return { allow: true };
    },
    requestUserInput: async (req) => {
      userInputCalls += 1;
      const answers: Record<string, string> = {};
      for (const q of req.questions) {
        answers[q.question] = q.options[0]?.label ?? "Yes";
      }
      return { answers };
    },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  };

  const ac = new AbortController();
  let adapter: AntigravityMessageAdapter | null = null;
  const transport = new AcpTransport({
    command: process.execPath,
    args: [fakeAgy, "acp"],
    cwd: process.cwd(),
    env: process.env,
    onNotification: (m, p) => {
      if (m === "session/update") adapter?.handleSessionNotification(p);
    },
    onRequest: async (m, p, rctx) => {
      if (!adapter) throw new AcpRpcError(-32000, "no adapter");
      if (m === "session/request_permission") return adapter.handlePermissionRequest(p, rctx.signal);
      if (m === "elicitation/create") return adapter.handleElicitationRequest(p, rctx.signal);
      throw new AcpRpcError(-32601, "unsupported");
    },
  });

  await transport.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
  const sess = (await transport.request("session/new", { cwd: process.cwd(), mcpServers: [] })) as {
    sessionId: string;
  };
  const wire = resolveAntigravityWireModel("gemini-4-hydrogen", "xhigh", parsed);
  await transport.request("session/set_model", { sessionId: sess.sessionId, modelId: wire });

  adapter = new AntigravityMessageAdapter({
    sessionId: "s1",
    acpSessionId: sess.sessionId,
    cwd: process.cwd(),
    model: "gemini-4-hydrogen",
    permissionMode: "default",
    ctx,
    snapshot: new FileSnapshot(),
    abortSignal: ac.signal,
  });

  await transport.request("session/prompt", {
    sessionId: sess.sessionId,
    prompt: [{ type: "text", text: "hello" }],
  });
  await adapter.finalize("end_turn");
  transport.close();

  assert.ok(events.some((e) => e.type === "thinking" && e.text.includes("Planning step")));
  assert.ok(events.some((e) => e.type === "upstream.issue" && e.kind === "retry"));
  assert.ok(events.some((e) => e.type === "text.delta" && e.text.includes("gemini-4-hydrogen-xhigh")));
  assert.ok(events.some((e) => e.type === "plan.update" && e.phase === "drafting"));
  assert.ok(events.some((e) => e.type === "token-usage.updated" && e.snapshot.pct === 15));
  assert.ok(approvalDesc.includes("Executes shell command"));
  assert.equal(userInputCalls, 2);
  const toolUse = events.find((e) => e.type === "tool.use");
  assert.ok(toolUse && toolUse.type === "tool.use" && toolUse.toolName === "Bash");
  const toolRes = events.find((e) => e.type === "tool.result");
  assert.ok(toolRes && toolRes.type === "tool.result" && String(toolRes.content).includes("form=true"));

  // 3. Verify bypassPermissions STILL surfaces interaction_ question (never auto-approved)
  let bypassUserInputCalls = 0;
  let bypassApprovalCalls = 0;
  const bypassAdapter = new AntigravityMessageAdapter({
    sessionId: "s-bypass",
    acpSessionId: "agy-sess-bypass",
    cwd: process.cwd(),
    permissionMode: "bypassPermissions",
    ctx: {
      emit: () => {},
      requestApproval: async () => {
        bypassApprovalCalls += 1;
        return { allow: true };
      },
      requestUserInput: async (req) => {
        bypassUserInputCalls += 1;
        return { answers: { [req.questions[0]!.question]: req.questions[0]!.options[0]!.label } };
      },
      log: { info: () => {}, warn: () => {}, error: () => {} },
    },
    snapshot: new FileSnapshot(),
    abortSignal: new AbortController().signal,
  });
  const bypassPerm = await bypassAdapter.handlePermissionRequest(
    {
      sessionId: "agy-sess-bypass",
      toolCall: { toolCallId: "call_tool", kind: "execute", rawInput: { CommandLine: "echo 1" } },
      options: [{ optionId: "allow_once", name: "Allow", kind: "allow_once" }],
    },
    new AbortController().signal,
  );
  assert.deepEqual(bypassPerm, { outcome: { outcome: "selected", optionId: "allow_once" } });
  assert.equal(bypassApprovalCalls, 0, "bypassPermissions must auto-approve normal tools");
  const bypassQuestion = await bypassAdapter.handlePermissionRequest(
    {
      sessionId: "agy-sess-bypass",
      toolCall: { toolCallId: "interaction_bypass_q", title: "Confirm?" },
      options: [{ optionId: "opt_1", name: "Yes" }],
    },
    new AbortController().signal,
  );
  assert.deepEqual(bypassQuestion, { outcome: { outcome: "selected", optionId: "opt_1" } });
  assert.equal(bypassUserInputCalls, 1, "interaction_ question must NOT be bypassed in bypassPermissions");

  // 4. Verify -32000 Authentication required maps to AcpAuthRequiredError
  const authTransport = new AcpTransport({
    command: process.execPath,
    args: [fakeAgy, "acp"],
    cwd: process.cwd(),
    env: { ...process.env, FAKE_AGY_SCENARIO: "auth-required" },
  });
  await authTransport.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
  await assert.rejects(
    () => authTransport.request("session/new", { cwd: process.cwd(), mcpServers: [] }),
    (err: unknown) => err instanceof AcpAuthRequiredError && err.code === -32000,
  );
  authTransport.close();

  // 5. Verify discardAgyListingSession cleans up temp conversation/brain/annotations files
  const fakeAgyRoot = mkdtempSync(join(tmpdir(), "agy-discard-smoke-"));
  try {
    const tempSid = "3d50b981-da12-47b3-a691-a1dd07901fa3";
    mkdirSync(join(fakeAgyRoot, "conversations"), { recursive: true });
    mkdirSync(join(fakeAgyRoot, "brain", tempSid), { recursive: true });
    mkdirSync(join(fakeAgyRoot, "annotations"), { recursive: true });
    writeFileSync(join(fakeAgyRoot, "conversations", `${tempSid}.db`), "stub");
    writeFileSync(join(fakeAgyRoot, "conversations", `${tempSid}.db-wal`), "stub");
    writeFileSync(join(fakeAgyRoot, "brain", tempSid, "meta.json"), "{}");
    writeFileSync(join(fakeAgyRoot, "annotations", `${tempSid}.pbtxt`), "");
    await discardAgyListingSession(tempSid, fakeAgyRoot);
    assert.equal(existsSync(join(fakeAgyRoot, "conversations", `${tempSid}.db`)), false);
    assert.equal(existsSync(join(fakeAgyRoot, "conversations", `${tempSid}.db-wal`)), false);
    assert.equal(existsSync(join(fakeAgyRoot, "brain", tempSid)), false);
    assert.equal(existsSync(join(fakeAgyRoot, "annotations", `${tempSid}.pbtxt`)), false);
  } finally {
    rmSync(fakeAgyRoot, { recursive: true, force: true });
  }

  // 6. Verify /usage JSON parsing, 1970 reset filtering, and billed-turn latch detection
  const usageSample = JSON.stringify({
    conversation_id: "",
    status: "SUCCESS",
    num_turns: 0,
    command: {
      name: "usage",
      data: {
        description: "Shared quota info",
        groups: [
          {
            name: "Gemini Models",
            buckets: [
              { id: "g-w", name: "Weekly", window: "weekly", remaining_fraction: 0.968, reset_time: "2026-12-01T05:36:11Z" },
              { id: "g-5h", name: "5h", window: "5h", remaining_fraction: 0.952, reset_time: "2026-11-26T05:05:32Z" },
              { id: "g-dis", name: "Off", window: "5h", remaining_fraction: 1, disabled: true },
            ],
          },
          {
            name: "Claude and GPT models",
            buckets: [
              { id: "3p-w", name: "Weekly", window: "weekly", remaining_fraction: 1, reset_time: "1970-01-01T00:00:00Z" },
            ],
          },
        ],
      },
    },
  });
  const usageParsed = parseAntigravityUsageStdout(usageSample);
  assert.equal(usageParsed.ranModelTurn, false);
  assert.equal(usageParsed.parsed?.groups.length, 2);
  assert.equal(usageParsed.parsed?.groups[0]?.buckets.length, 2, "disabled bucket must be skipped");
  assert.equal(usageParsed.parsed?.groups[0]?.buckets[0]?.remainingPercent, 97);
  assert.equal(usageParsed.parsed?.groups[1]?.buckets[0]?.resetsAt, null, "1970 epoch reset must be null");

  const billedTurn = parseAntigravityUsageStdout(JSON.stringify({ conversation_id: "abc", status: "SUCCESS", num_turns: 1 }));
  assert.equal(billedTurn.ranModelTurn, true, "num_turns > 0 or non-empty conversation_id must trigger safety latch");

  // 7. Verify host MCP read-only browser & orch_submit_plan tools are auto-approved in default mode
  let defaultApprovalCalls = 0;
  const mcpAdapter = new AntigravityMessageAdapter({
    sessionId: "s-mcp",
    acpSessionId: "agy-sess-mcp",
    cwd: process.cwd(),
    permissionMode: "default",
    ctx: {
      emit: () => {},
      requestApproval: async () => {
        defaultApprovalCalls += 1;
        return { allow: true };
      },
      log: { info: () => {}, warn: () => {}, error: () => {} },
    },
    snapshot: new FileSnapshot(),
    abortSignal: new AbortController().signal,
  });
  const roBrowserPerm = await mcpAdapter.handlePermissionRequest(
    {
      sessionId: "agy-sess-mcp",
      toolCall: { toolCallId: "tc_1", title: "mcp__mcode-browser__browser_snapshot" },
      options: [{ optionId: "allow_once", name: "Allow", kind: "allow_once" }],
    },
    new AbortController().signal,
  );
  assert.deepEqual(roBrowserPerm, { outcome: { outcome: "selected", optionId: "allow_once" } });
  const orchPerm = await mcpAdapter.handlePermissionRequest(
    {
      sessionId: "agy-sess-mcp",
      toolCall: { toolCallId: "tc_2", title: "orch_submit_plan" },
      options: [{ optionId: "allow_once", name: "Allow", kind: "allow_once" }],
    },
    new AbortController().signal,
  );
  assert.deepEqual(orchPerm, { outcome: { outcome: "selected", optionId: "allow_once" } });
  assert.equal(defaultApprovalCalls, 0, "read-only browser & orch_submit_plan tools must auto-approve");

  // 8. Verify --gemini-dir isolation args, settings.json builder, and env sanitization
  assert.deepEqual(buildAgyIsolatedHomeArgs(null), []);
  assert.deepEqual(buildAgyIsolatedHomeArgs("/tmp/agy-home-1"), [
    "--gemini-dir",
    "/tmp/agy-home-1",
    "--app-data-dir",
    "antigravity-cli",
  ]);
  const apiKeySettings = JSON.parse(buildAgyHomeSettingsJson({ method: "gemini-api-key" })) as {
    auth?: { type?: string };
  };
  assert.equal(apiKeySettings.auth?.type, "gemini-api-key");
  const gcpSettings = JSON.parse(
    buildAgyHomeSettingsJson({ method: "agent-platform", gcpProject: "demo-proj", gcpLocation: "us-central1" }),
  ) as { auth?: { type?: string }; gcp?: { project?: string; location?: string } };
  assert.equal(gcpSettings.auth?.type, "agent-platform");
  assert.equal(gcpSettings.gcp?.project, "demo-proj");
  assert.equal(gcpSettings.gcp?.location, "us-central1");

  const sanitized = buildSanitizedAntigravityEnv(
    {
      PATH: "/usr/bin",
      GEMINI_API_KEY: "leaked-host-key",
      GOOGLE_CLOUD_PROJECT: "leaked-proj",
      AGY_ACP_FORCE_FILE: "1",
    },
    "gemini-api-key",
    { GEMINI_API_KEY: "account-key" },
  );
  assert.equal(sanitized["GEMINI_API_KEY"], "account-key");
  assert.equal(sanitized["GOOGLE_CLOUD_PROJECT"], undefined, "conflicting GCP var must be stripped");
  assert.equal(sanitized["AGY_ACP_FORCE_FILE"], undefined, "AGY_ACP_* override must be stripped");
  assert.equal(sanitized["AGY_CLI_DISABLE_AUTO_UPDATE"], "true");

  console.log("antigravity-acp-smoke: ALL ASSERTIONS PASSED");
}

void run().catch((err) => {
  console.error(err);
  process.exit(1);
});
