/**
 * Streaming splitter for `<think>...</think>` reasoning tags.
 *
 * Reasoning models served over OpenAI-compatible endpoints (DeepSeek R1,
 * QwQ, …) often inline their chain-of-thought inside `delta.content`,
 * wrapped in `<think>`/`</think>`, instead of (or in addition to) the
 * dedicated `reasoning`/`reasoning_content` field. Forwarded verbatim, the
 * raw tags land in the chat as literal text. This scanner re-splits the
 * stream so enclosed content is routed to a thinking block while
 * everything else stays text.
 *
 * ## Streaming safety
 *
 * A tag can straddle chunk boundaries (`<th` + `ink>`), so a per-chunk
 * indexOf would miss it. The scanner therefore holds back any trailing
 * bytes that could still grow into the active tag — i.e. a proper prefix
 * of `<think>`/`</think>`, at most 7 chars — until the next chunk
 * disambiguates. An ordinary `<` in prose or code flushes as soon as the
 * next byte breaks the prefix match, so latency impact is one chunk at
 * worst, and only for chunks ending exactly on a tag prefix.
 */

/** A run of content classified as either prose or reasoning. */
export type ThinkSegment =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string };

const OPEN_TAG = "<think>";
const CLOSE_TAG = "</think>";

/** Longest k < tag.length such that `s` ends with the first k chars of `tag`. */
function heldPrefixLength(s: string, tag: string): number {
  const max = Math.min(s.length, tag.length - 1);
  for (let k = max; k > 0; k--) {
    if (s.endsWith(tag.slice(0, k))) return k;
  }
  return 0;
}

export class ThinkTagSplitter {
  private mode: "text" | "thinking" = "text";
  /** Trailing bytes that may still grow into the active tag; flushed
   *  verbatim if the stream ends or the match fails. */
  private held = "";

  /** Classify one chunk of stream content into text/thinking segments. */
  push(text: string): ThinkSegment[] {
    const out: ThinkSegment[] = [];
    const emit = (s: string): void => {
      if (s.length > 0) out.push({ kind: this.mode, text: s });
    };

    const buf = this.held + text;
    this.held = "";
    let i = 0;
    while (i < buf.length) {
      const tag = this.mode === "text" ? OPEN_TAG : CLOSE_TAG;
      const lt = buf.indexOf("<", i);
      if (lt < 0) {
        // No tag start in what's left — but the tail could still be a
        // partial tag; hold it for the next chunk.
        const rest = buf.slice(i);
        const hold = heldPrefixLength(rest, tag);
        emit(rest.slice(0, rest.length - hold));
        this.held = hold > 0 ? rest.slice(rest.length - hold) : "";
        return out;
      }
      if (lt > i) emit(buf.slice(i, lt));
      if (buf.startsWith(tag, lt)) {
        // Complete tag — flip the mode and continue past it.
        this.mode = this.mode === "text" ? "thinking" : "text";
        i = lt + tag.length;
        continue;
      }
      const tail = buf.slice(lt);
      if (tag.startsWith(tail)) {
        // Partial tag at the chunk boundary — hold until more arrives.
        this.held = tail;
        return out;
      }
      // A `<` that can't start the active tag — literal text; rescan after it
      // (a run like `<<think>` still matches on the second `<`).
      emit("<");
      i = lt + 1;
    }
    return out;
  }

  /** Emit whatever is still held (the stream ended mid-potential-tag).
   *  An unterminated `<think>` keeps its content classified as thinking. */
  flush(): ThinkSegment[] {
    if (this.held.length === 0) return [];
    const seg: ThinkSegment = { kind: this.mode, text: this.held };
    this.held = "";
    return [seg];
  }
}
