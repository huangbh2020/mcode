/**
 * Pi SDK → RuntimeEvent normalization engine.
 *
 * The Pi SDK's `AgentSessionEvent` union (from @earendil-works/pi-coding-agent)
 * is structurally different from the Claude SDK's `SDKMessage`, but the target
 * contract is the same `RuntimeEvent` union — so the renderer / IPC /
 * persistence layers are provider-neutral and don't change.
 *
 * Pi event shape (v0.80.3):
 *   - `message_update` carries an `assistantMessageEvent` with a
 *     `type: "text_delta" | "thinking_delta" | ...` discriminator — we only
 *     forward the delta kinds the renderer renders.
 *   - `tool_execution_start/update/end` carry `toolName` + `toolCallId`.
 *   - `turn_end` signals a full turn completed (message + tool results).
 *   - `message_end` / `agent_end` bracket assistant messages.
 *
 * Turn lifecycle: the Pi SDK emits `agent_end` when the agent finishes
 * processing a prompt (and `turn_end` for each LLM+tool round). On a retryable
 * transient error (overloaded / rate-limit / 5xx) the SDK emits an
 * INTERMEDIATE `agent_end` with `willRetry: true`, then retries internally
 * (`auto_retry_start` → backoff → another iteration). We emit `turn.done`
 * only on the TERMINAL `agent_end` (`willRetry: false`) — emitting on the
 * intermediate event used to clear the loading spinner mid-retry and, when
 * every retry failed, end the turn with zero visible output. A terminal
 * `agent_end` whose final assistant message has `stopReason: "error"` is also
 * surfaced as a visible `error` block so the failure is never silent.
 */
import { randomUUID } from "node:crypto";
import type { RuntimeEvent, TurnDoneReason, ContextUsageEvent } from "@contracts/runtime";
import type { ProviderContext } from "@contracts/provider";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { FileSnapshot } from "@main/lib/fileSnapshot.js";

/**
 * Hook the provider installs so the adapter can ask for a token-usage snapshot
 * at the points where it makes sense to emit `token-usage.updated`:
 *   - at `agent_end` (turn end — the authoritative post-turn read), where the
 *     SDK's messages list is finalized and `getContextUsage()` reflects the
 *     just-completed turn.
 *
 * The adapter fires this callback BEFORE emitting `turn.done`, so the runtime
 * sees `token-usage.updated` → `turn.done` in order — the latter consumes the
 * snapshot to append the per-turn usage-history record. Returning `undefined`
 * (e.g. right after compaction, when the SDK reports null tokens) skips the
 * emit cleanly.
 */
export type PiTokenSnapshotProvider = () => ContextUsageEvent["snapshot"] | undefined;

export class PiMessageAdapter {
  /** Per-contentIndex message id — mirrors how Claude's SdkMessageAdapter maps
   *  content_block index → messageId. Pi's AssistantMessageEvent carries a
   *  `contentIndex` identifying which block a delta belongs to (thinking=0,
   *  text=1, tool=2, …). Assigning one messageId per block lets the renderer
   *  bucket each independently; turn-level grouping (turnMeta) then assembles
   *  them into a single turn in the view. This is what keeps each thinking /
   *  text segment as its own block instead of coalescing alternated
   *  thinking/text deltas into a single message (which produced the
   *  "thinking → text → thinking → text" multi-panel artifact). */
  private readonly blockMessageIds = new Map<number, string>();
  /** Tracks the most recently seen contentIndex so message_end can emit a
   *  message.complete with a valid id. */
  private lastMessageId: string | null = null;
  /** The messageId that tool_execution_start events should attach to. Pi's
   *  `message_update` stream carries the narration text (contentIndex 0/1)
   *  before the toolcall blocks (contentIndex 2+), and `tool_execution_start`
   *  fires AFTER message_end — detached from any messageId. Snapshotting the
   *  latest text/thinking messageId at `toolcall_start` lets the subsequent
   *  tool.use event carry the owning message, so the renderer keeps the
   *  "text → tool" timeline instead of piling every tool onto the turn opener. */
  private pendingToolTargetId: string | null = null;
  /** True once a terminal error has been surfaced for this turn. Guards
   *  against a duplicate error block when the final agent_end (message
   *  inspection) AND a subsequent auto_retry_end{success:false} both report
   *  the same exhausted-retry failure. Per-turn state (adapter is recreated
   *  each startTurn). */
  private errorSurfaced = false;
  /** <think>-tag splitter: current region kind. "text" outside a think tag,
   *  "thinking" inside one. See {@link emitSplitText}. */
  private thinkRegion: "text" | "thinking" = "text";
  /** <think>-tag splitter: tail of the previous delta held back because it
   *  may be a tag PREFIX cut mid-tag across delta boundaries (e.g. "<th" +
   *  "ink>"). Re-scanned when the next delta arrives. */
  private thinkHold = "";
  /** messageId for the think-block synthesized out of inline <think> regions.
   *  Distinct from the text block's id so the renderer buckets them as
   *  separate messages (the delta buffer keys text/thinking by messageId);
   *  re-set per assistant message at message_end. */
  private thinkMessageId: string | null = null;
  /** Set right after a closing </think>: swallow the single newline that
   *  models emit directly after it so the answer body doesn't start with a
   *  blank line. Survives across deltas (the \n often arrives in the next
   *  chunk). */
  private skipLfAfterThinkClose = false;
  /** contentIndex of the most recent text_delta — the fallback index used
   *  when flushing held-back text at message_end. */
  private lastTextContentIndex = 0;

