/**
 * IPC handlers for filesystem operations crossing the main↔renderer boundary.
 *
 * The renderer runs under contextIsolation and has no filesystem access of
 * its own. Three channels live here, all sharing one security rule: every
 * path MUST resolve inside a known project root. We never trust a
 * caller-supplied cwd; instead we scan all persisted projects and accept a
 * root that contains the path (for read/write) or that matches the supplied
 * `projectPath` exactly (for dir listing, where the caller already knows the
 * root). A path that escapes every project root — or a read/write failure —
 * degrades gracefully (empty listing / empty content / `ok: false`) rather
 * than throwing into the renderer.
 *
 * Channels:
 *  - `file:readFile`  — single-file utf-8 read (diff card, Monaco editor)
 *  - `file:listDir`   — one-level directory listing for the file tree
 *  - `file:search`    — recursive file search for composer @ / add-context
 *  - `file:writeFile` — utf-8 write with parent-dir creation (Monaco save)
 *  - `file:mkdir`     — recursive directory creation (file-tree 新建文件夹)
 *  - `file:delete`    — trash a file or directory (file-tree 删除, recoverable)
 *  - `file:rename`    — in-place rename, same parent dir (file-tree 重命名)
 */
import type { IpcMain } from "electron";
import { app, clipboard, nativeImage, shell } from "electron";
import { readFile, writeFile, readdir, mkdir, rename, access, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { TextDecoder } from "node:util";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  IPC,
  FileReadSchema,
  FileReadBinarySchema,
  FileListDirSchema,
  FileSearchSchema,
  FileWriteSchema,
  FileMkdirSchema,
  FileDeleteSchema,
  FileRenameSchema,
  FileGrepSchema,
  ClipboardSaveFileSchema,
  ClipboardWriteImageSchema,
} from "@contracts/ipc";
import type {
  FileSearchEntry,
  FileTreeEntry,
  FileGrepEntry,
  FileSearchInput,
  FileGrepInput,
  FileSearchResult,
  FileGrepResult,
} from "@contracts/ipc";
import { ProjectRepo } from "@main/store/repositories.js";
import { log } from "@main/lib/logger.js";

/** Compare two filesystem paths for equality after normalizing (resolving
 *  `.`, `..`, redundant separators, and trailing separators). Used instead of
 *  raw `===` when matching a caller-supplied projectPath against persisted
 *  Project.path values — the folder picker and the DB can disagree on trivial
 *  formatting (e.g. a trailing `/` on macOS) which would otherwise cause a
 *  silent "unknown projectPath" refusal. */
function samePath(a: string, b: string): boolean {
  return resolve(a) === resolve(b);
}

/** True if `abs` is inside `root` (or equals it), after normalizing both.
 *  This is the containment check used by the read/write/list handlers to
 *  enforce the project-root security boundary. Uses `resolve` + a
 *  separator-aware prefix check so "/foo/bar" doesn't match root "/foo/ba". */
function pathWithin(root: string, abs: string): boolean {
  const r = resolve(root);
  const a = resolve(abs);
  if (a === r) return true;
  // Ensure the root ends with a separator so "/foo/bar" doesn't match "/foo/ba".
  return a.startsWith(r + sep);
}

/** True if `abs` sits inside the clipboard-paste temp dir (see the
 *  `clipboard:saveFile` handler). Files there were written by THIS app from
 *  user pastes (images/files copied into the composer), so reads are allowed
 *  even though the dir sits outside every project root — the IDE editor needs
 *  it to open/preview pasted files. Writes stay guarded as before. */
function isPasteTempPath(abs: string): boolean {
  const dir = join(app.getPath("temp"), "mcode-pastes");
  return resolve(abs).startsWith(resolve(dir) + sep);
}

/** Directory/file names hidden from the file tree. These are build artifacts
 *  or VCS internals the user never wants to click through. Kept as a Set for
 *  O(1) lookup during listing. Dotfiles are NOT hidden — users expect to see
 *  `.env`, `.eslintrc`, etc. The search + grep walks share this list (both
 *  runs of the keep-out list also include common virtualenv / package-cache
 *  dirs that would otherwise eat the whole traversal budget on big repos). */
