import { app, BrowserWindow, dialog, shell, session, type WebContents } from "electron";
import { join } from "node:path";
import { freemem, totalmem } from "node:os";
import { is } from "@main/utils.js";
import { getEffectiveTheme, getThemeStylePreference } from "@main/lib/theme.js";
import { log } from "@main/lib/logger.js";
import { logStartup } from "@main/lib/startupTimer.js";
import { IPC } from "@contracts/ipc";

let mainWindow: BrowserWindow | null = null;

/** Background color matching the effective theme, so the first frame (before
 *  React mounts) doesn't flash the wrong color. Mirrors --surface in CSS
 *  (styles.css): light = #ffffff (sketch paper #fcfaf3), dark = #1a1d24
 *  (sketch kraft #3b3126) — the pre-DB fallback below is an imperceptible
 *  delta. */
function bgColor(): string {
  const sketch = getThemeStylePreference() === "sketch";
  if (getEffectiveTheme() === "dark") return sketch ? "#3b3126" : "#1a1d24";
  return sketch ? "#fcfaf3" : "#ffffff";
}

/** Title-bar overlay colour scheme that matches the app theme. The overlay sits
 *  behind the native min/max/close buttons when `titleBarStyle: 'hidden'` is
 *  active, so it must visually blend with the custom titlebar in the renderer.
 *
 *  `color` mirrors --surface-muted (the toolbar's background — it matches the
 *  full-height sidebar so they read as one frame); `symbolColor` mirrors
 *  --content-subtle so the button glyphs match the dim UI text tone. Values
 *  must stay in sync with styles.css (.dark block + the sketch section's
 *  paper palette: #f6f2e7 / #8d8371, and kraft palette: #332a20 / #aca089).
 *
 *  `height` must match the renderer titlebar's height (h-10 = 40px): Electron
 *  draws the overlay aligned to the top of the window, and the buttons are
 *  centered within `height`. If this is smaller than the bar (e.g. 32), the
 *  buttons sit too high instead of being vertically centered. */