  constructor(
    private readonly ctx: ProviderContext,
    private readonly sessionId: string,
    /** Provides a token-usage snapshot at turn end. See
     *  {@link PiTokenSnapshotProvider} — installed by PiAgentSdkProvider, which
     *  is the layer that owns the `session` (the adapter only sees events). */
    private readonly provideTokenSnapshot: PiTokenSnapshotProvider = () => undefined,
    /** Per-session file snapshot backing the "本轮修改" card + 撤销本轮 (rewind).
     *  Shared with the Claude provider via the snapshot registry — the
     *  extension's `tool_call` handler records pre-turn content (recordPre),
     *  and {@link flushFinal} freezes it into a `turn.files` event at turn end. */
    private readonly snapshots: FileSnapshot,
  ) {}

  /** Dispatch a single Pi agent-session event into RuntimeEvents. */
  dispatch(event: AgentSessionEvent): void {
    switch (event.type) {
      case "message_update":
        this.handleMessageUpdate(event);
        break;
      case "message_start":
        // Per-block ids are allocated lazily on each delta's contentIndex;
        // nothing to do at message boundaries.
        break;
      case "message_end":
        // Flush any held-back tail (an unterminated tag prefix that never
        // completed — emit it as plain content, don't drop it) before the
        // block ids are cleared.
        this.flushThinkHold();
        if (this.lastMessageId) {
          this.emit({ type: "message.complete", sessionId: this.sessionId, messageId: this.lastMessageId });
        }
        this.blockMessageIds.clear();
        // Reset the per-message <think> splitter state so the next assistant
        // message starts fresh in text mode with its own think messageId.
        this.thinkRegion = "text";
        this.thinkHold = "";
        this.thinkMessageId = null;
        this.skipLfAfterThinkClose = false;
        break;
      case "tool_execution_start":
        // Attach the tool to the message that narrated it (snapshot at
        // toolcall_start). Without this the store's open-turn heuristic would
        // append every tool to the turn's first message, flattening the
        // interleaved "text → tool → text → tool" timeline into one pile.
        this.emit({
          type: "tool.use",
          sessionId: this.sessionId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          input: event.args,
          requiresApproval: false, // Pi has no canUseTool interception; tools run directly
          ...(this.pendingToolTargetId ? { messageId: this.pendingToolTargetId } : {}),
        });
        break;
      case "tool_execution_end":
        this.emit({
          type: "tool.result",
          sessionId: this.sessionId,
          toolCallId: event.toolCallId,
          isError: event.isError,
          content: event.result,
        });
        break;
      case "agent_end":
        this.handleAgentEnd(event);
        break;
      case "auto_retry_start":
        // Informational: the model hit a retryable transient error
        // (overloaded / rate-limit / 5xx) and the SDK will retry after
        // backoff. The agent_end that preceded this carried willRetry:true
        // and was ignored by handleAgentEnd, so the loading spinner stays on
        // while the SDK backs off and retries. Logged so a long exponential
        // backoff isn't a silent hang in the main-process log.
        this.ctx.log.info(
          `pi: retrying after transient error (attempt ${event.attempt}/${event.maxAttempts} in ${event.delayMs}ms): ${event.errorMessage}`,
        );
        break;
      case "auto_retry_end":
        // A failed retry run. The terminal error is normally already surfaced
        // by handleAgentEnd (the final agent_end carries the error assistant
        // message). This is a backstop for the rare case where it wasn't —
        // e.g. the error message was stripped from agent state before the
        // final agent_end. errorSurfaced guards against a duplicate block.
        if (!event.success && !this.errorSurfaced && event.finalError) {
          this.errorSurfaced = true;
          this.emit({
            type: "error",
            sessionId: this.sessionId,
            message: `模型调用失败(重试已耗尽):${event.finalError}`,
            code: "PI_RETRY_EXHAUSTED",
          });
        }
        break;
      case "compaction_end": {
        // Pi's CompactionResult carries real token counts (tokensBefore /
        // estimatedTokensAfter) — surface them in the compact card instead of
        // the 0 placeholder. estimatedTokensAfter may be absent; the card
        // simply omits the "after" readout then.
        const result = event.result;
        const preTokens = result?.tokensBefore ?? 0;
        const postTokens = result?.estimatedTokensAfter;
        this.emit({
          type: "compact.result",
          sessionId: this.sessionId,
          trigger: event.reason === "manual" ? "manual" : "auto",
          preTokens,
          ...(typeof postTokens === "number" ? { postTokens } : {}),
        });
        // After a compaction the SDK's getContextUsage() reports null tokens
        // (no post-compact LLM usage yet) — so a fresh snapshot emit would be
        // a no-op. The next agent_end will publish the real post-compact
        // occupancy; until then the ring stays at its last value, which is
        // the intended UX (a compaction visibly just happened).
        break;
      }
      // turn_start / turn_end / agent_start / queue_update /
      // session_info_changed / thinking_level_changed — not surfaced to the
      // renderer. Forward-compatible: unknown types are silently ignored.
      default:
        break;
    }
  }

