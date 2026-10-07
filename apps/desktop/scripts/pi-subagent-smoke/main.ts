/**
 * Headless smoke for the Pi subagent coordinator — see run.sh. Covered
 * scenarios:
 *
 *   S1  concurrency cap holds (maxConcurrent observed ≤ cap)
 *   S2  roster: first update all running, final update all completed (REPLACE)
 *   S3  transcript per child: text + tool_use blocks, tool flips running→done
 *   S4  batch keying: N tasks under one tool call get distinct toolUseIds
 *   S5  abort cascade: turn abort → running children killed, run() resolves
 *   S6  timeout: hung child aborted and failed with the timeout reason
 *   S7  spawn throw: failed snapshot, run() isError when every child failed
 *   S8  maxTasks cap: 10 requested → 8 children scheduled
 */
import type { ProviderContext } from "@contracts/provider";
import type { RuntimeEvent } from "@contracts/runtime";
import {
  SubagentCoordinator,
  SUBAGENT_MAX_TASKS,
  type SpawnChild,
  type SubagentTaskSpec,
} from "../../src/main/providers/pi-sdk/piSubagentRunner.js";

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, extra = "") => {
  if (cond) {
    pass++;
    console.log(`  ok  ${name}${extra ? " — " + extra : ""}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${extra ? " — " + extra : ""}`);
  }
};

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Collect emitted events; ProviderContext is otherwise unused. */
function makeCtx(events: RuntimeEvent[]): ProviderContext {
  return {
    emit: (e: RuntimeEvent) => events.push(e),
    log: { info() {}, warn() {}, error() {} },
  } as unknown as ProviderContext;
}

const isUpdate = (e: RuntimeEvent): e is Extract<RuntimeEvent, { type: "subagent.update" }> =>
  e.type === "subagent.update";
const isTranscript = (e: RuntimeEvent): e is Extract<RuntimeEvent, { type: "subagent.transcript" }> =>
  e.type === "subagent.transcript";

// ── S1–S4: happy batch with concurrency cap ─────────────────────────────
{
  const events: RuntimeEvent[] = [];
  let active = 0;
  let maxActive = 0;
  const spawn: SpawnChild = async (spec, cb) => {
    active++;
    maxActive = Math.max(maxActive, active);
    cb.onToolStart("tool-1", "read", { path: "a.ts" });
    cb.onText(`${spec.description} thinking out`);
    await delay(25);
    cb.onToolEnd("tool-1", "file body", false);
    cb.onText(`${spec.description} final answer`);
    active--;
    return { status: "completed", finalText: `${spec.description} final answer`, totalTokens: 42 };
  };
  const ac = new AbortController();
  const coord = new SubagentCoordinator({
    ctx: makeCtx(events),
    sessionId: "sess-1",
    spawnChild: spawn,
    abortSignal: ac.signal,
    maxConcurrent: 2,
    timeoutMs: 5000,
  });
  const specs: SubagentTaskSpec[] = [1, 2, 3, 4, 5, 6].map((i) => ({
    description: `task ${i}`,
    prompt: `do ${i}`,
  }));
  const result = await coord.run("call-1", specs);

  ok("S1 concurrency cap holds", maxActive <= 2, `maxActive=${maxActive}`);
  const updates = events.filter(isUpdate);
  ok("S2a first roster announces all 6 running",
    updates.length > 0 && updates[0].agents.length === 6 && updates[0].agents.every((a) => a.status === "running"));
  const last = updates[updates.length - 1];
  ok("S2b final roster all completed with usage",
    last.agents.every((a) => a.status === "completed" && a.totalTokens === 42 && a.toolUses === 1));
  ok("S2c batch children get distinct toolUseIds",
    new Set(last.agents.map((a) => a.toolUseId)).size === 6 &&
    last.agents.every((a) => a.taskId === a.toolUseId));
  ok("S2d lastToolName tracked", last.agents.every((a) => a.lastToolName === "read"));

  const transcripts = events.filter(isTranscript);
  const byChild = new Map(transcripts.map((t) => [t.parentToolUseId, t.blocks]));
  ok("S3a transcript emitted per child", byChild.size === 6);
  const blocks = byChild.get(last.agents[0].toolUseId) ?? [];
  const textBlocks = blocks.filter((b) => b.kind === "text");
  const toolBlocks = blocks.filter((b) => b.kind === "tool_use");
  ok("S3b text coalesced to trailing block per message",
    textBlocks.length === 1 && (textBlocks[0].kind === "text" ? textBlocks[0].text : "").includes("final answer"));
  ok("S3c tool_use block flips to done with result",
    toolBlocks.length === 1 && toolBlocks[0].kind === "tool_use" && toolBlocks[0].status === "done" &&
    toolBlocks[0].result === "file body");
  ok("S4 aggregate result text carries every child", result.text.split("## ").length === 7 && !result.isError);
}

