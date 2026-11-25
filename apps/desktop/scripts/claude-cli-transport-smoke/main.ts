/**
 * Claude CLI transport smoke — the REAL cliTransport / claudeCliQuery /
 * hostMcpHttp / claudeExecutable modules, driven against a fake `claude`
 * process (fake-claude.mjs) that speaks the CLI's headless protocol.
 *
 * Why a fake process: the control-protocol round trips (tool approval,
 * AskUserQuestion, plan dialog, stop_task, abort, kill) can only be exercised
 * through a real child process with pipes, and the real CLI needs a model on
 * the other end to emit them. The fake emits the same frames deterministically.
 *
 * Run: scripts/claude-cli-transport-smoke/run.sh (esbuild bundle, like the
 * other smokes). Nothing here touches the network or a model.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  CliAbortedError,
  type CanUseToolRequest,
  type PermissionResult,
  type UserDialogResult,
} from "@main/providers/claude-sdk/claudeProtocol.js";
import { CliTransport } from "@main/providers/claude-sdk/cliTransport.js";
import {
  ClaudeCliUnavailableError,
  assertClaudeCliUsable,
  buildCliArgs,
  buildInitializeRequest,
  runClaudeCliQuery,
  type ClaudeCliOptions,
  type CliQuery,
} from "@main/providers/claude-sdk/claudeCliQuery.js";
import { startHostMcpServer } from "@main/providers/claude-sdk/hostMcpHttp.js";
import { runClaudeOneShot } from "@main/providers/claude-sdk/claudeOneShot.js";
import type { ClaudeAssistantMessage, ClaudeMessage, ClaudeResultMessage, ClaudeSystemInitMessage } from "@main/providers/claude-sdk/claudeStreamTypes.js";
import {
  compareVersions,
  probeClaudeCliVersion,
  spawnableClaudeExecutable,
  type ClaudeExecutable,
} from "@main/lib/claudeExecutable.js";

const FAKE_CLI = process.env.FAKE_CLAUDE_JS;
if (!FAKE_CLI) throw new Error("FAKE_CLAUDE_JS must point at fake-claude.mjs (see run.sh)");

// A hung scenario must fail the run, not hang CI.
setTimeout(() => {
  console.error("✗ smoke timed out");
  process.exit(1);
}, 90_000).unref();

const WORK = mkdtempSync(join(tmpdir(), "mcode-claude-smoke-"));
const DUMP = join(WORK, "dump.jsonl");
mkdirSync(WORK, { recursive: true });

let passed = 0;
function ok(cond: unknown, msg: string): void {
  assert.ok(cond, msg);
  passed += 1;
  console.log(`  ✓ ${msg}`);
}
function eq(actual: unknown, expected: unknown, msg: string): void {
  assert.deepStrictEqual(actual, expected, msg);
  passed += 1;
  console.log(`  ✓ ${msg}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Poll until `cond` holds (fails the run on timeout). */
async function until(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("until(): timed out");
    await sleep(20);
  }
}
function section(title: string): void {
  console.log(`\n${title}`);
}

/** The fake CLI as an executable: `node fake-claude.mjs <cli args>`. The tag
 *  arg only keeps the version-probe cache key distinct per fixture version. */
function fakeExecutable(version = "2.1.303"): ClaudeExecutable {
  return {
    command: process.execPath,
    preArgs: [FAKE_CLI!, `--fake-tag=${version}`],
    env: { FAKE_CLAUDE_VERSION: version },
    path: FAKE_CLI!,
    source: "node-launcher",
  };
}

interface Outcome {
  messages: ClaudeMessage[];
  error?: Error;
  init: Record<string, unknown> | null;
}
const isResult = (m: ClaudeMessage) => m.type === "result";
const results = (o: Outcome): ClaudeResultMessage[] => o.messages.filter((m): m is ClaudeResultMessage => m.type === "result");
const replies = (o: Outcome): string[] =>
  o.messages
    .filter((m): m is ClaudeAssistantMessage => m.type === "assistant")
    .map((m) => m.message.content)
    .filter((content): content is Array<{ type: string; text?: string }> => Array.isArray(content))
    .map((content) => content.filter((b) => b.type === "text").map((b) => b.text ?? "").join(""))
    .filter(Boolean);

/** Drain a query until the first `result` (or the end), then let the process
 *  exit and confirm the launcher cleaned up after itself. */
