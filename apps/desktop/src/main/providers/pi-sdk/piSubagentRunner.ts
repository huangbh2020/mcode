/**
 * Pi subagent coordinator — runs in-process child agent sessions behind the
 * mcode extension's `task` tool and maps their progress onto the
 * provider-neutral `subagent.update` / `subagent.transcript` events, so the
 * renderer's existing capsule + transcript UI works for Pi exactly as for
 * Claude's Task tool.
 *
 * ## Split of responsibilities
 *
 * This module owns ONLY coordination + event mapping: roster state (REPLACE
 * snapshots), per-child transcript accumulation, a concurrency-bounded queue,
 * timeout and abort cascades. The actual child-session mechanics live behind
 * the injected {@link SpawnChild} callback — production wiring (a real child
 * `createAgentSession` with its own mcode extension instance) lives in
 * mcodeExtension.ts; the smoke injects a stub, so no model is needed to test
 * the full scheduling/event surface.
 *
 * ## Event semantics (must match the Claude adapter's shapes)
 *
 *   - `subagent.update`: the FULL roster on every change (REPLACE — the
 *     renderer renders the array verbatim). RuntimeManager captures these
 *     provider-neutrally for cross-turn replay, so the capsule survives
 *     turn boundaries with zero extra work here.
 *   - `subagent.transcript`: keyed by the child's snapshot `toolUseId` (the
 *     renderer looks transcripts up by `agent.toolUseId`, NOT by a chat-stream
 *     block id) — for a parallel batch each child gets a distinct
 *     `<toolCallId>#<n>` key. Message-level granularity: text/thinking blocks
 *     are folded in when the child finalizes a message, tool_use blocks flip
 *     running→done/error on the child's tool results.
 *
 * ## Known gaps (documented in docs/pi-sdk-integration.md)
 *
 *   - Child tokens are NOT folded into the parent turn's usage snapshot
 *     (ContextRing undercounts by the subagent share).
 *   - No `isBackgrounded` — Pi children always block the parent turn.
 */
import type { ProviderContext } from "@contracts/provider";
import type {
  SubagentSnapshot,
  SubagentTranscriptBlock,
} from "@contracts/runtime";

/** One task the model asked to delegate. */
export interface SubagentTaskSpec {
  description: string;
  prompt: string;
}

/** Semantic child-progress callbacks. The pi-event → semantic mapping lives
 *  in the injected spawnChild (it knows the SDK shapes); this keeps the
 *  coordinator free of SDK imports. */
export interface ChildProgressCallbacks {
  /** Finalized assistant text (called per assistant message, last wins). */
  onText(text: string): void;
  /** Finalized assistant thinking (same granularity as onText). */
  onThinking(text: string): void;
  onToolStart(toolCallId: string, toolName: string, input: unknown): void;
  onToolEnd(toolCallId: string, result: unknown, isError: boolean): void;
}

export interface ChildOutcome {
  status: "completed" | "failed" | "killed";
  finalText: string;
  totalTokens: number;
  error?: string;
}

/** Spawns one child run. Resolves with the outcome; throwing maps to a
 *  failed snapshot (the coordinator never lets one child break the batch). */
export type SpawnChild = (
  spec: SubagentTaskSpec,
  callbacks: ChildProgressCallbacks,
  signal: AbortSignal,
) => Promise<ChildOutcome>;

export interface SubagentCoordinatorOptions {
  ctx: ProviderContext;
  /** The PARENT GUI session id — all events carry it. */
  sessionId: string;
  spawnChild: SpawnChild;
  /** The turn's abort signal — aborting it kills every running child. */
  abortSignal: AbortSignal;
  maxTasks?: number;
  maxConcurrent?: number;
  /** Per-child wall-clock cap; a timed-out child is aborted and failed. */
  timeoutMs?: number;
}

export const SUBAGENT_MAX_TASKS = 8;
export const SUBAGENT_MAX_CONCURRENT = 4;
export const SUBAGENT_TIMEOUT_MS = 10 * 60_000;

interface ChildState {
  snapshot: SubagentSnapshot;
  blocks: SubagentTranscriptBlock[];
  controller: AbortController;
  /** Callbacks bound to this child's transcript/roster state. */
  callbacks: ChildProgressCallbacks;
}

