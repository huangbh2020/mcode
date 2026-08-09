/**
 * Owns all embedded browser WebContentsView instances for the browser panel.
 *
 * A WebContentsView is an OS-level web surface that overlays the main window's
 * renderer. The renderer can't host it directly - it measures a placeholder
 * div and sends pixel bounds over IPC; this manager positions the view to
 * match. Navigation/loading state is pushed back to the renderer as
 * `browser:event` messages.
 *
 * The DOM element picker is injected via `webContents.executeJavaScript` into
 * the page's main world. Picked elements flow back through the browserPicker
 * preload's `mcodeBridge.pickElement` -> `ipcRenderer.send` -> this manager
 * -> `sendToRenderer(BROWSER_EVENT / pickResult)`.
 *
 * Lifecycle: create() makes a view + attaches it (offscreen). show()/hide()
 * move it on/off screen without destroying the session (so toggling the panel
 * preserves browsing state). close() destroys. disposeAll() on app quit.
 *
 * Security: each view runs with contextIsolation + sandbox + a locked-down
 * preload that exposes only `mcodeBridge.pickElement`. External links
 * (target=_blank) are routed to the system browser, never opened in-view.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ipcMain, shell, WebContentsView, type Rectangle, type IpcMainEvent } from "electron";
import { IPC } from "@contracts/ipc";
import type {
  BrowserCreateResult,
  BrowserOpResult,
  BrowserDevicePreset,
  PickedElement,
} from "@contracts/ipc";
import { getMainWindow, sendToRenderer } from "@main/window.js";
import { getEffectiveTheme } from "@main/lib/theme.js";
import { log } from "@main/lib/logger.js";
import { PICKER_INJECT_SCRIPT, PICKER_REMOVE_SCRIPT } from "./pickerScript.js";
import { SNAPSHOT_SCRIPT, buildClickScript } from "./snapshotScript.js";

/** Metadata for a live browser view, returned by `list()` for agent discovery. */
export interface BrowserInfo {
  browserId: string;
  projectPath: string;
  url: string;
  title: string;
}

/** Result of a `snapshot()` — the structured page data handed to the agent. */
export interface BrowserSnapshotResult {
  ok: boolean;
  error?: string;
  data?: {
    url: string;
    title: string;
    readyState: string;
    html: string;
    bodyText: string;
    interactive: Array<{
      role: string;
      name: string;
      tag: string;
      selector: string;
      text: string;
    }>;
  };
}

/** Result of a `click()` — carries post-click url/title so the caller can tell
 *  whether the click triggered a navigation. */
export interface BrowserClickResult {
  ok: boolean;
  error?: string;
  url?: string;
  title?: string;
}

/** Result of a `screenshot()` — `data` is a base64 PNG string. */
export interface BrowserScreenshotResult {
  ok: boolean;
  error?: string;
  data?: string;
  mimeType?: "image/png";
}

/** A pixel rect in window coordinates (the renderer measures + forwards this). */
export interface BrowserBounds extends Rectangle {}

interface LiveBrowser {
  id: string;
  view: WebContentsView;
  /** Project root this browser is bound to (for consistency with terminal). */
  projectPath: string;
  /** Last applied bounds, so show() can restore after a hide(). */
  lastBounds: BrowserBounds;
  /** True while the view is attached + onscreen; false when hidden offscreen. */
  visible: boolean;
  /** Whether the picker is currently injected (avoids double-inject/remove). */
  pickMode: boolean;
  /** Current device emulation preset (desktop = no emulation). */
  device: BrowserDevicePreset;
}

/** Offscreen parking rect used while hidden (keeps the view alive but unseen). */
const HIDDEN_BOUNDS: Rectangle = { x: -9999, y: -9999, width: 1, height: 1 };

/** Background color matching the effective theme, so the view doesn't flash
 *  the wrong color before a page paints. Mirrors window.ts's bgColor(). */
function bgColor(): string {
  return getEffectiveTheme() === "dark" ? "#0d0e11" : "#ffffff";
}

class BrowserManagerImpl {
  private readonly browsers = new Map<string, LiveBrowser>();
  /** webContents.id -> browserId, for routing picker IPC from the right view. */
  private readonly wcToBrowser = new Map<number, string>();
  /** Registered once; the picker-result listener keys off `event.sender`. */
  private pickerListenerInstalled = false;

  create(projectPath: string, initialDevice?: BrowserDevicePreset): BrowserCreateResult {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) {
      return { ok: false, error: "主窗口未就绪，无法创建浏览器" };
    }

