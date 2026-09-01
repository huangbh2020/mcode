/**
 * Worktree grouping helpers for the left bar.
 *
 * Sessions bound to the same isolated checkout must bucket under ONE group
 * node, so the raw `worktreePath` string can't be the group key — the same
 * directory can surface with different separators/casing (win32 is
 * case-insensitive, and git may echo either separator). Mirrors the
 * normalization the main process applies (repositories.ts `normKey`,
 * worktreeOps.ts, sessionStart.ts `applyWorktreeBind`).
 */
import { isMac, isWindows } from "./platform.js";

/** Canonical group/map key for a worktree path: backslashes → slashes,
 *  trailing separators trimmed, lowercased on case-insensitive filesystems. */
export function normWorktreeKey(p: string): string {
  const n = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return isWindows || isMac ? n.toLowerCase() : n;
}

/** Left-bar display name for a worktree directory: the user's custom name
 *  when one was set (keyed by normalized path), otherwise the directory
 *  basename itself — matching what exists on disk keeps an un-renamed group
 *  unambiguous. */
export function worktreeDisplayName(
  worktreePath: string,
  names: Record<string, string>,
): string {
  const custom = names[normWorktreeKey(worktreePath)];
  if (custom) return custom;
  const base = normWorktreeKey(worktreePath).split("/").pop();
  return base || worktreePath;
}
