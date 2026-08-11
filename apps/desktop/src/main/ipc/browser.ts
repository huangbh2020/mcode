/**
 * IPC handlers for the embedded browser panel (create / navigate / bounds /
 * pick mode / show / hide / close).
 *
 * Mirrors the terminal handler pattern: zod-validate the input, delegate to
 * BrowserManager, return `{ ok, error? }` (never throw into the renderer).
 * `projectPath` on create is scoped to a known project root for consistency
 * with the other IDE resource handlers, even though browsing itself is open.
 *
 * The picker is injected by `browser.setPickMode` via executeJavaScript; picked
 * elements arrive as a `browser:event` / `pickResult` push (handled inside
 * BrowserManager), not via a return value here.
 */
import type { IpcMain } from "electron";
import { resolve } from "node:path";
import {
  IPC,
  BrowserCreateSchema,
  BrowserLoadUrlSchema,
  BrowserGoBackSchema,
  BrowserGoForwardSchema,
  BrowserReloadSchema,
  BrowserSetBoundsSchema,
  BrowserSetPickModeSchema,
  BrowserShowSchema,
  BrowserHideSchema,
  BrowserCloseSchema,
  BrowserSetDeviceSchema,
} from "@contracts/ipc";
import { isKnownProjectPath } from "@main/lib/pathGuard.js";
import { BrowserManager } from "@main/browser/BrowserManager.js";
import { log } from "@main/lib/logger.js";

export function registerBrowserHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.BROWSER_CREATE, async (_evt, raw) => {
    try {
      const input = BrowserCreateSchema.parse(raw);
      const projectPath = resolve(input.projectPath);
      if (!isKnownProjectPath(projectPath)) {
        return { ok: false as const, error: "未知项目路径，拒绝创建浏览器" };
      }
      return BrowserManager.create(projectPath, input.initialDevice);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`browser.create failed: ${msg}`);
      return { ok: false as const, error: msg };
    }
  });

  ipcMain.handle(IPC.BROWSER_LOAD_URL, async (_evt, raw) => {
    try {
      const input = BrowserLoadUrlSchema.parse(raw);
      return BrowserManager.loadUrl(input.browserId, input.url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false as const, error: msg };
    }
  });

  ipcMain.handle(IPC.BROWSER_GO_BACK, async (_evt, raw) => {
    try {
      const input = BrowserGoBackSchema.parse(raw);
      return BrowserManager.goBack(input.browserId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false as const, error: msg };
    }
  });

  ipcMain.handle(IPC.BROWSER_GO_FORWARD, async (_evt, raw) => {
    try {
      const input = BrowserGoForwardSchema.parse(raw);
      return BrowserManager.goForward(input.browserId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false as const, error: msg };
    }
  });

  ipcMain.handle(IPC.BROWSER_RELOAD, async (_evt, raw) => {
    try {
      const input = BrowserReloadSchema.parse(raw);
      return BrowserManager.reload(input.browserId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false as const, error: msg };
    }
  });

  ipcMain.handle(IPC.BROWSER_SET_BOUNDS, async (_evt, raw) => {
    try {
      const input = BrowserSetBoundsSchema.parse(raw);
      return BrowserManager.setBounds(input.browserId, {
        x: input.x,
        y: input.y,
        width: input.width,
        height: input.height,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false as const, error: msg };
    }
  });

  // setPickMode is async because executeJavaScript returns a promise.
  ipcMain.handle(IPC.BROWSER_SET_PICK_MODE, async (_evt, raw) => {
    try {
      const input = BrowserSetPickModeSchema.parse(raw);
      return await BrowserManager.setPickMode(input.browserId, input.enabled);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false as const, error: msg };
    }
  });

  ipcMain.handle(IPC.BROWSER_SHOW, async (_evt, raw) => {
    try {
      const input = BrowserShowSchema.parse(raw);
      return BrowserManager.show(input.browserId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false as const, error: msg };
    }
  });

  ipcMain.handle(IPC.BROWSER_HIDE, async (_evt, raw) => {
    try {
      const input = BrowserHideSchema.parse(raw);
      return BrowserManager.hide(input.browserId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false as const, error: msg };
    }
  });

  ipcMain.handle(IPC.BROWSER_CLOSE, async (_evt, raw) => {
    try {
      const input = BrowserCloseSchema.parse(raw);
      return BrowserManager.close(input.browserId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false as const, error: msg };
    }
  });

  ipcMain.handle(IPC.BROWSER_SET_DEVICE, async (_evt, raw) => {
    try {
      const input = BrowserSetDeviceSchema.parse(raw);
      return BrowserManager.setDevice(input.browserId, input.device, {
        width: input.width,
        height: input.height,
        orientation: input.orientation,
        viewportWidth: input.viewportWidth,
        viewportHeight: input.viewportHeight,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false as const, error: msg };
    }
  });

  // Global to the browser session (no per-view input): clears HTTP cache +
  // temporary site storage while keeping cookies/login state.
  ipcMain.handle(IPC.BROWSER_CLEAR_CACHE, async () => {
    try {
      return await BrowserManager.clearBrowserCache();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false as const, error: msg };
    }
  });
}
