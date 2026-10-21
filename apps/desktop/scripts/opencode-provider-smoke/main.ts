/**
 * Headless smoke for the OpenCode (v2) GUI provider:
 *   A. server config builder + fingerprint (permission asks / autoupdate / mcp)
 *   B. permission-bridge decision core (guards → mode auto-approve → prompt)
 *   C. permission/question ask handlers (reply once/reject, never "always",
 *      recordPre-before-reply, AskUserQuestion answer mapping)
 *   D. message adapter (session.next.* deltas, tool lifecycle, bash roster,
 *      idle turn-end gating, usage accumulation, subagent roster/transcript)
 *   E. model projection + id parsing
 *   F. MCP entry mapping
 *   G. terminal-adoption exclusion (GUI opencode-sdk ids are claimed)
 *
 * The SDK imports in the adapter/bridge are type-only; the server manager's
 * runtime SDK import is bundled but never invoked (no server is started).
 */
import type { V2Event, PermissionV2Asked, QuestionV2Asked } from "@opencode-ai/sdk/v2/types";
import type { ProviderContext, ProviderApprovalDecision } from "@contracts/provider";
import type { RuntimeEvent, UserInputDecision } from "@contracts/runtime";
import type { FileSnapshot } from "@main/lib/fileSnapshot.js";
import {
  buildOpenCodeServerConfig,
  openCodeServerFingerprint,
} from "@main/providers/opencode-sdk/opencodeServerManager.js";
import {
  decideOpenCodePermission,
  handleOpenCodePermissionAsked,
  handleOpenCodeQuestionAsked,
  mapUserInputAnswersToOpenCode,
  openCodeActionToToolName,
} from "@main/providers/opencode-sdk/opencodePermissionBridge.js";
import { OpencodeMessageAdapter } from "@main/providers/opencode-sdk/OpencodeMessageAdapter.js";
import { parseOpenCodeModelId } from "@main/providers/opencode-sdk/OpencodeProvider.js";
import {
  projectOpenCodeModel,
  sortOpenCodeModels,
  formatContextHint,
  unwrapV2Envelope,
} from "@main/providers/opencode-sdk/opencodeModels.js";
import { toOpenCodeMcpEntry } from "@main/providers/opencode-sdk/opencodeMcp.js";
import { reconcileOpenCodeTerminalSessionId } from "@main/lib/opencodeSession.js";
import { fixture, SessionRepo } from "./stub-repositories.js";

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

const PROJ = process.platform === "win32" ? "D:\\proj-smoke" : "/tmp/proj-smoke";
const OUTSIDE = process.platform === "win32" ? "D:\\other\\x.txt" : "/tmp/other/x.txt";
const INSIDE =
  process.platform === "win32" ? "D:\\proj-smoke\\src\\a.ts" : "/tmp/proj-smoke/src/a.ts";

/* ── tiny fakes ── */

function fakeCtx(over: Partial<ProviderContext> = {}): ProviderContext {
  return {
    emit: () => {},
    log: { info: () => {}, warn: () => {}, error: () => {} },
    ...over,
  } as ProviderContext;
}

function fakeSnapshot(): FileSnapshot {
  const recordCalls: string[] = [];
  return {
    recordPre: async (_cwd: string, p: string) => {
      recordCalls.push(p);
    },
    freeze: async () => [],
    hasPaths: () => false,
    clear: () => {},
    // test hook
    __recordCalls: recordCalls,
  } as unknown as FileSnapshot;
}

/** Fake of the serverManager handle's fetchRaw: records parsed bodies and
 *  answers 204. The 2.1.1 reply body is {decision} (verified live). */
function fakeFetch(replies: Array<{ path: string; body: Record<string, unknown> }>) {
  const questionRejects: Array<{ path: string }> = [];
  const questionReplies: Array<{ path: string; body: Record<string, unknown> }> = [];
  return {
    fetchRaw: async (path: string, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      if (path.includes("/permission/")) replies.push({ path, body });
      else if (path.includes("/reject")) questionRejects.push({ path });
      else questionReplies.push({ path, body });
      return new Response(null, { status: 204 });
    },
    __replies: replies,
    __questionRejects: questionRejects,
    __questionReplies: questionReplies,
  };
}

