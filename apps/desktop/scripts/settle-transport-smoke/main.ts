// Headless smoke for the persistent-transport turn semantics (2026-10-27 fix
// for "model starts a background service → session stuck in running forever"):
//
//  Old world: turn.done was emitted ONLY by flushFinal() when the SDK
//  generator closed, and the generator only closed when the CLI process
//  exited — but the CLI process IGNORES stdin EOF while it babysits live
//  background bash tasks (observed 2026-10-27: alive 9.5 min past EOF with a
//  dev server running). A dev server never exits ⇒ the session never ended,
//  and RuntimeManager.sendTurn rejected every new message with "session is
//  currently running". main.log showed turns whose result arrived but whose
//  "claude turn settled" anchor never did.
//
//  New world (covered here):
//  1. SERVICE case: result + running background bash task → the logical end
//     is deferred only by the bounded patience window (BASH_SETTLE_PATIENCE_MS;
//     forced expired via internals so the smoke stays fast), then turn.done
//     fires while the task is STILL running; the feed-close request must NOT
//     fire until the task settles (the CLI process must stay alive for it).
//  2. FAST case: result with nothing running → turn.done + feed close within
//     the settle grace.
//  3. SUBAGENT case: a running subagent still blocks the end indefinitely
//     (its task-notification resume streams turn content) — until its
//     completion edge, which then settles within the grace.
//  4. flushFinal honesty: after the logical end, a generator close must NOT
//     re-emit turn.done, but MUST run the kill-nets (running roster entries
//     die with the process — the CLI is exiting there).
//  5. Carryover: a follow-up adapter seeded from the previous one reconciles
//     lifecycle edges for the previous turn's still-running task (they would
//     otherwise be dropped as orphans).
//  6. flushFinal backstop: a generator close with NO result at all emits
//     turn.done("interrupted") and resolves the logical-end hook exactly once.
//
// The adapter runs for real (stubs: logger, serviceScanner's window hooks —
// both electron-adjacent and orthogonal here). White-box internals access
// follows the tool-media-smoke precedent (private fields are compile-time
// only under esbuild).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SdkMessageAdapter, type AdapterCarryover } from "@main/providers/claude-sdk/SdkMessageAdapter.js";
import { FileSnapshot } from "@main/lib/fileSnapshot.js";
import type { ProviderContext } from "@contracts/provider";
import type { RuntimeEvent, SubagentSnapshot, BashTaskSnapshot } from "@contracts/runtime";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Harness {
  adapter: SdkMessageAdapter;
  events: RuntimeEvent[];
  logicalEnds: string[];
  feedCloseCount(): number;
  internals: {
    maybeSettle(): void;
    state: {
      bashPatienceTimer: NodeJS.Timeout | null;
      bashPatienceExpired: boolean;
      settled: boolean;
      lastResultSubtype: string | null;
      lastResultAt: number;
      lastAgentActivityAt: number;
      turnDoneEmitted: boolean;
      bashTasks: Map<string, BashTaskSnapshot>;
      subagents: Map<string, SubagentSnapshot>;
    };
    exportCarryover(): AdapterCarryover;
  };
}

function makeHarness(project: string, carryover?: AdapterCarryover): Harness {
  const events: RuntimeEvent[] = [];
  const logicalEnds: string[] = [];
  let feedCloses = 0;
  const ctx = {
    emit: (e: RuntimeEvent) => {
      events.push(e);
    },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  } as unknown as ProviderContext;
  const adapter = new SdkMessageAdapter(
    ctx,
    "sess-smoke",
    false,
    project,
    new FileSnapshot("sess-smoke"),
    null,
    null,
    [],
    undefined,
    true,
    {
      carryover,
      hooks: {
        onLogicalEnd: (reason) => logicalEnds.push(reason),
        requestFeedClose: () => {
          feedCloses++;
        },
      },
    },
  );
  const internals = adapter as unknown as Harness["internals"];
  return {
    adapter,
    events,
    logicalEnds,
    feedCloseCount: () => feedCloses,
    internals,
  };
}

