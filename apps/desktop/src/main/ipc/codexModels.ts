/**
 * IPC handlers for the Codex model-provider panel (third-party
 * Responses-API endpoints driving the Codex harness).
 *
 * - list      : all configured providers (hasApiKey flag, never cleartext)
 * - save      : create/update one provider; apiKey is encrypted into the
 *               settings table (codexProviderKeys) and config.toml is
 *               rematerialized (the key never lands in the TOML)
 * - delete    : remove provider + key, rematerialize config.toml
 * - getApiKey : settings-UI eye-icon only — same security carve-out as
 *               customModel.getToken (turn-time resolution stays in main)
 */
import type { IpcMain } from "electron";
import {
  IPC,
  SaveCodexProviderSchema,
  DeleteCodexProviderSchema,
  GetCodexApiKeySchema,
} from "@contracts/ipc";
import { CodexModelsStore } from "@main/lib/codexModelsStore.js";
import { log } from "@main/lib/logger.js";

export function registerCodexModelsHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.CODEX_MODELS_LIST, async () => {
    const providers = await CodexModelsStore.listPublic();
    return { providers };
  });

  ipcMain.handle(IPC.CODEX_MODELS_SAVE, async (_evt, raw) => {
    const input = SaveCodexProviderSchema.parse(raw);
    const providers = await CodexModelsStore.saveProvider(
      input.id,
      { name: input.name, baseUrl: input.baseUrl, models: input.models },
      input.apiKey,
    );
    return { providers };
  });

  ipcMain.handle(IPC.CODEX_MODELS_DELETE, async (_evt, raw) => {
    const input = DeleteCodexProviderSchema.parse(raw);
    const providers = await CodexModelsStore.deleteProvider(input.id);
    return { providers };
  });

  ipcMain.handle(IPC.CODEX_MODELS_GET_API_KEY, async (_evt, raw) => {
    try {
      const input = GetCodexApiKeySchema.parse(raw);
      return { apiKey: CodexModelsStore.resolveApiKey(input.id) };
    } catch (err) {
      log.error(`codexModels.getApiKey: ${(err as Error).message}`);
      return { apiKey: null };
    }
  });
}