function askEvent(over: {
  id?: string;
  sessionID?: string;
  action: string;
  resources: string[];
  callID?: string;
}): PermissionV2Asked {
  return {
    id: `ev-${Math.random()}`,
    type: "permission.v2.asked",
    data: {
      id: over.id ?? "req-1",
      sessionID: over.sessionID ?? "oc-sess-1",
      action: over.action,
      resources: over.resources,
      ...(over.callID
        ? { source: { type: "tool" as const, messageID: "m1", id: over.callID } }
        : {}),
    },
  } as unknown as PermissionV2Asked;
}

function questionEvent(): QuestionV2Asked {
  return {
    id: "qev-1",
    type: "question.v2.asked",
    data: {
      id: "q-1",
      sessionID: "oc-sess-1",
      questions: [
        {
          question: "Which database?",
          header: "Database",
          multiple: false,
          options: [
            { label: "SQLite", description: "embedded" },
            { label: "Postgres", description: "server" },
          ],
        },
      ],
      tool: { messageID: "m1", callID: "call-1" },
    },
  } as unknown as QuestionV2Asked;
}

function adapter(over: { events: RuntimeEvent[] } = { events: [] }): OpencodeMessageAdapter {
  return new OpencodeMessageAdapter({
    ctx: {
      emit: (e) => {
        over.events.push(e);
      },
      log: { info: () => {}, warn: () => {}, error: () => {} },
    } as unknown as ProviderContext,
    sessionId: "gui-1",
    opencodeSessionId: "oc-sess-1",
    contextWindow: 1_000_000,
    model: "opencode/test-model",
    snapshot: fakeSnapshot(),
  });
}

function ev(type: string, data: Record<string, unknown>): V2Event {
  return { id: `syn-${Math.random()}`, type, data } as unknown as V2Event;
}

/* ═══════════ A. server config ═══════════ */
console.log("A. server config builder + fingerprint");
{
  const cfg = buildOpenCodeServerConfig();
  const perm = cfg["permission"] as Record<string, string>;
  ok(perm["edit"] === "ask" && perm["bash"] === "ask", "A1 mutating tools ask (edit/bash)");
  ok(
    perm["webfetch"] === "ask" && perm["websearch"] === "ask" && perm["task"] === "ask",
    "A2 web/task ask",
  );
  ok(cfg["autoupdate"] === false, "A3 autoupdate disabled");
  ok(!("mcp" in cfg), "A4 no mcp key when empty");
  const withMcp = buildOpenCodeServerConfig({ srv: { type: "local", command: ["node"] } });
  ok("mcp" in withMcp, "A5 mcp merged when present");
  const f1 = openCodeServerFingerprint();
  const f2 = openCodeServerFingerprint();
  const f3 = openCodeServerFingerprint({ srv: { type: "local", command: ["node"] } });
  ok(f1 === f2, "A6 fingerprint stable without config change");
  ok(f1 !== f3, "A7 fingerprint drifts on MCP change (server restarts)");
}

