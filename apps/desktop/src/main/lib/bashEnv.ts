/**
 * Detect which bash the provider's Bash tool actually spawns, so the system
 * prompt can tell the model the truth about path styles (WSL `/mnt/d/...`
 * vs native `D:\...`).
 *
 * The two providers resolve bash differently on Windows, and the truth is
 * machine-dependent:
 *
 *   - Pi (`pi-coding-agent` `getShellConfig`): pi settings `shellPath` →
 *     `%ProgramFiles%\Git\bin\bash.exe` → `%ProgramFiles(x86)%\...` →
 *     `where bash.exe` first PATH hit. When Git isn't at the two hardcoded
 *     locations and Git's `usr\bin` isn't on PATH, the first hit is
 *     `C:\Windows\System32\bash.exe` — the WSL launcher — so every Bash tool
 *     call runs inside WSL (`/bin/bash`, the Windows cwd shows as
 *     `/mnt/d/...`).
 *   - Claude CLI prefers Git Bash (resolved from the git install root) and
 *     only falls back to WSL when no Git Bash exists at all.
 *
 * The old unconditional hint ("NEVER use WSL-style paths like /mnt/d/...")
 * was written for the Git Bash case; under WSL bash it is factually wrong —
 * the model pwd's the cwd, sees `/mnt/d/...` actually exists, and burns tool
 * calls rediscovering that (observed in Pi sessions on WSL-first machines).
 * The two detectors below mirror each SDK's own resolution, so the hint
 * always matches the shell the tool will actually spawn.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export type BashEnvKind = "unix" | "wsl" | "native" | "unknown";
export type BashEnvScope = "pi" | "claude";

/** WSL bash launcher — mirrors `pi-coding-agent`'s `isLegacyWslBashPath`,
 *  plus the WindowsApps app-execution alias and `wsl.exe` itself. */
const WSL_BASH_LAUNCHER_RE = /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/i;
const WSL_BASH_ALIAS_RE = /\\windowsapps\\bash\.exe$/i;
const WSL_EXE_RE = /^[a-z]:\\windows\\(?:system32|sysnative)\\wsl\.exe$/i;

/** Classify a resolved shell path: the WSL launcher → `wsl`, any other bash
 *  (Git Bash / Cygwin / MSYS2) → `native`. */
function classifyBashPath(shellPath: string): BashEnvKind | null {
  const n = shellPath.replace(/\//g, "\\");
  if (WSL_BASH_LAUNCHER_RE.test(n) || WSL_BASH_ALIAS_RE.test(n) || WSL_EXE_RE.test(n)) {
    return "wsl";
  }
  return "native";
}

/** First existing hit of `where <name>` (win32), mirroring the Pi SDK's
 *  `findBashOnPath`. WindowsApps app-execution aliases (e.g. the WSL `bash`
 *  alias) can fail `existsSync` with EACCES depending on the Node/libuv
 *  version, so we skip matches that don't exist and take the first one that
 *  does — matching the shell the SDK effectively ends up spawning. Returns
 *  null off-win32 / not found. */
function whereFirst(name: string): string | null {
  if (process.platform !== "win32") return null;
  try {
    const res = spawnSync("where", [name], { encoding: "utf-8", timeout: 5000, windowsHide: true });
    if (res.status === 0 && res.stdout) {
      for (const line of res.stdout.split(/\r?\n/)) {
        const p = line.trim();
        if (p && existsSync(p)) return p;
      }
    }
  } catch {
    // `where` unavailable — treat as not found
  }
  return null;
}

/** Git Bash in the two locations both SDKs check on win32. */
function programFilesGitBash(): string | null {
  for (const pf of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]) {
    if (!pf) continue;
    const p = join(pf, "Git", "bin", "bash.exe");
    if (existsSync(p)) return p;
  }
  return null;
}

