/**
 * ripgrep-backed search primitives for `file:search` / `file:grep`.
 *
 * ripgrep does the expensive part — walking the tree and scanning file
 * contents — in C, orders of magnitude faster than the in-process JS
 * scanners in `ipc/files.ts`. The IPC handlers call these first and fall back
 * to the JS walk when ripgrep isn't installed or a spawn fails, so behavior
 * degrades gracefully instead of erroring.
 *
 * Encoding story (mirrors the JS decode path in files.ts):
 *  - UTF-8 is the default; rg also auto-transcodes UTF-16 files with a BOM.
 *  - GBK/GB2312 ANSI files (the classic Chinese-Windows encoding) are seen as
 *    binary by the UTF-8 pass and skipped, so when the QUERY itself contains
 *    non-ASCII bytes we additionally run a `--encoding gbk` pass and merge the
 *    two result sets. ASCII queries match identical bytes under both encodings
 *    (GBK is ASCII-compatible), so a second pass would add nothing.
 *  - Plain binary content (NUL bytes) is sniffed by rg itself and skipped.
 *
 * Both functions return `null` on failure so callers know to fall back; on
 * success results mirror the shapes defined in `packages/contracts/ipc.ts`
 * (plus the truncation flag, computed from the same caps).
 */
import { spawn } from "node:child_process";
import { basename, join } from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { app } from "electron";
import { which } from "@main/lib/binaryResolve.js";

/** How long a single rg spawn may run before we kill it and fall back. A
 *  huge tree on a slow disk can exceed this; 30s is far above any healthy
 *  scan and bounds pathological cases. */
const RG_TIMEOUT_MS = 30_000;

/** Per-file byte cap, mirrored from the JS grep path. Larger files are
 *  skipped by rg (`--max-filesize`) so decoding never stalls the process. */
export const RG_MAX_FILE_BYTES = 32 * 1024 * 1024;

let cachedRg: string | null | undefined;

/** Where a one-click install puts the binary (`userData/bin`, shared with
 *  `rgInstall.ts`). Checked before PATH so an app-installed copy wins over a
 *  system one — the app-owned copy is the one we can vouch for. */
export function bundledRgPath(): string {
  return join(app.getPath("userData"), "bin", process.platform === "win32" ? "rg.exe" : "rg");
}

/** Drop the resolved-binary cache. Called by the install flow so newly
 *  installed binaries are picked up without a restart. */
export function resetRgCache(): void {
  cachedRg = undefined;
}

/** Locate the `rg` binary (lazy, cached). Order: bundled `userData/bin` copy,
 *  PATH via the shared `which()`, then a couple of install locations NOT on
 *  PATH by default (cargo/scoop). */
export function resolveRg(): string | null {
  if (cachedRg !== undefined) return cachedRg;
  let found: string | null = null;
  const bundled = bundledRgPath();
  if (existsSync(bundled)) found = bundled;
  if (!found) found = which("rg");
  if (!found && process.platform === "win32") {
    const home = homedir();
    for (const p of [
      join(home, ".cargo", "bin", "rg.exe"),
      join(home, "scoop", "shims", "rg.exe"),
    ]) {
      if (existsSync(p)) {
        found = p;
        break;
      }
    }
  }
  cachedRg = found;
  return cachedRg;
}

/** Turn an IGNORED_ENTRIES-style directory-name list into `-g` exclusions.
 *  Each name yields a pair of globs — one hides that dir's contents anywhere
 *  in the tree, the other also hides a top-level FILE that shares the name
 *  (e.g. .DS_Store, coverage): `!**`+`/dir/`+`**` and `!**`+`/dir`. Globs
 *  use `/` even on Windows — rg normalizes them. */
export function ignoreGlobArgs(ignored: Iterable<string>): string[] {
  const args: string[] = [];
  for (const n of ignored) {
    if (!n) continue;
    args.push("-g", `!**/${n}/**`, "-g", `!**/${n}`);
  }
  return args;
}

/** rg renders search results relative to `root` (cwd is set to root and the
 *  search path is `.`). On Windows that comes out as `.\foo\bar` with
 *  backslashes; normalize to a bare forward-slash relative path. */
function toRelPath(raw: string): string {
  let p = raw;
  if (p.startsWith("./")) p = p.slice(2);
  else if (p.startsWith(".\\")) p = p.slice(2);
  return p.split(/[/\\]/).join("/");
}

