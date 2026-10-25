/** Electron stub (alias target) — the smoke only really uses `app.getPath`
 *  (the screenshot-save fallback dir). The remaining names exist so bundling
 *  succeeds wherever an electron-adjacent module got pulled in transitively;
 *  those code paths never execute in this smoke. */
export const app = { getPath: () => "/tmp/pictures" };
export const shell = { openExternal: () => undefined, showItemInFolder: () => undefined, openPath: () => "" };
export const nativeTheme = { shouldUseDarkColors: false, on: () => undefined, off: () => undefined };
export const session = { fromPartition: () => ({}), fromPath: () => ({}) };
export const BrowserWindow = class {
  static fromWebContents() {
    return null;
  }
  getAllWindows() {
    return [];
  }
};
export const ipcMain = { handle: () => undefined, on: () => undefined, removeHandler: () => undefined };
