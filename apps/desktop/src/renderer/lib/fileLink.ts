/**
 * File-path detection & resolution for chat output.
 *
 * The model emits file paths in free-form prose with no guaranteed shape:
 * absolute (`/Users/x/proj/src/a.ts`), project-relative (`src/a.ts`,
 * `./src/a.ts`), partial (`components/chat/Markdown.tsx`), or even a bare
 * filename (`FileEditor.tsx`). This module turns such tokens into clickable
 * links by resolving them to absolute paths on click (NOT at render time -
 * rendering stays synchronous and IPC-free so streaming is unaffected).
 *
 * Resolution strategy (per token, on click):
 *  1. Absolute path under a known project root -> return as-is.
 *  2. Project-relative path that exists -> resolve against project root.
 *  3. Otherwise -> `file.search` substring query, client-side ranked.
 *
 * Security: we never resolve outside a known project root. `file.search` /
 * `file.readFile` on the main side re-validate containment regardless.
 */
import { api } from "@renderer/lib/api.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { basename, joinPath } from "@renderer/lib/path.js";

/** Maximum candidates returned from the ambiguous-path search fallback. */
const MAX_CANDIDATES = 12;
/** `file.search` limit (larger than MAX_CANDIDATES so ranking has room). */
const SEARCH_LIMIT = 50;

/** Common source-file extensions used to recognise bare filenames like
 *  `FileEditor.tsx`. Kept broad but bounded so version strings (`v1.2`) or
 *  sentences ending in a short dotted token aren't misread as paths. */
const COMMON_EXTENSIONS = new Set([
  // code
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "vue", "svelte", "astro",
  "py", "rb", "php", "go", "rs", "java", "kt", "swift", "c", "h", "cpp",
  "cc", "cxx", "hpp", "hh", "cs", "scala", "clj", "ex", "exs", "erl",
  "elm", "dart", "lua", "r", "jl", "pl", "pm", "tcl",
  // web / markup
  "html", "htm", "css", "scss", "sass", "less", "styl",
  "json", "jsonc", "json5", "yaml", "yml", "toml", "ini", "cfg", "conf",
  "xml", "svg", "md", "mdx", "markdown", "rst", "tex",
  // shell / build
  "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd",
  "dockerfile", "makefile", "cmake", "gradle", "rake",
  // data
  "sql", "graphql", "gql", "proto", "csv", "tsv", "env",
  // config (special filenames handled separately, but cover dotfile exts)
  "gitignore", "editorconfig", "eslintrc", "prettierrc",
]);

/** True when `ext` (without the dot, lowercased) looks like a real file
 *  extension rather than a version fragment or sentence punctuation. */
function looksLikeExtension(ext: string): boolean {
  if (!ext) return false;
  if (COMMON_EXTENSIONS.has(ext)) return true;
  // Allow unknown but plausible extensions: 1-8 alnum chars. This catches
  // niche formats (.lock, .log, .wasm) while rejecting `v1.2` (the part
  // after the dot is `2`, fine) — actually `2` is 1 char so guard against
  // single-char non-letter tails by requiring at least one letter.
  if (ext.length > 8) return false;
  if (!/[a-z]/.test(ext)) return false;
  return /^[a-z0-9]+$/.test(ext);
}

/** Does `token` look like a bare filename with a recognised extension,
 *  e.g. `FileEditor.tsx`? Used to linkify filenames that have no slash. */
function isBareFilenameWithExt(token: string): boolean {
  const slash = token.lastIndexOf("/");
  const name = slash >= 0 ? token.slice(slash + 1) : token;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false; // dot at 0 = dotfile, treat as no ext here
  const ext = name.slice(dot + 1).toLowerCase();
  return looksLikeExtension(ext);
}

/**
 * Regex matching file-path-like tokens inside prose.
 *
 * Matches one of:
 *  - Absolute POSIX path: `/Users/foo/proj/src/a.ts` (must contain a `.` in
 *    the last segment OR be long enough to look pathy: `/a/b/c`).
 *  - Windows absolute path: `C:\proj\src\a.ts` or `C:/proj/src/a.ts`.
 *  - Relative path with a slash and a trailing extension: `src/a.ts`,
 *    `./components/chat/Markdown.tsx`, `../lib/path.ts`.
 *  - Bare filename with a recognised extension: `FileEditor.tsx`.
 *
 * Deliberately does NOT match:
 *  - Plain words / sentences (no slash, no extension).
 *  - URLs (`http://...`, `https://...`) — left to the `a` override.
 *  - Email addresses (`foo@bar.com`).
 *  - Version numbers / dotted sentences (`v1.2.3`, `end. The`).
 *
 * Boundary: matched as a maximal run of non-whitespace, non-CJK-punct chars,
 * then validated by the helper. We avoid trailing punctuation (`,`, `)`,
 * `。`, `、`) via the character class.
 */
