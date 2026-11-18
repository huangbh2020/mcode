/**
 * OpenCode revision alignment helpers — the opencode-sdk half of
 * conversation-level revision (2026-11-18). The revision itself is the v2
 * server's NATIVE staged revert (POST /api/session/{id}/revert/stage →
 * /revert/commit; DELETE …/revert aborts a staging): the projector hard-deletes
 * every message with seq >= the boundary's seq ON COMMIT — boundary message
 * INCLUDED — so the boundary is the TARGET message itself ("drop it and
 * everything after"). These helpers map GUI user rows to opencode message ids
 * via each projected user message's `text` (see lib/promptAlign.ts for the
 * LCS core); the HTTP round-trip lives in OpencodeProvider.
 */
import {
  alignPromptSequences,
  positionalCandidate,
  type PromptCandidate,
} from "@main/lib/promptAlign.js";

/** Minimal shape of one projected session message (GET
 *  /api/session/{id}/message items — SessionMessageUser et al). Kept loose:
 *  the wire type lags the installed CLI (SDK 1.19.3 vs CLI 2.x). */
export interface OpencodeMessageLike {
  id: string;
  type: string;
  text?: string;
  time?: { created?: number };
}

/** Only user messages are prompt candidates — assistant/shell/synthetic/
 *  model-switched/compaction rows never correspond to a GUI user row. Each
 *  Mcode turn posts exactly one user message whose `text` carries the full
 *  model prompt (the GUI display text is its prefix, which is exactly what
 *  the aligner tests). `time.created` feeds the aligner's timestamp floor. */
export function opencodeUserCandidates(messages: OpencodeMessageLike[]): PromptCandidate[] {
  return messages
    .filter((m) => m.type === "user")
    .map((m) => ({
      key: m.id,
      timestampMs: typeof m.time?.created === "number" ? m.time.created : null,
      text: typeof m.text === "string" ? m.text : "",
    }));
}

/** Align GUI user rows to opencode user messages → guiIndex → messageId. */
export function alignOpencodeMessages(
  gui: { id: string; createdAt: number; text: string }[],
  messages: OpencodeMessageLike[],
): Map<number, string> {
  return alignPromptSequences(gui, opencodeUserCandidates(messages));
}

/** Positional tail-count fallback (image-only prompts) → messageId or null. */
export function positionalOpencodeMessage(
  guiCount: number,
  guiIndex: number,
  messages: OpencodeMessageLike[],
): string | null {
  return positionalCandidate(guiCount, guiIndex, opencodeUserCandidates(messages));
}
