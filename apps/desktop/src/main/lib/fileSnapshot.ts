/**
 * Per-turn file snapshot — backs the "撤销本轮" feature (Claude Code's
 * `/rewind` analog, scoped to a single turn).
 *
 * Lifecycle:
 *   1. `recordPre(cwd, filePath)` is called once for each file Edit/Write
 *      touches in the turn. The first call snapshots; subsequent calls
 *      for the same path are no-ops (the *original* content is what
 *      matters, not the latest).
 *   2. At turn end, `freeze()` returns the list of files for the renderer
 *      and marks the snapshot as "ready to rewind". The records stay
 *      in memory so `restore()` can still access them.
 *   3. If the user clicks "撤销本轮", `restore(cwd)` writes the originals
 *      back / unlinks newly created files, then the runtime calls
 *      `clear()` to release memory.
 *
 * Path safety: every path is `path.resolve(cwd, filePath)`-d before any
 * disk access and rejected if it escapes `cwd`. This prevents a hostile
 * prompt from getting us to write outside the project working directory.
 *
 * Why we don't use git / a real checkpoint: out of scope for v1. The
 * roadmap reserves checkpoint timeline for P5; this is the lightweight
 * "last turn only" version that solves 90% of the actual user pain
 * (accidental file overwrite / wrong edits) without taking on a
 * dependency.
 */
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { TurnFileEntry } from "@contracts/runtime";
import { msysToWindowsPath } from "@main/lib/msysPath.js";

/** Internal record per snapshotted file. */
interface FileRecord {
  /** Path the snapshot was taken from (cwd-resolved, absolute). */
  absPath: string;
  /** True if the file existed when recordPre was called; false if the
   *  file was created by this turn. Restore uses this to choose
   *  writeFile vs unlink. */
  exists: boolean;
  /** Pre-turn content. Empty string for "existed but was empty" or
   *  "didn't exist" (the latter shouldn't be read; we only use
   *  `content` when `exists === true`). */
  content: string;
}

/** @deprecated Use {@link TurnFileEntry} — kept as an alias so existing
 *  imports keep compiling during the payload expansion. */
export type FrozenFile = TurnFileEntry;

export class FileSnapshot {
  private originals = new Map<string, FileRecord>();
  /** Once frozen, recordPre() is a no-op. Lets us safely call
   *  freeze() at turn end and have any straggling tool_use events
   *  (rare, but possible) be ignored. */
  private frozen = false;

  /** Number of files currently snapshotted (used by tests and the
   *  empty-after-freeze check). */
  get size(): number {
    return this.originals.size;
  }