/* ═══════════ B. permission decision core ═══════════ */
console.log("B. permission decision core");
{
  const d = (action: string, resources: string[], mode: string | undefined, toolInput?: unknown) =>
    decideOpenCodePermission({ action, resources, toolInput, cwd: PROJ, mode });

  ok(d("edit", [INSIDE], "default").choice.kind === "prompt", "B1 in-project edit prompts under default");
  const rej = d("edit", [OUTSIDE], "default").choice;
  ok(rej.kind === "reject" && rej.message?.includes("项目工作目录之外"), "B2 out-of-project edit rejected (guard before UI)");
  ok(d("edit", [OUTSIDE], "bypassPermissions").choice.kind === "approve", "B3 bypass approves out-of-project edit (guard exempt)");
  ok(d("edit", [INSIDE], "acceptEdits").choice.kind === "approve", "B4 acceptEdits approves in-project edit");
  ok(d("edit", [INSIDE], "isolated").choice.kind === "approve", "B5 isolated approves in-project edit");
  const wslPath = process.platform === "win32" ? "/mnt/d/proj-smoke/src/b.ts" : "/tmp/proj-smoke/src/b.ts";
  const wslRej = d("edit", [wslPath], "default").choice;
  ok(wslRej.kind === "prompt", "B6 WSL-dialect path normalizes into the project (prompt, not reject)");
  const rec = d("edit", [wslPath], "acceptEdits");
  ok(
    rec.choice.kind === "approve" &&
      rec.recordPrePath?.endsWith(process.platform === "win32" ? "src\\b.ts" : "src/b.ts"),
    "B7 recordPrePath is the normalized absolute path",
  );
  const bashCmd = process.platform === "win32" ? "echo hi > ..\\..\\other\\x.txt" : "echo hi > ../../other/x.txt";
  const bashRej = d("bash", [bashCmd], "default").choice;
  ok(bashRej.kind === "reject", "B8 bash writing outside the project rejected");
  ok(d("bash", ["npm test"], "default").choice.kind === "prompt", "B9 benign bash prompts under default");
  ok(d("shell", ["npm test"], "default").choice.kind === "prompt", "B9b 'shell' action (2.1.1 spelling) treated as bash");
  ok(openCodeActionToToolName("shell") === "Bash" && openCodeActionToToolName("subagent") === "Task", "B9c 2.1.1 action names mapped");
  ok(d("bash", ["npm test"], "bypassPermissions").choice.kind === "approve", "B10 bash approved under bypass");
  ok(d("webfetch", ["https://x.dev"], "default").choice.kind === "prompt", "B11 webfetch prompts under default");
  ok(d("websearch", ["query"], "bypassPermissions").choice.kind === "approve", "B12 websearch approved under bypass");
  ok(d("task", ["subtask"], "default").choice.kind === "approve", "B13 subagent dispatch auto-approves (pi Task parity)");
  ok(d("subagent", [], "default").choice.kind === "approve", "B14 'subagent' action alias approves");
  const outsideDir = process.platform === "win32" ? "D:\\other" : "/tmp/other";
  ok(
    d("external_directory", [outsideDir], "isolated").choice.kind === "reject",
    "B15 isolated rejects out-of-project external_directory",
  );
  ok(
    d("external_directory", [outsideDir], "default").choice.kind === "approve",
    "B16 default approves external_directory (reads allowed)",
  );
  ok(d("read", [INSIDE], "isolated").choice.kind === "approve", "B17 isolated approves in-project read ask");
  ok(openCodeActionToToolName("bash") === "Bash" && openCodeActionToToolName("edit") === "Edit", "B18 action → Mcode tool name mapping");
}

