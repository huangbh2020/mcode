/**
 * IPC handlers for ripgrep availability + one-click install.
 *
 * These drive the search dialog's "ripgrep 未安装" banner: `rg.status` tells
 * the renderer whether a binary is resolvable (and whether an install is
 * already in flight), `rg.install` downloads the pinned release into
 * userData/bin and resets the resolution cache. Handlers never reject —
 * failures return `{ ok: false, error }` (same shape as the LSP ops).
 */
import type { IpcMain } from "electron";
import { IPC } from "@contracts/ipc";
import { resolveRg } from "@main/lib/rgSearch.js";
import { installRg, isRgInstalling } from "@main/lib/rgInstall.js";
import { log } from "@main/lib/logger.js";

export function registerRgHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.RG_STATUS, async () => {
    try {
      const path = resolveRg();
      return { available: path != null, path: path ?? undefined, installing: isRgInstalling() };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`rg.status failed: ${msg}`);
      return { available: false, installing: false };
    }
  });

  ipcMain.handle(IPC.RG_INSTALL, async () => {
    try {
      return await installRg();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`rg.install failed: ${msg}`);
      return { ok: false, error: msg };
    }
  });
}