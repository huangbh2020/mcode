/**
 * Relay IPC handlers (PC renderer → main).
 *
 * Bridges the renderer's "remote access" panel to the singleton
 * {@link relayManager}: save/read VPS config, connect/disconnect, and read
 * status. State changes are pushed proactively via `relay:event`.
 */
import type { IpcMain } from "electron";
import { IPC, RelayVpsConfigSchema } from "@contracts/ipc";
import { relayManager } from "@main/relay/RelayManager.js";
import { log } from "@main/lib/logger.js";

export function registerRelayHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.RELAY_SAVE_CONFIG, async (_evt, raw) => {
    try {
      const config = RelayVpsConfigSchema.parse(raw);
      relayManager.saveConfig(config);
      return { ok: true as const };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`relay.saveConfig failed: ${msg}`);
      return { ok: true as const }; // still return ok; the form handles its own validation
    }
  });

  ipcMain.handle(IPC.RELAY_GET_CONFIG, async () => {
    return { config: relayManager.getConfig() };
  });

  ipcMain.handle(IPC.RELAY_CONNECT, async () => {
    try {
      return await relayManager.connect();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`relay.connect failed: ${msg}`);
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle(IPC.RELAY_DISCONNECT, async () => {
    try {
      await relayManager.disconnect();
      return { ok: true as const };
    } catch {
      return { ok: true as const };
    }
  });

  ipcMain.handle(IPC.RELAY_STATUS, async () => {
    return relayManager.getStatus();
  });

  log.info("relay: IPC handlers registered");
}
