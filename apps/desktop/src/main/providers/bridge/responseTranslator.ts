/**
 * Response translator: OpenAI streaming chunks → Anthropic SSE event stream.
 *
 * The Claude binary consumes Anthropic's streaming format (message_start →
 * content_block_start → content_block_delta ×N → content_block_stop →
 * message_delta → message_stop). OpenAI streams a flat sequence of
 * `data: {...}` chunks whose `choices[0].delta` carries either `content`
 * (text) or `tool_calls[]` (function-call fragments). This class is a state
 * machine that re-sequences OpenAI's flat stream into Anthropic's block-
 * structured events.
 *
 * ## State
 *
 * The binary assigns each content block a sequential `index`. We track:
 *   - whether `message_start` has been emitted (gated on first chunk),
 *   - the currently-open block's index and type (text | tool_use), so we
 *     can emit `content_block_stop` before opening the next one.
 *
 * `openBlockIndex` uses a NO_BLOCK sentinel rather than `undefined` so it
 * stays a plain `number` — which keeps the type narrowing tractable across
 * the many read/emit sites in `feed`.
 *
 * ## Why a class (not a pure function)
 *
 * OpenAI's tool_call arguments arrive in arbitrary fragments across many
 * chunks; Anthropic wraps each fragment as an `input_json_delta`. Translating
 * a single chunk therefore depends on what came before it, so the translator
 * must hold state between chunks. The class is driven chunk-by-chunk via
 * `feed()`, then finalized with `finish()` to close out the message.
 *
 * ## Tool-call index mapping
 *
 * OpenAI tags each tool_call fragment with its own `index` (0,1,2…). Anthropic
 * tags content blocks with a global `index` that also counts text blocks.
 * We maintain a map `oaiToolIndex → anthropicBlockIndex` so a tool_call that
 * spans many chunks always lands on the same Anthropic block index.
 */
import type {
  AnthropicSseEvent,
  AnthropicUsage,
  OpenAIChunk,
} from "./types.js";
import { ThinkTagSplitter, type ThinkSegment } from "./thinkTagSplitter.js";

/** Sentinel for "no block currently open" (avoids number|undefined juggling). */
const NO_BLOCK = -1;

/** Generate an id resembling Anthropic's `msg_...` format. The binary only
 *  needs an opaque unique id; it doesn't validate the prefix. */
