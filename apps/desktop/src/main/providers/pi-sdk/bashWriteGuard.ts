/**
 * Bash write-target guard for the Pi provider.
 *
 * The Pi SDK's built-in `bash` tool is unguarded — the model can create or
 * overwrite files anywhere via shell redirections (`>`, `>>`, `tee`, `dd of=`,
 * `sed -i`, …), bypassing the in-project path guard that wraps `write`/`edit`
 * (see `createGuardedFileTools` in `PiAgentSdkProvider.ts`). This module
 * extracts the write targets from a command string so the wrapped bash tool can
 * reject ones that resolve outside the project working directory, the same way
 * `guardToolPath` does for the file tools.
 *
 * ## Scope — deliberately NOT a sandbox
 *
 * We statically scan for the common redirection/append forms and a handful of
 * write-specialized commands. We do NOT fully parse shell grammar, so a
 * determined model can still escape with forms we don't recognize (`cp`/`mv`
 * target arguments, heredocs, pipes into `cat >`, `install`, etc.). The goal is
 * to block the *unintentional* "create a helper script in /tmp" pattern, not to
 * defeat adversarial input — that is the same incompleteness the Claude
 * provider's bash side accepts (it guards Write/Edit/MultiEdit/NotebookEdit via
 * canUseTool but leaves bash unguarded there too).
 *
 * Paths containing `$` or backticks are skipped (we can't expand them
 * statically, and rejecting them would block legitimate in-project writes via a
 * variable). Everything else goes through `normalizeToolFilePath`, which also
 * normalizes WSL `/mnt/<drive>/...` to native Windows paths.
 */
import { homedir } from "node:os";
import path from "node:path";
import { normalizeToolFilePath } from "@main/lib/fileSnapshot.js";

/**
 * A single token taken from the shell command string after lightweight
 * quote-stripping. We don't run a real shell tokenizer — we split on
 * whitespace while respecting simple single/double quoting, which is enough
 * to peel the redirection target off the token that follows `>`/`>>`.
 */
function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      // POSIX backslash-escaping: `\X` yields the literal `X`. But for path
      // extraction we must keep backslashes that are path separators on
      // Windows — `\t` in `C:\tmp` is NOT an escape of `t`. So we only drop
      // the backslash when it precedes a character that would otherwise end
      // the token (whitespace or a quote); otherwise we keep it verbatim.
      // This can only make us over- rather than under-extract paths, which is
      // safe for a guard (a false positive on a literal `\w` is benign).
      const next = command[i + 1];
      if (/\s/.test(next) || next === '"' || next === "'" || next === "\\") {
        cur += next;
        i++;
      } else {
        cur += ch;
      }
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur.length > 0) {
        tokens.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur.length > 0) tokens.push(cur);
  return tokens;
}

/**
 * Strip a leading `&` (from `&>`/`>&`) or file-descriptor digits (e.g. the `2`
 * in `2>file`) from a redirection operator token so we recognize it uniformly.
 */
function isWriteRedir(tok: string): boolean {
  return /^(?:\d*)>{1,2}$/.test(tok) || /^&>{1,2}$/.test(tok) || /^>{1,2}&$/.test(tok);
}

/**
 * Extract the file paths a command would write to via redirections and
 * write-specialized commands. Returns them in source order (duplicates kept —
 * the caller only needs to know if ANY escapes, and a duplicate path has no
 * semantic cost).
 *
 * Recognized forms:
 *   - `> file`, `>> file`, `2> file`, `&> file`, `>& file` — redirection
 *   - `tee file`, `tee -a file …` — first non-option argument(s) per tee call
 *   - `dd of=file` — the `of=` operand
 *   - `sed -i … file`, `sed -i'' … file` — in-place edit targets
 *
 * `cp`/`mv`/`install`/heredoc/pipe targets are intentionally NOT covered (see
 * the module doc).
 */
export function extractBashWriteTargets(command: string): string[] {
  const tokens = tokenize(command);
  const targets: string[] = [];
  const isOption = (t: string) => t.startsWith("-");

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];

    // Redirection operators: the NEXT token is the target file. `>&word` and
    // `&>word` collapse to a bare operator here because the tokenizer already
    // split on whitespace, so we only see `&>` / `>&` as their own token when
    // the user wrote `& >`-style spacing (rare); the common `&>file` form is
    // handled by the fused check below.
    if (isWriteRedir(tok)) {
      const next = tokens[i + 1];
      if (next && !isOption(next)) targets.push(next);
      i++; // consume the target
      continue;
    }

    // Fused forms where the operator and target are one token: `>file`,
    // `>>file`, `&>file`, `>&file`, `2>file`. Match the longest operator
    // prefix and take the rest as the path.
    const fused = tok.match(/^(?:\d*|&)?>{1,2}&?(.+)$/);
    if (fused && /^(?:\d*|&)?>{1,2}&?/.test(tok) && fused[1] && !isOption(tok)) {
      // Avoid misclassifying a comparison like `a>b` only when it looks like a
      // path: require the target to start with `/`, `./`, `../`, `~`, or a
      // drive letter. Pure-alphanumeric "a>b" is left alone.
      const path = fused[1];
      if (isPathy(path)) targets.push(path);
      continue;
    }

    const lower = tok.toLowerCase();

    // dd of=file
    if (lower === "dd") {
      for (let j = i + 1; j < tokens.length && !isOption(tokens[j]); j++) {
        const m = tokens[j].match(/^of=(.+)$/);
        if (m) targets.push(m[1]);
      }
      continue;
    }

    // tee [-a/-i/…] file … — skip options, every following non-option token is
    // a write target (tee writes to each). Stop at the next command separator
    // or pipe; we don't model those, so we conservatively stop at `|`/`;`.
    if (lower === "tee") {
      for (let j = i + 1; j < tokens.length; j++) {
        const t = tokens[j];
        if (t === "|" || t === ";") break;
        if (isOption(t)) continue;
        targets.push(t);
      }
      continue;
    }

    // sed -i[-suffix] … file — the in-place edit targets are the trailing
    // non-option arguments. We only flag when `-i` is present (without `-i`
    // sed writes to stdout, not to the file).
    if (lower === "sed" && tokens.slice(i + 1).some((t) => /^-i/.test(t))) {
      for (let j = i + 1; j < tokens.length; j++) {
        const t = tokens[j];
        if (isOption(t)) continue;
        // sed's expression argument (e.g. `s/a/b/`) — skip it; it contains a
        // path-looking segment only by accident and isn't a file target.
        if (/^s\b/.test(t) || t.includes("/")) continue;
        targets.push(t);
      }
      continue;
    }
  }

  return targets;
}

