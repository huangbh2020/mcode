/**
 * SDKMessage → RuntimeEvent normalization engine.
 *
 * Ported from the ClaudeRuntime's NDJSON handlers (handleSystem, handleStreamEvent,
 * handleAssistant, handleUser, handleResult). The input is now a structured
 * SDKMessage object instead of a raw JSON string. Output is the same RuntimeEvent
 * union — the frontend / IPC / persistence contract is unchanged.
 */
import { randomUUID } from "node:crypto";
import type {
  RuntimeEvent,
  TextDeltaEvent,
  ThinkingEvent,
  ToolUseEvent,
  ToolResultEvent,
  ContextUsageEvent,
  ContextSnapshot,
  TurnDoneEvent,
  TurnFilesEvent,
  ErrorEvent,
  TodoUpdateEvent,
  AskUserQuestionEvent,
  ModeChangeEvent,
  PlanUpdateEvent,
  SubagentUpdateEvent,
  SubagentSnapshot,
} from "@contracts/runtime";
import type { ProviderContext } from "@contracts/provider";
import { FileSnapshot, FILE_MUTATING_TOOLS, getToolFilePath, normalizeToolFilePath } from "@main/lib/fileSnapshot.js";
import type {
  SDKMessage,
  SDKSystemMessage,
  SDKAssistantMessage,
  SDKUserMessage,
  SDKResultMessage,
  SDKPartialAssistantMessage,
  Query,
} from "@anthropic-ai/claude-agent-sdk";

/** Minimal envelope for SDKTaskStartedMessage. The full SDK type is rich
 *  (uuid, session_id, workflow_name, prompt, …); we only forward the bits
 *  the renderer needs. Avoids pulling a large union into this file. */
interface TaskStartedEnvelope {
  type: "system";
  subtype: "task_started";
  task_id: string;
  tool_use_id?: string;
  description?: string;
  subagent_type?: string;
  /** SDK flag: when true the parent agent does not block on this task and it
   *  may continue running after the parent turn's stream ends. */
  is_backgrounded?: boolean;
}

interface TaskProgressEnvelope {
  type: "system";
  subtype: "task_progress";
  task_id: string;
  tool_use_id?: string;
  description?: string;
  subagent_type?: string;
  usage?: { total_tokens?: number; tool_uses?: number; duration_ms?: number };
  last_tool_name?: string;
  summary?: string;
}

interface TaskUpdatedEnvelope {
  type: "system";
  subtype: "task_updated";
  task_id: string;
  patch?: {
    status?: "pending" | "running" | "completed" | "failed" | "killed" | "paused";
    description?: string;
    end_time?: number;
    total_paused_ms?: number;
    error?: string;
    is_backgrounded?: boolean;
  };
}
import {
  normalizeClaudeTokenUsage,
  mergeClaudeTokenUsageSnapshot,
  buildCompactSnapshot,
  buildSnapshotFromControlChannel,
  resolveEffectiveContextWindow,
  totalProcessedTokensFromRawUsage,
  type RawClaudeUsage,
  type ClaudeContextWindowTag,
} from "./claudeTokenUsage.js";

/* ─── helpers ─── */

