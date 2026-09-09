import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { cn } from "@renderer/lib/cn.js";
import { api } from "@renderer/lib/api.js";
import {
  setBrowserStageRect,
  shouldSuppressBrowserView,
  subscribeOcclusion,
  getOcclusionVersion,
} from "@renderer/lib/browserOcclusion.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import type { BrowserTab } from "@renderer/stores/sessionStore.js";
import { localPathToFileUrl } from "@renderer/lib/browserUrl.js";
import {
  resolveBrowserDeviceSpec,
  BROWSER_ADDRESS_HISTORY_SETTING_KEY,
  BROWSER_BOOKMARKS_SETTING_KEY,
  type PickedElement,
  type BrowserDevicePreset,
  type BrowserOrientation,
  type BrowserBookmarkEntry,
  type BrowserHistoryEntry,
  type BrowserAuthRequest,
  type BrowserDownloadProgress,
} from "@contracts/ipc";
import { BrowserToolbar } from "./BrowserToolbar.js";
import { DeviceToolbar } from "./DeviceToolbar.js";
import { BrowserTabs, type BrowserTabDisplay } from "./BrowserTabs.js";
import { PickedElementsBar } from "./PickedElementsBar.js";
import { DownloadBar, type DownloadBarItem } from "./DownloadBar.js";
import { AuthPromptDialog } from "./AuthPromptDialog.js";
import { useI18n } from "@renderer/lib/i18n/index.js";

/**
 * Browser panel — multi-tab, shared between two containers.
 *
 * - `mode="overlay"`: a full-workspace overlay (below the 40px titlebar) — the
 *   PC-fullscreen experience. Picked elements stage in a bottom bar and only
 *   enter the composer when the user clicks "添加".
 * - `mode="sidebar"`: embedded inside the right IDE panel. New tabs default to
 *   the desktop preset (no emulation — the page fills the panel like a normal
 *   browser window; the device toolbar offers phone/tablet emulation), and
 *   picked elements go straight to the composer.
 *
 * Tabs live in the session store (`browserTabs` / `browserActiveTabId`) so they
 * survive a container swap: switching modes unmounts one container (hiding the
 * active view) and mounts the other (re-showing it + re-syncing bounds). The
 * actual web pages are rendered by main-process WebContentsViews that float
 * ABOVE the renderer at OS level - one view per tab. The placeholder div
 * (`stageRef`) is just a measurement target whose getBoundingClientRect()
 * drives `api.browser.setBounds` for the active tab's view; background tabs'
 * views stay parked offscreen.
 *
 * The main process (BrowserManager) already supports N concurrent views keyed
 * by browserId - every navigation/loading/pickResult event carries the
 * browserId so this component can route updates to the owning tab.
 */

/** Display mode for this container. */
export type BrowserMode = "overlay" | "sidebar";

export interface BrowserPanelProps {
  mode: BrowserMode;
}

/** Emulated viewport dims for a tab, honoring orientation (landscape swaps
 *  width/height) and custom width/height. Returns null for desktop (no
 *  emulation — the view fills the stage). Used by syncBounds to narrow the
 *  view to a device-sized column centered in the stage (both overlay and
 *  sidebar modes). */
function tabViewportDims(tab: BrowserTab): { width: number; height: number } | null {
  if (tab.device === "desktop") return null;
  const spec = resolveBrowserDeviceSpec(tab.device, {
    width: tab.customWidth,
    height: tab.customHeight,
  });
  const landscape = tab.orientation === "landscape";
  return {
    width: landscape ? spec.height : spec.width,
    height: landscape ? spec.width : spec.height,
  };
}

