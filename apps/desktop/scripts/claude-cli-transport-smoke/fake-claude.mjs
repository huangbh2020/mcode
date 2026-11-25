// A stand-in for the Claude Code CLI's headless protocol, for the transport
// smoke (scripts/claude-cli-transport-smoke). Speaks exactly the frames the
// real CLI writes on stdout and reads on stdin:
//
//   stdout  system/init · assistant · user(tool_result) · result ·
//           control_request (can_use_tool / request_user_dialog / elicitation)
//   stdin   control_response · control_request (initialize / stop_task /
//           get_context_usage / interrupt) · user messages
//
// What a user turn does is chosen by its first word (TOOL / ASK / PLAN / …);
// the rest of the text is a label the test reads back. No model, no network.
//
// Knobs (env):
//   FAKE_CLAUDE_DUMP     append one JSON line per process: argv + the
//                        --settings / --mcp-config files it was handed
//   FAKE_CLAUDE_VERSION  what `--version` prints (default 2.1.303)
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const argValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

if (args.includes("--version")) {
  process.stdout.write(`${process.env.FAKE_CLAUDE_VERSION ?? "2.1.303"} (Claude Code)\n`);
  process.exit(0);
}

function readJson(file) {
  if (!file) return null;
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  return { inline: file };
}

const dump = process.env.FAKE_CLAUDE_DUMP;
if (dump) {
  appendFileSync(
    dump,
    `${JSON.stringify({
      pid: process.pid,
      args,
      settings: readJson(argValue("--settings")),
      mcp: readJson(argValue("--mcp-config")),
    })}\n`,
  );
}

const out = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const success = (request_id, response) => out({ type: "control_response", response: { subtype: "success", request_id, response } });
const failure = (request_id, error, error_code) => out({ type: "control_response", response: { subtype: "error", request_id, error, error_code } });

/** CLI → host request: send it and wait for the matching control_response. */
const waiting = new Map();
let nextId = 0;
function ask(request, timeoutMs) {
  const request_id = `fake-${++nextId}`;
  return new Promise((resolve) => {
    waiting.set(request_id, resolve);
    // With a timeout, an unanswered request resolves undefined — what the
    // real CLI sees when the host stays silent past its park deadline.
    if (timeoutMs) setTimeout(() => {
      if (waiting.delete(request_id)) resolve(undefined);
    }, timeoutMs).unref();
    out({ type: "control_request", request_id, request });
  });
}

const sessionId = "00000000-0000-4000-8000-000000000001";
let turn = 0;
let announcedInit = false;
let exitOnClose = true;
let eof = false;
let inFlight = 0;
function maybeExit() {
  if (eof && inFlight === 0 && exitOnClose) process.exit(0);
}

function announceInit() {
  if (announcedInit) return;
  announcedInit = true;
  const mcp = dump ? readJson(argValue("--mcp-config")) : null;
  out({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    claude_code_version: process.env.FAKE_CLAUDE_VERSION ?? "2.1.303",
    cwd: process.cwd(),
    tools: ["Bash", "Read", "AskUserQuestion"],
    mcp_servers: mcp?.mcpServers ? Object.keys(mcp.mcpServers).map((name) => ({ name, status: "connected" })) : [],
    model: "fake-model",
    permissionMode: argValue("--permission-mode") ?? "default",
    slash_commands: [],
    output_style: "default",
    skills: [],
  });
}

const assistant = (blocks) => out({ type: "assistant", parent_tool_use_id: null, message: { id: `msg_${++nextId}`, role: "assistant", content: blocks } });
const result = (text) =>
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    result: text,
    session_id: sessionId,
  });