    const id = randomUUID();
    let view: WebContentsView;
    try {
      view = new WebContentsView({
        webPreferences: {
          // contextIsolation stays on so the page can't touch the preload's
          // scope; the browserPicker preload exposes only mcodeBridge.pickElement.
          // sandbox is OFF because the preload is built as ESM (.mjs) and
          // sandboxed preloads only support require() - ESM import would silently
          // fail to load, leaving window.mcodeBridge undefined. This mirrors the
          // main window's preload config (which is also sandbox:false + ESM).
          // The preload still grants no Node capability to the page itself.
          preload: join(__dirname, "../preload/browserPicker.mjs"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`browser view create failed: ${msg}`);
      return { ok: false, error: `创建浏览器视图失败: ${msg}` };
    }

    view.setBackgroundColor(bgColor());
    // Start offscreen + invisible until the renderer sends real bounds + show().
    view.setBounds(HIDDEN_BOUNDS);

    const live: LiveBrowser = {
      id,
      view,
      projectPath,
      lastBounds: HIDDEN_BOUNDS,
      visible: false,
      pickMode: false,
      device: "desktop",
    };
    this.browsers.set(id, live);
    this.wcToBrowser.set(view.webContents.id, id);

    win.contentView.addChildView(view);

    this.installPickerListener();
    this.attachNavigationEvents(live);

    // Apply an optional initial device-emulation preset once the renderer is
    // ready. Calling enableDeviceEmulation before the GPU/renderer process is
    // initialized (i.e. synchronously right after create) crashes Chromium on
    // Windows; dom-ready is the safe earliest point. Only applied if it differs
    // from the default "desktop" (which is a no-op disable).
    if (initialDevice && initialDevice !== "desktop") {
      const applyOnce = () => {
        this.setDevice(id, initialDevice);
        live.view.webContents.removeListener("dom-ready", applyOnce);
      };
      live.view.webContents.on("dom-ready", applyOnce);
    }

    // External links (target=_blank, window.open) go to the system browser,
    // never open a new Electron window inside the view.
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (url) void shell.openExternal(url);
      return { action: "deny" };
    });

    log.info(`browser created: ${id} project=${projectPath}`);
    return { ok: true, browserId: id };
  }

  /** Install the global picker-result listener once. Routes by sender. */
  private installPickerListener(): void {
    if (this.pickerListenerInstalled) return;
    this.pickerListenerInstalled = true;
    ipcMain.on("__mcode_pick_result__", (evt: IpcMainEvent, data: unknown) => {
      const browserId = this.wcToBrowser.get(evt.sender.id);
      if (!browserId) return;
      // Best-effort shape check; the picker always sends this structure.
      const el = data as PickedElement;
      if (!el || typeof el.selector !== "string") return;
      sendToRenderer(IPC.BROWSER_EVENT, {
        channel: IPC.BROWSER_EVENT,
        browserId,
        type: "pickResult",
        payload: el,
      });
    });
  }

  /** Wire navigation/loading events -> push to renderer as browser:event. */
  private attachNavigationEvents(live: LiveBrowser): void {
    const wc = live.view.webContents;
    const id = live.id;
    const push = (type: "navigation" | "loading", payload: unknown) => {
      sendToRenderer(IPC.BROWSER_EVENT, {
        channel: IPC.BROWSER_EVENT,
        browserId: id,
        type,
        payload,
      });
    };

    wc.on("did-start-loading", () => push("loading", { isLoading: true }));
    wc.on("did-stop-loading", () => push("loading", { isLoading: false }));
    wc.on("did-navigate", (_e, url) =>
      push("navigation", {
        url,
        title: wc.getTitle(),
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward(),
      }),
    );
    wc.on("did-navigate-in-page", (_e, url) =>
      push("navigation", {
        url,
        title: wc.getTitle(),
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward(),
      }),
    );
    wc.on("page-title-updated", (_e, title) =>
      push("navigation", {
        url: wc.getURL(),
        title,
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward(),
      }),
    );
    wc.on("render-process-gone", () => {
      live.pickMode = false;
      sendToRenderer(IPC.BROWSER_EVENT, {
        channel: IPC.BROWSER_EVENT,
        browserId: id,
        type: "crashed",
        payload: {},
      });
    });
  }

  private get(id: string): LiveBrowser | undefined {
    return this.browsers.get(id);
  }

