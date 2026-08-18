import { BrowserWindow, shell } from "electron";
import { join } from "node:path";
import { is } from "@main/utils.js";
import { getEffectiveTheme } from "@main/lib/theme.js";
import { log } from "@main/lib/logger.js";
import { logStartup } from "@main/lib/startupTimer.js";
import { IPC } from "@contracts/ipc";

let mainWindow: BrowserWindow | null = null;

/** Background color matching the effective theme, so the first frame (before
 *  React mounts) doesn't flash the wrong color. Mirrors --surface in CSS
 *  (styles.css): light = #ffffff, dark = #1a1d24. */
function bgColor(): string {
  return getEffectiveTheme() === "dark" ? "#1a1d24" : "#ffffff";
}

/** Title-bar overlay colour scheme that matches the app theme. The overlay sits
 *  behind the native min/max/close buttons when `titleBarStyle: 'hidden'` is
 *  active, so it must visually blend with the custom titlebar in the renderer.
 *
 *  `color` mirrors --surface-muted (the toolbar's background — it matches the
 *  full-height sidebar so they read as one frame); `symbolColor` mirrors
 *  --content-subtle so the button glyphs match the dim UI text tone. Values
 *  must stay in sync with styles.css (.dark block).
 *
 *  `height` must match the renderer titlebar's height (h-10 = 40px): Electron
 *  draws the overlay aligned to the top of the window, and the buttons are
 *  centered within `height`. If this is smaller than the bar (e.g. 32), the
 *  buttons sit too high instead of being vertically centered. */
function overlayColors() {
  const dark = getEffectiveTheme() === "dark";
  return {
    color: dark ? "#2c313c" : "#f4f4f5",
    symbolColor: dark ? "#848891" : "#71717a",
    height: 40,
  };
}

/** Update the title-bar overlay colors (called when the theme switches).
 *
 *  `setTitleBarOverlay` only exists on Windows and Linux, where
 *  `titleBarOverlay` paints the area behind the native min/max/close buttons.
 *  macOS uses the traffic-light buttons (see `trafficLightPosition`) and has no
 *  overlay, so the call is a no-op there - without this guard it throws
 *  "setTitleBarOverlay is not a function" on macOS. */
export function updateTitleBarOverlay(): void {
  if (process.platform === "darwin") return;
  mainWindow?.setTitleBarOverlay(overlayColors());
}