  /** Handle `agent_end` — the Pi analogue of the Claude result message.
   *
   *  agent_end fires once per agent.prompt/agent.continue iteration. When the
   *  model hits a retryable transient error (overloaded / rate-limit / 5xx),
   *  the SDK emits an INTERMEDIATE agent_end with `willRetry: true` and then
   *  retries internally (auto_retry_start → backoff → another iteration).
   *  Ending the turn on that intermediate event was the root cause of the
   *  "loading disappears, no output, task stops" symptom: the spinner was
   *  cleared while the SDK was still retrying, and because an error response
   *  carries only `errorMessage` (no TextContent), a turn where every retry
   *  failed ended with zero visible output and no error block.
   *
   *  Two fixes live here:
   *    1. Ignore intermediate agent_end events (willRetry:true) — the turn
   *       stays live until the terminal agent_end (willRetry:false), which
   *       fires after retries are exhausted OR the attempt succeeds.
   *    2. On the terminal event, inspect the final assistant message: if its
   *       stopReason is "error", surface a visible error block so the failure
   *       is never silent. Covers both the retries-disabled and the
   *       retries-exhausted paths (in both, the final agent_end carries the
   *       error assistant message — _prepareRetry only strips it when a retry
   *       actually follows).
   *
   *  The token-usage snapshot is emitted BEFORE turn.done so the runtime can
   *  append this turn's usage-history record (it reads lastContextSnapshot at
   *  turn.done). Skipping the emit when the snapshot is undefined (e.g. right
   *  after compaction) is fine — the runtime just won't have a usage record. */
  private handleAgentEnd(event: Extract<AgentSessionEvent, { type: "agent_end" }>): void {
    // willRetry:true = an intermediate event; the SDK is about to retry. Do
    // NOT end the turn — the loading spinner must stay on until the terminal
    // agent_end (willRetry:false) arrives.
    if (event.willRetry) return;

    const terminalError = this.terminalErrorFromMessages(event.messages);
    if (terminalError && !this.errorSurfaced) {
      this.errorSurfaced = true;
      this.emit({
        type: "error",
        sessionId: this.sessionId,
        message: terminalError,
        code: "PI_MODEL_ERROR",
      });
    }

    this.emitTurnEndSnapshot();
    this.emit({
      type: "turn.done",
      sessionId: this.sessionId,
      reason: this.pickDoneReason(),
    });
  }

