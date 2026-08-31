/**
 * Owns all node-pty sessions for the integrated terminal.
 *
 * Renderer never touches PTY handles — it only sees opaque terminalIds and
 * streams I/O over IPC push channels. Paths are validated by the IPC layer
 * before create() is called; this class assumes cwd is already trusted.
 */
import { randomUUID } from "node:crypto";
import { existsSync, statSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import type { IPty } from "node-pty";
import { IPC } from "@contracts/ipc";
import type { TerminalInfo } from "@contracts/ipc";
import { sendToRenderer } from "@main/window.js";
import { log } from "@main/lib/logger.js";
import { resolveDefaultShell } from "./shellResolve.js";
import { buildTerminalEnv } from "./envRefresh.js";

const require = createRequire(import.meta.url);

export interface CreateTerminalOpts {
  projectPath: string;
  cwd: string;
  cols?: number;
  rows?: number;
  /** Per-create shell override (already preferred over settings by caller). */
  shell?: string;
  /** Settings-level shell override (used when per-create shell is absent). */
  shellSetting?: string | null;
}

export interface CreateTerminalSuccess {
  ok: true;
  terminalId: string;
  pid: number;
  cwd: string;
  shell: string;
}

export interface CreateTerminalFailure {
  ok: false;
  error: string;
}

interface LiveTerminal {
  id: string;
  pty: IPty;
  info: TerminalInfo;
}

/** Lazy-load node-pty so a missing native binary doesn't crash app boot —
 *  failure surfaces on first terminal.create instead. */
function loadNodePty(): typeof import("node-pty") {
  const mod = require("node-pty") as typeof import("node-pty");
  ensureSpawnHelperExecutable();
  return mod;
}

/** node-pty on POSIX spawns a tiny `spawn-helper` binary via posix_spawnp.
 *  pnpm/tar extraction is known to drop the executable bit on that helper
 *  (the prebuild ships it as `-rw-r--r--`), which makes every `pty.spawn()`
 *  fail with the opaque `posix_spawnp failed.`. Fix it proactively: locate
 *  the helper next to the native addon and `chmod 0o755` it if it lacks +x.
 *  No-op on Windows (ConPTY path doesn't use a helper). */
function ensureSpawnHelperExecutable(): void {
  if (process.platform === "win32") return;
  try {
    // node-pty's utils.js resolves the native dir as one of
    //   {build/Release, build/Debug, prebuilds/<plat>-<arch>}
    // relative to node-pty's own lib dir. Replicate that lookup so the fix
    // works both in dev (prebuilds/) and after a native rebuild (build/).
    const ptyRoot = require.resolve("node-pty/lib/unixTerminal.js");
    const libDir = dirname(ptyRoot);
    const platArch = `${process.platform}-${process.arch}`;
    const candidates = [
      join(libDir, "..", "build", "Release"),
      join(libDir, "..", "build", "Debug"),
      join(libDir, "..", "prebuilds", platArch),
    ];
    for (const dir of candidates) {
      const helper = join(dir, "spawn-helper");
      if (!existsSync(helper)) continue;
      try {
        if (!(statSync(helper).mode & 0o111)) {
          chmodSync(helper, 0o755);
          log.info(`spawn-helper chmod +x: ${helper}`);
        }
      } catch (e) {
        // chmod failing is non-fatal — the spawn will surface a clearer error.
        log.warn(`spawn-helper chmod failed (${helper}): ${e instanceof Error ? e.message : String(e)}`);
      }
      return; // first existing helper wins
    }
  } catch {
    // resolve failed / unexpected layout — fall through; node-pty will throw
    // its own (typed) error from loadNativeModule instead.
  }
}

class TerminalManagerImpl {
  private readonly terminals = new Map<string, LiveTerminal>();

  /**
   * Async because the env build refreshes the live Windows registry environment
   * (see envRefresh.ts) before spawning — a fresh system-terminal-equivalent
   * env costs one short-lived powershell.exe run (~hundreds of ms cold).
   */
  async create(opts: CreateTerminalOpts): Promise<CreateTerminalSuccess | CreateTerminalFailure> {
    const cols = opts.cols ?? 80;
    const rows = opts.rows ?? 24;
    const resolved = resolveDefaultShell(opts.shell ?? opts.shellSetting ?? null);

    let ptyMod: typeof import("node-pty");
    try {
      ptyMod = loadNodePty();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`node-pty failed to load: ${msg}`);
      return {
        ok: false,
        error: `无法加载终端原生模块 (node-pty): ${msg}`,
      };
    }

    const { env, registryVarsApplied } = await buildTerminalEnv();
    if (process.platform === "win32") {
      if (registryVarsApplied === null) {
        log.warn("terminal env: registry refresh failed, using inherited process env");
      } else {
        log.info(`terminal env: refreshed ${registryVarsApplied} vars from live registry`);
      }
    }
    env.TERM = "xterm-256color";
    env.COLORTERM = env.COLORTERM ?? "truecolor";
    // Force UTF-8 where shells honour it.
    env.LANG = env.LANG ?? "en_US.UTF-8";

    const id = randomUUID();
    let pty: IPty;
    try {
      // On Windows, force the conpty.dll path (useConptyDll: true). node-pty's
      // default ConPTY path (useConptyDll: false) forks a helper process
      // (conpty_console_list_agent) on every kill(); that helper calls
      // AttachConsole(shellPid), which races with the shell exiting and throws
      // an uncaught "Error: AttachConsole failed" from the forked child. It's
      // harmless (the child crashes, parent carries on with a 5s fallback) but
      // spams stderr on app shutdown (disposeAll -> kill each terminal) and on
      // every terminal close. The DLL path kills via inSocket.destroy() +
      // ptyNative.kill() and never forks the agent, eliminating the noise.
      // Non-Windows ignores the option.
      pty = ptyMod.spawn(resolved.file, resolved.args, {
        name: "xterm-256color",
        cols,
        rows,
        cwd: opts.cwd,
        env,
        useConptyDll: process.platform === "win32",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`terminal spawn failed: ${resolved.file} ${msg}`);
      return { ok: false, error: `启动 shell 失败 (${resolved.label}): ${msg}` };
    }

    const info: TerminalInfo = {
      terminalId: id,
      cwd: opts.cwd,
      shell: resolved.label,
      pid: pty.pid,
      projectPath: opts.projectPath,
    };

    const live: LiveTerminal = { id, pty, info };
    this.terminals.set(id, live);

    pty.onData((data) => {
      // Drop if already removed (race with kill/exit).
      if (!this.terminals.has(id)) return;
      sendToRenderer(IPC.TERMINAL_DATA, {
        channel: IPC.TERMINAL_DATA,
        terminalId: id,
        data,
      });
    });

    pty.onExit(({ exitCode }) => {
      // onExit may fire after kill() already deleted the entry — still notify
      // renderer so UI can flip to "exited" if it hasn't already.
      this.terminals.delete(id);
      sendToRenderer(IPC.TERMINAL_EXIT, {
        channel: IPC.TERMINAL_EXIT,
        terminalId: id,
        exitCode: typeof exitCode === "number" ? exitCode : null,
      });
      log.info(`terminal exited: ${id} code=${exitCode}`);
    });

    log.info(`terminal created: ${id} shell=${resolved.label} cwd=${opts.cwd}`);
    return {
      ok: true,
      terminalId: id,
      pid: pty.pid,
      cwd: opts.cwd,
      shell: resolved.label,
    };
  }

  write(terminalId: string, data: string): boolean {
    const live = this.terminals.get(terminalId);
    if (!live) return false;
    try {
      live.pty.write(data);
      return true;
    } catch (err) {
      log.warn(`terminal write failed: ${terminalId} ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  resize(terminalId: string, cols: number, rows: number): boolean {
    const live = this.terminals.get(terminalId);
    if (!live) return false;
    try {
      live.pty.resize(cols, rows);
      return true;
    } catch (err) {
      log.warn(`terminal resize failed: ${terminalId} ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  kill(terminalId: string): boolean {
    const live = this.terminals.get(terminalId);
    if (!live) return false;
    this.terminals.delete(terminalId);
    try {
      live.pty.kill();
    } catch (err) {
      log.warn(`terminal kill failed: ${terminalId} ${err instanceof Error ? err.message : String(err)}`);
    }
    // Emit exit so renderer cleans up even if onExit is slow/missing.
    sendToRenderer(IPC.TERMINAL_EXIT, {
      channel: IPC.TERMINAL_EXIT,
      terminalId,
      exitCode: null,
    });
    return true;
  }

  list(projectPath?: string): TerminalInfo[] {
    const all = [...this.terminals.values()].map((t) => t.info);
    if (!projectPath) return all;
    const norm = projectPath;
    return all.filter((t) => t.projectPath === norm);
  }

  /** Kill every live PTY — call on app quit. */
  disposeAll(): void {
    const ids = [...this.terminals.keys()];
    for (const id of ids) {
      this.kill(id);
    }
  }
}

/** Process-wide singleton. */
export const TerminalManager = new TerminalManagerImpl();