/** Create the primary three-pane window. */
export function createMainWindow(): BrowserWindow {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    title: "Mcode",
    // Window/taskbar icon. In dev the build/ tree sits two levels up from
    // out/main; in packaged builds electron-builder injects the icon from
    // build/icon.ico/.icns into the executable itself, so this is mainly for
    // the dev experience (otherwise the default Electron icon shows up).
    icon: join(__dirname, "../../build/icon.png"),
    backgroundColor: bgColor(),
    // Hidden title-bar + overlay lets us render custom content (the toggle
    // button plus a draggable handle) in the title-bar row alongside the
    // native window-control buttons (min / max / close).  The overlay colours
    // are set once here and kept in sync by updateTitleBarOverlay().
    titleBarStyle: "hidden",
    titleBarOverlay: overlayColors(),
    // macOS only: pin the traffic-light buttons (close/min/zoom) so they sit
    // vertically centered in our 40px (h-10) custom titlebar. Without this,
    // macOS uses its default Y (~14px from the top), which is tuned for the
    // standard ~28px titlebar and leaves the buttons sitting too high in our
    // taller bar. The 12px-diameter circles are vertically centered when the
    // group origin is at y = (40 - 14) / 2 ≈ 13. Ignored on Windows/Linux.
    trafficLightPosition: { x: 20, y: 13 },
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.on("ready-to-show", () => {
    logStartup("ready-to-show");
    mainWindow?.show();
  });

  // Forward window focus/blur to the renderer so it can make notification
  // decisions (OS notification vs in-app toast vs silent badge). The renderer
  // also tracks document.visibilityState for tab-hide, but the Electron-level
  // focus event is the authoritative "is our app frontmost?" signal.
  // `blur`/`focus` fire on app switch, dock click, minimize, and restore.
  const pushFocus = (focused: boolean) => sendToRenderer(IPC.WINDOW_FOCUS_CHANGED, { focused });
  mainWindow.on("focus", () => pushFocus(true));
  mainWindow.on("blur", () => pushFocus(false));
  // On macOS, minimize doesn't trigger blur reliably in all versions, so also
  // hook the minimize/restore pair for a deterministic signal.
  mainWindow.on("minimize", () => pushFocus(false));
  mainWindow.on("restore", () => pushFocus(true));
  // Null out the reference once the window is gone so the optional chains in
  // sendToRenderer / updateTitleBarOverlay / getMainWindow short-circuit
  // instead of operating on a destroyed BrowserWindow. Without this, async
  // callbacks (node-pty onExit/onData, approval bridges) that fire during quit
  // would dereference a stale, already-destroyed window.
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Forward renderer console messages to stderr so we can debug blank screens
  // without watching DevTools, AND persist them to main.log so they survive
  // even when launched from the Start Menu (no stderr sink). The renderer's
  // own errors never go through the main-process `log`, so without this a
  // blank-screen bug leaves no trace on disk after the app quits.
  mainWindow.webContents.on("console-message", (_e, level, message, line, sourceId) => {
    const tag = ["LOG", "WARN", "ERROR"][level] ?? "LOG";
    const line2 = `[renderer:${tag}] ${message} (${sourceId}:${line})`;
    process.stderr.write(`${line2}\n`);
    if (tag === "ERROR") log.error(line2);
    else if (tag === "WARN") log.warn(line2);
  });
  mainWindow.webContents.on("render-process-gone", (_e, details) => {
    const line = `[renderer:GONE] ${JSON.stringify(details)}`;
    process.stderr.write(`${line}\n`);
    log.error(line);
  });
  mainWindow.webContents.on("did-fail-load", (_e, code, desc, url) => {
    const line = `[renderer:FAIL_LOAD] ${code} ${desc} ${url}`;
    process.stderr.write(`${line}\n`);
    log.error(line);
  });

  // Open external links in the system browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // Load the renderer.
  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
    // DevTools is intentionally NOT auto-opened. The detached DevTools
    // front-end emits harmless-but-noisy Chromium console errors on every
    // startup (e.g. "Autofill.enable wasn't found", "Unknown VE context:
    // language-mismatch") because Electron's bundled Chromium doesn't
    // implement every CDP domain the DevTools UI probes. Those errors come
    // from Chromium's own logging, not the console-message listener above,
    // so they can't be filtered in app code. Renderer errors are already
    // surfaced via the listener above -> [renderer:ERROR] on stderr, so a
    // blank screen is debuggable without DevTools. Press Ctrl+Shift+I
    // (Cmd+Option+I on macOS) to open DevTools manually when needed.
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

  // Safety net: if ready-to-show never fires within 3s (e.g. the renderer's
  // first paint is stuck because a script was blocked by CSP, or a native
  // module failed to load and stalled page load), force the window visible.
  // The whole "app runs in the background but shows no UI" class of bugs on
  // packaged Windows builds comes from show:false + a ready-to-show that
  // never arrives — this guarantee ensures the user at least sees the window
  // (and, if it's blank, can open DevTools to find out why) instead of a
  // phantom background process. Once the real ready-to-show fires it simply
  // calls show() again, which is a no-op on an already-visible window.
  const showFallback = setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      log.warn("ready-to-show timed out after 3s — forcing window visible");
      mainWindow.show();
    }
  }, 3000);
  mainWindow.once("closed", () => clearTimeout(showFallback));

  return mainWindow;
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

/** Send a push event to the renderer (main -> renderer).
 *
 *  Defensive against a closed/destroyed window: node-pty's onExit/onData and
 *  the approval bridges fire asynchronously, so they can run after the window
 *  has torn down during quit. Calling webContents.send() on a destroyed window
 *  throws "Object has been destroyed" (an uncaught main-process exception).
 *  Drop silently in that case - the renderer is gone and nobody can receive
 *  the message anyway. */
export function sendToRenderer(channel: string, ...args: unknown[]): void {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  const wc = win.webContents;
  if (wc.isDestroyed()) return;
  wc.send(channel, ...args);
}