function genMessageId(): string {
  return `msg_bridge_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export class OpenAiToAnthropicSse {
  private messageId = genMessageId();
  private model = "bridge";
  private started = false;
  /** The Anthropic block index currently open, or NO_BLOCK if none. */
  private openBlockIndex = NO_BLOCK;
  /** The type of the currently-open block, or undefined if none. */
  private openBlockKind: "text" | "tool_use" | "thinking" | undefined;
  /** Splits `<think>`-tagged reasoning out of the text stream. */
  private thinkSplitter = new ThinkTagSplitter();
  /** Next Anthropic block index to assign. */
  private nextIndex = 0;
  /** Map: OpenAI tool_call.index → Anthropic block index (for that tool_use). */
  private toolIndexMap = new Map<number, number>();
  /** finish_reason captured off the last choice-bearing chunk (OpenAI
   *  vocabulary; null when the stream carried none). It arrives on the FINAL
   *  choice chunk — the trailing usage-only chunk has `choices: []` — which is
   *  why it must be captured in feed() rather than read at finish() time.
   *  finish() maps it onto Anthropic's stop_reason. Previously it was dropped
   *  entirely and every message reported stop_reason "end_turn", even ones
   *  that ended in tool_use (where Anthropic mandates "tool_use"). */
  private capturedFinishReason: string | null = null;
  /** Accumulated usage from the final chunk (OpenAI emits it once, at the end). */
  private usage: AnthropicUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };

  /** Close the open block (if any) and push its `content_block_stop`. */
  private closeOpenBlock(events: AnthropicSseEvent[]): void {
    if (this.openBlockIndex !== NO_BLOCK) {
      events.push({ type: "content_block_stop", index: this.openBlockIndex });
      this.openBlockIndex = NO_BLOCK;
      this.openBlockKind = undefined;
    }
  }

  /** Open a new text block (closing the previous open block first). */
  private openTextBlock(events: AnthropicSseEvent[]): number {
    this.closeOpenBlock(events);
    const index = this.nextIndex++;
    this.openBlockIndex = index;
    this.openBlockKind = "text";
    events.push({
      type: "content_block_start",
      index,
      content_block: { type: "text", text: "" },
    });
    return index;
  }

  /** Open a new tool_use block (closing the previous open block first). */
  private openToolBlock(events: AnthropicSseEvent[], id: string, name: string): number {
    this.closeOpenBlock(events);
    const index = this.nextIndex++;
    this.openBlockIndex = index;
    this.openBlockKind = "tool_use";
    events.push({
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id, name, input: {} },
    });
    return index;
  }

  /** Open a new thinking block (closing the previous open block first).
   *  The signature is faked as empty: OpenAI-compatible upstreams expose no
   *  reasoning signature. That's safe here because the request translator
   *  strips thinking blocks from history, so the empty signature never
   *  round-trips to anything that would validate it. */
  private openThinkingBlock(events: AnthropicSseEvent[]): number {
    this.closeOpenBlock(events);
    const index = this.nextIndex++;
    this.openBlockIndex = index;
    this.openBlockKind = "thinking";
    events.push({
      type: "content_block_start",
      index,
      content_block: { type: "thinking", thinking: "", signature: "" },
    });
    return index;
  }

  /** Emit one text/thinking segment, reusing the open block when its kind
   *  matches and switching blocks (close + open) when it doesn't. */
  private emitTextLike(events: AnthropicSseEvent[], seg: ThinkSegment): void {
    if (seg.kind === "text") {
      const index =
        this.openBlockKind === "text" ? this.openBlockIndex : this.openTextBlock(events);
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text: seg.text },
      });
    } else {
      const index =
        this.openBlockKind === "thinking" ? this.openBlockIndex : this.openThinkingBlock(events);
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "thinking_delta", thinking: seg.text },
      });
    }
  }

  /** Process one OpenAI SSE chunk → zero or more Anthropic events. */
  feed(chunk: OpenAIChunk): AnthropicSseEvent[] {
    const events: AnthropicSseEvent[] = [];

    // Capture model/id off the first chunk for the message_start envelope.
    if (!this.started) {
      if (chunk.model) this.model = chunk.model;
      events.push({
        type: "message_start",
        message: {
          id: this.messageId,
          type: "message",
          role: "assistant",
          content: [],
          model: this.model,
          stop_reason: null,
          stop_sequence: null,
          // message_start usage is a placeholder; real totals arrive in
          // message_delta (Anthropic's own contract does the same).
          usage: { ...this.usage },
        },
      });
      this.started = true;
    }

    if (chunk.usage) {
      // OpenAI's prompt_tokens INCLUDES the cached portion; Anthropic's
      // input_tokens EXCLUDES it (cache tokens live in separate fields). The
      // cached count must be split out and subtracted, or downstream sums
      // like input + cacheRead double-count it. Math.max guards against
      // gateways reporting cached > prompt_tokens.
      const cached =
        chunk.usage.prompt_tokens_details?.cached_tokens ??
        chunk.usage.prompt_cache_hit_tokens ??
        0;
      this.usage = {
        input_tokens: Math.max(0, (chunk.usage.prompt_tokens ?? 0) - cached),
        output_tokens: chunk.usage.completion_tokens ?? 0,
        // No OpenAI equivalent: caching is automatic upstream and write
        // volume is never reported.
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: cached,
      };
    }

    const choices = chunk.choices;
    const choice = choices && choices.length > 0 ? choices[0] : undefined;
    const delta = choice?.delta;

    // Capture the terminal finish_reason. Truthy check: intermediate chunks
    // carry null; only the final choice-bearing chunk sets a real value.
    if (choice?.finish_reason) {
      this.capturedFinishReason = choice.finish_reason;
    }

    if (delta) {
      // Reasoning content (DeepSeek/o1-style dedicated field). Checked before
      // text: these models stream reasoning first, so block order matches the
      // model's actual output order when a chunk carries both.
      const reasoning = delta.reasoning ?? delta.reasoning_content;
      if (typeof reasoning === "string" && reasoning.length > 0) {
        this.emitTextLike(events, { kind: "thinking", text: reasoning });
      }

      // Text content. Routed through the think-tag splitter so
      // `<think>`-wrapped reasoning emitted inline (many OpenAI-compatible
      // reasoning models do this) becomes a thinking block instead of raw
      // tags in the chat. Plain streams pass through unchanged — the
      // splitter only holds back bytes that could still grow into a tag.
      const text = delta.content;
      if (typeof text === "string" && text.length > 0) {
        for (const seg of this.thinkSplitter.push(text)) {
          this.emitTextLike(events, seg);
        }
      }

      // Tool-call fragments. Each distinct OpenAI tool_call index maps to one
      // Anthropic tool_use block; id/name arrive on its first fragment, and
      // subsequent fragments carry only argument pieces.
      const toolCalls = delta.tool_calls;
      if (toolCalls && toolCalls.length > 0) {
        for (const tc of toolCalls) {
          let blockIdx = this.toolIndexMap.get(tc.index);
          if (blockIdx === undefined) {
            // First fragment for this tool call → open a new tool_use block.
            const id = tc.id ?? `toolu_bridge_${this.nextIndex}`;
            const name = tc.function?.name ?? "";
            blockIdx = this.openToolBlock(events, id, name);
            this.toolIndexMap.set(tc.index, blockIdx);
          }
          // Argument fragment → input_json_delta. OpenAI sends arguments as a
          // JSON string that may itself arrive in pieces; Anthropic's contract
          // is to forward each piece verbatim as `partial_json` (the SDK
          // concatenates them before JSON.parse).
          const argPiece = tc.function?.arguments;
          if (typeof argPiece === "string" && argPiece.length > 0) {
            events.push({
              type: "content_block_delta",
              index: blockIdx,
              delta: { type: "input_json_delta", partial_json: argPiece },
            });
          }
        }
      }

    }

    return events;
  }

  /** Close out the message after the stream ends. `stopReason` (explicit
   *  caller override) wins over the finish_reason captured from the stream;
   *  when neither arrived, mapStopReason's default ("end_turn") applies.
   *  Returns the tail events: stop the open block, then message_delta + stop. */
  finish(stopReason?: string | null): AnthropicSseEvent[] {
    const events: AnthropicSseEvent[] = [];
    if (!this.started) {
      // Degenerate stream with no chunks at all — still emit a valid envelope.
      events.push({
        type: "message_start",
        message: {
          id: this.messageId,
          type: "message",
          role: "assistant",
          content: [],
          model: this.model,
          stop_reason: null,
          stop_sequence: null,
          usage: { ...this.usage },
        },
      });
      this.started = true;
    }
    // Flush any bytes the splitter is still holding (stream ended exactly on
    // a partial tag like `<th`) BEFORE closing the open block, so a flushed
    // segment's block still gets its content_block_stop.
    for (const seg of this.thinkSplitter.flush()) {
      this.emitTextLike(events, seg);
    }
    this.closeOpenBlock(events);
    events.push({
      type: "message_delta",
      delta: {
        stop_reason: mapStopReason(stopReason ?? this.capturedFinishReason),
        stop_sequence: null,
      },
      usage: { ...this.usage },
    });
    events.push({ type: "message_stop" });
    return events;
  }

  /** Raw OpenAI finish_reason captured from the stream (null if none
   *  arrived). Read by the bridge server after finish() to detect the
   *  upstream-dropped-tools failure mode: finish_reason "tool_calls" with
   *  zero translated tool blocks. */
  get finishReason(): string | null {
    return this.capturedFinishReason;
  }

  /** Number of distinct tool_use blocks the stream produced. Paired with
   *  finishReason for the dropped-tools diagnostic above. */
  get toolBlockCount(): number {
    return this.toolIndexMap.size;
  }

  /** Reset for reuse (in case the same instance is recycled across turns).
   *  The bridge currently creates a fresh instance per request, so this is
   *  mainly for test ergonomics. */
  reset(): void {
    this.messageId = genMessageId();
    this.started = false;
    this.openBlockIndex = NO_BLOCK;
    this.openBlockKind = undefined;
    this.thinkSplitter = new ThinkTagSplitter();
    this.nextIndex = 0;
    this.toolIndexMap.clear();
    this.capturedFinishReason = null;
    this.usage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
  }
}

/** Map OpenAI's finish_reason onto Anthropic's stop_reason vocabulary. */
export function mapStopReason(openaiReason: string | null | undefined): string {
  switch (openaiReason) {
    case "stop":
      return "end_turn";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    default:
      // null (still going) or unknown values → end_turn is the safe default
      // for a terminated message.
      return "end_turn";
  }
}