/** Heuristic: does this token look like a file path rather than a stray
 *  word glued to a `>`? Drives the fused-redirection branch so we don't flag
 *  shell comparisons like `[ a>b ]`. */
function isPathy(p: string): boolean {
  return (
    p.startsWith("/") ||
    p.startsWith("./") ||
    p.startsWith("../") ||
    p.startsWith("~") ||
    /^[a-zA-Z]:[\\/]/.test(p) // Windows drive path
  );
}

/** True when a path token contains shell expansion we can't resolve statically
 *  ($VAR, ${VAR}, `cmd`). Such targets are skipped (allowed) to avoid blocking
 *  legitimate in-project writes via a variable. */
function hasDynamicExpansion(p: string): boolean {
  return p.includes("$") || p.includes("`");
}

/** Special device files that are safe to write to — they never create or
 *  modify real files on disk. `/dev/null` discards output (the canonical
 *  `command > /dev/null 2>&1` idiom); `/dev/stdout`, `/dev/stderr`, and
 *  `/dev/fd/N` redirect to existing file descriptors. Whitelisting these
 *  avoids false positives on ubiquitous output-suppression patterns. Checked
 *  against the normalized absolute path so `/dev/./null` etc. are covered. */
const SAFE_DEVICE_FILES = new Set([
  "/dev/null",
  "/dev/stdin",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/fd/0",
  "/dev/fd/1",
  "/dev/fd/2",
]);

/**
 * Expand a leading `~` (or `~user`) to the user's home directory.
 *
 * `node:path.resolve` does NOT understand tilde — it treats `~` as a literal
 * directory name, so `resolve(cwd, "~/foo")` yields `<cwd>/~/foo` and the
 * in-project guard wrongly admits it. But bash expands `~` to `$HOME` (or a
 * specific user's home with `~user`), which is virtually always OUTSIDE the
 * project. Expanding up front lets {@link normalizeToolFilePath} resolve the
 * real absolute path and judge containment correctly.
 *
 * `~user` is expanded via `os.homedir()` only for the bare `~`/`~/` forms
 * (the common case); `~someoneelse` is left unchanged — we can't look up
 * arbitrary users' homes portably, and leaving it means it resolves to a
 * literal `~someoneelse/...` dir inside cwd (still contained, so allowed —
 * the rare `~user` escape is an acceptable known gap).
 *
 * Exported so the write/edit path guard (`guardToolPath`) can reuse the exact
 * same expansion — both guards must agree on how `~` is handled.
 */
export function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  return p; // `~user` or no tilde — leave as-is
}

/**
 * Inspect a bash command for write targets that escape the project working
 * directory. Returns a Chinese denial message (mirroring `guardToolPath`) when
 * a target resolves outside `cwd` in strict mode, or `null` when the command is
 * allowed (all targets inside the project, or non-strict, or only dynamic
 * targets we can't check).
 *
 * @param cwd       project working directory
 * @param command   the raw bash command string from the tool params
 * @param strict    when false (bypassPermissions/dontAsk), allow escapes
 * @returns         denial message, or null to allow
 */
export function guardBashCommand(
  cwd: string,
  command: string,
  strict: boolean,
): string | null {
  if (!strict) return null;
  if (typeof command !== "string" || command.length === 0) return null;

  const targets = extractBashWriteTargets(command);
  for (const raw of targets) {
    if (hasDynamicExpansion(raw)) continue; // can't expand — allow
    const norm = normalizeToolFilePath(cwd, expandTilde(raw));
    if (!norm) continue; // unresolvable — allow (matches guardToolPath behavior)
    if (SAFE_DEVICE_FILES.has(norm.absPath)) continue; // device file — safe, no real write
    if (!norm.insideProject) {
      return `拒绝:bash 重定向目标在项目工作目录之外(${norm.absPath})。只允许在项目目录内写入文件,请改用相对路径。`;
    }
  }
  return null;
}