/** rg's JSON `lines.text` includes the terminating newline; strip it so the
 *  stored lineText matches what the old JS line-split produced (and so the
 *  highlight ranges slice a clean line). */
function stripNewline(s: string): string {
  if (s.endsWith("\r\n")) return s.slice(0, -2);
  if (s.endsWith("\n")) return s.slice(0, -1);
  if (s.endsWith("\r")) return s.slice(0, -1);
  return s;
}

/** Map UTF-8 byte offsets (rg submatch positions) onto UTF-16 code-unit
 *  indices so the renderer's `line.slice(start, end)` highlighting aligns.
 *  Precomputes the byte offset at each char once per line, then a binary
 *  search per submatch (lines are short — the cost is negligible). */
function byteOffsetsToUtf16(
  line: string,
  submatches: Array<{ start: number; end: number }>,
): Array<{ start: number; end: number }> {
  const byteAt: number[] = [0];
  let acc = 0;
  for (let i = 0; i < line.length; i++) {
    acc += Buffer.byteLength(line[i], "utf8");
    byteAt.push(acc);
  }
  const toIdx = (b: number): number => {
    let lo = 0;
    let hi = byteAt.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (byteAt[mid] <= b) lo = mid + 1;
      else hi = mid;
    }
    return Math.max(0, lo - 1);
  };
  return submatches.map((m) => ({ start: toIdx(m.start), end: toIdx(m.end) }));
}

export interface RgFile {
  name: string;
  /** Absolute filesystem path. */
  abs: string;
  /** Project-relative path with forward slashes. */
  relPath: string;
}

/** List every file under `root` via `rg --files` (C-speed walk, complete —
 *  no visit budget, so `incompleteScan` never applies). Hidden files and
 *  non-gitignored content are included, matching the JS walk's semantics;
 *  only the IGNORED_ENTRIES-style dirs are excluded. Returns null on any
 *  failure (rg missing, nonzero exit, timeout). */