export class SubagentCoordinator {
  private readonly children = new Map<string, ChildState>();
  private readonly queue: Array<{ childId: string; spec: SubagentTaskSpec }> = [];
  private active = 0;
  private abortedAll = false;

  constructor(private readonly opts: SubagentCoordinatorOptions) {
    // Cascade the turn's abort into every running/queued child.
    this.opts.abortSignal.addEventListener(
      "abort",
      () => this.abortAll("turn aborted"),
      { once: true },
    );
  }

  /** Run a batch of tasks (single task = one-element batch) to completion.
   *  Returns the aggregated tool-result text and whether EVERY child failed
   *  (partial success still counts as a usable result for the model). */
  async run(
    toolUseId: string,
    specs: SubagentTaskSpec[],
  ): Promise<{ text: string; isError: boolean }> {
    const maxTasks = this.opts.maxTasks ?? SUBAGENT_MAX_TASKS;
    const clipped = specs.slice(0, maxTasks);
    if (specs.length > maxTasks) {
      this.opts.ctx.log.warn(
        `pi subagent: ${specs.length} tasks requested, capped to ${maxTasks}`,
      );
    }

    const childIds = clipped.map((_, i) =>
      clipped.length === 1 ? toolUseId : `${toolUseId}#${i}`,
    );
    // Register + announce ALL children before any starts, so the capsule
    // shows the full batch while it schedules.
    clipped.forEach((spec, i) => {
      const childId = childIds[i];
      const controller = new AbortController();
      const state: ChildState = {
        snapshot: {
          taskId: childId,
          toolUseId: childId,
          description: spec.description || spec.prompt.slice(0, 80),
          subagentType: "general-purpose",
          status: "running",
        },
        blocks: [],
        controller,
        callbacks: this.makeCallbacks(childId),
      };
      this.children.set(childId, state);
      this.queue.push({ childId, spec });
    });
    this.emitRoster();

    // If the turn was already aborted between registration and scheduling,
    // mark everything killed instead of spinning up doomed sessions.
    if (this.opts.abortSignal.aborted) {
      this.abortAll(this.opts.abortSignal.reason ?? "turn aborted");
      return this.resultText(childIds);
    }

    await this.drain();
    return this.resultText(childIds);
  }

  /** Abort every running child and drop the queue. Safe to call twice. */
  abortAll(reason: string): void {
    if (this.abortedAll) return;
    this.abortedAll = true;
    this.queue.length = 0;
    for (const [childId, state] of this.children) {
      if (state.snapshot.status !== "running") continue;
      state.controller.abort(new Error(reason));
      state.snapshot = {
        ...state.snapshot,
        status: "killed",
        endedAt: Date.now(),
        error: reason,
      };
      this.children.set(childId, state);
    }
    this.emitRoster();
  }

  /** Worker-pool drain: start queued children while under the concurrency
   *  cap; resolve when every registered child reached a terminal state. */
  private async drain(): Promise<void> {
    const maxConcurrent = this.opts.maxConcurrent ?? SUBAGENT_MAX_CONCURRENT;
    const timeoutMs = this.opts.timeoutMs ?? SUBAGENT_TIMEOUT_MS;
    const settled = new Promise<void>((resolve) => {
      const pump = () => {
        if (this.abortedAll) {
          // Any stragglers not yet marked (registered but never started) are
          // killed by abortAll above; wait for their spawnChild to unwind.
        }
        while (!this.abortedAll && this.active < maxConcurrent && this.queue.length > 0) {
          const next = this.queue.shift();
          if (!next) break;
          this.active++;
          void this.runOne(next.childId, next.spec, timeoutMs).finally(() => {
            this.active--;
            pump();
            if (this.active === 0 && this.queue.length === 0) resolve();
          });
        }
        if (this.active === 0 && this.queue.length === 0) resolve();
      };
      pump();
    });
    await settled;
  }

