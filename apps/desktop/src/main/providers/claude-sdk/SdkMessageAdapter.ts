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
  TurnIncompleteEvent,
  TurnFilesEvent,
  ErrorEvent,
  TodoUpdateEvent,
  AskUserQuestionEvent,
  ModeChangeEvent,
  PlanUpdateEvent,
  SubagentUpdateEvent,
  SubagentSnapshot,
  SubagentTranscriptBlock,
  SubagentTranscriptEvent,
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
  /** CLI-internal task kind. Verified against the bundled binary (2.1.x):
   *  `local_agent` = Task-tool subagent, `local_bash` = background/foreground
   *  bash command tracked as a task, `local_workflow` = script workflow,
   *  `remote_agent` = remote agent. The capsule is a *subagent* roster, so
   *  non-agent kinds are excluded (see NON_AGENT_TASK_TYPES). */
  task_type?: string;
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

/** Envelope for the SDK's `api_retry` system message — emitted when an API
 *  request fails with a retryable error (rate_limit / overloaded / server_error
 *  / connection timeout) and the SDK's built-in retry loop will retry after
 *  `retry_delay_ms`. The claude binary retries API errors internally; this
 *  message is the visibility signal. Full shape in sdk.d.ts SDKAPIRetryMessage;
 *  we forward only what we log. */
