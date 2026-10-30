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
  /** Command line typed into the shell once it has booted (terminal
   *  sessions auto-launch `claude` this way). Injection waits for the FIRST
   *  output chunk — the shell's first paint proves it is reading stdin —
   *  plus a short settle delay for profile/prompt loading on Windows
   *  PowerShell, whose config load can outpace prompt rendering. */
  initCommand?: string;
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
  outputBuffer: string[];
  bufferedChars: number;
  flushTimer: ReturnType<typeof setTimeout> | null;
}

/** Lazy-load node-pty so a missing native binary doesn't crash app boot —
 *  failure surfaces on first terminal.create instead. Exported for the MCP
 *  OAuth login flow, which needs a real TTY for `claude mcp login` (the CLI
 *  refuses authentication when stdin isn't a terminal). */
export function loadNodePty(): typeof import("node-pty") {
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

/** Settle delay between the shell's first output chunk and the init-command
 *  injection (see CreateTerminalOpts.initCommand). Long enough for
 *  PowerShell profile/prompt paint on cold start, short enough to feel
 *  instant. */
const INIT_COMMAND_SETTLE_MS = 300;

/** Batching window for forwarding PTY output over IPC to renderer (~60 FPS).
 *  Collapses high-throughput streams (e.g. build logs, find/cat bursts) so
 *  the IPC channel and xterm render engine aren't flooded by micro-chunks. */
const TERMINAL_OUTPUT_FLUSH_INTERVAL_MS = 16;

/** Max characters buffered before forcing an immediate IPC flush, ensuring
 *  both high throughput and bounded latency during massive bursts. */
const TERMINAL_OUTPUT_MAX_BUFFERED_CHARS = 65536;

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

    if (!existsSync(opts.cwd)) {
      log.warn(`terminal spawn rejected: cwd does not exist (${opts.cwd})`);
      return { ok: false, error: `工作目录不存在或已被移除: ${opts.cwd}` };
    }
    try {
      if (!statSync(opts.cwd).isDirectory()) {
        log.warn(`terminal spawn rejected: cwd is not a directory (${opts.cwd})`);
        return { ok: false, error: `工作目录必须是文件夹: ${opts.cwd}` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`terminal spawn rejected: failed to stat cwd (${opts.cwd}): ${msg}`);
      return { ok: false, error: `无法访问工作目录 (${opts.cwd}): ${msg}` };
    }

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
      let msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("error code: 267") || msg.includes("267")) {
        msg = `${msg} (工作目录无效或不存在: ${opts.cwd})`;
      }
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

    const live: LiveTerminal = {
      id,
      pty,
      info,
      outputBuffer: [],
      bufferedChars: 0,
      flushTimer: null,
    };
    this.terminals.set(id, live);

    let initInjected = false;
    pty.onData((data) => {
      // One-shot init command (terminal sessions): the first output chunk
      // means the shell has booted and is reading stdin. A fixed settle
      // delay after it absorbs PowerShell profile load + prompt paint;
      // writing earlier risks the command landing before readline is up and
      // being swallowed. Guarded by the terminals-map check below like the
      // forwarding path, so a kill between spawn and injection is a no-op.
      if (opts.initCommand && !initInjected) {
        initInjected = true;
        setTimeout(() => {
          if (!this.terminals.has(id)) return;
          try {
            live.pty.write(`${opts.initCommand}\r`);
            log.info(`terminal init command injected: ${id}`);
          } catch (err) {
            log.warn(
              `terminal init command failed: ${id} ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }, INIT_COMMAND_SETTLE_MS);
      }
      // Drop if already removed (race with kill/exit).
      if (!this.terminals.has(id)) return;

      live.outputBuffer.push(data);
      live.bufferedChars += data.length;
      if (live.bufferedChars >= TERMINAL_OUTPUT_MAX_BUFFERED_CHARS) {
        this.flushOutput(live);
      } else if (!live.flushTimer) {
        live.flushTimer = setTimeout(() => {
          if (this.terminals.has(id)) {
            this.flushOutput(live);
          }
        }, TERMINAL_OUTPUT_FLUSH_INTERVAL_MS);
      }
    });

    pty.onExit(({ exitCode }) => {
      // Flush any lingering buffered output before notifying renderer of exit.
      this.flushOutput(live);
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

  private flushOutput(live: LiveTerminal): void {
    if (live.flushTimer) {
      clearTimeout(live.flushTimer);
      live.flushTimer = null;
    }
    if (live.outputBuffer.length === 0) return;
    const data = live.outputBuffer.join("");
    live.outputBuffer = [];
    live.bufferedChars = 0;
    sendToRenderer(IPC.TERMINAL_DATA, {
      channel: IPC.TERMINAL_DATA,
      terminalId: live.id,
      data,
    });
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
    this.flushOutput(live);
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