  loadUrl(id: string, url: string): BrowserOpResult {
    const live = this.get(id);
    if (!live) return { ok: false, error: "浏览器不存在或已关闭" };
    try {
      void live.view.webContents.loadURL(url);
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`browser loadUrl failed: ${id} ${msg}`);
      return { ok: false, error: msg };
    }
  }

  goBack(id: string): BrowserOpResult {
    const live = this.get(id);
    if (!live) return { ok: false, error: "浏览器不存在或已关闭" };
    try {
      if (live.view.webContents.navigationHistory.canGoBack()) {
        live.view.webContents.navigationHistory.goBack();
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  goForward(id: string): BrowserOpResult {
    const live = this.get(id);
    if (!live) return { ok: false, error: "浏览器不存在或已关闭" };
    try {
      if (live.view.webContents.navigationHistory.canGoForward()) {
        live.view.webContents.navigationHistory.goForward();
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  reload(id: string): BrowserOpResult {
    const live = this.get(id);
    if (!live) return { ok: false, error: "浏览器不存在或已关闭" };
    try {
      live.view.webContents.reload();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Position/resize the view over the renderer's placeholder. When hidden the
   *  bounds are remembered so show() can restore them; the actual call here
   *  only applies if the view is visible (hidden views stay parked offscreen). */
  setBounds(id: string, bounds: BrowserBounds): BrowserOpResult {
    const live = this.get(id);
    if (!live) return { ok: false, error: "浏览器不存在或已关闭" };
    live.lastBounds = bounds;
    if (live.visible) {
      try {
        live.view.setBounds(bounds);
      } catch (err) {
        log.warn(`browser setBounds failed: ${id} ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { ok: true };
  }

  /** Attach + restore last bounds. Called when the panel reopens. */
  show(id: string): BrowserOpResult {
    const live = this.get(id);
    if (!live) return { ok: false, error: "浏览器不存在或已关闭" };
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return { ok: false, error: "主窗口未就绪" };
    try {
      // Re-attach in case it was removed (e.g. by close/hide using removeChildView).
      win.contentView.addChildView(live.view);
      const b = live.lastBounds.width > 1 ? live.lastBounds : { ...HIDDEN_BOUNDS };
      live.view.setBounds(b);
      live.visible = true;
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Move offscreen without destroying - preserves the browsing session so
   *  toggling the panel back on restores the page. */
  hide(id: string): BrowserOpResult {
    const live = this.get(id);
    if (!live) return { ok: false, error: "浏览器不存在或已关闭" };
    try {
      live.view.setBounds(HIDDEN_BOUNDS);
      live.visible = false;
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Inject or remove the DOM element picker from the page's main world. */
  async setPickMode(id: string, enabled: boolean): Promise<BrowserOpResult> {
    const live = this.get(id);
    if (!live) return { ok: false, error: "浏览器不存在或已关闭" };
    if (enabled === live.pickMode) return { ok: true }; // idempotent
    try {
      const script = enabled ? PICKER_INJECT_SCRIPT : PICKER_REMOVE_SCRIPT;
      await live.view.webContents.executeJavaScript(script, true);
      live.pickMode = enabled;
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`browser setPickMode failed: ${id} ${msg}`);
      // Pages that block script injection (e.g. CSP) leave the flag as-is.
      return { ok: false, error: `无法注入拾取脚本: ${msg}` };
    }
  }

  /** Set the device emulation preset. "desktop" disables emulation (full
   *  desktop viewport); mobile presets enable Chromium device emulation with a
   *  fixed screen size + device scale factor + mobile screenPosition. The
   *  renderer also narrows the view's bounds to match the emulated width so the
   *  page renders in a phone-sized column centered in the stage. */
  setDevice(id: string, device: BrowserDevicePreset): BrowserOpResult {
    const live = this.get(id);
    if (!live) return { ok: false, error: "浏览器不存在或已关闭" };
    if (device === live.device) return { ok: true }; // idempotent
    try {
      const wc = live.view.webContents;
      if (device === "desktop") {
        wc.disableDeviceEmulation();
      } else {
        // iPhone 14: 390x844 @ 3x; Android (Pixel): 412x915 @ 2.625x.
        const dims =
          device === "iphone"
            ? { width: 390, height: 844, scale: 3 }
            : { width: 412, height: 915, scale: 2.625 };
        wc.enableDeviceEmulation({
          screenPosition: "mobile",
          screenSize: { width: dims.width, height: dims.height },
          deviceScaleFactor: dims.scale,
          viewSize: { width: dims.width, height: dims.height },
          viewPosition: { x: 0, y: 0 },
          scale: 1,
        });
      }
      live.device = device;
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`browser setDevice failed: ${id} ${msg}`);
      return { ok: false, error: msg };
    }
  }

  /** Destroy the view + drop it from the manager. */
  close(id: string): BrowserOpResult {
    const live = this.get(id);
    if (!live) return { ok: true }; // already gone is fine
    const win = getMainWindow();
    try {
      if (win && !win.isDestroyed()) win.contentView.removeChildView(live.view);
    } catch {
      /* window tearing down - ignore */
    }
    this.wcToBrowser.delete(live.view.webContents.id);
    this.browsers.delete(id);
    try {
      live.view.webContents.close();
    } catch (err) {
      log.warn(`browser webContents close failed: ${id} ${err instanceof Error ? err.message : String(err)}`);
    }
    log.info(`browser closed: ${id}`);
    return { ok: true };
  }

  // ── Agent-facing capabilities ───────────────────────────────────────
  // These power the `browser_*` tools registered with both providers. Unlike
  // the panel-facing methods above (which fire navigation and return
  // immediately), these are async because they await the page's response:
  // executeJavaScript resolves with the script's return value, capturePage
  // resolves with a NativeImage. Both are awaited so the agent gets real data.

  /** List metadata for every live browser view, so an agent can discover the
   *  `browserId` to target. There is no "active" concept in the manager (the
   *  renderer tracks the active panel tab); the agent resolves a target by
   *  picking the first entry, or by matching url/title from this list. */
  list(): BrowserInfo[] {
    const out: BrowserInfo[] = [];
    for (const [id, live] of this.browsers) {
      const wc = live.view.webContents;
      out.push({
        browserId: id,
        projectPath: live.projectPath,
        url: wc.getURL(),
        title: wc.getTitle(),
      });
    }
    return out;
  }

  /** Read a structured snapshot of the page: url/title/readyState, clipped
   *  html + bodyText, and a compact list of interactive elements (links,
   *  buttons, inputs, headings) each with a stable selector the agent can
   *  pass back to `click()`. */
  async snapshot(id: string): Promise<BrowserSnapshotResult> {
    const live = this.get(id);
    if (!live) return { ok: false, error: "浏览器不存在或已关闭" };
    try {
      const data = await live.view.webContents.executeJavaScript(SNAPSHOT_SCRIPT, true);
      return { ok: true, data: data as BrowserSnapshotResult["data"] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`browser snapshot failed: ${id} ${msg}`);
      return { ok: false, error: `无法读取页面快照: ${msg}` };
    }
  }

  /** Programmatically click the element matching a CSS selector. The selector
   *  is JSON-encoded before substitution into the click script (see
   *  `buildClickScript`), so it can't break out of the `querySelector` call.
   *  Returns post-click url/title so the caller can detect navigation. */
  async click(id: string, selector: string): Promise<BrowserClickResult> {
    const live = this.get(id);
    if (!live) return { ok: false, error: "浏览器不存在或已关闭" };
    if (typeof selector !== "string" || selector.length === 0) {
      return { ok: false, error: "selector 不能为空" };
    }
    try {
      const script = buildClickScript(selector);
      const res = (await live.view.webContents.executeJavaScript(script, true)) as {
        ok?: boolean;
        error?: string;
        url?: string;
        title?: string;
      };
      if (res && res.error) return { ok: false, error: res.error };
      return { ok: true, url: res?.url, title: res?.title };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`browser click failed: ${id} ${msg}`);
      return { ok: false, error: `点击失败: ${msg}` };
    }
  }

  /** Capture the current page as a PNG screenshot. `capturePage()` renders the
   *  view's current composite — if the page is mid-navigation the result may be
   *  blank, so callers should snapshot/click after navigation settles. */
  async screenshot(id: string): Promise<BrowserScreenshotResult> {
    const live = this.get(id);
    if (!live) return { ok: false, error: "浏览器不存在或已关闭" };
    try {
      const image = await live.view.webContents.capturePage();
      const data = image.toPNG().toString("base64");
      return { ok: true, data, mimeType: "image/png" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`browser screenshot failed: ${id} ${msg}`);
      return { ok: false, error: `截图失败: ${msg}` };
    }
  }

  /** Destroy every live browser view - call on app quit. Idempotent (safe to
   *  call multiple times, e.g. during dev HMR). */
  disposeAll(): void {
    const ids = [...this.browsers.keys()];
    for (const id of ids) this.close(id);
  }
}

/** Process-wide singleton. */
export const BrowserManager = new BrowserManagerImpl();
