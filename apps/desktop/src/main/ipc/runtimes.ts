/**
 * IPC handlers for the settings panel's "Agent Runtimes" section.
 *
 * Three download-on-demand runtimes (claude / codex / pi) — see
 * main/runtimes/runtimeInstaller.ts for the install pipeline. list() is a
 * snapshot (expected vs installed vs registry-latest); install() runs the
 * full download→verify→extract pipeline and resolves when done, streaming
 * coarse progress over the `runtimes:event` push channel; remove() deletes
 * the installed copy.
 *
 * remove() is rejected while ANY turn is running: the runtime binary the
 * turn is executing (or about to spawn) would vanish mid-flight. The guard
 * is intentionally conservative (any session, not per-agent) — removing a
 * ~300MB runtime is rare enough that a "stop your turns first" hint is
 * cheaper than per-provider mapping.
 */
import type { IpcMain } from "electron";
import {
  IPC,
  RuntimesInstallSchema,
  RuntimesInstallLocalSchema,
  RuntimesRemoveSchema,
} from "@contracts/ipc";
import { runtimeManager } from "@main/claude/RuntimeManager.js";
import {
  listRuntimes,
  installRuntime,
  installRuntimeFromLocalPath,
  removeRuntime,
} from "@main/runtimes/runtimeInstaller.js";

export function registerRuntimesHandlers(ipcMain: IpcMain): void {
  // list takes no input (mirrors lsp.list) — nothing to parse.
  ipcMain.handle(IPC.RUNTIMES_LIST, async () => {
    return { runtimes: await listRuntimes() };
  });

  ipcMain.handle(IPC.RUNTIMES_INSTALL, async (_evt, raw) => {
    const input = RuntimesInstallSchema.parse(raw);
    return await installRuntime(input.agent);
  });

  ipcMain.handle(IPC.RUNTIMES_INSTALL_LOCAL, async (_evt, raw) => {
    const input = RuntimesInstallLocalSchema.parse(raw);
    return await installRuntimeFromLocalPath(input.agent, input.localPath);
  });

  ipcMain.handle(IPC.RUNTIMES_REMOVE, async (_evt, raw) => {
    const input = RuntimesRemoveSchema.parse(raw);
    const running = runtimeManager.runningSessionIds();
    if (running.length > 0) {
      return {
        ok: false,
        error: `${running.length} session(s) still have a running turn — stop them before removing a runtime`,
      };
    }
    return await removeRuntime(input.agent);
  });
}