interface ApiRetryEnvelope {
  type: "system";
  subtype: "api_retry";
  attempt: number;
  max_retries: number;
  retry_delay_ms: number;
  error_status: number | null;
  error: string;
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

/** CLI task kinds that are NOT subagents and must not enter the capsule
 *  roster. `local_bash` covers every bash command the CLI tracks as a task
 *  (e.g. `sleep N` waits) — those used to pile up as forever-"running"
 *  "subagents" because the CLI never sends a closing task_updated for them
 *  mid-turn. `local_workflow` runs script workflows, not model subagents.
 *  Unknown / missing task_type stays visible (older CLIs don't send the
 *  field, and future agent-ish kinds shouldn't be hidden). */
const NON_AGENT_TASK_TYPES = new Set(["local_bash", "local_workflow"]);

/** How long the turn-end snapshot (emitTurnEndSnapshot) waits for the
 *  `getContextUsage()` control channel (path B) before falling back to
 *  path C. First-party CLI answers arrive in milliseconds; third-party
 *  gateways have been observed answering after 17-36s with garbage values
 *  (the plausibility gate discards them anyway) — waiting that long only
 *  stalls the snapshot publish. 3s cleanly separates the two. */
const CONTEXT_USAGE_PATH_B_TIMEOUT_MS = 3_000;

/** Grace period between the settle condition flipping and the stdin-hold
 *  release (see maybeSettle) — covers the CLI's session-state finalization
 *  lag after the last background-agent edge. */
const SETTLE_GRACE_MS = 1_500;

/** Trailing punctuation that never legitimately ends a COMPLETE final reply:
 *  (full/half-width) colon, comma, enumeration comma, semicolon. When the
 *  turn's LAST assistant message is text-only and ends on one of these, the
 *  model announced a continuation that never arrived — see the
 *  "unfinished-text" branch of maybeEmitTurnIncomplete. */
const UNFINISHED_TRAILING_RE = /[：:，,、；;]$/;

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
  /** Per-subagent live transcripts, keyed by the spawning Task tool_use id
   *  (== the `parent_tool_use_id` on forwarded subagent messages, ==
   *  SubagentSnapshot.toolUseId). Fed by handleSubagentAssistant/User when
   *  forwardSubagentText is on, flushed as replace-semantics
   *  `subagent.transcript` events. Per-turn lifetime like the rest of this
   *  state (the adapter is constructed per turn). */
  subagentTranscripts: Map<string, SubagentTranscriptBlock[]>;
  /** toolCallId → owning transcript key + the tool_use block awaiting its
   *  tool_result. Subagent tool_results arrive as separate forwarded user
   *  messages; this map routes the result back onto its block in place. */
  subagentPendingTools: Map<
    string,
    { parent: string; block: Extract<SubagentTranscriptBlock, { kind: "tool_use" }> }
  >;
  /** task_ids of non-agent tasks (bash commands, workflows) we deliberately
   *  keep OUT of the subagent roster. task_started tags them with task_type,
   *  but task_progress / task_updated don't carry it — without remembering
   *  the ids here, the progress handler's synthesis branch would re-add
   *  them to the roster. */
  ignoredTaskIds: Set<string>;
  /** Whether the model is currently in plan mode. Set true on EnterPlanMode,
   *  false on the matching ExitPlanMode or when a `mode.change` to default
   *  arrives (covers rejection / interruption). Drives `plan.update` emit. */
  inPlanMode: boolean;
  /** In-flight `Query.getContextUsage()` promise kicked off at the last
   *  `handleAssistant` (while the CLI process is still alive). Raced against
   *  CONTEXT_USAGE_PATH_B_TIMEOUT_MS at turn-end in `emitTurnEndSnapshot`
   *  (which itself runs OFF the turn's critical path) to read the
   *  authoritative context-window occupancy; on timeout or rejection (e.g.
   *  Query already closed) we fall back to path C. */
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
  /** Subtype of the LAST `result` message ("success" / "error_max_turns" …).
   *  Read by the turn-incomplete check in flushFinal: only success-ending
   *  turns qualify (error subtypes already surface via the error event). */
  lastResultSubtype: string | null;
  /** tool_use id → tool name, for every main-agent tool_use emitted this
   *  turn. Lets the turn-incomplete check report WHICH calls are dangling. */
  toolUseNames: Map<string, string>;
  /** tool_use ids that received a tool_result this turn. Diffed against
   *  emittedToolUse in flushFinal to detect dangling calls (the model was
   *  mid-tool-flow when the stream closed — third-party gateways returning
   *  an empty final completion). */
  resultedToolUseIds: Set<string>;
  /** True once any assistant text block arrived this turn. A success-ending
   *  turn with no text at all is the other half of the empty-response
   *  failure mode the turn-incomplete check covers. */
  textEmitted: boolean;
  /** Joined text blocks of the LAST main-agent assistant message this turn
   *  ("" when that message carried no text). With lastAssistantHadToolUse,
   *  feeds the "unfinished-text" half of the turn-incomplete check: a final
   *  narration ending in continuation punctuation means the announced next
   *  step never arrived (the gateway dropped the tool call after the text —
   *  observed 2026-09-02 on a deepseek OpenAI bridge that flattens every
   *  finish_reason to end_turn). Updated on every MAIN-AGENT assistant
   *  message (after the subagent-forward early return), so forwarded
   *  subagent blocks never pollute it. */
  lastAssistantText: string;
  /** True if the LAST main-agent assistant message contained a tool_use
   *  block. The unfinished-text check only fires when the turn's final
   *  message was text-only — closing on a tool dispatch makes trailing
   *  punctuation on earlier narration inconclusive (the dispatch itself may
   *  have been the promised next step). */
  lastAssistantHadToolUse: boolean;
  /** True once the turn used an interaction tool (EnterPlanMode /
   *  ExitPlanMode / AskUserQuestion). Those turns legitimately end without
   *  narration text — the "payload" lives in the tool input / approval flow —
   *  so the empty-response half of the turn-incomplete check must skip them. */
  interactionToolSeen: boolean;
  /** Level signal of live background tasks (SDK `background_tasks_changed`).
   *  The SDK documents it as the authoritative "is background work running"
   *  source — we track the task_ids here for observability / future use.
   *  (Previously fed a turn.done gate in maybeEmitTurnDone; that gate is gone
   *  — turn.done is now emitted solely by flushFinal() when the generator
   *  closes — but we keep consuming the level signal so the wiring is intact
   *  if we need an authoritative "still working" check later.) */
  backgroundTaskIds: Set<string>;
  /** True once any renderable assistant content (text / thinking / tool_use)
   *  has been emitted to the renderer this turn. Read by the provider's
   *  transport-retry wrapper: a retry is only safe while this is false — once
   *  content has streamed, recreating the query + adapter would orphan the
   *  partial output in the message stream. */
  contentStarted: boolean;
  /** True once the turn-settle gate fired (result seen AND no running
   *  subagents / background tasks). Guards maybeSettle's idempotence. See
   *  setSettleGate / the provider's buildPromptInput for the full story. */
  settled: boolean;
  /** Wall-clock ms of the last `result` message (0 = none yet). Settling
   *  requires a result NEWER than the last subagent/background-task edge —
   *  see lastAgentActivityAt. */
  lastResultAt: number;
  /** Wall-clock ms of the last subagent status / background-task edge
   *  (0 = none). An agent completing triggers the CLI's task-notification
   *  resume flow: it injects a synthetic user message and CONTINUES the
   *  main loop (more tools, more asks, possibly more agents). A result that
   *  predates the last agent edge is an INTERMEDIATE one — the turn is not
   *  over, so the stdin hold must stay (2026-08-26: releasing on the bare
   *  "result + agents idle" condition killed every ask in the resumed
   *  phase with "AbortError: Stream closed"). */
  lastAgentActivityAt: number;
}

/* ─── public export ────────────────────────────────────────────────── */

