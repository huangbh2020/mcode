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
 * preload that exposes only `mcodeBridge.pickElement`. New-window requests
 * (target=_blank) for web URLs become new in-panel tabs on the same session;
 * other protocols go to the system browser. Desktop pages see a plain Chrome
 * UA (the Electron/app tail is stripped) — sign-in flows refuse webview UAs.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  app,
  ipcMain,
  safeStorage,
  shell,
  session,
  WebContentsView,
  type Rectangle,
  type Session,
  type Cookie,
  type CookiesSetDetails,
  type IpcMainEvent,
  type AuthInfo,
  type Debugger,
  type DownloadItem,
} from "electron";import {
  IPC,
  resolveBrowserDeviceSpec,
  BROWSER_COOKIE_VAULT_SETTING_KEY,
  BROWSER_COOKIE_VAULT_ENC_SETTING_KEY,
  BROWSER_DATA_DIR_SETTING_KEY,
  BROWSER_PERSIST_LOGIN_SETTING_KEY,
} from "@contracts/ipc";
import type {
  BrowserCreateResult,
  BrowserOpResult,
  BrowserDevicePreset,
  BrowserOrientation,
  BrowserViewport,
  PickedElement,
} from "@contracts/ipc";
import { getMainWindow, sendToRenderer } from "@main/window.js";
import { getOsPrefersDark, getThemePreference } from "@main/lib/theme.js";
import { log } from "@main/lib/logger.js";
import { SettingRepo } from "@main/store/repositories.js";
import { PICKER_INJECT_SCRIPT, PICKER_REMOVE_SCRIPT } from "./pickerScript.js";
import { SNAPSHOT_SCRIPT, buildClickScript, buildCheckFileInputScript, buildElementCenterScript, buildTypeScript, buildEvaluateScript, buildScrollScript, buildWaitScript, buildSelectScript, buildFindScript } from "./snapshotScript.js";
import { AddressHistory } from "./addressHistory.js";

/** Normalize a URL to its origin (scheme://host[:port]). Returns "" for URLs
 *  the URL constructor can't parse. */
function urlOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

/** Strip the Electron/app-name tokens Electron appends after the Safari marker
 *  (`…Safari/537.36 AppName/1.2.3 Electron/33.0.0` → `…Safari/537.36`) so
 *  desktop-mode pages see a plain Chrome UA. Sites like Google sign-in and
 *  some Cloudflare-protected hosts refuse embedded-webview UAs outright; the
 *  Chrome token itself stays genuine (real Chromium version), only the trailing
 *  framework identifiers are removed. Falls back to removing just the
 *  Electron/app tail if the Safari marker is ever absent. */
function chromeLikeUserAgent(ua: string): string {
  const m = ua.match(/^.*?Safari\/[\d.]+/);
  if (m) return m[0];
  return ua.replace(/\s*[\w.-]+\/[\d.]+\s+Electron\/[\d.]+\s*$|\s+Electron\/[\d.]+\s*$/, "").trim();
}

/** Metadata for a live browser view, returned by `list()` for agent discovery. */
export interface BrowserInfo {
  browserId: string;
  projectPath: string;
  url: string;
  title: string;
}

/** Normalize a model-supplied key name to Electron's accelerator key codes for
 *  `sendInputEvent`. Accepts KeyboardEvent.key-style names (ArrowUp, Escape…)
 *  as well as the accelerator names themselves (Up, Esc…). Single characters
 *  pass through lowercased (shift comes in as an explicit modifier). */
function normalizeKeyName(raw: string): string | null {
  const key = raw.trim();
  if (!key) return null;
  const named: Record<string, string> = {
    enter: "Enter",
    return: "Enter",
    tab: "Tab",
    esc: "Esc",
    escape: "Esc",
    space: "Space",
    spacebar: "Space",
    backspace: "Backspace",
    delete: "Del",
    del: "Del",
    up: "Up",
    arrowup: "Up",
    down: "Down",
    arrowdown: "Down",
    left: "Left",
    arrowleft: "Left",
    right: "Right",
    arrowright: "Right",
    pageup: "PageUp",
    pagedown: "PageDown",
    home: "Home",
    end: "End",
    insert: "Ins",
    ins: "Ins",
  };
  const lower = key.toLowerCase();
  if (named[lower]) return named[lower];
  if (/^f([1-9]|1\d|2[0-4])$/.test(lower)) return key.toUpperCase();
  if (key.length === 1) return key.toLowerCase();
  return null;
}

/** Parse a key combo like "Control+Shift+Enter" into sendInputEvent modifiers
 *  + a key code. CmdOrCtrl maps to Meta on macOS / Control elsewhere (the
 *  usual convention). Exactly one non-modifier key per combo. */
function parseKeyCombo(
  combo: string,
): { modifiers: Array<"control" | "shift" | "alt" | "meta">; key: string } | { error: string } {
  const parts = combo
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return { error: "按键为空" };
  const modifiers: Array<"control" | "shift" | "alt" | "meta"> = [];
  let key: string | null = null;
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === "control" || lower === "ctrl" || lower === "cmdorctrl") {
      modifiers.push(process.platform === "darwin" ? "meta" : "control");
    } else if (lower === "meta" || lower === "cmd" || lower === "command" || lower === "super" || lower === "win") {
      modifiers.push("meta");
    } else if (lower === "alt" || lower === "option") {
      modifiers.push("alt");
    } else if (lower === "shift") {
      modifiers.push("shift");
    } else if (key === null) {
      const norm = normalizeKeyName(part);
      if (!norm) return { error: `无法识别的按键 "${part}"(支持 Enter/Escape/Tab/Arrow*/PageUp/F1-F12/单字符等)` };
      key = norm;
    } else {
      return { error: `一次只能按一个主键:"${combo}"` };
    }
  }
  if (key === null) return { error: `组合键缺少主键:"${combo}"` };
  return { modifiers, key };
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
      /** 1-based handle the model passes to browser_click/type/select. */
      index: number;
      role: string;
      name: string;
      tag: string;
      selector: string;
      text: string;
      /** False when the element is outside the viewport (scroll to reach it). */
      inView: boolean;
      /** Form-state annotations: value=… / [checked] / [disabled] / href=… */
      state: string[];
    }>;
  };
}

/** Result of a `click()` — carries post-click url/title so the caller can tell
 *  whether the click triggered a navigation. `obscured` is set when the real
 *  mouse click path detected another element covering the target's center. */
export interface BrowserClickResult {
  ok: boolean;
  error?: string;
  url?: string;
  title?: string;
  obscured?: { tag: string; text: string };
}

/** Result of an `evaluate()` — like click, plus `result`: a JSON/text
 *  serialization of the script's return value (so the agent can verify what
 *  its DOM changes produced). */
export interface BrowserEvaluateResult extends BrowserClickResult {
  /** Serialized return value of the evaluated script (JSON or String fallback). */
  result?: string;
}

/** Result of a `scroll()` — where the viewport (or scrolled element) landed,
 *  so the agent can tell whether more content remains below. */
export interface BrowserScrollResult extends BrowserClickResult {
  scrollY?: number;
  scrollHeight?: number;
  viewport?: number;
}

/** Result of a `selectOption()` — the chosen option, or the full option list
 *  when nothing matched (the agent retries with an exact spelling). */
export interface BrowserSelectResult extends BrowserClickResult {
  selected?: { value: string; text: string };
  options?: Array<{ value: string; text: string; selected?: boolean }>;
}

/** Result of a `find()` — selector rows (tag/text/selector/attributes) or
 *  text-match snippets, depending on the query mode. */
export interface BrowserFindResult extends BrowserClickResult {
  total?: number;
  matches?: Array<{
    tag?: string;
    text?: string;
    selector?: string;
    attributes?: Record<string, string>;
    snippet?: string;
  }>;
}

/** Result of a `waitFor()` — `found:false` means the condition never became
 *  true within the timeout (still ok:true — the poll itself ran fine). */
export interface BrowserWaitResult extends BrowserClickResult {
  found?: boolean;
  elapsedMs?: number;
}

/** One tracked download of the shared browser session. Kept in main (recent
 *  50), pushed to the renderer as a "download" browser:event on start and at
 *  the terminal state, and listed for agents via the browser_downloads tool. */
export interface BrowserDownloadEntry {
  id: string;
  browserId: string;
  url: string;
  filename: string;
  /** Absolute path the file is being written to (pre-allocated, deduped). */
  path: string;
  state: "progressing" | "completed" | "cancelled" | "interrupted";
  receivedBytes: number;
  totalBytes: number;
  startedAt: number;
  endedAt?: number;
}

/** Result of a `printToPdf()` — `data` is the PDF bytes base64-encoded; the
 *  caller writes it to disk. */
export interface BrowserPdfResult {
  ok: boolean;
  error?: string;
  data?: string;
}

/** Where downloads land: a fixed subfolder of the OS downloads directory, so
 *  the agent (and the user) always knows where to look. Created lazily. */
function browserDownloadsDir(): string {
  return join(app.getPath("downloads"), "mcode-browser");
}

/** Dedupe a download filename against existing files on disk: `a.pdf` →
 *  `a-1.pdf`, `a-2.pdf` … (before the extension). Keeps repeated downloads of
 *  the same report from silently overwriting each other. */