  /** Snapshot a file's pre-turn state. Safe to call concurrently — the
   *  Map.set is atomic, and only the first call per path does real
   *  work. Returns silently on any error (ENOENT = created, anything
   *  else = log + skip, never crash the event stream). */
  async recordPre(cwd: string, filePath: string): Promise<void> {
    if (this.frozen) return;
    const abs = safeResolve(cwd, filePath);
    if (abs === null) return; // path escapes cwd — silently ignore
    if (this.originals.has(abs)) return; // already snapshotted
    try {
      const content = await readFile(abs, "utf-8");
      this.originals.set(abs, { absPath: abs, exists: true, content });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        // File didn't exist before — claude will create it. Record
        // exists:false so restore can unlink.
        this.originals.set(abs, { absPath: abs, exists: false, content: "" });
      } else {
        // EACCES, EISDIR, etc. — not safe to restore later, so skip.
        // Logged so devs can see it without crashing the stream.
        console.warn(`FileSnapshot: skip ${abs} (${code ?? (err as Error).message})`);
      }
    }
  }

  /** Freeze and return the list of files for the renderer, enriched with
   *  per-file change tallies (`adds` / `dels`) and the pre-turn `before`
   *  content. The records STAY in memory so a subsequent restore() can use
   *  them — clear() is what actually frees them, and the runtime calls it
   *  either after a successful restore or at the start of the next turn.
   *
   *  Async because we read each file's current on-disk content to diff
   *  against the snapshotted `before`. Read failures (deleted mid-turn,
   *  binary, permission) degrade gracefully to adds=dels=0 and before=""
   *  so a single bad file never blocks the whole turn-files event. */
  async freeze(): Promise<TurnFileEntry[]> {
    this.frozen = true;
    const out: TurnFileEntry[] = [];
    for (const rec of this.originals.values()) {
      const before = rec.exists ? rec.content : "";
      let after = "";
      try {
        after = await readFile(rec.absPath, "utf-8");
      } catch {
        // File is unreadable (gone, binary, EACCES, …). Fall back to an
        // empty "after" so the tallies show the whole `before` as deleted.
        after = "";
      }
      const { adds, dels } = countLineDiff(before, after);
      out.push({
        filePath: rec.absPath,
        kind: rec.exists ? "modified" : "created",
        adds,
        dels,
        before,
      });
    }
    return out;
  }

  /** Restore all snapshotted files. Returns the paths that were
   *  successfully restored. Failures are logged and excluded from
   *  the return value so the renderer knows which ones actually
   *  reverted.
   *
   *  Delegates to the module-level {@link restoreFiles} so the restore
   *  logic has a single implementation shared with the DB-driven path
   *  (used when a session is reopened and the in-memory snapshot is gone). */
  async restore(cwd: string): Promise<string[]> {
    // Process created-files first (unlink) so a parent that was also
    // modified can be cleanly rewritten without the child blocking.
    const all = [...this.originals.values()];
    const created = all.filter((r) => !r.exists);
    const modified = all.filter((r) => r.exists);
    const ordered = [...created, ...modified].map((r) =>
      // Reconstruct a TurnFileEntry from the in-memory record. `before`
      // is only meaningful when the file existed; created files carry
      // an empty string (restore unlinks rather than writes).
      ({
        filePath: r.absPath,
        kind: r.exists ? ("modified" as const) : ("created" as const),
        adds: 0,
        dels: 0,
        before: r.exists ? r.content : "",
      }),
    );
    return restoreFiles(cwd, ordered);
  }

  /** Drop the restore records. Called by the runtime after a
   *  successful rewind (so the next turn starts clean) and when a
   *  session is disposed. Also called at the start of each turn
   *  to bound memory. */
  clear(): void {
    this.originals.clear();
    this.frozen = false;
  }

  /** Snapshot keys (cwd-resolved absolute paths) — used by the runtime
   *  to decide whether a rewind's `files` argument matches the live
   *  snapshot (so it can clear() safely) or came from elsewhere (e.g.
   *  the DB, for a historical-turn rewind) and shouldn't touch the
   *  live snapshot. */
  hasPaths(paths: string[]): boolean {
    if (paths.length !== this.originals.size) return false;
    return paths.every((p) => this.originals.has(p));
  }
}

/** Restore an arbitrary set of {@link TurnFileEntry} to their `before`
 *  state. The single source of truth for the restore operation — used
 *  both by {@link FileSnapshot.restore} (live latest-turn rewind) and
 *  by `RuntimeManager.rewindTurn` when it receives explicit entries
 *  (historical-turn rewind, or a session reopened after restart where
 *  the in-memory snapshot is gone).
 *
 *  Path safety: every entry's `filePath` is re-checked against `cwd`
 *  via {@link safeResolveOk} — a path that escapes cwd is refused and
 *  excluded from the result. This keeps the restore guard identical to
 *  the one that governed the original write.
 *
 *  Returns the paths actually restored (failures are logged and dropped,
 *  so the renderer knows what really landed back on disk). */
export async function restoreFiles(
  cwd: string,
  entries: TurnFileEntry[],
): Promise<string[]> {
  const restored: string[] = [];
  // Process created-files first (unlink) so a parent that was also
  // modified can be cleanly rewritten without the child blocking.
  const created = entries.filter((e) => e.kind === "created");
  const modified = entries.filter((e) => e.kind === "modified");
  for (const entry of [...created, ...modified]) {
    if (!safeResolveOk(cwd, entry.filePath)) {
      console.warn(`restoreFiles: refused, escapes cwd: ${entry.filePath}`);
      continue;
    }
    try {
      if (entry.kind === "modified") {
        // Ensure parent dir exists in case the user (or another tool)
        // deleted it mid-turn.
        await mkdir(dirname(entry.filePath), { recursive: true });
        await writeFile(entry.filePath, entry.before, "utf-8");
      } else {
        try {
          await unlink(entry.filePath);
        } catch (err) {
          // Already gone — nothing to do.
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
      }
      restored.push(entry.filePath);
    } catch (err) {
      console.warn(`restoreFiles: failed for ${entry.filePath} (${(err as Error).message})`);
    }
  }
  return restored;
}

/* ──────────────────────────── path safety ──────────────────────────── */
/* Exported so the on-demand file-read IPC handler reuses the exact same
   cwd-escape guard the snapshot uses, rather than re-implementing it. */

/** File-mutating tools whose `file_path` / `notebook_path` input must be
 *  normalized (WSL → Windows) and confined to the project working directory.
 *  Shared between the provider's canUseTool guard and the adapter's rewind
 *  snapshot so both sides agree on the target path. */
export const FILE_MUTATING_TOOLS: ReadonlySet<string> = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
]);