const IGNORED_ENTRIES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".cache",
  ".turbo",
  ".vercel",
  "coverage",
  ".sass-cache",
  "__pycache__",
  ".DS_Store",
  "out",
  "target",
  ".venv",
  "venv",
  ".gradle",
  ".idea",
  ".svn",
  ".hg",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".eslintcache",
  "Pods",
  ".yarn",
  ".pnpm-store",
  "__MACOSX",
]);

/** File extensions that are always binary - skipped by `file:grep` without
 *  even opening the file. Cheaper than the null-byte sniff for obvious cases.
 *  Lowercase, no leading dot. */
const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "tiff", "svgz",
  "zip", "gz", "tar", "rar", "7z", "bz2", "xz",
  "woff", "woff2", "ttf", "otf", "eot",
  "pdf", "exe", "dll", "so", "dylib", "class", "jar", "wasm",
  "mp3", "mp4", "webm", "avi", "mov", "ogg", "flac", "wav",
  "sqlite", "db",
]);

/** NUL-byte sniff window for text/binary discrimination. We only look at the
 *  first chunk — reading a whole large file just to reject it is wasteful.
 *  Used by `decodeTextBuffer` (below), which replaces the old plain NUL check
 *  so real UTF-16 text files (which legitimately contain NUL bytes) are no
 *  longer thrown away as binary. */
const SNIFF_BYTES = 8192;

/** Upper bound for a single file scanned by `file:grep`. Larger files are
 *  skipped (with a WARN) — decoding + line-splitting a multi-GB dump would
 *  stall the main process. 32MB covers every realistic source/log file. */
const MAX_GREP_FILE_BYTES = 32 * 1024 * 1024;

/** Decoders for `file:grep`. UTF-8 variants are the common case; the BOM
 *  variant strips the BOM so the first line doesn't start with U+FEFF. The
 *  GBK fallback is what makes CJK search work on the Windows ANSI files a
 *  Chinese dev machine accumulates (see `decodeTextBuffer`). */
const UTF8_DECODER = new TextDecoder("utf-8");
const UTF8_STRICT = new TextDecoder("utf-8", { fatal: true });
const UTF16LE = new TextDecoder("utf-16le");
const UTF16BE = new TextDecoder("utf-16be");
let GBK: TextDecoder | null | undefined;

function gbkDecoder(): TextDecoder | null {
  if (GBK !== undefined) return GBK;
  try {
    GBK = new TextDecoder("gbk");
  } catch {
    // Not all ICU builds ship GBK; search degrades to UTF-8 in that case.
    GBK = null;
  }
  return GBK;
}

/** True if any of the first `SNIFF_BYTES` bytes of `buf` is NUL. */
function hasNulByte(buf: Buffer): boolean {
  const len = Math.min(buf.length, SNIFF_BYTES);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/** UTF-16 LE/BE detection for BOM-less files. Real "Unicode" text files
 *  mostly contain ASCII (structural chars, spacing) whose UTF-16 encoding
 *  puts a NUL in every other byte — that pattern is what we exploit. A
 *  BOM-less all-CJK UTF-16 file has no NULs at all and stays undetected
 *  (it would need a language model to guess); those are extremely rare. */
function looksUtf16Le(buf: Buffer): boolean {
  const n = Math.min(buf.length, 4096) & ~1;
  if (n < 4) return false;
  let pairs = 0;
  let nulOdd = 0;
  for (let i = 0; i < n; i += 2) {
    pairs += 1;
    if (buf[i + 1] === 0) nulOdd += 1;
  }
  return nulOdd >= pairs * 0.6;
}

function looksUtf16Be(buf: Buffer): boolean {
  const n = Math.min(buf.length, 4096) & ~1;
  if (n < 4) return false;
  let pairs = 0;
  let nulEven = 0;
  for (let i = 0; i < n; i += 2) {
    pairs += 1;
    if (buf[i] === 0) nulEven += 1;
  }
  return nulEven >= pairs * 0.6;
}

/**
 * Decode a raw file buffer for content search; null means "binary, skip".
 * The old path (`buf.toString("utf-8")` after a raw NUL sniff) had two blind
 * spots that made real files unfindable:
 *  - UTF-16 text (Windows Notepad "Unicode") contains NUL bytes, so the
 *    sniff classified it as binary and skipped it entirely;
 *  - GBK/GB2312 ANSI files (the default encoding for CJK on older Windows
 *    tools) are byte-invalid UTF-8, so the lossy decode produced mojibake and
 *    every non-ASCII query missed.
 * Order is: BOM → UTF-16 NUL pattern → strict UTF-8 → GBK. Only bytes that
 * fail all of these (and aren't NUL-pattern UTF-16) are treated as binary.
 */
function decodeTextBuffer(buf: Buffer): string | null {
  if (buf.length === 0) return "";
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return UTF8_DECODER.decode(buf.subarray(3));
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return UTF16LE.decode(buf.subarray(2));
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return UTF16BE.decode(buf.subarray(2));
  }
  if (hasNulByte(buf)) {
    if (looksUtf16Le(buf)) return UTF16LE.decode(buf);
    if (looksUtf16Be(buf)) return UTF16BE.decode(buf);
    return null;
  }
  try {
    return UTF8_STRICT.decode(buf);
  } catch {
    const gbk = gbkDecoder();
    if (gbk) return gbk.decode(buf);
    // ICUI-less build: fall back to the old lossy decode rather than skipping.
    return UTF8_DECODER.decode(buf);
  }
}

