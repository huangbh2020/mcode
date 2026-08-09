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
 * processing a prompt (and `turn_end` for each LLM+tool round). We emit
 * `turn.done` on `agent_end` — the closest analogue to the Claude result
 * message's end-of-turn signal.
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
        if (this.lastMessageId) {
          this.emit({ type: "message.complete", sessionId: this.sessionId, messageId: this.lastMessageId });
        }
        this.blockMessageIds.clear();
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
        // End of the agent's processing run — the Pi analogue of the Claude
        // result message. Emit the token-usage snapshot BEFORE turn.done so
        // the runtime can append this turn's usage-history record (it reads
        // lastContextSnapshot at turn.done). Skipping the emit when the
        // snapshot is undefined (e.g. right after compaction) is fine — the
        // runtime just won't have a usage record for this turn.
        this.emitTurnEndSnapshot();
        this.emit({
          type: "turn.done",
          sessionId: this.sessionId,
          reason: this.pickDoneReason(),
        });
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
      // turn_start / turn_end / agent_start / queue_update / auto_retry_* /
      // session_info_changed / thinking_level_changed — not surfaced to the
      // renderer. Forward-compatible: unknown types are silently ignored.
      default:
        break;
    }
  }

  private handleMessageUpdate(
    event: Extract<AgentSessionEvent, { type: "message_update" }>,
  ): void {
    const sub = event.assistantMessageEvent;
    if (!sub) return;
    if (sub.type === "text_delta") {
      const messageId = this.ensureMessageId(sub.contentIndex);
      // AskUserQuestion is now handled by the inline extension's native tool
      // (registered via pi.registerTool in mcodeExtension.ts) — the tool's
      // execute bridges to ctx.requestUserInput, so the question panel opens
      // deterministically. The model may still occasionally emit the
      // sentinel <<<ASK_USER_QUESTION>>> JSON form (the system prompt teaches
      // it as a fallback); a sentinel-text scan could be added here later as
      // a backstop, but the native tool is the primary path.
      this.emit({
        type: "text.delta",
        sessionId: this.sessionId,
        messageId,
        text: sub.delta,
      });
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
   *  Called by the provider once `session.prompt()` settles (on success AND
   *  on user abort; skipped on SDK error, matching Claude's error path).
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
