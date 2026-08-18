/**
 * IPC handlers for the settings panel's usage-stats section.
 *
 * Single read-only RPC: aggregate the persisted per-turn usage history
 * (sessions.usage_history) into summary / per-model / per-day views.
 * Provider accounting normalization (Pi cumulative diffs) lives in
 * lib/usageStats.ts.
 */
import type { IpcMain } from "electron";
import { IPC, UsageStatsSchema } from "@contracts/ipc";
import { buildUsageStats } from "@main/lib/usageStats.js";

export function registerUsageHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.USAGE_STATS, (_evt, raw) => {
    const input = UsageStatsSchema.parse(raw);
    return buildUsageStats(input.preset);
  });
}