async function onUser(msg) {
  turn += 1;
  announceInit();
  const content = msg.message.content;
  const text = typeof content === "string" ? content : content.map((b) => (b.type === "text" ? b.text : "")).join("");
  const [scenario, ...rest] = text.split(" ");
  const label = rest.join(" ") || `t${turn}`;

  switch (scenario) {
    case "FAIL401": {
      out({ type: "result", subtype: "error_during_execution", is_error: true, duration_ms: 1, duration_api_ms: 1, num_turns: 0, errors: ["API error 401: invalid x-api-key"], session_id: sessionId });
      process.exit(1);
      break;
    }
    case "CRASH": {
      assistant([{ type: "text", text: "partial" }]);
      process.exit(3);
      break;
    }
    case "HANG":
      // Never answers; leaves on stdin EOF (or when killed).
      return;
    case "IGNORE_EOF":
      // Keeps running past stdin EOF — only a kill ends it.
      exitOnClose = false;
      setInterval(() => {}, 1000);
      return;
    case "TOOL": {
      const id = `toolu_${label}`;
      const input = { command: `echo ${label}` };
      assistant([{ type: "tool_use", id, name: "Bash", input }]);
      const res = await ask({ subtype: "can_use_tool", tool_name: "Bash", input, tool_use_id: id, title: `Run echo ${label}` });
      if (!res) {
        out({ type: "result", subtype: "error_during_execution", is_error: true, duration_ms: 1, duration_api_ms: 1, num_turns: 1, errors: ["no answer"], session_id: sessionId });
        return;
      }
      const decision = res.response.response ?? {};
      if (res.response.subtype === "success" && decision.behavior === "allow") {
        const command = decision.updatedInput?.command ?? input.command;
        out({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: `ran:${command}` }] } });
        assistant([{ type: "text", text: `allowed:${command}` }]);
        result(`allowed:${command}`);
      } else {
        out({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: decision.message ?? res.response.error, is_error: true }] } });
        assistant([{ type: "text", text: `denied:${decision.message ?? res.response.error}` }]);
        result("denied");
      }
      return;
    }
    case "TOOLREFUSE": {
      // A tool ask the host cannot approve (nobody registered canUseTool).
      const id = "toolu_refuse";
      const input = { command: "echo never" };
      assistant([{ type: "tool_use", id, name: "Bash", input }]);
      const res = await ask({ subtype: "can_use_tool", tool_name: "Bash", input, tool_use_id: id });
      const reason = res?.response.subtype === "success" ? res.response.response?.message : res?.response.error;
      assistant([{ type: "text", text: `denied:${reason}` }]);
      result("refused");
      return;
    }
    case "ASK": {
      const id = "toolu_ask";
      const input = {
        questions: [{ question: "Color?", header: "Color", multiSelect: false, options: [{ label: "Red", description: "" }, { label: "Blue", description: "" }] }],
      };
      assistant([{ type: "tool_use", id, name: "AskUserQuestion", input }]);
      const res = await ask({ subtype: "can_use_tool", tool_name: "AskUserQuestion", input, tool_use_id: id });
      const answers = res?.response.response?.updatedInput?.answers ?? null;
      out({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: JSON.stringify({ answers }) }] } });
      assistant([{ type: "text", text: `answers:${JSON.stringify(answers)}` }]);
      result("asked");
      return;
    }
    case "PLAN": {
      const res = await ask({
        subtype: "request_user_dialog",
        dialog_kind: "permission_exit_plan_mode_v2",
        payload: { plan: `plan for ${label}` },
        tool_use_id: "toolu_plan",
      }, 400);
      const approved = res?.response.response?.result?.approved;
      assistant([{ type: "text", text: `plan:${res ? (approved ? "approved" : "rejected") : "silent"}` }]);
      result("planned");
      return;
    }
    case "ELICIT": {
      const res = await ask({ subtype: "elicitation", mcp_server_name: "srv", message: "fill the form", mode: "form" });
      assistant([{ type: "text", text: `elicit:${JSON.stringify(res?.response.response ?? res?.response)}` }]);
      result("elicit");
      return;
    }
    case "UNKNOWNCTRL": {
      const res = await ask({ subtype: "weird_kind", payload: {} });
      assistant([{ type: "text", text: `unknown:${res?.response.subtype}:${res?.response.error_code}` }]);
      result("unknown");
      return;
    }
    case "NOISE": {
      // What a chatty shell/profile can do to a pipe: junk and blank lines
      // between the JSON frames. The transport must skip them.
      process.stdout.write("not json at all\n\n   \n");
      assistant([{ type: "text", text: `reply:${label}` }]);
      result(`reply:${label}`);
      return;
    }
    case "CANCEL": {
      // Asks for a tool, then withdraws the ask before it is answered — the
      // host's handler must see its abort signal fire and stay silent.
      const id = "toolu_cancel";
      const askId = `fake-${nextId + 1}`;
      void ask({ subtype: "can_use_tool", tool_name: "Bash", input: { command: "echo never" }, tool_use_id: id });
      out({ type: "control_cancel_request", request_id: askId });
      assistant([{ type: "text", text: "cancelled" }]);
      result("cancelled");
      return;
    }
    case "TASKS": {
      out({ type: "system", subtype: "task_started", task_id: "bash1", tool_use_id: "toolu_b", description: "sleep 100", task_type: "local_bash", is_backgrounded: true, session_id: sessionId });
      out({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "bash1", task_type: "local_bash", description: "sleep 100" }], session_id: sessionId });
      assistant([{ type: "text", text: "started" }]);
      result("started");
      return;
    }
    default: {
      assistant([{ type: "text", text: `reply:${label}` }]);
      result(`reply:${label}`);
    }
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    // What the real CLI does with a non-JSON line: nothing.
    return;
  }
  if (frame.type === "control_response") {
    waiting.get(frame.response.request_id)?.(frame);
    waiting.delete(frame.response.request_id);
    return;
  }
  if (frame.type === "control_cancel_request") {
    waiting.delete(frame.request_id);
    return;
  }
  if (frame.type === "control_request") {
    const { request_id, request } = frame;
    switch (request.subtype) {
      case "initialize":
        success(request_id, {
          commands: [],
          models: [],
          claude_code_version: process.env.FAKE_CLAUDE_VERSION ?? "2.1.303",
          echo: {
            appendSystemPrompt: request.appendSystemPrompt ?? null,
            systemPrompt: request.systemPrompt ?? null,
            supportedDialogKinds: request.supportedDialogKinds ?? null,
          },
        });
        return;
      case "get_context_usage":
        success(request_id, { totalTokens: 1234, maxTokens: 200000, percentage: 1, model: "fake-model", categories: [] });
        return;
      case "stop_task":
        if (request.task_id === "missing") failure(request_id, "No such task", "not_found");
        else {
          success(request_id, {});
          out({ type: "system", subtype: "task_notification", task_id: request.task_id, status: "stopped", output_file: "task-out.txt", session_id: sessionId });
        }
        return;
      case "interrupt":
        success(request_id, { still_queued: [] });
        return;
      case "set_permission_mode":
        success(request_id, {});
        return;
      default:
        failure(request_id, `Unsupported control request subtype: ${request.subtype}`, "unsupported_request");
    }
    return;
  }
  if (frame.type === "user") {
    inFlight += 1;
    void onUser(frame).finally(() => {
      inFlight -= 1;
      maybeExit();
    });
  }
});
// stdin EOF = the graceful stop. Like the real CLI, an in-flight turn
// (e.g. one parked on an approval) still runs to its result first.
rl.on("close", () => {
  eof = true;
  maybeExit();
});