function uniqueDownloadPath(dir: string, filename: string): string {
  const safe = filename.replace(/[\\/:*?"<>|]/g, "_").trim() || "download";
  const ext = join(dir, safe);
  try {
    statSync(ext);
  } catch {
    return ext; // does not exist — take it
  }
  const dot = safe.lastIndexOf(".");
  const stem = dot > 0 ? safe.slice(0, dot) : safe;
  const tail = dot > 0 ? safe.slice(dot) : "";
  for (let i = 1; i < 1000; i++) {
    const candidate = join(dir, `${stem}-${i}${tail}`);
    try {
      statSync(candidate);
    } catch {
      return candidate;
    }
  }
  return join(dir, `${stem}-${Date.now()}${tail}`);
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
  /** Current viewport config (custom dims + orientation). Mirrors what was
   *  last passed to setDevice so screenshots/reuse apply the same emulation. */
  viewport: BrowserViewport;
  /** Original UA captured at create() — restored when leaving a mobile preset
   *  (webContents.setUserAgent fallback path). */
  defaultUserAgent: string;
  /** True while THIS manager holds a CDP debugger session on the view (for the
   *  UA/client-hint override). Lets setDevice detach only its own session. */
  uaDebuggerAttached: boolean;
  /** True while a CDP debugger session pins the page's prefers-color-scheme to
   *  the OS preference (see pinColorScheme). Released before the mobile UA
   *  override takes the (single) debugger slot. */
  csDebuggerAttached: boolean;
  /** Resolves once the cookie vault has been restored into this view's
   *  session (or was skipped). Navigation must wait for it — see loadUrl. */
  ready: Promise<void>;
}

/** Offscreen parking rect used while hidden (keeps the view alive but unseen). */
const HIDDEN_BOUNDS: Rectangle = { x: -9999, y: -9999, width: 1, height: 1 };

/** Default on-screen bounds for an agent-created view that the renderer hasn't
 *  measured yet. Sized to a reasonable right-panel region of the main window so
 *  the page is visible AND capturable (capturePage on a 1x1 offscreen view
 *  returns an empty image). The renderer's BrowserPanel will re-sync precise
 *  bounds once it mounts and measures its placeholder div. */
function defaultOnscreenBounds(): Rectangle {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) {
    return { x: 80, y: 80, width: 800, height: 600 };
  }
  const [winW, winH] = win.getContentSize();
  // Right ~42% of the window, leaving room for the center pane. Min 480 wide.
  const panelW = Math.max(480, Math.round(winW * 0.42));
  return { x: Math.max(0, winW - panelW), y: 0, width: panelW, height: winH };
}

/** Fixed background for every browser view. Intentionally theme-independent:
 *  the page (and any blank/loading frame while it paints) keeps the same
 *  backdrop whether the app is in dark or light mode, so the embedded browser
 *  reads as an external window rather than a themed panel. White is Chromium's
 *  default page canvas. */
const BROWSER_BACKGROUND = "#ffffff";

/** Persistent partition shared by ALL embedded browser views, so cookies /
 *  localStorage / login state is consistent across tabs (mirrors the old
 *  behavior of all views sharing session.defaultSession, but isolated from the
 *  app shell). Used when the user has NOT configured a custom data directory. */
const BROWSER_PARTITION = "persist:mcode-browser";

/** The shared Session for every embedded browser view. When the user has
 *  configured a data directory (browser.dataDir setting) it is created via
 *  `session.fromPath(dir)` — the browser's cookies, form/autofill data,
 *  localStorage, IndexedDB etc. are written straight into that directory.
 *  Empty/absent → Electron's default partition location under userData.
 *
 *  NOTE: Electron caches Session objects by path/partition string, so a
 *  browser.dataDir change only takes effect on the first session lookup of a
 *  run. Changing the setting therefore requires an app restart (the settings
 *  UI tells the user this). */
function browserSession(): Session {
  const dir = SettingRepo.get(BROWSER_DATA_DIR_SETTING_KEY)?.trim();
  if (!dir) return session.fromPartition(BROWSER_PARTITION);
  // session.fromPath requires an absolute path; a relative value (e.g. typed
  // into the settings input) would be resolved unpredictably — fall back to
  // the default partition location instead.
  if (!isAbsolute(dir)) {
    log.warn(`browser data dir is not absolute, ignoring: ${dir}`);
    return session.fromPartition(BROWSER_PARTITION);
  }
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`browser data dir mkdir failed (falling back to default): ${msg}`);
    return session.fromPartition(BROWSER_PARTITION);
  }
  return session.fromPath(dir);
}

/** Whether cookies should survive restarts via the vault
 *  (`browser.persistLogin`; missing = on, "0" = off). */
function isPersistLoginEnabled(): boolean {
  return SettingRepo.get(BROWSER_PERSIST_LOGIN_SETTING_KEY) !== "0";
}

/** How often the cookie vault is refreshed in the background, so a force-kill
 *  (dev Ctrl+C, crash) loses at most one interval of sign-in state. */
const PERSIST_LOGIN_INTERVAL_MS = 5 * 60 * 1000;

/** Upper bound on vaulted cookies. A panel browser accumulates far fewer;
 *  the cap just keeps the settings row bounded if something pathological
 *  (tracker explosion) happens. Newest wins is NOT applied — the array is
 *  the session's live cookie list, order is Chromium's. */
const COOKIE_VAULT_MAX = 400;

/** Serializable snapshot of one cookie. `expirationDate` is omitted for
 *  session cookies, which therefore restore as session cookies — full
 *  fidelity, no expiry rewriting. */
interface VaultCookie {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: Cookie["sameSite"];
  expirationDate?: number;
}

/** User-Agent + platform metadata used while a mobile preset is active.
 *  enableDeviceEmulation only emulates the viewport — the page's requests
 *  would otherwise keep the desktop Electron UA, so backends still judge the
 *  device as PC. Keyed by preset id; unknown presets ("custom" when narrow)
 *  fall back to ANDROID_UA_SPEC. */
interface DeviceUaSpec {
  /** User-Agent string (HTTP header + navigator.userAgent). */
  ua: string;
  /** Value for CDP Emulation.setUserAgentOverride.platform → navigator.platform. */
  platform: string;
  /** Client-hint platform token (sec-ch-ua-platform / userAgentData.platform). */
  os: "android" | "ios";
  platformVersion: string;
  model: string;
}

const ANDROID_UA_SPEC: DeviceUaSpec = {
  ua: "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
  platform: "Linux armv8l",
  os: "android",
  platformVersion: "14.0.0",
  model: "Pixel 7",
};

const MOBILE_USER_AGENTS: Partial<Record<BrowserDevicePreset, DeviceUaSpec>> = {
  iphone: {
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1",
    platform: "iPhone",
    os: "ios",
    platformVersion: "16.5.0",
    model: "iPhone 14",
  },
  "iphone-se": {
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 15_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.5 Mobile/15E148 Safari/604.1",
    platform: "iPhone",
    os: "ios",
    platformVersion: "15.5.0",
    model: "iPhone SE",
  },
  android: ANDROID_UA_SPEC,
  "galaxy-s23": {
    ua: "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
    platform: "Linux armv8l",
    os: "android",
    platformVersion: "14.0.0",
    model: "SM-S918B",
  },
  "ipad-mini": {
    ua: "Mozilla/5.0 (iPad; CPU OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1",
    platform: "iPad",
    os: "ios",
    platformVersion: "16.5.0",
    model: "iPad mini",
  },
};

/** Whether a device preset should present a mobile UA. Desktop (no emulation)
 *  is desktop; the phone/tablet presets always mobile; "custom" is mobile only
 *  while narrow enough to be a phone/tablet viewport (wide custom sizes behave
 *  like desktop pages). */
function isMobileUa(device: BrowserDevicePreset, effWidth: number): boolean {
  if (device === "desktop") return false;
  if (device === "custom") return effWidth <= 1024;
  return true;
}

/** CDP UserAgentMetadata for the emulated device: drives the `sec-ch-ua*`
 *  client-hint headers and navigator.userAgentData. Without it a UA override
 *  leaves client hints reporting the real desktop Chrome — the exact "judged
 *  as PC" symptom. Best-effort: Chromium's brands are used even for iOS UAs;
 *  the `mobile: true` flag is what backends actually branch on. */
function userAgentMetadataFor(spec: DeviceUaSpec) {
  return {
    brands: [
      { brand: "Chromium", version: "124" },
      { brand: "Google Chrome", version: "124" },
      { brand: "Not-A.Brand", version: "99" },
    ],
    fullVersion: "124.0.0.0",
    platform: spec.os === "android" ? "Android" : "iOS",
    platformVersion: spec.platformVersion,
    architecture: "",
    model: spec.model,
    mobile: true,
    bitness: "",
    wow64: false,
  };
}

class BrowserManagerImpl {
  private readonly browsers = new Map<string, LiveBrowser>();
  /** webContents.id -> browserId, for routing picker IPC from the right view. */
  private readonly wcToBrowser = new Map<number, string>();
  /** Registered once; the picker-result listener keys off `event.sender`. */
  private pickerListenerInstalled = false;
  /** Background cookie-vault save timer (see saveCookieVault).
   *  Started once with the first browser view; never stopped (process exits). */
  private persistTimer: NodeJS.Timeout | null = null;

  create(projectPath: string, initialDevice?: BrowserDevicePreset): BrowserCreateResult {
    const spawned = this.spawnView(projectPath);
    if ("error" in spawned) return { ok: false, error: spawned.error };
    const live = spawned.live;

    // Apply an optional initial device-emulation preset once the renderer is
    // ready. Calling enableDeviceEmulation before the GPU/renderer process is
    // initialized (i.e. synchronously right after create) crashes Chromium on
    // Windows; dom-ready is the safe earliest point. Only applied if it differs
    // from the default "desktop" (which is a no-op disable).
    if (initialDevice && initialDevice !== "desktop") {
      const applyOnce = () => {
        this.setDevice(live.id, initialDevice);
        live.view.webContents.removeListener("dom-ready", applyOnce);
      };
      live.view.webContents.on("dom-ready", applyOnce);
    }

    return { ok: true, browserId: live.id };
  }

  /** Core view construction shared by the panel's create() and the
   *  window-open ("open as a new tab") path. Creates the WebContentsView on
   *  the shared browser session, registers it, wires navigation events, and
   *  installs the window-open handler that turns target=_blank / window.open
   *  into in-panel tabs (see handleWindowOpen). */
  private spawnView(projectPath: string): { live: LiveBrowser } | { error: string } {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) {
      return { error: "主窗口未就绪，无法创建浏览器" };
    }

