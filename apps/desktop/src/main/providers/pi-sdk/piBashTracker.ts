/**
 * Live bash-task tracking for the Pi provider — Pi's answer to the CLI's
 * local_bash task ledger.
 *
 * Pi's bash tool is fully pluggable (`BashToolOptions.operations`): the
 * session's default local execution is `createLocalBashOperations`, whose
 * `exec` already receives streaming chunks (`onData`) and an AbortSignal. This
 * tracker wraps those operations to mirror every bash command into the SAME
 * `bash-tasks.update` channel the Claude adapter uses — the entire「运行命令」
 * panel (roster, live output expander, per-task stop button) works for Pi
 * sessions with zero renderer changes. Two capabilities fall out of the same
 * wrapper:
 *
 *   1. **Live output** — chunks land on the snapshot's `output` field as they
 *      arrive (rolling tail, ANSI-stripped, throttled flushes), unlike the
 *      Claude side where output is only visible after the CLI's terminal
 *      `task_notification`.
 *   2. **Per-command stop** — each exec gets its own AbortController; the
 *      TurnHandle's `stopTask` aborts one command without interrupting the
 *      turn. The agent loop continues with the aborted command's error
 *      result, same semantics as Claude's `stop_task`.
 *
 * Scope note: subagent child sessions (piSubagentRunner) build their own
 * sessions without this override — their bash runs untracked, visible only
 * through the subagent transcript. Turn-level interrupt still kills them
 * (session.abort() cascades).
 */
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import type { BashTaskSnapshot, BashTasksEvent, RuntimeEvent } from "@contracts/runtime";
import { TASK_OUTPUT_CAP_BYTES, stripAnsiEscapes } from "@main/lib/taskOutputFile.js";

/** How long a quiet period must last before a chunk-driven flush fires —
 *  bounds IPC traffic for chatty commands while keeping the live view fresh
 *  enough to read. Lifecycle edges (start/settle) always flush immediately. */
const FLUSH_QUIET_MS = 400;

/** Rolling tail cap for the live `output` field — same cap the CLI spool
 *  reader applies, so the panel's expander behaves identically on both
 *  providers. */
const LIVE_TAIL_CAP = TASK_OUTPUT_CAP_BYTES;

interface ExecState {
  snapshot: BashTaskSnapshot;
  controller: AbortController;
  /** Raw output chunks, head-trimmed to ~LIVE_TAIL_CAP. Buffers are joined
   *  and decoded at flush time — per-chunk utf8 decoding would corrupt
   *  multibyte characters at chunk seams. */
  chunks: Buffer[];
  /** Bytes currently held in `chunks` (mirrors push/shift so trim decisions
   *  measure the REAL buffer — `totalBytes` is ever-seen and over-counts
   *  after the first trim, which would over-trim on every later chunk). */
  bufferedBytes: number;
  /** Total bytes the command ever printed — drives `outputTruncated` (the
   *  tail is a window over this, not the whole story). */
  totalBytes: number;
  /** Set when chunks arrived since the last snapshot refresh — flushNow
   *  rebuilds the live `output` field for these entries. */
  dirty: boolean;
}

export interface PiBashTracker {
  /** Wrap pi's local bash operations with tracking (pass the result as
   *  `BashToolOptions.operations`). */
  wrapOperations(base: BashOperations): BashOperations;
  /** Abort ONE running command (TurnHandle.stopTask). Returns false for an
   *  unknown/settled task id. */
  stopTask(taskId: string): boolean;
  /** End-of-turn sweep: settle anything still running (a session disposed
   *  mid-exec never runs the wrapper's settle path) and flush once. */
  dispose(): void;
}

