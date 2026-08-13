/**
 * Mobile companion IPC handlers (PC renderer → main).
 *
 * These drive the PC-side "connect phone" dialog: start/cancel a pairing,
 * list/revoke paired devices, and read server status. The actual LAN HTTP
 * server + pairing handshake lives in `main/mobile/*` — this module only
 * exposes it to the renderer over IPC (the same DB-guarded wrapper as every
 * other domain).
 */
import type { IpcMain } from "electron";
import { IPC, RevokeMobileDeviceSchema } from "@contracts/ipc";
import { pairingManager, detectLanIp, detectLanIps } from "@main/mobile/PairingManager.js";
import { getMobileServer } from "@main/mobile/MobileHttpServer.js";
import { log } from "@main/lib/logger.js";

export function registerMobileHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.MOBILE_START_PAIRING, async (_evt, raw) => {
    const server = getMobileServer();
    const input = (raw ?? {}) as { host?: string };
    const lanIp = input.host || detectLanIp();
    // If the server isn't running (disabled / port error), we still let the
    // user generate a QR but warn via the endpoint field — the phone won't be
    // able to connect until the server comes up.
    const endpoint = `http://${lanIp ?? "localhost"}:${server.port || 7331}`;
    const pairing = pairingManager.startPairing(endpoint);
    return { pairing };
  });

  ipcMain.handle(IPC.MOBILE_GET_PAIRING, async () => {
    return { pairing: pairingManager.getPending() };
  });

  ipcMain.handle(IPC.MOBILE_CANCEL_PAIRING, async () => {
    pairingManager.cancelPairing();
    return { ok: true as const };
  });

  ipcMain.handle(IPC.MOBILE_LIST_DEVICES, async () => {
    const devices = await pairingManager.listDevices();
    return { devices };
  });

  ipcMain.handle(IPC.MOBILE_REVOKE_DEVICE, async (_evt, raw) => {
    const input = RevokeMobileDeviceSchema.parse(raw);
    await pairingManager.revokeDevice(input.deviceId);
    return { ok: true as const };
  });

  ipcMain.handle(IPC.MOBILE_GET_STATUS, async () => {
    const server = getMobileServer();
    return {
      running: server.running,
      port: server.port,
      endpoint: server.endpoint,
      lanIp: detectLanIp(),
      lanIps: detectLanIps(),
    };
  });

  log.info("mobile: IPC handlers registered");
}