/** Extract the lowercase extension (no dot) from a filename, or "" if none. */
function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  if (i <= 0 || i === name.length - 1) return "";
  return name.slice(i + 1).toLowerCase();
}

/** MIME types for the binary/image extensions we expect to serve as data
 *  URLs. Unknown extensions fall back to application/octet-stream (the <img>
 *  will fail to render and the pane shows its error state - intended). */
const BINARY_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  webp: "image/webp",
  svg: "image/svg+xml",
  tif: "image/tiff",
  tiff: "image/tiff",
  avif: "image/avif",
};

/** Shared guarded single-file utf-8 read — used by both the desktop IPC
 *  handler and the mobile RPC whitelist. Scans every persisted project for a
 *  root containing the path; clipboard-paste temp files (app-owned) are
 *  allowed outside projects. Degrades to empty content instead of throwing. */
export async function readFileGuarded(filePath: string): Promise<{ content: string }> {
  const root = ProjectRepo.listPaths().find((p) => pathWithin(p, filePath));
  if (!root && !isPasteTempPath(filePath)) {
    log.warn(`file.readFile refused — path outside any project root: ${filePath}`);
    return { content: "" };
  }
  try {
    const content = await readFile(filePath, "utf-8");
    return { content };
  } catch (err) {
    // ENOENT (file gone), EACCES, or binary content that isn't valid utf-8.
    log.warn(`file.readFile failed for ${filePath}: ${(err as Error).message}`);
    return { content: "" };
  }
}

/** Shared guarded binary read (base64 data URL) — same boundary as
 *  {@link readFileGuarded}. */
export async function readBinaryGuarded(filePath: string): Promise<{ dataUrl: string }> {
  const root = ProjectRepo.listPaths().find((p) => pathWithin(p, filePath));
  if (!root && !isPasteTempPath(filePath)) {
    log.warn(`file.readBinary refused - path outside any project root: ${filePath}`);
    return { dataUrl: "" };
  }
  try {
    const buf = await readFile(filePath);
    const ext = extOf(basename(filePath));
    const mime = BINARY_MIME[ext] ?? "application/octet-stream";
    // For SVG (text/XML), decode to a utf-8 string and embed directly - avoids
    // base64 bloat and renders identically in <img>.
    if (mime === "image/svg+xml") {
      const text = buf.toString("utf-8");
      return { dataUrl: `data:${mime};utf8,${encodeURIComponent(text)}` };
    }
    const b64 = buf.toString("base64");
    return { dataUrl: `data:${mime};base64,${b64}` };
  } catch (err) {
    log.warn(`file.readBinary failed for ${filePath}: ${(err as Error).message}`);
    return { dataUrl: "" };
  }
}

/** Shared guarded one-level directory listing — used by both the desktop IPC
 *  handler and the mobile RPC whitelist. `projectPath` must match a persisted
 *  Project root; `dirPath` is resolved against it and must stay inside. */