/** Generate a renderer-local tab id (distinct from the main-process browserId). */
function newTabId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `t-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

export function BrowserPanel({ mode }: BrowserPanelProps) {
  const { t } = useI18n();
  // Layout / mode state from the store.
  const open = useSessionStore((s) => s.browserPanelOpen);
  const setOpen = useSessionStore((s) => s.setBrowserPanelOpen);
  const setRightPanelTab = useSessionStore((s) => s.setRightPanelTab);
  const setRightOpen = useSessionStore((s) => s.setRightOpen);
  const activeProjectId = useSessionStore((s) => s.activeProjectId);
  const projects = useSessionStore((s) => s.projects);
  const enqueueChatElement = useSessionStore((s) => s.enqueueChatElement);
  const setBrowserTabCount = useSessionStore((s) => s.setBrowserTabCount);
  // Device-toolbar visibility (DevTools-style row under the address bar).
  const deviceToolbarOpen = useSessionStore((s) => s.browserDeviceToolbarOpen);
  const setDeviceToolbarOpen = useSessionStore((s) => s.setBrowserDeviceToolbarOpen);
  // Suppression counter: while > 0 a renderer-DOM overlay (image lightbox,
  // etc.) needs to cover the OS-level view, so we hide it. See the effect below.
  const suppressed = useSessionStore((s) => s.browserViewSuppressed);
  // Shared tabs state (lifted to the store so both containers see the same list).
  const tabs = useSessionStore((s) => s.browserTabs);
  const activeTabId = useSessionStore((s) => s.browserActiveTabId);
  const setTabs = useSessionStore((s) => s.setBrowserTabs);
  const setActiveTabId = useSessionStore((s) => s.setBrowserActiveTabId);
  const addTab = useSessionStore((s) => s.addBrowserTab);
  const removeTab = useSessionStore((s) => s.removeBrowserTab);
  const patchTabInStore = useSessionStore((s) => s.patchBrowserTab);

  /** Pending HTTP Basic Auth request pushed by main ("authRequest" event).
   *  Non-null shows the login dialog (view hidden while it's up). */
  const [authRequest, setAuthRequest] = useState<BrowserAuthRequest | null>(null);
  /** Frozen-frame placeholder while a toolbar menu (history / device) is open
   *  over the stage: a base64 PNG of the page captured right before the real
   *  view parks offscreen, pinned to the stage at the view's exact rect. The
   *  menu floats over this snapshot as plain DOM instead of blanking the
   *  panel to white — nothing reflows, the page just freezes for the menu's
   *  lifetime. Purely in-memory (IPC → <img>), dropped when the menu closes. */
  const [freezeFrame, setFreezeFrame] = useState<{
    browserId: string;
    data: string;
    rect: { left: number; top: number; width: number; height: number } | null;
  } | null>(null);
  /** Address-bar history, read from settings (main is the single writer). */
  const [history, setHistory] = useState<BrowserHistoryEntry[]>([]);
  /** Bookmarked pages for the More menu, read from settings (main is the
   *  single writer via browser.bookmarkAdd / bookmarkRemove). */
  const [bookmarks, setBookmarks] = useState<BrowserBookmarkEntry[]>([]);
  /** Error message shown in the stage when tab creation fails (e.g. no active
   *  project). Renders in the placeholder div so it isn't covered by a view. */
  const [error, setError] = useState<string | null>(null);

  /** Ephemeral confirmation card when an element is picked (shows what was
   *  captured + staged in the bar below). */
  const [pickFlash, setPickFlash] = useState(0);
  /** Picked elements shown in the bottom picked-elements bar (overlay mode only
   *  - visual feedback during the staged-add flow; the elements are also
   *  enqueued to the composer via the store when the user clicks "添加").
   *  Cleared when the panel closes so each browser session starts fresh. */
  const [pickedItems, setPickedItems] = useState<PickedElement[]>([]);
  /** The most recently picked element, shown as a brief floating preview card
   *  that animates in then fades out (the "浮窗预览" feedback). */
  const [flashPreview, setFlashPreview] = useState<PickedElement | null>(null);
  /** Download-bar chips, fed by "download" browser:event pushes (start +
   *  terminal state; newest first, capped). Terminal-state chips are
   *  auto-dismissed by timers held in downloadTimersRef. Session-transient
   *  view only — `browser_downloads` (main registry) stays the source of
   *  truth for the agent. */
  const [downloads, setDownloads] = useState<DownloadBarItem[]>([]);
  const downloadTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const stageRef = useRef<HTMLDivElement | null>(null);
  /** Latest bounds sent to main, so re-showing the active tab can re-sync. */
  const lastBoundsRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  /** Ref mirror of deviceToolbarOpen for syncBounds (which is []-memoized). */
  const deviceToolbarOpenRef = useRef(deviceToolbarOpen);
  deviceToolbarOpenRef.current = deviceToolbarOpen;
  /** Ref mirror of tabs/activeTabId so async callbacks read fresh values. */
  const tabsRef = useRef<BrowserTab[]>([]);
  const activeTabIdRef = useRef<string | null>(null);
  /** Whether the device dropdown is open. While open we hide the active view
   *  so the OS-level WebContentsView can't cover the renderer-DOM popup (the
   *  view parks offscreen; it's re-shown + re-synced on close). Kept in a ref
   *  (not state) because only the hide/show effect reads it — a render isn't
   *  needed. */
  const deviceMenuOpenRef = useRef(false);
  /** Ref mirror of pickedItems so handleAddPicked reads the fresh list. */
  const pickedItemsRef = useRef<PickedElement[]>([]);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);
  useEffect(() => {
    activeTabIdRef.current = activeTabId;
  }, [activeTabId]);
  useEffect(() => {
    pickedItemsRef.current = pickedItems;
  }, [pickedItems]);
  /** In-flight guard for the initial-tab create. React StrictMode (dev) runs
   *  mount effects twice back-to-back; without this the two runs both call
   *  createTab() before the first tab lands in the store, opening the browser
   *  with two duplicate tabs. */
  const creatingTabRef = useRef(false);
  /** Monotonic token for freeze/unfreeze orchestration: each open or close
   *  bumps it, async steps compare against the value they captured, so a
   *  stale close-grace timer can't clear a newer freeze and a freeze that
   *  finished after its menu closed won't hide the view into the snapshot. */
  const freezeSeqRef = useRef(0);

  /** Whether THIS container is currently the active one (owns the views). The
   *  overlay is active while `browserPanelOpen`; the sidebar is active while
   *  mounted AND the overlay is NOT open (overlay takes precedence so the two
   *  containers never fight over the same view). BOTH deactivate while the
   *  settings overlay is open: the browser's WebContentsView is an OS-level
   *  surface that floats ABOVE the renderer DOM, so no CSS z-index can stack
   *  the settings page on top of it — the only way to keep the settings panel
   *  clickable is to hide the view (hide() parks it offscreen, the session
   *  survives and re-shows on return). */
  const settingsOpen = useSessionStore((s) => s.settingsOpen);
  const isActive = settingsOpen ? false : mode === "overlay" ? open : !open;

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;

  /** URL staged by an external "open in browser" entry (e.g. the file-tree
   *  context menu) to be loaded into a new tab. Consumed by the effects below. */
  const pendingBrowserUrl = useSessionStore((s) => s.pendingBrowserUrl);

  /** Resolve the active project's path (needed for browser.create). */
  const projectPath = activeProjectId
    ? projects.find((p) => p.id === activeProjectId)?.path ?? null
    : null;

  /** Send the placeholder div's window-relative rect to main for the active
   *  tab's view. The view is sized to the emulated device (or the stage when
   *  the device is larger than the available space) and centered in the stage.
   *  rAF-throttled by callers. Background tabs are visible:false in main, so
   *  their setBounds is a no-op - only the active view moves.
   *
   *  Desktop (the default, no emulation) fills the stage: the page viewport
   *  follows the panel's real size. Mobile presets size the view to the
   *  emulated device (clamped to the stage when it doesn't fit). */
  const syncBounds = useCallback(() => {
    const id = activeTabIdRef.current;
    const tab = tabsRef.current.find((t) => t.id === id);
    const stage = stageRef.current;
    if (!tab || !stage) return;
    const r = stage.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) {
      setBrowserStageRect(null);
      return;
    }
    // Publish the stage rect so the occlusion decision (hide the view only
    // when an open popup actually reaches it) uses live geometry.
    setBrowserStageRect({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
    // Device emulation active only while the device toolbar is open (collapsed
    // = desktop full width). Desktop fills the stage.
    const dims =
      deviceToolbarOpenRef.current && tab.device !== "desktop"
        ? tabViewportDims(tab)
        : null;
    let viewW: number;
    let viewH: number;
    let viewX: number;
    let viewY: number;
    let effW: number | undefined;
    let effH: number | undefined;
    if (dims) {
      // Other presets: the view's physical size MUST equal the emulated
      // viewport or the page gets clipped (content "显示不完整") and
      // capturePage() returns black frames. When the device dims fit the
      // stage, use them exactly; when they exceed it (narrow sidebar, short
      // window), clamp to the stage and override the emulated viewport to
      // match — the page reflows to the available space instead of being cut
      // off.
      viewW = Math.min(dims.width, r.width);
      viewH = Math.min(dims.height, r.height);
      viewX = Math.round(r.left + (r.width - viewW) / 2);
      viewY = Math.round(r.top + (r.height - viewH) / 2);
      if (viewW !== dims.width || viewH !== dims.height) {
        effW = Math.round(viewW);
        effH = Math.round(viewH);
      }
    } else {
      viewW = r.width;
      viewH = r.height;
      viewX = Math.round(r.left);
      viewY = Math.round(r.top);
    }
    const bounds = { x: viewX, y: viewY, w: Math.round(viewW), h: Math.round(viewH) };
    const prev = lastBoundsRef.current;
    if (prev && prev.x === bounds.x && prev.y === bounds.y && prev.w === bounds.w && prev.h === bounds.h) return;
    lastBoundsRef.current = bounds;
    void api.browser.setBounds({
      browserId: tab.browserId,
      x: bounds.x,
      y: bounds.y,
      width: bounds.w,
      height: bounds.h,
    });
    // If the emulated viewport was clamped to the stage, re-apply device
    // emulation with the effective size so the page viewport matches the
    // view's physical bounds (no clipping, screenshots stay valid).
    if (effW != null && effH != null) {
      void api.browser.setDevice({
        browserId: tab.browserId,
        device: tab.device,
        width: tab.customWidth,
        height: tab.customHeight,
        orientation: tab.orientation ?? "portrait",
        viewportWidth: effW,
        viewportHeight: effH,
      });
    }
  }, []);

  /** Re-show the active tab's view with fresh bounds. ORDERING IS THE FIX for
   *  the "browser view escapes the sidebar and covers other panels" bug: main's
   *  show() restores the last stored bounds — or a GUESSED default rect
   *  (defaultOnscreenBounds, ~42% of the window) when the view was never
   *  measured (fresh tab, container swap). If show() is sent before the
   *  renderer has measured the stage, the view paints at that wrong rect and
   *  floats above everything until some later resize happens to re-sync.
   *  Instead: (1) while the stage isn't measurable yet, DON'T show — retry on
   *  subsequent frames (bounded, so a never-measurable container can't spin
   *  rAF forever; after ~1s fall back to a plain show); (2) syncBounds() FIRST
   *  so main stores the true rect while the view is still hidden (setBounds on
   *  an invisible view only updates lastBounds); (3) only then show(), which
   *  applies exactly those bounds; (4) one more rAF sync in case layout moved.
   *  Callers that must force a re-sync (stage narrowed by a menu, device
   *  change, …) null lastBoundsRef before calling. Reads tabsRef/
   *  activeTabIdRef, so callers that just changed the active tab must update
   *  those refs first (they lag the store by one render). */
  const showActiveViewRef = useRef<(attempt?: number) => void>(() => {});
  const showActiveView = useCallback(
    (attempt = 0) => {
      const stage = stageRef.current;
      const r = stage ? stage.getBoundingClientRect() : null;
      if (!r || r.width < 1 || r.height < 1) {
        if (attempt < 60) {
          requestAnimationFrame(() => showActiveViewRef.current(attempt + 1));
          return;
        }
      } else {
        // ALWAYS force the setBounds through: lastBoundsRef dedupes identical
        // rects, but a tab switch lands on a DIFFERENT view that never received
        // those bounds (opening a 2nd html file measures the exact same stage
        // rect as the 1st) — without this, main's show() falls back to the
        // guessed defaultOnscreenBounds rect and the view escapes the panel.
        lastBoundsRef.current = null;
        syncBounds();
      }
      const tab = activeTabIdRef.current
        ? tabsRef.current.find((t) => t.id === activeTabIdRef.current)
        : null;
      if (tab) void api.browser.show({ browserId: tab.browserId });
      requestAnimationFrame(syncBounds);
    },
    [syncBounds],
  );
  useEffect(() => {
    showActiveViewRef.current = (attempt?: number) => showActiveView(attempt ?? 0);
  }, [showActiveView]);

  /** Freeze the active view into a stage-pinned snapshot, then park the view.
   *  Called when a toolbar menu (history / device) opens: the menu renders as
   *  plain DOM floating over the snapshot instead of a white stage. Capture
   *  failure degrades to the old plain hide (menu over white). */
  const freezeViewForMenu = useCallback(async () => {
    const tab = activeTabIdRef.current
      ? tabsRef.current.find((t) => t.id === activeTabIdRef.current)
      : null;
    if (!tab) return;
    // Stage-relative rect of the view (desktop = full stage; device emulation
    // = the centered device column) so the placeholder lands exactly where
    // the real view was.
    const stage = stageRef.current;
    const viewBounds = lastBoundsRef.current;
    const stageRect = stage?.getBoundingClientRect() ?? null;
    const rect =
      stageRect && viewBounds && stageRect.width > 0
        ? {
            left: viewBounds.x - stageRect.left,
            top: viewBounds.y - stageRect.top,
            width: viewBounds.w,
            height: viewBounds.h,
          }
        : null;
    const cap = await api.browser.captureFrame({ browserId: tab.browserId }).catch(() => null);
    // Re-validate after the async capture: the active tab may have changed.
    const still = activeTabIdRef.current
      ? tabsRef.current.find((t) => t.id === activeTabIdRef.current)
      : null;
    if (!still || still.browserId !== tab.browserId) return;
    if (cap?.ok && cap.data) {
      setFreezeFrame({ browserId: tab.browserId, data: cap.data, rect });
      const seq = ++freezeSeqRef.current;
      // Double rAF: the first fires before the placeholder's paint, the
      // second after one committed paint — parking the view from here can't
      // flash white between hide and placeholder.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      // The menu closed while we were freezing (unfreeze bumped the seq):
      // keep the view up and drop our snapshot instead of hiding into it.
      if (freezeSeqRef.current !== seq) {
        setFreezeFrame(null);
        return;
      }
    }
    void api.browser.hide({ browserId: tab.browserId });
  }, []);

  /** Reverse of freezeViewForMenu: bring the live view back FIRST (the native
   *  surface paints over the snapshot the moment it's onscreen — it sits
   *  above all DOM), then drop the snapshot after a short grace so the
   *  addChildView re-host frame can't flash through. The seq guard stops a
   *  stale grace timer from clearing a snapshot captured by a NEWER open
   *  (fast close→reopen). */
  const unfreezeViewForMenu = useCallback(() => {
    lastBoundsRef.current = null;
    showActiveView();
    const seq = ++freezeSeqRef.current;
    window.setTimeout(() => {
      if (freezeSeqRef.current === seq) setFreezeFrame(null);
    }, 150);
  }, [showActiveView]);

  // A frozen snapshot belongs to the tab it was captured from — drop it if
  // the active tab changes (menu mid-flight, tab switch via shortcut, …).
  useEffect(() => {
    setFreezeFrame(null);
  }, [activeTabId]);

  /** Create a new browser view (main) + a new tab entry, hide the old active
   *  tab's view, show the new one, and focus it. Returns the new tab or null. */
  const createTab = useCallback(async (initialUrl?: string): Promise<BrowserTab | null> => {
    if (!projectPath) {
      setError(t("browser.selectProjectFirst"));
      return null;
    }
    // Default to the desktop preset (no emulation — the page fills the panel).
    // Mobile/tablet emulation is opt-in via the device toolbar.
    const res = await api.browser.create({ projectPath });
    if (!res.ok) {
      setError(res.error);
      return null;
    }
    const browserId = res.browserId;
    const tab: BrowserTab = {
      id: newTabId(),
      browserId,
      url: initialUrl ?? "",
      title: "",
      loading: false,
      canGoBack: false,
      canGoForward: false,
      pickMode: false,
      device: "desktop",
    };
    // Load the start page: an explicit initial URL (e.g. a local file opened
    // from the file tree) if given, otherwise a blank page.
    void api.browser.loadUrl({ browserId, url: initialUrl ?? "about:blank" });
    // Hide the previously active tab's view, then show the new one.
    const prevId = activeTabIdRef.current;
    const prevTab = prevId ? tabsRef.current.find((t) => t.id === prevId) : null;
    if (prevTab) {
      // Turn off pick mode on the outgoing tab (picker doesn't cross tabs).
      if (prevTab.pickMode) {
        void api.browser.setPickMode({ browserId: prevTab.browserId, enabled: false });
      }
      void api.browser.hide({ browserId: prevTab.browserId });
    }
    addTab(tab);
    setActiveTabId(tab.id);
    // The refs lag the store by one render — set them NOW so showActiveView()
    // (called synchronously below) measures + targets the new tab, not the
    // outgoing one.
    tabsRef.current = [...tabsRef.current, tab];
    activeTabIdRef.current = tab.id;
    setError(null);
    showActiveView();
    return tab;
  }, [projectPath, addTab, setActiveTabId, syncBounds, showActiveView, t]);

  /** Adopt a view that main created for a page-initiated new-window request
   *  ("tabOpened" event, target=_blank / window.open): register the tab and —
   *  unless the link was opened in the background (middle/ctrl-click) — switch
   *  focus to it, hiding the outgoing active view first exactly like
   *  createTab does. The view itself already exists in main and is already
   *  loading the URL, so unlike createTab there is no browser.create /
   *  loadUrl round-trip here. */
  const adoptWindowOpenTab = useCallback(
    (browserId: string, info: { url?: string; title?: string; background?: boolean }) => {
      // Duplicate push → the tab already exists; its navigation events keep
      // url/title fresh, nothing to adopt.
      if (tabsRef.current.some((t) => t.browserId === browserId)) return;
      const tab: BrowserTab = {
        id: newTabId(),
        browserId,
        url: typeof info.url === "string" ? info.url : "",
        title: typeof info.title === "string" ? info.title : "",
        loading: false,
        canGoBack: false,
        canGoForward: false,
        pickMode: false,
        device: "desktop",
      };
      addTab(tab);
      tabsRef.current = [...tabsRef.current, tab];
      if (info.background) return; // opened behind the current tab — keep focus
      const prevId = activeTabIdRef.current;
      const prevTab = prevId ? tabsRef.current.find((t) => t.id === prevId) : null;
      if (prevTab) {
        // Turn off pick mode on the outgoing tab (picker doesn't cross tabs).
        if (prevTab.pickMode) {
          void api.browser.setPickMode({ browserId: prevTab.browserId, enabled: false });
          patchTabInStore(prevTab.browserId, { pickMode: false });
        }
        void api.browser.hide({ browserId: prevTab.browserId });
      }
      setActiveTabId(tab.id);
      // Refs lag the store by one render — update them NOW so showActiveView()
      // measures + targets the new tab, not the outgoing one.
      activeTabIdRef.current = tab.id;
      showActiveView();
    },
    [addTab, setActiveTabId, patchTabInStore, showActiveView],
  );

  // First time THIS container becomes active with no tabs at all: create the
  // initial tab. (Tabs are shared, so this only fires once per session no
  // matter which container mounts first.) creatingTabRef skips the redundant
  // run from StrictMode's double effect invocation on mount.
  useEffect(() => {
    if (!isActive) return;
    if (tabsRef.current.length > 0) return; // already have tabs
    if (creatingTabRef.current) return; // an initial create is already in flight
    creatingTabRef.current = true;
    // If an external entry (e.g. file-tree "open in browser") staged a URL
    // before any tab existed, load it into this first tab instead of a blank.
    // Consume it SYNCHRONOUSLY, before the async create starts: addTab landing
    // mid-create re-renders and re-runs the pendingBrowserUrl effect below,
    // which — with tabsRef already length 1 and the URL still staged — would
    // open the SAME url in a second, duplicate tab.
    const pending = useSessionStore.getState().pendingBrowserUrl;
    if (pending) useSessionStore.setState({ pendingBrowserUrl: null });
    void createTab(pending ?? undefined)
      .catch(() => {
        // Restore the URL if the initial create failed outright, so the
        // request isn't silently dropped (the pending effect will retry once
        // a tab exists).
        if (pending) useSessionStore.setState({ pendingBrowserUrl: pending });
      })
      .finally(() => {
        creatingTabRef.current = false;
      });
  }, [isActive, createTab]);

  // External "open URL in browser" requests (file-tree, etc.) arrive as a
  // staged `pendingBrowserUrl`. When tabs already exist we honour the request
  // by creating a NEW tab for the URL (rather than overwriting the current
  // page). The no-tabs case (panel first opened) is owned by the first-tab
  // effect above, which loads the URL into the initial tab.
  useEffect(() => {
    if (!isActive || !pendingBrowserUrl) return;
    if (tabsRef.current.length === 0) return; // first-tab effect handles the no-tab case
    const url = pendingBrowserUrl;
    // Re-check the LIVE store before consuming: the closure value can be
    // stale — React StrictMode (dev) re-invokes effects with the SAME captured
    // value after the first run already consumed the URL; without this guard
    // one "open in browser" click creates TWO identical tabs.
    if (useSessionStore.getState().pendingBrowserUrl !== url) return;
    useSessionStore.setState({ pendingBrowserUrl: null }); // consume before async create
    void createTab(url);
  }, [isActive, pendingBrowserUrl, createTab]);

  // Show/hide the active tab's view as THIS container activates/deactivates.
  // Deactivating hides the view WITHOUT destroying it (preserves browsing
  // state); the other container will re-show it when it activates.
  useEffect(() => {
    if (!isActive) {
      // Container deactivating: hide the active tab's view + drop the stage
      // rect (no active browser surface for the occlusion decision).
      setBrowserStageRect(null);
      const tab = activeTabIdRef.current
        ? tabsRef.current.find((t) => t.id === activeTabIdRef.current)
        : null;
      if (tab) {
        if (tab.pickMode) {
          void api.browser.setPickMode({ browserId: tab.browserId, enabled: false });
          patchTabInStore(tab.browserId, { pickMode: false });
        }
        void api.browser.hide({ browserId: tab.browserId });
      }
      return;
    }
    // Container activating with existing tabs: re-show the active view + sync.
    if (tabsRef.current.length === 0) return; // first-open tab creation handled above
    showActiveView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, showActiveView]);

  // React to the suppression counter: while > 0, a renderer-DOM overlay may
  // need to cover the OS-level WebContentsView (which always floats above the
  // DOM). Hide the active view ONLY when one of the open popups actually
  // reaches the browser's stage rect — popups elsewhere (composer dropdowns
  // in the center pane, etc.) keep the view onscreen; unconditionally hiding
  // it blanked the whole panel (white stage) whenever any dropdown opened
  // anywhere. Geometry changes re-run this via the occlusion version (popup
  // moved/closed) and the ResizeObserver schedule below (stage moved). Only
  // this (active) container owns the view, so inactive containers no-op.
  // Unknown geometry (no measurable popup) suppresses conservatively — the
  // old always-hide behavior. Mirrors the device-dropdown / confirm-destroy
  // hide pattern.
  const occlusionVersion = useSyncExternalStore(subscribeOcclusion, getOcclusionVersion);
  const prevSuppressedRef = useRef(0);
  const reconcileBrowserOcclusion = useCallback(() => {
    if (!isActive) return;
    const tab = activeTabIdRef.current
      ? tabsRef.current.find((t) => t.id === activeTabIdRef.current)
      : null;
    if (!tab) return;
    const prev = prevSuppressedRef.current;
    prevSuppressedRef.current = suppressed;
    if (suppressed === 0) {
      // Steady idle state — nothing to reconcile (bounds sync owns visibility).
      // Only the release transition (last popup closed) re-shows the view.
      if (prev > 0) {
        lastBoundsRef.current = null;
        showActiveView();
      }
      return;
    }
    if (shouldSuppressBrowserView()) {
      void api.browser.hide({ browserId: tab.browserId });
    } else {
      // Popups are open but none reaches the browser's rect — keep the view
      // up (this also re-shows after an overlapping popup moved away).
      lastBoundsRef.current = null;
      showActiveView();
    }
  }, [suppressed, isActive, showActiveView, occlusionVersion]);
  useEffect(() => {
    reconcileBrowserOcclusion();
  }, [reconcileBrowserOcclusion]);
  /** Latest reconcile for the resize/scroll scheduling below (whose effect
   *  is scoped to the mount). */
  const reconcileRef = useRef(reconcileBrowserOcclusion);
  reconcileRef.current = reconcileBrowserOcclusion;

  // When the component unmounts (container swap / panel close), hide the active
  // view so it can't linger over the workspace. The view survives in main.
  useEffect(() => {
    return () => {
      setBrowserStageRect(null);
      const tab = activeTabIdRef.current
        ? tabsRef.current.find((t) => t.id === activeTabIdRef.current)
        : null;
      if (tab) {
        if (tab.pickMode) {
          void api.browser.setPickMode({ browserId: tab.browserId, enabled: false });
        }
        void api.browser.hide({ browserId: tab.browserId });
      }
    };
  }, []);

  // ResizeObserver -> syncBounds + occlusion reconcile (rAF-throttled inside).
  // Scroll events feed the same path. The reconcile rides along because the
  // stage moving (window resize, panel divider drag) can flip whether an open
  // popup overlaps it.
  useEffect(() => {
    if (!isActive) return;
    const stage = stageRef.current;
    if (!stage) return;
    let raf = 0;
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        syncBounds();
        reconcileRef.current();
      });
    };
    const ro = new ResizeObserver(schedule);
    ro.observe(stage);
    stage.addEventListener("scroll", schedule);
    // Also sync on window resize (a window move changes the screen-coord rect
    // without a size change that ResizeObserver would catch).
    window.addEventListener("resize", schedule);
    raf = requestAnimationFrame(syncBounds);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      stage.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [isActive, syncBounds]);

  // Address history: read from settings on mount + after navigations (main
  // writes it on did-navigate; a small delay lets the write land first).
  const refreshHistory = useCallback(() => {
    void api.setting
      .get({ key: BROWSER_ADDRESS_HISTORY_SETTING_KEY })
      .then((res) => {
        try {
          const parsed = res.value ? JSON.parse(res.value) : [];
          setHistory(Array.isArray(parsed) ? parsed : []);
        } catch {
          setHistory([]);
        }
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    refreshHistory();
  }, [refreshHistory]);

  // Bookmarks: same settings-backed read pattern as the history above.
  const refreshBookmarks = useCallback(() => {
    void api.setting
      .get({ key: BROWSER_BOOKMARKS_SETTING_KEY })
      .then((res) => {
        try {
          const parsed = res.value ? JSON.parse(res.value) : [];
          setBookmarks(Array.isArray(parsed) ? parsed : []);
        } catch {
          setBookmarks([]);
        }
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    refreshBookmarks();
  }, [refreshBookmarks]);

  /** Bookmark / unbookmark the active page (by URL match against the list). */
  const handleToggleBookmark = useCallback(() => {
    const tab = activeTabIdRef.current
      ? tabsRef.current.find((t) => t.id === activeTabIdRef.current)
      : null;
    if (!tab || !tab.url || tab.url === "about:blank") return;
    const already = bookmarks.some((b) => b.url === tab.url);
    const req = already
      ? api.browser.bookmarkRemove({ url: tab.url })
      : api.browser.bookmarkAdd({ url: tab.url, title: tab.title });
    void req.then(refreshBookmarks);
  }, [bookmarks, refreshBookmarks]);

  const handleRemoveBookmark = useCallback(
    (url: string) => {
      void api.browser.bookmarkRemove({ url }).then(refreshBookmarks);
    },
    [refreshBookmarks],
  );

  /** More-menu open/close — same freeze-frame contract as the history
   *  dropdown; the list is refreshed on open so entries are current. */
  const handleMoreMenuOpenChange = useCallback(
    (open: boolean) => {
      if (!isActive) return;
      const tab = activeTabIdRef.current
        ? tabsRef.current.find((t) => t.id === activeTabIdRef.current)
        : null;
      if (!tab) return;
      if (open) {
        refreshBookmarks();
        void freezeViewForMenu();
      } else {
        unfreezeViewForMenu();
      }
    },
    [isActive, freezeViewForMenu, unfreezeViewForMenu, refreshBookmarks],
  );

  /** Download-bar actions. The renderer only ever passes the downloadId —
   *  main resolves the path from its own registry (BrowserDownloadActionSchema
   *  carries no path), so no renderer-supplied filesystem path is trusted. */
  const handleDownloadOpen = useCallback((downloadId: string) => {
    void api.browser.downloadAction({ downloadId, action: "open" });
  }, []);
  const handleDownloadReveal = useCallback((downloadId: string) => {
    void api.browser.downloadAction({ downloadId, action: "reveal" });
  }, []);
  const handleDownloadDismiss = useCallback((downloadId: string) => {
    const timer = downloadTimersRef.current.get(downloadId);
    if (timer) {
      clearTimeout(timer);
      downloadTimersRef.current.delete(downloadId);
    }
    setDownloads((cur) => cur.filter((d) => d.downloadId !== downloadId));
  }, []);

  /** Privacy rows in the More-menu tree: cache clear keeps cookies (main is
   *  deliberate about the split); cookie clear also wipes the persisted
   *  vault, so sign-ins cannot resurrect on restart. */
  const handleClearCache = useCallback(() => {
    void api.browser.clearCache();
  }, []);
  const handleClearCookies = useCallback(() => {
    void api.browser.clearCookies();
  }, []);
  // Unmount: clear every pending auto-dismiss timer (the container swap on
  // mode switch unmounts this component mid-download routinely).
  useEffect(() => {
    const timers = downloadTimersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  // Subscribe to browser:event pushes. Route each event to the owning tab by
  // browserId and update that tab's state only. Subscribed whenever this
  // container is active (the other container takes over otherwise).
  useEffect(() => {
    if (!isActive) return;
    const unsub = api.on.browserEvent((msg) => {
      // Basic Auth request: hide the active view (the login dialog is
      // renderer DOM and would be covered by the OS-level view) and show it.
      if (msg.type === "authRequest") {
        const req = msg.payload as BrowserAuthRequest;
        if (!req || typeof req.requestId !== "string") return;
        setAuthRequest(req);
        const tab = tabsRef.current.find((t) => t.browserId === msg.browserId);
        if (tab) void api.browser.hide({ browserId: tab.browserId });
        return;
      }
      // Download tracking: update-or-insert the bar chip. Must be handled
      // BEFORE the browserId lookup below — the owning view may not have an
      // adopted tab (agent-created views, window-open races), and the
      // download is still worth showing. A terminal state also schedules the
      // chip's auto-dismiss (~8s; timer tracked so unmount/dismiss can clear).
      if (msg.type === "download") {
        const p = msg.payload as BrowserDownloadProgress;
        if (!p || typeof p.downloadId !== "string") return;
        setDownloads((prev) => {
          const item: DownloadBarItem = {
            downloadId: p.downloadId,
            filename: p.filename,
            path: p.path,
            state: p.state,
            receivedBytes: p.receivedBytes,
            totalBytes: p.totalBytes,
          };
          const idx = prev.findIndex((d) => d.downloadId === p.downloadId);
          const next = idx >= 0 ? prev.map((d, i) => (i === idx ? item : d)) : [item, ...prev];
          return next.slice(0, 10);
        });
        if (p.state !== "progressing") {
          const timer = setTimeout(() => {
            downloadTimersRef.current.delete(p.downloadId);
            setDownloads((cur) => cur.filter((d) => d.downloadId !== p.downloadId));
          }, 8000);
          downloadTimersRef.current.set(p.downloadId, timer);
        }
        return;
      }
      // Main created a fresh view for a page-initiated new-window request
      // (target=_blank / window.open): adopt it as a new panel tab. Must be
      // handled BEFORE the browserId lookup below — the tab doesn't exist yet.
      if (msg.type === "tabOpened") {
        const p = (msg.payload as { url?: string; title?: string; background?: boolean }) ?? {};
        adoptWindowOpenTab(msg.browserId, p);
        return;
      }
      const tab = tabsRef.current.find((t) => t.browserId === msg.browserId);
      if (!tab) return; // not one of our tabs (e.g. stale view)
      if (msg.type === "navigation") {
        refreshHistory();
        const p = msg.payload as { url?: string; title?: string; canGoBack?: boolean; canGoForward?: boolean };
        patchTabInStore(msg.browserId, {
          ...(typeof p.url === "string" ? { url: p.url } : {}),
          ...(typeof p.title === "string" ? { title: p.title } : {}),
          ...(typeof p.canGoBack === "boolean" ? { canGoBack: p.canGoBack } : {}),
          ...(typeof p.canGoForward === "boolean" ? { canGoForward: p.canGoForward } : {}),
        });
      } else if (msg.type === "loading") {
        const p = msg.payload as { isLoading?: boolean };
        if (typeof p.isLoading === "boolean") patchTabInStore(msg.browserId, { loading: p.isLoading });
      } else if (msg.type === "pickResult") {
        const el = msg.payload as PickedElement;
        if (el && typeof el.selector === "string") {
          if (mode === "sidebar") {
            // Sidebar: send straight to the composer (mobile-first flow).
            enqueueChatElement(el);
          } else {
            // Overlay: stage in the picked-items bar for batch review.
            setPickedItems((prev) => [...prev, el]);
          }
          setFlashPreview(el);
          setPickFlash((n) => n + 1);
        }
      }
    });
    return unsub;
  }, [isActive, mode, adoptWindowOpenTab, enqueueChatElement, patchTabInStore, refreshHistory]);

  // Clear the pick flash + floating preview after a moment.
  useEffect(() => {
    if (pickFlash === 0) return;
    const t = setTimeout(() => {
      setPickFlash(0);
      setFlashPreview(null);
    }, 1800);
    return () => clearTimeout(t);
  }, [pickFlash]);

  /** Remove a picked item from the staging bar (by index). Since elements are
   *  staged (not yet enqueued), this simply drops it from the list. */
  const handleRemovePicked = useCallback((index: number) => {
    setPickedItems((prev) => prev.filter((_, i) => i !== index));
  }, []);
  const handleClearPicked = useCallback(() => setPickedItems([]), []);

  /** Overlay → main panel: close the fullscreen overlay and put the browser
   *  back in the right sidebar — the same restoration the "切换到侧边栏"
   *  toolbar button performs. Flows that exit the overlay while the user still
   *  wants to browse (e.g. 添加) must go through this so the right panel isn't
   *  left closed behind the overlay. */
  const handleReturnToSidebar = useCallback(() => {
    setOpen(false);
    setRightOpen(true);
    setRightPanelTab("browser");
  }, [setOpen, setRightOpen, setRightPanelTab]);

  /** Flush all staged elements to the composer (overlay mode only) and return
   *  to the main workspace. This is the commit action for the staging bar:
   *  elements picked in the browser are only added to the input box when the
   *  user clicks "添加". */
  const handleAddPicked = useCallback(() => {
    // Read from the ref to avoid stale-closure issues if multiple adds race.
    const items = pickedItemsRef.current;
    if (items.length === 0) {
      handleReturnToSidebar();
      return;
    }
    for (const el of items) {
      enqueueChatElement(el);
    }
    setPickedItems([]);
    // Commit + return: like "切换到侧边栏", restore the browser into the right
    // sidebar so returning to the main panel doesn't leave the sidebar closed.
    handleReturnToSidebar();
  }, [enqueueChatElement, handleReturnToSidebar]);

  /** Normalize a typed string into a URL.
   *  Recognizes: explicit schemes (http(s)://, file://, …), about:blank, local
   *  file paths (Windows `C:\\…` / `C:/…` or Unix `/…`, converted to file://),
   *  bare domains (prefixed with https://), and falls back to a web search. */
  const normalizeUrl = (input: string): string => {
    const s = input.trim();
    if (!s) return "about:blank";
    if (s === "about:blank") return s;
    // 已带 scheme 的 URL（http/https/file/…）原样放行
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
    // 本地文件路径：Windows 盘符路径或 Unix 绝对路径 → file://
    if (/^[a-z]:[\\/]/i.test(s) || s.startsWith("/")) {
      return localPathToFileUrl(s);
    }
    // 看起来像域名（含 TLD）则补 https://
    if (!/\s/.test(s) && /\.[a-z]{2,}/i.test(s)) return `https://${s}`;
    return `https://www.google.com/search?q=${encodeURIComponent(s)}`;
  };

  const handleNavigate = useCallback(
    (raw: string) => {
      if (!activeTab) return;
      const u = normalizeUrl(raw);
      patchTabInStore(activeTab.browserId, { url: u });
      void api.browser.loadUrl({ browserId: activeTab.browserId, url: u });
    },
    [activeTab, patchTabInStore],
  );

  /** Smart open for bookmark / history entries (the toolbar's More menu):
   *  reuse the active tab ONLY when it's still blank (fresh tab, nothing
   *  loaded yet) — otherwise open a new tab, so picking a bookmark never
   *  clobbers a page the user is reading. The address bar keeps plain
   *  handleNavigate (typing there always targets the current tab). */
  const handleOpenUrlSmart = useCallback(
    (raw: string) => {
      const active = activeTab;
      const u = active?.url.trim();
      if (active && (u === "" || u === "about:blank")) {
        handleNavigate(raw);
        return;
      }
      void createTab(normalizeUrl(raw));
    },
    [activeTab, handleNavigate, createTab],
  );

  /** Force a NEW tab for a URL — the More-menu tree's open-in-new-tab op on
   *  bookmark rows (the smart open above keeps blank-tab reuse). */
  const handleOpenUrlNewTab = useCallback(
    (raw: string) => {
      void createTab(normalizeUrl(raw));
    },
    [createTab],
  );

  const handleBack = useCallback(() => {
    if (activeTab) void api.browser.goBack({ browserId: activeTab.browserId });
  }, [activeTab]);
  const handleForward = useCallback(() => {
    if (activeTab) void api.browser.goForward({ browserId: activeTab.browserId });
  }, [activeTab]);
  const handleReload = useCallback(() => {
    if (activeTab) void api.browser.reload({ browserId: activeTab.browserId });
  }, [activeTab]);

  const handleTogglePickMode = useCallback(() => {
    if (!activeTab) return;
    const next = !activeTab.pickMode;
    void api.browser.setPickMode({ browserId: activeTab.browserId, enabled: next }).then((res) => {
      if (res.ok) patchTabInStore(activeTab.browserId, { pickMode: next });
    });
  }, [activeTab, patchTabInStore]);

  /** The device dropdown is a renderer-DOM popup; the page behind it is an
   *  OS-level WebContentsView that always floats above the DOM. So while the
   *  dropdown is open we freeze the page into a stage-pinned snapshot and
   *  park the view — the menu floats over the frozen frame instead of a
   *  white stage — and re-show the view when it closes (the snapshot lingers
   *  a few frames to mask the re-host flash). Only acts when this container
   *  is active. Edge cases are covered by the existing isActive show/hide
   *  effect: if the container deactivates while the menu is open (settings
   *  opened, mode switch, project switch), its hide effect hides the view
   *  anyway, and reactivation re-shows it via the show branch. */
  const handleDeviceMenuOpenChange = useCallback(
    (open: boolean) => {
      deviceMenuOpenRef.current = open;
      if (!isActive) return;
      const tab = activeTabIdRef.current
        ? tabsRef.current.find((t) => t.id === activeTabIdRef.current)
        : null;
      if (!tab) return;
      if (open) {
        void freezeViewForMenu();
      } else {
        unfreezeViewForMenu();
      }
    },
    [isActive, freezeViewForMenu, unfreezeViewForMenu],
  );

  /** Switch the active tab's device/viewport. The main process applies
   *  Chromium device emulation (mobile viewport + touch + UA); the renderer
   *  narrows the view's bounds to the emulated size and centers it. For
   *  "custom" the given width/height are used; orientation "landscape" swaps
   *  the dims. The bounds re-sync happens on the next animation frame. */
  const handleViewportChange = useCallback(
    (
      device: BrowserDevicePreset,
      opts?: { width?: number; height?: number; orientation?: BrowserOrientation },
    ) => {
      if (!activeTab) return;
      const orientation = opts?.orientation ?? "portrait";
      const customWidth = device === "custom" ? opts?.width : undefined;
      const customHeight = device === "custom" ? opts?.height : undefined;
      if (
        activeTab.device === device &&
        (activeTab.orientation ?? "portrait") === orientation &&
        (device !== "custom" ||
          (activeTab.customWidth === customWidth &&
            activeTab.customHeight === customHeight))
      ) {
        return;
      }
      void api.browser
        .setDevice({
          browserId: activeTab.browserId,
          device,
          width: opts?.width,
          height: opts?.height,
          orientation,
        })
        .then((res) => {
          if (!res.ok) return;
          patchTabInStore(activeTab.browserId, {
            device,
            ...(device === "custom"
              ? { customWidth, customHeight }
              : { customWidth: undefined, customHeight: undefined }),
            orientation,
          });
          // Force a bounds re-sync: the dedupe check in syncBounds compares
          // against lastBoundsRef, so we must clear it to let the new (narrower
          // or wider) rect through.
          lastBoundsRef.current = null;
          requestAnimationFrame(syncBounds);
        });
    },
    [activeTab, patchTabInStore, syncBounds],
  );

  /** Toggle the device toolbar. Collapsing/expanding changes whether the view
   *  is narrowed to the device size (collapsed = full width), so force a
   *  bounds re-sync after the store updates (the dedupe check in syncBounds
   *  needs lastBoundsRef cleared).
   *
   *  Collapsing while a mobile preset is active ALSO resets the device to
   *  "desktop": main keeps Chromium device emulation (390×844 etc.) applied
   *  until setDevice("desktop") disables it, so a full-width view with a
   *  still-active emulation viewport is mismatched — capturePage() then
   *  returns a black/blank screenshot. "Collapse = desktop full width" keeps
   *  the renderer view bounds and the main emulation state in sync. */
  const handleToggleDeviceToolbar = useCallback(() => {
    const opening = !deviceToolbarOpenRef.current;
    const tab = activeTabIdRef.current
      ? tabsRef.current.find((t) => t.id === activeTabIdRef.current)
      : null;
    if (!opening && tab && tab.device !== "desktop") {
      // Collapsing with a mobile preset: reset to desktop (disables main's
      // emulation) so the full-width view matches the disabled emulation.
      void handleViewportChange("desktop");
    }
    setDeviceToolbarOpen(opening);
    lastBoundsRef.current = null;
    requestAnimationFrame(syncBounds);
  }, [setDeviceToolbarOpen, handleViewportChange, syncBounds]);

  /** Address-history dropdown open/close — same freeze-frame pattern as the
   *  device dropdown above (renderer-DOM popup vs OS-level view). */
  const handleHistoryMenuOpenChange = useCallback(
    (open: boolean) => {
      if (!isActive) return;
      const tab = activeTabIdRef.current
        ? tabsRef.current.find((t) => t.id === activeTabIdRef.current)
        : null;
      if (!tab) return;
      if (open) {
        void freezeViewForMenu();
      } else {
        unfreezeViewForMenu();
      }
    },
    [isActive, freezeViewForMenu, unfreezeViewForMenu],
  );

  const handleRemoveHistoryEntry = useCallback(
    (url: string) => {
      void api.browser.historyRemove({ url }).then(() => refreshHistory());
    },
    [refreshHistory],
  );

  const handleClearHistory = useCallback(() => {
    void api.browser.historyClear({}).then(() => refreshHistory());
  }, [refreshHistory]);

  /** Auth dialog closed: restore the (previously hidden) active view. */
  const handleAuthClose = useCallback(() => {
    setAuthRequest(null);
    if (!isActive) return;
    const tab = activeTabIdRef.current
      ? tabsRef.current.find((t) => t.id === activeTabIdRef.current)
      : null;
    if (tab) {
      lastBoundsRef.current = null;
      showActiveView();
    }
  }, [isActive, showActiveView]);

  /** Select a tab: hide the old active view, show the new one. */
  const handleSelectTab = useCallback(
    (id: string) => {
      if (id === activeTabIdRef.current) return;
      const oldTab = activeTabIdRef.current
        ? tabsRef.current.find((t) => t.id === activeTabIdRef.current)
        : null;
      const newTab = tabsRef.current.find((t) => t.id === id);
      if (!newTab) return;
      // Turn off pick mode on the outgoing tab (picker doesn't cross tabs).
      if (oldTab && oldTab.pickMode) {
        void api.browser.setPickMode({ browserId: oldTab.browserId, enabled: false });
        patchTabInStore(oldTab.browserId, { pickMode: false });
      }
      if (oldTab) void api.browser.hide({ browserId: oldTab.browserId });
      setActiveTabId(id);
      // Refs lag the store by one render — update them now so showActiveView()
      // targets the incoming tab.
      activeTabIdRef.current = id;
      showActiveView();
    },
    [patchTabInStore, setActiveTabId, showActiveView],
  );

  /** Close a tab: destroy its view, remove it, and activate a neighbor. If it
   *  was the last tab, close the whole panel (overlay) / exit the sidebar. */
  const handleCloseTab = useCallback(
    (id: string) => {
      const idx = tabsRef.current.findIndex((t) => t.id === id);
      if (idx === -1) return;
      const closing = tabsRef.current[idx];
      void api.browser.close({ browserId: closing.browserId });
      const remaining = tabsRef.current.filter((t) => t.id !== id);
      setTabs(remaining);
      if (remaining.length === 0) {
        // Last tab closed -> exit the browser entirely.
        setActiveTabId(null);
        lastBoundsRef.current = null;
        if (mode === "overlay") {
          setOpen(false);
        } else {
          setRightPanelTab("files");
        }
        return;
      }
      // If we closed the active tab, activate the neighbor (previous, or the
      // new last if we closed the last tab). Otherwise keep the current active.
      if (id === activeTabIdRef.current) {
        const nextTab = remaining[Math.min(idx, remaining.length - 1)];
        setActiveTabId(nextTab.id);
        // Refs lag the store — update now so showActiveView() targets the
        // incoming neighbor tab.
        tabsRef.current = remaining;
        activeTabIdRef.current = nextTab.id;
        showActiveView();
      }
    },
    [mode, setTabs, setActiveTabId, setOpen, setRightPanelTab, showActiveView],
  );

  /** New tab button: create a fresh tab and focus it. */
  const handleNewTab = useCallback(() => {
    void createTab();
  }, [createTab]);

  /** Overlay: "返回工作台" hides the overlay (views stay alive). Sidebar has no
   *  equivalent (closing is via the rail icon toggle / 关闭浏览器). */
  const handleClose = useCallback(() => {
    if (mode === "overlay") setOpen(false);
  }, [mode, setOpen]);

  /** Switch to the OTHER container: sidebar → overlay (PC fullscreen) or
   *  overlay → sidebar (mobile column). The active view is hidden on unmount
   *  of this container and re-shown when the other container mounts; tabs are
   *  shared via the store so they carry over. */
  const handleSwitchMode = useCallback(() => {
    if (mode === "sidebar") {
      // Sidebar → overlay: drop the sidebar tab + open the fullscreen overlay.
      setRightPanelTab("files");
      setOpen(true);
    } else {
      // Overlay → sidebar: restore the browser into the right sidebar (this
      // also closes the overlay and reopens the right panel).
      handleReturnToSidebar();
    }
  }, [mode, handleReturnToSidebar, setRightPanelTab, setOpen]);

  // Sync the shared tab count to the store so the rail/Titlebar badges work.
  // (Only one container is active at a time, so no double-counting.)
  useEffect(() => {
    if (!isActive) return;
    setBrowserTabCount(tabs.length);
  }, [tabs.length, isActive, setBrowserTabCount]);

  if (mode === "overlay" && !open) return null;

  // Tabs for display (strip browserId - the tab strip doesn't need it).
  const displayTabs: BrowserTabDisplay[] = tabs.map((t) => ({
    id: t.id,
    title: t.title,
    url: t.url,
    loading: t.loading,
  }));

  const rootClass =
    mode === "overlay"
      ? "fixed inset-x-0 top-10 bottom-0 z-40 flex flex-col bg-surface"
      : "flex h-full flex-col bg-surface";

  return (
    <div className={rootClass}>
      <BrowserTabs
        tabs={displayTabs}
        activeTabId={activeTabId}
        onSelect={handleSelectTab}
        onClose={handleCloseTab}
        onNew={handleNewTab}
      />
      <BrowserToolbar
        mode={mode}
        url={activeTab?.url ?? ""}
        loading={activeTab?.loading ?? false}
        canGoBack={activeTab?.canGoBack ?? false}
        canGoForward={activeTab?.canGoForward ?? false}
        pickMode={activeTab?.pickMode ?? false}
        deviceToolbarOpen={deviceToolbarOpen}
        onUrlChange={(u) => activeTab && patchTabInStore(activeTab.browserId, { url: u })}
        onNavigate={handleNavigate}
        onBack={handleBack}
        onForward={handleForward}
        onReload={handleReload}
        onTogglePickMode={handleTogglePickMode}
        onToggleDeviceToolbar={handleToggleDeviceToolbar}
        onClose={handleClose}
        onSwitchMode={handleSwitchMode}
        history={history}
        bookmarks={bookmarks}
        currentBookmarked={!!activeTab && bookmarks.some((b) => b.url === activeTab.url)}
        onToggleBookmark={handleToggleBookmark}
        onRemoveBookmark={handleRemoveBookmark}
        onOpenUrl={handleOpenUrlSmart}
        onOpenUrlNewTab={handleOpenUrlNewTab}
        downloads={downloads}
        onDownloadOpen={handleDownloadOpen}
        onDownloadReveal={handleDownloadReveal}
        onClearCache={handleClearCache}
        onClearCookies={handleClearCookies}
        onRemoveHistoryEntry={handleRemoveHistoryEntry}
        onClearHistory={handleClearHistory}
        onHistoryMenuOpenChange={handleHistoryMenuOpenChange}
        onMoreMenuOpenChange={handleMoreMenuOpenChange}
      />
      {/* Device toolbar — the DevTools-style row (device dropdown + custom
          dims + rotate), toggled by the 📱 button above. Rendered between the
          address bar and the stage so the stage (and the view) sits below it. */}
      {deviceToolbarOpen && activeTab && (
        <DeviceToolbar
          device={activeTab.device}
          customWidth={activeTab.customWidth}
          customHeight={activeTab.customHeight}
          orientation={activeTab.orientation}
          onViewportChange={handleViewportChange}
          onMenuOpenChange={handleDeviceMenuOpenChange}
          onClose={() => handleToggleDeviceToolbar()}
        />
      )}
      {/* The stage is the measurement target for the active tab's
          WebContentsView. The view floats above it at OS level, so this div
          stays visually empty - its only job is to occupy the right rect. The
          spacer just fills the stage for every device (pages scroll inside
          the native window).
          The background is fixed white (matching BrowserManager's view
          background) so the browser's page area never follows the app theme. */}
      <div ref={stageRef} className="relative min-h-0 flex-1 overflow-auto bg-white">
        <div className="h-full w-full" />
        {/* Frozen-frame placeholder: while a toolbar menu is open the real
            view is parked offscreen and this snapshot pins the page's last
            painted frame to the stage — the menu floats over it as plain DOM
            instead of a white void. pointer-events-none lets clicks fall
            through to the stage (outside-click closes the menu). The rect is
            null when the view bounds weren't measured yet — cover the stage
            as the fallback. */}
        {freezeFrame && activeTab?.browserId === freezeFrame.browserId && (
          <img
            src={`data:image/png;base64,${freezeFrame.data}`}
            alt=""
            aria-hidden
            draggable={false}
            className="pointer-events-none absolute select-none"
            style={
              freezeFrame.rect
                ? {
                    left: freezeFrame.rect.left,
                    top: freezeFrame.rect.top,
                    width: freezeFrame.rect.width,
                    height: freezeFrame.rect.height,
                  }
                : { inset: 0, width: "100%", height: "100%" }
            }
          />
        )}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center">
            <p className="text-sm text-content-muted">{error}</p>
          </div>
        )}
        {activeTab?.pickMode && (
          <div className="pointer-events-none absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-full bg-accent/90 px-3 py-1 text-[11px] font-medium text-white shadow">
            {mode === "sidebar"
              ? t("browser.pickSidebarHint")
              : t("browser.pickOverlayHint")}
          </div>
        )}
        {/* Floating preview card: appears briefly on each pick, showing the
            just-picked element's selector + preview so the user gets immediate
            visual confirmation of WHAT was added (not just that something was).
            Animates in (scale-up + fade) then fades out when pickFlash clears. */}
        {flashPreview && (
          <div
            className={cn(
              "pointer-events-none absolute bottom-4 left-1/2 z-10 -translate-x-1/2",
              "flex items-center gap-2 rounded-lg border border-green-500/40 bg-green-600/95 px-3 py-2 text-white shadow-xl",
              "transition-all duration-300",
              pickFlash > 0 ? "scale-100 opacity-100" : "scale-95 opacity-0",
            )}
          >
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/25 text-[11px]">✓</span>
            <div className="min-w-0">
              <div className="text-[11px] font-medium leading-tight">
                {mode === "sidebar" ? t("browser.addedToInput") : t("browser.pickedToList")}
              </div>
              <div className="max-w-[240px] truncate text-[10px] leading-tight text-white/80">
                {flashPreview.preview || flashPreview.selector}
              </div>
            </div>
          </div>
        )}
      </div>
      {/* Download bar (both modes): Chrome-style chips for downloads started
          by the embedded browser — spinner while in flight, click a completed
          chip to open the file, folder button reveals it. Auto-hides when
          empty; its height shrinks the stage (bounds re-sync via the stage
          ResizeObserver). */}
      <DownloadBar
        items={downloads}
        onOpen={handleDownloadOpen}
        onReveal={handleDownloadReveal}
        onDismiss={handleDownloadDismiss}
      />
      {/* Picked-elements bar (overlay mode only): a Chrome-download-bar-style
          strip showing all elements picked in this browser session. The sidebar
          flow enqueues immediately so it has no staging bar. */}
      {mode === "overlay" && (
        <PickedElementsBar
          items={pickedItems}
          onRemove={handleRemovePicked}
          onClear={handleClearPicked}
          onAdd={handleAddPicked}
        />
      )}

      {/* HTTP Basic Auth prompt (pushed by main as an "authRequest" event;
          the view is hidden while it's up, restored on close). */}
      <AuthPromptDialog request={authRequest} onClose={handleAuthClose} />
    </div>
  );
}
