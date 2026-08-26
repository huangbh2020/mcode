/**
 * IPC handlers for language servers (LSP).
 *
 * Each handler validates input with a zod schema, delegates to the singleton
 * `lspManager`, and converts thrown errors into `LspOpResult`/`{ error }`
 * returns so the renderer never sees a rejected invoke. Document-sync and
 * request handlers also enforce that workspacePath is a known project root;
 * `lspManager` re-checks path containment for filePaths.
 */
import type { IpcMain } from "electron";
import {
  IPC,
  LspListSchema,
  LspInstallSchema,
  LspInstallFromFileSchema,
  LspUninstallSchema,
  LspToggleSchema,
  LspSetPathSchema,
  LspHealthCheckSchema,
  LspRestartSchema,
  LspOpenDocSchema,
  LspCloseDocSchema,
  LspDidChangeSchema,
  LspDidSaveSchema,
  LspRequestSchema,
} from "@contracts/ipc";
import { lspManager } from "@main/lsp/LspManager.js";
import { log } from "@main/lib/logger.js";

export function registerLspHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.LSP_LIST, async () => {
    try {
      return await lspManager.list();
    } catch (err) {
      log.warn(`lsp.list failed: ${err instanceof Error ? err.message : String(err)}`);
      return { languages: [] };
    }
  });

  ipcMain.handle(IPC.LSP_INSTALL, async (_evt, raw) => {
    try {
      const input = LspInstallSchema.parse(raw);
      return await lspManager.install(input.language);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`lsp.install failed: ${msg}`);
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle(IPC.LSP_INSTALL_FROM_FILE, async (_evt, raw) => {
    try {
      const input = LspInstallFromFileSchema.parse(raw);
      return await lspManager.installFromFile(input.language, input.archivePath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`lsp.installFromFile failed: ${msg}`);
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle(IPC.LSP_UNINSTALL, async (_evt, raw) => {
    try {
      const input = LspUninstallSchema.parse(raw);
      return await lspManager.uninstall(input.language);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`lsp.uninstall failed: ${msg}`);
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle(IPC.LSP_TOGGLE, async (_evt, raw) => {
    try {
      const input = LspToggleSchema.parse(raw);
      return await lspManager.toggle(input.language, input.enabled);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`lsp.toggle failed: ${msg}`);
      return { languages: [] };
    }
  });

  ipcMain.handle(IPC.LSP_SET_PATH, async (_evt, raw) => {
    try {
      const input = LspSetPathSchema.parse(raw);
      return await lspManager.setPath(input.language, input.serverPath, input.args, input.javaHome);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`lsp.setPath failed: ${msg}`);
      return { languages: [] };
    }
  });

  ipcMain.handle(IPC.LSP_HEALTH_CHECK, async (_evt, raw) => {
    try {
      const input = LspHealthCheckSchema.parse(raw);
      return await lspManager.healthCheck(input.language);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`lsp.healthCheck failed: ${msg}`);
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle(IPC.LSP_RESTART, async (_evt, raw) => {
    try {
      const input = LspRestartSchema.parse(raw);
      return await lspManager.restart(input.workspacePath, input.language);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`lsp.restart failed: ${msg}`);
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle(IPC.LSP_OPEN_DOC, async (_evt, raw) => {
    try {
      const input = LspOpenDocSchema.parse(raw);
      await lspManager.openDocument(input.workspacePath, input.filePath, input.language);
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`lsp.openDocument failed: ${msg}`);
    }
  });

  ipcMain.handle(IPC.LSP_CLOSE_DOC, async (_evt, raw) => {
    try {
      const input = LspCloseDocSchema.parse(raw);
      await lspManager.closeDocument(input.workspacePath, input.filePath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`lsp.closeDocument failed: ${msg}`);
    }
  });

  ipcMain.handle(IPC.LSP_DID_CHANGE, async (_evt, raw) => {
    try {
      const input = LspDidChangeSchema.parse(raw);
      await lspManager.didChange(input.workspacePath, input.filePath, input.text, input.version);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`lsp.didChange failed: ${msg}`);
    }
  });

  ipcMain.handle(IPC.LSP_DID_SAVE, async (_evt, raw) => {
    try {
      const input = LspDidSaveSchema.parse(raw);
      await lspManager.didSave(input.workspacePath, input.filePath, input.text);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`lsp.didSave failed: ${msg}`);
    }
  });

  ipcMain.handle(IPC.LSP_REQUEST, async (_evt, raw) => {
    try {
      const input = LspRequestSchema.parse(raw);
      return await lspManager.request(input.workspacePath, input.language, input.method, input.params);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`lsp.request failed: ${msg}`);
      return { error: { code: -32603, message: msg } };
    }
  });
}
