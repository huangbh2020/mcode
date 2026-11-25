/**
 * Model-emitted file citations: `::zcode-file-citation{path="…" purpose="output"}`.
 *
 * Some third-party models behind custom endpoints (GLM, MiniMax — first seen
 * 2026-11-24) cite the files they produced or read with the inline markup of
 * the agent harness they were trained on. It reaches Mcode as plain assistant
 * text, and nothing here understood it: the user read the raw braces, and
 * Markdown mangled the path inside them (a backslash before `.`, `_`, `[`,
 * `(` … is an escape; a backtick opens a code span).
 *
 * So citations are lifted out of the markdown BEFORE it is parsed — each one
 * swapped for a placeholder Markdown cannot touch (`preprocessFileCitations`)
 * — and put back as clickable chips after (the rehype plugin in
 * markdownFileCitations.ts). `splitTextByFileCitations` is the one scanner
 * everything builds on; `flattenFileCitations` turns the markup into plain
 * paths for the clipboard and other raw-text surfaces.
 *
 * Grammar, as lenient as the output it has to survive:
 *
 *   ::zcode-file-citation{key="value" …}
 *   │                      └ double-quoted attributes; `path` is required,
 *   │                        `purpose` is output | source, and
 *   │                        artifact_kind / sheet / range describe a
 *   │                        data-source excerpt
 *   └ a single colon is accepted too — "来源：:zcode-file-citation{…}" was
 *     seen with a full-width colon in the prose and one ASCII colon starting
 *     the directive
 *
 * Only this exact name is matched: the same `::name{…}` shape is CSS
 * pseudo-element syntax (`::before{…}`), and stored replies are full of it.
 * Directives inside code (fenced blocks, inline code) are left alone — that
 * is the model showing the syntax, not citing a file.
 *
 * Pure string functions, no React / DOM: the smoke script bundles them as is.
 */

/** The one directive name this module recognises. */
export const FILE_CITATION_NAME = "zcode-file-citation";

export interface FileCitation {
  /** Path exactly as cited, apart from the two repairs in `decodeValue`. */
  path: string;
  /** `output` — the agent produced or changed the file; `source` — it read
   *  it. Anything else passes through; absent when the model omitted it. */
  purpose: string | undefined;
  artifactKind: string | undefined;
  /** Workbook sheet the citation points into (`artifact_kind="workbook"`). */
  sheet: string | undefined;
  /** Cell range inside that sheet (`A1:E91`). */
  range: string | undefined;
}

export type FileCitationSegment =
  | { kind: "text"; text: string }
  | { kind: "citation"; citation: FileCitation }
  /** Always the last segment: a directive that is still arriving, or one the
   *  model never closed. The caller decides whether to hide or show it. */
  | { kind: "partial"; text: string };

/** `[start, end)` character range. */
type Range = [number, number];

/** Directive opening: one or two ASCII colons, the name, optional blank
 *  space, `{`. Two colons match greedily, so `::name` is taken whole and a
 *  colon run of three leaves the extra one as text. */
