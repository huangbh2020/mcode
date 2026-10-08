/**
 * Headless smoke for providers/pi-sdk/piBashTracker.ts — the wrapper that
 * mirrors Pi bash executions into the bash-tasks roster with live output and
 * per-command stop. Uses a fake BashOperations (the real one only matters
 * inside a pi session); the tracker's only SDK dependency is a type-only
 * import, so no stubs are needed.
 */
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import type { BashTaskSnapshot, BashTasksEvent, RuntimeEvent } from "@contracts/runtime";
import { TASK_OUTPUT_CAP_BYTES } from "@main/lib/taskOutputFile.js";
import { createPiBashTracker } from "@main/providers/pi-sdk/piBashTracker.js";

let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed += 1;
  } else {
    console.log(`ok: ${msg}`);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A deferred fake exec — the test drives resolution/abort and feeds chunks
 *  through the captured onData/signal. */
function makeDeferredExec() {
  let captured: { onData: (b: Buffer) => void; signal?: AbortSignal } | null = null;
  let settleExec!: (r: { exitCode: number | null }) => void;
  let failExec!: (e: Error) => void;
  const promise = new Promise<{ exitCode: number | null }>((res, rej) => {
    settleExec = res;
    failExec = rej;
  });
  const base: BashOperations = {
    exec: (_command, _cwd, options) => {
      captured = options;
      return promise;
    },
  };
  return {
    base,
    captured: () => {
      if (!captured) throw new Error("exec not started");
      return captured;
    },
    settleExec,
    failExec,
  };
}

function lastRoster(events: RuntimeEvent[]): BashTaskSnapshot[] {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "bash-tasks.update") return e.tasks;
  }
  return [];
}

