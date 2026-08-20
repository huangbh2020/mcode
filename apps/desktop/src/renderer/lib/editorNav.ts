/**
 * Editor navigation-history support — the last-known cursor per file.
 *
 * The back/forward stacks themselves live in `sessionStore`
 * (`navBackByProject` / `navForwardByProject`, per project). To snapshot the
 * OUTGOING location when the user navigates away, the store needs the current
 * file's cursor — but that cursor moves constantly, and writing it into
 * zustand on every selection change would re-run every store selector on each
 * keystroke/click. So the cursor lives here as a plain module-level Map,
 * updated by EditPane's selection listener, and read by the store's nav
 * actions. Plain module state is also safe across the App.tsx `key={filePath}`
 * remounts that destroy every EditPane instance.
 *
 * This module must not import the store (the store imports this) — no cycles.
 */

/** One location in the editor navigation history. Lines/columns are 1-based
 *  (Monaco coordinates), matching `idePendingReveal`. */
export interface NavEntry {
  filePath: string;
  line: number;
  column: number;
}

/** Last-known primary cursor per absolute file path (1-based). Seeded by
 *  EditPane on mount (after the view-state restore) and refreshed on every
 *  cursor-selection change. Entries persist after the EditPane unmounts —
 *  that's the point. */
const lastCursorByFile = new Map<string, { line: number; column: number }>();

export function setLastCursor(
  filePath: string,
  pos: { line: number; column: number },
): void {
  lastCursorByFile.set(filePath, pos);
}

export function getLastCursor(
  filePath: string,
): { line: number; column: number } | undefined {
  return lastCursorByFile.get(filePath);
}