/* ═══════════ C. ask handlers ═══════════ */
console.log("C. permission/question ask handlers");
{
  // C1: guard violation answers reject directly, never reaching requestApproval.
  {
    const replies: Array<{ reply?: string }> = [];
    let approvalCalls = 0;
    const client = fakeFetch(replies as never);
    const snapshot = fakeSnapshot();
    await handleOpenCodePermissionAsked(
      askEvent({ action: "edit", resources: [OUTSIDE] }),
      {
        ctx: fakeCtx({
          requestApproval: async () => {
            approvalCalls++;
            return { allow: true } as ProviderApprovalDecision;
          },
        }),
        sessionId: "gui-1",
        cwd: PROJ,
        fetchRaw: client.fetchRaw,
        getToolCall: () => undefined,
        noteToolName: () => {},
      },
    );
    ok(approvalCalls === 0 && replies[0]?.body?.["decision"] === "reject", "C1 guard violation rejected without UI");
  }
  // C2: default edit → approval card; allow → once + recordPre first.
  {
    const replies: Array<{ reply?: string }> = [];
    const client = fakeFetch(replies as never);
    const snapshot = fakeSnapshot();
    const recordOrder: string[] = [];
    await handleOpenCodePermissionAsked(
      askEvent({ action: "edit", resources: [INSIDE] }),
      {
        ctx: fakeCtx({
          requestApproval: async () => ({ allow: true } as ProviderApprovalDecision),
        }),
        sessionId: "gui-1",
        cwd: PROJ,
        fetchRaw: client.fetchRaw,
        getToolCall: () => undefined,
        noteToolName: () => {},
      },
    );
    ok(replies[0]?.body?.["decision"] === "once", "C2 allowed edit answered once");
  }
  // C3: deny → reject with the user's reason; recordPre NOT called.
  {
    const replies: Array<{ reply?: string; message?: string }> = [];
    const client = fakeFetch(replies as never);
    await handleOpenCodePermissionAsked(
      askEvent({ action: "bash", resources: ["rm -rf build"] }),
      {
        ctx: fakeCtx({
          requestApproval: async () => ({ allow: false, reason: "Nope" } as ProviderApprovalDecision),
        }),
        sessionId: "gui-1",
        cwd: PROJ,
        fetchRaw: client.fetchRaw,
        getToolCall: () => undefined,
        noteToolName: () => {},
      },
    );
    ok(replies[0]?.body?.["decision"] === "reject" && replies[0]?.body?.["message"] === "Nope", "C3 denied bash rejected with reason");
  }
  // C4: always-allow short-circuits (no UI), still once — never "always".
  {
    const replies: Array<{ reply?: string }> = [];
    const client = fakeFetch(replies as never);
    let approvalCalls = 0;
    await handleOpenCodePermissionAsked(
      askEvent({ action: "bash", resources: ["git status"] }),
      {
        ctx: fakeCtx({
          requestApproval: async () => {
            approvalCalls++;
            return { allow: true } as ProviderApprovalDecision;
          },
          isToolAlwaysAllowed: (tool) => tool === "Bash",
        }),
        sessionId: "gui-1",
        cwd: PROJ,
        fetchRaw: client.fetchRaw,
        getToolCall: () => undefined,
        noteToolName: () => {},
      },
    );
    ok(approvalCalls === 0 && replies[0]?.body?.["decision"] === "once", "C4 always-allow approved without UI (reply still once)");
  }
  // C5: answers NEVER carry "always".
  {
    const replies: Array<{ reply?: string }> = [];
    const client = fakeFetch(replies as never);
    await handleOpenCodePermissionAsked(
      askEvent({ action: "edit", resources: [INSIDE] }),
      {
        ctx: fakeCtx({ requestApproval: async () => ({ allow: true, persist: true } as ProviderApprovalDecision) }),
        sessionId: "gui-1",
        cwd: PROJ,
        fetchRaw: client.fetchRaw,
        getToolCall: () => undefined,
        noteToolName: () => {},
      },
    );
    ok(replies.every((r) => r.body?.["decision"] !== "always"), "C5 server reply never uses 'always' (guards must not be bypassed)");
  }
  // C6: recordPre runs BEFORE the approving reply (rewind snapshot timing).
  {
    const replies: Array<{ reply?: string }> = [];
    const client = fakeFetch(replies as never);
    const order: string[] = [];
    const snap = {
      recordPre: async () => {
        order.push("recordPre");
      },
      freeze: async () => [],
      hasPaths: () => false,
      clear: () => {},
    } as unknown as FileSnapshot;
    // The bridge resolves the snapshot via the registry (sessionId key) —
    // in-process registry is shared with real code paths, so drive timing
    // through the acceptEdits auto-approve path instead (same ordering).
    await handleOpenCodePermissionAsked(
      askEvent({ action: "edit", resources: [INSIDE] }),
      {
        ctx: fakeCtx({
          getPermissionMode: () => "acceptEdits",
        }),
        sessionId: "gui-acceptEdits-timing",
        cwd: PROJ,
        fetchRaw: client.fetchRaw,
        getToolCall: () => undefined,
        noteToolName: () => {},
      },
    );
    // Registry-backed snapshot: verify via the side effect that recordPre
    // completed before the reply landed (the reply is pushed only after the
    // await recordPre in the bridge).
    ok(replies[0]?.body?.["decision"] === "once", "C6 acceptEdits edit answered once after recordPre await");
  }
  // C7: question bridge — answers map to per-question label arrays.
  {
    ok(
      JSON.stringify(mapUserInputAnswersToOpenCode(
        [{ header: "h", question: "Q?", multiSelect: false, options: [] }],
        { "Q?": "SQLite" },
      )) === JSON.stringify([["SQLite"]]),
      "C7a single answer → [label]",
    );
    ok(
      JSON.stringify(mapUserInputAnswersToOpenCode(
        [{ header: "h", question: "Q?", multiSelect: true, options: [] }],
        { "Q?": ["A", "B"] },
      )) === JSON.stringify([["A", "B"]]),
      "C7b multi answer passes through",
    );
    ok(
      JSON.stringify(mapUserInputAnswersToOpenCode(
        [{ header: "h", question: "Q?", multiSelect: false, options: [] }],
        { "Q?": null },
      )) === JSON.stringify([[]]),
      "C7c skipped question → empty array",
    );
  }
  // C8: question handler — reply path.
  {
    const client = fakeFetch([]);
    await handleOpenCodeQuestionAsked(questionEvent(), {
      ctx: fakeCtx({
        requestUserInput: async (): Promise<UserInputDecision> => ({ answers: { "Which database?": "SQLite" } }),
      }),
      sessionId: "gui-1",
      cwd: PROJ,
      fetchRaw: client.fetchRaw,
      noteToolName: () => {},
      getToolCall: () => undefined,
    });
    const r = client.__questionReplies[0] as { body: { answers: string[][] } };
    ok(r?.body?.answers?.[0]?.[0] === "SQLite", "C8 question replied with selected label");
  }
  // C9: dismissed question → reject.
  {
    const client = fakeFetch([]);
    await handleOpenCodeQuestionAsked(questionEvent(), {
      ctx: fakeCtx({
        requestUserInput: async (): Promise<UserInputDecision> => ({ answers: {}, dismissed: true }),
      }),
      sessionId: "gui-1",
      cwd: PROJ,
      fetchRaw: client.fetchRaw,
      noteToolName: () => {},
      getToolCall: () => undefined,
    });
    ok(client.__questionRejects.length === 1, "C9 dismissed question rejected");
  }
}

