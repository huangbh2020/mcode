import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { api } from "@renderer/lib/api.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import type { BrowserTab } from "@renderer/stores/sessionStore.js";
import { localPathToFileUrl } from "@renderer/lib/browserUrl.js";
import {
  resolveBrowserDeviceSpec,
  BROWSER_ADDRESS_HISTORY_SETTING_KEY,
  type PickedElement,
  type BrowserDevicePreset,
  type BrowserOrientation,
  type BrowserHistoryEntry,
  type BrowserAuthRequest,
} from "@contracts/ipc";
import { BrowserToolbar } from "./BrowserToolbar.js";
import { DeviceToolbar } from "./DeviceToolbar.js";
import { BrowserTabs, type BrowserTabDisplay } from "./BrowserTabs.js";
import { PickedElementsBar } from "./PickedElementsBar.js";
import { ConfirmDialog } from "@renderer/components/ui/confirm-dialog.js";
import { CredentialDialog } from "./CredentialDialog.js";
import { AuthPromptDialog } from "./AuthPromptDialog.js";

/**
 * Browser panel — multi-tab, shared between two containers.
 *
 * - `mode="overlay"`: a full-workspace overlay (below the 40px titlebar) — the
 *   PC-fullscreen experience. Picked elements stage in a bottom bar and only
 *   enter the composer when the user clicks "添加".
 * - `mode="sidebar"`: embedded inside the right IDE panel — the mobile-first
 *   experience. New tabs default to the iPhone device preset, the view fills
 *   the sidebar width, and picked elements go straight to the composer.
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

  /** Confirm-destroy dialog visibility. Opening the dialog first hides the
   *  active WebContentsView so the (renderer-DOM) dialog isn't covered by the
   *  OS-level view floating above the stage. */
  const [confirmDestroy, setConfirmDestroy] = useState(false);
  /** Credential-vault dialog visibility (same hide-view-while-open pattern). */
  const [credentialsOpen, setCredentialsOpen] = useState(false);
  /** Pending HTTP Basic Auth request pushed by main ("authRequest" event).
   *  Non-null shows the login dialog (view hidden while it's up). */
  const [authRequest, setAuthRequest] = useState<BrowserAuthRequest | null>(null);
  /** Address-bar history, read from settings (main is the single writer). */
  const [history, setHistory] = useState<BrowserHistoryEntry[]>([]);
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
   *  The "pc" preset keeps the page's true 1920×1080 layout (the emulated
   *  viewport is pinned to 1920×1080 via setDevice's viewportWidth/Height
   *  override) but clamps the physical view to the stage so a narrow sidebar
   *  never overflows onto the chat/other panels. The user scrolls inside the
   *  native window (the page's own scrollbar) to see the rest of the page. */
  const syncBounds = useCallback(() => {
    const id = activeTabIdRef.current;
    const tab = tabsRef.current.find((t) => t.id === id);
    const stage = stageRef.current;
    if (!tab || !stage) return;
    const r = stage.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
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
    if (dims && tab.device === "pc") {
      // PC preset: keep the true 1920×1080 emulated viewport (PC page layout)
      // but clamp the physical view to the stage so it never overflows the
      // sidebar onto other panels. The page renders its full PC layout and the
      // user scrolls inside the native window to see beyond the visible area.
      viewW = r.width;
      viewH = r.height;
      viewX = Math.round(r.left);
      viewY = Math.round(r.top);
      effW = dims.width;
      effH = dims.height;
    } else if (dims) {
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

  /** Create a new browser view (main) + a new tab entry, hide the old active
   *  tab's view, show the new one, and focus it. Returns the new tab or null. */
  const createTab = useCallback(async (initialUrl?: string): Promise<BrowserTab | null> => {
    if (!projectPath) {
      setError("请先选择一个项目");
      return null;
    }
    // Sidebar starts in mobile mode. We pass initialDevice so the main process
    // applies emulation at dom-ready (the safe earliest point) — calling
    // setDevice synchronously here crashes the GPU process before it's ready.
    const initialDevice = mode === "sidebar" ? "iphone" : undefined;
    const res = await api.browser.create({ projectPath, initialDevice });
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
      // Sidebar defaults to mobile; overlay defaults to desktop.
      device: mode === "sidebar" ? "iphone" : "desktop",
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
  }, [projectPath, mode, addTab, setActiveTabId, syncBounds, showActiveView]);

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
      // Container deactivating: hide the active tab's view.
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

  // React to the suppression counter: while > 0 a renderer-DOM overlay (image
  // lightbox, etc.) must cover the OS-level WebContentsView, which always floats
  // above the DOM — so hide the active view and restore it when the counter
  // returns to zero. Only this (active) container owns the view, so inactive
  // containers no-op (their view is already hidden by the isActive effect
  // above). Mirrors the device-dropdown / confirm-destroy hide pattern.
  useEffect(() => {
    if (!isActive) return;
    const tab = activeTabIdRef.current
      ? tabsRef.current.find((t) => t.id === activeTabIdRef.current)
      : null;
    if (!tab) return;
    if (suppressed > 0) {
      void api.browser.hide({ browserId: tab.browserId });
    } else {
      lastBoundsRef.current = null;
      showActiveView();
    }
  }, [suppressed, isActive, showActiveView]);

  // When the component unmounts (container swap / panel close), hide the active
  // view so it can't linger over the workspace. The view survives in main.
  useEffect(() => {
    return () => {
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

  // ResizeObserver -> syncBounds (rAF-throttled inside). The stage is also a
  // scroll container for the "pc" preset (the view pans with scrollLeft/Top),
  // so scroll events re-sync the bounds the same way.
  useEffect(() => {
    if (!isActive) return;
    const stage = stageRef.current;
    if (!stage) return;
    let raf = 0;
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(syncBounds);
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
  }, [isActive, mode, enqueueChatElement, patchTabInStore, refreshHistory]);

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
   *  dropdown is open we hide the active view (parked offscreen, session kept)
   *  and re-show + re-sync it when the dropdown closes — the same pattern the
   *  confirm-destroy dialog uses. Only acts when this container is active.
   *  Edge cases are covered by the existing isActive show/hide effect: if the
   *  container deactivates while the menu is open (settings opened, mode
   *  switch, project switch), its hide effect hides the view anyway, and
   *  reactivation re-shows it via the show branch. */
  const handleDeviceMenuOpenChange = useCallback(
    (open: boolean) => {
      deviceMenuOpenRef.current = open;
      if (!isActive) return;
      const tab = activeTabIdRef.current
        ? tabsRef.current.find((t) => t.id === activeTabIdRef.current)
        : null;
      if (!tab) return;
      if (open) {
        void api.browser.hide({ browserId: tab.browserId });
      } else {
        lastBoundsRef.current = null;
        showActiveView();
      }
    },
    [isActive, showActiveView],
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

  /** Address-history dropdown open/close — same hide/show pattern as the
   *  device dropdown above (renderer-DOM popup vs OS-level view). */
  const handleHistoryMenuOpenChange = useCallback(
    (open: boolean) => {
      if (!isActive) return;
      const tab = activeTabIdRef.current
        ? tabsRef.current.find((t) => t.id === activeTabIdRef.current)
        : null;
      if (!tab) return;
      if (open) {
        void api.browser.hide({ browserId: tab.browserId });
      } else {
        lastBoundsRef.current = null;
        showActiveView();
      }
    },
    [isActive, showActiveView],
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

  /** Credential vault dialog — hide the active view while it's open (same
   *  pattern as the destroy-confirm dialog), restore on close. */
  const handleCredentialsOpenChange = useCallback(
    (open: boolean) => {
      if (!isActive) {
        setCredentialsOpen(open);
        return;
      }
      const tab = activeTabIdRef.current
        ? tabsRef.current.find((t) => t.id === activeTabIdRef.current)
        : null;
      if (open) {
        if (tab) void api.browser.hide({ browserId: tab.browserId });
      } else if (tab) {
        lastBoundsRef.current = null;
        showActiveView();
      }
      setCredentialsOpen(open);
    },
    [isActive, showActiveView],
  );

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

  /** "关闭浏览器" button: open a confirmation dialog before tearing down all
   *  tabs. We hide the active view first so the OS-level WebContentsView can't
   *  cover the renderer-DOM dialog. Cancel restores the view. */
  const handleRequestDestroy = useCallback(() => {
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
    setConfirmDestroy(true);
  }, [patchTabInStore]);

  /** Confirm: destroy every tab's view in main, clear shared state, exit. */
  const handleConfirmDestroy = useCallback(() => {
    for (const t of tabsRef.current) {
      void api.browser.close({ browserId: t.browserId });
    }
    setTabs([]);
    setActiveTabId(null);
    lastBoundsRef.current = null;
    setPickedItems([]);
    setConfirmDestroy(false);
    if (mode === "overlay") {
      setOpen(false);
    } else {
      setRightPanelTab("files");
    }
  }, [mode, setTabs, setActiveTabId, setOpen, setRightPanelTab]);

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
        onRequestDestroy={handleRequestDestroy}
        history={history}
        onRemoveHistoryEntry={handleRemoveHistoryEntry}
        onClearHistory={handleClearHistory}
        onHistoryMenuOpenChange={handleHistoryMenuOpenChange}
        onOpenCredentials={() => handleCredentialsOpenChange(true)}
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
          spacer just fills the stage for every device (the "pc" preset no longer
          pans via stage scroll — the page scrolls inside the native window). */}
      <div ref={stageRef} className="relative min-h-0 flex-1 overflow-auto bg-surface">
        <div className="h-full w-full" />
        {error && (
          <div className="absolute inset-0 flex items-center justify-center">
            <p className="text-sm text-content-muted">{error}</p>
          </div>
        )}
        {activeTab?.pickMode && (
          <div className="pointer-events-none absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-full bg-accent/90 px-3 py-1 text-[11px] font-medium text-white shadow">
            {mode === "sidebar"
              ? "点击页面元素直接添加到输入框 · 按 Esc 退出"
              : "点击页面元素以添加到输入框 · 按 Esc 退出"}
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
                {mode === "sidebar" ? "已添加到输入框" : "已拾取到列表"}
              </div>
              <div className="max-w-[240px] truncate text-[10px] leading-tight text-white/80">
                {flashPreview.preview || flashPreview.selector}
              </div>
            </div>
          </div>
        )}
      </div>
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

      {/* Destroy confirmation. Rendered at panel root so it sits above the
          stage; the active view was already hidden in handleRequestDestroy so
          the dialog isn't covered by the OS-level WebContentsView. Cancel
          restores the view since the panel stays open. */}
      <ConfirmDialog
        open={confirmDestroy}
        title="关闭浏览器？"
        description="关闭后将销毁所有打开的标签页，未保存的页面内容将丢失。"
        confirmText="确定关闭"
        cancelText="取消"
        danger
        onOpenChange={(o) => {
          setConfirmDestroy(o);
          if (!o) {
            // Cancel: re-show the active view (panel is still active).
            if (!isActive) return;
            lastBoundsRef.current = null;
            showActiveView();
          }
        }}
        onConfirm={handleConfirmDestroy}
      />

      {/* Credential vault (manual password manager). The active view is
          hidden while open via handleCredentialsOpenChange. */}
      <CredentialDialog open={credentialsOpen} onOpenChange={handleCredentialsOpenChange} />

      {/* HTTP Basic Auth prompt (pushed by main as an "authRequest" event;
          the view is hidden while it's up, restored on close). */}
      <AuthPromptDialog request={authRequest} onClose={handleAuthClose} />
    </div>
  );
}