const TOKEN_CHAR = "[^\\s\"'`<>()\\[\\]{}。，、；：!?,；）】》」』)\\]]";
const PATH_TOKEN_RE = new RegExp(
  [
    // 1) Absolute POSIX path, must look pathy (slash + (extension or depth>=2))
    String.raw`/(?:[A-Za-z0-9._\-]+/){1,}[A-Za-z0-9._\-]+`,
    // 2) Windows absolute path: drive letter + colon + (back|fwd) slashes
    String.raw`[A-Za-z]:[\\/][^\\/\s][^\s"'\`<>()[\]{}。，、；：!?,；）】》」』)\]]*`,
    // 3) Relative path with a slash and a trailing extension: ./x/y.z, x/y.z
    String.raw`(?:\.{0,2}/)?[A-Za-z0-9._\-]+(?:[\\/][A-Za-z0-9._\-]+)+\.[A-Za-z0-9._\-]+`,
    // 4) Bare filename with a recognised extension: FileEditor.tsx
    String.raw`[A-Za-z0-9._\-]+\.[A-Za-z0-9._\-]+`,
  ].join("|"),
  "g",
);

/** A candidate produced by resolution — an absolute path plus its
 *  project-relative form (for display in the picker). */
export interface ResolvedCandidate {
  /** Absolute filesystem path (openable by `openFileInIde`). */
  path: string;
  /** Path relative to the project root (forward-slash), for display. */
  relativePath: string;
}

/** Normalize separators to forward slashes and strip a leading `./`. */
function normalizeRel(p: string): string {
  let s = p.replace(/\\/g, "/");
  if (s.startsWith("./")) s = s.slice(2);
  return s;
}

/**
 * All filesystem roots a chat-emitted path may legally open: registered
 * project roots plus every known worktree checkout (session-bound paths and
 * the per-repo git worktree probe). Mirrors the main-side workspace-root
 * guard — without the worktree roots, absolute paths emitted by a worktree
 * session (its cwd IS the worktree) would resolve to "no match".
 */
function knownWorkspaceRoots(): string[] {
  const s = useSessionStore.getState();
  const roots: string[] = [];
  for (const p of s.projects) {
    if (p.path) roots.push(p.path);
  }
  const pushSessionRoots = (sessions: ReadonlyArray<{ worktreePath?: string | null }>) => {
    for (const sess of sessions) {
      if (sess.worktreePath) roots.push(sess.worktreePath);
    }
  };
  for (const list of Object.values(s.sessionsByProject)) pushSessionRoots(list ?? []);
  pushSessionRoots(s.pinnedSessions);
  pushSessionRoots(s.streamSessions);
  for (const info of Object.values(s.worktreeInfoByRepo)) {
    for (const wt of info.worktrees) {
      if (wt.path) roots.push(wt.path);
    }
  }
  return roots;
}

/** True if `absPath` is contained by one of the known project/worktree roots. */
function isUnderKnownProject(absPath: string): boolean {
  const norm = absPath.replace(/\\/g, "/");
  for (const root of knownWorkspaceRoots()) {
    const r = root.replace(/\\/g, "/").replace(/\/+$/, "");
    if (!r) continue;
    if (norm === r || norm.startsWith(r + "/")) return true;
  }
  return false;
}

/** True if `token` is an absolute path (POSIX or Windows drive). */
export function isAbsolutePath(token: string): boolean {
  return token.startsWith("/") || /^[A-Za-z]:[\\/]/.test(token);
}

/**
 * True when a markdown `href` should be treated as a local file path rather
 * than a web URL: `file://` URIs, scheme-less paths (absolute, relative, or
 * UNC), and single-letter "schemes" (Windows drives: `D:/x`, `D:\x`). Real
 * web schemes (http/https/mailto/…) return false and keep the default
 * external-open flow; `#fragment` and empty hrefs return false.
 */
