/**
 * Resolve a file path printed in terminal output to an on-disk file —
 * the main-side half of the terminal click-to-open feature (the renderer
 * cannot stat; the IPC handler in ipc/terminal.ts delegates here).
 *
 * Three stages, strictest first:
 *  1. direct: relative candidates join the project root, absolute ones are
 *     taken as-is (POSIX separators normalized on win32);
 *  2. basename fuzzy: agents reference files by BARE NAME constantly
 *     ("audio_audit.py" when the file lives at scratch/audio_audit.py) —
 *     bounded walk of the project looking for a UNIQUE basename match
 *     (0 or ≥2 hits → null; ambiguity must never jump the editor somewhere
 *     wrong);
 *  3. null — everything else (directories never resolve).
 *
 * Pure fs module (no electron imports) so the smoke script exercises the
 * real walk against temp trees.
 */
import { readdirSync, statSync } from "node:fs";
import { isAbsolute, join, resolve as resolvePath } from "node:path";

/** Directories the fuzzy walk never descends into (huge / noise). */
const WALK_SKIP = new Set(["node_modules", ".git", "dist", "build", ".venv", "__pycache__"]);

/** Budgets keeping the walk bounded on big repos. */
const WALK_MAX_DEPTH = 8;
const WALK_MAX_ENTRIES = 20_000;

/** Unique-match memo: key `projectPath\0basename`. Negative results cached
 *  too — a repeated miss must not re-walk the tree on every hover tick. */
const fuzzyCache = new Map<string, string | null>();

/** Drop the fuzzy memo (smoke/test hook — the walk's negative and positive
 *  results are session-lived by design; a test that MUTATES the tree between
 *  assertions needs a clean slate to observe the walk again). */
export function resetPrintedPathResolveCache(): void {
  fuzzyCache.clear();
}

/** Normalize a printed path for the host OS: POSIX separators → win32,
 *  then absolute-or-join-root. */
function normalizeCandidate(projectPath: string, printed: string): string | null {
  let candidate = printed.trim();
  if (!candidate) return null;
  if (process.platform === "win32") {
    candidate = candidate.replace(/\//g, "\\");
    // A single leading slash (posix-absolute style) anchors to no drive we
    // can trust — drop it and treat as root-relative.
    candidate = candidate.replace(/^\\+/, "");
    candidate = candidate.replace(/\\+/g, "\\");
  }
  const abs = isAbsolute(candidate) ? candidate : join(projectPath, candidate);
  return resolvePath(abs);
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Depth-limited, entry-budgeted basename search. Returns the single match
 *  or null (none / ambiguous). `hits` stops at 2 — one past unique is all
 *  the caller needs to know. */
function walkByBasename(
  dir: string,
  base: string,
  depth: number,
  state: { entries: number },
  hits: string[],
): void {
  if (hits.length >= 2 || depth > WALK_MAX_DEPTH || state.entries > WALK_MAX_ENTRIES) return;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (hits.length >= 2 || state.entries > WALK_MAX_ENTRIES) return;
    state.entries += 1;
    const full = join(dir, name);
    let stat: import("node:fs").Stats | null = null;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isFile() && name === base) {
      hits.push(full);
      if (hits.length >= 2) return;
    } else if (stat.isDirectory() && !WALK_SKIP.has(name)) {
      walkByBasename(full, base, depth + 1, state, hits);
    }
  }
}

export interface ResolvePrintedPathInput {
  projectPath: string;
  /** Candidate exactly as printed in the terminal. */
  path: string;
}

/** See the module header. Returns the absolute path of an existing FILE or
 *  null. Never throws. */
export function resolvePrintedPath(projectPath: string, printed: string): string | null {
  try {
    const abs = normalizeCandidate(projectPath, printed);
    if (!abs) return null;
    if (isFile(abs)) return abs;

    // Fuzzy stage applies to BARE names only — a path with separators that
    // misses must not "maybe land somewhere else"; wrong-directory jumps
    // are worse than a dead click there.
    const base = printed.trim().replace(/\\/g, "/");
    if (base.includes("/")) return null;

    const key = `${resolvePath(projectPath)}\0${base}`;
    if (fuzzyCache.has(key)) return fuzzyCache.get(key) ?? null;

    const hits: string[] = [];
    walkByBasename(resolvePath(projectPath), base, 0, { entries: 0 }, hits);
    const result = hits.length === 1 ? hits[0] : null;
    if (fuzzyCache.size > 200) fuzzyCache.clear();
    fuzzyCache.set(key, result);
    return result;
  } catch {
    return null;
  }
}
