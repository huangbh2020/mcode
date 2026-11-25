/**
 * Locate the executable Mcode spawns to run the USER'S Claude CLI.
 *
 * Claude sessions no longer bundle a binary: they run whatever `claude` the
 * user installed and keeps updated (npm global `@anthropic-ai/claude-code`, or
 * the native installer's ~/.local/bin drop) — the same CLI their terminal
 * runs. What `which claude` finds is not always spawnable, though:
 *
 *   - npm's global bin on Windows holds `claude.cmd` / `claude.ps1` / a sh
 *     shim. `child_process.spawn` cannot launch a `.cmd` (CreateProcess only
 *     runs .exe), and `shell: true` would hand every argument to cmd.exe's
 *     parser — wrong for paths with spaces and for anything JSON-shaped.
 *   - so the shim is followed to what it forwards to: the package's native
 *     `bin/claude[.exe]` (current layout) is spawned directly; a JS launcher
 *     (older layouts) is run with `node`.
 *
 * The result is what the transport, the MCP OAuth PTY (`claude mcp login`)
 * and the version probe all spawn, so every path agrees on one binary.
 *
 * Pure node (no electron, no logger) — the CLI protocol probes bundle it.
 */
import { execFile } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { which } from "@main/lib/binaryResolve.js";

export type ClaudeExecutableSource =
  /** A native binary found directly on PATH. */
  | "native"
  /** The native binary behind an npm shim. */
  | "npm"
  /** The native installer's drop (not on PATH). */
  | "native-installer"
  /** A JS launcher behind a shim, run with node. */
  | "node-launcher"
  /** The shim itself, launched through the shell (last resort). */
  | "shim";

export interface ClaudeExecutable {
  /** What `child_process.spawn` gets as `command`. */
  command: string;
  /** Args that must precede the CLI's own args (the `node <cli.js>` form). */
  preArgs: string[];
  /** Extra environment the launch form needs (ELECTRON_RUN_AS_NODE when the
   *  launcher runs on Electron's own node). */
  env?: Record<string, string>;
  /** Last resort only: let a shell resolve the shim. */
  shell?: boolean;
  /** The path a user would recognise — what `which claude` found. */
  path: string;
  source: ClaudeExecutableSource;
}

/** Oldest CLI the control protocol Mcode speaks is known to work on: the
 *  stdio permission channel landed in 2.1.199 and the plan-approval dialog
 *  kind (`permission_exit_plan_mode_v2`) is confirmed on 2.1.218. Older
 *  binaries would silently lose approvals, so sessions refuse to start. */
export const MIN_CLAUDE_CLI_VERSION = "2.1.218";

const CACHE_MS = 10 * 60_000;
let cached: { at: number; value: ClaudeExecutable | null } | undefined;
let cachedVersion: { key: string; at: number; value: string | null } | undefined;

/** Drop the cached resolution (after an install / uninstall). */
export function invalidateClaudeExecutableCache(): void {
  cached = undefined;
  cachedVersion = undefined;
}

/** Native executable magic numbers: PE, ELF, the Mach-O families. */
function isNativeBinary(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(4);
    const n = readSync(fd, buf, 0, 4, 0);
    if (n < 2) return false;
    if (buf[0] === 0x4d && buf[1] === 0x5a) return true; // MZ
    if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) return true; // ELF
    if (buf[0] === 0xca && buf[1] === 0xfe && buf[2] === 0xba && buf[3] === 0xbe) return true;
    if ((buf[0] === 0xfe && buf[1] === 0xed) || (buf[0] === 0xcf && buf[1] === 0xfa)) return true;
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Where an npm shim forwards to, relative to the package root — read from
 *  the shim text, with the package manifest's `bin.claude` as the fallback. */
