/**
 * IPC handlers for the settings panel's "Agent Runtimes" section.
 *
 * Three download-on-demand runtimes (claude / codex / pi) — see
 * main/runtimes/runtimeInstaller.ts for the install pipeline. list() is a
 * snapshot (expected vs installed vs registry-latest); install() runs the
 * full download→verify→gate→extract pipeline and resolves when done,
 * streaming coarse progress over the `runtimes:event` push channel;
 * remove()/rollback() delete managed version dirs.
 *
 * install/remove/rollback are ALL rejected while ANY turn is running: the
 * runtime binary the turn is executing (or about to spawn) would vanish
 * mid-flight, and on Windows deleting a running executable's dir fails with
 * EPERM. The guard is intentionally conservative (any session, not
 * per-agent) — replacing a ~300MB runtime is rare enough that a "stop your
 * turns first" hint is cheaper than per-provider mapping. The check RPC is
 * read-only and always allowed.
 */
import type { IpcMain } from "electron";
import {
  IPC,
  RuntimesCheckSchema,
  RuntimesInstallLocalSchema,
  RuntimesInstallSchema,
  RuntimesRemoveSchema,
  RuntimesRollbackSchema,
} from "@contracts/ipc";
import { runtimeManager } from "@main/claude/RuntimeManager.js";
import {
  checkRuntimeUpdates,
  installRuntime,
  installRuntimeFromLocalPath,
  listRuntimes,
  removeRuntime,
  rollbackRuntime,
} from "@main/runtimes/runtimeInstaller.js";

function runningTurnGuard(): { ok: false; error: string } | null {
  const running = runtimeManager.runningSessionIds();
  if (running.length === 0) return null;
  return {
    ok: false,
    error: `${running.length} session(s) still have a running turn — stop them before touching a runtime`,
  };
}

export function registerRuntimesHandlers(ipcMain: IpcMain): void {
  // list takes no input (mirrors lsp.list) — nothing to parse.
  ipcMain.handle(IPC.RUNTIMES_LIST, async () => {
    return { runtimes: await listRuntimes() };
  });

  ipcMain.handle(IPC.RUNTIMES_INSTALL, async (_evt, raw) => {
    const input = RuntimesInstallSchema.parse(raw);
    const guard = runningTurnGuard();
    if (guard) return guard;
    return await installRuntime(input.agent, input.version, input.force ?? false);
  });

  ipcMain.handle(IPC.RUNTIMES_INSTALL_LOCAL, async (_evt, raw) => {
    const input = RuntimesInstallLocalSchema.parse(raw);
    const guard = runningTurnGuard();
    if (guard) return guard;
    return await installRuntimeFromLocalPath(input.agent, input.localPath);
  });

  ipcMain.handle(IPC.RUNTIMES_REMOVE, async (_evt, raw) => {
    const input = RuntimesRemoveSchema.parse(raw);
    const guard = runningTurnGuard();
    if (guard) return guard;
    return await removeRuntime(input.agent, input.version);
  });

  // Manual "check for updates" — user-clicked only, read-only, always allowed.
  ipcMain.handle(IPC.RUNTIMES_CHECK_UPDATES, async (_evt, raw) => {
    RuntimesCheckSchema.parse(raw);
    return { results: await checkRuntimeUpdates() };
  });

  ipcMain.handle(IPC.RUNTIMES_ROLLBACK, async (_evt, raw) => {
    const input = RuntimesRollbackSchema.parse(raw);
    const guard = runningTurnGuard();
    if (guard) return guard;
    return await rollbackRuntime(input.agent);
  });
}
