import { app, BrowserWindow, session } from "electron";
import { createMainWindow } from "@main/window.js";
import { registerIpcHandlers } from "@main/ipc/index.js";
import { initDb, closeDb, awaitDb } from "@main/store/db.js";
import { initTheme } from "@main/lib/theme.js";
import { TerminalManager } from "@main/terminal/TerminalManager.js";
import { BridgeRegistry } from "@main/providers/bridge/bridgeRegistry.js";
import { lspManager } from "@main/lsp/LspManager.js";
import { BrowserManager } from "@main/browser/BrowserManager.js";
import { startMobileServer, stopMobileServer } from "@main/mobile/MobileHttpServer.js";
import { relayManager } from "@main/relay/RelayManager.js";
import { RELAY_AUTO_START_SETTING_KEY } from "@contracts/relay";
import { SettingRepo } from "@main/store/repositories.js";
import { initUpdater } from "@main/updater.js";
import { initAutoArchiver } from "@main/session/AutoArchiver.js";
import { notificationManager } from "@main/notifications/NotificationManager.js";
import { is } from "@main/utils.js";
import { logStartup } from "@main/lib/startupTimer.js";
import { log } from "@main/lib/logger.js";

// App identity for OS-level surfaces (desktop notifications, taskbar grouping,
// Windows AUMID). setName("Mcode") makes the system notification card title
// read "Mcode" instead of the raw executable name ("electron" in dev, or
// "@mcode/desktop" from package.json).
//
// ⚠️ setName() ALSO changes the default userData path (%APPDATA%/<name>),
// which would orphan the existing database + logs (they live under the
// pre-rename directory). To avoid a silent data wipe, snapshot the current
// userData path BEFORE renaming, then pin it back with setPath() right after.
// Unconditional setPath is safe: when the name already matched (packaged
// builds where exe metadata is "Mcode"), prevUserData == current path and this
// just rewrites the same value (a no-op).
const prevUserData = app.getPath("userData");
app.setName("Mcode");
app.setPath("userData", prevUserData);
// Windows: AppUserModelId drives taskbar grouping + the AUMID the toast center
// uses to attribute notifications. Harmless on macOS/Linux (ignored).
if (process.platform === "win32") {
  app.setAppUserModelId("Mcode");
}

// Global exception handlers — install BEFORE anything else. Without these, an
// uncaughtException (e.g. from `new BrowserWindow`, or a require() of a native
// module that fails to load) or an unhandledRejection (from the fire-and-forget
// `void initDb()` / `void initTheme()` / `void initUpdater()` below) crashes
// the main process silently. In a packaged build that looks exactly like "the
// app starts in the background but no window ever appears": the window is
// created with show:false and the ready-to-show -> show() path never completes
// because the process is already dying. These handlers log the cause to
// main.log so the failure is diagnosable instead of invisible.
// 重入保护:若 log.error 自身抛出(如 stderr 管道断裂 EPIPE),重入这些 handler
// 会递归到栈溢出(0xC0000409 STATUS_STACK_BUFFER_OVERRUN)。两个 handler 共用同一
// flag,因为两者都调 log.error。
let handlingGlobalError = false;
process.on("uncaughtException", (err) => {
  if (handlingGlobalError) return;
  handlingGlobalError = true;
  try {
    log.error(`uncaughtException: ${err.stack ?? err}`);
  } finally {
    handlingGlobalError = false;
  }
});
process.on("unhandledRejection", (reason) => {
  if (handlingGlobalError) return;
  handlingGlobalError = true;
  try {
    log.error(`unhandledRejection: ${reason instanceof Error ? reason.stack ?? reason : String(reason)}`);
  } finally {
    handlingGlobalError = false;
  }
});

// Single-instance lock - only one GUI instance runs at a time.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

app.on("second-instance", () => {
  // Someone tried to run a second instance — surface our existing window.
  const wins = BrowserWindow.getAllWindows();
  if (wins.length > 0) {
    const [win] = wins;
    if (win.isMinimized()) win.restore();
    // show() is essential here: the main window is created with show:false
    // and only revealed on ready-to-show. If the first launch's renderer is
    // still loading (or stalled), the window may still be hidden, and bare
    // focus() does NOT make a hidden window visible — so the user would see
    // "clicking the shortcut does nothing" even though the process is alive.
    win.show();
    win.focus();
  }
});

