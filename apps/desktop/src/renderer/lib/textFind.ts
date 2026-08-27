/**
 * Text-anchored locate helpers for bookmark jumps.
 *
 * A bookmark stores the whitespace-collapsed excerpt of what the user had
 * selected. At jump time the message is fully rendered, so the selection's
 * original text lives in the row's DOM — split across however many text
 * nodes markdown produced (p / code / emphasis / list bullets…), with
 * whitespace that the excerpt collapsed. These helpers re-find that exact
 * span and paint it, without mutating React-managed DOM:
 *
 *  - {@link findNormalizedTextRange} matches with `\s+`→" " normalization
 *    across node boundaries and returns a DOM Range over the match.
 *  - {@link highlightRange} paints a Range via the CSS Custom Highlight API
 *    (Chromium ≥105, our baseline) — no wrapper elements, nothing for React
 *    to clobber on re-render.
 */

/** Collapse whitespace runs to single spaces — mirrors how the bookmark
 *  excerpt was built from `selection.toString()` at add time. */
function normalize(s: string): string {
  return s.replace(/\s+/g, " ");
}

/** One text node and where its content starts inside the concatenated
 *  full text of the search root. */
interface TextNodeSpan {
  node: Text;
  start: number;
}

/** Find `needle` in `root`'s text, matching across element boundaries with
 *  whitespace-run normalization, and return a Range spanning the match.
 *  Returns null when the needle isn't present (e.g. the selection spanned
 *  two messages, or the text changed since the bookmark was added). */
export function findNormalizedTextRange(root: Element, needle: string): Range | null {
  const wanted = normalize(needle).trim();
  if (wanted.length < 4) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const spans: TextNodeSpan[] = [];
  let full = "";
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n as Text;
    if (!text.data) continue;
    spans.push({ node: text, start: full.length });
    full += text.data;
  }
  if (spans.length === 0) return null;

  // Normalized text plus a norm-index → original-index map. A collapsed
  // whitespace run maps to its FIRST original character, so positions land
  // on real char boundaries on both sides of a match.
  let norm = "";
  const map: number[] = [];
  let pendingWs = -1;
  for (let i = 0; i < full.length; i++) {
    if (/\s/.test(full[i])) {
      if (pendingWs < 0) pendingWs = i;
      continue;
    }
    if (pendingWs >= 0 && norm.length > 0) {
      norm += " ";
      map.push(pendingWs);
      pendingWs = -1;
    }
    norm += full[i];
    map.push(i);
  }

  const at = norm.indexOf(wanted);
  if (at < 0) return null;
  const origStart = map[at];
  // Exclusive end = one past the last matched original char.
  const origEnd = map[at + wanted.length - 1] + 1;

  // Locate the nodes containing the start and the last matched char.
  let startSpan = spans[0];
  let endSpan = spans[0];
  for (const span of spans) {
    if (span.start <= origStart) startSpan = span;
    if (span.start <= origEnd - 1) endSpan = span;
  }
  if (origStart - startSpan.start > startSpan.node.length) return null;

  const range = document.createRange();
  range.setStart(startSpan.node, origStart - startSpan.start);
  range.setEnd(endSpan.node, Math.min(origEnd - endSpan.start, endSpan.node.length));
  return range;
}

/** Registry name for the transient jump-target highlight. */
const HIGHLIGHT_NAME = "bookmark-target";

/** Paint `range` via the CSS Custom Highlight API for `durationMs`. Returns
 *  false when the API isn't available (caller falls back to row-level
 *  flash). Re-jumping replaces the previous highlight; the clear timer only
 *  deletes the highlight it registered. */
export function highlightRange(range: Range, durationMs: number): boolean {
  if (typeof Highlight === "undefined" || typeof CSS === "undefined" || !CSS.highlights) {
    return false;
  }
  const hl = new Highlight(range);
  CSS.highlights.set(HIGHLIGHT_NAME, hl);
  window.setTimeout(() => {
    if (CSS.highlights.get(HIGHLIGHT_NAME) === hl) CSS.highlights.delete(HIGHLIGHT_NAME);
  }, durationMs);
  return true;
}