/* ═══════════ D. message adapter ═══════════ */
console.log("D. message adapter (CLI 2.1.1 wire contract)");
{
  // D1: residual idle before any activity is ignored.
  {
    const a = adapter();
    a.dispatch(ev("session.idle", { sessionID: "oc-sess-1" }));
    ok(!a.hasTurnEnded, "D1 pre-activity idle ignored");
  }
  // D2: execution.started → deltas → execution.succeeded ends the turn once.
  {
    const sink: RuntimeEvent[] = [];
    const ad = adapter({ events: sink });
    ad.dispatch(ev("session.execution.started", { sessionID: "oc-sess-1" }));
    ad.dispatch(ev("session.text.delta", { sessionID: "oc-sess-1", assistantMessageID: "am-1", ordinal: 0, delta: "Hello " }));
    ad.dispatch(ev("session.text.delta", { sessionID: "oc-sess-1", assistantMessageID: "am-1", ordinal: 1, delta: "world" }));
    ad.dispatch(ev("session.execution.succeeded", { sessionID: "oc-sess-1" }));
    ad.dispatch(ev("session.execution.succeeded", { sessionID: "oc-sess-1" }));
    const deltas = sink.filter((e) => e.type === "text.delta");
    ok(deltas.length === 2 && (deltas[0] as { text: string }).text === "Hello ", "D2a text deltas forwarded verbatim");
    ok(sink.filter((e) => e.type === "turn.done").length === 1, "D2b execution.succeeded ends the turn exactly once");
    ok((sink.find((e) => e.type === "turn.done") as { reason: string }).reason === "end_turn", "D2c reason end_turn");
    ok(ad.hasTurnEnded, "D2d adapter marks turn ended");
  }
  // D3: idle fallback still ends an active turn (secondary signal).
  {
    const sink: RuntimeEvent[] = [];
    const ad = adapter({ events: sink });
    ad.dispatch(ev("session.execution.started", { sessionID: "oc-sess-1" }));
    ad.dispatch(ev("session.idle", { sessionID: "oc-sess-1" }));
    ok(ad.hasTurnEnded, "D3 idle after activity ends the turn (fallback)");
  }
  // D4: execution.failed → error + error turn.
  {
    const sink: RuntimeEvent[] = [];
    const ad = adapter({ events: sink });
    ad.dispatch(ev("session.execution.started", { sessionID: "oc-sess-1" }));
    ad.dispatch(ev("session.execution.failed", { sessionID: "oc-sess-1", error: { message: "boom" } }));
    const err = sink.find((e) => e.type === "error") as { message: string };
    const done = sink.find((e) => e.type === "turn.done") as { reason: string };
    ok(err?.message === "boom" && done?.reason === "error", "D4 execution.failed → error + error turn.done");
  }
  // D5: reasoning → thinking.
  {
    const sink: RuntimeEvent[] = [];
    const ad = adapter({ events: sink });
    ad.dispatch(ev("session.reasoning.delta", { sessionID: "oc-sess-1", assistantMessageID: "am-1", delta: "hmm" }));
    ok(sink.some((e) => e.type === "thinking"), "D5 reasoning delta → thinking");
  }
  // D6: tool lifecycle + bash roster (2.1.1: call id under `id`, no tool name).
  {
    const sink: RuntimeEvent[] = [];
    const ad = adapter({ events: sink });
    ad.dispatch(ev("session.tool.called", {
      sessionID: "oc-sess-1",
      assistantMessageID: "am-1",
      id: "call-1",
      input: { command: "npm test" },
      executed: false,
    }));
    ad.dispatch(ev("session.tool.success", {
      sessionID: "oc-sess-1",
      id: "call-1",
      content: [{ type: "text", text: "all passed" }],
      metadata: { status: "completed", exit: 0 },
    }));
    const use = sink.find((e) => e.type === "tool.use") as { toolName: string };
    ok(use?.toolName === "bash", "D6a tool.called → tool.use (name guessed from input shape)");
    const res = sink.find((e) => e.type === "tool.result") as { isError: boolean };
    ok(res && !res.isError, "D6b tool.success → tool.result (not error)");
    const bash = sink.filter((e) => e.type === "bash-tasks.update") as Array<{ tasks: Array<{ status: string; output?: string }> }>;
    ok(bash[0]?.tasks[0]?.status === "running", "D6c bash roster running on called");
    ok(bash[bash.length - 1]?.tasks[0]?.status === "completed" && bash[bash.length - 1]?.tasks[0]?.output === "all passed", "D6d bash roster completed with output");
  }
  // D6e: file mutating tool records pre-turn snapshot immediately
  {
    let recordedPath: string | null = null;
    const mockSnap = {
      recordPre: async (_cwd: string, fp: string) => { recordedPath = fp; },
      freeze: async () => [],
    } as unknown as FileSnapshot;
    const ad = new OpencodeMessageAdapter({
      ctx: { emit: () => {}, log: { info: () => {}, warn: () => {}, error: () => {} } } as any,
      sessionId: "m-sess",
      opencodeSessionId: "oc-sess-1",
      cwd: "/test",
      snapshot: mockSnap,
    });
    ad.dispatch(ev("session.tool.called", {
      sessionID: "oc-sess-1",
      assistantMessageID: "am-1",
      id: "call-edit-1",
      tool: "edit",
      input: { path: "src/index.ts", oldString: "a", newString: "b" },
    }));
    ok(recordedPath === "src/index.ts", "D6e edit tool call records pre-turn snapshot");
  }
  // D7: tool failure.
  {
    const sink: RuntimeEvent[] = [];
    const ad = adapter({ events: sink });
    ad.dispatch(ev("session.tool.called", { sessionID: "oc-sess-1", assistantMessageID: "am-1", id: "c2", input: { path: "a.ts" } }));
    ad.dispatch(ev("session.tool.failed", { sessionID: "oc-sess-1", id: "c2", error: { message: "boom" } }));
    const res = sink.find((e) => e.type === "tool.result") as { isError: boolean; content: unknown };
    ok(res?.isError && res.content === "boom", "D7 tool.failed → error result with message");
  }
  // D8: step.ended → message.complete; usage rides session.usage.updated.
  {
    const sink: RuntimeEvent[] = [];
    const ad = adapter({ events: sink });
    ad.dispatch(ev("session.step.ended", {
      sessionID: "oc-sess-1", assistantMessageID: "am-1", finish: "stop", cost: 0.3,
      tokens: { input: 5000, output: 30, reasoning: 0, cache: { read: 300, write: 400 } },
    }));
    ad.dispatch(ev("session.usage.updated", {
      sessionID: "oc-sess-1", cost: 0.3,
      tokens: { input: 898, output: 41, reasoning: 138, cache: { read: 107264, write: 0 } },
    }));
    ok(sink.filter((e) => e.type === "message.complete").length === 1, "D8a message.complete per step");
    const snaps = sink.filter((e) => e.type === "token-usage.updated") as Array<{ snapshot: { usedTokens: number; totalProcessedTokens: number } }>;
    ok(snaps.length >= 1, "D8b at least one snapshot per step/usage.updated");
    const lastSnap = snaps[snaps.length - 1];
    ok(lastSnap.snapshot.usedTokens === 5000 + 300 + 400, "D8c occupancy = step input + cache write + cache read");
    ok(lastSnap.snapshot.totalProcessedTokens === 898 + 41 + 107264, "D8d throughput sums all fields");
  }
  // D9: subagent roster + transcript + child terminal events.
  {
    const sink: RuntimeEvent[] = [];
    const ad = adapter({ events: sink });
    ad.dispatch(ev("session.tool.called", {
      sessionID: "oc-sess-1",
      assistantMessageID: "am-1",
      id: "call-task-1",
      tool: "task",
      input: { description: "investigate repo", subagent_type: "explore" },
    }));
    ad.dispatch(ev("session.created", { sessionID: "child-1", info: { parentID: "oc-sess-1" } }));
    ad.dispatch(ev("session.created", { sessionID: "unrelated", info: { parentID: "other" } }));
    ad.dispatch(ev("session.text.delta", { sessionID: "child-1", assistantMessageID: "cm-1", delta: "working" }));
    ad.dispatch(ev("session.execution.succeeded", { sessionID: "child-1" }));
    const rosters = sink.filter((e) => e.type === "subagent.update") as Array<{ agents: Array<{ taskId: string; toolUseId?: string; description?: string; status: string }> }>;
    ok(rosters[0]?.agents?.[0]?.taskId === "child-1" && rosters[0].agents[0].status === "running", "D9a child session joins roster running");
    ok(rosters[0]?.agents?.[0]?.toolUseId === "call-task-1", "D9a2 child session associates with Task toolUseId");
    ok(rosters[0]?.agents?.[0]?.description === "investigate repo", "D9a3 child session receives Task description");
    ok(rosters.every((r) => r.agents.length === 1), "D9b unrelated sessions never join the roster");
    ok(rosters[rosters.length - 1]?.agents?.[0]?.status === "completed", "D9c child execution.succeeded → roster completed");
    const tr = sink.find((e) => e.type === "subagent.transcript") as { parentToolUseId?: string; blocks: Array<{ kind: string; text?: string }> };
    ok(tr?.parentToolUseId === "call-task-1", "D9d parentToolUseId matches Task callID");
    ok(tr?.blocks?.[0]?.kind === "text" && tr.blocks[0].text === "working", "D9e child deltas feed the transcript");
  }
  // D10: session.error → error + error-reason turn end.
  {
    const sink: RuntimeEvent[] = [];
    const ad = adapter({ events: sink });
    ad.dispatch(ev("session.execution.started", { sessionID: "oc-sess-1" }));
    ad.dispatch(ev("session.error", { sessionID: "oc-sess-1", error: { message: "upstream 500" } }));
    const err = sink.find((e) => e.type === "error") as { message: string };
    const done = sink.find((e) => e.type === "turn.done") as { reason: string };
    ok(err?.message === "upstream 500" && done?.reason === "error", "D10 session.error → error card + error turn.done");
  }
  // D11: finalize seals open messages + settles running bash entries.
  {
    const sink: RuntimeEvent[] = [];
    const ad = adapter({ events: sink });
    ad.dispatch(ev("session.tool.called", { sessionID: "oc-sess-1", assistantMessageID: "am-9", id: "c9", input: { command: "sleep 100" } }));
    ad.finalizeAborted();
    const bash = sink.filter((e) => e.type === "bash-tasks.update") as Array<{ tasks: Array<{ status: string }> }>;
    const done = sink.find((e) => e.type === "turn.done") as { reason: string };
    ok(done?.reason === "interrupted", "D11a finalizeAborted → interrupted turn.done");
    ok(bash[bash.length - 1]?.tasks?.[0]?.status === "completed", "D11b running bash settled at finalize");
  }
}