const DIRECTIVE_START_RE = /:{1,2}zcode-file-citation[ \t]*\{/g;

/** `key="…"`, `key='…'` or `key=bare`. A double-quoted value may carry
 *  backslash escapes; a bare one stops at whitespace or a quote. */
const ATTRIBUTE_RE = /([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([^\s"'{}]+))/g;

/** A colon run at the very end of the text followed by letters/hyphens only. */
const TRAILING_NAME_RE = /:{1,2}([A-Za-z-]*)$/;

const BACKTICK_RUN_RE = /`+/g;
const BLANK_LINE_RE = /\n[ \t]*\n/g;

/** How far into the name a trailing colon run must reach before it counts
 *  as a directive on its way (see `trailingPartialStart`). */
const PARTIAL_MIN_CHARS = 3;

/** Text that cannot hold a directive — complete or on its way — needs no
 *  scanning: no full name, and not even the first letters of one after a
 *  colon. */
function hasCandidate(text: string): boolean {
  return text.length > 0 && (text.includes(FILE_CITATION_NAME) || text.includes(`:${FILE_CITATION_NAME.slice(0, PARTIAL_MIN_CHARS)}`));
}

function inRanges(ranges: Range[], index: number): boolean {
  for (const [start, end] of ranges) {
    if (index >= start && index < end) return true;
  }
  return false;
}

/**
 * Fenced code blocks (``` / ~~~), line by line. A fence is at most three
 * spaces in from the line start; it closes on a line of the same character,
 * at least as long, with nothing but whitespace after it. A fence that never
 * closes runs to the end of the text — which is also the state of a block
 * that is still streaming.
 */
function fencedCodeRanges(text: string): Range[] {
  const ranges: Range[] = [];
  let open: { ch: string; len: number; start: number } | null = null;
  let lineStart = 0;
  for (;;) {
    let lineEnd = text.indexOf("\n", lineStart);
    const last = lineEnd === -1;
    if (last) lineEnd = text.length;
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(text.slice(lineStart, lineEnd));
    if (m) {
      const ch = m[1][0];
      const len = m[1].length;
      if (!open) {
        open = { ch, len, start: lineStart };
      } else if (
        ch === open.ch &&
        len >= open.len &&
        text.slice(lineStart + m[0].length, lineEnd).trim() === ""
      ) {
        ranges.push([open.start, last ? lineEnd : lineEnd + 1]);
        open = null;
      }
    }
    if (last) break;
    lineStart = lineEnd + 1;
  }
  if (open) ranges.push([open.start, text.length]);
  return ranges;
}

/**
 * Inline code spans (`` `…` ``), outside the fenced blocks. A backtick run
 * is closed by the next run of the same length; a run that never closes is
 * literal text, as in Markdown. Spans cannot cross a blank line, so runs are
 * paired paragraph by paragraph.
 */
function inlineCodeRanges(text: string, fenced: Range[]): Range[] {
  const ranges: Range[] = [];
  let paraStart = 0;
  for (;;) {
    BLANK_LINE_RE.lastIndex = paraStart;
    const blank = BLANK_LINE_RE.exec(text);
    const paraEnd = blank ? blank.index : text.length;
    const open: Array<{ len: number; start: number }> = [];
    BACKTICK_RUN_RE.lastIndex = paraStart;
    for (let m = BACKTICK_RUN_RE.exec(text); m && m.index < paraEnd; m = BACKTICK_RUN_RE.exec(text)) {
      // An escaped backtick and one inside a fence are not delimiters.
      if (inRanges(fenced, m.index) || text[m.index - 1] === "\\") continue;
      const len = m[0].length;
      const k = open.findIndex((o) => o.len === len);
      if (k === -1) {
        open.push({ len, start: m.index });
      } else {
        ranges.push([open[k].start, m.index + len]);
        open.splice(k, 1);
      }
    }
    if (!blank) break;
    paraStart = blank.index + blank[0].length;
  }
  return ranges;
}

/**
 * Index of the `}` closing the body that starts just after `openBrace`, or
 * -1 when the body is never closed. Braces inside double quotes are data (a
 * path may contain them); so is a backslash-escaped quote.
 */
function findBodyEnd(text: string, openBrace: number): number {
  // Depth counts the `{` the caller already consumed.
  let depth = 1;
  let quoted = false;
  for (let i = openBrace; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === "\\") i++;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i;
  }
  return -1;
}

/** A quoted attribute value as a path: `\"` is an escaped quote. Models
 *  sometimes emit the value JSON-escaped (`D:\\x\\y`) although the text
 *  around it is not — doubled separators right after a drive letter are
 *  undone, since no real path has them there. Other backslashes are kept:
 *  `\\server\share` is a real UNC prefix. */
function decodeValue(value: string): string {
  let s = value.replace(/\\"/g, '"');
  if (/^[A-Za-z]:(\\\\)/.test(s)) s = s.replace(/\\\\/g, "\\");
  return s.trim();
}

function parseAttributes(body: string): FileCitation | null {
  let path = "";
  let purpose: string | undefined;
  let artifactKind: string | undefined;
  let sheet: string | undefined;
  let range: string | undefined;
  ATTRIBUTE_RE.lastIndex = 0;
  for (let m = ATTRIBUTE_RE.exec(body); m !== null; m = ATTRIBUTE_RE.exec(body)) {
    const value = m[2] !== undefined ? decodeValue(m[2]) : (m[3] ?? m[4] ?? "").trim();
    switch (m[1].toLowerCase()) {
      case "path":
        if (!path) path = value;
        break;
      case "purpose":
        purpose ??= value;
        break;
      case "artifact_kind":
        artifactKind ??= value;
        break;
      case "sheet":
        sheet ??= value;
        break;
      case "range":
        range ??= value;
        break;
      default:
        // Unknown attributes (and anything the model invents later) are ignored.
        break;
    }
  }
  // No path, no citation: the text stays as it is.
  return path ? { path, purpose, artifactKind, sheet, range } : null;
}

/** Where a still-arriving directive begins at the end of `text` — its name
 *  is incomplete (`…来源：:zcode-fi`), or complete but the `{` has not landed.
 *  -1 when the text does not end that way. */
function trailingPartialStart(text: string): number {
  const m = TRAILING_NAME_RE.exec(text);
  if (!m) return -1;
  const tail = m[1];
  // A shorter tail is far more likely a sentence ending in an ASCII colon
  // that the next token completes — hiding that would make the colon blink
  // in and out while the reply streams.
  return tail.length >= PARTIAL_MIN_CHARS && FILE_CITATION_NAME.startsWith(tail) ? m.index : -1;
}

/**
 * Split text into plain text, citations and (at most, at the end) one
 * unfinished directive. The segments concatenate back to the input exactly.
 * Empty input yields [].
 */
export function splitTextByFileCitations(text: string): FileCitationSegment[] {
  if (!text) return [];
  if (!hasCandidate(text)) return [{ kind: "text", text }];

  const fenced = fencedCodeRanges(text);
  const inline = text.includes("`") ? inlineCodeRanges(text, fenced) : [];
  const inCode = (index: number) => inRanges(fenced, index) || inRanges(inline, index);

  const out: FileCitationSegment[] = [];
  let last = 0;
  DIRECTIVE_START_RE.lastIndex = 0;
  for (let m = DIRECTIVE_START_RE.exec(text); m !== null; m = DIRECTIVE_START_RE.exec(text)) {
    const start = m.index;
    if (inCode(start)) continue;
    const bodyEnd = findBodyEnd(text, start + m[0].length);
    if (bodyEnd === -1) {
      if (start > last) out.push({ kind: "text", text: text.slice(last, start) });
      out.push({ kind: "partial", text: text.slice(start) });
      return out;
    }
    const citation = parseAttributes(text.slice(start + m[0].length, bodyEnd));
    // Not a usable citation (no path): leave it in the text and keep looking.
    if (!citation) continue;
    if (start > last) out.push({ kind: "text", text: text.slice(last, start) });
    out.push({ kind: "citation", citation });
    last = bodyEnd + 1;
    DIRECTIVE_START_RE.lastIndex = last;
  }

  const rest = text.slice(last);
  const partialAt = trailingPartialStart(rest);
  if (partialAt >= 0) {
    if (partialAt > 0) out.push({ kind: "text", text: rest.slice(0, partialAt) });
    out.push({ kind: "partial", text: rest.slice(partialAt) });
  } else if (rest) {
    out.push({ kind: "text", text: rest });
  }
  return out;
}

/** The excerpt a citation points at, in spreadsheet notation:
 *  `<sheet>!<range>`, or whichever of the two is present. "" for a plain file. */
export function fileCitationLocation(citation: FileCitation): string {
  return [citation.sheet, citation.range].filter(Boolean).join("!");
}

/** Plain-text stand-in for a citation: the path, plus the excerpt in parentheses. */
function citeAsText(citation: FileCitation): string {
  const location = fileCitationLocation(citation);
  return location ? `${citation.path} (${location})` : citation.path;
}

/**
 * Replace citations with what they mean — the path — for the clipboard and
 * other raw-text surfaces. Returns the input itself when it has none, so
 * callers can keep feeding a stable string to memoized consumers.
 */
export function flattenFileCitations(text: string): string {
  if (!hasCandidate(text)) return text;
  const segments = splitTextByFileCitations(text);
  if (segments.length === 1 && segments[0].kind === "text") return text;
  return segments
    .map((s) => (s.kind === "citation" ? citeAsText(s.citation) : s.text))
    .join("");
}

/**
 * Private-use sentinels around a citation's index. Markdown has no syntax
 * involving U+E000/U+E001, so the placeholder survives parsing untouched
 * and is restored by the rehype plugin.
 */
const PLACEHOLDER_START = "\uE000";
const PLACEHOLDER_END = "\uE001";

/** Matches a placeholder; group 1 is the citation index. */
export const FILE_CITATION_PLACEHOLDER_RE = new RegExp(`${PLACEHOLDER_START}(\\d+)${PLACEHOLDER_END}`, "g");

export interface PreprocessedCitations {
  /** The markdown with citations swapped for placeholders. */
  text: string;
  /** Citations in order of their placeholders. */
  citations: FileCitation[];
}

const NO_CITATIONS: FileCitation[] = [];

/**
 * Lift the citations out of a markdown source so it can be parsed safely.
 * `hideTrailingPartial` (set while the block is streaming) drops a directive
 * that is still arriving instead of letting its raw markup flash by; once
 * streaming ends the caller leaves it set to false, so a directive the model
 * genuinely never closed stays visible instead of silently vanishing.
 */
export function preprocessFileCitations(
  markdown: string,
  opts: { hideTrailingPartial?: boolean } = {},
): PreprocessedCitations {
  const segments = splitTextByFileCitations(markdown);
  if (segments.length === 1 && segments[0].kind === "text") return { text: markdown, citations: NO_CITATIONS };

  let text = "";
  const citations: FileCitation[] = [];
  for (const segment of segments) {
    if (segment.kind === "text") {
      text += segment.text;
    } else if (segment.kind === "citation") {
      text += PLACEHOLDER_START + citations.length + PLACEHOLDER_END;
      citations.push(segment.citation);
    } else if (!opts.hideTrailingPartial) {
      text += segment.text;
    }
  }
  return { text, citations };
}
