/**
 * IPC handlers for the Antigravity (`agy acp`) Chat Provider:
 * model listing + CLI availability / version status probe.
 */
import type { IpcMain } from "electron";
import { z } from "zod";
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
import {
  invalidateAntigravityModelsCache,
  listAntigravityModels,
} from "@main/providers/antigravity-acp/antigravityModels.js";
import {
  getAntigravityUsage,
  invalidateAntigravityUsageCache,
} from "@main/providers/antigravity-acp/antigravityUsage.js";
import {
  captureGoogleAntigravityAccount,
  deleteAntigravityAccount,
  listAntigravityAccounts,
  saveAntigravityAccount,
  selectAntigravityAccount,
} from "@main/providers/antigravity-acp/antigravityAccounts.js";

const SelectAccountSchema = z.object({ accountId: z.string().min(1) });
const DeleteAccountSchema = z.object({ accountId: z.string().min(1) });
const CaptureGoogleSchema = z.object({ name: z.string().min(1) });
const SaveAccountSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  method: z.enum(["gemini-api-key", "agent-platform"]),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  gcpProject: z.string().optional(),
  gcpLocation: z.string().optional(),
});

export function registerAntigravityHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.ANTIGRAVITY_LIST_MODELS, async (_evt, raw) => {
    const force = Boolean(raw && typeof raw === "object" && (raw as { force?: unknown }).force === true);
    return listAntigravityModels(force);
  });

  ipcMain.handle(IPC.ANTIGRAVITY_USAGE, async (_evt, raw) => {
    const force = Boolean(raw && typeof raw === "object" && (raw as { force?: unknown }).force === true);
    return getAntigravityUsage(force);
  });

  ipcMain.handle(IPC.ANTIGRAVITY_LIST_ACCOUNTS, () => listAntigravityAccounts());

  ipcMain.handle(IPC.ANTIGRAVITY_SELECT_ACCOUNT, async (_evt, raw) => {
    const { accountId } = SelectAccountSchema.parse(raw);
    const res = await selectAntigravityAccount(accountId);
    if (res.ok) {
      invalidateAntigravityModelsCache();
      invalidateAntigravityUsageCache();
    }
    return res;
  });

  ipcMain.handle(IPC.ANTIGRAVITY_SAVE_ACCOUNT, (_evt, raw) => {
    const parsed = SaveAccountSchema.parse(raw);
    const res = saveAntigravityAccount(parsed);
    if (res.ok) {
      invalidateAntigravityModelsCache();
      invalidateAntigravityUsageCache();
    }
    return res;
  });

  ipcMain.handle(IPC.ANTIGRAVITY_CAPTURE_GOOGLE_ACCOUNT, async (_evt, raw) => {
    const { name } = CaptureGoogleSchema.parse(raw);
    return captureGoogleAntigravityAccount(name);
  });

  ipcMain.handle(IPC.ANTIGRAVITY_DELETE_ACCOUNT, async (_evt, raw) => {
    const { accountId } = DeleteAccountSchema.parse(raw);
    const res = await deleteAntigravityAccount(accountId);
    if (res.ok) {
      invalidateAntigravityModelsCache();
      invalidateAntigravityUsageCache();
    }
    return res;
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
