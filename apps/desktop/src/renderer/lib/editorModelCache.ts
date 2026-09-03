import type { editor } from "monaco-editor";

/**
 * Process-wide cache of Monaco text models for the editor's open tabs, keyed
 * by absolute file path (the same canonical strings the store's open-files
 * buckets hold).
 *
 * Why: the editor column mounts a single `FileEditor` keyed by `filePath`, so
 * every tab switch tears the whole Monaco instance down. With
 * `keepCurrentModel` the TextModel survives those remounts — together with
 * its tokenization cache, its undo stack and any unsaved edits — so
 * re-opening a file skips the read→spinner→re-tokenize pipeline entirely.
 *
 * Ownership: this cache OWNS the models. `@monaco-editor/react` is given
 * `keepCurrentModel` so it never disposes them; disposal happens exactly
 * when a file stops being open:
 *   - store close/rename/replace actions dispose models of files that were
 *     NOT mounted (background tabs get no unmount event);
 *   - the mounted file's model is disposed by EditPane's unmount cleanup,
 *     which checks that the file has actually left its project's open list.
 *
 * No runtime dependency on the monaco namespace on purpose — models are held
 * by reference and `.dispose()` needs no namespace — so the session store can
 * import this module without pulling Monaco onto the startup path (Monaco
 * stays lazy-loaded inside the FileEditor chunk).
 */

export interface CachedModelEntry {
  model: editor.ITextModel;
  /** Content the model was last loaded from / saved to disk with — the dirty
   *  baseline. Updated on save and on external-change syncs. */
  baseline: string;
}

const entries = new Map<string, CachedModelEntry>();

export function getModelEntry(filePath: string): CachedModelEntry | undefined {
  return entries.get(filePath);
}

export function getBaseline(filePath: string): string | undefined {
  return entries.get(filePath)?.baseline;
}

/** Register a model. Idempotent per path: a remount of an already-cached
 *  file keeps its baseline (unsaved-edit state must survive), but the model
 *  reference is refreshed so a stale entry self-heals against the model the
 *  editor is actually displaying. */
export function registerModel(
  filePath: string,
  model: editor.ITextModel,
  baseline: string,
): void {
  const existing = entries.get(filePath);
  if (existing) {
    existing.model = model;
    return;
  }
  entries.set(filePath, { model, baseline });
}

export function updateBaseline(filePath: string, baseline: string): void {
  const entry = entries.get(filePath);
  if (entry) entry.baseline = baseline;
}

export function disposeModel(filePath: string): void {
  const entry = entries.get(filePath);
  if (!entry) return;
  entries.delete(filePath);
  try {
    entry.model.dispose();
  } catch {
    // Already disposed — nothing to do.
  }
}

/* ─────────────────────── displayed-model ownership ───────────────────────
 *
 * The file whose model a live editor is currently displaying. With the
 * persistent editor (model swap instead of remount), there is always exactly
 * one "mounted" model while the editor column is up — and it is NOT
 * necessarily the store's active file (while a newly-activated file is still
 * loading, the editor keeps showing the previous one). Disposing an attached
 * model breaks the live editor, so store close/rename actions must skip it;
 * the swap's leave-bookkeeping in EditPane disposes it once it's no longer
 * displayed and has left the open list. */

let displayedPath: string | null = null;

export function getDisplayedPath(): string | null {
  return displayedPath;
}

export function setDisplayedPath(path: string | null): void {
  displayedPath = path;
}
