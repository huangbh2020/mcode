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
import { resolve } from "node:path";
import type { RuntimeEvent } from "@contracts/runtime";
import type { ProviderContext } from "@contracts/provider";
import {
  parseAntigravityModelListing,
  resolveAntigravityWireModel,
} from "@main/providers/antigravity-acp/antigravityModels.js";
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

  console.log("antigravity-acp-smoke: ALL ASSERTIONS PASSED");
}

void run().catch((err) => {
  console.error(err);
  process.exit(1);
});