function overlayColors() {
  const dark = getEffectiveTheme() === "dark";
  const sketch = getThemeStylePreference() === "sketch";
  return {
    // Light default #f0f2f6 = --surface-muted (240 242 246) so the native
    // controls' backdrop is the SAME color as the Titlebar's bg-surface-muted
    // — the old zinc-100 (#f4f4f5) left a visible tone seam where the overlay
    // met the React bar. Dark default already matches (#2c313c = 44 49 60).
    color: dark ? (sketch ? "#332a20" : "#2c313c") : sketch ? "#f6f2e7" : "#f0f2f6",
    symbolColor: dark ? (sketch ? "#aca089" : "#9ea2ab") : sketch ? "#8d8371" : "#71717a",
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

/** V8 old-space ceiling for the renderer, applied via `--js-flags` on the
 *  renderer process command line (webPreferences.additionalArguments).
 *  ~25% of physical RAM clamped to [2GB, 6GB]. Without a cap the V8 heap grows
 *  until the OS kills the process — and on a memory-starved machine it drags
 *  system-wide commit down with it (2026-10-30 03:01: renderer OOM while git,
 *  netstat and PowerShell were simultaneously failing to allocate). A capped
 *  heap turns the failure inward: this renderer dies alone instead of starving
 *  the whole machine. The transcript store is the growth driver (single
 *  sessions up to ~55MB raw text, parsed into several× that in JS objects), so
 *  the 2GB floor is a generous working set, not a straitjacket. */
function rendererHeapCapMb(): number {
  const quarterOfRamMb = Math.round(totalmem() / 4 / (1024 * 1024));
  return Math.min(6144, Math.max(2048, quarterOfRamMb));
}

/** Grant the renderer access to the microphone (voice input).
 *
 *  Electron defaults to denying mic permission for a sandboxed renderer, so
 *  the composer's voice button (which calls `navigator.mediaDevices.
 *  getUserMedia({ audio })`) would fail without this. This app's only mic
 *  consumer is the voice-input feature, so we allow `media` requests on the
 *  default session outright. Runs once, before any window loads a page.
 *  Uses Electron's `media` permission type (the umbrella covering mic/camera);
 *  we only ever request the mic, so granting media is sufficient.
 */
let sessionPermissionsReady = false;
function setupSessionPermissions(): void {
  if (sessionPermissionsReady) return;
  sessionPermissionsReady = true;
  const ses = session.defaultSession;

  // A custom check handler REPLACES Electron's default allow-all, so every
  // permission the renderer's own code relies on must be listed here or it
  // silently regresses app-wide. `navigator.clipboard.writeText()` performs a
  // `clipboard-sanitized-write` CHECK (no prompt) and `readText()` needs
  // `clipboard-read` — denying these broke every copy affordance (chat code
  // blocks, file-tree path copy, the mobile-connect dialog) and terminal
  // paste. Clipboard grants are scoped to the main window's webContents so
  // arbitrary pages can never touch the OS clipboard; the embedded browser
  // views use a separate persistent partition and are unaffected either way.
  const isAllowed = (wc: WebContents | null, permission: string): boolean => {
    if (permission === "media" || permission === "mediaKeySystem") return true;
    if (permission !== "clipboard-sanitized-write" && permission !== "clipboard-read") return false;
    const main = getMainWindow();
    return !!main && !main.isDestroyed() && wc?.id === main.webContents.id;
  };

  ses.setPermissionRequestHandler((wc, permission, callback) => {
    callback(isAllowed(wc, permission));
  });
  ses.setPermissionCheckHandler((wc, permission) => {
    return isAllowed(wc, permission);
  });
}

/** Create the primary three-pane window. */
export function createMainWindow(): BrowserWindow {
  setupSessionPermissions();
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
      additionalArguments: [`--js-flags=--max-old-space-size=${rendererHeapCapMb()}`],
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
  // ── Crash auto-reload, with an OOM-specific guard ──────────────────────────
  // Any non-clean renderer death reloads the page (the original behavior).
  // OOM deaths are different: an immediate reload re-parses the full session
  // store (445 sessions, transcripts up to ~55MB raw text each) into a machine
  // that just proved it has no memory to spare — on 2026-10-30 the immediate
  // reload OOM'd again 26 seconds later, while git/netstat were failing to
  // allocate. So OOM reloads wait for os.freemem() to recover, back off per
  // consecutive attempt, and after OOM_MAX_CRASHES stop auto-reloading and ask
  // the user instead of crash-looping. The renderer i18n system is dead at
  // that point, so the dialog copy is hardcoded bilingual.
  const CRASH_RELOAD_DELAY_MS = 500;
  const OOM_BACKOFF_MS = [2_000, 5_000, 15_000];
  const OOM_FREEMEM_MIN_BYTES = 1536 * 1024 * 1024;
  const OOM_FREEMEM_POLL_MS = 2_000;
  const OOM_FREEMEM_MAX_WAIT_MS = 90_000;
  const OOM_STABLE_RESET_MS = 5 * 60_000;
  const OOM_MAX_CRASHES = 3;

  let crashReloadTimer: NodeJS.Timeout | null = null;
  let oomWaitTimer: NodeJS.Timeout | null = null;
  let oomStableTimer: NodeJS.Timeout | null = null;
  let consecutiveOomCrashes = 0;

  function clearCrashReloadTimers(): void {
    if (crashReloadTimer) {
      clearTimeout(crashReloadTimer);
      crashReloadTimer = null;
    }
    if (oomWaitTimer) {
      clearTimeout(oomWaitTimer);
      oomWaitTimer = null;
    }
    if (oomStableTimer) {
      clearTimeout(oomStableTimer);
      oomStableTimer = null;
    }
  }

  function reloadRenderer(reason: string): void {
    const win = mainWindow;
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
    // Alive for OOM_STABLE_RESET_MS after this reload → the OOMs were one bad
    // episode, not a chronic condition; a fresh OOM starts counting at 1.
    if (oomStableTimer) clearTimeout(oomStableTimer);
    oomStableTimer = setTimeout(() => {
      oomStableTimer = null;
      consecutiveOomCrashes = 0;
    }, OOM_STABLE_RESET_MS);
    log.warn(`reloading renderer after crash (${reason})...`);
    win.webContents.reload();
  }

  /** OOM path: back off, then hold the reload until the machine shows real
   *  free memory again (polling, capped — after the cap we still try once; the
   *  consecutive-attempt cap below bounds the loop when the signal lies).
   *  freemem() is available-physical, not commit headroom — on Windows a dead
   *  process's pages return to the standby list while commit stays tight. It
   *  is still the right cheap gate (a machine deep in commit thrash shows
   *  near-zero available too); deliberately NOT a PowerShell perf-counter
   *  commit probe — those were among the commands failing to spawn during the
   *  incident. */
  function scheduleOomReload(attempt: number): void {
    const backoff = OOM_BACKOFF_MS[Math.min(attempt - 1, OOM_BACKOFF_MS.length - 1)];
    const deadline = Date.now() + backoff + OOM_FREEMEM_MAX_WAIT_MS;
    const step = (): void => {
      oomWaitTimer = null;
      const win = mainWindow;
      if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
      if (freemem() >= OOM_FREEMEM_MIN_BYTES || Date.now() >= deadline) {
        reloadRenderer("oom");
        return;
      }
      oomWaitTimer = setTimeout(step, OOM_FREEMEM_POLL_MS);
    };
    oomWaitTimer = setTimeout(step, backoff);
  }

  function showOomGiveUpDialog(): void {
    const options: Electron.MessageBoxOptions = {
      type: "error",
      title: "Mcode",
      message: "渲染进程内存不足 (Renderer out of memory)",
      detail:
        "渲染进程已连续 3 次因内存耗尽崩溃,自动恢复已暂停。\n" +
        "请关闭其他占用内存的程序(IDE、浏览器标签页、语言服务器等)后重试。\n\n" +
        "The renderer crashed 3 times in a row from memory exhaustion; auto-reload is paused.\n" +
        "Close other memory-heavy programs (IDEs, browser tabs, language servers) and retry.",
      buttons: ["重新加载 (Reload)", "退出 (Quit)"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    };
    const win = mainWindow;
    const shown =
      win && !win.isDestroyed()
        ? dialog.showMessageBox(win, options)
        : dialog.showMessageBox(options);
    void shown.then(({ response }) => {
      if (response === 0) {
        consecutiveOomCrashes = 0;
        scheduleOomReload(1);
      } else {
        log.warn("quitting from OOM recovery dialog");
        app.quit();
      }
    });
  }

  mainWindow.webContents.on("render-process-gone", (_e, details) => {
    const line = `[renderer:GONE] ${JSON.stringify(details)}`;
    process.stderr.write(`${line}\n`);
    log.error(line);
    clearCrashReloadTimers();
    if (details.reason === "clean-exit") return;

    // Non-OOM deaths (crashed/killed/…) mean the renderer got to run and died
    // of other causes — the immediate reload is safe and expected.
    if (details.reason !== "oom") {
      consecutiveOomCrashes = 0;
      crashReloadTimer = setTimeout(() => reloadRenderer(details.reason), CRASH_RELOAD_DELAY_MS);
      return;
    }

    consecutiveOomCrashes += 1;
    if (consecutiveOomCrashes >= OOM_MAX_CRASHES) {
      log.error(`renderer OOM ${consecutiveOomCrashes} times in a row — stopping auto-reload`);
      showOomGiveUpDialog();
      return;
    }
    scheduleOomReload(consecutiveOomCrashes);
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
 *  Defensive against a closed/destroyed window or disposed frame: node-pty's
 *  onExit/onData, ServiceScanner, and approval bridges fire asynchronously, so
 *  they can run after the window has torn down or while the renderer crashed.
 *  Calling webContents.send() on a destroyed window or disposed frame throws
 *  "Render frame was disposed before WebFrameMain could be accessed" or
 *  "Object has been destroyed". We guard against both and catch any synchronous
 *  throw so the main process never crashes from a dead renderer. */
export function sendToRenderer(channel: string, ...args: unknown[]): void {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  const wc = win.webContents;
  if (wc.isDestroyed() || wc.isCrashed()) return;
  try {
    wc.send(channel, ...args);
  } catch {
    // Drop silently if the render frame was disposed before or during access.
  }
}
