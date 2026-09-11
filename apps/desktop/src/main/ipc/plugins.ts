/**
 * IPC handlers for the settings panel's "Plugins" section.
 *
 * list/install/enable/remove over the plugin cache (~/.mcode/plugins) plus
 * marketplace management — see main/plugins/pluginManager.ts for the layout
 * and the install pipeline. Installs land DISABLED: the renderer pops the
 * component-review dialog on success and calls setEnabled when the user
 * approves (the review-before-activation gate lives in the UI).
 *
 * remove() is rejected while ANY turn is running: a live turn may hold the
 * plugin's paths (Claude options.plugins / skill roots) and deleting the
 * tree under it would corrupt that turn — same conservative global gate as
 * runtimes.remove.
 */
import type { IpcMain } from "electron";
import {
  IPC,
  PluginsInstallLocalSchema,
  PluginsInstallGitSchema,
  PluginsInstallMarketplaceSchema,
  PluginsSetEnabledSchema,
  PluginsRemoveSchema,
  PluginsMarketplaceAddSchema,
  PluginsMarketplaceRemoveSchema,
  PluginsMarketplaceRefreshSchema,
} from "@contracts/ipc";
import { runtimeManager } from "@main/claude/RuntimeManager.js";
import {
  listPlugins,
  installFromLocal,
  installFromGit,
  installFromMarketplace,
  setPluginEnabled,
  removePlugin,
  listMarketplaces,
  addMarketplace,
  removeMarketplace,
  refreshMarketplace,
} from "@main/plugins/pluginManager.js";

export function registerPluginsHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.PLUGINS_LIST, async () => {
    return { plugins: listPlugins() };
  });

  ipcMain.handle(IPC.PLUGINS_INSTALL_LOCAL, async (_evt, raw) => {
    const input = PluginsInstallLocalSchema.parse(raw);
    return await installFromLocal(input.localPath);
  });

  ipcMain.handle(IPC.PLUGINS_INSTALL_GIT, async (_evt, raw) => {
    const input = PluginsInstallGitSchema.parse(raw);
    return await installFromGit(input.url, input.ref);
  });

  ipcMain.handle(IPC.PLUGINS_INSTALL_MARKETPLACE, async (_evt, raw) => {
    const input = PluginsInstallMarketplaceSchema.parse(raw);
    return await installFromMarketplace(input.marketplace, input.name);
  });

  ipcMain.handle(IPC.PLUGINS_SET_ENABLED, async (_evt, raw) => {
    const input = PluginsSetEnabledSchema.parse(raw);
    return setPluginEnabled(input.name, input.enabled);
  });

  ipcMain.handle(IPC.PLUGINS_REMOVE, async (_evt, raw) => {
    const input = PluginsRemoveSchema.parse(raw);
    const running = runtimeManager.runningSessionIds();
    if (running.length > 0) {
      return {
        ok: false,
        error: `${running.length} 个会话仍在运行回合——请先停止再卸载插件`,
      };
    }
    return removePlugin(input.name);
  });

  ipcMain.handle(IPC.PLUGINS_MARKETPLACE_LIST, async () => {
    return { marketplaces: listMarketplaces() };
  });

  ipcMain.handle(IPC.PLUGINS_MARKETPLACE_ADD, async (_evt, raw) => {
    const input = PluginsMarketplaceAddSchema.parse(raw);
    return await addMarketplace({ kind: input.kind, ref: input.ref, name: input.name });
  });

  ipcMain.handle(IPC.PLUGINS_MARKETPLACE_REMOVE, async (_evt, raw) => {
    const input = PluginsMarketplaceRemoveSchema.parse(raw);
    return removeMarketplace(input.name);
  });

  ipcMain.handle(IPC.PLUGINS_MARKETPLACE_REFRESH, async (_evt, raw) => {
    const input = PluginsMarketplaceRefreshSchema.parse(raw);
    return await refreshMarketplace(input.name);
  });
}
