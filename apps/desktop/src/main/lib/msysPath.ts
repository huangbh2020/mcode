/**
 * MSYS / WSL path-dialect normalization shared by the Claude and Pi providers.
 *
 * Agent models trained on Linux/macOS material emit three path dialects on
 * native Windows, and every one of them breaks a different way:
 *
 *   - `/mnt/<drive>/...`  — WSL mount notation; `path.resolve` turns it into a
 *     garbage root-relative folder (`D:\mnt\d\...`) and non-WSL shells can't
 *     find it. (Existing handling in `fileSnapshot.normalizeToolFilePath`.)
 *   - `/d/...`            — Git Bash (MSYS) drive notation; only Git Bash can
 *     convert it, so WSL bash / PowerShell / cmd all fail (`ls: cannot access
 *     '/d/workspace/lfl/'`). THE case behind the Pi provider's bash failures.
 *   - `D:\...`            — native path with backslashes; bash eats them as
 *     escapes (`D:\workspace\...` arrives as `D:workspace...`).
 *
 * This module provides two shared helpers:
 *   - {@link msysToWindowsPath} — single path-token translation, used by the
 *     file-tool guards (`Write`/`Edit`/`read`/rewind snapshot).
 *   - {@link normalizeBashCommand} — token-aware rewrite of a whole bash
 *     command string, used at the providers' bash-tool interception points
 *     (Claude `canUseTool` → `updatedInput`; Pi `tool_call` → in-place).
 *
 * Both only ever rewrite a `/X/` root where `X` is a SINGLE letter — the MSYS
 * drive notation. Linux roots are multi-letter (`dev`, `tmp`, `usr`, …) and
 * can never match, so idioms like `> /dev/null` or `ls /tmp` are preserved
 * automatically (no denylist needed). A single-letter `/X/` root IS a drive on
 * Windows by definition — Git Bash's own path conversion treats it the same
 * way.
 */

/**
 * Translate a single path token from WSL/MSYS notation to a native Windows
 * path. Returns the input unchanged when it isn't a recognized dialect form.
 *
 * Handles:
 *   - `/mnt/d/foo` → `D:\foo`          (WSL mount notation)
 *   - `/d/foo`     → `D:/foo`          (MSYS drive notation)
 *
 * The `\` vs `/` separator choice mirrors the callers' existing conventions:
 * WSL → native Windows `\` (file tools resolve it via `path.resolve`); MSYS →
 * forward slashes (safe inside bash, where `\` is an escape character).
 */
export function msysToWindowsPath(p: string): string {
  // WSL mount notation first: /mnt/d/foo → D:\foo.
  const wsl = /^\/mnt\/([a-zA-Z])\/(.*)$/.exec(p);
  if (wsl) {
    return `${wsl[1].toUpperCase()}:\\${wsl[2].replace(/\//g, "\\")}`;
  }
  // MSYS drive notation: /d/foo → D:/foo (forward slashes — safe in bash).
  const msys = /^\/([a-zA-Z])\/(.*)$/.exec(p);
  if (msys) {
    return `${msys[1].toUpperCase()}:/${msys[2]}`;
  }
  return p;
}

/** Characters that may legally precede a path token in a shell command. A
 *  slash preceded by a word character is NOT a path — it's the tail of a token
 *  like `sed s/x/y/` (preceded by `s`) or `http://d/...` (preceded by `:`), so
 *  we only rewrite when the slash follows whitespace, a quote, or a shell
 *  operator. */
const PATH_PREFIX_RE = "(^|[\\s;|&()<>{}\"'`=!,$])";

/** Characters that may directly follow a converted `/X/` — anything that
 *  continues a path. A space/quote/operator right after `/X/` means the token
 *  is likely a regex literal like `awk '/d/ {print}'`, which must NOT be
 *  touched. */
const PATH_CONTINUE_RE = /[^\s;|&()<>{}"'`=!,$]/;

/**
 * Rewrite WSL/MSYS drive-notation paths inside a bash command string to
 * native Windows paths.
 *
 *   `ls /d/workspace/lfl/`            → `ls D:/workspace/lfl/`
 *   `cat > /mnt/d/x.txt`              → `cat > D:/x.txt`
 *   `ls /d/00-huangbh-project/app`    → `ls D:/00-huangbh-project/app`
 *
 * Conservative by design:
 *   - Linux root segments (`/dev/null`, `/tmp/x`, `/usr/bin`) are untouched —
 *     the single-letter rule can't match multi-letter roots;
 *   - `//server/share` (UNC) and `sed s/x/y/`-style expressions never match
 *     (slash must be preceded by whitespace/quote/operator);
 *   - single-letter regex literals like `awk '/d/ {print}'` are left alone
 *     (a path character must follow `/d/`);
 *   - a bare drive root (`ls /d` at end of string) converts to `D:/`.
 *
 * Backslash-native paths (`D:\workspace\...`) are NOT rewritten — fixing those
 * means shell-steering the provider to Git Bash so bash never sees raw
 * backslashes from the model (see `resolveGitBash` in `binaryResolve.ts`).
 */
export function normalizeBashCommand(command: string): string {
  // Shared rewrite: `/mnt/<letter>/` (pass 1) and `/d/` (pass 2). The trailing
  // `(\/|$)` is consumed and re-emitted as `/` so no double slash appears.
  const rewrite = (
    out: string,
    re: RegExp,
  ): string =>
    out.replace(re, (match, prefix: string, letter: string, _slash: string, offset: number) => {
      // Require a path character after the drive segment: `awk '/d/ {print}'`
      // must survive untouched, while `/d/workspace` converts. A bare `/d` at
      // end of string (rest empty) is a drive root — convert.
      const rest = out.slice(offset + match.length);
      if (rest.length > 0 && !PATH_CONTINUE_RE.test(rest[0])) {
        return match;
      }
      return `${prefix}${letter.toUpperCase()}:/`;
    });

  // Pass 1: WSL mount notation. `/mnt/<letter>/` is always a drive mount (the
  // letter directly follows `/mnt/`), so no Linux-root ambiguity exists here.
  let out = rewrite(command, new RegExp(`${PATH_PREFIX_RE}\\/mnt\\/([a-zA-Z])(\\/|$)`, "g"));
  // Pass 2: MSYS drive notation `/d/...` (or bare `/d` at end of string).
  out = rewrite(out, new RegExp(`${PATH_PREFIX_RE}\\/([a-zA-Z])(\\/|$)`, "g"));
  return out;
}
