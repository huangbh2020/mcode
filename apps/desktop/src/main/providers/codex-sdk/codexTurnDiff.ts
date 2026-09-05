/**
 * Codex per-turn unified-diff utilities.
 *
 * The app-server exposes file changes as a cumulative per-turn unified diff
 * (`turn/diff/updated`, cwd-relative paths, 0.152.0+) — AFTER the writes have
 * already landed. Unlike Claude/Pi there is no pre-write hook carrying file
 * contents, so to reconstruct the PRE-TURN content for the "本轮修改" card
 * and the rewind feature we reverse-apply the turn's diff against the
 * current on-disk content at freeze time.
 *
 * The reverse-apply is deliberately conservative: any hunk whose "+"/context
 * side fails to match the current content exactly (byte-for-byte, no fuzz)
 * fails the whole path's reconstruction and the caller falls back (skip the
 * rewind entry, keep the card honest). Codex generates these diffs from
 * exact file states, so a clean match is the expected case.
 */

/** One file's parsed section of a unified diff. */
export interface DiffFileSection {
  /** Path as written in the diff header (a/ b/ prefixes stripped; may be
   *  absolute for pre-0.152 servers). */
  path: string;
  /** True when the diff creates the file (`--- /dev/null`). */
  created: boolean;
  /** True when the diff deletes the file (`+++ /dev/null`). */
  deleted: boolean;
  /** Per-hunk old/new line arrays (context lines repeated in both). */
  hunks: Array<{ oldLines: string[]; newLines: string[] }>;
  /** Added / deleted line tallies (+ and − lines, context excluded). */
  adds: number;
  dels: number;
}

/** Parse a multi-file unified diff into per-file sections. Tolerates the
 *  git extended header (`diff --git a/x b/x`) and plain `---/+++` form.
 *  Binary sections (`Binary files ... differ`) yield empty hunks and are
 *  skipped by consumers. */
export function parseUnifiedDiff(diff: string): DiffFileSection[] {
  const lines = diff.split("\n");
  const sections: DiffFileSection[] = [];
  let cur: DiffFileSection | null = null;
  let hunk: { oldLines: string[]; newLines: string[] } | null = null;

  const stripPrefix = (p: string): string =>
    p === "/dev/null" ? p : p.replace(/^[ab]\//, "");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("diff --git ")) {
      cur = null; // header of the next section; ---/+++ lines finalize it
      hunk = null;
      continue;
    }
    if (line.startsWith("--- ")) {
      const raw = line.slice(4).split("\t")[0].trim();
      cur = {
        path: stripPrefix(raw),
        created: raw === "/dev/null",
        deleted: false,
        hunks: [],
        adds: 0,
        dels: 0,
      };
      continue;
    }
    if (line.startsWith("+++ ")) {
      const raw = line.slice(4).split("\t")[0].trim();
      if (!cur) {
        cur = { path: stripPrefix(raw), created: false, deleted: false, hunks: [], adds: 0, dels: 0 };
      }
      cur.deleted = raw === "/dev/null";
      if (cur.path !== "/dev/null") sections.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("@@")) {
      hunk = { oldLines: [], newLines: [] };
      cur.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith("+")) {
      hunk.newLines.push(line.slice(1));
      cur.adds++;
    } else if (line.startsWith("-")) {
      hunk.oldLines.push(line.slice(1));
      cur.dels++;
    } else if (line.startsWith(" ") || line === "") {
      // Context line (an entirely empty line in the diff body is context).
      const text = line.startsWith(" ") ? line.slice(1) : "";
      hunk.oldLines.push(text);
      hunk.newLines.push(text);
    }
    // "\" No newline at end of file" and stray headers are ignored.
  }
  return sections;
}

/**
 * Reverse-apply one file's diff section to the CURRENT (post-turn) content,
 * yielding the pre-turn content. Hunks are processed bottom-up so earlier
 * line numbers stay valid while later ones are replaced.
 *
 * Returns null on any mismatch — the caller must treat the reconstruction
 * as unavailable rather than guessing.
 */
export function reverseApplySection(
  current: string,
  section: DiffFileSection,
): string | null {
  // Whole-file creation: pre-turn content is empty.
  if (section.created) return "";
  // Whole-file deletion: the diff carries the entire original content as
  // "-" and context lines.
  if (section.deleted) {
    return section.hunks.map((h) => [...h.oldLines].join("\n")).join("\n") + (section.hunks.length ? "\n" : "");
  }
  if (section.hunks.length === 0) return null;

  const lines = current === "" ? [] : current.split("\n");
  // Trailing "" from a final newline is a real element of split("\n") — keep
  // it: hunk line numbers are 1-based over that same representation.
  for (let h = section.hunks.length - 1; h >= 0; h--) {
    const { oldLines, newLines } = section.hunks[h];
    // Find the new-side segment in the current content. We don't have
    // reliable hunk header parsing for edited-with-context edge cases, so
    // scan: try the header-declared start first, then a full search.
    const idx = locateSegment(lines, newLines);
    if (idx === null) return null;
    lines.splice(idx, newLines.length, ...oldLines);
  }
  return lines.join("\n");
}

/** Locate `segment` within `lines` (exact element-wise match). Returns the
 *  start index or null. Empty segments match nowhere. */
function locateSegment(lines: string[], segment: string[]): number | null {
  if (segment.length === 0) return null;
  outer: for (let i = 0; i + segment.length <= lines.length; i++) {
    for (let j = 0; j < segment.length; j++) {
      if (lines[i + j] !== segment[j]) continue outer;
    }
    return i;
  }
  return null;
}
