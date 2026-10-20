/**
 * Provider-neutral prompt alignment — the shared core of conversation-level
 * revision (2026-10-20). Every provider's revision needs to answer the same
 * question: which entry in the PROVIDER's history corresponds to this GUI
 * user row? The provider transcripts carry the full model prompt while the
 * GUI row stores display text, sessions can carry orphan rows on either side
 * (the pre-revision edit-resend left orphan provider entries; a failed
 * sendTurn can leave a GUI row with no provider entry), so the mapping is
 * recovered with a longest-common-subsequence over a text-prefix-compatibility
 * relation plus a timestamp floor. See lib/claudeTranscript.ts (CLI jsonl),
 * lib/piSessionRevise.ts (pi session files) and providers/codex-sdk (turn
 * items) for the three concrete candidate collectors built on this.
 */
import type { RevisionGuiPrompt } from "@contracts/provider";

/** Clock skew tolerance for `candidate.timestampMs >= gui.createdAt - skew`:
 *  both timestamps come from the same machine, but the GUI row is persisted
 *  by the renderer a beat after the user hits send while the provider entry
 *  is written after process spawn/handshake — a small floor absorbs ordering
 *  jitter. There is deliberately NO upper bound: queued prompts can sit
 *  behind a running turn for minutes before their sendTurn actually runs. */
export const ALIGN_SKEW_MS = 15_000;

/** One provider-side prompt candidate, already reduced to the alignment
 *  signals. `text` is the FULL model prompt (display text is its prefix). */
export interface PromptCandidate {
  /** Provider entry id — opaque to the aligner, returned to the caller. */
  key: string;
  /** Entry write time (ms). Null when the provider entry carries no usable
   *  timestamp — such candidates skip the floor check (text-only matching). */
  timestampMs: number | null;
  text: string;
}

function normalizeForCompare(s: string): string {
  return s.replace(/\r\n/g, "\n").trim();
}

/** Text-compatibility of a GUI row against a provider prompt. The GUI stores
 *  the display text while the provider carries the full model prompt (file
 *  tags and approved-plan payloads fold around the prose), so equality is
 *  tested as: the SHORTER normalized text is a prefix of the longer one.
 *  Both sides must be non-empty — an empty side matches nothing (image-only
 *  prompts are handled by positional fallbacks at the call sites). */
export function textPrefixCompatible(guiText: string, candidateText: string): boolean {
  const a = normalizeForCompare(guiText);
  const b = normalizeForCompare(candidateText);
  if (!a || !b) return false;
  const n = Math.min(a.length, b.length);
  return a.slice(0, n) === b.slice(0, n);
}

/**
 * Align GUI user rows to provider prompt candidates. Returns guiIndex →
 * candidate key. Rows the LCS could not place are simply absent — callers
 * decide whether a missing target is fatal or falls back to positional
 * matching.
 */
export function alignPromptSequences(
  gui: RevisionGuiPrompt[],
  candidates: PromptCandidate[],
): Map<number, string> {
  const n = gui.length;
  const m = candidates.length;

  // match[i][j]: gui[i] pairs with candidates[j] — text compatible AND the
  // candidate was written no earlier than the GUI row (minus skew).
  const match: boolean[][] = Array.from({ length: n }, () => new Array<boolean>(m).fill(false));
  for (let i = 0; i < n; i++) {
    const floor = gui[i].createdAt - ALIGN_SKEW_MS;
    for (let j = 0; j < m; j++) {
      const c = candidates[j];
      if (c.timestampMs != null && c.timestampMs < floor) continue;
      if (textPrefixCompatible(gui[i].text, c.text)) match[i][j] = true;
    }
  }

  // LCS length table over (gui, candidates).
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = match[i][j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out = new Map<number, string>();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (match[i][j]) {
      out.set(i, candidates[j].key);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return out;
}

/**
 * Positional fallback for targets the LCS could not place (image-only
 * prompts carry no text signal). Counts from the TAIL: if `guiIndex` is
 * k-th from the end of the GUI rows, use the k-th-from-the-end candidate.
 * Sound while the two sequences' tails are in sync — true for every session
 * revised only through this feature (each revision re-synchronizes both
 * sides); legacy sessions with pre-revision orphan tails can miss, so
 * callers log when this path fires. Returns the candidate key or null.
 */
export function positionalCandidate(
  guiCount: number,
  guiIndex: number,
  candidates: PromptCandidate[],
): string | null {
  const fromEnd = guiCount - 1 - guiIndex;
  if (fromEnd < 0 || fromEnd >= candidates.length) return null;
  return candidates[candidates.length - 1 - fromEnd]?.key ?? null;
}