async function main(): Promise<void> {
  // ── T1: lifecycle + live output + model-side onData passthrough ──
  {
    const events: RuntimeEvent[] = [];
    const tracker = createPiBashTracker("s1", (e) => events.push(e));
    const fake = makeDeferredExec();
    const ops = tracker.wrapOperations(fake.base);
    const modelChunks: Buffer[] = [];
    const outer = new AbortController();
    const execP = ops.exec("echo hi", "/tmp", { onData: (b) => modelChunks.push(b), signal: outer.signal });

    let roster = lastRoster(events);
    assert(roster.length === 1, "exec start flushes a 1-entry roster");
    assert(
      roster[0].status === "running" && roster[0].description === "echo hi" && roster[0].taskId === "pi-bash-1",
      "running snapshot carries command + taskId",
    );

    fake.captured().onData(Buffer.from("\x1b[32mhello\x1b[0m\r\n"));
    fake.captured().onData(Buffer.from("world"));
    assert(modelChunks.length === 2, "chunks forwarded to the model-side onData unchanged");
    await sleep(600); // flush quiet period (FLUSH_QUIET_MS = 400)
    roster = lastRoster(events);
    assert(roster[0].output === "hello\nworld", `live output ANSI-stripped + CRLF-normalized (got ${JSON.stringify(roster[0].output)})`);
    assert(roster[0].outputTruncated !== true, "short output not marked truncated");

    fake.settleExec({ exitCode: 0 });
    await execP;
    roster = lastRoster(events);
    assert(roster[0].status === "completed" && typeof roster[0].endedAt === "number", "exit 0 settles completed");
    tracker.dispose();
  }

  // ── T2: multibyte chunk seams survive (decode happens at flush) ──
  {
    const events: RuntimeEvent[] = [];
    const tracker = createPiBashTracker("s2", (e) => events.push(e));
    const fake = makeDeferredExec();
    const ops = tracker.wrapOperations(fake.base);
    const execP = ops.exec("cat zh.txt", "/tmp", { onData: () => {} });
    const full = Buffer.from("进度：50%", "utf8");
    fake.captured().onData(full.subarray(0, 3));
    fake.captured().onData(full.subarray(3));
    fake.settleExec({ exitCode: 0 });
    await execP;
    const snapshot = lastRoster(events)[0];
    assert(snapshot.output === "进度：50%", `multibyte chunk seam intact (got ${JSON.stringify(snapshot.output)})`);
    tracker.dispose();
  }

  // ── T3: per-command stop ──
  {
    const events: RuntimeEvent[] = [];
    const tracker = createPiBashTracker("s3", (e) => events.push(e));
    const fake = makeDeferredExec();
    const ops = tracker.wrapOperations(fake.base);
    const execP = ops.exec("dev-server", "/tmp", { onData: () => {} });
    execP.catch(() => {}); // the rethrow below is expected; don't trip unhandled-rejection
    assert(tracker.stopTask("pi-bash-1") === true, "stopTask returns true for a running task");
    assert(fake.captured().signal?.aborted === true, "stopTask aborts the exec's signal");
    fake.settleExec({ exitCode: null }); // aborted exec resolves null per pi's contract
    await execP.then(
      () => {},
      () => {},
    );
    assert(lastRoster(events)[0].status === "killed", "aborted exec settles killed");
    assert(tracker.stopTask("pi-bash-1") === false, "stopTask false for a settled task");
    assert(tracker.stopTask("nope") === false, "stopTask false for an unknown task");
    tracker.dispose();
  }

  // ── T4: outer (turn-interrupt) signal cascades into the exec ──
  {
    const events: RuntimeEvent[] = [];
    const tracker = createPiBashTracker("s4", (e) => events.push(e));
    const fake = makeDeferredExec();
    const ops = tracker.wrapOperations(fake.base);
    const outer = new AbortController();
    const execP = ops.exec("sleep 100", "/tmp", { onData: () => {}, signal: outer.signal });
    execP.catch(() => {});
    outer.abort();
    assert(fake.captured().signal?.aborted === true, "outer abort cascades into the exec controller");
    fake.settleExec({ exitCode: null });
    await execP.then(
      () => {},
      () => {},
    );
    assert(lastRoster(events)[0].status === "killed", "outer-aborted exec settles killed");
    tracker.dispose();
  }

  // ── T5: failure paths ──
  {
    const events: RuntimeEvent[] = [];
    const tracker = createPiBashTracker("s5", (e) => events.push(e));

    const f1 = makeDeferredExec();
    const p1 = tracker.wrapOperations(f1.base).exec("bad-cmd", "/tmp", { onData: () => {} });
    f1.settleExec({ exitCode: 1 });
    await p1;
    let snap = lastRoster(events)[0];
    assert(snap.status === "failed" && snap.error === "exit 1", "non-zero exit settles failed with exit code");

    const f2 = makeDeferredExec();
    const p2 = tracker.wrapOperations(f2.base).exec("slow", "/tmp", { onData: () => {} });
    f2.failExec(new Error("timeout:30"));
    await p2.then(
      () => assert(false, "timeout rejection should propagate"),
      () => {},
    );
    snap = lastRoster(events)[1];
    assert(snap.status === "failed" && snap.error === "timeout:30", "timeout rejection settles failed and rethrows");

    const f3 = makeDeferredExec();
    const p3 = tracker.wrapOperations(f3.base).exec("abort-me", "/tmp", { onData: () => {} });
    f3.failExec(new Error("aborted"));
    await p3.then(
      () => assert(false, "'aborted' rejection should propagate"),
      () => {},
    );
    snap = lastRoster(events)[2];
    assert(snap.status === "killed", "'aborted' rejection settles killed");
    tracker.dispose();
  }

  // ── T6: live tail cap ──
  {
    const events: RuntimeEvent[] = [];
    const tracker = createPiBashTracker("s6", (e) => events.push(e));
    const fake = makeDeferredExec();
    const ops = tracker.wrapOperations(fake.base);
    const execP = ops.exec("dev-server", "/tmp", { onData: () => {} });
    const chunk = Buffer.from("y".repeat(1024) + "\n");
    for (let i = 0; i < Math.ceil((TASK_OUTPUT_CAP_BYTES + 8192) / chunk.length); i++) {
      fake.captured().onData(chunk);
    }
    fake.settleExec({ exitCode: 0 });
    await execP;
    const snap = lastRoster(events)[0];
    // Tight bounds: the tail must stay CLOSE to the cap. A loose upper bound
    // alone once hid an over-trim bug (the trim measured the ever-seen byte
    // counter instead of the buffered bytes, silently shrinking the tail to
    // 43% of the cap).
    assert(
      snap.output !== undefined &&
        snap.output.length <= TASK_OUTPUT_CAP_BYTES + 2048 &&
        snap.output.length >= TASK_OUTPUT_CAP_BYTES - 2048,
      `live output capped near the cap (got ${snap.output?.length})`,
    );
    assert(snap.outputTruncated === true, "capped live output marked truncated");
    tracker.dispose();
  }

  // ── T7: dispose settles orphans ──
  {
    const events: RuntimeEvent[] = [];
    const tracker = createPiBashTracker("s7", (e) => events.push(e));
    const fake = makeDeferredExec();
    const ops = tracker.wrapOperations(fake.base);
    void ops.exec("orphan", "/tmp", { onData: () => {} }); // never settles
    tracker.dispose();
    const snap = lastRoster(events).at(-1);
    assert(snap?.status === "killed", "dispose settles a still-running exec as killed");
  }

  if (failed > 0) {
    console.error(`${failed} assertion(s) failed`);
    process.exit(1);
  }
  console.log("pi-bash-tracker smoke: all assertions passed");
}

void main();