  /** Extract the terminal model error (if any) from an agent_end's `messages`.
   *  Walks back from the end to the most recent assistant message; if its
   *  stopReason is "error", returns the errorMessage (or a generic notice when
   *  the provider didn't supply one, so the turn never ends truly blank). A
   *  non-error last assistant message yields undefined — the turn produced a
   *  real (possibly tool-bearing) result and needs no synthetic error.
   *
   *  Typed structurally (role/stopReason/errorMessage) because `AgentMessage`
   *  isn't exported from the SDK's root entry and is a broad union including
   *  custom message kinds; a structural read is the narrowest safe access. */
  private terminalErrorFromMessages(
    messages: readonly unknown[] | undefined,
  ): string | undefined {
    if (!messages || messages.length === 0) return undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i] as {
        role?: string;
        stopReason?: string;
        errorMessage?: string;
      };
      if (m.role === "assistant") {
        if (m.stopReason === "error") {
          return m.errorMessage && m.errorMessage.trim().length > 0
            ? m.errorMessage
            : "模型调用失败,未返回内容(可能是限流或服务暂时不可用)";
        }
        return undefined;
      }
    }
    return undefined;
  }

  private handleMessageUpdate(
    event: Extract<AgentSessionEvent, { type: "message_update" }>,
  ): void {
    const sub = event.assistantMessageEvent;
    if (!sub) return;
    if (sub.type === "text_delta") {
      // AskUserQuestion is now handled by the inline extension's native tool
      // (registered via pi.registerTool in mcodeExtension.ts) — the tool's
      // execute bridges to ctx.requestUserInput, so the question panel opens
      // deterministically. The model may still occasionally emit the
      // sentinel <<<ASK_USER_QUESTION>>> JSON form (the system prompt teaches
      // it as a fallback); a sentinel-text scan could be added here later as a
      // backstop, but the native tool is the primary path.
      this.lastTextContentIndex = sub.contentIndex;
      this.emitSplitText(sub.delta, sub.contentIndex);
    } else if (sub.type === "thinking_delta") {
      const messageId = this.ensureMessageId(sub.contentIndex);
      this.emit({
        type: "thinking",
        sessionId: this.sessionId,
        messageId,
        text: sub.delta,
      });
    } else if (sub.type === "toolcall_start") {
      // The narration for this tool has already streamed (text/thinking
      // deltas), so lastMessageId points at the message that should own the
      // tool. Snapshot it for the upcoming tool_execution_start — pi fires
      // that event after message_end, outside the messageId context. A tool
      // block never emits a delta of its own; it just records the target.
      this.pendingToolTargetId = this.lastMessageId;
    }
  }

  /** Route a text-delta chunk through the inline `<think>` splitter.
   *
   *  Reasoning models behind OpenAI-compatible endpoints (DeepSeek-R1, GLM,
   *  QwQ, … via vLLM / llama.cpp / gateway deployments) often inline their
   *  chain-of-thought in the `content` field wrapped in literal
   *  `<think>…</think>` tags instead of the separate `reasoning_content`
   *  field pi-ai recognizes. The SDK forwards those tags as ordinary
   *  `text_delta`s, so without this pass the raw tags render in the chat.
   *  The splitter converts each tagged region into a `thinking` event under
   *  a dedicated messageId (reusing the renderer's existing thinking panel)
   *  and emits the surrounding text as `text.delta`, dropping the tags
   *  themselves plus the newline models put right after the closing tag.
   *
   *  Deltas can split a tag anywhere ("<th" + "ink>…"), so text that might be
   *  a tag prefix is held back ({@link thinkHold}) until the next chunk
   *  resolves it; message_end flushes whatever is still held. */
  private emitSplitText(delta: string, contentIndex: number): void {
    const buf = this.thinkHold + delta;
    this.thinkHold = "";
    let pos = 0;
    while (pos < buf.length) {
      if (this.skipLfAfterThinkClose) {
        if (buf[pos] === "\n") pos++;
        this.skipLfAfterThinkClose = false;
        continue;
      }
      if (this.thinkRegion === "text") {
        const open = buf.indexOf("<think>", pos);
        const close = buf.indexOf("</think>", pos);
        if (open !== -1 && (close === -1 || open < close)) {
          this.emitTextSegment(buf.slice(pos, open), contentIndex);
          pos = open + "<think>".length;
          this.thinkRegion = "thinking";
        } else if (close !== -1) {
          // Stray closing tag with no opening one — strip it, stay in text.
          this.emitTextSegment(buf.slice(pos, close), contentIndex);
          pos = close + "</think>".length;
          this.skipLfAfterThinkClose = true;
        } else {
          const hold = this.tagPrefixHoldLen(buf, pos);
          this.emitTextSegment(buf.slice(pos, buf.length - hold), contentIndex);
          this.thinkHold = buf.slice(buf.length - hold);
          return;
        }
      } else {
        const close = buf.indexOf("</think>", pos);
        if (close !== -1) {
          this.emitTextSegment(buf.slice(pos, close), contentIndex);
          pos = close + "</think>".length;
          this.thinkRegion = "text";
          this.skipLfAfterThinkClose = true;
        } else {
          const hold = this.tagPrefixHoldLen(buf, pos);
          this.emitTextSegment(buf.slice(pos, buf.length - hold), contentIndex);
          this.thinkHold = buf.slice(buf.length - hold);
          return;
        }
      }
    }
  }

  /** Emit one splitter segment under the current region kind: text regions
   *  ride the contentIndex-keyed messageId (the plain pre-splitter behavior),
   *  think regions get a dedicated id so the renderer buckets them as their
   *  own thinking message. */
  private emitTextSegment(text: string, contentIndex: number): void {
    if (!text) return;
    if (this.thinkRegion === "thinking") {
      if (!this.thinkMessageId) this.thinkMessageId = randomUUID();
      this.lastMessageId = this.thinkMessageId;
      this.emit({ type: "thinking", sessionId: this.sessionId, messageId: this.thinkMessageId, text });
    } else {
      const messageId = this.ensureMessageId(contentIndex);
      this.emit({ type: "text.delta", sessionId: this.sessionId, messageId, text });
    }
  }

  /** Length of the buffer tail that must be held back because it could still
   *  grow into a tag on the next delta: the candidate starts at the last "<"
   *  and is only kept when it is a proper prefix of "<think>" or "</think>".
   *  Complete tags never reach here (the scan above consumes them first). */
  private tagPrefixHoldLen(buf: string, from: number): number {
    const lt = buf.lastIndexOf("<");
    if (lt < from) return 0;
    const tail = buf.slice(lt);
    if ("<think>".startsWith(tail) || "</think>".startsWith(tail)) {
      return tail.length;
    }
    return 0;
  }

  /** Emit any held-back tail at message end. An unterminated tag prefix
   *  ("<th" that never completed) is ordinary text — deliver it in the
   *  current region kind rather than dropping it. */
  private flushThinkHold(): void {
    if (!this.thinkHold) return;
    const held = this.thinkHold;
    this.thinkHold = "";
    this.emitTextSegment(held, this.lastTextContentIndex);
    this.skipLfAfterThinkClose = false;
  }

  /** Look up (or lazily allocate) the messageId for a given contentIndex. Each
   *  content block gets its own stable id — thinking(0) ≠ text(1) — matching
   *  Claude's per-block model. The map is cleared at message_end so the next
   *  pi-message reuses contentIndex 0/1 with fresh ids. */
  private ensureMessageId(contentIndex: number): string {
    let id = this.blockMessageIds.get(contentIndex);
    if (!id) {
      id = randomUUID();
      this.blockMessageIds.set(contentIndex, id);
    }
    this.lastMessageId = id;
    return id;
  }

  /** Pi doesn't report max_tokens / tool_use stop reasons distinctly in the
   *  events we surface; a completed agent run is treated as end_turn. */
  private pickDoneReason(): TurnDoneReason {
    return "end_turn";
  }

  /** End-of-turn finalization — the Pi analogue of Claude's flushFinal.
   *  Called by the provider once `session.prompt()` settles (on success,
   *  user abort, AND SDK error — an external failure doesn't undo the file
   *  writes that already landed, so the card must still surface them).
   *  Freezes the per-session file snapshot and emits `turn.files` so the
   *  renderer can show the "本轮修改" card with per-file tallies + a rewind
   *  button (adds/dels/before computed inside freeze()).
   *
   *  Async because freeze() reads each file's post-turn on-disk content.
   *  `turn.files` may arrive AFTER `turn.done` — `agent_end` already emitted
   *  it inside the subscribe stream — which is exactly the ordering the
   *  store's turn.files handler is written for (Claude's flushFinal emits the
   *  same way). */
  async flushFinal(): Promise<void> {
    const files = await this.snapshots.freeze();
    if (files.length > 0) {
      this.emit({
        type: "turn.files",
        sessionId: this.sessionId,
        files,
      });
    }
  }

  /** Ask the provider for a turn-end token snapshot and emit
   *  `token-usage.updated` when one is available. Called at `agent_end`, before
   *  `turn.done`. A no-op when the provider returns `undefined` (no snapshot
   *  yet — e.g. right after compaction), so a missing snapshot never blocks
   *  turn completion. */
  private emitTurnEndSnapshot(): void {
    let snapshot;
    try {
      snapshot = this.provideTokenSnapshot();
    } catch (err) {
      // The provider's session-reading callback should never throw into the
      // event stream, but a defensive guard keeps a stats-read failure from
      // also dropping turn.done.
      this.ctx.log.warn(
        `pi: token snapshot provider threw: ${(err as Error).message}`,
      );
      return;
    }
    if (!snapshot) return;
    this.emit({
      type: "token-usage.updated",
      sessionId: this.sessionId,
      snapshot,
    });
  }

  private emit(e: RuntimeEvent): void {
    this.ctx.emit(e);
  }
}