    const id = randomUUID();
    const ses = browserSession();
    let view: WebContentsView;
    try {
      view = new WebContentsView({
        webPreferences: {
          // The browser runs on its own persistent partition (browserSession),
          // isolated from the app shell's default session, so cookies/login/
          // storage live in the browser's data directory (user-configurable
          // via the browser.dataDir setting) instead of mixing with app data.
          session: ses,
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
      return { error: `创建浏览器视图失败: ${msg}` };
    }

    view.setBackgroundColor(BROWSER_BACKGROUND);
    // Start offscreen + invisible until the renderer sends real bounds + show().
    view.setBounds(HIDDEN_BOUNDS);

    // Present a plain Chrome UA on desktop pages — chromeLikeUserAgent strips
    // the Electron/app-name tail, which sign-in flows (Google & friends) and
    // some anti-bot layers refuse outright. The cleaned value doubles as the
    // desktop default that the mobile-emulation path restores on turn-off.
    const rawUserAgent = view.webContents.getUserAgent();
    const desktopUserAgent = chromeLikeUserAgent(rawUserAgent);
    if (desktopUserAgent && desktopUserAgent !== rawUserAgent) {
      view.webContents.setUserAgent(desktopUserAgent);
    }

    const live: LiveBrowser = {
      id,
      view,
      projectPath,
      lastBounds: HIDDEN_BOUNDS,
      visible: false,
      pickMode: false,
      device: "desktop",
      viewport: { device: "desktop", orientation: "portrait" },
      defaultUserAgent: desktopUserAgent || rawUserAgent,
      uaDebuggerAttached: false,
      csDebuggerAttached: false,
      ready: this.restoreCookieVault(ses),
    };
    this.browsers.set(id, live);
    this.wcToBrowser.set(view.webContents.id, id);

    win.contentView.addChildView(view);

    this.installPickerListener();
    this.attachNavigationEvents(live);
    this.ensurePersistTimer();
    this.installDownloadListener();

    // New-window requests (target=_blank, window.open) become in-panel tabs
    // for web URLs so browsing never leaves the app; other protocols
    // (mailto: & co) still go to the system browser. The handler must return
    // synchronously — the adoption work is fire-and-forget.
    view.webContents.setWindowOpenHandler(({ url, disposition }) => {
      void this.handleWindowOpen(live, url, disposition);
      return { action: "deny" };
    });

    log.info(`browser created: ${id} project=${projectPath}`);
    void this.pinColorScheme(live);
    return { live };
  }

  /** Adopt a page-initiated new-window request as a new in-panel tab. Web
   *  URLs (http/https/file) spawn a fresh view on the SAME browser session
   *  (cookies shared, so OAuth popups land on the signed-in session) and push
   *  a "tabOpened" event; the renderer adopts the new browserId into its tab
   *  strip and takes over visibility/bounds. Everything else — other
   *  protocols, unparseable URLs, spawn failures — falls back to the system
   *  browser, mirroring the previous open-everything-externally behavior. */
  private handleWindowOpen(parent: LiveBrowser, rawUrl: string, disposition: string): void {
    if (!rawUrl) return;
    let proto = "";
    try {
      proto = new URL(rawUrl).protocol;
    } catch {
      /* unparseable → system browser below */
    }
    if (proto === "http:" || proto === "https:" || proto === "file:") {
      const spawned = this.spawnView(parent.projectPath);
      if ("live" in spawned) {
        const child = spawned.live;
        // loadUrl waits for the cookie vault restore before the first request.
        this.loadUrl(child.id, rawUrl);
        sendToRenderer(IPC.BROWSER_EVENT, {
          channel: IPC.BROWSER_EVENT,
          browserId: child.id,
          type: "tabOpened",
          payload: { url: rawUrl, background: disposition === "background-tab" },
        });
        log.info(`browser window-open → new tab: ${child.id} url=${rawUrl} (from ${parent.id})`);
        return;
      }
      log.warn(`browser window-open tab spawn failed, falling back to system browser: ${spawned.error}`);
    }
    shell.openExternal(rawUrl).catch((err: unknown) => {
      log.warn(`browser openExternal failed for ${rawUrl}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /** Pin this view's `prefers-color-scheme` media query to the OS's real
   *  preference (captured at startup, before the app's themeSource override),
   *  so embedded pages render like they would in the OS browser instead of
   *  following the app's dark/light setting. Uses the CDP debugger's
   *  Emulation.setEmulatedMedia — Electron has no per-webContents themeSource,
   *  and nativeTheme.themeSource is process-global. Silent no-op when the app
   *  is in "system" theme mode (the OS already controls the media feature),
   *  when the debugger is busy, or when the view is gone — degradation only
   *  ever returns to the current behavior.
   *
   *  The mobile UA override needs the debugger too (two attach() calls on one
   *  webContents throw), so applyDeviceUserAgent releases this session while a
   *  mobile preset is active and this method re-attaches when emulation returns
   *  to desktop. */
  private async pinColorScheme(live: LiveBrowser): Promise<void> {
    if (getThemePreference() === "system") return;
    const wc = live.view.webContents;
    if (wc.isDestroyed() || live.csDebuggerAttached) return;
    try {
      wc.debugger.attach("1.3");
      live.csDebuggerAttached = true;
    } catch {
      // Debugger already taken (DevTools / mobile UA session) — leave the page
      // unpinned rather than disturb the other user.
      return;
    }
    try {
      await wc.debugger.sendCommand("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: getOsPrefersDark() ? "dark" : "light" }],
      });
    } catch {
      // Page tearing down / session broken — release the slot so a later call
      // (or the UA override) can retry.
      try {
        wc.debugger.detach();
      } catch {
        /* ignore */
      }
      live.csDebuggerAttached = false;
    }
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
    wc.on("did-navigate", (_e, url) => {
      // Address-bar history (main is the single writer; renderer only reads
      // and requests removals). The title may still be blank this early —
      // page-title-updated below refreshes the entry via record()'s dedupe.
      try {
        AddressHistory.record(url, wc.getTitle());
      } catch {
        /* history must never break navigation */
      }
      push("navigation", {
        url,
        title: wc.getTitle(),
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward(),
      });
    });
    wc.on("did-navigate-in-page", (_e, url) =>
      push("navigation", {
        url,
        title: wc.getTitle(),
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward(),
      }),
    );
    wc.on("page-title-updated", (_e, title) => {
      // did-navigate may have recorded a blank title; re-record to fill it in.
      try {
        AddressHistory.record(wc.getURL(), title);
      } catch {
        /* ignore */
      }
      push("navigation", {
        url: wc.getURL(),
        title,
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward(),
      });
    });
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
      const wc = live.view.webContents;
      // Navigation waits for the cookie vault restore so login state (which
      // only exists as in-memory cookies after the re-inject) is present from
      // the very first request — otherwise the site would see an anonymous
      // session and bounce to its login page.
      void live.ready.then(() => wc.loadURL(url));
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`browser loadUrl failed: ${id} ${msg}`);
      return { ok: false, error: msg };
    }
  }

  /** Wait for the view's page to finish loading (did-finish-load), or time out.
   *  Used by the agent navigate tool so a subsequent snapshot/screenshot sees
   *  real content instead of a blank/about:blank page. Resolves with the final
   *  url/title so the caller can report them. No-op-safe if the page is already
   *  loaded (did-finish-load fires immediately on attach only if load already
   *  completed, so the timeout is the real backstop in that case). */
  async waitForLoad(id: string, timeoutMs = 8000): Promise<{ ok: boolean; url?: string; title?: string; error?: string }> {
    const live = this.get(id);
    if (!live) return { ok: false, error: "浏览器不存在或已关闭" };
    const wc = live.view.webContents;
    if (wc.isLoading() === false) {
      // Already loaded (or hasn't started yet). Give a brief grace period for a
      // just-kicked-off loadURL to register as loading, then return current state.
      await new Promise((r) => setTimeout(r, 200));
      if (wc.isLoading() === false) {
        return { ok: true, url: wc.getURL(), title: wc.getTitle() };
      }
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: { ok: boolean; url?: string; title?: string; error?: string }) => {
        if (settled) return;
        settled = true;
        wc.removeListener("did-finish-load", onLoad);
        wc.removeListener("did-fail-load", onFail);
        resolve(result);
      };
      const onLoad = () => finish({ ok: true, url: wc.getURL(), title: wc.getTitle() });
      const onFail = (_e: unknown, errorCode: number, errorDesc: string) =>
        finish({ ok: false, error: `页面加载失败(${errorCode}): ${errorDesc}` });
      wc.on("did-finish-load", onLoad);
      wc.on("did-fail-load", onFail);
      // Backstop: some pages never fire did-finish-load (permanent spinners,
      // streaming responses). Resolve with whatever we have so the agent isn't
      // blocked indefinitely.
      setTimeout(() => finish({ ok: true, url: wc.getURL(), title: wc.getTitle() }), timeoutMs);
    });
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

  /** Attach + restore last bounds. Called when the panel reopens. When the
   *  view was created by the agent (never measured by the renderer), lastBounds
   *  is still HIDDEN_BOUNDS — fall back to a default on-screen region so the
   *  page is visible and capturable instead of a 1x1 offscreen blank.
   *
   *  Idempotent: re-showing an already-visible view is a no-op. This matters
   *  because addChildView on an attached view re-orders/re-hosts the native
   *  surface — the compositor drops a frame and the panel visibly flashes
   *  white. The renderer calls show() liberally (popup open/close resyncs), so
   *  the dedupe here is what keeps redundant calls flicker-free. */
  show(id: string): BrowserOpResult {
    const live = this.get(id);
    if (!live) return { ok: false, error: "浏览器不存在或已关闭" };
    if (live.visible) return { ok: true };
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return { ok: false, error: "主窗口未就绪" };
    try {
      // Re-attach in case it was removed (e.g. by close/hide using removeChildView).
      win.contentView.addChildView(live.view);
      const b = live.lastBounds.width > 1 ? live.lastBounds : defaultOnscreenBounds();
      live.lastBounds = b;
      live.view.setBounds(b);
      live.visible = true;
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Move offscreen without destroying - preserves the browsing session so
   *  toggling the panel back on restores the page. Dimensions are PRESERVED
   *  (only x/y move offscreen) so capturePage still reads a valid backing
   *  store from the hidden view — agent screenshots of a hidden panel don't
   *  need to flash the page on-screen. Idempotent (no-op when already hidden). */
  hide(id: string): BrowserOpResult {
    const live = this.get(id);
    if (!live) return { ok: false, error: "浏览器不存在或已关闭" };
    if (!live.visible) return { ok: true };
    try {
      live.view.setBounds({ x: -9999, y: -9999, width: live.lastBounds.width, height: live.lastBounds.height });
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

  /** Set the device emulation preset (or a custom viewport + orientation).
   *  "desktop" disables emulation (full desktop viewport); mobile presets
   *  enable Chromium device emulation with a screen size + device scale factor
   *  + mobile screenPosition. For "custom", the given width/height are used
   *  (falling back to the iphone preset dims). `orientation: "landscape"`
   *  swaps width/height before emulating. The renderer also narrows the view's
   *  bounds to match the emulated size so the page renders in a device-sized
   *  column centered in the stage. */
  setDevice(
    id: string,
    device: BrowserDevicePreset,
    opts?: {
      width?: number;
      height?: number;
      orientation?: BrowserOrientation;
      /** Effective emulated viewport size (CSS px). Overrides the preset/custom
       *  dims so the viewport exactly matches the view's physical bounds (see
       *  BrowserSetDeviceSchema.viewportWidth). */
      viewportWidth?: number;
      viewportHeight?: number;
    },
  ): BrowserOpResult {
    const live = this.get(id);
    if (!live) return { ok: false, error: "浏览器不存在或已关闭" };
    const orientation = opts?.orientation ?? "portrait";
    const spec = resolveBrowserDeviceSpec(device, {
      width: opts?.width,
      height: opts?.height,
    });
    const effW = opts?.viewportWidth ?? (orientation === "landscape" ? spec.height : spec.width);
    const effH = opts?.viewportHeight ?? (orientation === "landscape" ? spec.width : spec.height);
    if (
      device === live.device &&
      orientation === (live.viewport?.orientation ?? "portrait") &&
      effW === live.viewport?.effWidth &&
      effH === live.viewport?.effHeight
    ) {
      return { ok: true }; // idempotent
    }
    try {
      const wc = live.view.webContents;
      if (device === "desktop") {
        wc.disableDeviceEmulation();
      } else {
        wc.enableDeviceEmulation({
          screenPosition: "mobile",
          screenSize: { width: effW, height: effH },
          deviceScaleFactor: spec.scale,
          viewSize: { width: effW, height: effH },
          viewPosition: { x: 0, y: 0 },
          scale: 1,
        });
      }
      // Viewport emulation alone keeps the desktop Electron UA on the page's
      // requests — override UA/client-hints/platform to match the device (or
      // restore the desktop UA when emulation is off). Fire-and-forget: the
      // CDP work is async, failures are logged inside.
      void this.applyDeviceUserAgent(live, device, effW);
      live.device = device;
      live.viewport = {
        device,
        width: opts?.width,
        height: opts?.height,
        orientation,
        effWidth: effW,
        effHeight: effH,
      };
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`browser setDevice failed: ${id} ${msg}`);
      return { ok: false, error: msg };
    }
  }

  /** Override the view's User-Agent (+ client hints + navigator.platform +
   *  touch) so requests from a mobile-emulated page advertise the emulated
   *  device — and restore the desktop UA when emulation is off. Without this a
   *  mobile viewport still sends desktop Electron UAs, so backends judge the
   *  device as PC.
   *
   *  Primary path is the CDP debugger: Emulation.setUserAgentOverride covers
   *  the UA header AND the sec-ch-ua* client hints AND navigator.platform (a
   *  plain webContents.setUserAgent would leave client hints reporting the
   *  real desktop Chrome). The debugger stays attached while a mobile preset
   *  is active and is detached on desktop, which reverts every override. If
   *  the debugger is busy (e.g. DevTools open on this view) it falls back to
   *  setUserAgent alone — the UA header is what most backends check anyway.
   *  Idempotent + race-tolerant: attach() is synchronous (so the attached flag
   *  is set atomically), and a later detach()/re-attach always wins. */
  private async applyDeviceUserAgent(
    live: LiveBrowser,
    device: BrowserDevicePreset,
    effWidth: number,
  ): Promise<void> {
    const wc = live.view.webContents;
    if (wc.isDestroyed()) return;
    if (!isMobileUa(device, effWidth)) {
      if (live.uaDebuggerAttached) {
        try {
          wc.debugger.detach(); // reverts all CDP overrides (UA/hints/touch)
        } catch {
          /* view tearing down - ignore */
        }
        live.uaDebuggerAttached = false;
      }
      if (live.defaultUserAgent) wc.setUserAgent(live.defaultUserAgent);
      // Desktop has no UA needs — re-pin the page's color scheme, which the
      // mobile path freed to make the debugger slot available.
      void this.pinColorScheme(live);
      return;
    }
    const spec = MOBILE_USER_AGENTS[device] ?? ANDROID_UA_SPEC;
    // Give up our color-scheme pin session so the UA override below can have
    // the sole debugger slot (two attach() calls on one webContents throw).
    if (live.csDebuggerAttached) {
      try {
        wc.debugger.detach();
      } catch {
        /* view tearing down - ignore */
      }
      live.csDebuggerAttached = false;
    }
    if (!live.uaDebuggerAttached) {
      try {
        wc.debugger.attach("1.3");
        live.uaDebuggerAttached = true;
      } catch {
        // Debugger busy (e.g. DevTools open on this view): fall back to the
        // plain UA override below; client hints stay desktop, but the UA
        // header is what most backends check.
        log.warn(
          `browser UA debugger attach failed (falling back to UA-only override): ${live.id}`,
        );
      }
    }
    try {
      // Set the webContents UA first (primary on the fallback path, base
      // value on the CDP path — the override below takes precedence).
      wc.setUserAgent(spec.ua);
      if (live.uaDebuggerAttached) {
        await wc.debugger.sendCommand("Emulation.setUserAgentOverride", {
          userAgent: spec.ua,
          platform: spec.platform,
          userAgentMetadata: userAgentMetadataFor(spec),
        });
        // navigator.maxTouchPoints / ontouchstart detection is part of how
        // pages decide "mobile" — without it mobile pages can still act desktop.
        await wc.debugger.sendCommand("Emulation.setTouchEmulationEnabled", {
          enabled: true,
          maxTouchPoints: 5,
        });
      }
    } catch (err) {
      log.warn(`browser UA override failed: ${live.id} ${err instanceof Error ? err.message : String(err)}`);
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
    if (live.uaDebuggerAttached) {
      try {
        live.view.webContents.debugger.detach();
      } catch {
        /* webContents already gone - ignore */
      }
      live.uaDebuggerAttached = false;
    }
    if (live.csDebuggerAttached) {
      try {
        live.view.webContents.debugger.detach();
      } catch {
        /* webContents already gone - ignore */
      }
      live.csDebuggerAttached = false;
    }
    try {
      live.view.webContents.close();
    } catch (err) {
      log.warn(`browser webContents close failed: ${id} ${err instanceof Error ? err.message : String(err)}`);
    }
    log.info(`browser closed: ${id}`);
    return { ok: true };
  }

  /** Clear the browser's HTTP cache + temporary site storage (localStorage,
   *  IndexedDB, service workers, cache storage, websql, filesystem). Cookies
   *  are intentionally NOT cleared, so the user stays signed in on the sites
   *  they've logged into. Operates on the shared browser partition session, not
   *  the app shell's default session. */
  async clearBrowserCache(): Promise<BrowserOpResult> {
    try {
      const ses = browserSession();
      await ses.clearCache();
      await ses.clearStorageData({
        storages: [
          "localstorage",
          "indexdb",
          "serviceworkers",
          "cachestorage",
          "websql",
          "filesystem",
        ],
      });
      log.info("browser cache cleared (HTTP cache + temporary site storage)");
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`browser clearCache failed: ${msg}`);
      return { ok: false, error: msg };
    }
  }

  /** Clear ALL cookies from the shared browser session (sign-out everywhere).
   *  The persisted cookie vault is wiped too — restoreCookieVault re-injects
   *  the snapshot before a new view's first navigation, so skipping that would
   *  silently undo the clear on the next spawn/restart. Complement of
   *  clearBrowserCache, which deliberately keeps cookies. */
  async clearBrowserCookies(): Promise<BrowserOpResult> {
    try {
      await browserSession().clearStorageData({ storages: ["cookies"] });
      SettingRepo.set(BROWSER_COOKIE_VAULT_ENC_SETTING_KEY, "");
      SettingRepo.set(BROWSER_COOKIE_VAULT_SETTING_KEY, "");
      log.info("browser cookies cleared (live session + persisted vault)");
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`browser clearCookies failed: ${msg}`);
      return { ok: false, error: msg };
    }
  }

  // ── Cookie vault (remember sign-in across restarts) ──
  // Electron ≤ 40 (Chromium ≤ 144) NEVER commits cookies to disk for
  // persistent partitions — even page-set persistent cookies ("remember me")
  // vanish on restart, and the on-disk Cookies DB stays empty (verified
  // empirically on Electron 33/34/36/38/40; works from 41 on). Chromium's own
  // store can therefore not be relied on: we snapshot ALL live cookies into
  // the settings table on a background timer and before quit, and re-inject
  // them into the session before its first navigation (restoreCookieVault).
  // The snapshot is safeStorage-encrypted when the OS credential store is
  // available (cookies are credentials); plaintext is the fallback where it
  // isn't, and the restore fallback for vaults written before encryption.
  // Gated by `browser.persistLogin` (default on). Once the app upgrades to
  // Electron ≥ 41 the native store works again; the vault simply keeps
  // shadowing it as a belt-and-braces copy.

  /** Snapshot the session's live cookies into the settings table. Runs on the
   *  background timer and from the app's before-quit hook. */
  async saveCookieVault(): Promise<{ ok: boolean; saved: number }> {
    if (!isPersistLoginEnabled()) return { ok: true, saved: 0 };
    const ses = browserSession();
    const cookies = await ses.cookies.get({});
    const vault: VaultCookie[] = cookies
      .filter((c): c is Cookie & { domain: string } => !!c.domain) // file:// cookies can't be expressed as a set() url
      .map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        hostOnly: c.hostOnly ?? false,
        path: c.path ?? "/",
        secure: c.secure ?? false,
        httpOnly: c.httpOnly ?? false,
        sameSite: c.sameSite,
        ...(c.session ? {} : { expirationDate: c.expirationDate }),
      }))
      .slice(0, COOKIE_VAULT_MAX);
    const plain = JSON.stringify(vault);
    // Cookies are credentials — store them via the OS credential store
    // (DPAPI/Keychain/keyring) when available; base64 ciphertext in the
    // settings table. Plaintext legacy key is the fallback where encryption
    // is unavailable (Linux without a keyring) and remains the restore
    // fallback for vaults written before the encrypted key existed.
    let encrypted = false;
    try {
      if (safeStorage.isEncryptionAvailable()) {
        SettingRepo.set(BROWSER_COOKIE_VAULT_ENC_SETTING_KEY, safeStorage.encryptString(plain).toString("base64"));
        encrypted = true;
        // Migration: once an encrypted copy exists, blank the plaintext one.
        if (SettingRepo.get(BROWSER_COOKIE_VAULT_SETTING_KEY)) {
          SettingRepo.set(BROWSER_COOKIE_VAULT_SETTING_KEY, "");
        }
      }
    } catch (err) {
      log.warn(
        `browser: cookie vault encryption failed (storing plaintext): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!encrypted) SettingRepo.set(BROWSER_COOKIE_VAULT_SETTING_KEY, plain);
    // Belt-and-braces for Electron ≥ 41, where the native store does commit.
    try {
      await ses.cookies.flushStore();
    } catch {
      /* native store best-effort only */
    }
    if (vault.length !== this.lastVaultSaved) {
      log.info(`browser: cookie vault saved (${vault.length} cookies)`);
      this.lastVaultSaved = vault.length;
    }
    return { ok: true, saved: vault.length };
  }

  /** Re-inject the vaulted cookies into `ses` (once per session instance).
   *  Session cookies restore as session cookies, expired entries are skipped,
   *  and SameSite is preserved on the first attempt (Electron rejects some
   *  attribute combos like "no_restriction" without secure — the retry drops
   *  just the SameSite attribute rather than the whole cookie). */
  private vaultRestored = new WeakSet<Session>();
  private lastVaultSaved = -1;

  private async restoreCookieVault(ses: Session): Promise<void> {
    if (this.vaultRestored.has(ses)) return;
    this.vaultRestored.add(ses);
    if (!isPersistLoginEnabled()) return;
    // Preferred source: safeStorage-encrypted vault. Decrypt failure (e.g.
    // the DB row was copied from another OS user) falls through to the legacy
    // plaintext key rather than losing all sign-in state.
    let raw: string | null = null;
    const enc = SettingRepo.get(BROWSER_COOKIE_VAULT_ENC_SETTING_KEY);
    if (enc && safeStorage.isEncryptionAvailable()) {
      try {
        raw = safeStorage.decryptString(Buffer.from(enc, "base64"));
      } catch (err) {
        log.warn(
          `browser: cookie vault decrypt failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (!raw) raw = SettingRepo.get(BROWSER_COOKIE_VAULT_SETTING_KEY);
    if (!raw) return;
    let vault: VaultCookie[];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      vault = parsed as VaultCookie[];
    } catch {
      log.warn("browser: cookie vault is corrupt, ignoring");
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    let restored = 0;
    for (const c of vault) {
      if (!c || typeof c.name !== "string" || typeof c.domain !== "string" || !c.domain) continue;
      if (typeof c.expirationDate === "number" && c.expirationDate <= now) continue;
      const host = c.domain.startsWith(".") ? c.domain.slice(1) : c.domain;
      const details: CookiesSetDetails = {
        url: `${c.secure ? "https" : "http"}://${host}${c.path || "/"}`,
        name: c.name,
        value: c.value,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
      };
      // hostOnly cookies must NOT pass domain — that would widen them to subdomains.
      if (!c.hostOnly) details.domain = c.domain;
      if (typeof c.expirationDate === "number") details.expirationDate = c.expirationDate;
      if (c.sameSite && c.sameSite !== "unspecified") {
        try {
          await ses.cookies.set({ ...details, sameSite: c.sameSite });
          restored++;
          continue;
        } catch {
          /* fall through to the no-SameSite retry */
        }
      }
      try {
        await ses.cookies.set(details);
        restored++;
      } catch (err) {
        log.warn(
          `browser: cookie vault restore failed for ${c.name}@${c.domain}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (restored > 0) log.info(`browser: cookie vault restored (${restored} cookies)`);
  }

  /** Start the background vault timer (once; unref'd so it never holds the
   *  process open). */
  private ensurePersistTimer(): void {
    if (this.persistTimer) return;
    this.persistTimer = setInterval(() => {
      void this.saveCookieVault().catch((err) => {
        log.warn(
          `browser: cookie vault save failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, PERSIST_LOGIN_INTERVAL_MS);
    this.persistTimer.unref?.();
  }

  // ── Download tracking ─────────────────────────────────────────────────
  // The embedded browser auto-downloads into a fixed folder (no save dialog —
  // that would block on UI the agent can't answer). Every download is tracked
  // here (recent 50), pushed to the renderer as a "download" browser:event on
  // start + terminal state, and listed for agents via the browser_downloads
  // tool (they then read the file with the normal file tools).

  /** Cap on remembered downloads; newest first. */
  private static readonly DOWNLOADS_MAX = 50;
  private readonly downloads: BrowserDownloadEntry[] = [];
  private downloadListenerInstalled = false;

  /** Hook the shared browser session's will-download ONCE. Registered lazily
   *  with the first spawned view (same pattern as the vault timer) because
   *  `app.getPath("downloads")` isn't guaranteed before app ready. */
  private installDownloadListener(): void {
    if (this.downloadListenerInstalled) return;
    this.downloadListenerInstalled = true;
    browserSession().on("will-download", (_event, item: DownloadItem, wc) => {
      const browserId = wc.isDestroyed() ? "" : (this.wcToBrowser.get(wc.id) ?? "");
      const dir = browserDownloadsDir();
      try {
        mkdirSync(dir, { recursive: true });
      } catch (err) {
        log.warn(
          `browser: download dir mkdir failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const path = uniqueDownloadPath(dir, item.getFilename());
      // Pre-allocate the save path: no dialog, deterministic location, name
      // deduped against existing files (-1, -2 … before the extension).
      item.setSavePath(path);
      const entry: BrowserDownloadEntry = {
        id: randomUUID(),
        browserId,
        url: item.getURL(),
        filename: item.getFilename(),
        path,
        state: "progressing",
        receivedBytes: 0,
        totalBytes: item.getTotalBytes(),
        startedAt: Date.now(),
      };
      this.downloads.unshift(entry);
      if (this.downloads.length > BrowserManagerImpl.DOWNLOADS_MAX) this.downloads.length = BrowserManagerImpl.DOWNLOADS_MAX;
      this.pushDownload(entry);
      log.info(`browser download started: ${entry.filename} → ${path}`);
      item.on("updated", (_e, state) => {
        entry.receivedBytes = item.getReceivedBytes();
        if (state === "interrupted") entry.state = "interrupted";
      });
      item.once("done", (_e, state) => {
        entry.state = state;
        entry.receivedBytes = item.getReceivedBytes();
        entry.endedAt = Date.now();
        this.pushDownload(entry);
        log.info(`browser download ${state}: ${entry.filename} (${entry.receivedBytes} bytes)`);
      });
    });
  }

  /** Push a download start/state-change to the renderer. browserId may be ""
   *  (download from a non-browser webContents on the shared session) — the
   *  renderer's browserId lookup just won't match a tab, which is fine. */
  private pushDownload(entry: BrowserDownloadEntry): void {
    sendToRenderer(IPC.BROWSER_EVENT, {
      channel: IPC.BROWSER_EVENT,
      browserId: entry.browserId,
      type: "download",
      payload: {
        downloadId: entry.id,
        filename: entry.filename,
        path: entry.path,
        url: entry.url,
        state: entry.state,
        receivedBytes: entry.receivedBytes,
        totalBytes: entry.totalBytes,
      },
    });
  }

  /** Recent downloads, newest first (a defensive copy — callers must not
   *  mutate the tracked entries). */
  listDownloads(): BrowserDownloadEntry[] {
    return this.downloads.map((d) => ({ ...d }));
  }

  /** Act on a tracked download from the panel's download bar. The renderer
   *  only ever passes the downloadId; the path is resolved HERE from the
   *  registry, so no renderer-supplied filesystem path is ever trusted.
   *  "open" (launch with the OS default app) is refused unless the download
   *  completed — opening a half-written or cancelled file is never useful. */
  downloadAction(downloadId: string, action: "open" | "reveal"): BrowserOpResult {
    const entry = this.downloads.find((d) => d.id === downloadId);
    if (!entry) return { ok: false, error: "下载记录不存在或已被清理" };
    try {
      if (action === "open") {
        if (entry.state !== "completed") {
          return { ok: false, error: "下载尚未完成,无法打开" };
        }
        void shell.openPath(entry.path).then((err) => {
          if (err) log.warn(`browser download openPath failed: ${entry.path} ${err}`);
        });
      } else {
        // Selects the item inside its folder (opens the folder when needed).
        shell.showItemInFolder(entry.path);
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ── HTTP Basic Auth ─────────────────────────────────────────────────

  /** Pending HTTP Basic Auth prompts: requestId -> Electron login callback.
   *  Filled by handleLogin(), drained by respondAuth(). */
  private readonly pendingAuths = new Map<
    string,
    { browserId: string; origin: string; callback: (u: string, p: string) => void }
  >();

  /** Route an Electron `app.on("login")` event. Only requests from the
   *  embedded browser's webContents are handled (others — e.g. the app shell
   *  itself — fall through, and the default no-handler behavior cancels).
   *  Pushes an "authRequest" event so the renderer shows a login dialog.
   *  Registered in main/index.ts. */
  handleLogin(
    webContentsId: number,
    url: string,
    authInfo: AuthInfo,
    callback: (username: string, password: string) => void,
  ): void {
    const browserId = this.wcToBrowser.get(webContentsId);
    if (!browserId) return; // not one of ours — leave to default behavior
    const origin = urlOrigin(url);
    if (!origin) {
      callback("", "");
      return;
    }
    const requestId = randomUUID();
    this.pendingAuths.set(requestId, { browserId, origin, callback });
    // Safety net: never leave a login callback hanging if the renderer never
    // answers (panel closed, window torn down) — cancel after 5 minutes.
    setTimeout(() => {
      const pending = this.pendingAuths.get(requestId);
      if (pending) {
        this.pendingAuths.delete(requestId);
        try {
          pending.callback("", "");
        } catch {
          /* webContents gone */
        }
      }
    }, 5 * 60 * 1000).unref?.();
    let host = origin;
    try {
      host = new URL(url).host;
    } catch {
      /* keep origin */
    }
    sendToRenderer(IPC.BROWSER_EVENT, {
      channel: IPC.BROWSER_EVENT,
      browserId,
      type: "authRequest",
      payload: { requestId, origin, host },
    });
  }

  /** Renderer's answer to an "authRequest" push. Empty username = cancel. */
  respondAuth(requestId: string, username: string, password: string): void {
    const pending = this.pendingAuths.get(requestId);
    if (!pending) return;
    this.pendingAuths.delete(requestId);
    try {
      pending.callback(username, password);
    } catch {
      /* webContents gone */
    }
  }

  // ── Agent-facing capabilities ───────────────────────────────────────
  // These power the `browser_*` tools registered with both providers. Unlike
  // the panel-facing methods above (which fire navigation and return
  // immediately), these are async because they await the page's response:
  // executeJavaScript resolves with the script's return value, capturePage
  // resolves with a NativeImage. Both are awaited so the agent gets real data.

  /** Notify the renderer that an agent tool opened/reused a browser view, so it
   *  can switch the right panel to the browser tab (making the view visible and
   *  letting BrowserPanel take over precise bounds syncing). Pushed as a
   *  `browser:event` with type "agentOpened". The optional `device` override
   *  tells the renderer which emulation preset the agent requested, so the
   *  adopted tab reflects it (e.g. mobile → phone-width column). */
  notifyAgentOpened(id: string, opts?: { device?: BrowserDevicePreset }): void {
    const live = this.get(id);
    if (!live) return;
    sendToRenderer(IPC.BROWSER_EVENT, {
      channel: IPC.BROWSER_EVENT,
      browserId: id,
      type: "agentOpened",
      payload: {
        url: live.view.webContents.getURL(),
        title: live.view.webContents.getTitle(),
        device: opts?.device ?? live.device,
      },
    });
  }

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

  /** Click the element matching a CSS selector.
   *
   *  Primary path is a REAL mouse event pair (mouseDown + mouseUp) dispatched
   *  at the element's viewport center: the injected ELEMENT_CENTER_SCRIPT
   *  scrolls it into view, computes the center, and checks what actually sits
   *  at that point. Going through Chromium's input pipeline means
   *  hover/mousedown-sensitive UI (dropdown menus, focus rings) behaves like a
   *  user click — the old `el.click()` path only fired a synthetic DOM click
   *  event and silently no-oped on such components. When the center point is
   *  covered by an overlay, the click still lands (that's what a human would
   *  hit) and `obscured` reports the covering element so the model can adapt
   *  (e.g. dismiss a cookie banner first).
   *
   *  Fallback to the programmatic `el.click()` script when the element has no
   *  layout box (hidden inputs) or script injection fails (strict CSP). */
  async click(id: string, selector: string): Promise<BrowserClickResult> {
    const live = this.get(id);
    if (!live) return { ok: false, error: "浏览器不存在或已关闭" };
    if (typeof selector !== "string" || selector.length === 0) {
      return { ok: false, error: "selector 不能为空" };
    }
    const wc = live.view.webContents;
    if (wc.isDestroyed()) return { ok: false, error: "浏览器已销毁" };

    // Real input needs the view on the visible surface — park it onscreen if
    // the user has another panel tab active (same trade-off as screenshot's
    // temp-show, minus the restore: the agent keeps browsing visibly).
    if (!live.visible) this.show(id);
    try {
      const center = (await wc.executeJavaScript(buildElementCenterScript(selector), true)) as {
        ok?: boolean;
        error?: string;
        fallback?: boolean;
        x?: number;
        y?: number;
        obscured?: { tag: string; text: string };
      };
      if (center && center.error) return { ok: false, error: center.error };
      if (center && center.ok && typeof center.x === "number" && typeof center.y === "number") {
        wc.focus();
        const base = { x: center.x, y: center.y, button: "left" as const, clickCount: 1 };
        wc.sendInputEvent({ type: "mouseDown", ...base });
        wc.sendInputEvent({ type: "mouseUp", ...base });
        // Give page handlers/navigation a beat to react before we report state.
        await new Promise((r) => setTimeout(r, 250));
        return { ok: true, url: wc.getURL(), title: wc.getTitle(), obscured: center.obscured ?? undefined };
      }
      // center.fallback (no layout box) or a thrown/injected-script failure →
      // fall through to the programmatic click below.
    } catch {
      /* CSP-strict pages can reject executeJavaScript — fall back below */
    }

    try {
      const script = buildClickScript(selector);
      const res = (await wc.executeJavaScript(script, true)) as {
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

  /** Click at raw viewport coordinates (CSS px, same space as
   *  getBoundingClientRect). The escape hatch for canvas maps / clickable divs
   *  that no CSS selector can address. */
  async clickAt(id: string, x: number, y: number): Promise<BrowserClickResult> {
    const live = this.get(id);
    if (!live) return { ok: false, error: "浏览器不存在或已关闭" };
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) {
      return { ok: false, error: `坐标无效: (${x}, ${y})` };
    }
    const wc = live.view.webContents;
    if (wc.isDestroyed()) return { ok: false, error: "浏览器已销毁" };
    if (!live.visible) this.show(id);
    wc.focus();
    const base = { x: Math.round(x), y: Math.round(y), button: "left" as const, clickCount: 1 };
    wc.sendInputEvent({ type: "mouseDown", ...base });
    wc.sendInputEvent({ type: "mouseUp", ...base });
    await new Promise((r) => setTimeout(r, 250));
    return { ok: true, url: wc.getURL(), title: wc.getTitle() };
  }

  /** Type text into an element (input / textarea / contenteditable) selected by
   *  CSS selector. Uses the element's native value setter + dispatches
   *  input/change events so React/Vue controlled inputs pick the value up (a
   *  plain `el.value = text` assignment silently no-ops on them). `clear=false`
   *  appends to the current value instead of replacing it. The element ends up
   *  focused, so a follow-up `sendKeys({keys:"Enter"})` acts on it. Returns
   *  post-action url/title like click(). The script (buildTypeScript)
   *  JSON-encodes selector/text/clear, so none of them can break out. */
  async type(id: string, selector: string, text: string, clear = true): Promise<BrowserClickResult> {
    const live = this.get(id);
    if (!live) return { ok: false, error: "浏览器不存在或已关闭" };
    if (typeof selector !== "string" || selector.length === 0) {
      return { ok: false, error: "selector 不能为空" };
    }
    if (typeof text !== "string") {
      return { ok: false, error: "text 必须是字符串" };
    }
    try {
      const script = buildTypeScript(selector, text, clear);
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
      log.warn(`browser type failed: ${id} ${msg}`);
      return { ok: false, error: `输入失败: ${msg}` };
    }
  }

  /** Evaluate arbitrary JS in the page's main world via `new Function(code)()`.
   *  This lets the agent modify the page DOM directly (text, styles,
   *  attributes, events). The script runs with the page's own permissions —
   *  no Node/Electron access (contextIsolation is on). Returns a serialized
   *  view of the script's return value so the caller can verify its changes.
   *  The script is JSON-encoded (buildEvaluateScript), so the code's quotes /
   *  backslashes / newlines can't break the injected script's syntax. */
  async evaluate(id: string, code: string): Promise<BrowserEvaluateResult> {
    const live = this.get(id);
    if (!live) return { ok: false, error: "浏览器不存在或已关闭" };
    if (typeof code !== "string" || code.length === 0) {
      return { ok: false, error: "script 不能为空" };
    }
    try {
      const script = buildEvaluateScript(code);
      const res = (await live.view.webContents.executeJavaScript(script, true)) as {
        ok?: boolean;
        error?: string;
        url?: string;
        title?: string;
        result?: string;
      };
      if (res && res.error) return { ok: false, error: res.error };
      return { ok: true, url: res?.url, title: res?.title, result: res?.result };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`browser evaluate failed: ${id} ${msg}`);
      return { ok: false, error: `脚本执行失败: ${msg}` };
    }
  }

  /** Scroll the page window (or a specific element's scrollable box) by a
   *  fraction of the viewport height. Returns the resulting scroll position so
   *  the agent knows where it landed and whether more content remains. */
  async scroll(
    id: string,
    direction: "up" | "down",
    pages: number,
    selector?: string,
  ): Promise<BrowserScrollResult> {
    const live = this.get(id);
    if (!live) return { ok: false, error: "浏览器不存在或已关闭" };
    try {
      const script = buildScrollScript({ selector: selector || undefined, direction, pages });
      const res = (await live.view.webContents.executeJavaScript(script, true)) as {
        ok?: boolean;
        error?: string;
        scrollY?: number;
        scrollHeight?: number;
        viewport?: number;
        url?: string;
        title?: string;
      };
      if (res && res.error) return { ok: false, error: res.error };
      return {
        ok: true,
        scrollY: res?.scrollY,
        scrollHeight: res?.scrollHeight,
        viewport: res?.viewport,
        url: res?.url,
        title: res?.title,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`browser scroll failed: ${id} ${msg}`);
      return { ok: false, error: `滚动失败: ${msg}` };
    }
  }

  /** Press a key or shortcut combo (e.g. "Enter", "Escape", "Control+a") via
   *  `sendInputEvent` — goes through Chromium's real input pipeline, so form
   *  default submissions (Enter), focus movement (Tab) and page keyboard
   *  shortcuts all behave like a user pressing the key. The currently focused
   *  element receives the event. NOT for entering text — use type() for that. */
  async sendKeys(id: string, keys: string): Promise<BrowserClickResult> {
    const live = this.get(id);
    if (!live) return { ok: false, error: "浏览器不存在或已关闭" };
    if (typeof keys !== "string" || !keys.trim()) return { ok: false, error: "keys 不能为空" };
    const parsed = parseKeyCombo(keys);
    if ("error" in parsed) return { ok: false, error: parsed.error };
    const wc = live.view.webContents;
    if (wc.isDestroyed()) return { ok: false, error: "浏览器已销毁" };
    try {
      wc.focus();
      const mods = parsed.modifiers.length ? parsed.modifiers : undefined;
      wc.sendInputEvent({ type: "keyDown", keyCode: parsed.key, modifiers: mods });
      wc.sendInputEvent({ type: "keyUp", keyCode: parsed.key, modifiers: mods });
    } catch (err) {
      return { ok: false, error: `按键失败: ${err instanceof Error ? err.message : String(err)}` };
    }
    await new Promise((r) => setTimeout(r, 200));
    return { ok: true, url: wc.getURL(), title: wc.getTitle() };
  }

  /** Navigate history: back / forward / reload, then wait for the page to
   *  settle so a subsequent snapshot sees the new content. Mirrors the panel's
   *  own toolbar buttons (goBack/goForward/reload), exposed to agents. */
  async historyAction(id: string, action: "back" | "forward" | "reload"): Promise<BrowserClickResult> {
    const live = this.get(id);
    if (!live) return { ok: false, error: "浏览器不存在或已关闭" };
    const wc = live.view.webContents;
    if (wc.isDestroyed()) return { ok: false, error: "浏览器已销毁" };
    const nav = wc.navigationHistory;
    try {
      if (action === "back") {
        if (!nav.canGoBack()) return { ok: false, error: "没有可后退的历史记录" };
        nav.goBack();
      } else if (action === "forward") {
        if (!nav.canGoForward()) return { ok: false, error: "没有可前进的历史记录" };
        nav.goForward();
      } else {
        wc.reload();
      }
    } catch (err) {
      return { ok: false, error: `导航失败: ${err instanceof Error ? err.message : String(err)}` };
    }
    const loaded = await this.waitForLoad(id);
    if (!loaded.ok) return { ok: false, error: loaded.error };
    return { ok: true, url: loaded.url ?? wc.getURL(), title: loaded.title ?? wc.getTitle() };
  }

  /** Select an option in a native <select> dropdown by value or exact visible
   *  text. On no match, returns the option list so the agent can retry with an
   *  exact spelling. Custom (div-based) dropdown widgets are rejected with a
   *  hint to click them open instead. */
  async selectOption(id: string, selector: string, value: string): Promise<BrowserSelectResult> {
    const live = this.get(id);
    if (!live) return { ok: false, error: "浏览器不存在或已关闭" };
    if (typeof selector !== "string" || selector.length === 0) {
      return { ok: false, error: "selector 不能为空" };
    }
    try {
      const script = buildSelectScript(selector, value);
      const res = (await live.view.webContents.executeJavaScript(script, true)) as {
        ok?: boolean;
        error?: string;
        options?: Array<{ value: string; text: string; selected?: boolean }>;
        selected?: { value: string; text: string };
        url?: string;
        title?: string;
      };
      if (res && res.error) {
        return { ok: false, error: res.error, options: res.options, url: res?.url, title: res?.title };
      }
      return {
        ok: true,
        selected: res?.selected,
        url: res?.url,
        title: res?.title,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`browser select failed: ${id} ${msg}`);
      return { ok: false, error: `下拉选择失败: ${msg}` };
    }
  }

  /** Poll a wait condition (element presence / text presence) until it holds
   *  or the timeout expires. Polling (instead of one injected script with a
   *  busy loop) keeps the page responsive and survives navigations mid-wait —
   *  a throwing poll (navigation aborted the script) just retries. */
  async waitFor(
    id: string,
    arg: { selector?: string; text?: string },
    timeoutMs: number,
  ): Promise<BrowserWaitResult> {
    const live = this.get(id);
    if (!live) return { ok: false, error: "浏览器不存在或已关闭" };
    const wc = live.view.webContents;
    if (wc.isDestroyed()) return { ok: false, error: "浏览器已销毁" };
    const script = buildWaitScript(arg);
    const start = Date.now();
    const intervalMs = 300;
    let lastReason = "";
    for (;;) {
      if (wc.isDestroyed()) return { ok: false, error: "浏览器已销毁" };
      try {
        const res = (await wc.executeJavaScript(script, true)) as {
          found?: boolean;
          error?: string;
          reason?: string;
          url?: string;
          title?: string;
        };
        if (res?.error) return { ok: false, error: res.error };
        if (res?.found) {
          return { ok: true, found: true, elapsedMs: Date.now() - start, url: res.url, title: res.title };
        }
        lastReason = res?.reason ?? lastReason;
      } catch {
        /* navigation aborted the evaluation — keep polling until timeout */
      }
      if (Date.now() - start >= timeoutMs) {
        return {
          ok: true,
          found: false,
          elapsedMs: Date.now() - start,
          url: wc.getURL(),
          title: wc.getTitle(),
          error: lastReason || undefined,
        };
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  /** Find elements by CSS selector (with attribute extraction) or search the
   *  page text (literal/regex, with context snippets). The cheap alternative
   *  to dumping raw HTML through evaluate(). */
  async find(
    id: string,
    arg: {
      selector?: string;
      text?: string;
      regex?: boolean;
      caseSensitive?: boolean;
      contextChars?: number;
      maxResults?: number;
      attributes?: string[];
      cssScope?: string;
    },
  ): Promise<BrowserFindResult> {
    const live = this.get(id);
    if (!live) return { ok: false, error: "浏览器不存在或已关闭" };
    try {
      const script = buildFindScript(arg);
      const res = (await live.view.webContents.executeJavaScript(script, true)) as {
        ok?: boolean;
        error?: string;
        total?: number;
        matches?: BrowserFindResult["matches"];
        url?: string;
        title?: string;
      };
      if (res && res.error) return { ok: false, error: res.error };
      return {
        ok: true,
        total: res?.total,
        matches: res?.matches ?? [],
        url: res?.url,
        title: res?.title,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`browser find failed: ${id} ${msg}`);
      return { ok: false, error: `查找失败: ${msg}` };
    }
  }

  /** Capture the current page as a PNG screenshot. `capturePage()` renders the
   *  view's current composite — if the page is mid-navigation the result may be
   *  blank, so callers should snapshot/click after navigation settles. Retries
   *  once after a short delay if the first capture throws (the renderer/GPU
   *  process can be momentarily unavailable right after view creation).
   *  If the view is currently hidden (user switched the right panel away from
   *  the browser tab), it is temporarily shown for the capture, then hidden
   *  again so it doesn't linger over the workspace.
   *
   *  Device-emulation note: when a mobile preset is active (enableDeviceEmulation
   *  sized the page to e.g. 390×844), capturePage() returns BLACK frames unless
   *  the view's physical bounds match the emulated viewport. The renderer
   *  normally keeps them in sync, but at capture time the view may be hidden
   *  (offscreen) or its bounds may not have been synced yet (agent navigate →
   *  immediate screenshot races the renderer's rAF sync). So when emulation is
   *  active we temporarily size the view to the emulated rect (centered), wait
   *  a frame, capture, then restore — exactly like the default temp-show below,
   *  but with matching dimensions. */
  async screenshot(id: string, opts?: { fullPage?: boolean }): Promise<BrowserScreenshotResult> {
    const live = this.get(id);
    if (!live) return { ok: false, error: "浏览器不存在或已关闭" };
    const wc = live.view.webContents;
    if (wc.isDestroyed()) return { ok: false, error: "浏览器已销毁" };
    log.info(`browser screenshot start: ${id} url=${wc.getURL()} visible=${live.visible} isLoading=${wc.isLoading()} fullPage=${opts?.fullPage === true}`);

    // Full-page capture goes through the CDP debugger: it renders the whole
    // scrollable document without touching visibility/bounds and works on a
    // hidden view. On failure (debugger slot held by DevTools, protocol error)
    // degrade to the plain viewport capture rather than failing the tool.
    if (opts?.fullPage) {
      const full = await this.captureFullPage(id);
      if (full !== null) {
        return { ok: true, data: full, mimeType: "image/png" };
      }
      log.warn(`browser full-page capture unavailable, falling back to viewport: ${id}`);
    }

    // If the view is offscreen/hidden (user switched panels, or it was never
    // measured), temporarily bring it on-screen so capturePage gets real pixels.
    // capturePage on a hidden/1x1 view returns an empty 0-byte image. The brief
    // on-screen flash is the known trade-off: offscreen capture either yields
    // incomplete output (wrong viewport size) or changes the page layout
    // (resizing to scrollHeight triggers reflow), so we prioritize capture
    // correctness over avoiding the flash.
    const needsTempShow = !live.visible || live.lastBounds.width <= 1;
    const savedVisible = live.visible;
    const savedBounds = live.lastBounds;
    // Device emulation active: the capture rect must match the emulated
    // viewport (see the note above). Compute it from the stored viewport;
    // null when desktop (no emulation) — then defaultOnscreenBounds applies.
    const emuRect = this.emulationCaptureRect(live);
    const boundsMatchEmu =
      emuRect != null &&
      Math.abs(live.lastBounds.width - emuRect.width) <= 2 &&
      Math.abs(live.lastBounds.height - emuRect.height) <= 2;
    const tempShown = needsTempShow || (emuRect != null && !boundsMatchEmu);
    if (tempShown) {
      const b = emuRect ?? defaultOnscreenBounds();
      live.view.setBounds(b);
      live.lastBounds = b;
      live.visible = true;
      // Give the compositor a frame to paint before capturing.
      await new Promise((r) => setTimeout(r, 100));
    }

    const capture = async (): Promise<{ pngBuf: Buffer; data: string } | { error: string }> => {
      try {
        const image = await wc.capturePage();
        const pngBuf = image.toPNG();
        return { pngBuf, data: pngBuf.toString("base64") };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    };

    let result = await capture();
    // Retry once after a brief wait if capture threw (common right after view
    // creation, before the compositor is ready) or produced an empty image.
    if ("error" in result || ("data" in result && result.data.length === 0)) {
      const firstError = "error" in result ? result.error : "(empty image)";
      log.info(`browser screenshot retrying after: ${firstError}`);
      await new Promise((r) => setTimeout(r, 500));
      result = await capture();
    }

    // Restore the hidden/offscreen state if we temporarily showed/resized the
    // view. Bounds changes during capture are reverted so the renderer's next
    // syncBounds (or the user's next show) isn't fighting a stale rect.
    if (tempShown) {
      if (savedVisible) {
        live.view.setBounds(savedBounds);
      } else {
        // Keep offscreen but preserve dimensions (consistent with hide()).
        live.view.setBounds({ x: -9999, y: -9999, width: savedBounds.width, height: savedBounds.height });
      }
      live.lastBounds = savedBounds;
      live.visible = savedVisible;
    }

    if ("error" in result) {
      log.warn(`browser screenshot failed: ${id} ${result.error}`);
      return { ok: false, error: `截图失败: ${result.error}` };
    }

    log.info(`browser screenshot done: ${id} pngBytes=${result.pngBuf.length} base64Len=${result.data.length}`);
    if (result.data.length === 0) {
      log.warn(`browser screenshot produced EMPTY image after retry: ${id} url=${wc.getURL()}`);
    }
    return { ok: true, data: result.data, mimeType: "image/png" };
  }

  /** Run `fn` with the CDP debugger attached to the view, normalizing the
   *  single-slot discipline in one place: Electron's debugger is a single slot
   *  per webContents — attach() throws when one of OUR sessions (mobile UA
   *  override / color-scheme pin) already holds it, then we simply reuse that
   *  session and do NOT detach at the end; only a slot THIS call attached is
   *  released. A slot held by real DevTools makes sendCommand fail, which
   *  surfaces as `{ ok:false }` (callers degrade). */
  private async withDebugger<T>(
    id: string,
    fn: (dbg: Debugger) => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
    const live = this.get(id);
    if (!live) return { ok: false, error: "浏览器不存在或已关闭" };
    const wc = live.view.webContents;
    if (wc.isDestroyed()) return { ok: false, error: "浏览器已销毁" };
    let attachedHere = false;
    try {
      wc.debugger.attach("1.3");
      attachedHere = true;
    } catch {
      /* already attached — ours (UA/color-scheme) or DevTools; try the command */
    }
    try {
      return { ok: true, value: await fn(wc.debugger) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`browser CDP command failed: ${id} ${msg}`);
      return { ok: false, error: msg };
    } finally {
      if (attachedHere) {
        try {
          wc.debugger.detach();
        } catch {
          /* view tearing down — ignore */
        }
      }
    }
  }

  /** Full-page capture via the CDP debugger: Page.captureScreenshot with
   *  captureBeyondViewport renders the entire scrollable document without
   *  resizing the view or touching visibility (works offscreen — unlike
   *  capturePage, which needs the view composited). Returns null on failure;
   *  the caller degrades to the viewport capture. */
  private async captureFullPage(id: string): Promise<string | null> {
    const res = await this.withDebugger<{ data?: string }>(id, (dbg) =>
      dbg.sendCommand("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
      }) as Promise<{ data?: string }>,
    );
    const data = res.ok ? res.value?.data : undefined;
    return typeof data === "string" && data.length > 0 ? data : null;
  }

  /** Render the page to PDF via Electron's own printing-stack API
   *  (`webContents.printToPDF`), returning the PDF bytes base64-encoded for
   *  the caller to persist.
   *
   *  ⚠️ NOT the CDP `Page.printToPDF`: that DevTools method only exists in
   *  headless Chromium — headed Electron never registers it, so
   *  `debugger.sendCommand("Page.printToPDF")` fails with -32601
   *  "'Page.printToPDF' wasn't found" on EVERY page (page-independent). The
   *  native API renders through the same pipeline as silent Ctrl+P, works
   *  offscreen, and needs no debugger slot at all.
   *
   *  `paperFormat` maps to Electron's named page sizes (A0-A6/Legal/Letter/
   *  Tabloid/Ledger); `landscape` flips the orientation; margins stay at the
   *  printer default (custom margins are in PIXELS in this Electron — easy to
   *  get wrong, and the default looks right). */
  async printToPdf(
    id: string,
    opts: {
      paperFormat?: string;
      landscape?: boolean;
      printBackground?: boolean;
      scale?: number;
      headerFooter?: boolean;
    },
  ): Promise<BrowserPdfResult> {
    const live = this.get(id);
    if (!live) return { ok: false, error: "浏览器不存在或已关闭" };
    const wc = live.view.webContents;
    if (wc.isDestroyed()) return { ok: false, error: "浏览器已销毁" };
    const format = (opts.paperFormat ?? "a4").toLowerCase();
    // Our lowercase tool enum → Electron's named page sizes (see
    // PrintToPDFOptions.pageSize). The old CDP inch table is gone with it.
    const PAGE_SIZE_NAMES: Record<string, "Letter" | "Legal" | "Tabloid" | "A3" | "A4" | "A5"> = {
      letter: "Letter",
      legal: "Legal",
      tabloid: "Tabloid",
      a3: "A3",
      a4: "A4",
      a5: "A5",
    };
    const pageSize = PAGE_SIZE_NAMES[format];
    if (!pageSize) {
      return { ok: false, error: `不支持的纸张格式 "${opts.paperFormat}"(可选 letter/legal/tabloid/a3/a4/a5)` };
    }
    const scale =
      typeof opts.scale === "number" && Number.isFinite(opts.scale) ? Math.min(Math.max(opts.scale, 0.1), 2) : 1;
    // Header/footer values render INVISIBLY unless the template sets an
    // explicit font-size (Chromium's documented gotcha) — so the flag comes
    // with default Chrome-style templates (date up top, url + page numbers
    // below). Empty templates + displayHeaderFooter would print nothing.
    const headerFooter = opts.headerFooter === true;
    try {
      const buf = await wc.printToPDF({
        landscape: opts.landscape === true,
        printBackground: opts.printBackground !== false,
        scale,
        pageSize,
        displayHeaderFooter: headerFooter,
        ...(headerFooter
          ? {
              headerTemplate:
                '<span class="date" style="font-size:8px; margin-right:0.4in;"></span>' +
                '<span class="title" style="font-size:8px; margin-left:0.4in;"></span>',
              footerTemplate:
                '<span class="url" style="font-size:8px; margin-right:0.4in;"></span>' +
                '<span class="pageNumber" style="font-size:8px;"></span>' +
                '<span style="font-size:8px;">/</span>' +
                '<span class="totalPages" style="font-size:8px;"></span>',
            }
          : {}),
      });
      const data = buf.length > 0 ? buf.toString("base64") : "";
      if (!data) {
        return { ok: false, error: "PDF 生成失败(空输出)" };
      }
      return { ok: true, data };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`browser printToPdf failed: ${id} ${msg}`);
      return { ok: false, error: `PDF 生成失败: ${msg}` };
    }
  }

  /** Set files on an `<input type="file">` via CDP DOM.setFileInputFiles —
   *  the same mechanism Playwright's setInputFiles uses: Chromium acts as if
   *  the user picked the files, so input/change events fire natively and
   *  React/Vue state updates. No file content crosses the boundary (paths
   *  only), so large uploads don't round-trip through executeJavaScript. The
   *  pre-check script gives a friendly error when the selector misses a file
   *  input; the CDP path is skipped entirely in that case. */
  async setFileInputFiles(
    id: string,
    selector: string,
    paths: string[],
  ): Promise<BrowserClickResult> {
    const live = this.get(id);
    if (!live) return { ok: false, error: "浏览器不存在或已关闭" };
    const wc = live.view.webContents;
    if (wc.isDestroyed()) return { ok: false, error: "浏览器已销毁" };
    if (typeof selector !== "string" || selector.length === 0) {
      return { ok: false, error: "selector 不能为空" };
    }
    if (!paths.length) return { ok: false, error: "paths 不能为空" };
    for (const p of paths) {
      try {
        if (!statSync(p).isFile()) return { ok: false, error: `不是文件: ${p}` };
      } catch {
        return { ok: false, error: `文件不存在: ${p}` };
      }
    }
    // Friendly pre-check (also validates the selector in page terms — CDP's
    // DOM.querySelector failure message is cryptic about which side failed).
    try {
      const check = (await wc.executeJavaScript(buildCheckFileInputScript(selector), true)) as {
        ok?: boolean;
        error?: string;
      };
      if (check?.error) return { ok: false, error: check.error };
    } catch {
      /* CSP-strict page — fall through and let CDP surface its own error */
    }
    const res = await this.withDebugger<unknown>(id, async (dbg) => {
      // depth:0 returns just the root handle (skip serializing the whole
      // subtree on big pages) — DOM.querySelector still searches the live
      // document regardless of the returned depth.
      const doc = (await dbg.sendCommand("DOM.getDocument", { depth: 0 })) as {
        root?: { nodeId?: number };
      };
      const root = doc?.root?.nodeId;
      if (!root) throw new Error("DOM.getDocument 未返回根节点");
      const q = (await dbg.sendCommand("DOM.querySelector", { nodeId: root, selector })) as {
        nodeId?: number;
      };
      if (!q?.nodeId) throw new Error(`element not found for selector: ${selector}`);
      await dbg.sendCommand("DOM.setFileInputFiles", { files: paths, nodeId: q.nodeId });
      return true;
    });
    if (!res.ok) {
      if (/element not found/.test(res.error)) return { ok: false, error: res.error };
      return { ok: false, error: `设置文件失败: ${res.error}` };
    }
    await new Promise((r) => setTimeout(r, 200));
    return { ok: true, url: wc.getURL(), title: wc.getTitle() };
  }

  /** Capture the current page as a single base64 PNG frame WITHOUT touching
   *  visibility. Powers the renderer's frozen-frame placeholder: toolbar
   *  menus (history / device) float over this snapshot while the real view
   *  parks offscreen, so the page stays visually present instead of blanking
   *  to a white stage. Callers capture while the view is onscreen (panel
   *  active) — unlike screenshot() there is no temp-show/restore and no
   *  emulation rect dance. An empty frame (capture raced a navigation, or
   *  the compositor isn't ready yet) retries once, then reports ok:false so
   *  the renderer degrades to the plain hide. The frame lives entirely in
   *  memory (IPC → <img>) and is never persisted. */
  async captureFrame(
    id: string,
  ): Promise<{ ok: boolean; data?: string; mimeType?: "image/png"; error?: string }> {
    const live = this.get(id);
    if (!live) return { ok: false, error: "浏览器不存在或已关闭" };
    const wc = live.view.webContents;
    if (wc.isDestroyed()) return { ok: false, error: "浏览器已销毁" };
    const capture = async (): Promise<string | null> => {
      try {
        const image = await wc.capturePage();
        const png = image.toPNG();
        return png.length > 0 ? png.toString("base64") : null;
      } catch {
        return null;
      }
    };
    let data = await capture();
    if (data === null) {
      // The compositor can be momentarily unavailable right after
      // create/navigate — one short retry before giving up.
      await new Promise((r) => setTimeout(r, 150));
      data = await capture();
    }
    if (data === null) {
      log.warn(`browser captureFrame produced no image: ${id} url=${wc.getURL()}`);
      return { ok: false, error: "截图失败" };
    }
    return { ok: true, data, mimeType: "image/png" };
  }

  /** The on-screen rect that matches the view's current device-emulation
   *  viewport (centered in the main window), or null for desktop (no
   *  emulation). capturePage() needs the view's physical bounds to equal the
   *  emulated screen size (e.g. 390×844 @3x) or it returns black frames, so
   *  screenshot() sizes the view to this rect before capturing. Uses the
   *  EFFECTIVE viewport size (may have been overridden by the renderer to
   *  match a narrow sidebar column), falling back to the preset/custom dims. */
  private emulationCaptureRect(live: LiveBrowser): Rectangle | null {
    const vp = live.viewport;
    if (!vp || vp.device === "desktop") return null;
    const w = vp.effWidth;
    const h = vp.effHeight;
    if (typeof w !== "number" || typeof h !== "number") return null;
    const win = getMainWindow();
    if (!win || win.isDestroyed()) {
      return { x: 80, y: 80, width: w, height: h };
    }
    const [winW, winH] = win.getContentSize();
    return {
      x: Math.max(0, Math.round((winW - w) / 2)),
      y: Math.max(0, Math.round((winH - h) / 2)),
      width: w,
      height: h,
    };
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
