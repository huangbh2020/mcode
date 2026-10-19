/**
 * Terminal click-to-open file paths — a custom xterm link provider that
 * recognizes file paths (and path:line / path:line:column shapes compilers
 * and agents emit) in the PTY output and turns them into clickable links
 * that open in the IDE editor.
 *
 * Matching rules are deliberately conservative:
 *  - the path must EXIST on disk (checked via the project-scoped resolver
 *    passed by the host — the renderer cannot stat arbitrary paths) and
 *    resolves against the project root for relative names;
 *  - only real files (directories open nothing — a clickable "src/" would
 *    be noise);
 *  - trailing separators like `:` `)` `,` quotes are stripped; a trailing
 *    `:12` / `:12:34` segment is treated as line/column ONLY when the
 *    remainder exists as a file (so "port: 5173" never matches).
 *
 * URLs are handled separately by @xterm/addon-web-links (http/https/mailto).
 */
import type { IBufferLine, ILink, ILinkProvider, Terminal } from "@xterm/xterm";

/** A candidate the host resolves: absolute or project-relative path plus
 *  optional 1-based line/column. `resolve` answers whether it exists. */
export interface TerminalPathTarget {
  /** The path as it should be opened (absolute after host resolution). */
  path: string;
  line?: number;
  column?: number;
}

export type PathResolver = (target: TerminalPathTarget) => boolean;

/** Trailing punctuation that cannot be part of a path when the match rides
 *  at the end of a sentence/list. */
const TRAILING_STRIP = /[)\]},;.'"“”»…]+$/;

/** Windows drive / UNC / posix-absolute / project-relative path candidates,
 *  plus BARE FILENAMES (`name.ext` / dotfiles like `.gitignore`) — agents
 *  constantly reference files by name alone. The bare branch requires a
 *  dot followed by an extension starting with a LETTER, so numbers like
 *  "3.8" / "v1.4.2" never match; everything still has to EXIST on disk
 *  (host-side resolution) before it becomes a link, so regex over-matching
 *  is harmless — misses just cost one deduped existence probe. CJK-safe
 *  via the unicode classes. */
const PATH_RE = new RegExp(
  [
    "(?:[A-Za-z]:[\\\\/](?:[^\\s\\\\/:*?\"<>|]+[\\\\/]*)*)", // Windows abs
    "(?:\\\\\\\\[A-Za-z0-9._-]+[\\\\/][^\\s]+)", // UNC
    "(?:\\.{1,2}[\\\\/](?:[^\\s\\\\/:*?\"<>|]+[\\\\/]*)+)", // ./ ../ rel
    "(?:(?:[^\\s\\\\/:*?\"<>|]+[\\\\/])+[^\\s\\\\/:*?\"<>|]+)", // nested rel
    // Bare files, two shapes: `name.ext` (audio_audit.py) and DOTFILES
    // (.gitignore / .prettierrc) — a dotfile is a single leading-dot token
    // with NO internal separator, so it cannot ride the name.ext shape
    // (that requires ≥1 char before the dot; .gitignore has none).
    "(?:(?:[\\p{L}\\p{N}_\\-.@]+\\.\\p{L}[\\p{L}\\p{N}]{0,12})|(?:\\.\\p{L}[\\p{L}\\p{N}_\\-.]{0,20}))",
  ].join("|"),
  "gu",
);

/** Quick "looks like a path" check. PATH_RE carries the `g` flag (matchAll
 *  requires it in provideLinks), and a global regex's .test() advances
 *  lastIndex BETWEEN CALLS — the classic trap that made results depend on
 *  call order. Reset before every test. */
export function isPathLikeText(text: string): boolean {
  PATH_RE.lastIndex = 0;
  return PATH_RE.test(text);
}

/** Strip `:line` / `:line:column` suffixes when the rest resolves to a
 *  file. Returns null when the candidate is not an existing file. */