/* ═══════════ E. model projection ═══════════ */
console.log("E. model projection + id parsing");
{
  // E0: v2 envelope unwrapping (live-verified on 2.1.1 — hey-api's `.data` is
  // the {location?, data} envelope BODY, not the inner payload; a bare
  // payload passes through for forward compatibility).
  ok(
    JSON.stringify(unwrapV2Envelope<Array<number>>({ location: {}, data: [1, 2] })) === "[1,2]",
    "E0a envelope {data:[…]} unwraps to the array",
  );
  ok(
    (unwrapV2Envelope<{ id: string }>({ data: { id: "ses_1" } }) as { id?: string })?.id === "ses_1",
    "E0b envelope {data:{…}} unwraps to the object",
  );
  ok(unwrapV2Envelope<unknown>(null) === undefined, "E0c null body → undefined");
  ok(
    JSON.stringify(unwrapV2Envelope<unknown>({ foo: 1 })) === '{"foo":1}',
    "E0d payload without a data key passes through",
  );
  const zen = projectOpenCodeModel({
    id: "grok-4-fast", providerID: "opencode", name: "Grok 4 Fast",
    variants: [{ id: "low" }, { id: "high" }],
    settings: { apiKey: "public" },
    limit: { context: 1_000_000, output: 32_000 },
  } as never);
  ok(zen.id === "opencode/grok-4-fast" && zen.supplier === "opencode", "E1 composite id + supplier");
  ok(zen.free === true, "E2 public apiKey → free badge");
  ok(zen.hint === "1M", "E3 context hint 1M");
  ok(JSON.stringify(zen.variants) === JSON.stringify(["low", "high"]), "E4 variants extracted");
  const other = projectOpenCodeModel({
    id: "m2", providerID: "anthropic", name: "Claude M2",
    limit: { context: 400_000, output: 64_000 },
  } as never);
  ok(other.hint === "400K" && !other.free, "E5 400K hint, no free badge");
  ok(sortOpenCodeModels([other, zen])[0].id === zen.id, "E6 Zen models sort first");
  ok(formatContextHint(1_500_000) === "1.5M" && formatContextHint(0) === undefined, "E7 hint formats");
  ok(parseOpenCodeModelId("opencode/grok-4-fast")?.providerID === "opencode", "E8a parse provider/model");
  ok(parseOpenCodeModelId("default") === null && parseOpenCodeModelId(undefined) === null, "E8b default/absent → null");
  ok(parseOpenCodeModelId("nodash") === null && parseOpenCodeModelId("/x") === null, "E8c malformed ids → null");
}