export async function listDirGuarded(
  projectPath: string,
  dirPath: string,
): Promise<{ entries: FileTreeEntry[] }> {
  const known = ProjectRepo.listPaths().some((p) => samePath(p, projectPath));
  if (!known) {
    log.warn(`file.listDir refused — unknown projectPath: ${projectPath}`);
    return { entries: [] };
  }
  const abs = resolve(projectPath, dirPath || ".");
  if (!pathWithin(projectPath, abs)) {
    log.warn(
      `file.listDir refused — dirPath escapes project root: ${dirPath} (root: ${projectPath})`,
    );
    return { entries: [] };
  }
  try {
    const dirents = await readdir(abs, { withFileTypes: true });
    const entries: FileTreeEntry[] = [];
    for (const d of dirents) {
      if (IGNORED_ENTRIES.has(d.name)) continue;
      // Skip broken symlinks (isDirectory throws ENOENT on dangling links).
      let isDir: boolean;
      try {
        isDir = d.isDirectory();
      } catch {
        continue;
      }
      const fullPath = join(abs, d.name);
      entries.push({
        name: d.name,
        path: fullPath,
        isDir,
      });
    }
    // Sort: directories first, then alphabetically (case-insensitive).
    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
    return { entries };
  } catch (err) {
    // Directory gone, not a directory, or EACCES — degrade to empty.
    log.warn(`file.listDir failed for ${abs}: ${(err as Error).message}`);
    return { entries: [] };
  }
}

/** Walk budget shared by `file.search` and `file.grep`. The original 12/8000
 *  caps silently stopped mid-tree on monorepos with deep package layouts or
 *  vendored dependencies — matches below the cut were simply never seen, and
 *  the user got "the file exists but search can't find it". Raised well above
 *  realistic source trees; when a walk still runs out of budget the result
 *  carries `incompleteScan: true` so the renderer can say the results may be
 *  partial instead of presenting an incomplete scan as exhaustive. */
const SEARCH_MAX_DEPTH = 32;
const SEARCH_MAX_VISIT = 50000;

/** Stable per-level ordering for the recursive walks: directories first, then
 *  case-insensitive alphabetical (keeps results deterministic). */