export function parseCandidate(
  raw: string,
  resolve: PathResolver,
): TerminalPathTarget | null {
  // Leading open-paren/quote rides along when the regex starts INSIDE a
  // wrapper (the branch char classes admit `(`) — "(src/main.ts)" must
  // resolve as "src/main.ts". Mirrors TRAILING_STRIP.
  let text = raw.replace(/^[([{“"']+/, "").replace(TRAILING_STRIP, "");
  if (!text || /\s/.test(text)) return null;

  // line/column suffixes (path:12 / path:12:34) — only when the file part
  // exists, so time-like strings never hijack.
  const m = text.match(/^(.*?)(?::)(\d{1,5})(?::(\d{1,5}))?$/);
  if (m && m[1] && !/[\\/]\d+$/.test(m[1])) {
    const candidate = m[1];
    const line = Number(m[2]);
    const column = m[3] ? Number(m[3]) : undefined;
    if (resolve({ path: candidate, line, column })) {
      return { path: candidate, line, column };
    }
  }
  if (resolve({ path: text })) return { path: text };
  return null;
}

/**
 * Map each STRING index of a translated line to its CELL column. The link
 * range must be in cell coordinates, but string indices are NOT cell
 * columns: a CJK glyph occupies TWO cells while translating to ONE string
 * char (and wide-char continuation cells translate to ""), so a path
 * preceded by N Chinese chars had its underline drifting N cells left —
 * the exact "underline offset to the upper-left" bug. Walking the cells
 * and accumulating getChars() lengths rebuilds the correspondence
 * translateToString assembled.
 */
export function buildStringToCellMap(line: IBufferLine, textLength: number): Int32Array {
  const map = new Int32Array(textLength + 1);
  let si = 0;
  for (let x = 0; x < line.length && si < textLength; x++) {
    const cell = line.getCell(x);
    if (!cell) break;
    const chars = cell.getChars();
    if (!chars) continue; // wide-char continuation cell: consumed, no string char
    for (let k = 0; k < chars.length && si + k <= textLength; k++) {
      map[si + k] = x;
    }
    si += chars.length;
  }
  return map;
}

/** Build the link provider. `resolve` comes from the host: the renderer has
 *  no fs access, so existence checks run in main via the `terminal.resolvePath`
 *  RPC (terminal.ts) — the sync resolve() answer may be a false "not yet"
 *  while the async lookup is in flight, so MISSES ARE NEVER CACHED: a cached
 *  null would poison the key forever (the pre-warmed async result would
 *  never be consulted and the link would never appear). Misses simply re-run
 *  the next scan; the host-side inflight/pathCache dedupe keeps repeats cheap. */
export function createFileLinkProvider(
  terminal: Terminal,
  resolve: PathResolver,
  onOpen: (target: TerminalPathTarget, event: MouseEvent) => void,
): ILinkProvider {
  const cache = new Map<string, TerminalPathTarget>();

  function findTarget(text: string): TerminalPathTarget | null {
    const hit = cache.get(text);
    if (hit) return hit;
    const target = parseCandidate(text, resolve);
    // Positive results only — see the header comment for why nulls must
    // not be cached.
    if (target) {
      cache.set(text, target);
      if (cache.size > 500) cache.clear();
    }
    return target;
  }

  return {
    provideLinks(bufferLineNumber, callback) {
      // provideLinks hands us a 1-BASED buffer line, but getLine indexes
      // 0-based (xterm's own OscLinkProvider does lines.get(e-1)). Fetching
      // the line one-below made the link paint one line ABOVE its path —
      // the "underline above the text" bug.
      const line = terminal.buffer.active.getLine(bufferLineNumber - 1);
      if (!line) {
        callback(undefined);
        return;
      }
      const text = line.translateToString(true);
      if (!text) {
        callback(undefined);
        return;
      }

      const links: ILink[] = [];
      // Cell-coordinate map for this line — string indices and cell columns
      // diverge after any wide char (see buildStringToCellMap).
      const cellMap = buildStringToCellMap(line, text.length);
      // matchAll clones PATH_RE but seeds the clone from its CURRENT
      // lastIndex — reset so a prior .test() (isPathLikeText) can't shift
      // the scan start and silently drop matches.
      PATH_RE.lastIndex = 0;
      for (const match of text.matchAll(PATH_RE)) {
        const start = match.index ?? 0;
        const raw = match[0];
        const target = findTarget(raw);
        if (!target) continue;
        // Line/column ride the same link: extend the range across the
        // `:12` / `:12:34` suffix directly following the match.
        let end = start + raw.length;
        const suffix = text.slice(end).match(/^:(\d{1,5})(?::(\d{1,5}))?/);
        if (suffix && target.path === (raw.replace(TRAILING_STRIP, ""))) {
          end += suffix[0].length;
        }
        // Convert string indices → CELL columns (1-based, inclusive end).
        const startX = (cellMap[start] ?? start) + 1;
        const endX = (cellMap[Math.max(end - 1, start)] ?? end - 1) + 1;
        links.push({
          range: {
            start: { x: startX, y: bufferLineNumber },
            end: { x: endX, y: bufferLineNumber },
          },
          text: text.slice(start, end),
          activate: (_e: MouseEvent | undefined, linkText: string) => {
            // Re-resolve at actuation (cache first) — never a dead click.
            // linkText ?? "" : xterm always passes the link text, but a
            // missing arg must fall through to the closure target below
            // rather than crash on parseCandidate(undefined).
            const t = findTarget(linkText ?? "") ?? findTarget(target.path) ?? target;
            if (t) onOpen(t, _e ?? (new MouseEvent("click")));
          },
        });
      }
      callback(links.length > 0 ? links : undefined);
    },
  };
}
