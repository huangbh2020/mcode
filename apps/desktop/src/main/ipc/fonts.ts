/**
 * IPC handlers for the UI font picker.
 * - listSystemFamilies : enumerate installed font family names (cached in
 *   main; {refresh:true} bypasses the cache after a font install).
 */
import type { IpcMain } from "electron";
import { IPC, FontsListSystemFamiliesSchema } from "@contracts/ipc";
import { listSystemFontFamilies } from "@main/lib/fontEnum.js";

export function registerFontHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.FONTS_LIST_SYSTEM_FAMILIES, (_evt, raw) => {
    const input = FontsListSystemFamiliesSchema.parse(raw);
    return listSystemFontFamilies(input.refresh === true).then((families) => ({
      families,
    }));
  });
}