app.whenReady().then(async () => {
  logStartup("whenReady entered");

  // Kick off DB init in the background (sql.js loads ~6MB asm.js + reads the
  // file + migrates). We DON'T await it - the window is created next so the
  // renderer starts loading immediately. IPC handlers await `awaitDb()`
  // internally (see ipc/index.ts), so any request that arrives before the DB
  // is ready simply queues instead of failing.
  void initDb();

  // CSP only in production - in dev, Vite injects inline HMR scripts that a
  // strict CSP would block, leaving the page blank.
  if (is.prod) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
            "Content-Security-Policy": [
            "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:",
          ],
        },
      });
    });
  }

  // Apply the persisted theme preference. Fire-and-forget: initTheme() awaits
  // DB readiness internally, so the first frame uses the OS-default theme and
  // is corrected to the saved preference once the DB is ready. Only a user
  // preference that differs from the OS causes a brief first-frame flash.
  void initTheme();

  // Register IPC handlers (each awaits DB readiness before running).
  registerIpcHandlers();
  logStartup("IPC handlers registered");

  // HTTP Basic Auth for the embedded browser: BrowserManager auto-fills a
  // saved credential for the origin, or pushes an "authRequest" event so the
  // renderer shows a login dialog (answered via the browser.authRespond RPC).
  // Requests not from a browser view are ignored (default cancel behavior).
  app.on("login", (event, webContents, _details, authInfo, callback) => {
    event.preventDefault();
    BrowserManager.handleLogin(
      webContents.id,
      webContents.getURL(),
      authInfo,
      callback,
    );
  });

  // Create the window immediately - don't wait for DB init to finish. The
  // renderer starts loading its JS/HMR while sql.js parses in parallel.
  createMainWindow();
  logStartup("createMainWindow returned");

  // Start the auto-updater (no-op in dev; only active in packaged builds).
  // Fire-and-forget: the first check is delayed 10s anyway, and the updater
  // module is lazy-loaded, so this never blocks window creation.
  void initUpdater();

  // Start the session auto-archiver. Fire-and-forget: the first pass is
  // delayed 60s and awaits DB readiness internally, so this never blocks
  // window creation.
  initAutoArchiver();

  // Start the notification system. Fire-and-forget: it awaits DB readiness
  // internally (to load prefs), then attaches its event observer to the
  // RuntimeManager. Until the observer attaches, events are simply not
  // observed (no notification) - safe to race with window creation.
  void (async () => {
    try {
      await awaitDb();
      notificationManager.start();
    } catch (err) {
      log.error(`NotificationManager failed to start: ${(err as Error).message}`);
    }
  })();

  // Start the mobile companion HTTP server (LAN-facing). Fire-and-forget: it
  // awaits DB readiness internally to read its enabled/port settings, then
  // binds 0.0.0.0:<port>. If disabled (mobile.enabled=0) it resolves to an
  // idle handle — safe no-op. Failure to bind (port in use) is logged but
  // never blocks the app. When "start remote access on launch" is enabled and
  // a VPS config exists, auto-connect the relay tunnel right after the mobile
  // server is up (the relay forwards into it).
  void (async () => {
    try {
      await startMobileServer();
      await maybeAutoStartRelay();
    } catch (err) {
      log.error(`mobile server failed to start: ${(err as Error).message}`);
    }
  })();

  app.on("activate", () => {
    // macOS: re-create a window when the dock icon is clicked.
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

// Quit when all windows are closed, except on macOS.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

/** If "start remote access on launch" is enabled and a VPS config exists,
 *  auto-connect the relay tunnel. Best-effort — failures are logged, never
 *  thrown (startup must not be blocked). */
async function maybeAutoStartRelay(): Promise<void> {
  try {
    const raw = SettingRepo.get(RELAY_AUTO_START_SETTING_KEY);
    if (raw !== "1") return;
    if (!relayManager.getConfig()) return;
    log.info("relay: auto-start enabled, connecting…");
    const result = await relayManager.connect();
    if (!result.ok && result.error) {
      log.warn(`relay: auto-start connect failed: ${result.error}`);
    }
  } catch (err) {
    log.warn(`relay: auto-start failed: ${(err as Error).message}`);
  }
}

// Close PTYs + bridge servers + LSP servers + browser views + DB cleanly on shutdown (best-effort).
app.on("before-quit", () => {
  BridgeRegistry.disposeAll();
  TerminalManager.disposeAll();
  lspManager.disposeAll();
  BrowserManager.disposeAll();
  relayManager.disposeAll();
  stopMobileServer();
  closeDb();
});
