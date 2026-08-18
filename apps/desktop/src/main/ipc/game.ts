/**
 * Mini-game (liars dice) IPC handlers. Main is the authoritative state owner;
 * each handler delegates to {@link gameService} and returns the resulting state
 * (or an error). The renderer mirrors the returned state.
 *
 * Mirrors the mcp.ts handler recipe: `ipcMain.handle(IPC.X, (_evt, raw) => {
 * const input = Schema.parse(raw); ... })`, degrading to `{ ok: false, error }`
 * rather than throwing into the renderer.
 */
import type { IpcMain } from "electron";
import { IPC, GameUserBidSchema } from "@contracts/ipc";
import { gameService } from "@main/game/GameService.js";
import type { GameRpcResult } from "@contracts/ipc";

export function registerGameHandlers(ipcMain: IpcMain): void {
  // Start a fresh game.
  ipcMain.handle(IPC.GAME_NEW_GAME, async () => {
    const state = gameService.newGame();
    return { ok: true, state } satisfies GameRpcResult;
  });

  // Read the current state (rehydrate on overlay reopen).
  ipcMain.handle(IPC.GAME_GET_STATE, async () => {
    const state = gameService.getState();
    return { ok: true, state } satisfies GameRpcResult;
  });

  // The user places a bid; main runs the model to completion before returning.
  ipcMain.handle(IPC.GAME_USER_BID, async (_evt, raw) => {
    const input = GameUserBidSchema.parse(raw);
    const res = await gameService.userBid(input.count, input.face);
    return res satisfies GameRpcResult;
  });

  // The user challenges the model's last bid.
  ipcMain.handle(IPC.GAME_USER_CHALLENGE, async () => {
    const res = await gameService.userChallenge();
    return res satisfies GameRpcResult;
  });

  // After a roundOver reveal, start the next round.
  ipcMain.handle(IPC.GAME_CONTINUE, async () => {
    const res = await gameService.continueGame();
    return res satisfies GameRpcResult;
  });

  // The user resigns - the model wins.
  ipcMain.handle(IPC.GAME_RESIGN, async () => {
    const state = gameService.resign();
    return { ok: true, state } satisfies GameRpcResult;
  });
}