async function drive(query: CliQuery, until: (m: ClaudeMessage) => boolean = isResult): Promise<Outcome> {
  const messages: ClaudeMessage[] = [];
  let error: Error | undefined;
  try {
    for await (const m of query) {
      messages.push(m);
      if (until(m)) break;
    }
  } catch (err) {
    error = err as Error;
  }
  let init: Record<string, unknown> | null = null;
  try {
    init = await Promise.race([query.initialization, sleep(2000).then(() => null)]);
  } catch {
    init = null;
  }
  releaseFeeds();
  query.transport.endInput();
  await Promise.race([query.transport.closed, sleep(4000)]);
  query.transport.close();
  if (process.env.SMOKE_DEBUG) console.log(JSON.stringify(messages.map((m) => ({ t: m.type, s: m.subtype, m: m.type === "user" ? m.message : undefined })), null, 1));
  return { messages, error, init };
}

function baseOptions(over: Partial<ClaudeCliOptions> = {}): ClaudeCliOptions {
  return {
    cwd: WORK,
    executable: fakeExecutable(),
    env: { ...process.env, FAKE_CLAUDE_DUMP: DUMP, FAKE_CLAUDE_VERSION: "2.1.303" },
    abortController: new AbortController(),
    supportedDialogKinds: ["permission_exit_plan_mode_v2"],
    ...over,
  };
}

/** A prompt feed that stays open after its prompts — like the provider's
 *  feed during a turn — so control responses still have a way in. `drive`
 *  (or releaseFeeds()) lets it end, which is what makes the CLI exit. */
function releaseFeeds(): void {
  for (const release of feeds.splice(0)) release();
}
const feeds: Array<() => void> = [];
function feedOf(...prompts: string[]): AsyncIterable<Record<string, unknown>> {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  feeds.push(release);
  return (async function* () {
    for (const prompt of prompts) {
      yield { type: "user", message: { role: "user", content: prompt }, parent_tool_use_id: null };
    }
    await held;
  })();
}

