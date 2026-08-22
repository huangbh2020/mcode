/**
 * IPC handler for the settings panel's output-style section: one operation,
 * list (built-ins gated by the bundled CLI version + user styles scanned from
 * ~/.mcode/output-styles). The selection itself goes through the generic
 * setting.get/set channels under AGENT_OUTPUT_STYLE_SETTING_KEY and is
 * injected per-turn by ClaudeAgentSdkProvider — no mutation RPCs needed.
 */
import type { IpcMain } from "electron";
import { IPC, OutputStyleListSchema } from "@contracts/ipc";
import { listOutputStyles } from "@main/lib/outputStyleConfig.js";

export function registerOutputStyleHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.OUTPUT_STYLE_LIST, (_evt, raw) => {
    OutputStyleListSchema.parse(raw ?? {});
    return { styles: listOutputStyles() };
  });
}