// ── S5: abort cascade ────────────────────────────────────────────────────
{
  const events: RuntimeEvent[] = [];
  const ac = new AbortController();
  const spawn: SpawnChild = async (_spec, _cb, signal) => {
    await new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    return signal.aborted
      ? { status: "killed", finalText: "", totalTokens: 0, error: "subagent aborted" }
      : { status: "completed", finalText: "x", totalTokens: 0 };
  };
  const coord = new SubagentCoordinator({
    ctx: makeCtx(events),
    sessionId: "sess-2",
    spawnChild: spawn,
    abortSignal: ac.signal,
  });
  const runPromise = coord.run("call-2", [{ description: "long", prompt: "hang" }]);
  await delay(30);
  ac.abort(new Error("turn aborted"));
  const result = await runPromise;
  const last = events.filter(isUpdate).at(-1);
  ok("S5 turn abort kills running child", last?.agents[0].status === "killed" && result.isError);
}

// ── S6: timeout ──────────────────────────────────────────────────────────
{
  const events: RuntimeEvent[] = [];
  const spawn: SpawnChild = async (_spec, _cb, signal) => {
    await new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    return signal.aborted
      ? { status: "failed", finalText: "", totalTokens: 0, error: "subagent timed out" }
      : { status: "completed", finalText: "x", totalTokens: 0 };
  };
  const coord = new SubagentCoordinator({
    ctx: makeCtx(events),
    sessionId: "sess-3",
    spawnChild: spawn,
    abortSignal: new AbortController().signal,
    timeoutMs: 120,
  });
  const result = await coord.run("call-3", [{ description: "hang", prompt: "hang" }]);
  const last = events.filter(isUpdate).at(-1);
  ok("S6 hung child aborted at timeout and failed",
    last?.agents[0].status === "failed" && result.isError && result.text.includes("timed out"));
}

// ── S7: spawn throw isolates to failed ───────────────────────────────────
{
  const events: RuntimeEvent[] = [];
  const spawn: SpawnChild = async () => {
    throw new Error("no model runtime");
  };
  const coord = new SubagentCoordinator({
    ctx: makeCtx(events),
    sessionId: "sess-4",
    spawnChild: spawn,
    abortSignal: new AbortController().signal,
  });
  const result = await coord.run("call-4", [{ description: "doomed", prompt: "p" }]);
  const last = events.filter(isUpdate).at(-1);
  ok("S7 spawn throw → failed snapshot, isError aggregate",
    last?.agents[0].status === "failed" && result.isError && result.text.includes("no model runtime"));
}

// ── S8: maxTasks cap ─────────────────────────────────────────────────────
{
  const events: RuntimeEvent[] = [];
  const spawn: SpawnChild = async (spec) => ({
    status: "completed",
    finalText: spec.description,
    totalTokens: 1,
  });
  const coord = new SubagentCoordinator({
    ctx: makeCtx(events),
    sessionId: "sess-5",
    spawnChild: spawn,
    abortSignal: new AbortController().signal,
  });
  const specs: SubagentTaskSpec[] = Array.from({ length: 10 }, (_, i) => ({
    description: `t${i}`,
    prompt: `p${i}`,
  }));
  await coord.run("call-5", specs);
  const last = events.filter(isUpdate).at(-1);
  ok("S8 task count capped to SUBAGENT_MAX_TASKS",
    last?.agents.length === SUBAGENT_MAX_TASKS);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