function taskStarted(taskId: string, opts?: { backgrounded?: boolean }) {
  return {
    type: "system",
    subtype: "task_started",
    task_id: taskId,
    task_type: "local_bash",
    tool_use_id: `toolu_${taskId}`,
    description: `cmd ${taskId}`,
    is_backgrounded: opts?.backgrounded ?? true,
  } as never;
}

function resultSuccess() {
  return {
    type: "result",
    subtype: "success",
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  } as never;
}

async function main(): Promise<void> {
  const project = await mkdtemp(join(tmpdir(), "mcode-settle-smoke-"));
  try {
    // ── 1. SERVICE case: a running background command must not pin the turn ──
    {
      const h = makeHarness(project);
      await h.adapter.dispatch(taskStarted("srv1", { backgrounded: true }));
      await h.adapter.dispatch({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [{ task_id: "srv1", task_type: "local_bash", description: "dev server" }],
      } as never);
      await h.adapter.dispatch(resultSuccess());
      await sleep(2_200); // settle grace (1.5s) + margin — patience still holding
      const doneEvents = h.events.filter((e) => e.type === "turn.done");
      check("service case: no turn.done while patience window holds", doneEvents.length === 0, doneEvents);
      check("service case: patience timer armed", h.internals.state.bashPatienceTimer !== null);
      // Force the window to expire (the real window is 60s — too slow for a
      // smoke) and re-run the settle check the way the timer would.
      h.internals.state.bashPatienceExpired = true;
      h.internals.maybeSettle();
      await sleep(2_200); // grace again
      const done2 = h.events.filter((e): e is Extract<RuntimeEvent, { type: "turn.done" }> => e.type === "turn.done");
      check("service case: turn.done fires after patience expiry", done2.length === 1, done2);
      check("service case: reason derives from the result", done2[0]?.reason === "end_turn", done2[0]);
      check("service case: logical-end hook fired once", h.logicalEnds.length === 1, h.logicalEnds);
      check(
        "service case: feed NOT closed while the command still runs",
        h.feedCloseCount() === 0,
        h.feedCloseCount(),
      );
      // The command settles → the process is idle → the feed may close.
      await h.adapter.dispatch({
        type: "system",
        subtype: "task_notification",
        task_id: "srv1",
        status: "completed",
      } as never);
      check("service case: feed closes once the command settles", h.feedCloseCount() >= 1, h.feedCloseCount());
    }

    // ── 2. FAST case: nothing running → end + feed close within the grace ──
    {
      const h = makeHarness(project);
      await h.adapter.dispatch(resultSuccess());
      await sleep(2_200);
      const done = h.events.filter((e): e is Extract<RuntimeEvent, { type: "turn.done" }> => e.type === "turn.done");
      check("fast case: turn.done within grace", done.length === 1, done);
      check("fast case: logical-end hook fired", h.logicalEnds.length === 1, h.logicalEnds);
      check("fast case: feed close requested (idle)", h.feedCloseCount() >= 1, h.feedCloseCount());
    }

    // ── 3. SUBAGENT case: a running subagent still blocks the turn ──
    {
      const h = makeHarness(project);
      await h.adapter.dispatch({
        type: "system",
        subtype: "task_started",
        task_id: "agent1",
        task_type: "local_agent",
        tool_use_id: "toolu_agent1",
        description: "researcher",
        is_backgrounded: true,
      } as never);
      await h.adapter.dispatch(resultSuccess());
      await sleep(2_200);
      check(
        "subagent case: running subagent blocks turn.done",
        h.events.filter((e) => e.type === "turn.done").length === 0,
      );
      await h.adapter.dispatch({
        type: "system",
        subtype: "task_updated",
        task_id: "agent1",
        patch: { status: "completed" },
      } as never);
      // The completion edge stamps an agent-activity point; the settle rule
      // (deliberately, see the 2026-08-26 plan-mode incident) requires the
      // result to POSTDATE it — in production the CLI's task-notification
      // resume always produces that second result.
      await h.adapter.dispatch(resultSuccess());
      await sleep(2_200);
      const done = h.events.filter((e): e is Extract<RuntimeEvent, { type: "turn.done" }> => e.type === "turn.done");
      check("subagent case: completion edge settles the turn", done.length === 1, done);
      check("subagent case: feed close requested after settle", h.feedCloseCount() >= 1, h.feedCloseCount());
    }

    // ── 4. flushFinal honesty: late generator close kills running rosters,
    //      never double-emits turn.done ──
    {
      const h = makeHarness(project);
      await h.adapter.dispatch(taskStarted("srv2", { backgrounded: true }));
      await h.adapter.dispatch(resultSuccess());
      h.internals.state.bashPatienceExpired = true;
      h.internals.maybeSettle();
      await sleep(2_200);
      check(
        "honesty case: turn.done emitted before flushFinal",
        h.events.filter((e) => e.type === "turn.done").length === 1,
      );
      await h.adapter.flushFinal();
      const done = h.events.filter((e) => e.type === "turn.done");
      check("honesty case: flushFinal does not double-emit turn.done", done.length === 1, done);
      check("honesty case: logical-end hook not re-fired", h.logicalEnds.length === 1, h.logicalEnds);
      const task = h.internals.state.bashTasks.get("srv2");
      check("honesty case: running command killed at process exit", task?.status === "killed", task);
      // The generator-close flush runs the exit-path nets regardless of the
      // roster state; after the kill-net empties the roster, a feed-close
      // request MAY follow (harmless — the provider's close is guarded and
      // the feed/process is already going away). What must NOT happen is a
      // second turn.done or a second logical-end fire (asserted above).
      check("honesty case: feed-close requests stay bounded", h.feedCloseCount() <= 1, h.feedCloseCount());
    }

    // ── 5. Carryover: follow-up adapter reconciles the previous turn's task ──
    {
      const h1 = makeHarness(project);
      await h1.adapter.dispatch(taskStarted("srv3", { backgrounded: true }));
      const seed = h1.internals.exportCarryover();
      check("carryover: running task exported", seed.bashTasks.some((t) => t.taskId === "srv3"), seed);
      const h2 = makeHarness(project, seed);
      check("carryover: seeded roster visible", h2.internals.state.bashTasks.get("srv3")?.status === "running");
      await h2.adapter.dispatch({
        type: "system",
        subtype: "task_updated",
        task_id: "srv3",
        patch: { status: "completed" },
      } as never);
      check(
        "carryover: lifecycle edge reconciles on the follow-up adapter",
        h2.internals.state.bashTasks.get("srv3")?.status === "completed",
        h2.internals.state.bashTasks.get("srv3"),
      );
      const updates = h2.events.filter((e): e is Extract<RuntimeEvent, { type: "bash-tasks.update" }> => e.type === "bash-tasks.update");
      check("carryover: roster flushed to the renderer", updates.length >= 1, updates.length);
    }

    // ── 6. flushFinal backstop: crash with no result → interrupted + hook ──
    {
      const h = makeHarness(project);
      await h.adapter.flushFinal();
      const done = h.events.filter((e): e is Extract<RuntimeEvent, { type: "turn.done" }> => e.type === "turn.done");
      check("backstop: no-result close emits turn.done", done.length === 1, done);
      check("backstop: reason interrupted", done[0]?.reason === "interrupted", done[0]);
      check("backstop: logical-end hook fired", h.logicalEnds.length === 1, h.logicalEnds);
    }

    // ── 7. The full persisted-report flow: task settles INSIDE the patience
    //       window → its completion edge (not the expiry) settles the turn ──
    {
      const h = makeHarness(project);
      await h.adapter.dispatch(taskStarted("bld1", { backgrounded: true }));
      await h.adapter.dispatch(resultSuccess());
      await sleep(300);
      check(
        "in-window case: still holding shortly after result",
        h.events.filter((e) => e.type === "turn.done").length === 0,
      );
      await h.adapter.dispatch({
        type: "system",
        subtype: "task_notification",
        task_id: "bld1",
        status: "completed",
      } as never);
      await sleep(2_200);
      const done = h.events.filter((e): e is Extract<RuntimeEvent, { type: "turn.done" }> => e.type === "turn.done");
      check("in-window case: completion inside the window settles early", done.length === 1, done);
      check("in-window case: feed closes (idle)", h.feedCloseCount() >= 1, h.feedCloseCount());
    }
  } finally {
    await rm(project, { recursive: true, force: true });
  }

  console.log(`\nsettle-transport smoke: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

void main();