function sortDirents(dirents: Dirent[]): void {
  dirents.sort((a, b) => {
    const aDir = a.isDirectory();
    const bDir = b.isDirectory();
    if (aDir !== bDir) return aDir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

interface WalkFile {
  name: string;
  /** Absolute filesystem path. */
  abs: string;
  /** Project-relative path with forward slashes. */
  relPath: string;
}

/** Enumerate every non-ignored file under `root`, shallow-first, bounded by
 *  {@link SEARCH_MAX_DEPTH}/{@link SEARCH_MAX_VISIT}. `incompleteScan` is set
 *  when the budget ran out before the tree was exhausted — callers must
 *  surface that, or an incomplete result looks authoritative. */
async function collectTreeFiles(
  root: string,
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
      if (IGNORED_ENTRIES.has(d.name)) continue;
      let isDir: boolean;
      try {
        isDir = d.isDirectory();
      } catch {
        continue; // Skip broken symlinks.
      }
      const fullPath = join(abs, d.name);
      if (!pathWithin(root, fullPath)) continue;
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

/** Relevance rank for name-search results: lower is better. Exact basename
 *  match beats a basename prefix, which beats a basename substring, which
 *  beats a path-only substring. The old result order was pure BFS (shallow
 *  dirs, alphabetical) — with a common query the file the user actually
 *  meant could sit past the result cap while unrelated hits filled the list. */
function rankFileMatch(name: string, relPath: string, query: string): number {
  const bn = name.toLowerCase();
  if (bn === query) return 0;
  if (bn.startsWith(query)) return 1;
  if (bn.includes(query)) return 2;
  return relPath.includes(query) ? 3 : 4;
}

/** Guarded recursive file search (project-root containment + hard depth /
 *  visit caps). Shared by the desktop `file:search` IPC handler and the
 *  mobile RPC whitelist so both transports behave identically. Non-empty
 *  queries return relevance-ranked matches (exact name / prefix first) sliced
 *  to `limit`, with `truncated`/`incompleteScan` telling the renderer when
 *  the slice or the walk hid real matches. */
export async function searchFilesGuarded(
  input: FileSearchInput,
): Promise<FileSearchResult> {
  const known = ProjectRepo.listPaths().some((p) => samePath(p, input.projectPath));
  if (!known) {
    log.warn(`file.search refused — unknown projectPath: ${input.projectPath}`);
    return { files: [], truncated: false, incompleteScan: false };
  }
  const root = resolve(input.projectPath);
  const limit = input.limit ?? 80;
  const query = (input.query ?? "").trim().toLowerCase();

  // Empty query: keep the legacy shallow BFS sample (stops at `limit`) — the
  // @-mention picker wants an instant initial list, and walking 50k entries
  // just to show a sample would be a regression. A sample is the contract
  // here, so neither truncation flag is meaningful for it.
  if (!query) {
    const files: FileSearchEntry[] = [];
    let visited = 0;
    const queue: Array<{ abs: string; depth: number }> = [{ abs: root, depth: 0 }];
    while (queue.length > 0 && files.length < limit && visited < SEARCH_MAX_VISIT) {
      const { abs, depth } = queue.shift()!;
      let dirents;
      try {
        dirents = await readdir(abs, { withFileTypes: true });
      } catch {
        continue;
      }
      sortDirents(dirents);
      for (const d of dirents) {
        if (files.length >= limit || visited >= SEARCH_MAX_VISIT) break;
        if (IGNORED_ENTRIES.has(d.name)) continue;
        let isDir: boolean;
        try {
          isDir = d.isDirectory();
        } catch {
          continue;
        }
        const fullPath = join(abs, d.name);
        if (!pathWithin(root, fullPath)) continue;
        visited += 1;
        if (isDir) {
          if (depth + 1 <= SEARCH_MAX_DEPTH) queue.push({ abs: fullPath, depth: depth + 1 });
          continue;
        }
        let rel: string;
        try {
          rel = relative(root, fullPath).split(/[/\\]/).join("/");
        } catch {
          rel = d.name;
        }
        files.push({ name: d.name, path: fullPath, relativePath: rel });
      }
    }
    return { files, truncated: false, incompleteScan: false };
  }

  // Query path: walk the whole tree once, filter, rank by relevance, slice to
  // `limit`. Collecting before ranking is what lets exact-name / prefix
  // matches surface instead of being buried by BFS order; `truncated` reports
  // when the slice hid real matches.
  const { files: allFiles, incompleteScan } = await collectTreeFiles(root);
  const hits: FileSearchEntry[] = [];
  for (const f of allFiles) {
    const hay = `${f.name}\n${f.relPath}`.toLowerCase();
    if (!hay.includes(query)) continue;
    hits.push({ name: f.name, path: f.abs, relativePath: f.relPath });
  }
  hits.sort((a, b) => {
    const ra = rankFileMatch(a.name, a.relativePath, query);
    const rb = rankFileMatch(b.name, b.relativePath, query);
    if (ra !== rb) return ra - rb;
    const la = a.relativePath.length;
    const lb = b.relativePath.length;
    if (la !== lb) return la - lb;
    return a.relativePath.localeCompare(b.relativePath, undefined, { sensitivity: "base" });
  });
  const truncated = hits.length > limit;
  return { files: hits.slice(0, limit), truncated, incompleteScan };
}

/** Guarded recursive content search (line-level matches). Shared by the
 *  desktop `file:grep` IPC handler; walks the same ignored-dir-filtered tree
 *  and visit/depth caps as `file:search`, decodes each file via
 *  `decodeTextBuffer` (UTF-8 / UTF-16 / GBK, binary skipped), and returns
 *  line-level matches. `truncated` reports the match cap being reached;
 *  `incompleteScan` reports the walk budget running out — both prevent an
 *  incomplete result from masquerading as exhaustive. */
export async function grepFilesGuarded(input: FileGrepInput): Promise<FileGrepResult> {
  const known = ProjectRepo.listPaths().some((p) => samePath(p, input.projectPath));
  if (!known) {
    log.warn(`file.grep refused - unknown projectPath: ${input.projectPath}`);
    return { matches: [], truncated: false, incompleteScan: false };
  }
  const root = resolve(input.projectPath);
  const limit = input.limit ?? 200;
  const maxPerFile = input.maxResultsPerFile ?? 10;
  const query = input.query;
  const needle = input.caseSensitive ? query : query.toLowerCase();

  const matches: FileGrepEntry[] = [];
  let visited = 0;
  let incompleteScan = false;

  /** BFS walk mirroring `file:search` so shallow files are scanned first. */
  const queue: Array<{ abs: string; depth: number }> = [{ abs: root, depth: 0 }];

  while (queue.length > 0 && matches.length < limit && visited < SEARCH_MAX_VISIT) {
    const { abs, depth } = queue.shift()!;
    let dirents;
    try {
      dirents = await readdir(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    sortDirents(dirents);
    for (const d of dirents) {
      if (matches.length >= limit || visited >= SEARCH_MAX_VISIT) break;
      if (IGNORED_ENTRIES.has(d.name)) continue;
      let isDir: boolean;
      try {
        isDir = d.isDirectory();
      } catch {
        continue;
      }
      const fullPath = join(abs, d.name);
      if (!pathWithin(root, fullPath)) continue;
      visited += 1;
      if (isDir) {
        if (depth + 1 <= SEARCH_MAX_DEPTH) {
          queue.push({ abs: fullPath, depth: depth + 1 });
        } else {
          incompleteScan = true;
        }
        continue;
      }
      // Skip obvious binaries by extension without opening them.
      if (BINARY_EXTENSIONS.has(extOf(d.name))) continue;

      // Size gate before reading: decoding + line-splitting a multi-hundred-
      // MB dump would stall the main process for seconds.
      let st;
      try {
        st = await stat(fullPath);
      } catch {
        continue; // ENOENT / EACCES - skip this file, keep scanning.
      }
      if (st.size > MAX_GREP_FILE_BYTES) {
        log.warn(`file.grep skipped ${fullPath}: ${st.size} bytes exceeds ${MAX_GREP_FILE_BYTES}`);
        continue;
      }

      let buf: Buffer;
      try {
        buf = await readFile(fullPath);
      } catch {
        // ENOENT / EACCES / unreadable - skip this file, keep scanning.
        log.warn(`file.grep read failed for ${fullPath}: skipping`);
        continue;
      }
      // Decode as UTF-8 / UTF-16 / GBK; null means binary content, skip.
      const text = decodeTextBuffer(buf);
      if (text === null) continue;

      let rel: string;
      try {
        rel = relative(root, fullPath).split(/[/\\]/).join("/");
      } catch {
        rel = d.name;
      }

      // Split on line boundaries; we scan the whole file but break early
      // once the per-file match cap is hit (bounds very large files).
      const lines = text.split(/\r?\n/);
      let fileHits = 0;
      for (let li = 0; li < lines.length; li++) {
        if (matches.length >= limit || fileHits >= maxPerFile) break;
        const line = lines[li];
        const hay = input.caseSensitive ? line : line.toLowerCase();
        let from = 0;
        const ranges: Array<{ start: number; end: number }> = [];
        // Find all occurrences on this line. Ranges index into the original
        // `line` (case preserved) so the frontend highlight aligns.
        for (;;) {
          const idx = hay.indexOf(needle, from);
          if (idx === -1) break;
          ranges.push({ start: idx, end: idx + query.length });
          from = idx + needle.length;
        }
        if (ranges.length > 0) {
          matches.push({
            path: fullPath,
            relativePath: rel,
            lineNumber: li + 1,
            lineText: line,
            matches: ranges,
          });
          fileHits += 1;
        }
      }
    }
  }
  if (visited >= SEARCH_MAX_VISIT) incompleteScan = true;
  return { matches, truncated: matches.length >= limit, incompleteScan };
}

export function registerFileHandlers(ipcMain: IpcMain): void {
  /* ── file:readFile — single file read, scoped to any project root ── */
  ipcMain.handle(IPC.FILE_READ, async (_evt, raw) => {
    const input = FileReadSchema.parse(raw);
    return readFileGuarded(input.filePath);
  });

  /* ── file:readBinary - read a binary file as a base64 data URL (images) ── */
  ipcMain.handle(IPC.FILE_READ_BINARY, async (_evt, raw) => {
    const input = FileReadBinarySchema.parse(raw);
    return readBinaryGuarded(input.filePath);
  });

  /* ── file:listDir — one-level directory listing for the file tree ── */
  ipcMain.handle(IPC.FILE_LIST_DIR, async (_evt, raw) => {
    const input = FileListDirSchema.parse(raw);
    return listDirGuarded(input.projectPath, input.dirPath);
  });

  /* ── file:search — recursive file search for composer @ / add-context ── */
  ipcMain.handle(IPC.FILE_SEARCH, async (_evt, raw) => {
    const input = FileSearchSchema.parse(raw);
    return searchFilesGuarded(input);
  });

  /* ── file:grep - recursive content search (line-level matches) ── */
  ipcMain.handle(IPC.FILE_GREP, async (_evt, raw) => {
    const input = FileGrepSchema.parse(raw);
    return grepFilesGuarded(input);
  });

  /* ── file:writeFile — utf-8 write, creates parent dirs, scoped to a root ── */
  ipcMain.handle(IPC.FILE_WRITE, async (_evt, raw) => {
    const input = FileWriteSchema.parse(raw);
    // Same root-scoping guard as readFile: accept the first project whose
    // root contains the target path.
    const root = ProjectRepo.listPaths().find((p) => pathWithin(p, input.filePath));
    if (!root) {
      log.warn(`file.writeFile refused — path outside any project root: ${input.filePath}`);
      return { ok: false };
    }
    try {
      // Ensure parent directory exists (Monaco may save a brand-new file).
      const parent = dirname(input.filePath);
      // Defense-in-depth: the parent must also stay inside the root. (Normal
      // dirname of an in-root path always does, but this guards edge cases.)
      if (!pathWithin(root, parent)) {
        log.warn(`file.writeFile refused — parent escapes root: ${parent}`);
        return { ok: false };
      }
      await mkdir(parent, { recursive: true });
      await writeFile(input.filePath, input.content, "utf-8");
      log.info(`file.writeFile saved: ${relative(root, input.filePath) || input.filePath}`);
      return { ok: true };
    } catch (err) {
      log.error(`file.writeFile failed for ${input.filePath}: ${(err as Error).message}`);
      return { ok: false };
    }
  });

  /* ── file:mkdir — recursive directory creation, scoped to a root ── */
  ipcMain.handle(IPC.FILE_MKDIR, async (_evt, raw) => {
    const input = FileMkdirSchema.parse(raw);
    // Same root-scoping guard as writeFile: accept the first project whose
    // root contains the target path.
    const root = ProjectRepo.listPaths().find((p) => pathWithin(p, input.dirPath));
    if (!root) {
      log.warn(`file.mkdir refused — path outside any project root: ${input.dirPath}`);
      return { ok: false };
    }
    try {
      await mkdir(input.dirPath, { recursive: true });
      log.info(`file.mkdir created: ${relative(root, input.dirPath) || input.dirPath}`);
      return { ok: true };
    } catch (err) {
      log.error(`file.mkdir failed for ${input.dirPath}: ${(err as Error).message}`);
      return { ok: false };
    }
  });

  /* ── file:delete — move a file or directory to the system trash ── */
  // Uses Electron's shell.trashItem so the user can recover the deletion from
  // the OS recycle bin / Trash. Refuses anything outside a project root.
  ipcMain.handle(IPC.FILE_DELETE, async (_evt, raw) => {
    const input = FileDeleteSchema.parse(raw);
    const root = ProjectRepo.listPaths().find((p) => pathWithin(p, input.targetPath));
    if (!root) {
      log.warn(`file.delete refused — path outside any project root: ${input.targetPath}`);
      return { ok: false };
    }
    try {
      await shell.trashItem(input.targetPath);
      log.info(`file.delete trashed: ${relative(root, input.targetPath) || input.targetPath}`);
      return { ok: true };
    } catch (err) {
      log.error(`file.delete failed for ${input.targetPath}: ${(err as Error).message}`);
      return { ok: false };
    }
  });

  /* ── file:rename — in-place rename within the same parent directory ── */
  // Both paths must resolve inside the same project root AND share the same
  // parent dir — a cross-directory move is a different operation (and a
  // foot-gun through this channel), so it's refused here.
  ipcMain.handle(IPC.FILE_RENAME, async (_evt, raw) => {
    const input = FileRenameSchema.parse(raw);
    const root = ProjectRepo.listPaths().find((p) => pathWithin(p, input.oldPath));
    if (!root) {
      log.warn(`file.rename refused — oldPath outside any project root: ${input.oldPath}`);
      return { ok: false };
    }
    // newPath must stay inside the same root.
    if (!pathWithin(root, input.newPath)) {
      log.warn(`file.rename refused — newPath escapes root: ${input.newPath}`);
      return { ok: false };
    }
    // Only allow a same-directory rename; reject cross-directory moves.
    if (dirname(input.oldPath) !== dirname(input.newPath)) {
      log.warn(
        `file.rename refused — cross-directory move (rename only): ${input.oldPath} -> ${input.newPath}`,
      );
      return { ok: false };
    }
    // No-op rename (same path) — nothing to do, report success.
    if (input.oldPath === input.newPath) {
      return { ok: true };
    }
    try {
      // POSIX `rename` silently overwrites an existing destination, which would
      // silently clobber a sibling. Refuse if the destination already exists so
      // a clash is surfaced (the renderer also pre-checks, but this is the
      // authoritative guard). ENOENT from access() is the "ok to rename" path.
      try {
        await access(input.newPath);
        log.warn(`file.rename refused — destination already exists: ${input.newPath}`);
        return { ok: false };
      } catch (existsErr) {
        // Rethrow anything that isn't ENOENT (e.g. permission), which would
        // also make the rename fail anyway.
        const code = (existsErr as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") throw existsErr;
      }
      await rename(input.oldPath, input.newPath);
      log.info(
        `file.rename: ${relative(root, input.oldPath) || input.oldPath} -> ${relative(root, input.newPath) || input.newPath}`,
      );
      return { ok: true };
    } catch (err) {
      log.error(
        `file.rename failed for ${input.oldPath} -> ${input.newPath}: ${(err as Error).message}`,
      );
      return { ok: false };
    }
  });

  /* ── clipboard:saveFile — persist a clipboard-pasted external file to a
     temp path the agent can read. The renderer can't write files itself
     (contextIsolation), and the pasted file lives nowhere on disk, so the
     bytes cross via base64 and main materializes them under the OS temp dir.
     The original extension is preserved — the agent's Read tool sniffs image
     types from it (base64 read for images). Note this is deliberately NOT
     project-scoped: the file must be readable by the agent's Read tool from
     anywhere, and reads are already unrestricted (only writes are guarded). */
  ipcMain.handle(IPC.CLIPBOARD_SAVE_FILE, async (_evt, raw) => {
    const input = ClipboardSaveFileSchema.parse(raw);
    try {
      // Sanitize the original name: strip path separators + control chars so
      // the temp path stays a single flat file; keep the extension.
      const cleanName =
        basename(input.name).replace(/[\\/:*?"<>|\x00-\x1f]/g, "_") || "paste.bin";
      const dir = join(app.getPath("temp"), "mcode-pastes");
      await mkdir(dir, { recursive: true });
      const target = join(
        dir,
        `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${cleanName}`,
      );
      await writeFile(target, Buffer.from(input.bytes, "base64"));
      return { ok: true, path: target };
    } catch (err) {
      const msg = (err as Error).message;
      log.warn(`clipboard.saveFile failed: ${msg}`);
      return { ok: false, error: msg };
    }
  });

  /* ── clipboard:writeImage — copy an image data URL onto the OS clipboard.
     The renderer's navigator.clipboard can't reliably write images under
     contextIsolation, so main decodes the data URL into a nativeImage and
     calls clipboard.writeImage (which handles the PNG/JPEG serialization per
     platform). Schema already constrains input to `data:image/...`; an empty
     nativeImage (undecodable payload) degrades to ok:false instead of
     silently clobbering the clipboard. */
  ipcMain.handle(IPC.CLIPBOARD_WRITE_IMAGE, async (_evt, raw) => {
    const input = ClipboardWriteImageSchema.parse(raw);
    try {
      const image = nativeImage.createFromDataURL(input.dataUrl);
      if (image.isEmpty()) {
        log.warn("clipboard.writeImage failed: data URL decoded to an empty image");
        return { ok: false, error: "图片数据无法解码" };
      }
      clipboard.writeImage(image);
      return { ok: true };
    } catch (err) {
      const msg = (err as Error).message;
      log.warn(`clipboard.writeImage failed: ${msg}`);
      return { ok: false, error: msg };
    }
  });
}