export class SdkMessageAdapter {
  private state: AdapterState;
  /** The provider's turn-settle release fn (unblocks the prompt iterable's
   *  stdin hold). Set via setSettleGate after construction. */
  private settleRelease: (() => void) | null = null;

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
    /** User-declared context-window tag ("1m" / "200k"), resolved from the
     *  active role's `supports1m` flag in the session's ApiConfig. Highest-
     *  precedence input to window resolution — overrides the model-name
     *  heuristic, so a 1M model still resolves to 1M even when the gateway
     *  strips the `[1m]` suffix from `message.model`. `undefined` (official
     *  Anthropic endpoint) lets the heuristic decide from the model name. */
    private configured?: ClaudeContextWindowTag,
    /** Whether to use the `getContextUsage()` control channel for turn-end
     *  window occupancy (path B). OFF for custom/gateway endpoints. The gate
     *  exists because kicking off `getContextUsage()` mid-turn leaves a
     *  `get_context_usage` request IN FLIGHT on the CLI's control channel; on
     *  third-party gateways that channel answers slowly, and although the
     *  snapshot emit is fire-and-forget, the query generator's teardown stays
     *  blocked behind the unanswered request until our
     *  CONTEXT_USAGE_PATH_B_TIMEOUT_MS race resolves — stalling turn.done
     *  (and the loading spinner) by that full 3s on every gateway turn. The
     *  value we'd get is discarded anyway: the plausibility gate rejects the
     *  garbage totals gateways report. Official Anthropic answers in
     *  milliseconds with trustworthy values, so path B stays enabled there. */
    private enableControlChannel = true,
  ) {
    this.state = {
      blockMessageIds: new Map(),
      emittedToolUse: new Set(),
      lastNarrationMessageId: null,
      tasks: [...initialTodos],
      textScanners: new Map(),
      lastKnownContextWindow: 0,
      subagents: new Map(),
      subagentTranscripts: new Map(),
      subagentPendingTools: new Map(),
      ignoredTaskIds: new Set(),
      inPlanMode: false,
      pendingContextUsage: null,
      assistantMessageCount: 0,
      streamDeltaUsageCount: 0,
      turnDoneEmitted: false,
      lastResultSubtype: null,
      toolUseNames: new Map(),
      resultedToolUseIds: new Set(),
      textEmitted: false,
      lastAssistantText: "",
      lastAssistantHadToolUse: false,
      interactionToolSeen: false,
      backgroundTaskIds: new Set(),
      contentStarted: false,
      settled: false,
      lastResultAt: 0,
      lastAgentActivityAt: 0,
    };
  }

  /** True once the turn has streamed any assistant content (text / thinking /
   *  tool_use) to the renderer. The provider's transport-retry wrapper reads
   *  this to decide whether a crashed attempt is safe to retry — retrying
   *  after content would duplicate / orphan the partial output. */
  hasEmittedContent(): boolean {
    return this.state.contentStarted;
  }

  /** Wire the turn-settle gate (see ClaudeAgentSdkProvider.buildPromptInput):
   *  `release` unblocks the prompt iterable's stdin hold so the CLI process
   *  can exit. Called once per adapter construction; safe to call before or
   *  after the settle condition is already met. */
  setSettleGate(release: () => void): void {
    this.settleRelease = release;
    this.maybeSettle();
  }

  /** Release the settle gate once the turn is settled: a result message has
   *  arrived AND no subagents / background tasks are still running. Rechecked
   *  on every result, subagent-status change, and background-task level
   *  signal, because the final result may precede the last agent's completion
   *  edge (or follow it). Idempotent. */
  private maybeSettle(): void {
    if (this.state.settled) return;
    // No result yet → the turn is still mid-flight (or streaming agent
    // output after an intermediate result) — keep holding.
    if (this.state.lastResultSubtype === null) return;
    // The result must POSTDATE the last agent edge. An agent completing
    // triggers the CLI's task-notification resume flow (synthetic user
    // message → the main loop continues), so a result older than the last
    // agent edge is intermediate — the turn still has resumed phases to run
    // and their permission asks need the stdin hold.
    if (this.state.lastResultAt < this.state.lastAgentActivityAt) return;
    for (const s of this.state.subagents.values()) {
      if (s.status === "running") return;
    }
    if (this.state.backgroundTaskIds.size > 0) return;
    this.state.settled = true;
    // Grace period: the CLI's session-state finalization (last agent
    // completion records) can lag the last edge we saw. Releasing stdin a
    // beat later keeps a fast follow-up turn from resuming mid-finalization
    // — the state that breaks the permission-ask channel (2026-08-26).
    const roster = Array.from(this.state.subagents.values());
    this.ctx.log.info(
      `claude turn settled: subtype=${this.state.lastResultSubtype} agents=${roster.length} bgTasks=${this.state.backgroundTaskIds.size} resultAt=+${this.state.lastResultAt} agentEdge=+${this.state.lastAgentActivityAt} — releasing stdin hold in ${SETTLE_GRACE_MS}ms`,
    );
    setTimeout(() => this.settleRelease?.(), SETTLE_GRACE_MS);
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
      } else if (subtype === "api_retry") {
        this.handleApiRetry(sys as unknown as ApiRetryEnvelope);
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
   * `finalReason` OVERRIDES the result-derived reason for the fallback
   * turn.done — the provider passes `"error"` when the generator threw, so a
   * stream that died mid-turn still closes with an error reason while the
   * files it already wrote surface on the turn-files card.
   *
   * Async because freeze() now reads each file's post-turn on-disk content
   * to compute the +N -M tallies and carry the pre-turn `before` payload. */
  async flushFinal(finalReason?: TurnDoneEvent["reason"]): Promise<void> {
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
    // Flag gateway-truncated turns BEFORE turn.done so the renderer can
    // replace its "回合完成" toast with an accurate "任务提前中断" warning.
    this.maybeEmitTurnIncomplete();
    // Turn end, exactly once. Three paths converge here:
    //  - a result arrived while subagents were still running → held back by
    //    maybeEmitTurnDone, now emitted with the final result's reason;
    //  - the stream ended without any result → safety-net "interrupted"
    //    (preserves the pre-existing fallback semantics);
    //  - a normal result already emitted turn.done → no-op (guard inside).
    // An explicit finalReason (the provider's thrown-error path) wins over
    // the result-derived reason: a stream that broke after an intermediate
    // result ended in an error, not in that result's stop_reason.
    if (!this.state.turnDoneEmitted) {
      this.emitTurnDone(finalReason ?? this.state.lastResultReason ?? "interrupted");
    }
  }

  /** Detect a "successfully"-ended turn whose stream shows the model never
   *  finished its work — the third-party-gateway failure where the model
   *  channel answers the last tool_result with an EMPTY completion and the
   *  CLI accepts it as a normal end-of-turn (observed 2026-08-20 on an
   *  OpenAI-protocol bridge: turn died right after a Read tool_use, result
   *  subtype=success, no final text, no error). Without this check the user
   *  just sees the work stop with a "turn complete" toast.
   *
   *  Conditions are deliberately narrow to avoid false positives:
   *  - last result subtype must be "success" (errors already surface);
   *  - the turn must not be user-interrupted (dangling tools are expected
   *    there);
   *  - Task launches are excluded — a backgrounded subagent legitimately
   *    outlives the parent stream, and its Task tool_use may never get an
   *    in-stream tool_result. */
  private maybeEmitTurnIncomplete(): void {
    if (this.state.lastResultSubtype !== "success") return;
    if (this.abortSignal?.aborted) return;

    const pending = [...this.state.emittedToolUse]
      .filter((id) => !this.state.resultedToolUseIds.has(id))
      .map((id) => ({ toolCallId: id, toolName: this.state.toolUseNames.get(id) ?? "" }))
      .filter((c) => c.toolName !== "Task");

    let kind: TurnIncompleteEvent["kind"] | null = null;
    if (pending.length > 0) {
      kind = "dangling-tools";
    } else if (
      !this.state.textEmitted &&
      this.state.emittedToolUse.size > 0 &&
      !this.state.interactionToolSeen
    ) {
      // Tools ran but the model never narrated anything — also a truncated
      // turn (a healthy turn always ends with the final text reply). Only
      // checked when tools ran: a completely empty turn (no content at all)
      // usually means the SDK is about to throw / has already surfaced an
      // error, and the error card covers it. Turns driven by interaction
      // tools (plan mode / AskUserQuestion) legitimately end text-less.
      kind = "empty-response";
    } else if (this.finalNarrationLooksCutOff()) {
      kind = "unfinished-text";
    }
    if (!kind) return;

    this.ctx.log.warn(
      `turn incomplete (gateway likely returned an empty final response): kind=${kind} pendingToolCalls=[${pending
        .map((c) => c.toolName)
        .join(", ")}]${
        kind === "unfinished-text"
          ? ` finalTextTail=${JSON.stringify(this.state.lastAssistantText.slice(-80))}`
          : ""
      }`,
    );
    this.ctx.emit({
      type: "turn.incomplete",
      sessionId: this.sessionId,
      kind,
      pendingToolCalls: kind === "dangling-tools" ? pending : [],
    } satisfies TurnIncompleteEvent);
  }

  /** Third truncation shape (observed 2026-09-02 on the deepseek
   *  OpenAI-protocol bridge): the model narrated its next step — "先读当前
   *  完整 `onSplitConfirm`:" — and the announced tool call never arrived;
   *  the bridge flattens every finish_reason to end_turn, so with no
   *  tool_use block to keep the loop alive the CLI closed the turn as
   *  success right after the text. A healthy final reply never ends with
   *  continuation punctuation (colon / comma / …) or an unclosed ``` fence.
   *
   *  Guards: the turn must have RUN tools (this gateway failure happens
   *  mid-work; pure-chat turns stay out of scope because a lone question to
   *  the user can legitimately end with a colon), and the final message must
   *  be text-only — a trailing tool dispatch (e.g. a backgrounded Task)
   *  makes punctuation on earlier narration inconclusive. */
  private finalNarrationLooksCutOff(): boolean {
    if (this.state.emittedToolUse.size === 0) return false;
    if (!this.state.textEmitted) return false;
    if (this.state.lastAssistantHadToolUse) return false;
    const text = this.state.lastAssistantText.trimEnd();
    if (text.length === 0) return false;
    if (UNFINISHED_TRAILING_RE.test(text)) return true;
    // Odd ``` count = a code fence opened but never closed.
    return (text.match(/```/g) ?? []).length % 2 === 1;
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
      configured: this.configured,
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
    // Non-agent tasks (bash commands / workflows) must not enter the
    // subagent capsule: they'd render as fake "subagents", and the CLI
    // doesn't emit a closing task_updated for them mid-turn, so they'd be
    // stuck on "running" until turn end. Remember the id so the follow-up
    // task_progress doesn't re-synthesize an entry either.
    if (NON_AGENT_TASK_TYPES.has(m.task_type ?? "")) {
      this.state.ignoredTaskIds.add(m.task_id);
      return;
    }
    this.state.ignoredTaskIds.delete(m.task_id);
    const snapshot: SubagentSnapshot = {
      taskId: m.task_id,
      toolUseId: m.tool_use_id,
      description: m.description ?? "",
      subagentType: m.subagent_type,
      status: "running",
      isBackgrounded: m.is_backgrounded ?? false,
    };
    this.state.subagents.set(m.task_id, snapshot);
    // Open the transcript bucket so forwarded subagent messages have a home
    // even if they somehow race ahead of this edge (defensive ordering).
    if (m.tool_use_id && !this.state.subagentTranscripts.has(m.tool_use_id)) {
      this.state.subagentTranscripts.set(m.tool_use_id, []);
    }
    this.flushSubagents();
  }

  private handleTaskProgress(m: TaskProgressEnvelope): void {
    if (this.state.ignoredTaskIds.has(m.task_id)) return; // non-agent task
    // CLI semantics (verified against the bundled 2.1.238 binary):
    // usage.total_tokens = latestInputTokens + cumulativeOutputTokens, where
    // latestInputTokens is OVERWRITTEN from each assistant message's API
    // usage. Third-party gateways omit usage on some responses (the CLI then
    // persists zeros), which resets latestInputTokens to 0 — the reported
    // total collapses to the accumulated output only (a few k, or ~0). The
    // true value is monotonic non-decreasing apart from in-subagent
    // microcompact, so a per-task max filters the collapse; 0 / missing is
    // "no data this event" and keeps the last good value.
    const tok = m.usage?.total_tokens;
    const cur = this.state.subagents.get(m.task_id);
    const nextTokens =
      typeof tok === "number" && tok > 0 ? Math.max(cur?.totalTokens ?? 0, tok) : cur?.totalTokens;
    if (!cur) {
      // Progress without a prior start — synthesize a minimal snapshot so
      // the roster stays consistent. Defensive: SDK normally pairs these.
      this.state.subagents.set(m.task_id, {
        taskId: m.task_id,
        toolUseId: m.tool_use_id,
        description: m.description ?? "",
        subagentType: m.subagent_type,
        status: "running",
        totalTokens: nextTokens,
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
        totalTokens: nextTokens,
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
    this.state.lastAgentActivityAt = Date.now();
    // The level signal may be the last edge we see when the final background
    // task completes after the result message — recheck the settle gate.
    this.maybeSettle();
  }

  /** `api_retry`: the SDK's built-in API-level retry loop kicked in after a
   *  retryable error (rate_limit / overloaded / server_error / connection
   *  timeout). The binary retries internally with the delay it reports here;
   *  we don't drive that loop — this is purely the visibility signal. Logged
   *  so a long backoff isn't a silent hang in the main-process log, and so
   *  triage can correlate a slow turn with upstream throttling.
   *
   *  The loading spinner already stays on (no turn.done is emitted while the
   *  SDK retries), so the user sees the turn as still active. When retries
   *  are exhausted the SDK emits `result{subtype:"error"}`, which handleResult
   *  surfaces as a visible error block. */
  private handleApiRetry(m: ApiRetryEnvelope): void {
    this.ctx.log.warn(
      `claude: API retry ${m.attempt}/${m.max_retries} after ${m.retry_delay_ms}ms ` +
        `(error=${m.error} status=${m.error_status ?? "n/a"})`,
    );
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
    // A status transition (running → completed/failed/killed) may be the last
    // edge before the settle condition flips — recheck on every roster flush.
    // It also marks agent activity: an agent completing kicks off the CLI's
    // task-notification resume flow, so any prior result is intermediate.
    this.state.lastAgentActivityAt = Date.now();
    this.maybeSettle();
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
    // First contamination guard for forwarded subagent streams
    // (forwardSubagentText): subagent deltas must NEVER enter the main
    // message flow — not even allocating blockMessageIds for them (a later
    // main-agent stream could reuse the index slot and get mislabeled). The
    // subagent's complete messages arrive separately as assistant/user
    // envelopes carrying parent_tool_use_id and are routed to the transcript
    // channel instead.
    if (m.parent_tool_use_id) return;
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

      // Any streamed text/thinking delta means assistant content has started
      // flowing — the provider's transport-retry wrapper must NOT retry after
      // this point (it would orphan the partial output).
      if ((delta.type === "text_delta" && delta.text) || (delta.type === "thinking_delta" && delta.thinking)) {
        this.state.contentStarted = true;
      }

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
    // is raced against a short timeout at turn-end (emitTurnEndSnapshot),
    // which itself runs off the turn's critical path (fire-and-forget from
    // handleResult — it must never delay turn.done). This is critical:
    // calling getContextUsage() only at result-time fails with "Query closed
    // before response received" because the generator is already tearing
    // down. We don't await here - just kick it off and let it resolve in the
    // background.
    if (this.enableControlChannel && this.query && !this.state.pendingContextUsage) {
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

    // Forwarded subagent message (forwardSubagentText). The usage path above
    // still ran — subagent occupancy deliberately counts toward the session
    // total (same as it did before the blocks were routed off the main
    // stream). Everything below belongs to the main agent only, so hand the
    // blocks to the transcript channel and stop here.
    if (m.parent_tool_use_id) {
      this.handleSubagentAssistant(m.parent_tool_use_id, blocks);
      return;
    }

    // Track the final-message shape for the "unfinished-text" half of the
    // turn-incomplete check. Computed off the raw content (what the model
    // actually sent), not off what we re-emit — deltas already rendered the
    // text; assistant messages only complete tool_use here.
    this.state.lastAssistantHadToolUse = blocks.some((b) => b.type === "tool_use");
    this.state.lastAssistantText = blocks
      .filter((b) => b.type === "text")
      .map((b) => (b as { text?: unknown }).text)
      .filter((t): t is string => typeof t === "string")
      .join("\n");

    for (const [idx, b] of blocks.entries()) {
      // Track the narration text so a subsequent tool_use block (which
      // claude's SDK sends as a SEPARATE assistant message — one content
      // block type per message, see docs/claude-stream-json.md §4) can
      // attach to the message that narrated it. blockMessageIds maps the
      // content-block index → messageId (assigned at content_block_start in
      // handleStreamEvent; text.delta uses the same map), so the index here
      // matches the stream's content index.
      if (b.type === "text" || b.type === "thinking") {
        const rawText = (b as { text?: unknown }).text;
        if (b.type === "text" && typeof rawText === "string" && rawText.trim().length > 0) {
          this.state.textEmitted = true;
        }
        const narrationId = this.state.blockMessageIds.get(idx);
        if (narrationId) this.state.lastNarrationMessageId = narrationId;
        continue;
      }
      if (b.type === "tool_use" && b.id && b.name) {
        // Subagent tool_use blocks never reach here — handleAssistant routes
        // parented messages to the transcript channel before the block loop.
        // The Task tool call itself (parentless) is the only visible trace of
        // the subagent in the main stream.
        if (this.state.emittedToolUse.has(b.id)) continue;
        this.state.emittedToolUse.add(b.id);
        this.state.toolUseNames.set(b.id, b.name);
        if (b.name === "EnterPlanMode" || b.name === "ExitPlanMode" || b.name === "AskUserQuestion") {
          this.state.interactionToolSeen = true;
        }
        // A tool_use block is renderable assistant content — once emitted, the
        // provider's transport-retry wrapper must not retry (would orphan it).
        this.state.contentStarted = true;

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
    // Forwarded subagent tool_results — route to the transcript channel (the
    // matching tool_use was routed there from handleAssistant too).
    if (m.parent_tool_use_id) {
      this.handleSubagentUser(m);
      return;
    }
    const blocks = (m.message as { content?: Array<{ type: string; tool_use_id?: string; is_error?: boolean; content?: unknown }> }).content;
    if (!blocks) return;

    for (const b of blocks) {
      if (b.type === "tool_result" && b.tool_use_id) {
        this.state.resultedToolUseIds.add(b.tool_use_id);
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

  /** Fold a forwarded subagent assistant message into its transcript:
   *  text/thinking/tool_use blocks append in order (tool_use starts as
   *  "running" and is registered for the later tool_result), then the whole
   *  transcript is emitted (replace semantics). Message-level granularity —
   *  the subagent viewer is a read-only "what is it doing" surface, char
   *  streaming would only multiply events. */
  private handleSubagentAssistant(
    parentToolUseId: string,
    blocks: Array<{ type: string; id?: string; name?: string; input?: unknown }>,
  ): void {
    let list = this.state.subagentTranscripts.get(parentToolUseId);
    if (!list) {
      list = [];
      this.state.subagentTranscripts.set(parentToolUseId, list);
    }
    for (const b of blocks) {
      if (b.type === "text" || b.type === "thinking") {
        const text = (b as { text?: unknown }).text;
        if (typeof text === "string" && text.trim().length > 0) {
          list.push({ kind: b.type, text });
        }
      } else if (b.type === "tool_use" && b.id && b.name) {
        const block: Extract<SubagentTranscriptBlock, { kind: "tool_use" }> = {
          kind: "tool_use",
          toolCallId: b.id,
          toolName: b.name,
          input: b.input,
          status: "running",
        };
        list.push(block);
        this.state.subagentPendingTools.set(b.id, { parent: parentToolUseId, block });
      }
    }
    this.flushSubagentTranscript(parentToolUseId);
  }

  /** Fold a forwarded subagent user message (tool_result blocks) onto the
   *  pending tool_use blocks of its transcript: fills result + flips status
   *  to done/error, then re-emits. Unknown ids are ignored (defensive —
   *  e.g. a result for a tool call whose message raced past turn teardown). */
  private handleSubagentUser(m: SDKUserMessage): void {
    const blocks = (m.message as { content?: Array<{ type: string; tool_use_id?: string; is_error?: boolean; content?: unknown }> }).content;
    if (!blocks) return;
    for (const b of blocks) {
      if (b.type !== "tool_result" || !b.tool_use_id) continue;
      const pending = this.state.subagentPendingTools.get(b.tool_use_id);
      if (!pending) continue;
      this.state.subagentPendingTools.delete(b.tool_use_id);
      pending.block.status = b.is_error ? "error" : "done";
      pending.block.result = b.content;
      this.flushSubagentTranscript(pending.parent);
    }
  }

  /** Emit one subagent's transcript as a replace-semantics event. Fresh
   *  array + shallow block copies — later in-place edits (tool_result
   *  backfill) must not alias what the renderer already stored. */
  private flushSubagentTranscript(parentToolUseId: string): void {
    const blocks = this.state.subagentTranscripts.get(parentToolUseId);
    if (!blocks) return;
    this.ctx.emit({
      type: "subagent.transcript",
      sessionId: this.sessionId,
      parentToolUseId,
      blocks: blocks.map((b) => ({ ...b })),
    } satisfies SubagentTranscriptEvent);
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
    this.state.lastResultSubtype = m.subtype;
    this.state.lastResultAt = Date.now();
    // A result arrived — the turn may now be settleable (if no subagents /
    // background tasks are still running, this releases the prompt hold and
    // the CLI process exits with complete session state).
    this.maybeSettle();

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
		      // The SDK reports the active model either as a top-level
		      // `result.model` (first-party endpoints) or — notably on third-party
		      // gateways / custom-model configs — ONLY as the key of the
		      // `modelUsage` map (e.g. "MiniMax-M3[1m]"). Reading `m.model` alone
		      // leaves those turns model-less, which surfaces as "未知模型" in the
		      // usage-stats panel even though the SDK did report the model.
		      const model =
		        (m as { model?: string }).model ?? Object.keys(modelUsage ?? {})[0];
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
	      //
	      // Fire-and-forget — the snapshot must NOT sit on the turn's
	      // critical path. Awaited here it stalled turn.done (which comes
	      // from flushFinal once the generator closes) for the full
	      // getContextUsage() latency, observed 17-36s on third-party
	      // gateways: the model had finished, but the UI kept spinning.
	      // turn.done now fires immediately; the context ring updates a
	      // moment later (≤ CONTEXT_USAGE_PATH_B_TIMEOUT_MS when path B is
	      // slow/unavailable).
	      void this.emitTurnEndSnapshot(accumulatedRaw, model, reportedWindow, lastKnown).catch((err) => {
	        this.ctx.log.warn(
	          `context-usage turn-end snapshot failed: ${(err as Error).message}`,
	        );
	      });

      // Permission denials
      for (const d of m.permission_denials ?? []) {
        if (!d.tool_use_id) continue;
        // The CLI usually streams the real (diagnostic) tool_result before
        // the final result envelope — e.g. ExitPlanMode's "Tool permission
        // request failed: AbortError: Stream closed" (SDK 0.3.238 / CLI
        // 2.1.238 control-stream regression, observed 2026-08-26). Don't
        // clobber it with the generic one-liner below; only synthesize when
        // no real result streamed for this tool_use.
        if (this.state.resultedToolUseIds.has(d.tool_use_id)) continue;
        this.ctx.emit({
          type: "tool.result",
          sessionId: this.sessionId,
          toolCallId: d.tool_use_id,
          isError: true,
          content: d.tool_name === "ExitPlanMode"
            ? "Plan approval prompt failed to reach the app (approval channel error). Reply in chat to approve the plan or request changes."
            : `Permission denied${d.tool_name ? ` (${d.tool_name})` : ""}`,
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
   *  contextWindow`; `configured` comes from the adapter's turn-level flag
   *  (resolved from the active role's `supports1m`). Both feed
   *  `resolveEffectiveContextWindow`, which also applies the never-downgrade
   *  rule via `state.lastKnownContextWindow`.
   *
   *  No-op when `usage` is absent or all-zero (`normalizeClaudeTokenUsage`
   *  returns `undefined`) — avoids emitting ghost "0 / 200k (0%)" snapshots. */
  private emitTokenUsage(
    usage: RawClaudeUsage | undefined,
    model: string | undefined,
    reportedWindow: number | undefined,
  ): void {
    if (!usage) return;
    const snapshot = normalizeClaudeTokenUsage(
      { ...usage, model: usage.model ?? model },
      {
        reported: reportedWindow,
        lastKnown: this.state.lastKnownContextWindow,
        configured: this.configured,
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

/** Emit the turn-end context-usage snapshot. Runs OFF the turn's critical
   *  path — handleResult fires it and returns immediately, so turn.done (from
   *  flushFinal) is never delayed. Races the `getContextUsage()` promise
   *  kicked off at the last `handleAssistant` (path B) against
   *  CONTEXT_USAGE_PATH_B_TIMEOUT_MS for authoritative window occupancy;
   *  falls back to path C (accumulated result.usage merged with path A's
   *  last known window read) if path B never fired, timed out, or rejected. */
  private async emitTurnEndSnapshot(
    accumulatedRaw: RawClaudeUsage,
    model: string | undefined,
    reportedWindow: number | undefined,
    lastKnown: ContextSnapshot | undefined,
  ): Promise<void> {
    // Path B: control channel. The most authoritative source for window
    // occupancy - the CLI reports the live context-window size directly. We
    // race the promise kicked off at handleAssistant time (before the
    // generator started tearing down) against a short timeout.
    const pending = this.state.pendingContextUsage;
    this.state.pendingContextUsage = null; // one-shot
    if (pending) {
      try {
        // Race the control channel against a short timeout. First-party CLI
        // answers arrive in milliseconds; third-party gateways have been
        // observed answering after 17-36s with garbage values (which the
        // plausibility gate below discards anyway). This snapshot already
        // runs off the turn's critical path, but a 36s-late publish could
        // land mid-next-turn and regress the ring — so on timeout we drop
        // the late answer and fall through to path C.
        void pending.catch(() => {}); // a late rejection must not surface as unhandled
        const cc = await Promise.race([
          pending,
          new Promise<null>((resolve) => {
            setTimeout(() => resolve(null), CONTEXT_USAGE_PATH_B_TIMEOUT_MS).unref();
          }),
        ]) as Awaited<ReturnType<Query["getContextUsage"]>> | null;
        if (!cc) {
          this.ctx.log.warn(
            `getContextUsage timed out after ${CONTEXT_USAGE_PATH_B_TIMEOUT_MS}ms, falling back to path C`,
          );
        } else {
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
              { reported: reportedWindow, lastKnown: this.state.lastKnownContextWindow, configured: this.configured },
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
      { reported: reportedWindow, lastKnown: this.state.lastKnownContextWindow, configured: this.configured },
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