/** What the fake CLI recorded about its launch (one line per process). */
function dumpRecords(): Array<{ pid: number; args: string[]; settings: unknown; mcp: unknown }> {
  if (!existsSync(DUMP)) return [];
  return readFileSync(DUMP, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
const argAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
const systemInit = (o: Outcome): ClaudeSystemInitMessage =>
  o.messages.find((m): m is ClaudeSystemInitMessage => m.type === "system" && m.subtype === "init")!;

try {
  /* ────────────────────────────────────────────────────────────────────
   * 1. Option → launch translation (pure)
   * ──────────────────────────────────────────────────────────────────── */
  section("1. option → argv / initialize translation");
  const full = buildCliArgs({
    cwd: WORK,
    abortController: new AbortController(),
    includePartialMessages: true,
    effort: "high",
    maxTurns: 1,
    model: "claude-sonnet-5",
    permissionMode: "bypassPermissions",
    debug: true,
    canUseTool: async () => ({ behavior: "allow" }),
    resume: "sess-1",
    skills: ["pdf", "ns:demo"],
    allowedTools: ["WebSearch"],
    tools: [],
    settingSources: ["project", "local"],
    forwardSubagentText: true,
    plugins: [{ type: "local", path: "/p/a" }, { type: "local", path: "/p/b", skipMcpDiscovery: true }],
  });
  for (const flag of ["--output-format", "stream-json", "--verbose", "--input-format", "--include-partial-messages", "--effort", "high", "--max-turns", "1", "--model", "claude-sonnet-5", "--permission-mode", "bypassPermissions", "--debug", "--permission-prompt-tool=stdio", "--resume=sess-1", "--setting-sources", "project,local", "--forward-subagent-text", "--plugin-dir", "/p/a", "--plugin-dir-no-mcp", "/p/b"]) {
    ok(full.includes(flag), `argv carries ${flag}`);
  }
  eq(argAfter(full, "--permission-mode"), "bypassPermissions", "permissionMode becomes --permission-mode <mode>");
  eq(argAfter(full, "--allowedTools"), "WebSearch,Skill(pdf),Skill(ns:demo)", "skills become an allowedTools Skill() allowlist after explicit allowedTools");
  eq(full.find((a) => a.startsWith("--tools")), "--tools=", "tools: [] disables every built-in tool");
  const bare = buildCliArgs({ cwd: WORK, abortController: new AbortController(), skills: "all" });
  eq(argAfter(bare, "--allowedTools"), "Skill", "skills: 'all' allows the Skill tool");
  ok(!bare.some((a) => a.startsWith("--permission-prompt-tool") || a === "--permission-mode" || a === "--debug" || a === "--include-partial-messages"), "no canUseTool / permission-mode / debug / partial flags unless asked for");

  const ac = new AbortController();
  eq(buildInitializeRequest({ cwd: WORK, abortController: ac }), { subtype: "initialize" }, "bare initialize carries only the subtype");
  eq(
    buildInitializeRequest({
      cwd: WORK,
      abortController: ac,
      systemPrompt: { type: "preset", preset: "claude_code", append: "user words" },
      supportedDialogKinds: ["permission_exit_plan_mode_v2"],
    }),
    { subtype: "initialize", appendSystemPrompt: "user words", supportedDialogKinds: ["permission_exit_plan_mode_v2"] },
    "preset + append rides the handshake as appendSystemPrompt, dialog kinds declared",
  );
  eq(
    buildInitializeRequest({ cwd: WORK, abortController: ac, systemPrompt: { type: "preset", preset: "claude_code" } }),
    { subtype: "initialize" },
    "a preset with no append sends nothing — the stock prompt",
  );
  eq(
    buildInitializeRequest({ cwd: WORK, abortController: ac, systemPrompt: { type: "custom", prompt: "be brief" } }),
    { subtype: "initialize", systemPrompt: ["be brief"] },
    "a custom prompt replaces the stock one via systemPrompt[]",
  );

  /* ────────────────────────────────────────────────────────────────────
   * 2. A plain turn end to end
   * ──────────────────────────────────────────────────────────────────── */
  section("2. plain turn: handshake, init, reply, result, exit, cleanup");
  {
    const query = await runClaudeCliQuery(
      feedOf("SAY hello world"),
      baseOptions({ settings: { plansDirectory: ".claude/plans" }, permissionMode: "bypassPermissions" }),
    );
    const o = await drive(query);
    ok(!o.error, `stream ended without a transport error (${o.error?.message ?? ""})`);
    ok(o.init !== null, "initialize was answered");
    eq((o.init?.["echo"] as Record<string, unknown>).supportedDialogKinds, ["permission_exit_plan_mode_v2"], "the CLI saw the declared dialog kinds");
    eq(systemInit(o).session_id, "00000000-0000-4000-8000-000000000001", "system/init reached the message stream");
    eq(systemInit(o).permissionMode, "bypassPermissions", "permissionMode reaches the CLI and reflects in system/init");
    eq(replies(o), ["reply:hello world"], "assistant text forwarded verbatim");
    eq(results(o).map((r) => r.result), ["reply:hello world"], "exactly one result, carrying the reply");
    eq(results(o)[0].is_error, false, "result is a success");

    const [rec] = dumpRecords();
    ok(rec.args.includes("--output-format") && rec.args.includes("--input-format"), "launched in stream-json mode");
    ok(!rec.args.some((a) => a.startsWith("--permission-prompt-tool")), "…and without a canUseTool callback no permission channel is requested (nothing could answer it)");
    ok(!rec.args.some((a) => a.includes("plansDirectory")), "settings JSON is not on the command line");
    eq(rec.settings, { plansDirectory: ".claude/plans" }, "settings reached the CLI through the --settings file, intact");
    const settingsFile = argAfter(rec.args, "--settings");
    ok(existsSync(settingsFile) === false, "the settings temp file is deleted once the process is gone");
  }

  /* ────────────────────────────────────────────────────────────────────
   * 3. Two turns on one process (the persistent transport)
   * ──────────────────────────────────────────────────────────────────── */
  section("3. one process serves two turns");
  {
    const query = await runClaudeCliQuery(feedOf("SAY first one", "SAY second two"), baseOptions());
    const all: ClaudeMessage[] = [];
    let count = 0;
    for await (const m of query) {
      all.push(m);
      if (isResult(m) && ++count === 2) break;
    }
    releaseFeeds();
    query.transport.endInput();
    await Promise.race([query.transport.closed, sleep(4000)]);
    eq(replies({ messages: all, init: null }), ["reply:first one", "reply:second two"], "both turns answered on the same stdin");
    eq(dumpRecords().length, 2, "still one fake process for the whole run (dump has one new line)");
  }

  /* ────────────────────────────────────────────────────────────────────
   * 4. Tool approval
   * ──────────────────────────────────────────────────────────────────── */
  section("4. tool approval round trip");
  {
    const seen: CanUseToolRequest[] = [];
    const o = await drive(
      await runClaudeCliQuery(
        feedOf("TOOL rewrite"),
        baseOptions({
          canUseTool: async (toolName, input, opts) => {
            seen.push({ subtype: "can_use_tool", tool_name: toolName, input, tool_use_id: opts.toolUseID });
            eq(opts.toolUseID, `toolu_rewrite`, "handler gets the tool_use id");
            eq(opts.title, "Run echo rewrite", "handler gets the CLI's display copy");
            ok(typeof opts.requestId === "string" && opts.requestId.length > 0, "handler gets the request id");
            return { behavior: "allow", updatedInput: { ...input, command: "echo rewritten" } };
          },
        }),
      ),
    );
    eq(seen.length, 1, "exactly one approval ask reached the host");
    eq(seen[0].tool_name, "Bash", "for the Bash tool");
    const toolResults = o.messages.filter((m) => m.type === "user").flatMap((m) => (m.type === "user" && Array.isArray(m.message.content) ? m.message.content : []));
    eq(toolResults.find((b) => b.type === "tool_result" && b.content?.toString().startsWith("ran:"))?.content, "ran:echo rewritten", "updatedInput replaces the tool input before it runs");
    eq(results(o)[0].result, "allowed:echo rewritten", "the turn continued after the allow");
  }
  {
    const o = await drive(
      await runClaudeCliQuery(
        feedOf("TOOL nope"),
        baseOptions({ canUseTool: async () => ({ behavior: "deny", message: "user said no" }) }),
      ),
    );
    eq(results(o)[0].result, "denied", "a deny ends the tool call; the turn still completes");
    const toolResults = o.messages.filter((m) => m.type === "user").flatMap((m) => (m.type === "user" && Array.isArray(m.message.content) ? m.message.content : []));
    const denied = toolResults.find((b) => b.type === "tool_result") as { is_error?: boolean; content?: unknown };
    eq([denied.is_error, denied.content], [true, "user said no"], "the model sees the host's deny reason as the tool error");
  }

  /* ────────────────────────────────────────────────────────────────────
   * 5. AskUserQuestion
   * ──────────────────────────────────────────────────────────────────── */
  section("5. AskUserQuestion: answers travel back through updatedInput");
  {
    let asked = 0;
    const o = await drive(
      await runClaudeCliQuery(
        feedOf("ASK"),
        baseOptions({
          canUseTool: async (toolName, input) => {
            asked += 1;
            eq(toolName, "AskUserQuestion", "the question arrives as an AskUserQuestion tool ask");
            const q = (input.questions as Array<{ question: string }>)[0];
            return { behavior: "allow", updatedInput: { questions: input.questions, answers: { [q.question]: "Blue" } } };
          },
        }),
      ),
    );
    eq(asked, 1, "one ask");
    eq(replies(o)[0], 'answers:{"Color?":"Blue"}', "the CLI executed the tool with the user's answers");
  }

  /* ────────────────────────────────────────────────────────────────────
   * 6. Plan approval dialog
   * ──────────────────────────────────────────────────────────────────── */
  section("6. plan approval dialog (request_user_dialog)");
  const dialogCases: Array<[boolean, string, string]> = [
    [true, "yes", "plan:approved"],
    [false, "no", "plan:rejected"],
  ];
  for (const [approved, label, expected] of dialogCases) {
    let dialog: { kind: string; plan: string; toolUseId: string | undefined } | null = null;
    const decision: UserDialogResult = approved
      ? { behavior: "completed", result: { approved: true, plan: "final", message: "ok" } }
      : { behavior: "completed", result: { approved: false, reason: "nope" } };
    const o = await drive(
      await runClaudeCliQuery(
        feedOf(`PLAN ${label}`),
        baseOptions({
          onUserDialog: async (request) => {
            dialog = { kind: request.dialogKind, plan: String(request.payload.plan), toolUseId: request.toolUseID };
            return decision;
          },
        }),
      ),
    );
    eq(dialog, { kind: "permission_exit_plan_mode_v2", plan: `plan for ${label}`, toolUseId: "toolu_plan" }, `dialog ${label}: kind, plan payload and tool id reach the host`);
    eq(replies(o)[0], expected, `dialog ${label}: the CLI applied the host's answer`);
  }
  {
    // No dialog handler → nothing is answered (never a "cancelled").
    const o = await drive(await runClaudeCliQuery(feedOf("PLAN silent"), baseOptions()));
    eq(replies(o)[0], "plan:silent", "with no onUserDialog the ask is left unanswered, not cancelled");
  }

  /* ────────────────────────────────────────────────────────────────────
   * 7. Other CLI → host requests
   * ──────────────────────────────────────────────────────────────────── */
  section("7. elicitation + unknown control subtypes");
  {
    const o = await drive(await runClaudeCliQuery(feedOf("ELICIT"), baseOptions()));
    eq(replies(o)[0], 'elicit:{"action":"decline"}', "an MCP elicitation is declined (Mcode renders no form)");
  }
  {
    const o = await drive(await runClaudeCliQuery(feedOf("UNKNOWNCTRL"), baseOptions()));
    eq(replies(o)[0], "unknown:error:unsupported_request", "an unrecognized CLI request gets an error response with the CLI's own error code");
  }
  {
    // Noise on stdout must not break framing.
    const o = await drive(await runClaudeCliQuery(feedOf("NOISE x"), baseOptions()));
    eq(results(o)[0].result, "reply:x", "non-JSON lines between frames are skipped");
  }
  {
    // The CLI withdraws an ask: the handler's abort signal fires and the
    // transport sends no response for it.
    let signalAborted = false;
    const o = await drive(
      await runClaudeCliQuery(
        feedOf("CANCEL"),
        baseOptions({
          canUseTool: async (_t, _i, opts) =>
            new Promise<PermissionResult>((resolve) => {
              opts.signal.addEventListener("abort", () => {
                signalAborted = true;
                resolve({ behavior: "deny", message: "gone" });
              });
            }),
        }),
      ),
    );
    ok(signalAborted, "control_cancel_request aborts the in-flight handler");
    eq(results(o)[0].result, "cancelled", "the turn went on after the withdraw");
  }

  /* ────────────────────────────────────────────────────────────────────
   * 8. Host → CLI requests
   * ──────────────────────────────────────────────────────────────────── */
  section("8. host → CLI control requests: get_context_usage, stop_task");
  {
    // These must go out while the process is alive: hold the feed open after
    // the first turn so the fake CLI keeps waiting for more input.
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const feed = (async function* () {
      yield { type: "user", message: { role: "user", content: "TASKS" }, parent_tool_use_id: null };
      await held;
    })();
    const query = await runClaudeCliQuery(feed, baseOptions());
    const collected: ClaudeMessage[] = [];
    const draining = (async () => {
      for await (const m of query) collected.push(m);
    })();
    await until(() => collected.some(isResult));
    eq(replies({ messages: collected, init: null }), ["started"], "the turn ran while the feed stayed open");
    ok(query.transport.isWritable(), "the process is alive and its stdin still takes frames");
    const usage = await query.getContextUsage();
    eq([usage.totalTokens, usage.maxTokens, usage.model], [1234, 200000, "fake-model"], "get_context_usage answers while the process lives");
    await query.stopTask("bash1");
    await until(() => collected.some((m) => m.type === "system" && m.subtype === "task_notification"));
    ok(true, "stop_task resolves, and the CLI's task_notification for it reaches the stream");
    await assert.rejects(
      query.stopTask("missing"),
      (err: Error & { code?: string }) => err.message.includes("No such task") && err.code === "not_found",
    );
    ok(true, "a stop_task error response rejects with the CLI's error + code");
    release();
    await draining;
    await Promise.race([query.transport.closed, sleep(4000)]);
    eq(collected.filter((m) => m.type === "system" && m.subtype === "task_started").length, 1, "task lifecycle frames were forwarded");
  }

  /* ────────────────────────────────────────────────────────────────────
   * 9. Failure shapes
   * ──────────────────────────────────────────────────────────────────── */
  section("9. failures: error result, crash, abort, kill");
  {
    const o = await drive(await runClaudeCliQuery(feedOf("FAIL401"), baseOptions()), () => false);
    ok(o.error?.message.startsWith("Claude Code returned an error result: API error 401"), `an error result's own text replaces the exit error (${o.error?.message})`);
    eq(results(o).length, 1, "the error result frame itself still reached the stream first");
  }
  {
    const o = await drive(await runClaudeCliQuery(feedOf("CRASH"), baseOptions()), () => false);
    ok(/exited with code 3/.test(o.error?.message ?? ""), `a crash without a result surfaces the exit code (${o.error?.message})`);
  }
  {
    const ac = new AbortController();
    const query = await runClaudeCliQuery(feedOf("HANG"), baseOptions({ abortController: ac }));
    const done = drive(query, () => false);
    await sleep(400);
    ok(query.transport.isWritable(), "the hung turn left the process running");
    ac.abort();
    const o = await done;
    ok(o.error instanceof CliAbortedError, `a user stop ends the stream with CliAbortedError (${o.error?.name})`);
    eq(results(o).length, 0, "no result was invented for the interrupted turn");
  }
  {
    // A process that ignores stdin EOF is killed once the grace runs out.
    const ac = new AbortController();
    const killed: number[] = [];
    const query = await runClaudeCliQuery(
      feedOf("IGNORE_EOF"),
      baseOptions({
        abortController: ac,
        eofGraceMs: 150,
        hardKill: (child) => {
          killed.push(child.pid!);
          child.kill("SIGKILL");
        },
      }),
    );
    const done = drive(query, () => false);
    await sleep(500);
    const pid = query.transport.pid!;
    ac.abort();
    const o = await done;
    ok(killed.length === 1 && killed[0] === pid, "hardKill is invoked on the live process after the grace");
    ok(o.error instanceof CliAbortedError, "the aborted stream reports CliAbortedError");
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    ok(!alive, "the killed process is gone");
  }

  /* ────────────────────────────────────────────────────────────────────
   * 10. Host MCP server over loopback HTTP
   * ──────────────────────────────────────────────────────────────────── */
  section("10. host MCP server (Streamable HTTP)");
  {
    const calls: unknown[] = [];
    const server = await startHostMcpServer({
      name: "mcode-fake",
      instructions: "fake tools",
      alwaysLoad: true,
      tools: [
        {
          name: "fake_tool",
          description: "A fake tool.",
          inputSchema: {
            url: z.string().describe("目标 URL"),
            device: z.enum(["desktop", "iphone"]).optional().describe("device"),
            pages: z.number().optional(),
            steps: z.array(z.object({ op: z.string() }).passthrough()).min(1).max(40).describe("steps"),
            note: z.string().nullable().optional(),
          },
          handler: async (args) => {
            calls.push(args);
            return { content: [{ type: "text", text: `got:${String(args.url)}` }] };
          },
        },
        {
          name: "fake_boom",
          description: "Always throws.",
          inputSchema: {},
          handler: async () => {
            throw new Error("exploded");
          },
        },
      ],
    });
    const url = server.config.url;
    ok(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/[0-9a-f]{48}$/.test(url), "served on loopback with a random token in the path");
    const post = (body: unknown, target = url) =>
      fetch(target, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify(body),
      });
    const json = async (body: unknown, target = url) => {
      const res = await post(body, target);
      return { status: res.status, body: (res.status === 202 ? undefined : await res.json()) as Record<string, unknown> };
    };

    const init = await json({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "c", version: "1" } } });
    eq(init.status, 200, "initialize answers 200 with JSON (no SSE needed)");
    eq((init.body.result as Record<string, unknown>).protocolVersion, "2025-06-18", "the client's protocol version is echoed");
    eq((init.body.result as Record<string, unknown>).serverInfo, { name: "mcode-fake", version: "1.0.0" }, "serverInfo names the server");
    eq((init.body.result as Record<string, unknown>).instructions, "fake tools", "instructions are surfaced");
    const odd = await json({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "garbage" } });
    eq((odd.body.result as Record<string, unknown>).protocolVersion, "2025-06-18", "a non-dated protocol version falls back to the default");
    eq((await json({ jsonrpc: "2.0", method: "notifications/initialized" })).status, 202, "notifications get an empty 202");
    eq((await json({ jsonrpc: "2.0", id: 2, method: "ping" })).body.result, {}, "ping");

    const list = await json({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    const tools = (list.body.result as { tools: Array<Record<string, unknown>> }).tools;
    eq(tools.map((t) => t.name), ["fake_tool", "fake_boom"], "tools/list returns every tool in order");
    eq(tools[0]._meta, { "anthropic/alwaysLoad": true }, "alwaysLoad rides each tool's _meta");
    const schema = tools[0].inputSchema as {
      type: string;
      properties: Record<string, Record<string, unknown>>;
      required: string[];
    };
    eq(schema.type, "object", "input schema is an object schema");
    eq(Object.keys(schema.properties).sort(), ["device", "note", "pages", "steps", "url"], "every zod property is advertised");
    eq(schema.required, ["url", "steps"], "only non-optional properties are required (nullable stays required-able, optional does not)");
    eq([schema.properties.url.type, schema.properties.url.description], ["string", "目标 URL"], "string + description");
    eq(schema.properties.device.enum, ["desktop", "iphone"], "z.enum → enum");
    eq([schema.properties.steps.type, schema.properties.steps.minItems, schema.properties.steps.maxItems], ["array", 1, 40], "array bounds");
    eq((schema.properties.steps.items as Record<string, unknown>).additionalProperties, true, "passthrough objects keep additionalProperties");
    eq(schema.properties.note.type, "string", "nullable().optional() unwraps to the inner type");

    const call = await json({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "fake_tool", arguments: { url: "x", steps: [{ op: "go", extra: 1 }], device: "iphone", stray: "kept" } } });
    eq(call.body.result, { content: [{ type: "text", text: "got:x" }] }, "tools/call returns the handler's content");
    eq(calls[0], { url: "x", steps: [{ op: "go", extra: 1 }], device: "iphone", stray: "kept" }, "the handler gets parsed args with unknown keys kept");
    const invalid = await json({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "fake_tool", arguments: { steps: [] } } });
    eq((invalid.body.result as { isError?: boolean }).isError, true, "arguments failing the schema → isError result");
    ok(String((invalid.body.result as { content: Array<{ text: string }> }).content[0].text).includes("Invalid arguments"), "…naming the offending field");
    const boom = await json({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "fake_boom", arguments: {} } });
    eq([(boom.body.result as { isError?: boolean }).isError, (boom.body.result as { content: Array<{ text: string }> }).content[0].text], [true, "Tool fake_boom failed: exploded"], "a throwing handler is a tool error, not a protocol error");
    eq((await json({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "nope", arguments: {} } })).body.error, { code: -32602, message: "Unknown tool: nope" }, "unknown tool → -32602");
    eq((await json({ jsonrpc: "2.0", id: 8, method: "resources/list" })).body.result, { resources: [] }, "no resources advertised");
    eq((await json({ jsonrpc: "2.0", id: 9, method: "bogus/method" })).body.error, { code: -32601, message: "Method not found: bogus/method" }, "unknown method → -32601");

    const batch = await post([{ jsonrpc: "2.0", id: 10, method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }]);
    eq([batch.status, await batch.json()], [200, [{ jsonrpc: "2.0", id: 10, result: {} }]], "a batch answers only its requests, as an array");
    const onlyNotes = await post({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "1" } });
    eq(onlyNotes.status, 202, "a lone notification is a bare 202");
    const get = await fetch(url);
    eq([get.status, get.headers.get("allow")], [405, "POST, DELETE"], "GET (server→client stream) is 405 for a stateless server");
    eq((await fetch(url, { method: "DELETE" })).status, 204, "DELETE (session end) is 204");
    const noToken = await post({ jsonrpc: "2.0", id: 1, method: "ping" }, url.replace(/\/mcp\/.+/, "/mcp"));
    eq(noToken.status, 404, "a request without the token looks like nothing is there");
    const last = url.slice(-1);
    const badToken = await post({ jsonrpc: "2.0", id: 1, method: "ping" }, `${url.slice(0, -1)}${last === "0" ? "1" : "0"}`);
    eq(badToken.status, 404, "a wrong token is rejected the same way");
    const badBody = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
    eq(badBody.status, 400, "an unparseable body is 400");
    await server.close();
    await assert.rejects(fetch(url));
    ok(true, "close() stops the server");
  }

  /* ────────────────────────────────────────────────────────────────────
   * 11. Host tools reach the CLI through --mcp-config
   * ──────────────────────────────────────────────────────────────────── */
  section("11. host MCP server wired into a launch");
  {
    const query = await runClaudeCliQuery(
      feedOf("with tools"),
      baseOptions({
        mcpServers: { "plugin-srv": { command: "stub-server", args: ["--x"] } },
        hostMcpServers: {
          "mcode-fake": { alwaysLoad: true, tools: [{ name: "t", description: "d", inputSchema: {}, handler: () => ({ content: [{ type: "text", text: "ok" }] }) }] },
        },
      }),
    );
    const o = await drive(query);
    eq(systemInit(o).mcp_servers.map((s) => s.name), ["plugin-srv", "mcode-fake"], "the CLI saw both MCP servers");
    const [rec] = dumpRecords().slice(-1);
    ok(!rec.args.some((a) => a.includes("mcode-fake") || a.includes("stub-server")), "MCP config is not on the command line");
    const servers = (rec.mcp as { mcpServers: Record<string, Record<string, unknown>> }).mcpServers;
    eq(servers["plugin-srv"], { command: "stub-server", args: ["--x"] }, "config-defined servers pass through to --mcp-config");
    eq([servers["mcode-fake"].type, /^http:\/\/127\.0\.0\.1:\d+\/mcp\/[0-9a-f]{48}$/.test(String(servers["mcode-fake"].url))], ["http", true], "host tools are listed as a loopback http server");
    ok(existsSync(argAfter(rec.args, "--mcp-config")) === false, "the mcp-config temp file is deleted after the run");
  }

  /* ────────────────────────────────────────────────────────────────────
   * 12. Executable resolution + version gate
   * ──────────────────────────────────────────────────────────────────── */
  section("12. locating the CLI + version gate");
  {
    eq(compareVersions("2.1.218", "2.1.218"), 0, "compareVersions: equal");
    ok(compareVersions("2.1.303", "2.1.218") > 0, "compareVersions: newer patch");
    ok(compareVersions("2.1.9", "2.1.218") < 0, "compareVersions: numeric, not lexicographic");
    ok(compareVersions("2.2.0", "2.1.999") > 0, "compareVersions: minor beats patch");

    const pkg = join(WORK, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin");
    mkdirSync(pkg, { recursive: true });
    // "MZ" + padding: enough of the PE magic for a native-binary check.
    writeFileSync(join(pkg, "claude.exe"), Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x01]));
    mkdirSync(join(WORK, "native"), { recursive: true });
    const nativePath = join(WORK, "native", process.platform === "win32" ? "claude.exe" : "claude");
    writeFileSync(nativePath, Buffer.from([0x4d, 0x5a, 0x00, 0x00]));

    const direct = spawnableClaudeExecutable(nativePath);
    eq([direct.source, direct.command, direct.preArgs], ["native", nativePath, []], "a native binary is spawned directly");

    const shimDir = join(WORK, "npm");
    const shimName = process.platform === "win32" ? "claude.cmd" : "claude";
    writeFileSync(join(shimDir, shimName), '@ECHO off\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*\n');
    const viaShim = spawnableClaudeExecutable(join(shimDir, shimName));
    eq([viaShim.source, viaShim.path], ["npm", join(shimDir, shimName)], "an npm shim is followed, and the user-facing path stays the shim");
    ok(viaShim.command.endsWith(join("@anthropic-ai", "claude-code", "bin", "claude.exe")) && viaShim.preArgs.length === 0 && !viaShim.shell, "…to the package's native binary, spawned directly (no shell)");

    const jsDir = join(WORK, "js");
    const jsTarget = join(jsDir, "node_modules", "@anthropic-ai", "claude-code", "cli.js");
    mkdirSync(dirname(jsTarget), { recursive: true });
    writeFileSync(jsTarget, "// launcher\n");
    writeFileSync(join(jsDir, shimName), `node "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\n`);
    const viaJs = spawnableClaudeExecutable(join(jsDir, shimName));
    eq([viaJs.source, viaJs.preArgs], ["node-launcher", [jsTarget]], "a JS launcher runs under node with the script as a pre-arg");
    ok(viaJs.command.length > 0, "a node runtime is picked for the launcher");

    const brokenDir = join(WORK, "broken");
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(join(brokenDir, shimName), "@ECHO off\necho nowhere\n");
    const unresolved = spawnableClaudeExecutable(join(brokenDir, shimName));
    eq([unresolved.source, unresolved.shell], ["shim", true], "a shim whose target cannot be found falls back to a shell launch");

    eq(await probeClaudeCliVersion(fakeExecutable("2.1.303")), "2.1.303", "probeClaudeCliVersion parses `claude --version`");
    ok(await assertClaudeCliUsable(fakeExecutable("2.1.218")) instanceof Object, "the minimum version passes the gate");
    await assert.rejects(
      runClaudeCliQuery(feedOf("x"), baseOptions({ executable: fakeExecutable("2.1.100") })),
      (err: unknown) => err instanceof ClaudeCliUnavailableError && err.message.includes("2.1.100"),
    );
    ok(true, "a CLI older than the minimum refuses to launch with the version in the message");

    const missing = baseOptions({ executable: undefined });
    (missing as { executable?: ClaudeExecutable }).executable = { command: join(WORK, "nope", "claude-missing"), preArgs: [], path: "x", source: "native" };
    const o = await drive(await runClaudeCliQuery(feedOf("x"), missing), () => false);
    ok(/Failed to spawn Claude Code process/.test(o.error?.message ?? ""), `a missing binary is a spawn error, not a hang (${o.error?.message})`);
  }

  /* ────────────────────────────────────────────────────────────────────
   * 13. One-shot runner (titles, commit messages, endpoint probe)
   * ──────────────────────────────────────────────────────────────────── */
  section("13. one-shot runner");
  const oneShot = (over: Record<string, unknown>) =>
    runClaudeOneShot({
      prompt: "SAY the title",
      systemPrompt: "You write titles.",
      tools: [],
      abortController: new AbortController(),
      cwd: WORK,
      executable: fakeExecutable(),
      env: { ...process.env, FAKE_CLAUDE_DUMP: DUMP, FAKE_CLAUDE_VERSION: "2.1.303" },
      ...over,
    });
  {
    const r = await oneShot({});
    eq([r.lastText, r.text, r.assistantSeen, r.result?.result], ["reply:the title", "reply:the title", true, "reply:the title"], "a plain one-shot returns the reply as lastText");
    eq(r.init?.claude_code_version, "2.1.303", "the init frame is handed back");
    const [rec] = dumpRecords().slice(-1);
    eq([argAfter(rec.args, "--max-turns"), rec.args.find((a) => a.startsWith("--tools")), argAfter(rec.args, "--setting-sources")], ["1", "--tools=", "project,local"], "launched with one turn, no tools, project+local settings");
    ok(!rec.args.some((a) => a.startsWith("--permission-prompt-tool")), "one-shots never request the stdio permission channel");
  }
  {
    // A tool ask with nobody to approve it: stdin must still be open for
    // the refusal to reach the CLI — closing it after the prompt would
    // strand the ask, and the turn with it.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 8000);
    const r = await oneShot({ prompt: "TOOLREFUSE x", tools: "default", abortController: ac });
    clearTimeout(timer);
    eq([r.lastText, r.result?.result], ["denied:canUseTool callback is not provided", "refused"], "an unanswerable tool ask gets the refusal and the turn completes");
  }
  {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 8000);
    const r = await oneShot({ prompt: "HANG", abortController: ac, stopAtInit: true });
    clearTimeout(timer);
    eq([r.init?.session_id, r.result], ["00000000-0000-4000-8000-000000000001", null], "stopAtInit returns at system/init, before any result");
  }

  rmSync(WORK, { recursive: true, force: true });
  console.log(`\n✓ claude-cli-transport-smoke: ${passed} assertions passed`);
} catch (err) {
  rmSync(WORK, { recursive: true, force: true });
  console.error(`\n✗ claude-cli-transport-smoke failed after ${passed} assertions:`);
  console.error(err);
  process.exit(1);
}
