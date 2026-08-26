/**
 * Cached project-tree enumeration for the in-process `file:search` fallback.
 *
 * The rg fast path (`lib/rgSearch.ts`) makes the JS walk a secondary path used
 * only when ripgrep isn't installed or fails — but on those machines a
 * readdir-everything walk per keystroke is exactly the slowness we're trying
 * to eliminate, so the flat file list is cached per project root. Invalidation
 * is a recursive `fs.watch` (win32/darwin, Node >= 19.1) that marks the entry
 * dirty on any change, with a TTL backstop so platforms/setups where watch
 * misses events never show results older than ~30s.
 *
 * The walk itself (budget, ignore list, ordering) is unchanged from the search
 * handlers — this module is purely "collect + cache".
 */
import { watch } from "node:fs";
import type { Dirent, FSWatcher } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

/** Walk budget shared by `file:search` and `file:grep`. The original 12/8000
 *  caps silently stopped mid-tree on monorepos with deep package layouts or
 *  vendored dependencies — matches below the cut were simply never seen, and
 *  the user got "the file exists but search can't find it". Raised well above
 *  realistic source trees; when a walk still runs out of budget the result
 *  carries `incompleteScan: true` so the renderer can say the results may be
 *  partial instead of presenting an incomplete scan as exhaustive. */
export const SEARCH_MAX_DEPTH = 32;
export const SEARCH_MAX_VISIT = 50000;

export interface WalkFile {
  name: string;
  /** Absolute filesystem path. */
  abs: string;
  /** Project-relative path with forward slashes. */
  relPath: string;
}

/** Stable per-level ordering for the recursive walks: directories first, then
 *  case-insensitive alphabetical (keeps results deterministic). */
export function sortDirents(dirents: Dirent[]): void {
  dirents.sort((a, b) => {
    const aDir = a.isDirectory();
    const bDir = b.isDirectory();
    if (aDir !== bDir) return aDir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

/** # of ms before a cached listing is considered stale even if no fs.watch
 *  event arrived (watch can silently drop events on some setups). */
const TTL_MS = 30_000;
/** Keep at most this many project caches alive (watchers hold handles);
 *  beyond the cap the oldest entries are evicted. */
const MAX_CACHED_ROOTS = 8;

interface CacheEntry {
  files: WalkFile[] | null;
  incompleteScan: boolean;
  dirty: boolean;
  watcher: FSWatcher | null;
  watchOk: boolean;
  watchAttempted: boolean;
  builtAt: number;
}

const caches = new Map<string, CacheEntry>();

/** Enumerate every non-ignored file under `root`, shallow-first, bounded by
 *  {@link SEARCH_MAX_DEPTH}/{@link SEARCH_MAX_VISIT}. `incompleteScan` is set
 *  when the budget ran out before the tree was exhausted. */
async function collectTreeFilesUncached(
  root: string,
  ignored: ReadonlySet<string>,
): Promise<{ files: WalkFile[]; incompleteScan: boolean }> {
  const files: WalkFile[] = [];
  let visited = 0;
  let incompleteScan = false;
  const queue: Array<{ abs: string; depth: number }> = [{ abs: root, depth: 0 }];
  while (queue.length > 0 && visited < SEARCH_MAX_VISIT) {
    const { abs, depth } = queue.shift()!;
    let dirents;
    try {
      dirents = await readdir(abs, { withFileTypes: true });
    } catch {
      continue; // Unreadable dir (EACCES/broken link) - keep walking siblings.
    }
    sortDirents(dirents);
    for (const d of dirents) {
      if (visited >= SEARCH_MAX_VISIT) {
        incompleteScan = true;
        break;
      }
      if (ignored.has(d.name)) continue;
      let isDir: boolean;
      try {
        isDir = d.isDirectory();
      } catch {
        continue; // Skip broken symlinks.
      }
      const fullPath = join(abs, d.name);
      if (!fullPath.startsWith(root + "\\") && !fullPath.startsWith(root + "/")) continue;
      visited += 1;
      if (isDir) {
        if (depth + 1 <= SEARCH_MAX_DEPTH) {
          queue.push({ abs: fullPath, depth: depth + 1 });
        } else {
          incompleteScan = true; // Too deep to ever queue - flagged, not silent.
        }
        continue;
      }
      // relative() can throw on exotic roots; fall back to name only.
      let rel: string;
      try {
        rel = relative(root, fullPath).split(/[/\\]/).join("/");
      } catch {
        rel = d.name;
      }
      files.push({ name: d.name, abs: fullPath, relPath: rel });
    }
  }
  if (visited >= SEARCH_MAX_VISIT) incompleteScan = true;
  return { files, incompleteScan };
}

/** Collect (or reuse a cached copy of) the flat file list for `root`. */
export async function cachedTreeFiles(
  root: string,
  ignored: ReadonlySet<string>,
): Promise<{ files: WalkFile[]; incompleteScan: boolean }> {
  const key = resolve(root);
  let entry = caches.get(key);
  if (!entry) {
    entry = { files: null, incompleteScan: false, dirty: false, watcher: null, watchOk: false, watchAttempted: false, builtAt: 0 };
    caches.set(key, entry);
    if (caches.size > MAX_CACHED_ROOTS) {
      const keys = [...caches.keys()];
      for (const k of keys.slice(0, caches.size - MAX_CACHED_ROOTS)) {
        const e = caches.get(k);
        try {
          e?.watcher?.close();
        } catch {
          // ignore close errors
        }
        caches.delete(k);
      }
    }
  }

  // Lazily arm the recursive watcher. Recursive watch is supported on win32
  // and darwin (Node >= 19.1); anywhere else we rely on the TTL backstop
  // alone. `watchAttempted` makes a failed/exited watcher a permanent "no
  // watch" — never re-armed and re-errored on every search.
  if (!entry.watcher && !entry.watchAttempted) {
    entry.watchAttempted = true;
    entry.watchOk = process.platform === "win32" || process.platform === "darwin";
    if (entry.watchOk) {
      try {
        entry.watcher = watch(key, { recursive: true }, () => {
          entry.dirty = true;
        });
        entry.watcher.on("error", () => {
          entry.watchOk = false;
          entry.dirty = true;
          try {
            entry.watcher?.close();
          } catch {
            // ignore
          }
          entry.watcher = null;
        });
      } catch {
        entry.watchOk = false;
      }
    }
  }

  if (entry.files != null && !entry.dirty && Date.now() - entry.builtAt < TTL_MS) {
    return { files: entry.files, incompleteScan: entry.incompleteScan };
  }

  const { files, incompleteScan } = await collectTreeFilesUncached(key, ignored);
  if (!entry.dirty) {
    // Nothing changed while we walked — safe to cache.
    entry.files = files;
    entry.incompleteScan = incompleteScan;
    entry.builtAt = Date.now();
  } else {
    // A change landed mid-walk; discard so the next search rebuilds.
    entry.files = null;
  }
  return { files, incompleteScan };
}