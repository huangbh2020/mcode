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
import { resolve } from "node:path";
import {
  IPC,
  TerminalCreateSchema,
  TerminalWriteSchema,
  TerminalResizeSchema,
  TerminalKillSchema,
  TerminalListSchema,
  TERMINAL_SHELL_SETTING_KEY,
} from "@contracts/ipc";
import { isKnownWorkspaceRoot, pathWithin } from "@main/lib/pathGuard.js";
import { SettingRepo } from "@main/store/repositories.js";
import { TerminalManager } from "@main/terminal/TerminalManager.js";
import { log } from "@main/lib/logger.js";

export function registerTerminalHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.TERMINAL_CREATE, async (_evt, raw) => {
    try {
      const input = TerminalCreateSchema.parse(raw);
      const projectPath = resolve(input.projectPath);

      if (!isKnownWorkspaceRoot(projectPath)) {
        return { ok: false as const, error: "未知项目路径，拒绝创建终端" };
      }

      const cwd = resolve(input.cwd ?? projectPath);
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
}