/** Extract the target path from a file-mutating tool's input. Returns ""
 *  when the input is missing/malformed. NotebookEdit names its field
 *  `notebook_path`; the rest use `file_path`. */
export function getToolFilePath(toolName: string, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  const raw = toolName === "NotebookEdit" ? obj.notebook_path : obj.file_path;
  return typeof raw === "string" ? raw : "";
}

/** Normalize a file path coming out of a file-mutating tool input:
 *  fix the WSL/MSYS-path footguns and classify it relative to the project
 *  root.
 *
 *  Claude occasionally emits `/mnt/<drive>/...` (WSL-style) or `/d/...`
 *  (Git Bash-style) paths even on native Windows — both notations are baked
 *  into its training data. On Windows `path.resolve()` treats such a path as
 *  root-relative on the current drive, so `/mnt/d/foo.md` would silently land
 *  in a garbage `D:\mnt\d\foo.md` folder. We translate both dialects to
 *  native paths first, then resolve against cwd.
 *
 *  Returns `{ absPath, insideProject }`:
 *    - absPath: the absolute path the write should actually target (the
 *      provider rewrites the tool input to this).
 *    - insideProject: whether absPath stays within cwd (the project root).
 *  Returns null when the path can't be resolved (caller skips silently). */
export function normalizeToolFilePath(
  cwd: string,
  filePath: string,
): { absPath: string; insideProject: boolean } | null {
  // WSL/MSYS dialect → native Windows path: /mnt/d/foo → D:\foo, /d/foo →
  // D:/foo (shared with the Pi read-tool override and the bash-command
  // normalizer, so every path check agrees on the same translation).
  const win = msysToWindowsPath(filePath);
  let abs: string;
  try {
    abs = resolve(cwd, win);
  } catch {
    return null;
  }
  return { absPath: abs, insideProject: safeResolveOk(cwd, abs) };
}

/** Resolve `filePath` against `cwd` and refuse any path that escapes.
 *  Returns null if the path is unsafe (caller should skip silently). */
export function safeResolve(cwd: string, filePath: string): string | null {
  let abs: string;
  try {
    abs = resolve(cwd, filePath);
  } catch {
    return null;
  }
  return safeResolveOk(cwd, abs) ? abs : null;
}

/** Re-check that an already-resolved absolute path stays within cwd.
 *  Used by restore() to defend against the cwd changing between
 *  recordPre and restore. */
export function safeResolveOk(cwd: string, abs: string): boolean {
  // path.relative with the second arg outside cwd returns a path
  // starting with "..". On Windows an absolute result also means
  //  "different root" (different drive).
  const rel = relative(cwd, abs);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/* ──────────────────────────── line counting ──────────────────────────── */

/** Split text into lines, dropping a single trailing empty produced by a
 *  final `\n` (matches the renderer's lineDiff.splitLines so before/after
 *  are counted on the same basis). */
function splitLines(s: string): string[] {
  if (s === "") return [];
  const parts = s.split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "" && s.endsWith("\n")) {
    parts.pop();
  }
  return parts;
}

/** Tally added/deleted line counts between two texts via an LCS table walk.
 *  A counting-only sibling of the renderer's `lineDiff` — we don't need the
 *  actual diff *lines* in main, just the `+N -M` numbers for the folded card,
 *  so this stays allocation-light (one Int32Array, no output array). */
function countLineDiff(oldText: string, newText: string): { adds: number; dels: number } {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const m = oldLines.length;
  const n = newLines.length;
  // Fast paths: identical, or one side empty.
  if (m === 0) return { adds: n, dels: 0 };
  if (n === 0) return { adds: 0, dels: m };

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
  // Walk back to count deletes/inserts (same logic as lineDiff, but tally
  // instead of push).
  let adds = 0;
  let dels = 0;
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (oldLines[i - 1] === newLines[j - 1]) {
      i--;
      j--;
    } else if (lcs[(i - 1) * cols + j] >= lcs[i * cols + (j - 1)]) {
      dels++;
      i--;
    } else {
      adds++;
      j--;
    }
  }
  while (i > 0) {
    dels++;
    i--;
  }
  while (j > 0) {
    adds++;
    j--;
  }
  return { adds, dels };
}
