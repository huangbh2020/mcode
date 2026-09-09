/**
 * Renderer-side path utilities.
 *
 * The renderer runs under contextIsolation and cannot `require("node:path")`.
 * These pure-string helpers cover the small set of path operations the IDE
 * panel needs (basename, dirname, extension). They handle both POSIX `/` and
 * Windows `\` separators since project paths may come from either platform.
 */

/** Matches the last path separator (forward or back slash). */
const SEP_RE = /[/\\]/;

/** The base name of a path — the segment after the last separator.
 *  `"foo/bar/baz.ts"` → `"baz.ts"`. Returns the input unchanged if it has no
 *  separator. */
export function basename(p: string): string {
  const parts = p.split(SEP_RE);
  return parts[parts.length - 1] ?? p;
}

/** The directory containing a path — everything before the last separator.
 *  `"foo/bar/baz.ts"` → `"foo/bar"`. Returns `""` for a bare file name. */
export function dirname(p: string): string {
  const last = p.lastIndexOf("/");
  const lastBack = p.lastIndexOf("\\");
  const cut = Math.max(last, lastBack);
  return cut < 0 ? "" : p.slice(0, cut);
}

/** The file extension including the leading dot, lowercased — `""` if none.
 *  Used to pick a Monaco language id. `"baz.ts"` → `".ts"`. */
export function extname(p: string): string {
  const base = basename(p);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return ""; // dot at 0 = hidden file, no extension
  return base.slice(dot).toLowerCase();
}

/** Join two path segments with a single separator. Handles the case where
 *  the base already ends with a separator and/or the add starts with one.
 *  Uses `/` (works on macOS/Linux; Windows tolerates it in Node APIs). */
export function joinPath(base: string, add: string): string {
  if (!add) return base;
  const left = base.endsWith("/") || base.endsWith("\\") ? base : base + "/";
  const right = add.startsWith("/") || add.startsWith("\\") ? add.slice(1) : add;
  return left + right;
}

/** The path of `absPath` relative to `root`, using forward slashes, e.g.
 *  `relativePath("/proj/src/a.ts", "/proj")` -> `"src/a.ts"`. Returns the
 *  path with any leading separator stripped. If `absPath` is not under `root`
 *  (after normalizing separators), returns `absPath` unchanged as a defensive
 *  fallback rather than an empty or misleading string.
 *
 *  Renderer-safe (no `node:path`): pure string arithmetic handling both `/`
 *  and `\` so cross-platform project paths normalize correctly. */
export function relativePath(absPath: string, root: string): string {
  // Normalize both to forward slashes for a single comparison path.
  const normAbs = absPath.replace(/\\/g, "/");
  const normRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normRoot) return normAbs;
  // Match root either exactly or as a directory prefix (followed by "/").
  if (normAbs === normRoot) return "";
  if (normAbs.startsWith(normRoot + "/")) {
    return normAbs.slice(normRoot.length + 1);
  }
  // Not under root - return the normalized input unchanged (defensive).
  return normAbs;
}

/** Resolve `rel` against `baseDir` and collapse `.`/`..` segments — the
 *  renderer-side stand-in for `path.resolve`/`path.normalize`.
 *  `resolveRelativePath("D:/proj/docs", "images/../img/a.png")`
 *    -> `"D:/proj/docs/img/a.png"`.
 *  Absolute inputs (drive-letter or POSIX root) are normalized in place
 *  without joining; `..` never escapes past a filesystem root. Output uses
 *  forward slashes (drive paths keep their `D:` prefix, POSIX keeps `/`).
 *  Renderer-safe: pure string arithmetic over both separators. */
export function resolveRelativePath(baseDir: string, rel: string): string {
  const normRel = rel.replace(/\\/g, "/");
  const joinedNorm = (
    /^[A-Za-z]:[\\/]/.test(normRel) || normRel.startsWith("/")
      ? normRel
      : joinPath(baseDir.replace(/[\\/]+$/, ""), normRel)
  ).replace(/\\/g, "/");
  // Absolute joined paths (POSIX "/..." or drive "D:/...") clamp `..` at the
  // filesystem root; only slash-rooted paths get the leading "/" back on
  // output — drive paths start with the letter, not a slash.
  const isAbsolute = joinedNorm.startsWith("/") || /^[A-Za-z]:\//.test(joinedNorm);
  const slashRoot = joinedNorm.startsWith("/");
  const segments: string[] = [];
  for (const seg of joinedNorm.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (segments.length > 0 && segments[segments.length - 1] !== "..") {
        segments.pop();
      } else if (!isAbsolute) {
        segments.push("..");
      }
      continue;
    }
    segments.push(seg);
  }
  return (slashRoot ? "/" : "") + segments.join("/");
}