function readStr(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function safeJsonParse<T>(s: string): T | undefined {
  try {
    return JSON.parse(s) as T;
  } catch {
    return undefined;
  }
}

/* ─── AskUserQuestion sentinel fallback ───────────────────────────────
 * When the environment lacks a native AskUserQuestion tool, we inject a
 * system prompt (see ClaudeAgentSdkProvider) teaching the model to emit
 * sentinel-delimited JSON. This scanner intercepts it from text deltas.
 *
 * This is a simplified copy of the original QuestionSentinelScanner from
 * the legacy ClaudeRuntime. When AskUserQuestion tool is available
 * (capabilities.supportsAskUserQuestion), this scanner is not created.
 */

const ASK_BEGIN = "<<<ASK_USER_QUESTION>>>";
const ASK_END = "<<<END_ASK_USER_QUESTION>>>";

/** Extract balanced JSON end position, or 0 if incomplete. */
function findJsonEnd(buf: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < buf.length; i++) {
    const ch = buf[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") { depth++; continue; }
    if (ch === "}") { depth--; if (depth === 0) return i + 1; continue; }
  }
  return 0;
}

/** Quick check: does this JSON parse as a question payload? */
function isQuestionPayload(json: string): boolean {
  try {
    const obj = JSON.parse(json);
    if (!obj || typeof obj !== "object") return false;
    const questions = (obj as { questions?: unknown }).questions;
    if (Array.isArray(questions)) return questions.length > 0;
    if (questions && typeof questions === "object") {
      return Array.isArray((questions as { item?: unknown }).item);
    }
    return false;
  } catch {
    return false;
  }
}

class SentinelScanner {
  private buf = "";
  private flushed = 0;
  private completedQuestions: string[] = [];

  push(chunk: string): string {
    this.buf += chunk;
    let safe = "";

    while (true) {
      const remaining = this.buf.slice(this.flushed);
      if (!remaining) break;

      const beginIdx = remaining.indexOf(ASK_BEGIN);
      if (beginIdx >= 0) {
        safe += remaining.slice(0, beginIdx);
        this.flushed += beginIdx;
        const afterBegin = this.buf.slice(this.flushed);
        const endRel = afterBegin.indexOf(ASK_END);
        if (endRel >= 0) {
          const json = this.buf.slice(this.flushed + ASK_BEGIN.length, this.flushed + endRel).trim();
          if (json) this.completedQuestions.push(json);
          this.flushed += endRel + ASK_END.length;
          continue;
        }
        break;
      }

      // Bare JSON fallback (only at message start)
      const bareIdx = remaining.search(/\{\s*"questions"\s*:/);
      if (bareIdx >= 0 && /^\s*$/.test(remaining.slice(0, bareIdx))) {
        safe += remaining.slice(0, bareIdx);
        const jsonStart = this.flushed + bareIdx;
        const jsonEnd = findJsonEnd(this.buf, jsonStart);
        if (jsonEnd > jsonStart) {
          const json = this.buf.slice(jsonStart, jsonEnd).trim();
          if (isQuestionPayload(json)) {
            this.completedQuestions.push(json);
            this.flushed = jsonEnd;
            continue;
          }
        }
        this.flushed += bareIdx;
        break;
      }

      const withhold = ASK_BEGIN.length - 1;
      const tail = remaining.length > withhold ? remaining.slice(0, remaining.length - withhold) : "";
      safe += tail;
      this.flushed += tail.length;
      break;
    }
    return safe;
  }

  takeQuestions(): string[] {
    const q = this.completedQuestions;
    this.completedQuestions = [];
    return q;
  }

  flush(): string {
    const remaining = this.buf.slice(this.flushed);
    this.flushed = this.buf.length;
    return remaining;
  }
}

// Re-exported from the shared @main/lib/askQuestion module so both the Claude
// and Pi providers use one implementation. The sentinel scanner below and
// ClaudeAgentSdkProvider's canUseTool import it from here for backward compat.
// Imported as a value (not just re-exported) because the sentinel scanner
// below calls parseQuestions locally.
import { parseQuestions } from "@main/lib/askQuestion.js";
export { parseQuestions } from "@main/lib/askQuestion.js";

/* ─── adapter state ────────────────────────────────────────────────── */

interface AdapterState {
  blockMessageIds: Map<number, string>;
  emittedToolUse: Set<string>;
  /** The messageId of the most recent text/thinking assistant message.
   *  Claude's SDK sends text and tool_use as SEPARATE assistant messages
   *  (one content block type per message — see docs/claude-stream-json.md
   *  §4), so a tool_use block can never look backward within its own
   *  content array for the narration text. Track the last narration
   *  messageId across messages instead: each tool.use carries it, keeping
   *  the interleaved "text → tool → text → tool" timeline intact (same
   *  fix pattern as PiMessageAdapter.pendingToolTargetId). */
  lastNarrationMessageId: string | null;
  tasks: TodoUpdateEvent["todos"];
  /** Per-message sentinel scanners — only created when AskUserQuestion tool is unavailable. */
  textScanners: Map<string, SentinelScanner>;
  /** Most recent normalized context snapshot (from path A mid-turn or path C
   *  turn-end). Feeds the never-downgrade window rule + path-C merge. */
  lastKnownTokenUsage?: ContextSnapshot;
  /** Last resolved context-window ceiling for this session. Used by
   *  `resolveEffectiveContextWindow` to refuse transient downgrades. */
  lastKnownContextWindow: number;
  /** Live subagent roster. Keyed by SDK task_id. Mutated by task_started /
   *  task_progress / task_updated edge events, then flushed as a single
   *  `subagent.update` event (REPLACE semantics). */
  subagents: Map<string, SubagentSnapshot>;
  /** Whether the model is currently in plan mode. Set true on EnterPlanMode,
   *  false on the matching ExitPlanMode or when a `mode.change` to default
   *  arrives (covers rejection / interruption). Drives `plan.update` emit. */
  inPlanMode: boolean;
  /** In-flight `Query.getContextUsage()` promise kicked off at the last
   *  `handleAssistant` (while the CLI process is still alive). Awaited at
   *  turn-end in `emitTurnEndSnapshot` so we can read the authoritative
   *  context-window occupancy before the generator closes. If the promise
   *  rejects (e.g. Query already closed) we fall back to path C. */
  pendingContextUsage?: Promise<unknown> | null;
  /** Diagnostic: how many SDK assistant messages this turn has produced so
   *  far. Logged at the getContextUsage kickoff so we can correlate the
   *  control-channel's accuracy with how far into the turn it fired. */
  assistantMessageCount: number;
  /** Diagnostic: how many `message_delta` stream events carried a non-empty
   *  usage this turn. Gateway streams often omit usage entirely (assistant
   *  messages then arrive usage-less and path A never fires) — this counter
   *  tells us whether the delta-level source is viable. */
  streamDeltaUsageCount: number;
  /** Whether turn.done has been emitted for this turn. Guards against double
   *  emits when both a result message and flushFinal() fire it. */
  turnDoneEmitted: boolean;
  /** Reason captured from the LAST `result` message. When that result was an
   *  INTERMEDIATE one (held back because subagents were still running), the
   *  real turn.done is deferred to flushFinal(), which uses this reason. */
  lastResultReason?: TurnDoneEvent["reason"];
  /** Level signal of live background tasks (SDK `background_tasks_changed`).
   *  The SDK documents it as the authoritative "is background work running"
   *  source — we track the task_ids here for observability / future use.
   *  (Previously fed a turn.done gate in maybeEmitTurnDone; that gate is gone
   *  — turn.done is now emitted solely by flushFinal() when the generator
   *  closes — but we keep consuming the level signal so the wiring is intact
   *  if we need an authoritative "still working" check later.) */
  backgroundTaskIds: Set<string>;
}

/* ─── public export ────────────────────────────────────────────────── */

export class SdkMessageAdapter {
  private state: AdapterState;

  constructor(
    private ctx: ProviderContext,
    private sessionId: string,
    /** Whether the provider's native AskUserQuestion tool is available. If false,
     * a SentinelScanner intercepts sentinel JSON from text deltas. */
    private askUserQuestionAvailable: boolean,
    /** Cwd passed to the SDK. Used to resolve relative `file_path`s from
     *  Edit/Write tool_use when snapshotting for the rewind feature. */
    private cwd: string,
    /** Per-turn file snapshot. The adapter records pre-turn content for
     *  every file Edit/Write touches; at turn end it emits a `turn.files`
     *  event so the renderer can show the "本轮文件" card. The same
     *  instance lives across the turn (clear() is called by the runtime
     *  at the *next* turn's start, not here). */
    private snapshots: FileSnapshot,
    /** The turn's AbortSignal. When aborted (user clicked stop), flushFinal()
     *  marks still-running subagents as `killed` instead of `completed` so
     *  they visually show "已终止" (stopped), reflecting the user's intent.
     *  `null` only in tests that don't exercise interrupt. */
    private abortSignal: AbortSignal | null = null,
    /** Live Query handle from the SDK. When available, {@link handleResult}
     *  calls {@link Query.getContextUsage} at turn-end to get the authoritative
     *  context-window snapshot (path B). Falls back to path-A/C merge when
     *  `null` or when the control-channel call fails. */
    private query: Query | null = null,
    /** Initial todos seeded from the persisted session state. Lets a fresh
     *  adapter resolve TaskUpdate(taskId=N) from earlier turns instead of
     *  silently dropping it when state.tasks is empty (the adapter is
     *  recreated each turn, so without seeding a cross-turn TaskUpdate has
     *  no list to index into). */
    initialTodos: TodoUpdateEvent["todos"] = [],
  ) {
    this.state = {
      blockMessageIds: new Map(),
      emittedToolUse: new Set(),
      lastNarrationMessageId: null,
      tasks: [...initialTodos],
      textScanners: new Map(),
      lastKnownContextWindow: 0,
      subagents: new Map(),
      inPlanMode: false,
      pendingContextUsage: null,
      assistantMessageCount: 0,
      streamDeltaUsageCount: 0,
      turnDoneEmitted: false,
      backgroundTaskIds: new Set(),
    };
  }

  /** Feed one SDKMessage through the normalization pipeline. */
  async dispatch(m: SDKMessage): Promise<void> {
    const type = m.type;
    if (type === "system") {
      // Task lifecycle events share the `system` envelope - dispatch on
      // subtype alongside `init`. Unknown subtypes are silently ignored
      // (forward-compatible).
      const sys = m as SDKSystemMessage;
      const subtype = (sys as { subtype?: string }).subtype;
      if (subtype === "init") {
        this.handleSystem(sys);
      } else if (subtype === "task_started") {
        this.handleTaskStarted(sys as unknown as TaskStartedEnvelope);
      } else if (subtype === "task_progress") {
        this.handleTaskProgress(sys as unknown as TaskProgressEnvelope);
      } else if (subtype === "task_updated") {
        this.handleTaskUpdated(sys as unknown as TaskUpdatedEnvelope);
      } else if (subtype === "compact_boundary") {
        this.handleCompactBoundary(sys as unknown as {
          subtype: "compact_boundary";
          compact_metadata: {
            trigger: "manual" | "auto";
            pre_tokens: number;
            post_tokens?: number;
            duration_ms?: number;
          };
        });
      } else if (subtype === "background_tasks_changed") {
        this.handleBackgroundTasksChanged(sys as unknown as {
          subtype: "background_tasks_changed";
          tasks: { task_id: string; task_type: string; description: string }[];
        });
      }
    } else if (type === "stream_event") {
      this.handleStreamEvent(m as SDKPartialAssistantMessage);
    } else if (type === "assistant") {
      this.handleAssistant(m as SDKAssistantMessage);
    } else if (type === "user") {
      this.handleUser(m as SDKUserMessage);
    } else if (type === "result") {
      await this.handleResult(m as SDKResultMessage);
    }
    // Unknown message types are silently ignored (forward-compatible).
  }

  /** Call once the generator completes (or after a catch). Emits a fallback
   * turn.done if none was already emitted, plus a `turn.files` event
   * listing every file Edit/Write touched in this turn (so the renderer
   * can show the "本轮文件" card with per-file tallies + a rewind button).
   *
   * Async because freeze() now reads each file's post-turn on-disk content
   * to compute the +N -M tallies and carry the pre-turn `before` payload. */
  async flushFinal(): Promise<void> {
    // Freeze and emit the snapshot list regardless of whether result
    // arrived. After freeze(), the snapshot is "frozen" — late
    // tool_use events for this adapter instance (shouldn't happen,
    // but defensively) will be ignored by recordPre.
    const files = await this.snapshots.freeze();
    if (files.length > 0) {
      this.ctx.emit({
        type: "turn.files",
        sessionId: this.sessionId,
        files,
      } satisfies TurnFilesEvent);
    }
    // End-of-turn safety net: if the model was still in plan mode (deny,
    // interrupt, or generator aborted before ExitPlanMode finalized), make
    // sure the renderer's plan section collapses instead of getting stuck
    // on a stale "草拟中" badge.
    if (this.state.inPlanMode) {
      this.state.inPlanMode = false;
      this.ctx.emit({
        type: "plan.update",
        sessionId: this.sessionId,
        plan: "",
        phase: "cleared",
      } satisfies PlanUpdateEvent);
    }
    // End-of-turn safety net for still-running subagents.
    //
    // NORMAL turn end: any FOREGROUND subagent still "running" is finished
    // (the parent turn was blocking on it). Mark those "completed" so the
    // capsule stops animating. We only auto-complete - real task_updated
    // events arriving earlier may have set failed/killed, which we preserve.
    //
    // BACKGROUND subagents (is_backgrounded=true) are different: the parent
    // agent did NOT block on them and they may still be running in the CLI
    // after this turn's stream closes. We deliberately leave them "running"
    // so the renderer keeps the "busy" signal alive while they remain
    // running.
    //
    // INTERRUPTED turn (user clicked stop): the abort signal is set. The user
    // asked to STOP everything, so mark ALL still-running subagents
    // (foreground AND background) as "killed" - they show "已终止" (stopped),
    // reflecting the user's intent rather than falsely reporting "completed".
    const aborted = !!this.abortSignal?.aborted;
    let subagentsChanged = false;
    for (const [id, s] of this.state.subagents) {
      if (s.status === "running" && (aborted || !s.isBackgrounded)) {
        this.state.subagents.set(id, {
          ...s,
          status: aborted ? "killed" : "completed",
          endedAt: s.endedAt ?? Date.now(),
        });
        subagentsChanged = true;
      }
    }
    if (subagentsChanged) this.flushSubagents();
    // Turn end, exactly once. Three paths converge here:
    //  - a result arrived while subagents were still running → held back by
    //    maybeEmitTurnDone, now emitted with the final result's reason;
    //  - the stream ended without any result → safety-net "interrupted"
    //    (preserves the pre-existing fallback semantics);
    //  - a normal result already emitted turn.done → no-op (guard inside).
    if (!this.state.turnDoneEmitted) {
      this.emitTurnDone(this.state.lastResultReason ?? "interrupted");
    }
  }

  /* ──────────────── per-message-type handlers ──────────────── */

  private handleSystem(m: SDKSystemMessage): void {
    if (m.subtype === "init") {
      this.ctx.onProviderSessionId?.(m.session_id);
      this.ctx.log.info(
        `claude SDK init: session=${m.session_id}, model=${m.model}, permissionMode=${m.permissionMode}`,
      );
    }
  }

  /** Compact boundary: the SDK finished a context compaction (manual
   *  `/compact` or auto-compact). Emit a `compact.result` event so the
   *  renderer can show a summary card in the message stream, AND emit a
   *  `token-usage.updated` event built from `post_tokens` so the context
   *  ring / persistence / path-C merge all reflect the reduced occupancy.
   *  Without the token-usage emit, the ring would stay at the pre-compact
   *  value until the next assistant response - which may never come if the
   *  user just ran `/compact` and stopped. */
  private handleCompactBoundary(m: {
    subtype: "compact_boundary";
    compact_metadata: {
      trigger: "manual" | "auto";
      pre_tokens: number;
      post_tokens?: number;
      duration_ms?: number;
    };
  }): void {
    const meta = m.compact_metadata;
    this.ctx.emit({
      type: "compact.result",
      sessionId: this.sessionId,
      trigger: meta.trigger,
      preTokens: meta.pre_tokens,
      postTokens: meta.post_tokens,
      durationMs: meta.duration_ms,
    });
    // Build a post-compaction snapshot from post_tokens. publishTokenUsageSnapshot
    // updates lastKnownTokenUsage (so path-C merge at turn-end uses the
    // post-compact occupancy) and lastKnownContextWindow (never-downgrade),
    // then emits token-usage.updated -> renderer ring + DB persistence.
    const snapshot = buildCompactSnapshot({
      postTokens: meta.post_tokens,
      lastKnown: this.state.lastKnownTokenUsage,
      model: this.state.lastKnownTokenUsage?.model,
    });
    if (snapshot) {
      this.publishTokenUsageSnapshot(snapshot);
    }
  }

  /* ──────────────── subagent task lifecycle (SDK level-signal pattern) ────────────────
   * The SDK emits three edge events for background / foreground subagent
   * tasks. We maintain a `Map<taskId, SubagentSnapshot>` and flush a single
   * `subagent.update` after each change so the renderer can REPLACE its
   * roster (no client-side merge). Field shapes are documented in the
   * SDK's sdk.d.ts SDKTask*Message types — we keep our own minimal envelope
   * types here to avoid dragging those deep generics into this file. */

  private handleTaskStarted(m: TaskStartedEnvelope): void {
    const snapshot: SubagentSnapshot = {
      taskId: m.task_id,
      toolUseId: m.tool_use_id,
      description: m.description ?? "",
      subagentType: m.subagent_type,
      status: "running",
      isBackgrounded: m.is_backgrounded ?? false,
    };
    this.state.subagents.set(m.task_id, snapshot);
    this.flushSubagents();
  }

  private handleTaskProgress(m: TaskProgressEnvelope): void {
    const cur = this.state.subagents.get(m.task_id);
    if (!cur) {
      // Progress without a prior start — synthesize a minimal snapshot so
      // the roster stays consistent. Defensive: SDK normally pairs these.
      this.state.subagents.set(m.task_id, {
        taskId: m.task_id,
        toolUseId: m.tool_use_id,
        description: m.description ?? "",
        subagentType: m.subagent_type,
        status: "running",
        totalTokens: m.usage?.total_tokens,
        toolUses: m.usage?.tool_uses,
        durationMs: m.usage?.duration_ms,
        lastToolName: m.last_tool_name,
        summary: m.summary,
      });
    } else {
      this.state.subagents.set(m.task_id, {
        ...cur,
        // description can be refined by progress (e.g. updated task brief);
        // preserve it if the progress payload omits one.
        description: m.description || cur.description,
        subagentType: m.subagent_type ?? cur.subagentType,
        totalTokens: m.usage?.total_tokens ?? cur.totalTokens,
        toolUses: m.usage?.tool_uses ?? cur.toolUses,
        durationMs: m.usage?.duration_ms ?? cur.durationMs,
        lastToolName: m.last_tool_name ?? cur.lastToolName,
        summary: m.summary ?? cur.summary,
      });
    }
    this.flushSubagents();
  }

  private handleTaskUpdated(m: TaskUpdatedEnvelope): void {
    const cur = this.state.subagents.get(m.task_id);
    if (!cur) return; // orphan update — ignore
    const patch = m.patch ?? {};
    // Map SDK lifecycle to our 4-value union.
    let status: SubagentSnapshot["status"] = cur.status;
    if (patch.status === "completed") status = "completed";
    else if (patch.status === "failed") status = "failed";
    else if (patch.status === "killed") status = "killed";
    else if (patch.status === "running" || patch.status === "pending" || patch.status === "paused") {
      status = "running";
    }
    this.state.subagents.set(m.task_id, {
      ...cur,
      status,
      description: patch.description ?? cur.description,
      endedAt: typeof patch.end_time === "number" ? patch.end_time : cur.endedAt,
      error: patch.error ?? cur.error,
      isBackgrounded: patch.is_backgrounded ?? cur.isBackgrounded,
    });
    this.flushSubagents();
  }

  /** Level signal: the SDK's authoritative "which background tasks are live"
   *  roster. REPLACE semantics per the SDK docs — swap the whole id set. We
   *  don't emit a `subagent.update` here (the edge events task_started /
   *  task_updated already drive the renderer roster); this set only feeds the
   *  turn.done gate so a backgrounded task that skipped its task_started edge
   *  still counts as "work in progress" and holds the composer locked. */
  private handleBackgroundTasksChanged(m: {
    subtype: "background_tasks_changed";
    tasks: { task_id: string; task_type: string; description: string }[];
  }): void {
    this.state.backgroundTaskIds = new Set((m.tasks ?? []).map((t) => t.task_id));
  }

  /** Emit the turn.done event exactly once per turn. Both handleResult (when
   *  the result isn't held back) and flushFinal (deferred end) route through
   *  here so the guard can't be bypassed by a result message followed by a
   *  stream-teardown emit. */
  private emitTurnDone(reason: TurnDoneEvent["reason"]): void {
    if (this.state.turnDoneEmitted) return;
    this.state.turnDoneEmitted = true;
    this.ctx.emit({
      type: "turn.done",
      sessionId: this.sessionId,
      reason,
    } satisfies TurnDoneEvent);
  }

  /** Emit the current subagent roster as a single `subagent.update` event.
   *  REPLACE semantics — the host should swap, not merge. */
  private flushSubagents(): void {
    this.ctx.emit({
      type: "subagent.update",
      sessionId: this.sessionId,
      agents: Array.from(this.state.subagents.values()),
    } satisfies SubagentUpdateEvent);
  }

  /** Look up a subagent snapshot by its originating Task tool_use id.
   *  Used to merge a later SDK task_started with a synthetic snapshot
   *  we created from the tool_use block. */
  private findSubagentByToolUseId(toolUseId: string): SubagentSnapshot | undefined {
    for (const s of this.state.subagents.values()) {
      if (s.toolUseId === toolUseId) return s;
    }
    return undefined;
  }

  private handleStreamEvent(m: SDKPartialAssistantMessage): void {
    const ev = m.event;
    if (!ev) return;

    if (ev.type === "content_block_start") {
      const index = (ev as { index?: number }).index;
      if (typeof index === "number") {
        this.state.blockMessageIds.set(index, randomUUID());
      }
    } else if (ev.type === "content_block_stop") {
      // Flush withheld text from sentinel scanner.
      const index = (ev as { index?: number }).index;
      if (typeof index === "number") {
        const messageId = this.state.blockMessageIds.get(index);
        if (messageId) {
          const scanner = this.state.textScanners.get(messageId);
          if (scanner) {
            const tail = scanner.flush();
            if (tail) {
              this.ctx.emit({
                type: "text.delta",
                sessionId: this.sessionId,
                messageId,
                text: tail,
              } satisfies TextDeltaEvent);
            }
          }
        }
      }
    } else if (ev.type === "content_block_delta") {
      const index = (ev as { index?: number }).index;
      if (typeof index !== "number") return;
      const messageId = this.state.blockMessageIds.get(index);
      if (!messageId) return;

      const delta = (ev as { delta?: { type?: string; text?: string; thinking?: string } }).delta;
      if (!delta) return;

      if (delta.type === "text_delta" && delta.text) {
        if (!this.askUserQuestionAvailable) {
          // Run through sentinel scanner to filter AskUserQuestion JSON
          let scanner = this.state.textScanners.get(messageId);
          if (!scanner) {
            scanner = new SentinelScanner();
            this.state.textScanners.set(messageId, scanner);
          }
          const safe = scanner.push(delta.text);
          if (safe) {
            this.ctx.emit({
              type: "text.delta",
              sessionId: this.sessionId,
              messageId,
              text: safe,
            } satisfies TextDeltaEvent);
          }
          for (const json of scanner.takeQuestions()) {
            const questions = parseQuestions(safeJsonParse(json));
            if (questions.length > 0) {
              // Sentinel-fallback questions can't block the SDK turn (the
              // model already finished emitting — there's no canUseTool to
              // answer). Use a `sentinel_`-prefixed requestId so the host
              // knows to send answers as the next turn's prompt rather than
              // resolving a Deferred.
              this.ctx.emit({
                type: "question.ask",
                sessionId: this.sessionId,
                requestId: `sentinel_${randomUUID()}`,
                questions,
              } satisfies AskUserQuestionEvent);
            }
          }
        } else {
          // Native tool handles AskUserQuestion via canUseTool; text deltas
          // pass through unfiltered.
          this.ctx.emit({
            type: "text.delta",
            sessionId: this.sessionId,
            messageId,
            text: delta.text,
          } satisfies TextDeltaEvent);
        }
      } else if (delta.type === "thinking_delta" && delta.thinking) {
        this.ctx.emit({
          type: "thinking",
          sessionId: this.sessionId,
          messageId,
          text: delta.thinking,
        } satisfies ThinkingEvent);
      }
    } else if (ev.type === "message_delta") {
      // Path A supplement: `message_delta` fires once per API call with that
      // call's FINAL usage (snake_case, like BetaUsage). Gateway streams
      // frequently omit usage, which leaves the aggregated assistant messages
      // usage-less and path A dead (lastKnown undefined → turn-end falls back
      // to pathC-direct, overstating occupancy with the cumulative input).
      // Reading it here gives path A a per-call source when present. The
      // counter distinguishes "delta carries usage" from "gateway never sends
      // usage" in the turn-end logs.
      const delta = ev as {
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
        };
      };
      if (delta.usage) {
        this.state.streamDeltaUsageCount += 1;
        this.emitTokenUsage(
          {
            inputTokens: delta.usage.input_tokens,
            outputTokens: delta.usage.output_tokens,
            cacheReadInputTokens: delta.usage.cache_read_input_tokens,
            cacheCreationInputTokens: delta.usage.cache_creation_input_tokens,
          },
          undefined,
          undefined,
        );
      }
    }
  }

  private handleAssistant(m: SDKAssistantMessage): void {
    this.state.assistantMessageCount += 1;
    const message = m.message as {
      content?: Array<{ type: string; id?: string; name?: string; input?: unknown }>;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
      model?: string;
    };
    const blocks = message.content;
    if (!blocks) return;

    // Path A (doc §2): per-assistant-response usage. This is the most accurate
    // reflection of the current context-window occupancy (the API call's prompt
    // + output size). Emits mid-turn so the status bar can update before the
    // turn completes. Skipped when `usage` is absent or all-zero (the SDK
    // forwards zeros from some proxies / non-Anthropic gateways).
    //
    // NOTE: the SDK forwards the API's `usage` verbatim on assistant messages
    // (Anthropic snake_case field names — BetaUsage), whereas RawClaudeUsage
    // uses camelCase (handleResult reads result.usage with explicit snake_case
    // keys, so it never hits this mismatch). Reading camelCase keys off the
    // snake_case object silently zeroes every field: normalize returns
    // undefined, path A never fires, lastKnown stays undefined, and the
    // turn-end fallback degrades to pathC-direct (cumulative result.usage as
    // occupancy), overstating the ring on multi-call turns. Map fields here.
    const usage = message.usage;
    this.emitTokenUsage(
      usage
        ? {
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
            cacheReadInputTokens: usage.cache_read_input_tokens,
            cacheCreationInputTokens: usage.cache_creation_input_tokens,
          }
        : undefined,
      message.model,
      undefined,
    );

    // Path B kickoff: fire off `Query.getContextUsage()` now while the CLI
    // process is still alive (during assistant-message processing). The result
    // is awaited at turn-end (emitTurnEndSnapshot). This is critical: calling
    // getContextUsage() only at result-time fails with "Query closed before
    // response received" because the generator is already tearing down. We
    // don't await here - just kick it off and let it resolve in the background.
    if (this.query && !this.state.pendingContextUsage) {
      // Diagnostic: log when the control channel fires relative to the turn's
      // assistant-message stream, plus the last path-A occupancy. Lets us
      // correlate getContextUsage accuracy with kickoff timing (gateway
      // models often report garbage: static-prompt-only totals, 0%).
      this.ctx.log.info(
        `context-usage kickoff: assistantMsgs=${this.state.assistantMessageCount} ` +
          `lastKnownUsed=${this.state.lastKnownTokenUsage?.usedTokens ?? "none"}`,
      );
      this.state.pendingContextUsage = this.query.getContextUsage().catch((err) => {
        // Swallow - the await in emitTurnEndSnapshot will see the rejection
        // via the stored promise and fall back to path C. Logging here helps
        // diagnose persistent failures (e.g. SDK version regressions).
        this.ctx.log.warn(
          `getContextUsage (kickoff) rejected: ${(err as Error).message}`,
        );
        throw err;
      });
    }

    for (const [idx, b] of blocks.entries()) {
      // Track the narration text so a subsequent tool_use block (which
      // claude's SDK sends as a SEPARATE assistant message — one content
      // block type per message, see docs/claude-stream-json.md §4) can
      // attach to the message that narrated it. blockMessageIds maps the
      // content-block index → messageId (assigned at content_block_start in
      // handleStreamEvent; text.delta uses the same map), so the index here
      // matches the stream's content index.
      if (b.type === "text" || b.type === "thinking") {
        const narrationId = this.state.blockMessageIds.get(idx);
        if (narrationId) this.state.lastNarrationMessageId = narrationId;
        continue;
      }
      if (b.type === "tool_use" && b.id && b.name) {
        // TODO(subagent-stream): subagent tool_use blocks carry a non-null
        // `parent_tool_use_id` on the message envelope. They are currently
        // filtered out of the main event stream to keep the main agent's
        // process surface clean (the Task tool call itself is the only
        // visible trace; subagent progress is summarized in the
        // ActivityPopover via subagent.update snapshots). When we add a
        // dedicated subagent transcript view, route these blocks there
        // instead of dropping them.
        if (m.parent_tool_use_id) continue;

        if (this.state.emittedToolUse.has(b.id)) continue;
        this.state.emittedToolUse.add(b.id);

        // Attach the tool to the message that narrated it. Claude's SDK
        // sends text and tool_use as SEPARATE assistant messages (one
        // content-block type per message — see docs/claude-stream-json.md
        // §4), so a tool block can't look backward within its own content
        // array for narration text. Instead we carry the most recent
        // text/thinking messageId tracked across messages
        // (lastNarrationMessageId, set below). Without this the store's
        // open-turn heuristic piles EVERY tool of the turn onto the opener,
        // while the interleaved narration text ("let me check…", "v8 is 25
        // pages…") becomes orphan messages AFTER the last tool — the
        // renderer then classifies them as the final reply and they leak
        // out of the TurnPanel. Same fix Pi got via
        // PiMessageAdapter.pendingToolTargetId.
        const messageId = this.state.lastNarrationMessageId ?? undefined;

        this.ctx.emit({
          type: "tool.use",
          sessionId: this.sessionId,
          toolCallId: b.id,
          toolName: b.name,
          input: b.input,
          requiresApproval: false,
          ...(messageId ? { messageId } : {}),
        } satisfies ToolUseEvent);

        // Snapshot the pre-turn content for every file-mutating tool so the
        // user can "撤销本轮" later. Fire-and-forget — we never want a
        // snapshot failure to derail the event stream. The first call per
        // (cwd+path) does the actual read; later calls are no-ops. The path
        // is normalized the same way the provider's canUseTool guard does —
        // the raw tool_use input may carry a WSL-style `/mnt/...` path the
        // CLI rewrote before executing, and only the normalized path matches
        // where the file actually landed.
        if (FILE_MUTATING_TOOLS.has(b.name)) {
          const fp = getToolFilePath(b.name, b.input);
          if (fp) {
            const norm = normalizeToolFilePath(this.cwd, fp);
            void this.snapshots.recordPre(this.cwd, norm?.absPath ?? fp);
          }
        }

        // TodoWrite is claude's canonical todo tool: it writes the WHOLE
        // list at once (every item with its current status), so a single
        // call both adds and flips items to completed/in_progress. We
        // replace the entire task list from its input. TaskCreate/TaskUpdate
        // below are a different (Agent SDK task) tool that mutates
        // incrementally — kept for compatibility, but TodoWrite is what the
        // chat agent actually uses, and without this branch completed
        // tasks never surfaced to the activity capsule.
        if (b.name === "TodoWrite") {
          const rawTodos = (b.input as Record<string, unknown> | undefined)?.todos;
          if (Array.isArray(rawTodos)) {
            const norm = rawTodos
              .map((item): TodoUpdateEvent["todos"][number] | null => {
                if (!item || typeof item !== "object") return null;
                const obj = item as Record<string, unknown>;
                const content = readStr(obj.content);
                if (!content) return null;
                const rawStatus = readStr(obj.status);
                const status =
                  rawStatus === "completed"
                    ? "completed"
                    : rawStatus === "in_progress"
                      ? "in_progress"
                      : "pending";
                const rawPriority = readStr(obj.priority);
                const priority =
                  rawPriority === "high"
                    ? "high"
                    : rawPriority === "low"
                      ? "low"
                      : "medium";
                return { content, status, priority };
              })
              .filter((x): x is TodoUpdateEvent["todos"][number] => x !== null);
            this.state.tasks = norm;
            this.ctx.emit({
              type: "todo.update",
              sessionId: this.sessionId,
              todos: [...this.state.tasks],
            });
          }
        } else if (b.name === "TaskCreate") {
          // TaskCreate's input field name varies by model: MiniMax-M3 uses
          // { subject, description, activeForm }, but other models may use a
          // different primary field. Accept any of them (first non-empty
          // wins) so the task actually enters the list - otherwise a later
          // TaskUpdate(taskId=N) has nothing to index into and the activity
          // capsule never reflects the status change.
          const inp = (b.input ?? {}) as Record<string, unknown>;
          const subject =
            readStr(inp.subject) ||
            readStr(inp.description) ||
            readStr(inp.activeForm) ||
            readStr(inp.content);
          if (subject) {
            this.state.tasks.push({ content: subject, status: "pending", priority: "medium" });
            this.ctx.emit({
              type: "todo.update",
              sessionId: this.sessionId,
              todos: [...this.state.tasks],
            });
          }
        } else if (b.name === "TaskUpdate") {
          const taskId = Number((b.input as Record<string, unknown> | undefined)?.taskId);
          const status = readStr((b.input as Record<string, unknown> | undefined)?.status);
          if (Number.isInteger(taskId) && taskId >= 1) {
            const norm = status === "completed" ? "completed" : status === "in_progress" ? "in_progress" : "pending";
            // Pad with placeholder items if taskId exceeds the current list.
            // This happens when TaskCreate used a field name we don't read
            // (see the TaskCreate branch below), or when the seeded list
            // doesn't cover this id. Better to surface a completed
            // placeholder than to silently drop the update and leave the
            // activity capsule stuck on a stale status.
            while (this.state.tasks.length < taskId) {
              this.state.tasks.push({
                content: `Task #${this.state.tasks.length + 1}`,
                status: "pending",
                priority: "medium",
              });
            }
            this.state.tasks[taskId - 1] = { ...this.state.tasks[taskId - 1], status: norm };
            this.ctx.emit({
              type: "todo.update",
              sessionId: this.sessionId,
              todos: [...this.state.tasks],
            });
          }
        } else if (b.name === "AskUserQuestion") {
          // Native AskUserQuestion tool_use appears in the finalized assistant
          // message AFTER canUseTool already fired question.ask via
          // ctx.requestUserInput. Don't re-emit here — it would duplicate the
          // question card and lose the requestId correlation. The sentinel
          // fallback path (when native tool is unavailable) is handled in
          // handleStreamEvent.
        } else if (b.name === "Task") {
          // Task tool (a.k.a. Agent) spawns a subagent. The SDK normally
          // emits a paired `task_started` system message; if that arrives
          // later it will merge/upgrade this snapshot. If not (e.g. the
          // SDK skipped the edge for a system-internal task), the snapshot
          // we create here is the only entry — better than nothing, and
          // it carries the user-supplied `description` which is the most
          // informative label we have.
          const input = (b.input ?? {}) as Record<string, unknown>;
          const description = readStr(input.description);
          const subagentType = readStr(input.subagent_type) || undefined;
          const existing = this.findSubagentByToolUseId(b.id);
          if (existing) {
            // Refine: SDK already opened a snapshot, just attach the
            // user-supplied description if the SDK didn't provide one.
            this.state.subagents.set(existing.taskId, {
              ...existing,
              description: existing.description || description,
              subagentType: existing.subagentType ?? subagentType,
            });
            this.flushSubagents();
          } else if (description || subagentType) {
            // Synthesize a placeholder keyed by the tool_use_id (we don't
            // know the SDK task_id yet). If a later task_started arrives
            // with a different task_id, it will create its own snapshot
            // and this one becomes orphaned — the renderer's roster is
            // REPLACE-based, so it'll just disappear. Acceptable.
            const syntheticId = `synthetic:${b.id}`;
            this.state.subagents.set(syntheticId, {
              taskId: syntheticId,
              toolUseId: b.id,
              description: description || "(subagent)",
              subagentType,
              status: "running",
            });
            this.flushSubagents();
          }
        } else if (b.name === "EnterPlanMode") {
          // Model initiated plan mode (e.g. via the EnterPlanMode tool). Tell
          // the host so the composer chip / status bar sync to "plan".
          this.ctx.emit({
            type: "mode.change",
            sessionId: this.sessionId,
            mode: "plan",
            source: "model",
          } satisfies ModeChangeEvent);
          // Mark the plan-mode session and emit a `plan.update` so the
          // activity capsule's Plan section appears immediately. The draft
          // is empty until ExitPlanMode; the renderer shows a "草拟中"
          // placeholder.
          this.state.inPlanMode = true;
          this.ctx.emit({
            type: "plan.update",
            sessionId: this.sessionId,
            plan: "",
            phase: "drafting",
          } satisfies PlanUpdateEvent);
        } else if (b.name === "ExitPlanMode") {
          // The finalized ExitPlanMode tool_use appears here only AFTER the
          // user approved it via canUseTool (a deny keeps the model in plan
          // mode and the SDK doesn't finalize the call). So seeing it here
          // means plan mode has ended for this turn → sync UI back to default.
          this.ctx.emit({
            type: "mode.change",
            sessionId: this.sessionId,
            mode: "default",
            source: "model",
          } satisfies ModeChangeEvent);
          // Emit a `plan.update` snapshot of the final plan text BEFORE
          // clearing the in-plan flag. The text comes from the tool's
          // `input.plan` field (verified present at runtime — SDK type
          // omits it but the wire format includes it). This is the
          // single source of truth for the plan the user just approved.
          const planText = typeof (b.input as { plan?: unknown })?.plan === "string"
            ? ((b.input as { plan: string }).plan)
            : "";
          if (planText) {
            this.ctx.emit({
              type: "plan.update",
              sessionId: this.sessionId,
              plan: planText,
              phase: "ready",
            } satisfies PlanUpdateEvent);
          }
          this.state.inPlanMode = false;
        }
      }
    }
  }

  private handleUser(m: SDKUserMessage): void {
    const blocks = (m.message as { content?: Array<{ type: string; tool_use_id?: string; is_error?: boolean; content?: unknown }> }).content;
    if (!blocks) return;

    for (const b of blocks) {
      if (b.type === "tool_result" && b.tool_use_id) {
        // TODO(subagent-stream): filter subagent tool_result blocks (non-null
        // `parent_tool_use_id`) out of the main stream - their corresponding
        // tool_use was already dropped in handleAssistant. When we add a
        // dedicated subagent transcript view, route these there instead.
        if (m.parent_tool_use_id) continue;

        this.ctx.emit({
          type: "tool.result",
          sessionId: this.sessionId,
          toolCallId: b.tool_use_id,
          isError: !!b.is_error,
          content: b.content,
        } satisfies ToolResultEvent);
      }
    }
  }

  private async handleResult(m: SDKResultMessage): Promise<void> {
    // Diagnostic: log the raw result envelope so we can see exactly what the
    // SDK delivered. Tokens staying at 0 after a turn usually means either
    // (a) the SDK didn't populate `usage` here, or (b) a non-success subtype
    // skipped usage emission entirely. Keep until the bug is confirmed fixed.
    const rawUsage = (m as { usage?: unknown }).usage;
    const rawModelUsage = (m as { modelUsage?: unknown }).modelUsage;
    this.ctx.log.info(
      `claude result: subtype=${m.subtype} usage=${JSON.stringify(rawUsage)} modelUsage=${JSON.stringify(rawModelUsage)} total_cost_usd=${(m as { total_cost_usd?: number }).total_cost_usd ?? "n/a"}`,
    );

    if (m.subtype === "success") {
      // Usage + cost (see https://code.claude.com/docs/en/agent-sdk/cost-tracking)
      // `usage` covers the top-level agent loop only; subagent tokens (e.g.
      // WebSearch, Task) are tracked in `modelUsage`. When `usage` reports
      // 0 tokens (all work delegated to subagents), we aggregate modelUsage
      // so the context ring still shows meaningful data.
      const usage = m.usage as {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      } | undefined;
      const rawInput = usage?.input_tokens ?? 0;
      const rawOutput = usage?.output_tokens ?? 0;

      // modelUsage: aggregate token/cost as a fallback for subagent-heavy
      // turns, AND read the per-model `contextWindow` (authoritative window
      // ceiling) for resolveEffectiveContextWindow. The SDK reports window
      // sizes here (e.g. claude-opus-4-1[1M] → 1_000_000).
      const modelUsage = (m as {
        modelUsage?: Record<string, {
          inputTokens?: number;
          outputTokens?: number;
          cacheReadInputTokens?: number;
          cacheCreationInputTokens?: number;
          costUSD?: number;
          contextWindow?: number;
        }>;
      }).modelUsage;
      let muInput = 0, muOutput = 0, muCacheRead = 0, muCacheCreation = 0, muCost = 0;
      let reportedWindow: number | undefined;
      if (modelUsage) {
        for (const v of Object.values(modelUsage)) {
          muInput += v.inputTokens ?? 0;
          muOutput += v.outputTokens ?? 0;
          muCacheRead += v.cacheReadInputTokens ?? 0;
          muCacheCreation += v.cacheCreationInputTokens ?? 0;
          muCost += v.costUSD ?? 0;
          // Track the largest reported window — multi-model turns should pick
          // the dominant model's ceiling. (Never-downgrade handled by
          // resolveEffectiveContextWindow via lastKnownContextWindow.)
          if (typeof v.contextWindow === "number" && v.contextWindow > 0) {
            reportedWindow = Math.max(reportedWindow ?? 0, v.contextWindow);
          }
        }
      }

// Path B (control channel): `Query.getContextUsage()` is the most
	      // authoritative source for context-window occupancy. When available,
	      // use it for `usedTokens`/`maxTokens`/`pct`; throughput/billing fields
	      // still come from the accumulated `result.usage` (path C).
	      //
	      // Path C (doc §2): fallback when the control channel is unavailable
	      // or fails. The SDK's `result.usage` is a CUMULATIVE sum across the
	      // whole run (billing semantics), NOT the current window occupancy —
	      // so `usedTokens`/`pct`/`warning` must come from the last path-A
	      // snapshot. The accumulated result contributes only throughput/cost/
	      // cache/output/window-ceiling metadata.
	      const costUsd = m.total_cost_usd ?? (muCost > 0 ? muCost : undefined);
	      const model = (m as { model?: string }).model;
	      const lastKnown = this.state.lastKnownTokenUsage;

	      // Build the accumulated throughput snapshot from result.usage.
	      // This always runs — the control channel only provides window
	      // occupancy, not billing/throughput data.
	      const accumulatedRaw: RawClaudeUsage = {
	        inputTokens: rawInput > 0 ? rawInput : muInput,
	        outputTokens: rawOutput > 0 ? rawOutput : muOutput,
	        cacheReadInputTokens:
	          (usage?.cache_read_input_tokens ?? 0) > 0
	            ? usage!.cache_read_input_tokens
	            : muCacheRead || undefined,
	        cacheCreationInputTokens:
	          (usage?.cache_creation_input_tokens ?? 0) > 0
	            ? usage!.cache_creation_input_tokens
	            : muCacheCreation || undefined,
	        costUsd,
	        model,
	      };

	      // Try path B (control channel) first. If it succeeds, merge with
	      // accumulated throughput. If it fails or is unavailable, fall back
	      // to path C (path-A merge).
	      await this.emitTurnEndSnapshot(accumulatedRaw, model, reportedWindow, lastKnown);

      // Permission denials
      for (const d of m.permission_denials ?? []) {
        if (!d.tool_use_id) continue;
        this.ctx.emit({
          type: "tool.result",
          sessionId: this.sessionId,
          toolCallId: d.tool_use_id,
          isError: true,
          content: `Permission denied${d.tool_name ? ` (${d.tool_name})` : ""}`,
        } satisfies ToolResultEvent);
      }

      // Capture the reason but do NOT emit turn.done here. CLI v2.1.198+ emits
      // an INTERMEDIATE result (usage all-zero) when the main agent hands off to
      // a backgrounded subagent — the stream resumes shortly after (a second
      // init arrives within milliseconds). Treating that intermediate result as
      // a turn end would prematurely clear `runningBySession` on the frontend
      // (the UI flips to "stopped" while the subagent keeps running in the
      // background). The real turn.done is emitted by flushFinal(), which fires
      // only when the generator truly closes — immune to any number of
      // intermediate results. `lastResultReason` carries the FINAL result's
      // reason through to flushFinal.
      this.state.lastResultReason = (m.stop_reason ?? "end_turn") as TurnDoneEvent["reason"];
    } else {
      // Error result. Emit the error event so the frontend shows it, but defer
      // turn.done to flushFinal() — same rationale as the success branch: an
      // error result may still be intermediate when subagents are involved.
      this.ctx.emit({
        type: "error",
        sessionId: this.sessionId,
        message: (m as { result?: string }).result ?? "Unknown error",
        code: "CLAUDE_ERROR",
      } satisfies ErrorEvent);
      this.state.lastResultReason = "error";
    }
  }

  /* ──────────────── token usage (paths A + C, doc §2) ──────────────── */

  /** Normalize raw usage fields and emit a `token-usage.updated` event
   *  carrying the resulting {@link ContextSnapshot}. Shared by path A
   *  (per assistant response) and the turn-end fallback in path C.
   *
   *  `reportedWindow` is the SDK-reported ceiling from `modelUsage[model].
   *  contextWindow`; `configured` is the user override (reserved for future
   *  settings). Both feed `resolveEffectiveContextWindow`, which also applies
   *  the never-downgrade rule via `state.lastKnownContextWindow`.
   *
   *  No-op when `usage` is absent or all-zero (`normalizeClaudeTokenUsage`
   *  returns `undefined`) — avoids emitting ghost "0 / 200k (0%)" snapshots. */
  private emitTokenUsage(
    usage: RawClaudeUsage | undefined,
    model: string | undefined,
    reportedWindow: number | undefined,
    configured?: ClaudeContextWindowTag,
  ): void {
    if (!usage) return;
    const snapshot = normalizeClaudeTokenUsage(
      { ...usage, model: usage.model ?? model },
      {
        reported: reportedWindow,
        lastKnown: this.state.lastKnownContextWindow,
        configured,
      },
    );
    if (!snapshot) return;
    this.publishTokenUsageSnapshot(snapshot);
  }

  /** Emit a pre-built snapshot (used by path C's merge branch) and update
   *  the adapter's never-downgrade state. */
  private publishTokenUsageSnapshot(snapshot: ContextSnapshot): void {
    // Update never-downgrade state BEFORE emitting so the next resolve sees
    // the new ceiling. lastKnownContextWindow only grows.
    if (snapshot.maxTokens > this.state.lastKnownContextWindow) {
      this.state.lastKnownContextWindow = snapshot.maxTokens;
    }
    this.state.lastKnownTokenUsage = snapshot;
    this.ctx.emit({
      type: "token-usage.updated",
      sessionId: this.sessionId,
      snapshot,
    } satisfies ContextUsageEvent);
  }

/** Emit the turn-end context-usage snapshot. Awaits the `getContextUsage()`
   *  promise kicked off at the last `handleAssistant` (path B) for authoritative
   *  window occupancy; falls back to path C (accumulated result.usage merged
   *  with path A's last known window read) if path B never fired or rejected. */
  private async emitTurnEndSnapshot(
    accumulatedRaw: RawClaudeUsage,
    model: string | undefined,
    reportedWindow: number | undefined,
    lastKnown: ContextSnapshot | undefined,
  ): Promise<void> {
    // Path B: control channel. The most authoritative source for window
    // occupancy - the CLI reports the live context-window size directly. We
    // await the promise kicked off at handleAssistant time (before the
    // generator started tearing down).
    const pending = this.state.pendingContextUsage;
    this.state.pendingContextUsage = null; // one-shot
    if (pending) {
      try {
        const cc = await pending as Awaited<ReturnType<Query["getContextUsage"]>>;
        // Diagnostic: raw control-channel values vs the accumulated usage
        // (billing) and the last path-A occupancy. `cc.totalTokens` far below
        // `accInput` means the CLI's context tracker missed the conversation
        // (gateway models) — the ring then shows garbage occupancy.
        this.ctx.log.info(
          `context-usage pathB: cc=${JSON.stringify({
            totalTokens: cc.totalTokens,
            maxTokens: cc.maxTokens,
            percentage: cc.percentage,
            model: cc.model,
          })} accInput=${accumulatedRaw.inputTokens ?? 0} ` +
            `accProcessed=${totalProcessedTokensFromRawUsage(accumulatedRaw)} ` +
            `assistantMsgs=${this.state.assistantMessageCount} ` +
            `deltaUsage=${this.state.streamDeltaUsageCount} ` +
            `lastKnownUsed=${lastKnown?.usedTokens ?? "none"}`,
        );
        // Plausibility gate: on third-party gateways the CLI's control channel
        // often returns a grossly undercounted occupancy (observed ~0.2%-1.6%
        // of the real prompt; e.g. 1,814 vs 677,944 input tokens on multi-call
        // turns), which would render a ghost "0%" ring. Cross-check against the
        // accumulated result.usage — a totalTokens below 10% of the real input
        // is treated as untrusted and we fall through to path C (path-A merge).
        // Single-call turns report exactly (`totalTokens == accInput`), so the
        // gate never fires there. Post-compaction the occupancy may legitimately
        // shrink below 10% of the cumulative input, but path C's merge uses the
        // last known snapshot (post-compact value), so the result stays correct.
        const accInput = accumulatedRaw.inputTokens ?? 0;
        const plausible = accInput <= 0 || cc.totalTokens >= accInput * 0.1;
        if (plausible) {
          const accumulated = normalizeClaudeTokenUsage(
            accumulatedRaw,
            { reported: reportedWindow, lastKnown: this.state.lastKnownContextWindow },
          );
          if (accumulated) {
            const snapshot = buildSnapshotFromControlChannel(cc, accumulated);
            this.publishTokenUsageSnapshot(snapshot);
            return;
          }
        } else {
          this.ctx.log.warn(
            `context-usage pathB implausible: totalTokens=${cc.totalTokens} vs accInput=${accInput} ` +
              `(${((cc.totalTokens / accInput) * 100).toFixed(1)}%), falling back to path C`,
          );
        }
      } catch (err) {
        this.ctx.log.warn(
          `getContextUsage (await) failed, falling back to path C: ${(err as Error).message}`,
        );
      }
    }

    // Path C fallback: accumulated result.usage for throughput/billing,
    // merged with path A's last known window read for occupancy.
    if (!lastKnown) {
      // No path-A snapshot - emit accumulated directly as better-than-nothing.
      this.ctx.log.info(
        `context-usage pathC-direct: accInput=${accumulatedRaw.inputTokens ?? 0} ` +
          `accProcessed=${totalProcessedTokensFromRawUsage(accumulatedRaw)} ` +
          `assistantMsgs=${this.state.assistantMessageCount} ` +
          `deltaUsage=${this.state.streamDeltaUsageCount} (no path-A snapshot)`,
      );
      this.emitTokenUsage(accumulatedRaw, model, reportedWindow);
      return;
    }

    const accumulated = normalizeClaudeTokenUsage(
      accumulatedRaw,
      { reported: reportedWindow, lastKnown: this.state.lastKnownContextWindow },
    );
    if (accumulated) {
      const merged = mergeClaudeTokenUsageSnapshot(
        lastKnown,
        accumulated,
        accumulated.maxTokens,
      );
      this.ctx.log.info(
        `context-usage pathC-merge: lastKnownUsed=${lastKnown.usedTokens} ` +
          `accProcessed=${totalProcessedTokensFromRawUsage(accumulatedRaw)} ` +
          `assistantMsgs=${this.state.assistantMessageCount} ` +
          `deltaUsage=${this.state.streamDeltaUsageCount} ` +
          `final=${merged.usedTokens}/${merged.pct}%`,
      );
      this.publishTokenUsageSnapshot(merged);
    }
  }
}
