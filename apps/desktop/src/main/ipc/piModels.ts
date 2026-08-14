/**
 * IPC handlers for the Pi models visual editor (~/.pi/agent/models.json).
 *
 * - list          : return all custom providers (with hasApiKey flag, never cleartext)
 * - save          : create/update one provider. Encrypted apiKey is stored in
 *                   the settings table (piProviderKeys); the models.json file
 *                   is credential-free.
 * - delete        : remove a provider from both models.json and the encrypted map
 * - getApiKey     : main-process only — returns the cleartext apiKey for the
 *                   given provider. Used by PiAgentSdkProvider at turn time.
 * - listAvailable : returns the pi ModelRuntime's getAvailable() projected
 *                   into BuiltinModelOption[] for the composer's model picker.
 */
import type { IpcMain } from "electron";
import {
  IPC,
  SavePiProviderSchema,
  DeletePiProviderSchema,
  GetPiApiKeySchema,
} from "@contracts/ipc";
import type { BuiltinModelOption } from "@contracts/provider";
import { PI_1M_CONTEXT_WINDOW } from "@contracts/piModel";
import type { PiProviderConfig } from "@contracts/piModel";
import { PiModelsStore } from "@main/lib/piModelsStore.js";
import { loadPiSdk } from "@main/providers/pi-sdk/piSdkLoader.js";
import { log } from "@main/lib/logger.js";

/** Best-effort projection of a pi Model into BuiltinModelOption.
 *  `providerId/modelId` shape lets the picker send a single string to
 *  `req.model` that Pi understands. Only 1M-context models carry a hint
 *  ("1M"); everything else shows no trailing text after the model name
 *  (threshold matches the settings panel's 1M toggle). */
function projectModel(model: { id: string; name?: string; provider: string; contextWindow?: number }): BuiltinModelOption {
  const hint =
    model.contextWindow && model.contextWindow >= PI_1M_CONTEXT_WINDOW ? "1M" : undefined;
  return {
    id: `${model.provider}/${model.id}`,
    label: model.name ?? model.id,
    hint,
  };
}

/** Shared listAvailable core — used by both the desktop IPC handler and the
 *  mobile RPC whitelist. Injects every configured apiKey so the SDK's
 *  auth-priority chain reports custom providers as authenticated. Non-fatal on
 *  failure: returns [] so the picker just shows nothing for pi. */
export async function listAvailablePiModels(): Promise<BuiltinModelOption[]> {
  try {
    const sdk = await loadPiSdk();
    const runtime = await sdk.ModelRuntime.create();
    // Inject every configured apiKey so the SDK's auth-priority chain
    // reports these models as authenticated (the env-fallback won't
    // have credentials for custom providers).
    const publicProviders = await PiModelsStore.listPublic();
    for (const [name, pub] of Object.entries(publicProviders)) {
      if (!pub.hasApiKey) continue;
      const key = PiModelsStore.resolveApiKey(name);
      if (key) await runtime.setRuntimeApiKey(name, key);
    }
    const available = await runtime.getAvailable();
    return available.map((m) => projectModel(m));
  } catch (err) {
    // Non-fatal: return empty so the picker just shows nothing for pi.
    // Common case is pi SDK failed to load on a non-pi-user's machine.
    log.warn(`piModels.listAvailable failed: ${(err as Error).message}`);
    return [];
  }
}

export function registerPiModelsHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.PI_MODELS_LIST, async () => {
    const providers = await PiModelsStore.listPublic();
    return { providers };
  });

  ipcMain.handle(IPC.PI_MODELS_SAVE, async (_evt, raw) => {
    const input = SavePiProviderSchema.parse(raw) as {
      name: string;
      config: unknown;
      apiKey?: string;
    };
    const providers = await PiModelsStore.saveProvider(
      input.name,
      input.config as PiProviderConfig,
      input.apiKey,
    );
    return { providers };
  });

  ipcMain.handle(IPC.PI_MODELS_DELETE, async (_evt, raw) => {
    const input = DeletePiProviderSchema.parse(raw);
    const providers = await PiModelsStore.deleteProvider(input.name);
    return { providers };
  });

  ipcMain.handle(IPC.PI_MODELS_GET_API_KEY, async (_evt, raw) => {
    const input = GetPiApiKeySchema.parse(raw);
    return { apiKey: PiModelsStore.resolveApiKey(input.name) };
  });

  ipcMain.handle(IPC.PI_MODELS_LIST_AVAILABLE, async () => {
    return { models: await listAvailablePiModels() };
  });
}