function shimTarget(shimPath: string, pkgDir: string): string | null {
  try {
    const text = readFileSync(shimPath, "utf8");
    const m = text.match(/@anthropic-ai[\\/]claude-code[\\/]([^"'\r\n%*|<>]+)/);
    if (m?.[1]) {
      const rel = m[1].replace(/[\\/]+$/, "").trim();
      if (rel) return join(pkgDir, rel);
    }
  } catch {
    /* unreadable shim — fall through to the manifest */
  }
  try {
    const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as {
      bin?: string | Record<string, string>;
    };
    const rel = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.["claude"];
    if (typeof rel === "string" && rel) return join(pkgDir, rel);
  } catch {
    /* no package beside the shim */
  }
  return null;
}

/** The `node` that runs a JS launcher: the one on PATH, else this process's
 *  own runtime (Electron's, acting as plain node). */
function nodeLauncher(): { command: string; env?: Record<string, string> } {
  const onPath = which("node");
  if (onPath) return { command: onPath };
  return { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: "1" } };
}

/** Turn a path (what `which claude` found) into something `child_process.spawn`
 *  can launch — see the module doc. Exported so the smoke can feed it fixture
 *  shims instead of whatever this machine has installed. */
export function spawnableClaudeExecutable(found: string): ClaudeExecutable {
  const isWindowsShim = process.platform === "win32" && /\.(cmd|bat|ps1)$/i.test(found);
  if (!isWindowsShim && isNativeBinary(found)) {
    return { command: found, preArgs: [], path: found, source: "native" };
  }

  // POSIX npm shims are extensionless shell scripts; so are hand-rolled
  // wrappers. Both forward to the same package layout.
  const pkgDir = join(dirname(found), "node_modules", "@anthropic-ai", "claude-code");
  if (isWindowsShim || existsSync(pkgDir)) {
    const target = shimTarget(found, pkgDir);
    if (target && existsSync(target)) {
      if (isNativeBinary(target)) {
        return { command: target, preArgs: [], path: found, source: "npm" };
      }
      if (/\.(c?js|mjs)$/i.test(target)) {
        const node = nodeLauncher();
        return { command: node.command, preArgs: [target], env: node.env, path: found, source: "node-launcher" };
      }
    }
    // Shim whose target could not be resolved: let a shell run it. Only
    // flag-shaped arguments are safe in this form — callers that pass files
    // pass paths without spaces (temp dirs), everything else rides stdin.
    return { command: found, preArgs: [], shell: true, path: found, source: "shim" };
  }
  if (isWindowsShim) {
    return { command: found, preArgs: [], shell: true, path: found, source: "shim" };
  }
  // Extensionless POSIX file that is neither native nor an npm shim.
  return { command: found, preArgs: [], shell: process.platform !== "win32", path: found, source: "shim" };
}

/** Resolve the user's Claude CLI, or null when it is not installed. Cached
 *  for {@link CACHE_MS}; resolution shells out to `where.exe` on win32. */
export function resolveClaudeExecutable(): ClaudeExecutable | null {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  let value: ClaudeExecutable | null = null;
  const onPath = which("claude");
  if (onPath) {
    value = spawnableClaudeExecutable(onPath);
  } else {
    // The native installer's default drop, not always on PATH.
    const native = join(homedir(), ".local", "bin", process.platform === "win32" ? "claude.exe" : "claude");
    if (existsSync(native)) {
      value = isNativeBinary(native)
        ? { command: native, preArgs: [], path: native, source: "native-installer" }
        : spawnableClaudeExecutable(native);
    }
  }
  cached = { at: Date.now(), value };
  return value;
}

/** `claude --version` → the dotted version ("2.1.303"), or null when the
 *  probe fails or prints nothing version-shaped. Cached per executable;
 *  `force` bypasses the cache (a CLI installed moments ago). */
export function probeClaudeCliVersion(
  exe: ClaudeExecutable,
  timeoutMs = 8_000,
  force = false,
): Promise<string | null> {
  const key = `${exe.command}|${exe.preArgs.join(" ")}`;
  if (!force && cachedVersion && cachedVersion.key === key && Date.now() - cachedVersion.at < CACHE_MS) {
    return Promise.resolve(cachedVersion.value);
  }
  return new Promise((resolve) => {
    execFile(
      exe.command,
      [...exe.preArgs, "--version"],
      {
        timeout: timeoutMs,
        windowsHide: true,
        shell: exe.shell,
        env: { ...process.env, ...exe.env },
      },
      (err, stdout) => {
        const value = err ? null : (stdout.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*/)?.[0] ?? null);
        cachedVersion = { key, at: Date.now(), value };
        resolve(value);
      },
    );
  });
}

/** Dotted-version comparison: negative / zero / positive. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => v.split(/[.+-]/).map((n) => parseInt(n, 10) || 0);
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
