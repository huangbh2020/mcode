#!/usr/bin/env node
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("1.5.16\n");
  process.exit(0);
}
if (args[0] === "models") {
  process.stdout.write(
    [
      "gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)",
      "gemini-4-hydrogen-xhigh\tGemini 4 Hydrogen (XHigh)",
      "gemini-4-hydrogen-medium\tGemini 4 Hydrogen (Medium)",
      "gemini-4-hydrogen-low\tGemini 4 Hydrogen (Low)",
      "claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)",
      "gpt-oss-120b-medium\tGPT-OSS 120B (Medium)",
    ].join("\n") + "\n",
  );
  process.exit(0);
}
if (args[0] !== "acp") {
  process.stderr.write(`unknown command: ${args.join(" ")}\n`);
  process.exit(2);
}

const scenario = process.env.FAKE_AGY_SCENARIO || "full";
let activeSessionId = "agy-sess-1";
let lastModelSet = null;
const pendingReplies = new Map();
let outgoingId = 100;

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function requestClient(method, params) {
  const id = outgoingId++;
  return new Promise((resolve, reject) => {
    pendingReplies.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  const msg = JSON.parse(trimmed);

  // Response to our outgoing request
  if (msg.method === undefined && msg.id !== undefined) {
    const p = pendingReplies.get(msg.id);
    if (p) {
      pendingReplies.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    }
    return;
  }

  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: "Antigravity ACP Server", version: "1.5.16" },
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, embeddedContext: true },
          sessionCapabilities: { resume: {}, load: {}, list: {}, close: {} },
          _meta: { antigravity: { tier: true, systemPrompt: { append: true } } },
        },
      },
    });
    return;
  }

  if (msg.method === "session/new") {
    if (scenario === "auth-required") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32000, message: "Authentication required" },
      });
      return;
    }
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        sessionId: activeSessionId,
        models: { currentModelId: "gemini-4-hydrogen-medium", availableModels: [] },
      },
    });
    return;
  }

  if (msg.method === "session/set_model") {
    lastModelSet = msg.params?.modelId ?? null;
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
    return;
  }

  if (msg.method === "session/prompt") {
    const sid = msg.params?.sessionId ?? activeSessionId;
    // 1. Thought + invalid-output retry notice + prose
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: sid,
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "Planning step..." },
        },
      },
    });
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: sid,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "\u26a0 Model produced invalid output." },
        },
      },
    });
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: sid,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `Model=${lastModelSet ?? "default"}` },
        },
      },
    });

    // 2. Plan + usage
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: sid,
        update: {
          sessionUpdate: "plan",
          entries: [{ content: "Inspect codebase", status: "completed" }],
        },
      },
    });
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: sid,
        update: { sessionUpdate: "usage_update", used: 15000, size: 100000 },
      },
    });

    // 3. Warned permission request (normal tool)
    const permRes = await requestClient("session/request_permission", {
      sessionId: sid,
      toolCall: {
        toolCallId: "call_exec_1",
        title: "Run command",
        kind: "execute",
        rawInput: { CommandLine: "echo ok", WorkingDirectory: process.cwd() },
      },
      options: [
        {
          optionId: "allow_once",
          name: "Allow once",
          kind: "allow_once",
          _meta: { "agy.security.warning": { message: "Executes shell command" } },
        },
        { optionId: "reject_once", name: "Reject", kind: "reject_once" },
      ],
    });

    // 4. Formless interaction_ question (must ask user even in bypass)
    const qRes = await requestClient("session/request_permission", {
      sessionId: sid,
      toolCall: { toolCallId: "interaction_q1", title: "Pick target env" },
      options: [
        { optionId: "opt_dev", name: "Dev" },
        { optionId: "opt_prod", name: "Prod" },
      ],
    });

    // 5. Elicitation form request
    const formRes = await requestClient("elicitation/create", {
      sessionId: sid,
      mode: "form",
      message: "Confirm details",
      requestedSchema: {
        properties: {
          confirm: { type: "boolean", title: "Proceed?" },
        },
        required: ["confirm"],
      },
    });

    // 6. Tool call lifecycle with normalized CommandLine/combinedOutput/exitCode
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: sid,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call_exec_1",
          kind: "execute",
          status: "in_progress",
          rawInput: { CommandLine: "echo ok", WorkingDirectory: process.cwd() },
        },
      },
    });
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: sid,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call_exec_1",
          kind: "execute",
          status: "completed",
          rawOutput: { combinedOutput: `perm=${permRes?.outcome?.optionId},q=${qRes?.outcome?.optionId},form=${formRes?.content?.confirm}`, exitCode: 0 },
        },
      },
    });

    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
  }
});

rl.on("close", () => process.exit(0));
