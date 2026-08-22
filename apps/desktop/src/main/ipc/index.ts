import { ipcMain, type IpcMain } from "electron";
import { IPC } from "@contracts/ipc";
import { awaitDb } from "@main/store/db.js";
import { registerProjectHandlers } from "./projects.js";
import { registerClaudeHandlers } from "./claude.js";
import { registerDialogHandlers } from "./dialog.js";
import { registerCustomModelHandlers } from "./customModel.js";
import { registerPiModelsHandlers } from "./piModels.js";
import { registerThemeHandlers } from "./theme.js";
import { registerFileHandlers } from "./files.js";
import { registerGitHandlers } from "./git.js";
import { registerTerminalHandlers } from "./terminal.js";
import { registerAppHandlers } from "./app.js";
import { registerShellHandlers } from "./shell.js";
import { registerUpdaterHandlers } from "./updater.js";
import { registerSkillsHandlers } from "./skills.js";
import { registerMcpHandlers } from "./mcp.js";
import { registerOutputStyleHandlers } from "./outputStyle.js";
import { registerUsageHandlers } from "./usage.js";
import { registerLspHandlers } from "./lsp.js";
import { registerBrowserHandlers } from "./browser.js";
import { registerNotificationHandlers } from "./notifications.js";
import { registerMobileHandlers } from "./mobile.js";
import { registerRelayHandlers } from "./relay.js";
import { registerVoiceHandlers } from "./voice.js";

/**
 * Wrap `ipcMain` so every `handle()` registration automatically awaits DB
 * readiness before invoking the handler. This decouples window creation from
 * DB init: the renderer may fire IPC before sql.js finishes loading, and those
 * calls simply queue on `awaitDb()` instead of hitting the "getDb() called
 * before initDb() resolved" throw. Once the DB is ready the promise is
 * already resolved, so the guard is a no-op for all subsequent calls.
 *
 * Only the `handle` method is intercepted; the register* functions use nothing
 * else from IpcMain, so a minimal object suffices.
 */
function createDbGuardedIpc(target: IpcMain): IpcMain {
  const wrapped: Pick<IpcMain, "handle"> = {
    handle(channel, handler) {
      target.handle(channel, async (event, raw) => {
        await awaitDb();
        return handler(event, raw);
      });
    },
  };
  return wrapped as unknown as IpcMain;
}

/** Register all renderer->main IPC handlers. */
export function registerIpcHandlers(): void {
  const ipc = createDbGuardedIpc(ipcMain);
  registerProjectHandlers(ipc);
  registerClaudeHandlers(ipc);
  registerDialogHandlers(ipc);
  registerCustomModelHandlers(ipc);
  registerPiModelsHandlers(ipc);
  registerThemeHandlers(ipc);
  registerFileHandlers(ipc);
  registerGitHandlers(ipc);
  registerTerminalHandlers(ipc);
  registerAppHandlers(ipc);
  registerShellHandlers(ipc);
  registerUpdaterHandlers(ipc);
  registerSkillsHandlers(ipc);
  registerMcpHandlers(ipc);
  registerOutputStyleHandlers(ipc);
  registerUsageHandlers(ipc);
  registerLspHandlers(ipc);
  registerBrowserHandlers(ipc);
  registerNotificationHandlers(ipc);
  registerMobileHandlers(ipc);
  registerRelayHandlers(ipc);
  registerVoiceHandlers(ipc);
}

// Re-export channel constants so handlers stay aligned with the contract.
export { IPC };