/** Pi mirror of the SDK's `getShellConfig()` — the shell its Bash tool spawns. */
function detectPiBashEnv(): BashEnvKind {
  // 1. `~/.pi/agent/settings.json` `shellPath` (honors PI_CODING_AGENT_DIR).
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  try {
    const cfg = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as {
      shellPath?: unknown;
    };
    if (typeof cfg.shellPath === "string" && cfg.shellPath.length > 0) {
      return existsSync(cfg.shellPath)
        ? (classifyBashPath(cfg.shellPath) ?? "native")
        : "unknown";
    }
  } catch {
    // no settings file / unreadable — fall through to auto-detection
  }
  // 2/3. Git Bash in the two known locations → native Windows bash.
  if (programFilesGitBash()) return "native";
  // 4. `where bash.exe` first PATH hit (Cygwin/MSYS2/WSL…). The first hit can
  //    legitimately be `C:\Windows\System32\bash.exe` (the WSL launcher) when
  //    Git's `usr\bin` isn't on PATH — that's the WSL case this module exists
  //    to distinguish.
  const onPath = whereFirst("bash.exe");
  if (onPath) return classifyBashPath(onPath) ?? "native";
  return "unknown";
}

/** Claude CLI: Git Bash first (git install root), WSL only as fallback.
 *
 *  Unlike the Pi SDK, the Claude CLI resolves Git Bash from where git is
 *  installed rather than `where bash.exe` — verified on a machine where
 *  `where bash.exe` returns the WSL launcher first while Claude's Bash tool
 *  still ran Git Bash (session logs show `/usr/bin/bash`-style errors and
 *  `D:/...` paths resolving fine). So the git-derived check below runs before
 *  the PATH lookup. */
function detectClaudeBashEnv(): BashEnvKind {
  // 1. Known Git Bash locations.
  if (programFilesGitBash()) return "native";
  // 2. Git-derived: bash sits under the git executable's install root
  //    (`<git>\cmd\git.exe` → `<git>\bin\bash.exe`), which catches custom Git
  //    installs (e.g. `D:\soft\Git`) even when their `usr\bin` isn't on PATH.
  const git = whereFirst("git.exe");
  if (git) {
    const gitDir = git.replace(/[\\/][^\\/]+$/, "");
    for (const p of [join(gitDir, "bin", "bash.exe"), join(gitDir, "..", "bin", "bash.exe")]) {
      if (existsSync(p)) return "native";
    }
  }
  // 3. A non-WSL bash on PATH (Cygwin/MSYS2/Git Bash `usr\bin` on PATH) — or
  //    the WSL launcher as the last reachable bash.
  const onPath = whereFirst("bash.exe");
  if (onPath) return classifyBashPath(onPath) ?? "native";
  // 4. WSL alone (no Git Bash anywhere).
  if (whereFirst("wsl.exe")) return "wsl";
  return "unknown";
}

const cache = new Map<BashEnvScope, BashEnvKind>();

/** Detect the bash the given provider's Bash tool will spawn. Memoized per
 *  scope — the resolved shell doesn't change within a process. */
export function detectBashEnv(scope: BashEnvScope): BashEnvKind {
  const hit = cache.get(scope);
  if (hit) return hit;
  const env = scope === "pi" ? detectPiBashEnv() : detectClaudeBashEnv();
  cache.set(scope, env);
  return env;
}

/** Native-Windows bash (Git Bash / Cygwin / MSYS2): `/mnt/...` doesn't exist,
 *  so the model must stick to relative or native `D:\...` paths. */
export const BASH_NATIVE_PATH_HINT =
  "You are running on Windows. Use native Windows paths (e.g. D:\\...) or, preferably, paths relative to the project working directory. NEVER use WSL-style paths like /mnt/d/... — they do not exist on this machine.";

/** WSL bash: the working directory appears as `/mnt/<drive>/...` and only
 *  that form resolves inside bash commands — while the (Node-fs) file tools
 *  stay native Windows and can't read `/mnt`. */
export const BASH_WSL_PATH_HINT =
  "You are running on Windows, and the Bash tool executes inside WSL (Windows Subsystem for Linux): the project working directory appears as /mnt/<drive>/<path> (e.g. /mnt/d/workspace/lfl). Inside Bash commands use WSL-style paths like /mnt/d/... — native Windows paths (D:\\...) and Git-Bash-style paths (/d/...) do NOT resolve there. The read/write/edit file tools run natively on Windows and cannot resolve /mnt/... paths — for those, use paths relative to the project working directory.";

/** System-prompt hint for a detected bash environment. Only meaningful on
 *  win32 — callers keep the `process.platform === "win32"` guard. */
export function bashPathHintFor(env: BashEnvKind): string {
  return env === "wsl" ? BASH_WSL_PATH_HINT : BASH_NATIVE_PATH_HINT;
}