export function rgListFiles(
  root: string,
  ignored: Iterable<string>,
  timeoutMs: number = RG_TIMEOUT_MS,
): Promise<RgFile[] | null> {
  return new Promise((resolvePromise) => {
    const rg = resolveRg();
    if (!rg) {
      resolvePromise(null);
      return;
    }
    const args = [
      "--files",
      "--hidden",
      "--no-ignore",
      "-0",
      ...ignoreGlobArgs(ignored),
      ".",
    ];
    const child = spawn(rg, args, {
      cwd: root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (v: RgFile[] | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolvePromise(v);
    };
    timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, timeoutMs);
    child.stdout.on("data", (c: Buffer | string) => {
      chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => {
      if (code !== 0) {
        finish(null);
        return;
      }
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        const files: RgFile[] = [];
        for (const raw of text.split("\0")) {
          const relSlash = toRelPath(raw);
          if (!relSlash) continue;
          files.push({
            name: basename(relSlash),
            abs: join(root, relSlash),
            relPath: relSlash,
          });
        }
        finish(files);
      } catch {
        finish(null);
      }
    });
  });
}

export interface RgGrepMatch {
  /** Absolute filesystem path. */
  path: string;
  /** Project-relative path with forward slashes. */
  relativePath: string;
  /** 1-based line number within the file. */
  lineNumber: number;
  /** Raw text of the matched line (trailing newline stripped). */
  lineText: string;
  /** Column ranges of each query occurrence on this line (UTF-16 indices,
   *  0-based [start,end), aligned with lineText). */
  matches: Array<{ start: number; end: number }>;
}

export interface RgGrepResult {
  matches: RgGrepMatch[];
  /** The global match cap was reached — more matches almost certainly exist
   *  in files we stopped scanning. */
  truncated: boolean;
}

/** Line-level content search via `rg --json -F` (fixed strings — substring
 *  semantics identical to the JS `indexOf` path, no regex surprises). The
 *  UTF-8 pass handles UTF-8 + UTF-16(BOM); a merged `--encoding gbk` pass is
 *  added when the query contains non-ASCII bytes. Returns null when rg is
 *  unavailable or the UTF-8 pass itself failed (fall back to JS). */
export function rgGrep(
  root: string,
  query: string,
  opts: { caseSensitive: boolean; limit: number; maxPerFile: number; includeExts?: string[] },
  ignored: Iterable<string>,
): Promise<RgGrepResult | null> {
  const rg = resolveRg();
  if (!rg) return Promise.resolve(null);
  const hasNonAscii = /[^\x00-\x7F]/.test(query);
  return Promise.all([
    runGrepPass(rg, root, query, opts, ignored, "utf-8"),
    hasNonAscii ? runGrepPass(rg, root, query, opts, ignored, "gbk") : Promise.resolve(null),
  ]).then(([utf8, gbk]) => {
    // A failed UTF-8 pass means rg itself couldn't run (spawn error etc.) —
    // a partial gbk-only merge would silently miss every UTF-8 file, so fail
    // the whole call and let the caller fall back to the JS scanner. A failed
    // gbk pass only loses ANSI-file coverage; keep what utf-8 found.
    if (utf8 === null) return null;
    const merged: RgGrepMatch[] = [];
    const seen = new Set<string>();
    for (const pass of [utf8, gbk]) {
      if (!pass) continue;
      for (const m of pass) {
        const key = `${m.path}\u0000${m.lineNumber}\u0000${m.matches.map((r) => `${r.start}:${r.end}`).join(",")}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(m);
        if (merged.length >= opts.limit) break;
      }
      if (merged.length >= opts.limit) break;
    }
    return { matches: merged, truncated: merged.length >= opts.limit };
  });
}

function runGrepPass(
  rg: string,
  root: string,
  query: string,
  opts: { caseSensitive: boolean; limit: number; maxPerFile: number; includeExts?: string[] },
  ignored: Iterable<string>,
  encoding: "utf-8" | "gbk",
): Promise<RgGrepMatch[] | null> {
  const includeGlobs: string[] = [];
  for (const ext of opts.includeExts ?? []) {
    // Sanitize: only bare alnum extensions become globs; anything else
    // (the renderer supplies these) is dropped rather than risk a weird
    // glob pattern. `*.ts` matches any file ending in .ts, any depth.
    const safe = ext.replace(/[^a-zA-Z0-9]/g, "");
    if (safe) {
      includeGlobs.push("-g", `*.${safe}`, "-g", `**/*.${safe}`);
    }
  }
  const args = [
    "--json",
    "--no-ignore",
    "--hidden",
    "-F",
    "-m",
    String(opts.maxPerFile),
    "--max-filesize",
    String(RG_MAX_FILE_BYTES),
    "--encoding",
    encoding,
    opts.caseSensitive ? "--case-sensitive" : "--ignore-case",
    ...ignoreGlobArgs(ignored),
    ...includeGlobs,
    query,
    ".",
  ];
  return new Promise((resolvePromise) => {
    const child = spawn(rg, args, {
      cwd: root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const matches: RgGrepMatch[] = [];
    let buf = "";
    let settled = false;
    let hitCap = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (v: RgGrepMatch[] | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolvePromise(v);
    };
    timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, RG_TIMEOUT_MS);

    child.stdout.on("data", (c: Buffer | string) => {
      buf += Buffer.isBuffer(c) ? c.toString("utf8") : c;
      let nl: number;
      while (!hitCap && (nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line) as {
            type?: string;
            data?: {
              path?: { text?: unknown };
              line_number?: unknown;
              lines?: { text?: unknown };
              submatches?: Array<{ start?: unknown; end?: unknown }>;
            };
          };
          if (evt.type !== "match" || !evt.data) continue;
          const d = evt.data;
          const p = toRelPath(typeof d.path?.text === "string" ? d.path.text : "");
          if (!p || typeof d.line_number !== "number" || typeof d.lines?.text !== "string") {
            continue;
          }
          const lineText = stripNewline(d.lines.text);
          const subs: Array<{ start: number; end: number }> = [];
          if (Array.isArray(d.submatches)) {
            for (const sm of d.submatches) {
              if (typeof sm?.start === "number" && typeof sm?.end === "number") {
                subs.push({ start: sm.start, end: sm.end });
              }
            }
          }
          if (subs.length === 0) continue;
          matches.push({
            path: join(root, p),
            relativePath: p,
            lineNumber: d.line_number,
            lineText,
            matches: byteOffsetsToUtf16(lineText, subs),
          });
          if (matches.length >= opts.limit) {
            hitCap = true;
            child.kill();
          }
        } catch {
          // Malformed JSON line — ignore and keep parsing the stream.
        }
      }
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => {
      // rg exit codes: 0 = matches, 1 = no matches (valid), 2 = error. We
      // also kill the child ourselves on cap/timeout — those still return
      // whatever partial results were collected.
      if (code === 2) {
        finish(null);
        return;
      }
      finish(matches);
    });
  });
}