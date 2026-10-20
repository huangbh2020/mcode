/**
 * Codex revision alignment helpers — the codex-sdk half of conversation-level
 * revision (2026-10-20). The revision itself is the app-server protocol's
 * NATIVE `thread/revert {threadId, beforeTurnId}` (verified live against
 * 0.162.0: revert survives an app-server restart; "beforeTurnId" = the id of
 * the FIRST turn to drop). These helpers map GUI user rows to turn ids via
 * each turn's `userMessage` item text (see lib/promptAlign.ts for the LCS
 * core); the protocol round-trip lives in CodexAgentSdkProvider.
 */
import {
  alignPromptSequences,
  positionalCandidate,
  type PromptCandidate,
} from "@main/lib/promptAlign.js";

/** Minimal turn shape from `thread/read {includeTurns: true}`. */
export interface CodexTurnLike {
  id: string;
  items?: Array<{ type?: string; content?: unknown }>;
}

function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  const parts: string[] = [];
  for (const p of content) {
    if (p && typeof p === "object" && (p as { type?: string }).type === "text") {
      const t = (p as { text?: unknown }).text;
      if (typeof t === "string") parts.push(t);
    }
  }
  return parts.join("\n");
}

/** Each Mcode turn contributes exactly one `userMessage` item whose content
 *  carries the full model prompt (folded pasted-content blocks included) —
 *  the GUI display text is its prefix, which is exactly what the aligner
 *  tests. Turns without a userMessage item (shouldn't happen on Mcode
 *  threads) yield empty text and never match. Codex carries no per-turn
 *  timestamp on the item — the aligner runs text-only for codex (timestampMs
 *  null skips the floor). */
export function codexTurnCandidates(turns: CodexTurnLike[]): PromptCandidate[] {
  return turns.map((t) => {
    const userItem = (t.items ?? []).find((it) => it.type === "userMessage");
    return {
      key: t.id,
      timestampMs: null,
      text: userItem ? textOfContent(userItem.content) : "",
    };
  });
}

/** Align GUI user rows to codex turns → guiIndex → turnId. */
export function alignCodexTurns(
  gui: { id: string; createdAt: number; text: string }[],
  turns: CodexTurnLike[],
): Map<number, string> {
  return alignPromptSequences(gui, codexTurnCandidates(turns));
}

/** Positional tail-count fallback (image-only prompts) → turnId or null. */
export function positionalCodexTurn(
  guiCount: number,
  guiIndex: number,
  turns: CodexTurnLike[],
): string | null {
  return positionalCandidate(guiCount, guiIndex, codexTurnCandidates(turns));
}