export function isLocalFileHref(href: string): boolean {
  const h = href.trim();
  if (!h || h.startsWith("#")) return false;
  if (/^file:\/\//i.test(h)) return true;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(h);
  if (!scheme) return true; // no scheme -> path (docs/x.md, ./x.md, /a/b, \\srv\share)
  return scheme[1].length === 1; // single-letter scheme = drive letter
}

/**
 * Percent-decode `s`, tolerating sequences that aren't valid encoding: runs of
 * consecutive `%XX` groups are decoded as one UTF-8 unit (`%E5%B0%8F` -> 小),
 * while malformed runs (a literal `%of` in a filename) are kept verbatim
 * instead of aborting the whole string like `decodeURIComponent` would.
 */
function decodePercentLenient(s: string): string {
  return s.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

/**
 * Convert a markdown href into a filesystem path (pure, no IPC).
 *
 * Two things to undo:
 *  - `file://` URIs: strip the `file://[host]` prefix and the extra leading
 *    slash of drive URIs (`file:///D:/x` -> `D:/x`).
 *  - Percent-encoding: the markdown pipeline encodes non-ASCII in URLs at the
 *    hast layer (mdast-util-to-hast -> normalizeUri), so a Chinese filename
 *    arrives as `Mcode-%E5%B0%8F….md` and no filesystem lookup would match.
 *    Decode before resolving; stray `%` runs that aren't valid encoding keep
 *    the raw form.
 */
export function fileHrefToPath(href: string): string {
  let h = href.trim();
  if (/^file:\/\//i.test(h)) {
    h = h.replace(/^file:\/\/(?:localhost)?/i, "");
    if (/^\/[A-Za-z]:[\\/]/.test(h)) h = h.slice(1);
  }
  if (h.includes("%")) {
    h = decodePercentLenient(h);
  }
  return h;
}

/**
 * Resolve a path token to one or more absolute-path candidates.
 *
 * Resolution order:
 *  1. Absolute path under a known project root -> single candidate.
 *  2. Project-relative path (joined to `projectPath`) whose relative path
 *     matches a `file.search` result -> single candidate.
 *  3. Otherwise, substring-search the project and rank the matches.
 *
 * Returns `[]` when nothing is found or no `projectPath` is available for a
 * relative token. Callers decide how to present 0/1/many candidates.
 */
export async function resolveFilePathToken(
  token: string,
  projectPath: string | null | undefined,
): Promise<ResolvedCandidate[]> {
  const clean = token.trim().replace(/^["'`]|["'`]$/g, "");
  if (!clean) return [];

  // 1) Absolute path.
  if (isAbsolutePath(clean)) {
    if (isUnderKnownProject(clean)) {
      return [{ path: clean, relativePath: relativeOrSelf(clean, projectPath) }];
    }
    // Absolute but not under a known project — can't open it.
    return [];
  }

  if (!projectPath) return []; // relative token without a root — give up

  const norm = normalizeRel(clean);

  // 2) Project-relative path: look for an exact relativePath match.
  //    Query the basename (search matches basename OR relativePath), then
  //    pick the entry whose relativePath equals our token.
  try {
    const base = basename(norm) || norm;
    const res = await api.file.search({ projectPath, query: base, limit: SEARCH_LIMIT });
    const exact = res.files.find((f) => normalizeRel(f.relativePath) === norm);
    if (exact) {
      return [{ path: exact.path, relativePath: exact.relativePath }];
    }
    // Also try the joined absolute path as a containment check fallback —
    // some files may be excluded from search (ignored entries) but still
    // openable. We can't stat from the renderer, but if the search returned
    // a candidate whose path ends with our relative segment, treat as found.
    const suffix = norm;
    const suffixMatch = res.files.find(
      (f) => f.path.endsWith(suffix) || f.path.endsWith("/" + suffix),
    );
    if (suffixMatch) {
      return [{ path: suffixMatch.path, relativePath: suffixMatch.relativePath }];
    }
  } catch {
    // search failure -> fall through to ambiguous lookup
  }

  // 3) Ambiguous / partial path: rank search results by relevance.
  return resolveAmbiguous(clean, projectPath);
}

/** Substring-search and rank candidates for a partial path token. */
async function resolveAmbiguous(
  token: string,
  projectPath: string,
): Promise<ResolvedCandidate[]> {
  let files: { name: string; path: string; relativePath: string }[] = [];
  try {
    const res = await api.file.search({ projectPath, query: token, limit: SEARCH_LIMIT });
    files = res.files;
  } catch {
    return [];
  }

  const lower = token.toLowerCase();
  const base = basename(token).toLowerCase();

  const scored = files
    .map((f) => {
      const nameLower = f.name.toLowerCase();
      const relLower = normalizeRel(f.relativePath).toLowerCase();
      let score = 0;
      if (nameLower === base) score += 100; // exact basename match
      else if (nameLower.endsWith(base)) score += 60; // basename ends with token
      else if (relLower === lower) score += 90; // exact relative path
      else if (relLower.endsWith(lower)) score += 50; // relative ends with token
      else if (nameLower.includes(base)) score += 30; // basename contains
      // Tiebreak: shallower (shorter relative path) first.
      score -= Math.min(f.relativePath.length, 99) / 100;
      return { f, score };
    })
    .sort((a, b) => b.score - a.score);

  // Deduplicate by path, keep top N.
  const seen = new Set<string>();
  const out: ResolvedCandidate[] = [];
  for (const { f } of scored) {
    if (seen.has(f.path)) continue;
    seen.add(f.path);
    out.push({ path: f.path, relativePath: f.relativePath });
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

/** Relative path of `abs` against `root`, falling back to `abs` itself. */
function relativeOrSelf(abs: string, root: string | null | undefined): string {
  if (!root) return abs;
  const normAbs = abs.replace(/\\/g, "/");
  const normRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
  if (normAbs.startsWith(normRoot + "/")) return normAbs.slice(normRoot.length + 1);
  return abs;
}

// ── Text splitting (render-time, synchronous) ─────────────────────────

/** A text segment is either plain text or a path token to be linkified. */
export type TextSegment =
  | { kind: "text"; text: string }
  | { kind: "path"; token: string };

/**
 * Split a string into plain-text and path-token segments. Pure & synchronous
 * — safe to call during render on every text node. Only linkifies tokens that
 * pass the path-likeness checks (slash + extension, or bare filename with a
 * recognised extension, or an absolute path).
 */
export function splitTextByPathTokens(text: string): TextSegment[] {
  if (!text) return [];
  const out: TextSegment[] = [];
  let last = 0;
  PATH_TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PATH_TOKEN_RE.exec(text)) !== null) {
    const token = m[0];
    // Validate the candidate so we don't linkify version strings etc.
    if (!isLikelyPathToken(token)) {
      continue; // skip — but don't consume; regex will advance naturally
    }
    // Also reject if the match is immediately preceded by a URL scheme.
    const start = m.index;
    if (start >= 4 && /https?:\/\//i.test(text.slice(Math.max(0, start - 8), start + token.length))) {
      continue;
    }
    // Reject if preceded by `@` (email-style `foo@bar.com` - `bar.com` would
    // otherwise match as a bare filename). A real file path is never preceded
    // by `@` in prose.
    if (start > 0 && text[start - 1] === "@") {
      continue;
    }
    if (start > last) out.push({ kind: "text", text: text.slice(last, start) });
    out.push({ kind: "path", token });
    last = start + token.length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

/** Final validation gate for a regex match: decide if it's really a path. */
function isLikelyPathToken(token: string): boolean {
  // Absolute POSIX: `/a/b/c` — require depth >= 2 OR an extension, to avoid
  // matching `/etc` style single-segment refs (rare in model output anyway).
  if (token.startsWith("/")) {
    const segs = token.split("/").filter(Boolean);
    if (segs.length >= 3) return true;
    if (segs.length >= 2 && isBareFilenameWithExt(segs[segs.length - 1])) return true;
    return false;
  }
  // Windows absolute.
  if (/^[A-Za-z]:[\\/]/.test(token)) {
    return token.split(/[\\/]/).filter(Boolean).length >= 2;
  }
  // Relative with slash + extension.
  if (/[\\/]/.test(token)) {
    return isBareFilenameWithExt(token);
  }
  // Bare filename with extension.
  return isBareFilenameWithExt(token);
}

/** Build the absolute path a relative token would have under a project root.
 *  Exported for callers (e.g. tool cards) that already hold an absolute path
 *  and just need the join helper. */
export function joinProjectPath(projectPath: string, rel: string): string {
  return joinPath(projectPath, rel);
}
