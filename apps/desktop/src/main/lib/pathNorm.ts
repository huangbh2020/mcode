/**
 * Canonical key for cross-surface path comparisons: git porcelain output vs
 * DB-stored values vs user input may differ in separators, trailing slashes
 * and casing (win32/darwin are case-insensitive). The porcelain-vs-DB miss
 * that once broke the merge dialog's preview matching was exactly a drift
 * between copies of this logic — main-process code must all come through
 * here (the renderer keeps its own twin, `lib/worktree.ts normWorktreeKey`,
 * because it cannot import main modules).
 */
export function normPathKey(p: string): string {
  const ci = process.platform === "win32" || process.platform === "darwin";
  const n = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return ci ? n.toLowerCase() : n;
}