export function createPiBashTracker(sessionId: string, emit: (e: RuntimeEvent) => void): PiBashTracker {
  const execs = new Map<string, ExecState>();
  let seq = 0;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const roster = (): BashTaskSnapshot[] => Array.from(execs.values()).map((s) => s.snapshot);

  const flushNow = (): void => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    // Running entries with new chunks get their live output rebuilt here —
    // the chunk path deliberately doesn't (concat per chunk would be
    // quadratic under a chatty command; flushes are already throttled).
    for (const st of execs.values()) {
      if (st.dirty && st.snapshot.status === "running") refreshOutput(st);
    }
    emit({ type: "bash-tasks.update", sessionId, tasks: roster() } satisfies BashTasksEvent);
  };

  const scheduleFlush = (): void => {
    if (flushTimer !== null) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushNow();
    }, FLUSH_QUIET_MS);
  };

  /** Rebuild the snapshot's live output from the rolling chunk buffer. */
  const refreshOutput = (st: ExecState): void => {
    st.dirty = false;
    const buf = Buffer.concat(st.chunks);
    const text = stripAnsiEscapes(buf.toString("utf8")).replace(/\r\n/g, "\n").trimEnd();
    st.snapshot = {
      ...st.snapshot,
      output: text || undefined,
      outputTruncated: st.totalBytes > buf.length ? true : undefined,
    };
  };

  /** Head-trim the chunk list back under the cap, dropping from the front in
   *  whole chunks (display-only data — a partially-dropped chunk boundary is
   *  fine, the flush-time decode tolerates it). */
  const trimChunks = (st: ExecState): void => {
    let kept = st.bufferedBytes;
    while (kept > LIVE_TAIL_CAP && st.chunks.length > 1) {
      kept -= st.chunks[0].length;
      st.chunks.shift();
    }
    st.bufferedBytes = kept;
  };

  const settle = (
    st: ExecState,
    status: BashTaskSnapshot["status"],
    error?: string,
  ): void => {
    if (st.snapshot.status !== "running") return;
    refreshOutput(st);
    st.snapshot = {
      ...st.snapshot,
      status,
      endedAt: Date.now(),
      error,
    };
    execs.set(st.snapshot.taskId, st);
    flushNow();
  };

  return {
    wrapOperations(base: BashOperations): BashOperations {
      return {
        exec: (command, cwd, options) => {
          const taskId = `pi-bash-${++seq}`;
          const controller = new AbortController();
          const st: ExecState = {
            snapshot: {
              taskId,
              description: command,
              status: "running",
              startedAt: Date.now(),
            },
            controller,
            chunks: [],
            bufferedBytes: 0,
            totalBytes: 0,
            dirty: false,
          };
          execs.set(taskId, st);
          flushNow();

          // Pi's cancellation (turn interrupt / session abort) must cascade
          // into the exec's own controller so the stop bookkeeping sees it.
          const outer = options.signal;
          const onOuterAbort = () => controller.abort();
          if (outer?.aborted) controller.abort();
          outer?.addEventListener("abort", onOuterAbort, { once: true });

          const onData = (data: Buffer): void => {
            options.onData(data);
            st.chunks.push(data);
            st.bufferedBytes += data.length;
            st.totalBytes += data.length;
            st.dirty = true;
            trimChunks(st);
            scheduleFlush();
          };

          return base
            .exec(command, cwd, { ...options, signal: controller.signal, onData })
            .then((res) => {
              // pi's contract: signal terminations report as 128+signal, a
              // plain kill resolves with a null exit code.
              if (controller.signal.aborted) settle(st, "killed");
              else if (res.exitCode == null) settle(st, "killed");
              else if (res.exitCode === 0) settle(st, "completed");
              else settle(st, "failed", `exit ${res.exitCode}`);
              return res;
            })
            .catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              if (msg === "aborted" || controller.signal.aborted) settle(st, "killed");
              else settle(st, "failed", msg);
              throw err;
            })
            .finally(() => {
              outer?.removeEventListener("abort", onOuterAbort);
            });
        },
      };
    },

    stopTask(taskId: string): boolean {
      const st = execs.get(taskId);
      if (!st || st.snapshot.status !== "running") return false;
      st.controller.abort();
      return true;
    },

    dispose(): void {
      for (const st of execs.values()) {
        // Anything still running at turn end was torn down with the session —
        // the session-scoped exec would never report back.
        if (st.snapshot.status === "running") {
          settle(st, "killed");
        }
      }
      flushNow();
    },
  };
}