  private async runOne(childId: string, spec: SubagentTaskSpec, timeoutMs: number): Promise<void> {
    const state = this.children.get(childId);
    if (!state) return;
    const timeout = setTimeout(() => {
      state.controller.abort(new Error(`subagent timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    try {
      const outcome = await this.opts.spawnChild(spec, state.callbacks, state.controller.signal);
      state.snapshot = {
        ...state.snapshot,
        status: outcome.status,
        totalTokens: outcome.totalTokens || state.snapshot.totalTokens,
        endedAt: Date.now(),
        ...(outcome.error ? { error: outcome.error } : {}),
      };
      // Fold the final text into the transcript so the viewer shows the
      // answer even when no message_end callback fired (defensive).
      if (outcome.finalText && !state.blocks.some((b) => b.kind === "text" && b.text === outcome.finalText)) {
        this.appendBlock(state, { kind: "text", text: outcome.finalText });
      }
      this.emitRoster();
      this.emitTranscript(childId);
    } catch (err) {
      const killed = state.controller.signal.aborted;
      state.snapshot = {
        ...state.snapshot,
        status: killed ? "killed" : "failed",
        endedAt: Date.now(),
        error: (err as Error).message,
      };
      this.emitRoster();
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Semantic callbacks wired to one child's transcript + roster state. */
  private makeCallbacks(childId: string): ChildProgressCallbacks {
    const touch = () => {
      this.emitRoster();
      this.emitTranscript(childId);
    };
    return {
      onText: (text) => {
        const state = this.children.get(childId);
        if (!state || !text) return;
        // Last-text-wins per child (message-level granularity): replace the
        // trailing text block instead of growing an append-only log.
        const last = state.blocks[state.blocks.length - 1];
        if (last?.kind === "text") {
          state.blocks[state.blocks.length - 1] = { kind: "text", text };
        } else {
          this.appendBlock(state, { kind: "text", text });
        }
        state.snapshot = { ...state.snapshot, summary: truncateSummary(text) };
        touch();
      },
      onThinking: (text) => {
        const state = this.children.get(childId);
        if (!state || !text) return;
        const last = state.blocks[state.blocks.length - 1];
        if (last?.kind === "thinking") {
          state.blocks[state.blocks.length - 1] = { kind: "thinking", text };
        } else {
          this.appendBlock(state, { kind: "thinking", text });
        }
        touch();
      },
      onToolStart: (toolCallId, toolName, input) => {
        const state = this.children.get(childId);
        if (!state) return;
        this.appendBlock(state, {
          kind: "tool_use",
          toolCallId,
          toolName,
          input,
          status: "running",
        });
        state.snapshot = { ...state.snapshot, lastToolName: toolName };
        touch();
      },
      onToolEnd: (toolCallId, result, isError) => {
        const state = this.children.get(childId);
        if (!state) return;
        const idx = state.blocks.findIndex(
          (b) => b.kind === "tool_use" && b.toolCallId === toolCallId,
        );
        if (idx >= 0) {
          const block = state.blocks[idx];
          if (block.kind === "tool_use") {
            state.blocks[idx] = {
              ...block,
              status: isError ? "error" : "done",
              ...(result !== undefined ? { result } : {}),
            };
          }
        }
        const uses = (state.snapshot.toolUses ?? 0) + 1;
        state.snapshot = { ...state.snapshot, toolUses: uses };
        touch();
      },
    };
  }

  private appendBlock(state: ChildState, block: SubagentTranscriptBlock): void {
    state.blocks.push(block);
  }

  private emitRoster(): void {
    this.opts.ctx.emit({
      type: "subagent.update",
      sessionId: this.opts.sessionId,
      agents: [...this.children.values()].map((c) => c.snapshot),
    });
  }

  private emitTranscript(childId: string): void {
    const state = this.children.get(childId);
    if (!state) return;
    this.opts.ctx.emit({
      type: "subagent.transcript",
      sessionId: this.opts.sessionId,
      parentToolUseId: childId,
      blocks: [...state.blocks],
    });
  }

  /** Aggregate the children's outcomes into one tool-result text. */
  private resultText(childIds: string[]): { text: string; isError: boolean } {
    const parts: string[] = [];
    let completed = 0;
    for (const childId of childIds) {
      const state = this.children.get(childId);
      if (!state) continue;
      const s = state.snapshot;
      if (s.status === "completed") completed++;
      const head = `## ${s.description} — ${s.status}`;
      const body =
        [...state.blocks].reverse().find((b) => b.kind === "text")?.text ??
        s.error ??
        "(无输出)";
      parts.push(`${head}\n\n${body}`);
    }
    return {
      text: parts.join("\n\n"),
      isError: childIds.length > 0 && completed === 0,
    };
  }
}

/** One-line summary for the capsule (roster), kept short. */
function truncateSummary(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > 120 ? `${line.slice(0, 117)}…` : line;
}
