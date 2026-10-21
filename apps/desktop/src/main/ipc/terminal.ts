/**
 * IPC handlers for the integrated terminal (create / write / resize / kill / list).
 *
 * Security: every create is scoped to a known project root. `cwd` must resolve
 * inside that root (defaults to the root itself). Write/resize/kill only accept
 * opaque terminalIds issued by us — no path trust issues there.
 *
 * Errors degrade to `{ ok: false, error }` rather than throwing into renderer.
 */
import type { IpcMain } from "electron";
import { app, shell } from "electron";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  IPC,
  TerminalCreateSchema,
  TerminalWriteSchema,
  TerminalResizeSchema,
  TerminalKillSchema,
  TerminalListSchema,
  TerminalHistorySaveSchema,
  TerminalHistoryLoadSchema,
  TerminalSuggestTitleSchema,
  TerminalResolvePathSchema,
  TerminalCliActionSchema,
  TERMINAL_SHELL_SETTING_KEY,
  TERMINAL_HISTORY_SETTING_KEY,
  UI_TITLE_GEN_ENABLED_SETTING_KEY,
  UI_TITLE_GEN_MODEL_SETTING_KEY,
} from "@contracts/ipc";
import { resolvePrintedPathWithCandidates } from "@main/lib/terminalPathResolve.js";
import { isKnownWorkspaceRoot, pathWithin } from "@main/lib/pathGuard.js";
import { SessionRepo, ProjectRepo, SettingRepo } from "@main/store/repositories.js";
import { TerminalManager } from "@main/terminal/TerminalManager.js";
import { resolveDefaultShell, resolveEffectiveShell } from "@main/terminal/shellResolve.js";
import {
  probeClaudeCli,
  reconcileTerminalClaudeSessionId,
} from "@main/lib/claudeCli.js";
import {
  listTerminalCliStatuses,
  checkTerminalCliUpdates,
  installTerminalCli,
  uninstallTerminalCli,
  findTerminalCliEntry,
} from "@main/lib/terminalCliCatalog.js";
import { reconcileCodexTerminalSessionId } from "@main/lib/codexSession.js";
import { reconcileAgyTerminalSessionId } from "@main/lib/agySession.js";
import { reconcileOpenCodeTerminalSessionId } from "@main/lib/opencodeSession.js";
import { saveTerminalHistory, loadTerminalHistory } from "@main/lib/terminalHistory.js";
import {
  extractTerminalTitleExcerpt,
  TERMINAL_TITLE_MIN_CONTENT,
  isDefaultTerminalTitle,
} from "@main/lib/terminalTitle.js";
import { generateTerminalSessionTitle } from "@main/ipc/titleGen.js";
import { log } from "@main/lib/logger.js";

/** Base dir for terminal-session scrollback snapshots (per-session .ser
 *  files). Resolved lazily — the app object is only usable after Electron's
 *  ready phase, and handlers run well after that. */
function historyBaseDir(): string {
  return join(app.getPath("userData"), "term-history");
}

