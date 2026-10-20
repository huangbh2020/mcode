/**
 * Pi session revision — the pi-sdk half of conversation-level revision
 * (2026-10-20). Pure planning helpers; the SDK calls live in
 * PiAgentSdkProvider.reviseConversation.
 *
 * Pi sessions are APPEND-ONLY TREES: every entry has id/parentId, the "leaf"
 * pointer tracks the conversation head, and `SessionManager.open()` resolves
 * the leaf as the file's LAST entry. The SDK's own revision primitive is
 * therefore not a file rewrite but a BRANCH:
 *
 *   branchWithSummary(branchPointId, "") — appends a `branch_summary` entry
 *   parented at the branch point (persisting the leaf move; a bare branch()
 *   only flips in-memory state and would be lost on the next open), with an
 *   EMPTY summary contributing zero context messages (sessionEntryToContext
 *   returns [] for falsy summaries) — verified live against a real 11-turn
 *   session: post-branch reopen excludes the target and everything after it,
 *   the next user append lands on the new branch, and the file only GROWS.
 *
 * The branch point is the target entry's predecessor ON THE CURRENT LEAF
 * PATH (raw parentId can point into an abandoned branch on hand-branched
 * files), so planning takes the context path, not the flat entry list.
 */
import {
  alignPromptSequences,
  positionalCandidate,
  type PromptCandidate,
} from "@main/lib/promptAlign.js";

/** Minimal shape of a pi session entry the planner reads (unknown entry
 *  kinds — labels, usage, custom — simply never match the filters). */
export interface PiEntryLike {
  id: string;
  parentId?: string | null;
  timestamp?: string;
  type?: string;
  message?: { role?: string; content?: unknown };
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const p of content) {
      if (p && typeof p === "object" && (p as { type?: string }).type === "text") {
        const t = (p as { text?: unknown }).text;
        if (typeof t === "string") parts.push(t);
      }
    }
    return parts.join("\n");
  }
  return "";
}

/** Real user-prompt entries as alignment candidates. toolResult/bash/Ask-
 * Question-reply message entries have different roles or text shapes and
 * simply never text-match a GUI prompt row (the LCS skips them). */
export function piPromptCandidates(entries: PiEntryLike[]): PromptCandidate[] {
  const out: PromptCandidate[] = [];
  for (const e of entries) {
    if (e.type !== "message" || !e.id) continue;
    if (e.message?.role !== "user") continue;
    const ts = e.timestamp ? Date.parse(e.timestamp) : NaN;
    out.push({
      key: e.id,
      timestampMs: Number.isNaN(ts) ? null : ts,
      text: textOfContent(e.message.content),
    });
  }
  return out;
}

/** Align GUI user rows to pi user entries (see lib/promptAlign.ts). Returns
 *  guiIndex → pi entry id. */
export function alignPiPrompts(
  gui: { id: string; createdAt: number; text: string }[],
  entries: PiEntryLike[],
): Map<number, string> {
  return alignPromptSequences(gui, piPromptCandidates(entries));
}

/** Positional tail-count fallback (image-only prompts) → pi entry id or null. */
export function positionalPiPrompt(
  guiCount: number,
  guiIndex: number,
  entries: PiEntryLike[],
): string | null {
  return positionalCandidate(guiCount, guiIndex, piPromptCandidates(entries));
}

/**
 * Resolve the branch point for retracting the target entry: the target's
 * predecessor ON THE LEAF PATH. Returns the predecessor's entry id, or null
 * when the target is the path's FIRST entry — branch to "before everything"
 * (SessionManager.branchWithSummary accepts null there, and resetLeaf()
 * documents exactly this "re-edit the first user message" case).
 * Throws when the target isn't on the path at all. */
export function piBranchPoint(
  leafPath: PiEntryLike[],
  targetEntryId: string,
): string | null {
  const idx = leafPath.findIndex((e) => e.id === targetEntryId);
  if (idx < 0) {
    throw new Error("target entry not on the session's active path");
  }
  if (idx === 0) return null;
  const prev = leafPath[idx - 1];
  if (!prev?.id) {
    throw new Error("branch predecessor has no id");
  }
  return prev.id;
}
