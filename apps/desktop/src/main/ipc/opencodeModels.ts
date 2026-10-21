/**
 * IPC handlers for the OpenCode (v2) provider's official-login surface:
 * model list, integration auth status, API-key connect, credential logout.
 * All state lives inside opencode itself (SQLite credential store shared
 * with the user's terminal CLI) — Mcode persists nothing here.
 */
import type { IpcMain } from "electron";
import {
  IPC,
  OpenCodeListModelsSchema,
  OpenCodeConnectKeySchema,
  OpenCodeLogoutSchema,
} from "@contracts/ipc";
import {
  listOpenCodeModels,
  openCodeAuthStatus,
  connectOpenCodeKey,
  logoutOpenCode,
} from "@main/providers/opencode-sdk/opencodeModels.js";

export function registerOpenCodeHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.OPENCODE_LIST_MODELS, async (_evt, raw) => {
    const input = OpenCodeListModelsSchema.parse(raw ?? {});
    return listOpenCodeModels(input.directory);
  });

  ipcMain.handle(IPC.OPENCODE_AUTH_STATUS, async () => {
    return openCodeAuthStatus();
  });

  ipcMain.handle(IPC.OPENCODE_CONNECT_KEY, async (_evt, raw) => {
    const input = OpenCodeConnectKeySchema.parse(raw);
    return connectOpenCodeKey(input.integrationId, input.key, input.label);
  });

  ipcMain.handle(IPC.OPENCODE_LOGOUT, async (_evt, raw) => {
    const input = OpenCodeLogoutSchema.parse(raw);
    return logoutOpenCode(input.credentialId);
  });
}