export function registerTerminalHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.TERMINAL_CREATE, async (_evt, raw) => {
    try {
      const input = TerminalCreateSchema.parse(raw);
      const projectPath = resolve(input.projectPath);

      if (!isKnownWorkspaceRoot(projectPath)) {
        return { ok: false as const, error: "未知项目路径，拒绝创建终端" };
      }

      if (!existsSync(projectPath)) {
        return { ok: false as const, error: `项目目录不存在或已被移除: ${projectPath}` };
      }

      let cwd = resolve(input.cwd ?? projectPath);
      if (!existsSync(cwd)) {
        // 子目录不存在时回退到项目根目录
        cwd = projectPath;
      }

      if (!pathWithin(projectPath, cwd)) {
        return { ok: false as const, error: "cwd 必须位于项目目录内" };
      }

      const shellSetting = SettingRepo.get(TERMINAL_SHELL_SETTING_KEY);

      return await TerminalManager.create({
        projectPath,
        cwd,
        cols: input.cols,
        rows: input.rows,
        shell: input.shell,
        shellSetting,
        initCommand: input.initCommand,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`terminal.create failed: ${msg}`);
      return { ok: false as const, error: msg };
    }
  });

  ipcMain.handle(IPC.TERMINAL_WRITE, async (_evt, raw) => {
    try {
      const input = TerminalWriteSchema.parse(raw);
      const ok = TerminalManager.write(input.terminalId, input.data);
      return ok ? { ok: true as const } : { ok: false as const, error: "终端不存在或已退出" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false as const, error: msg };
    }
  });

  ipcMain.handle(IPC.TERMINAL_RESIZE, async (_evt, raw) => {
    try {
      const input = TerminalResizeSchema.parse(raw);
      const ok = TerminalManager.resize(input.terminalId, input.cols, input.rows);
      return ok ? { ok: true as const } : { ok: false as const, error: "终端不存在或已退出" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false as const, error: msg };
    }
  });

  ipcMain.handle(IPC.TERMINAL_KILL, async (_evt, raw) => {
    try {
      const input = TerminalKillSchema.parse(raw);
      const ok = TerminalManager.kill(input.terminalId);
      // Killing an already-gone id is still ok from the renderer's POV.
      return { ok: true as const, ...(ok ? {} : { error: "终端不存在或已退出" }) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false as const, error: msg };
    }
  });

  ipcMain.handle(IPC.TERMINAL_LIST, async (_evt, raw) => {
    try {
      const input = TerminalListSchema.parse(raw ?? {});
      const projectPath = input.projectPath ? resolve(input.projectPath) : undefined;
      return { terminals: TerminalManager.list(projectPath) };
    } catch (err) {
      log.warn(`terminal.list failed: ${err instanceof Error ? err.message : String(err)}`);
      return { terminals: [] };
    }
  });

  // Settings feedback for `terminal.shell`: "which shell will a new terminal
  // actually run?" — answered without spawning anything. The settings panel
  // uses it to say which shell is in effect, and to shout when the configured
  // path doesn't resolve (create() falls back to the platform default
  // silently, so a typo would otherwise look like "the setting does nothing").
  ipcMain.handle(IPC.TERMINAL_RESOLVE_SHELL, () => {
    const setting = SettingRepo.get(TERMINAL_SHELL_SETTING_KEY);
    const { shell, source } = resolveEffectiveShell(setting);
    return {
      shell: shell.label,
      source,
      ...(source === "default" && setting?.trim() ? { failedSetting: setting.trim() } : {}),
      defaultShell: resolveDefaultShell(null).label,
    };
  });

  // ── Terminal sessions (user's own Claude CLI in a PTY) ──

  // Probe the user's CLI (path + version) for the session pane's badge and
  // the not-installed empty state. Cached in main (10 min).
  ipcMain.handle(IPC.TERMINAL_CLI_PROBE, () => probeClaudeCli());

  // ── Terminal-CLI management (设置 → Agent → 终端会话类型) ──
  // List/check/install/uninstall the four terminal CLIs. Enable/disable is
  // a plain renderer setting (TERMINAL_CLI_ENABLED_SETTING_KEY) and never
  // crosses IPC here.

  ipcMain.handle(IPC.TERMINAL_CLI_LIST, async () => {
    try {
      return { clis: await listTerminalCliStatuses() };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`terminal.cliList failed: ${msg}`);
      return { clis: [] };
    }
  });

  ipcMain.handle(IPC.TERMINAL_CLI_CHECK_UPDATES, async () => {
    try {
      return { results: await checkTerminalCliUpdates() };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`terminal.cliCheckUpdates failed: ${msg}`);
      return { results: [] };
    }
  });

  ipcMain.handle(IPC.TERMINAL_CLI_INSTALL, async (_evt, raw) => {
    try {
      const input = TerminalCliActionSchema.parse(raw);
      // External CLIs (agy) have no npm package — "install" opens the
      // official download page in the OS browser; its own installer manages
      // the rest.
      const entry = findTerminalCliEntry(input.providerId);
      if (entry && !entry.packageName) {
        if (entry.downloadUrl) await shell.openExternal(entry.downloadUrl);
        return { ok: true as const };
      }
      return await installTerminalCli(input.providerId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`terminal.cliInstall failed: ${msg}`);
      return { ok: false as const, error: msg };
    }
  });

  ipcMain.handle(IPC.TERMINAL_CLI_UNINSTALL, async (_evt, raw) => {
    try {
      const input = TerminalCliActionSchema.parse(raw);
      return await uninstallTerminalCli(input.providerId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`terminal.cliUninstall failed: ${msg}`);
      return { ok: false as const, error: msg };
    }
  });

  // Scrollback snapshot persistence, gated on the `terminal.persistHistory`
  // setting ("0" disables — terminal output may hold text the user printed
  // deliberately, so persistence is opt-out).
  ipcMain.handle(IPC.TERMINAL_HISTORY_SAVE, (_evt, raw) => {
    try {
      const input = TerminalHistorySaveSchema.parse(raw);
      if (SettingRepo.get(TERMINAL_HISTORY_SETTING_KEY) === "0") {
        return { ok: true as const };
      }
      const result = saveTerminalHistory(historyBaseDir(), input.sessionId, input.content, {
        cols: input.cols ?? 0,
        rows: input.rows ?? 0,
      });
      // Resume reconciliation piggybacks on the 3s save tick (throttled to
      // 30s in-main), dispatched per CLI: claude's pin can be dropped by a
      // CLI auto-update relaunch (adopt from ~/.claude/projects); codex and
      // opencode have no pin at all (adopt from ~/.codex/sessions rollouts
      // resp. opencode's SQLite session table); pi's --session-id pin is
      // deterministic and needs nothing.
      if (result.ok) {
        const session = SessionRepo.get(input.sessionId);
        const project = session ? ProjectRepo.get(session.projectId) : undefined;
        if (session && project) {
          if (session.providerId === "codex-sdk") {
            reconcileCodexTerminalSessionId(session);
          } else if (session.providerId === "antigravity") {
            reconcileAgyTerminalSessionId(session);
          } else if (session.providerId === "opencode") {
            reconcileOpenCodeTerminalSessionId(session, project.path);
          } else {
            reconcileTerminalClaudeSessionId(session, project.path);
          }
        }
      }
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false as const, error: msg };
    }
  });

  ipcMain.handle(IPC.TERMINAL_HISTORY_LOAD, (_evt, raw) => {
    try {
      const input = TerminalHistoryLoadSchema.parse(raw);
      const session = SessionRepo.get(input.sessionId);
      let claudeSessionId = session?.claudeSessionId ?? null;
      if (session && session.kind === "terminal" && session.providerId === "opencode") {
        if (!claudeSessionId || !claudeSessionId.startsWith("ses")) {
          const project = ProjectRepo.get(session.projectId);
          if (project) {
            const adopted = reconcileOpenCodeTerminalSessionId(session, project.path, undefined, true);
            if (adopted) claudeSessionId = adopted;
          }
        }
      }
      const data = loadTerminalHistory(historyBaseDir(), input.sessionId);
      if (!data) return { content: null, claudeSessionId };
      return { content: data.content, cols: data.cols, rows: data.rows, claudeSessionId };
    } catch (err) {
      log.warn(`terminal.loadHistory failed: ${err instanceof Error ? err.message : String(err)}`);
      return { content: null };
    }
  });

  // Auto-name a terminal session (titleGen variant — see lib/terminalTitle.ts
  // and titleGen.ts:generateTerminalSessionTitle). The gates that decide
  // "retry later" vs "done" run synchronously here so the renderer can stop
  // or keep polling without awaiting the LLM; the query itself is
  // fire-and-forget and its result lands via session:titleUpdated +
  // session.changed like every other rename.
  ipcMain.handle(IPC.TERMINAL_SUGGEST_TITLE, (_evt, raw) => {
    try {
      const input = TerminalSuggestTitleSchema.parse(raw);
      const session = SessionRepo.get(input.sessionId);
      if (!session || session.kind !== "terminal") return { done: true };
      // Already named (manual rename or a previous generation) — permanent.
      if (!isDefaultTerminalTitle(session.title)) return { done: true };
      // Feature/model not configured yet — retryable (user may enable
      // mid-session; the next snapshot tick asks again).
      if (SettingRepo.get(UI_TITLE_GEN_ENABLED_SETTING_KEY) !== "on") {
        return { done: false };
      }
      if (!SettingRepo.get(UI_TITLE_GEN_MODEL_SETTING_KEY)) return { done: false };
      const excerpt = extractTerminalTitleExcerpt(input.content);
      if (excerpt.length < TERMINAL_TITLE_MIN_CONTENT) return { done: false };
      void generateTerminalSessionTitle(session, excerpt);
      return { done: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`terminal.suggestTitle failed: ${msg}`);
      return { done: false };
    }
  });

  // Click-to-open file paths: resolve a candidate printed in terminal
  // output to an EXISTING FILE (never a directory). Delegates to
  // lib/terminalPathResolve.ts — direct root-relative/absolute resolution
  // first, then a bounded basename walk. Unique matches resolve to the file;
  // ambiguous BARE names come back as a candidate list so the renderer can
  // ask "which one" instead of dead-clicking.
  ipcMain.handle(IPC.TERMINAL_RESOLVE_PATH, (_evt, raw) => {
    try {
      const input = TerminalResolvePathSchema.parse(raw);
      if (!isKnownWorkspaceRoot(resolve(input.projectPath))) {
        return { path: null, candidates: [] };
      }
      return resolvePrintedPathWithCandidates(input.projectPath, input.path);
    } catch (err) {
      log.warn(`terminal.resolvePath failed: ${err instanceof Error ? err.message : String(err)}`);
      return { path: null, candidates: [] };
    }
  });
}