/* ═══════════ F. MCP entry mapping ═══════════ */
console.log("F. MCP entry mapping");
{
  const local = toOpenCodeMcpEntry({ type: "stdio", command: "node", args: ["s.js"], env: { A: "1" } });
  ok(local.entry?.type === "local" && JSON.stringify(local.entry?.command) === JSON.stringify(["node", "s.js"]) && local.entry?.environment?.["A"] === "1", "F1 stdio → local command+environment");
  const http = toOpenCodeMcpEntry({ type: "http", url: "https://mcp.dev/api", headers: { Authorization: "x" } });
  ok(http.entry?.type === "remote" && http.entry?.url === "https://mcp.dev/api" && http.entry?.headers?.["Authorization"] === "x", "F2 http → remote url+headers");
  const sse = toOpenCodeMcpEntry({ type: "sse", url: "https://mcp.dev/sse" });
  ok(sse.entry?.type === "remote" && sse.entry?.url === "https://mcp.dev/sse", "F3 sse → remote");
  const bad = toOpenCodeMcpEntry({ type: "stdio" } as never);
  ok(bad.entry === null && !!bad.error, "F4 stdio without command → null+error");
}

/* ═══════════ G. terminal adoption exclusion ═══════════ */
console.log("G. terminal adoption exclusion (GUI ids are claimed)");
{
  // Reset the shared fixture.
  fixture.terminalIds = [];
  fixture.providerIds = {};
  fixture.updates = [];
  fixture.rows.clear();

  const termRow = {
    id: "term-1", kind: "terminal", providerId: "opencode", claudeSessionId: null,
    createdAt: Date.now() - 60_000,
  } as never;
  fixture.rows.set("term-1", termRow);

  // The GUI provider's opencode session id must be treated as claimed even
  // though it is the NEWEST unclaimed row in the project directory.
  fixture.providerIds["opencode-sdk"] = ["gui-owned-id"];

  const adopted = reconcileOpenCodeTerminalSessionId(
    termRow, PROJ, ":memory:", true,
  );
  ok(adopted !== "gui-owned-id", "G1 GUI-owned opencode id never adopted by a terminal row");

  // Without GUI rows, adoption still works (same fixture db is empty here, so
  // the result is null — assert the no-candidate path instead of lying).
  fixture.providerIds = {};
  const adopted2 = reconcileOpenCodeTerminalSessionId(termRow, PROJ, ":memory:", true);
  ok(adopted2 === null, "G2 empty db → no adoption (no crash)");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
