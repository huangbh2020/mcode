/**
 * Line-level diff using the LCS (longest common subsequence) table.
 *
 * Why LCS and not Myers: file-level Edit snippets from Claude are small
 * (typically < 200 lines) so the O(n*m) memory cost is trivial. LCS is
 * ~40 lines, dead-obvious to audit, and gives the standard "diff" output
 * users expect from a code-review tool: kept lines, removed lines
 * (red), added lines (green).
 *
 * Output: a flat list of `{op, text}` in old-then-new order, suitable
 * for rendering as a single column. `equal` lines have no prefix; the
 * caller decides the visual prefix (+/-/space).
 */

export type DiffOp = "equal" | "delete" | "insert";
export interface DiffLine {
  op: DiffOp;
  text: string;
}

/** Compute a line-level diff from `oldText` to `newText`. Empty lines
 *  are preserved (a blank line in the source is a real unit). */
export function lineDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const m = oldLines.length;
  const n = newLines.length;

  // Build the LCS length table. `lcs[i][j]` = LCS length of oldLines[0..i) and newLines[0..j).
  // Use a flat Int32Array to keep allocation predictable; we never index more
  // than m+1 rows of n+1 columns.
  const cols = n + 1;
  const lcs = new Int32Array((m + 1) * cols);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        lcs[i * cols + j] = lcs[(i - 1) * cols + (j - 1)] + 1;
      } else {
        const up = lcs[(i - 1) * cols + j];
        const left = lcs[i * cols + (j - 1)];
        lcs[i * cols + j] = up > left ? up : left;
      }
    }
  }

  // Backtrace from (m, n) to (0, 0), pushing ops in reverse. We then
  // reverse the whole list to get old-then-new order.
  const out: DiffLine[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (oldLines[i - 1] === newLines[j - 1]) {
      out.push({ op: "equal", text: oldLines[i - 1] });
      i--;
      j--;
    } else if (lcs[(i - 1) * cols + j] >= lcs[i * cols + (j - 1)]) {
      // Came from above → old line was deleted.
      out.push({ op: "delete", text: oldLines[i - 1] });
      i--;
    } else {
      // Came from the left → new line was inserted.
      out.push({ op: "insert", text: newLines[j - 1] });
      j--;
    }
  }
  while (i > 0) {
    out.push({ op: "delete", text: oldLines[i - 1] });
    i--;
  }
  while (j > 0) {
    out.push({ op: "insert", text: newLines[j - 1] });
    j--;
  }
  out.reverse();
  return out;
}

/** Tally inserts and deletes for a quick "+N -M" summary badge. */
export function diffSummary(diff: ReadonlyArray<DiffLine>): { adds: number; dels: number } {
  let adds = 0;
  let dels = 0;
  for (const d of diff) {
    if (d.op === "insert") adds++;
    else if (d.op === "delete") dels++;
  }
  return { adds, dels };
}

/** Parse a unified diff / patch string (e.g. Codex `fileChange.changes[].diff`)
 *  into the flat `DiffLine[]` consumed by `DiffView`. File headers (`---`/`+++`/
 *  `diff --git`/`index`) and hunk markers (`@@ ... @@`) are stripped so the
 *  output matches `lineDiff()`. */
export function parseUnifiedDiff(patch: string): DiffLine[] {
  const lines = splitLines(patch);
  const out: DiffLine[] = [];
  for (const line of lines) {
    if (
      line.startsWith("diff --git ") ||
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("@@ ") ||
      line === "\\ No newline at end of file"
    ) {
      continue;
    }
    if (line.startsWith("+")) {
      out.push({ op: "insert", text: line.slice(1) });
    } else if (line.startsWith("-")) {
      out.push({ op: "delete", text: line.slice(1) });
    } else if (line.startsWith(" ")) {
      out.push({ op: "equal", text: line.slice(1) });
    } else {
      out.push({ op: "equal", text: line });
    }
  }
  return out;
}

/** Split text on `\n` while preserving empty trailing lines (so a file
 *  ending with `\n` doesn't get a phantom empty last line, but a blank
 *  line in the middle of the file does show up as an empty string).
 *  Matches what most diff tools do: drop a single trailing empty that
 *  comes from the final newline. */
function splitLines(s: string): string[] {
  if (s === "") return [];
  const parts = s.split("\n");
  // If the text ends with `\n`, split produces a trailing "" — drop it
  // so an "old == new" file of just "\n" diffs to empty.
  if (parts.length > 0 && parts[parts.length - 1] === "" && s.endsWith("\n")) {
    parts.pop();
  }
  return parts;
}

/** Fast prefix/suffix-trimmed diff summary for large files: strips identical
 *  head/tail lines before running LCS, keeping only `contextLines` of context
 *  around changes. Also estimates visible collapsed line count. */
export function analyzeCompactDiff(
  original: string,
  modified: string,
  contextLines = 3,
): {
  diff: DiffLine[];
  adds: number;
  dels: number;
  visibleLines: number;
  hasCollapsibleContext: boolean;
} {
  const oldLines = splitLines(original);
  const newLines = splitLines(modified);
  let prefix = 0;
  const minLen = Math.min(oldLines.length, newLines.length);
  while (prefix < minLen && oldLines[prefix] === newLines[prefix]) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const midOld = oldLines.slice(prefix, oldLines.length - suffix);
  const midNew = newLines.slice(prefix, newLines.length - suffix);
  const midDiff: DiffLine[] =
    midOld.length * midNew.length <= 250_000
      ? lineDiff(midOld.join("\n"), midNew.join("\n"))
      : [
          ...midOld.map((text): DiffLine => ({ op: "delete", text })),
          ...midNew.map((text): DiffLine => ({ op: "insert", text })),
        ];

  const { adds, dels } = diffSummary(midDiff);

  const leadCtx = oldLines
    .slice(Math.max(0, prefix - contextLines), prefix)
    .map((text): DiffLine => ({ op: "equal", text }));
  const tailCtx = oldLines
    .slice(oldLines.length - suffix, Math.min(oldLines.length, oldLines.length - suffix + contextLines))
    .map((text): DiffLine => ({ op: "equal", text }));
  const diff = [...leadCtx, ...midDiff, ...tailCtx];

  let visibleLines = 0;
  let equalRun = 0;
  let hasInnerCollapse = false;
  for (const d of midDiff) {
    if (d.op === "equal") {
      equalRun++;
    } else {
      if (equalRun > 0) {
        if (equalRun > contextLines * 2 + 3) hasInnerCollapse = true;
        visibleLines += equalRun > contextLines * 2 + 1 ? contextLines * 2 + 1 : equalRun;
        equalRun = 0;
      }
      visibleLines++;
    }
  }
  if (equalRun > 0) {
    if (equalRun > contextLines * 2 + 3) hasInnerCollapse = true;
    visibleLines += equalRun > contextLines * 2 + 1 ? contextLines * 2 + 1 : equalRun;
  }
  visibleLines += leadCtx.length + tailCtx.length;
  const hasCollapsibleContext =
    prefix > contextLines + 3 || suffix > contextLines + 3 || hasInnerCollapse;

  return { diff, adds, dels, visibleLines, hasCollapsibleContext };
}
