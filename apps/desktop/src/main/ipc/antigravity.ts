/**
 * IPC handlers for the Antigravity (`agy acp`) Chat Provider:
 * model listing + CLI availability / version status probe.
 */
import type { IpcMain } from "electron";
import {
  IPC,
  RuntimesClaudeCliSchema,
  type AntigravityCliStatus,
} from "@contracts/ipc";
import {
  MIN_ANTIGRAVITY_CLI_VERSION,
  probeAntigravityCliVersion,
  resolveAntigravityExecutable,
} from "@main/lib/antigravityExecutable.js";
import { compareVersions } from "@main/lib/claudeExecutable.js";
import { listAntigravityModels } from "@main/providers/antigravity-acp/antigravityModels.js";

export function registerAntigravityHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.ANTIGRAVITY_LIST_MODELS, async (_evt, raw) => {
    const force = Boolean(raw && typeof raw === "object" && (raw as { force?: unknown }).force === true);
    return listAntigravityModels(force);
  });

  ipcMain.handle(IPC.ANTIGRAVITY_CLI_STATUS, async (_evt, raw): Promise<AntigravityCliStatus> => {
    const { force } = RuntimesClaudeCliSchema.parse(raw ?? {});
    const exePath = resolveAntigravityExecutable();
    if (!exePath) {
      return {
        installed: false,
        minVersion: MIN_ANTIGRAVITY_CLI_VERSION,
        usable: false,
        reason: "not-installed",
      };
    }
    const version = await probeAntigravityCliVersion(exePath, 8_000, force ?? false);
    const tooOld = Boolean(version && compareVersions(version, MIN_ANTIGRAVITY_CLI_VERSION) < 0);
    return {
      installed: true,
      path: exePath,
      ...(version ? { version } : {}),
      minVersion: MIN_ANTIGRAVITY_CLI_VERSION,
      usable: !tooOld,
      ...(tooOld ? { reason: "too-old" as const } : {}),
    };
  });
}
