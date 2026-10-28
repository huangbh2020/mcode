import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { cn } from "@renderer/lib/cn.js";
import { IconX } from "@renderer/lib/icons.js";
import { getProviderIcon } from "@renderer/lib/providerIcon.js";
import { getSessionDragPayload, isSessionDrag } from "@renderer/lib/sessionDrag.js";
import { ThreePaneLayout } from "./components/layout/ThreePaneLayout.js";
import { Divider } from "./components/layout/Divider.js";
import { Titlebar } from "./components/layout/Titlebar.js";
import { LeftBar } from "./components/layout/LeftBar.js";
import { StreamSidebar } from "./components/layout/StreamSidebar.js";
import {
  LeftEdgePeekTrigger,
  RightEdgePeekTrigger,
  PeekScrim,
  usePeekAutoClose,
  AUTO_PEEK_IDLE_MS,
} from "./components/layout/LeftPanelPeek.js";
import { ChatPane } from "./components/chat/ChatPane.js";
import { TerminalSessionPane } from "./components/chat/TerminalSessionPane.js";
import { SessionTabs } from "./components/layout/SessionTabs.js";
import { UnifiedTabsBar } from "./components/layout/UnifiedTabsBar.js";
import { RightPanel } from "./components/layout/RightPanel.js";
import { BottomTerminalBar } from "./components/layout/BottomTerminalBar.js";
import { SettingsPage } from "./components/settings/SettingsPage.js";
import { SchedPage } from "./components/automation/SchedPage.js";
import { CommandPalette } from "./components/layout/CommandPalette.js";
import { SearchDialog } from "./components/ide/SearchDialog.js";
import { ModelConfigPrompt } from "./components/chat/ModelConfigPrompt.js";
import { RuntimeUpdatePrompt } from "./components/settings/RuntimeUpdatePrompt.js";
import { BrowserPanel } from "./components/browser/BrowserPanel.js";
import { Toaster } from "./components/layout/Toaster.js";
import { UpdateNotification } from "./components/layout/UpdateNotification.js";
import { VoiceListeningOverlay } from "./components/layout/VoiceListeningOverlay.js";
import { useClaudeEvents } from "./hooks/useClaudeEvents.js";
import { useGlobalShortcuts } from "./hooks/useGlobalShortcuts.js";
import { useMouseGestures } from "./hooks/useMouseGestures.js";
import { useSuppressBrowserView } from "./hooks/useSuppressBrowserView.js";
import { useSessionStore, selectSessionKind } from "./stores/sessionStore.js";
import type { BrowserDevicePreset } from "@contracts/ipc";
import { api } from "./lib/api.js";
import { useTheme } from "./lib/theme.js";
import { useChatAppearance, useRightPanelAppearance, useThemeStyle } from "./lib/appearance.js";
import { useI18n } from "./lib/i18n/index.js";
import { startPortalPopupWatcher } from "./lib/browserPortalWatcher.js";
import { OpenTabsBar } from "./components/ide/OpenTabsBar.js";

// Lazy-load the Monaco-backed editor, diff dialog and plan viewer so the large
// monaco-editor library (and its web workers) stay out of the initial renderer
// chunk. PlanViewer statically imports monacoSetup.ts (the worker bootstrap),
// so an eager import here would pull all of Monaco into the first-paint
// critical path — exactly the slowness lazy-loading FileEditor was meant to
// avoid. All three are only needed once the user opens a file, a diff dialog
// or the plan tab — well after first paint. Vite splits them into separate
// chunks automatically.
const FileEditor = lazy(() =>
  import("./components/ide/FileEditor.js").then((m) => ({ default: m.FileEditor })),
);
const GitDiffDialog = lazy(() =>
  import("./components/ide/GitDiffDialog.js").then((m) => ({ default: m.GitDiffDialog })),
);
const PlanViewer = lazy(() =>
  import("./components/chat/PlanViewer.js").then((m) => ({ default: m.PlanViewer })),
);

/** Two-frame transition arming for a hover-peek drawer, shared by the left
 *  and right drawers. Entering drawer mode re-parents the aside in a single
 *  commit, and a live transform transition would replay a stale slide across
 *  the window — the first frame must park the panel off-canvas with
 *  transitions disabled, then arm.
 *
 *  Two frames, not one: a single rAF still fires BEFORE the first paint, so
 *  arming would coalesce with the park into one style change and the
 *  transform would glide none → ±100% across the window (visible when a
 *  fullscreen page closes back onto a closed-sidebar workspace). Frame 1
 *  paints the parked state; frame 2 arms the transitions. Exiting drawer
 *  mode disarms and resets the side's peek flag (a drawer that no longer
 *  exists must never stay "open"). */
function usePeekDrawerArmed(drawer: boolean, resetPeek: (open: boolean) => void) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!drawer) {
      setArmed(false);
      resetPeek(false);
      return;
    }
    let id2 = 0;
    const id1 = requestAnimationFrame(() => {
      id2 = requestAnimationFrame(() => setArmed(true));
    });
    return () => {
      cancelAnimationFrame(id1);
      cancelAnimationFrame(id2);
    };
  }, [drawer, resetPeek]);
  return armed;
}

export function App() {
  // Subscribe to the claude event stream for the app's whole lifetime.
  useClaudeEvents();
  // Global portal-popup watcher: classifies any portaled popup by ARIA role
  // (base-ui sets role="menu"/"listbox"/"dialog") and registers occluders so
  // the embedded browser's OS-level view can't swallow popups nobody wired
  // with useSuppressBrowserView (ConfirmDialog family, context menus, select
  // dropdowns, future components). See lib/browserPortalWatcher.ts.
  useEffect(() => {
    startPortalPopupWatcher();
  }, []);
  // When an agent browser tool opens/reuses a view, surface the browser panel
  // so the user sees the agent browsing and BrowserPanel can sync bounds.
  // Subscribed globally (not in BrowserPanel, which only mounts when the
  // browser tab is already active) so the panel switch happens even if the
  // right panel is currently on files/git. The view is adopted into the
  // renderer's tab list so BrowserPanel's show/hide/bounds logic manages it.
  //
  // The agent opens in the right sidebar (scrollable column) by default — a
  // desktop page renders at full width inside the sidebar; a phone page narrows
  // to the emulated viewport. The fullscreen overlay is never triggered
  // automatically: it's reserved for the user to open manually via the
  // "展开为 PC 全屏" button when they want more room.
  //
  // Respect the user's manual view-mode choice: if they've switched to the
  // fullscreen overlay, the agent must NOT yank them back to the sidebar. We
  // still adopt the tab so the overlay surfaces the agent's view, but leave
  // browserPanelOpen untouched. Only when the user is NOT in fullscreen do we
  // force the sidebar to own the view (isActive = !browserPanelOpen) and open
  // the right panel on the browser tab.
  // The device toolbar is auto-opened so the requested emulation takes effect
  // (collapsed = full-width desktop, ignoring the agent's device).
  useEffect(() => {
    const off = api.on.browserEvent((msg) => {
      if (msg.type !== "agentOpened") return;
      const p = (msg.payload as { url?: string; title?: string; device?: BrowserDevicePreset }) ?? {};
      const st = useSessionStore.getState();
      const createdNew = st.adoptAgentBrowserTab(msg.browserId, p);
      if (!st.browserPanelOpen) {
        // Not in fullscreen — bring up the sidebar to show the agent browsing.
        // The sidebar browser is a session-scoped tab: open it on the ACTIVE
        // session (the rail's "+" menu does the same).
        st.openSessionRightTab("browser");
        st.setRightOpen(true);
      }
      // Only auto-open the device toolbar for a brand-new agent tab, so the
      // requested emulation is visible. For an existing tab, preserve the
      // user's toolbar state — reopening it over their collapsed choice would
      // be surprising, and the user's device/size selection is preserved by
      // adoptAgentBrowserTab regardless.
      if (createdNew) {
        st.setBrowserDeviceToolbarOpen(true);
      }
    });
    return off;
  }, []);
  // Global keyboard shortcuts (Cmd+K palette, Cmd+B sidebar, etc.). Mounts a
  // single capture-phase window listener; rebinding in settings re-subscribes.
  useGlobalShortcuts();
  // Global mouse gestures (hold right button + drag). Same listener pattern;
  // detached entirely while disabled in settings.
  useMouseGestures();
  // Apply + keep in sync the color scheme (.dark on <html>).
  useTheme();
  // Apply + keep in sync the chat appearance CSS vars (--chat-font-size,
  // --user-bubble) from the user-configurable settings.
  useChatAppearance();
  // Apply + keep in sync the global side-panel + settings font-size CSS var
  // (--right-panel-font-size) for the left bar, right files/git/terminal
  // panels, and the settings page.
  useRightPanelAppearance();
  // Apply + keep in sync the theme STYLE (.sketch on <html>, orthogonal to
  // the light/dark scheme above) from the ui.themeStyle setting.
  useThemeStyle();

  const init = useSessionStore((s) => s.init);
  useEffect(() => {
    void init();
  }, [init]);

  /** Settings page visibility — opened from the LeftBar ⚙ footer, the
   *  CLI-missing CTA, or the model-dropdown "manage models" entry. Renders as
   *  a sibling view (not a modal) sharing the same titlebar + pane shell. */
  const settingsOpen = useSessionStore((s) => s.settingsOpen);
  const setSettingsOpen = useSessionStore((s) => s.setSettingsOpen);

  /** 定时任务只读查看页 — same full-bleed overlay form as the settings page
   *  (mutually exclusive with it; see setSchedPageOpen). */
  const schedPageOpen = useSessionStore((s) => s.schedPageOpen);
  const setSchedPageOpen = useSessionStore((s) => s.setSchedPageOpen);

  /** Left / right sidebar + bottom terminal visibility. Lifted from local
   *  useState into the store so the command palette (and any other consumer)
   *  can toggle them. Workspace-only — the settings view pins leftOpen=true /
   *  rightOpen=false. NOT persisted (matches original behavior). */
  const leftOpen = useSessionStore((s) => s.leftOpen);
  const leftBarMode = useSessionStore((s) => s.leftBarMode);
  const setLeftOpen = useSessionStore((s) => s.setLeftOpen);
  // Hover-peek drawer state (left panel floating over the workspace while
  // closed) + the browser-overlay gate for its trigger strip.
  const leftPeekOpen = useSessionStore((s) => s.leftPeekOpen);
  const setLeftPeekOpen = useSessionStore((s) => s.setLeftPeekOpen);
  const browserPanelOpen = useSessionStore((s) => s.browserPanelOpen);

  // ── Side-panel hover-peek drawers (left + right) ────────────────────────
  // Workspace visible + panel closed → the always-mounted aside flips from
  // in-flow to a fixed off-canvas drawer: hovering the window's edge floats
  // it in OVER the content (no layout shift); pinning stays on the toggle
  // buttons. Settings/sched pages keep both asides fully hidden.
  const leftDrawer = !leftOpen && !settingsOpen && !schedPageOpen;
  // Drawer-mode entry must not animate: the aside re-parents from in-flow
  // (or display:none) to fixed in a single commit, and a live transform
  // transition would replay a stale slide across the window. The first
  // drawer frame parks the panel off-canvas with transitions disabled; they
  // arm one frame later so peek open/close glide.
  const leftDrawerArmed = usePeekDrawerArmed(leftDrawer, setLeftPeekOpen);
  // Dismiss the drawer on mouse-leave after a short grace period (re-entering
  // cancels), so grazing onto the scrim doesn't flicker it shut. Clicking the
  // scrim dismisses immediately; opening cancels any pending close.
  const { schedule: scheduleLeftPeekClose, cancel: cancelLeftPeekClose } = usePeekAutoClose(
    leftPeekOpen,
    () => setLeftPeekOpen(false),
  );
  const openLeftPeek = () => {
    cancelLeftPeekClose();
    // The two drawers must never stack (both float over the workspace and
    // share the z-band) — opening one dismisses the other.
    setRightPeekOpen(false);
    setLeftPeekOpen(true);
  };
  const rightOpen = useSessionStore((s) => s.rightOpen);
  const setRightOpen = useSessionStore((s) => s.setRightOpen);
  // Right-panel hover-peek state — mirror of the left: hovering the window's
  // right edge floats the closed IDE panel in over the workspace.
  const rightPeekOpen = useSessionStore((s) => s.rightPeekOpen);
  const setRightPeekOpen = useSessionStore((s) => s.setRightPeekOpen);
  const rightDrawer = !rightOpen && !settingsOpen && !schedPageOpen;
  const rightDrawerArmed = usePeekDrawerArmed(rightDrawer, setRightPeekOpen);
  const { schedule: scheduleRightPeekClose, cancel: cancelRightPeekClose } = usePeekAutoClose(
    rightPeekOpen,
    () => setRightPeekOpen(false),
  );
  // Distinguish user peeks (trigger strip / scrim path) from store-driven
  // AUTO-peeks (a file opened while the panel was closed slides the drawer
  // in with the file preview). Only auto-peeks get the idle dismissal below.
  const rightPeekUserRef = useRef(false);
  const prevRightPeekRef = useRef(rightPeekOpen);
  const openRightPeek = () => {
    cancelRightPeekClose();
    rightPeekUserRef.current = true;
    setLeftPeekOpen(false);
    setRightPeekOpen(true);
  };
  useEffect(() => {
    const rose = rightPeekOpen && !prevRightPeekRef.current;
    prevRightPeekRef.current = rightPeekOpen;
    if (!rightPeekOpen) {
      rightPeekUserRef.current = false;
      return;
    }
    // Auto-peeked (no user gesture): the mouse may never enter the drawer,
    // so mouse-leave alone would leave it parked open over the workspace —
    // arm the idle window. A mouse-enter cancels it (ThreePaneLayout wires
    // cancelRightPeekClose), handing control to the normal leave-grace.
    if (rose && !rightPeekUserRef.current) {
      scheduleRightPeekClose(AUTO_PEEK_IDLE_MS);
    }
  }, [rightPeekOpen, scheduleRightPeekClose]);
  const rightPanelTab = useSessionStore((s) => s.rightPanelTab);
  const setRightPanelTab = useSessionStore((s) => s.setRightPanelTab);
  const widePanelOpen = useSessionStore((s) => s.widePanelOpen);
  // Wide-panel (3:7) split share + its resize/reset actions. The wide mode
  // reuses the layout's right aside (percentage width) instead of mounting a
  // second RightPanel inside the center column, so toggling wide never
  // unmounts the right panel (file tree, git scan, browser view ownership).
  const widePanelPct = useSessionStore((s) => s.widePanelPct);
  const adjustWidePanelPct = useSessionStore((s) => s.adjustWidePanelPct);
  const resetWidePanelPct = useSessionStore((s) => s.resetWidePanelPct);

  /** Draggable pane sizes + resize actions (from the store; persisted). */
  const leftWidthPct = useSessionStore((s) => s.leftWidthPct);
  const rightWidth = useSessionStore((s) => s.rightWidth);
  const bottomTerminalHeight = useSessionStore((s) => s.bottomTerminalHeight);
  const bottomTerminalOpen = useSessionStore((s) => s.bottomTerminalOpen);
  const terminalPosition = useSessionStore((s) => s.terminalPosition);
  const adjustLeftWidthPct = useSessionStore((s) => s.adjustLeftWidthPct);
  const adjustRightWidth = useSessionStore((s) => s.adjustRightWidth);
  const adjustBottomTerminalHeight = useSessionStore((s) => s.adjustBottomTerminalHeight);
  const resetLeftWidthPct = useSessionStore((s) => s.resetLeftWidthPct);
  const resetRightWidth = useSessionStore((s) => s.resetRightWidth);
  const resetBottomTerminalHeight = useSessionStore((s) => s.resetBottomTerminalHeight);

  /** Command palette + file search dialog visibility is driven by the
   *  global shortcut listener (useGlobalShortcuts) via store actions, so we
   *  no longer wire those keys here. */

  // Auto-open the right panel when something requests its attention (plain
  // openFileInIde calls; diff opens render in the center editor and
  // deliberately don't bump). The store can't reach into this local state,
  // so it bumps a nonce we watch here.
  const ideFocusNonce = useSessionStore((s) => s.ideFocusNonce);
  useEffect(() => {
    if (ideFocusNonce > 0) setRightOpen(true);
  }, [ideFocusNonce, setRightOpen]);

  // Root row ref — measures the full window width so the left divider's px
  // drag delta can be converted into percentage points of that width (the
  // sidebar share is percentage-based so the 3:7 split scales on resize).
  const rootRef = useRef<HTMLDivElement>(null);
  // Convert a px drag delta into a percentage-point delta of the window
  // width. The divider sits to the RIGHT of the sidebar, so the sign flip
  // (none needed here — dragging right widens) lives in adjustLeftWidthPct.
  // No rounding: the store keeps fractional percentages so the pane tracks
  // the cursor pixel-for-pixel (integer pcts ate sub-percent deltas).
  const handleLeftResize = (deltaPx: number) => {
    const el = rootRef.current;
    if (!el) return;
    const w = el.getBoundingClientRect().width;
    if (w <= 0) return;
    adjustLeftWidthPct((deltaPx / w) * 100);
  };
  // Wide mode: the layout's center|right divider drives the wide split. Same
  // px→percentage-points conversion as handleLeftResize — wide mode forces
  // the left sidebar closed (store guard), so the window width IS the layout
  // row width that widePanelPct is a share of. The sign flip (dragging right
  // shrinks the right panel) lives in adjustWidePanelPct.
  const handleWidePanelResize = (deltaPx: number) => {
    const el = rootRef.current;
    if (!el) return;
    const w = el.getBoundingClientRect().width;
    if (w <= 0) return;
    adjustWidePanelPct((deltaPx / w) * 100);
  };

  return (
    // bg-surface-muted (matching the sidebar/toolbar/track) so the left
    // divider's transparent 1px layout slot blends in — a bg-surface root
    // showed through it as a stray light/dark hairline cutting the frame.
    <div ref={rootRef} className="flex h-full w-full bg-surface-muted text-content">
      {/* Command palette + file search dialog overlay both workspace and
          settings views. The browser panel overlay mounts here too - it
          covers the workspace with a fixed inset overlay (z-40, below the
          z-50 dialogs so ConfirmDialog etc. still sit on top). */}
      <CommandPalette />
      <SearchDialog />
      {/* Send-time "尚未配置模型" guard (sendPrompt opens it when the active
          provider has no model configured). Root-mounted so it overlays both
          workspace and settings views. */}
      <ModelConfigPrompt />
      <BrowserPanel mode="overlay" />
      {/* Wide-mode plan dialog - mounts over the wide 3:7 workspace (fixed
          overlay below the titlebar) when a plan tab is open. Mounted here
          beside the browser overlay so it covers both the chat and right
          columns. Renders null when not applicable. */}
      <WidePlanDialog />
      {/*
        Left sidebar — spans the FULL window height. Its share of the width
        is a persisted percentage (default 20 ≈ a compact sidebar); the
        Divider below is draggable (invisible hairline — the sidebar and the
        toolbar/track share the same muted surface, a hairline would cut the
        continuous frame; the resize cursor is the affordance) and
        double-click resets to the default.
        Wide-panel mode forces leftOpen=false in the store — the aside then
        presents as the hover-peek DRAWER (fixed, parked off-canvas, still
        mounted), NOT unmounted, so neither toggling wide nor peeking ever
        cold-rebuilds the project tree / stream list (which would refetch
        sessions via IPC). While the settings view is open the aside is hidden
        via CSS too (stays mounted to preserve scroll) so settings renders
        FULL-WIDTH below the toolbar instead of only over the right column.
        bg-surface-muted matches the toolbar to the right and the panel track,
        so all three read as one continuous frame — no right-edge rounding;
        rounded-tl alone carries the window-corner arc on macOS.

        Drawer presentation (leftDrawer): the same element re-parents to a
        fixed overlay parked at -translate-x-full. Opening the peek glides it
        in with a soft sheet ease while a right-cast shadow blooms and the
        scrim below dims the workspace — it floats over the content with
        rounded right corners + a hairline, visually distinct from the pinned
        in-flow presentation. Transitions arm a frame after mode entry (see
        leftDrawerArmed) so parking never animates.

        Trigger strip (mounted only while the drawer is parked and the browser
        overlay doesn't own the workspace — its z-40 canvas would sit above
        the strip anyway): invisible 8px column; hovering starts the intent
        timer, clicking skips it. The scrim fades in with the drawer and takes
        over dismissal (click = close; the drawer also closes on mouse-leave
        with a grace period).
      */}
      {leftDrawer && !leftPeekOpen && !browserPanelOpen && (
        <LeftEdgePeekTrigger onActivate={openLeftPeek} />
      )}
      {leftDrawer && <PeekScrim active={leftPeekOpen} onClose={() => setLeftPeekOpen(false)} />}
      {/* Right-edge mirror of the trigger strip above (same intent delay +
          click-to-skip; see LeftPanelPeek.tsx). Gated the same way: not while
          a side peek is open, the browser overlay owns the workspace, or a
          fullscreen page covers the row. The right drawer itself is the
          layout's right aside in drawer mode (ThreePaneLayout props below). */}
      {rightDrawer && !rightPeekOpen && !browserPanelOpen && (
        <RightEdgePeekTrigger onActivate={openRightPeek} />
      )}
      {rightDrawer && (
        <PeekScrim active={rightPeekOpen} onClose={() => setRightPeekOpen(false)} />
      )}
      <aside
        onMouseEnter={leftPeekOpen ? cancelLeftPeekClose : undefined}
        // Explicit no-arg call: React passes the MouseEvent as the first
        // argument, and schedule's optional ms-override parameter would
        // swallow it as a grace duration.
        onMouseLeave={leftPeekOpen ? () => scheduleLeftPeekClose() : undefined}
        className={cn(
          // min-w-0 kills the flex `min-width: auto` content floor —
          // without it the widest nowrap row in LeftBar (e.g. a long
          // session title, which contributes its full text width to
          // min-content) propped the aside open no matter how small
          // leftWidthPct got.
          "flex h-full min-w-0 shrink flex-col rounded-tl-2xl bg-surface-muted",
          leftDrawer &&
            cn(
              // Drawer mode: fixed overlay parked off-canvas; the peek slides
              // it in over the workspace (z-[45], under the z-50 dialogs).
              // overflow-hidden clips content to the rounded right corners.
              "fixed left-0 top-0 z-[45] shrink-0 overflow-hidden",
              "rounded-r-2xl border-r border-edge-panel/60",
              leftDrawerArmed &&
                "transition-[transform,opacity,box-shadow] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]",
              leftPeekOpen
                ? "pointer-events-auto translate-x-0 opacity-100 shadow-[12px_0_48px_-12px_rgba(0,0,0,0.45)]"
                : "pointer-events-none -translate-x-full opacity-0",
            ),
          (settingsOpen || schedPageOpen) && "hidden",
        )}
        style={
          leftDrawer
            ? { width: `${leftWidthPct}%` }
            : { flexGrow: 0, flexBasis: `${leftWidthPct}%` }
        }
      >
        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* Left-bar view preference: classic project tree or the
              session-first stream. Both are pure renderers over the same
              store; switching keeps running turns untouched. */}
          {leftBarMode === "stream" ? <StreamSidebar /> : <LeftBar />}
        </div>
      </aside>
      {leftOpen && !settingsOpen && !schedPageOpen && (
        <Divider
          orientation="vertical"
          hideLine
          // z-20 lifts the invisible ±5px hit area above the center pane's
          // z-10 — without it the pane (later in DOM, same z) swallowed the
          // right half of the grab zone, leaving only the sidebar-side 5px.
          className="z-20"
          onResize={handleLeftResize}
          onDoubleClick={resetLeftWidthPct}
        />
      )}
      {/*
        Right column — the 7 of the 3:7 split: the toolbar (Titlebar) on top
        and the main panel below (center chat/editor pane + right IDE panel,
        plus the bottom terminal inside the center main).
      */}
      <div className="flex min-w-[600px] flex-1 flex-col">
        {/*
          Workspace shell is ALWAYS mounted — the settings view renders as an
          overlay on top of it, not as a mutually-exclusive sibling. This is
          critical: BottomTerminalBar (→ TerminalPanel → every TerminalView)
          lives inside ThreePaneLayout. A ternary swap `settingsOpen ?
          <Settings> : <Workspace>` would unmount the whole workspace subtree
          on every settings open, killing all live PTYs (TerminalView's
          cleanup calls api.terminal.kill) and destroying scrollback — and
          racing many concurrent pty.kill() calls on Windows occasionally
          crashes the main process. Keeping the workspace mounted preserves
          the carefully-built cross-project terminal keep-alive (see
          TerminalPanel.tsx) exactly as designed. The Titlebar below switches
          its mode + the settings overlay covers the main panel visually (the
          left sidebar stays visible alongside it).
        */}
        <Titlebar
          mode={settingsOpen ? "settings" : schedPageOpen ? "sched" : "workspace"}
          leftOpen={leftOpen}
          rightOpen={settingsOpen || schedPageOpen ? false : rightOpen}
          onBack={() => (settingsOpen ? setSettingsOpen(false) : setSchedPageOpen(false))}
          onToggleLeft={() => setLeftOpen(!leftOpen)}
          onToggleRight={() => setRightOpen(!rightOpen)}
        />
        {/* Main panel row — bg-surface-muted as the contrasting track so the
            center pane's rounded left-edge corners (in ThreePaneLayout)
            reveal this muted color through the notches and read as clean
            arcs. The left sidebar (bg-surface-muted) blends into the track
            on its side; the center pane (bg-surface) separates from the
            track by the flat color step alone (no shadow). */}
        <div className="relative flex min-h-0 flex-1 bg-surface-muted">
          {/*
            Center is ONE stable tree across wide mode (CenterPane takes the
            wide flag as a render variation) — the old ternary swap
            `<WidePanelSplit/> : <CenterPane/>` remounted every ChatPane
            (Tiptap, timeline) + the whole right panel on each toggle, which
            read as a lag. Wide mode only re-shapes the layout: the right
            aside switches to the percentage share (rightWidthPct) and stays
            open (setWidePanelOpen forces rightOpen=true on enter and
            restores the snapshot on exit), so RightPanel — file tree, git
            scan, browser view ownership — is never torn down.
          */}
          <ThreePaneLayout
            left={null}
            center={<CenterPane wide={widePanelOpen} />}
            right={<RightPanel />}
            leftOpen={false}
            rightOpen={rightOpen}
            rightWidth={rightWidth}
            rightWidthPct={widePanelOpen ? widePanelPct : undefined}
            rightPeekDrawer={rightDrawer}
            rightPeekArmed={rightDrawerArmed}
            rightPeekOpen={rightPeekOpen}
            onRightPeekMouseEnter={cancelRightPeekClose}
            onRightPeekMouseLeave={scheduleRightPeekClose}
            bottomTerminal={
              terminalPosition === "bottom" ? (
                <BottomTerminalBar active={bottomTerminalOpen} />
              ) : undefined
            }
            bottomTerminalOpen={terminalPosition === "bottom" && bottomTerminalOpen}
            bottomTerminalHeight={bottomTerminalHeight}
            onResizeBottomTerminal={adjustBottomTerminalHeight}
            onResetBottomTerminal={resetBottomTerminalHeight}
            onResizeRight={widePanelOpen ? handleWidePanelResize : adjustRightWidth}
            onResetRight={widePanelOpen ? resetWidePanelPct : resetRightWidth}
          />
          {/* Git diff dialog (the "dialog" open-mode). Portaled to <body>;
              renders nothing when closed or empty. Mounted at the workspace
              level so it overlays the editor while staying app-scoped.
              Lazy-loaded with monaco since it reuses the Monaco DiffPane. */}
          <Suspense fallback={null}>
            <GitDiffDialog />
          </Suspense>
          {/*
            Settings overlay — renders on top of the always-mounted workspace
            shell, FULL-WIDTH: the left aside above is CSS-hidden while
            settings is open, so this overlay (inset-0 of the panel row, which
            now spans the whole window) covers everything below the toolbar.
            The workspace still mounts underneath, keeping terminals alive,
            just not visible. bg-surface-muted is opaque (no bleed-through)
            and doubles as the settings "track": it shows through the content
            pane's rounded-tl/bl notches so the settings arcs read exactly
            like the workspace center pane against its frame.
            `flex` is required: SettingsPage reuses
            ThreePaneLayout, whose left <aside> + center <main> are sibling
            nodes laid out horizontally by a flex parent. Without flex the
            <main> collapses to height 0 and the settings content never
            renders.
          */}
          {settingsOpen && (
            <div className="settings-root absolute inset-0 z-30 flex bg-surface-muted">
              <SettingsPage />
            </div>
          )}
          {/* 定时任务查看页(只读) — same full-bleed overlay form as the
              settings overlay above: covers the whole panel row (the left
              aside is CSS-hidden while it's open), workspace stays mounted
              underneath. Exclusivity with settings is enforced in the store
              actions, so at most one of the two overlays is ever mounted. */}
          {schedPageOpen && (
            <div className="absolute inset-0 z-30 flex bg-surface-muted">
              <SchedPage />
            </div>
          )}
        </div>
      </div>
      {/* Global bottom-right corner: update notification card + runtime
          reminder card + toast stack share one fixed column so they stack
          vertically and never overlap. All render null when they have
          nothing to show. The column sits exactly over the right panel's
          browser stage, so while it has content the browser view is
          suppressed geometry-aware (CornerOverlayColumn below). */}
      <CornerOverlayColumn>
        <UpdateNotification />
        {/* Non-blocking runtime-update reminder: surfaced once per launch by
            reloadRuntimes when an installed runtime lags this build's pin. */}
        <RuntimeUpdatePrompt />
        <Toaster />
      </CornerOverlayColumn>
      {/* Global voice-dictation indicator - floats top-center while any
          composer is listening. Renders null when idle. */}
      <VoiceListeningOverlay />
    </div>
  );
}

/** Bottom-right corner column with browser-view suppression. The OS-level
 *  browser view floats above all DOM and this corner is exactly where the
 *  sidebar browser stage lives, so toasts/update cards would be swallowed.
 *  Content visibility is tracked with a ResizeObserver (the container is
 *  always mounted but zero-sized while all children render null) — the
 *  suppression hook only engages once there is something to show, and stays
 *  geometry-aware so a toast can't fully blank the browser panel either. */
function CornerOverlayColumn({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [hasContent, setHasContent] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setHasContent(r.width > 1 && r.height > 1);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useSuppressBrowserView(hasContent, ref);
  return (
    <div
      ref={ref}
      className="pointer-events-none fixed bottom-4 right-4 z-[9999] flex flex-col items-end gap-2"
    >
      {children}
    </div>
  );
}

/** Center pane router. `tabs` displayMode renders the UNIFIED tab bar —
 *  session tabs and editor file tabs share ONE strip, and whichever tab is
 *  active (chat or editor) takes the full center width (no split). `single`
 *  mode keeps the legacy layout: a horizontal split between the chat column
 *  (left) and the file-editor column (right), where the editor column only
 *  appears when a file or plan tab is open (see the design notes in
 *  docs/tech-stack.md).
 *
 *  `wide` (wide-panel 3:7 mode) is a RENDER VARIATION, not a different tree:
 *  the same components stay mounted and only the editor surface is hidden
 *  (the plan opens as the WidePlanDialog overlay instead). Toggling wide is
 *  a relayout, never a remount — the chat panes (Tiptap composers, scroll,
 *  drafts) and everything else below this point survive the toggle. */
function CenterPane({ wide }: { wide: boolean }) {
  const displayMode = useSessionStore((s) => s.displayMode);
  if (displayMode === "tabs") {
    return <UnifiedTabbedPane wide={wide} />;
  }
  return <SplitCenterPane wide={wide} />;
}

/** Per-tab surface router: a kind="terminal" session renders the PTY pane
 *  (user's own Claude CLI in TTY mode) instead of ChatPane. Keep-alive
 *  semantics are identical — the pane mounts once per tab and hides via CSS,
 *  so the terminal (and its PTY) survive focus flips. */
function SessionSurface({ sessionId, isActive }: { sessionId: string; isActive: boolean }) {
  const kind = useSessionStore((s) => selectSessionKind(s, sessionId));
  if (kind === "terminal") {
    return <TerminalSessionPane sessionId={sessionId} isActive={isActive} />;
  }
  return <ChatPane sessionId={sessionId} isActive={isActive} />;
}

/** `tabs` displayMode: ONE tab bar (UnifiedTabsBar) mixing session tabs and
 *  file tabs, with the active tab's content filling the whole center width.
 *  The chat|editor split is gone — that's the point (maximum reading space
 *  for whichever view is active). All open tabs' ChatPanes stay mounted and
 *  are backgrounded via CSS (`hidden`) so drafts / scroll / undo survive
 *  focus flips (same keep-alive trick the old tabs-mode chat column used);
 *  the editor column mounts only while an editor tab holds the focus.
 *
 *  In wide mode the editor has no surface (the plan opens as the
 *  WidePlanDialog overlay instead), so the strip swaps to the session-only
 *  SessionTabs (file tabs would be dead controls) and an editor tab holding
 *  the focus keeps its host mounted but `hidden` — the editor host is a
 *  SIBLING of the pane host, so the strip swap and the hide never remount
 *  the ChatPanes below. Monaco therefore survives the wide toggle and
 *  re-shows instantly on exit. */
function UnifiedTabbedPane({ wide }: { wide: boolean }) {
  // The active file is scoped to the active project - switching projects
  // swaps to that project's open files (or hides the editor if none).
  const activeProjectId = useSessionStore((s) => s.activeProjectId);
  const activeFile = useSessionStore((s) =>
    activeProjectId ? s.ideActiveFileByProject[activeProjectId] ?? null : null,
  );
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const openTabs = useSessionStore((s) => s.openTabs);
  const planTabActive = useSessionStore(
    (s) => (activeSessionId ? s.planTabActiveBySession[activeSessionId] ?? false : false),
  );
  const centerTabFocus = useSessionStore((s) => s.centerTabFocus);
  const tabsFilePreviewPlacement = useSessionStore((s) => s.tabsFilePreviewPlacement);
  // Per-tab split groups (tabs displayMode): the ACTIVE tab's grid replaces
  // its plain pane — the split lives INSIDE the tab, other tabs and the
  // strip are untouched. The focused session may be a non-tab member pane,
  // so the active TAB is resolved through the groups.
  const splitGroupsBySession = useSessionStore((s) => s.splitGroupsBySession);
  const activeTabId = (() => {
    const a = activeSessionId;
    if (a && openTabs.includes(a)) return a;
    if (a) {
      for (const [root, members] of Object.entries(splitGroupsBySession)) {
        if (members.includes(a)) return root;
      }
    }
    return null;
  })();
  const activeGroup = activeTabId ? splitGroupsBySession[activeTabId] : undefined;
  const showSplitGrid = !!activeGroup && activeGroup.length >= 2;
  // The editor owns the content area only while focused AND it has content.
  // In `tabs` displayMode with `sidebar` placement, file preview lives in the
  // right sidebar's dual-column preview, so the center pane keeps the chat view.
  const showEditor =
    centerTabFocus === "editor" &&
    ((!!activeFile && tabsFilePreviewPlacement !== "sidebar") || planTabActive);
  // Wide mode: only a FILE editor stays mounted (hidden keep-alive). A plan
  // tab's surface is owned by the WidePlanDialog overlay — keeping a second
  // hidden PlanViewer here would double the markdown/Monaco work on every
  // streamed plan update. Visible only when not wide; the chat pane is the
  // wide-mode surface, matching isSessionChatOnScreen's wide semantics.
  const editorMounted = showEditor && !(wide && !activeFile);
  const editorVisible = showEditor && !wide;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {wide ? <SessionTabs /> : <UnifiedTabsBar />}
      {/* Split drag-in host: dropping a sidebar session below the tab bar
          splits the CURRENTLY OPEN tab in place (per-tab group) — the
          dragged session never becomes a tab. Only the content area is a
          target; the tab strip keeps its own dnd-kit reorder zone. */}
      <SplitDropHost className="relative min-h-0 flex-1">
        {showSplitGrid ? (
          <div className="absolute inset-0 flex min-h-0 flex-col">
            <SplitChatArea sessionIds={activeGroup} />
          </div>
        ) : (
          <>
          {openTabs.map((sid) => (
          <div
            key={sid}
            className={cn(
              "absolute inset-0",
              sid === activeSessionId && !editorVisible ? "" : "hidden",
            )}
          >
            <SessionSurface sessionId={sid} isActive={sid === activeSessionId && !editorVisible} />
          </div>
        ))}
        {editorMounted && (
          <div
            className={cn(
              "absolute inset-0 flex min-h-0 flex-col",
              !editorVisible && "hidden",
            )}
          >
            {/* hideTabsBar: the unified bar above already shows the file
                tabs — a second OpenTabsBar would duplicate them. In wide
                mode the strip is SessionTabs, and the hidden host renders
                no bar at all. */}
            <EditorColumn filePath={activeFile} hideTabsBar />
          </div>
        )}
          </>
        )}
      </SplitDropHost>
    </div>
  );
}

/** `single` displayMode: a horizontal split between the chat column (left)
 *  and the file-editor column (right). When no file is open the editor
 *  column is omitted and the chat column takes the full width — the layout
 *  the user sees when they haven't clicked any files yet. The editor column
 *  hosts the Monaco FileEditor + its own tab bar (OpenTabsBar), and is only
 *  rendered when `ideActiveFile` is non-null.
 *
 *  Wide mode CSS-hides the editor column (keep-alive) and lets the chat fill
 *  the center — the right panel lives in the layout's aside beside it. Both
 *  columns are siblings of the same flex row, so the hide is a class flip,
 *  never a remount. */
function SplitCenterPane({ wide }: { wide: boolean }) {
  // The active file is scoped to the active project - switching projects
  // swaps to that project's open files (or hides the editor if none).
  const activeProjectId = useSessionStore((s) => s.activeProjectId);
  const activeFile = useSessionStore((s) =>
    activeProjectId ? s.ideActiveFileByProject[activeProjectId] ?? null : null,
  );
  // Plan tab: the editor column is visible when a file tab is active OR the
  // plan tab is active. EditorColumn decides whether to render PlanViewer
  // (plan tab active) or FileEditor (file tab active) based on planTabActive.
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const planTabActive = useSessionStore(
    (s) => (activeSessionId ? s.planTabActiveBySession[activeSessionId] ?? false : false),
  );

  // In `single` displayMode, normal file previews are rendered in the right panel's
  // dual-column FilesPanel instead of splitting the center pane. The center pane only
  // splits for the plan tab (PlanViewer) when active.
  const editorMounted = planTabActive && !wide;
  const editorVisible = editorMounted;


  // Draggable chat|editor split. The editor column's share is a persisted
  // percentage; the chat column gets the remainder. The Divider reports a px
  // delta which we convert to a percentage delta using the container's
  // measured width (captured via ref on the split row).
  const editorWidthPct = useSessionStore((s) => s.editorWidthPct);
  const adjustEditorWidthPct = useSessionStore((s) => s.adjustEditorWidthPct);
  const resetEditorWidthPct = useSessionStore((s) => s.resetEditorWidthPct);
  const splitRef = useRef<HTMLDivElement>(null);

  // Convert a px drag delta into a percentage-point delta relative to the
  // container width. The divider sits to the LEFT of the editor column, so the
  // sign flip (growing the editor shrinks as the handle moves right) lives in
  // adjustEditorWidthPct — here we just translate px to percentage points.
  const handleEditorResize = (deltaPx: number) => {
    const el = splitRef.current;
    if (!el) return;
    const w = el.getBoundingClientRect().width;
    if (w <= 0) return;
    adjustEditorWidthPct((deltaPx / w) * 100);
  };

  return (
    <div ref={splitRef} className="flex h-full min-h-0">
      {/* Chat column - flex-basis is the remainder of the editor share so the
          two columns split the center pane proportionally. When no file is
          open and no plan is viewed it takes the full width (flex-1). */}
      <div
        className="flex min-w-[600px] shrink-0 flex-col"
        style={editorVisible ? { flexGrow: 0, flexBasis: `${100 - editorWidthPct}%` } : { flexGrow: 1, flexBasis: "0%" }}
      >

        <ChatColumn />
      </div>
      {/* Divider between chat and editor - only while the editor column is
          actually visible (a hidden keep-alive column gets no handle). */}
      {editorVisible && (
        <Divider
          orientation="vertical"
          onResize={handleEditorResize}
          onDoubleClick={resetEditorWidthPct}
        />
      )}
      {/* Editor column - mounted while a file or plan tab is open; wide mode
          keeps it mounted but `hidden` (flexBasis is inert under display:none,
          the chat's flexGrow:1 above takes the full width). */}
      {editorMounted && (
        <div
          className={cn(
            "flex min-w-0 flex-col border-l border-edge-panel bg-surface",
            !editorVisible && "hidden",
          )}
          style={{ flexGrow: 0, flexBasis: `${editorWidthPct}%` }}
        >
          <EditorColumn filePath={activeFile} />
        </div>
      )}
    </div>
  );
}

/** The chat half: SessionTabs strip (in tabs mode) + the active ChatPane.
 *
 *  Tabs mode keeps every OPEN tab's pane mounted, backgrounded via CSS
 *  (display:none) — pane lifetime is the user's own tab strip, and closeTab
 *  intentionally keeps the store buckets so re-opening shows the latest state.
 *
 *  Single mode mounts ONLY the active pane (单会话 = one live thread): the
 *  previous pane unmounts on every switch, and the session that ages out of
 *  the two-generation grace window (current + previous) gets its heavy store
 *  buckets pruned via `pruneSessionHistory` — loaded messages (incl. base64
 *  image blocks), turn-files cards, subagent transcripts, usage history. The
 *  grace window keeps A↔B ping-pong refetch-free (the previous session's
 *  store data survives; only the pane remounts), and anything older is fully
 *  destroyed: the next activation re-fetches the first page because
 *  selectSession/openTab gate on historyLoadedBySession. Sessions with a
 *  running turn or a pending question are never pruned (their live event
 *  stream, turn.done persistence, and the left-bar badge read those buckets)
 *  — they're deferred and retried on the next switch. */

/** Buckets kept alive in single mode: [previous, current], most recent last.
 *  Module-level so it survives ChatColumn re-mounts (mode switches). */
const singleModeGrace: string[] = [];
const SINGLE_MODE_GRACE = 2;
/** Eviction candidates deferred because the session was still live (running
 *  turn / pending question) at prune time. Retried on every switch. */
const singleModePruneRetry: string[] = [];
let lastChatColumnMode: "single" | "tabs" | null = null;

function ChatColumn() {
  const displayMode = useSessionStore((s) => s.displayMode);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const openTabs = useSessionStore((s) => s.openTabs);
  const splitSessionIds = useSessionStore((s) => s.splitSessionIds);

  // Single-mode memory policy driver (see the block comment above).
  useEffect(() => {
    if (displayMode !== "single") {
      lastChatColumnMode = displayMode;
      return;
    }
    if (lastChatColumnMode !== "single") {
      // Entering single mode: baseline the grace window at the incoming
      // session — its pane is the one being mounted right now.
      lastChatColumnMode = "single";
      singleModeGrace.length = 0;
      if (activeSessionId != null) singleModeGrace.push(activeSessionId);
      return;
    }
    if (activeSessionId == null) return;
    if (singleModeGrace[singleModeGrace.length - 1] === activeSessionId) return;
    singleModeGrace.push(activeSessionId);
    const candidates: string[] = [];
    while (singleModeGrace.length > SINGLE_MODE_GRACE) {
      candidates.push(singleModeGrace.shift()!);
    }
    candidates.push(...singleModePruneRetry.splice(0));
    if (candidates.length === 0) return;
    const s = useSessionStore.getState();
    for (const id of candidates) {
      if (id === activeSessionId || singleModeGrace.includes(id)) continue;
      // Split-view members are visibly mounted in the grid — exempt from
      // the grace-window eviction entirely (agreed policy: split panes stay
      // resident).
      if (s.splitSessionIds.includes(id)) continue;
      // Live threads keep their buckets: a running turn's events and its
      // turn.done persistence read messagesBySession, and a pending question
      // drives the left-bar/activity badge. Retry on the next switch.
      if (s.runningBySession[id] || s.pendingQuestionBySession[id]) {
        singleModePruneRetry.push(id);
        continue;
      }
      s.pruneSessionHistory(id);
    }
  }, [activeSessionId, displayMode]);

  // Tabs-mode memory hygiene: prune any resident session buckets whose tab has
  // been closed (and has no in-flight turn / pending question). Survives tab closures,
  // project switches, and archives without letting megabytes of base64 images linger.
  useEffect(() => {
    if (displayMode !== "tabs") return;
    const s = useSessionStore.getState();
    const openSet = new Set(openTabs);
    for (const id of Object.keys(s.messagesBySession)) {
      if (openSet.has(id)) continue;
      if (s.runningBySession[id] || s.pendingQuestionBySession[id]) continue;
      s.pruneSessionHistory(id);
    }
  }, [openTabs, displayMode]);

  if (displayMode === "tabs") {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <SessionTabs />
        <div className="relative min-h-0 flex-1">
          {openTabs.map((sid) => (
            <div
              key={sid}
              className={`absolute inset-0 ${sid === activeSessionId ? "" : "hidden"}`}
            >
              <SessionSurface sessionId={sid} isActive={sid === activeSessionId} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Split view (single displayMode, ≥ 2 members): every member pane mounts
  // simultaneously in the 2×2 grid with ONE shared composer strip below.
  // Split members never take the keyed-remount path below — their lifetime
  // is the grid, and the prune effect above exempts them.
  if (splitSessionIds.length >= 2) {
    return <SplitChatArea sessionIds={splitSessionIds} />;
  }

  // single mode: mount ONLY the active pane. The keyed div forces a full
  // remount on switch — that IS the destruction the mode promises. What the
  // user loses vs. the old 8-pane keep-alive is instant back-switching
  // (Tiptap re-init + timeline re-parse on return); the composer draft and
  // capsule state live in the store and survive, and the immediately
  // previous session's data stays in memory (grace window) so returning to
  // it doesn't even refetch.
  if (activeSessionId == null) {
    return <ChatPane sessionId={null} />;
  }
  return (
    <SplitDropHost className="relative min-h-0 flex-1">
      <div key={activeSessionId} className="absolute inset-0">
        <SessionSurface sessionId={activeSessionId} isActive />
      </div>
    </SplitDropHost>
  );
}

/** Drag-in host for the NON-split center: dragging a sidebar session over
 *  the center materializes the split grid around the currently open session
 *  (addToSplit seeds it as pane 1; from `tabs` displayMode it switches the
 *  mode first). Used by the plain single view AND UnifiedTabbedPane's
 *  content area. Same highlight contract as SplitChatArea's own drop
 *  handling. */
/** Drag-in host for the NON-split center. The drop is the split gesture in
 *  BOTH display modes (store-side mode dispatch): `single` seeds the global
 *  grid around the open session; `tabs` splits the currently open tab in
 *  place (per-tab group — the dragged session never becomes a tab). Used by
 *  the plain single view AND UnifiedTabbedPane's content area (the tab
 *  strip itself keeps its own dnd-kit reorder zone). */
function SplitDropHost({ className, children }: { className?: string; children: ReactNode }) {
  const addToSplit = useSessionStore((s) => s.addToSplit);
  const [dragOver, setDragOver] = useState(false);
  // One-shot ring pulse after a successful drop — acknowledges the landing
  // (styles.css `split-drop-flash`; cleared on animation end).
  const [flash, setFlash] = useState(false);
  return (
    <div
      className={cn(
        className,
        // Fade the highlight in/out (box-shadow = ring) + a faint tint.
        "transition-[box-shadow,background-color] duration-200",
        dragOver && "rounded-xl bg-accent/[0.04] ring-2 ring-inset ring-accent",
        flash && "rounded-xl split-drop-flash",
      )}
      onDragOver={(e) => {
        if (!isSessionDrag(e.dataTransfer.types)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
      }}
      onDrop={(e) => {
        const sid = getSessionDragPayload(e.dataTransfer);
        if (!sid) return;
        e.preventDefault();
        setDragOver(false);
        setFlash(true);
        void addToSplit(sid);
      }}
      onAnimationEnd={(e) => {
        // animationend bubbles — child animations (composer cards etc.)
        // must not clear the host's own flash.
        if (e.target === e.currentTarget) setFlash(false);
      }}
    >
      {children}
    </div>
  );
}

/** One cell of the split grid: mini header (provider icon + title + running
 *  dot + close) above the session surface. Click anywhere focuses the pane
 *  (= the normal activation chain, so composer slots / title bar / git /
 *  right panel all follow). The focused pane renders its composer column
 *  into the shared strip via the portal target; unfocused chat panes keep
 *  their column in place but hide the input (pending prompts still show —
 *  an unfocused pane's approval must stay visible and answerable). */
function SplitPaneCell({
  sessionId,
  focused,
  composerPortalTarget,
}: {
  sessionId: string;
  focused: boolean;
  composerPortalTarget: HTMLElement | null;
}) {
  const { t } = useI18n();
  const kind = useSessionStore((s) => selectSessionKind(s, sessionId));
  const session = useSessionStore((s) => s.getSessionById(sessionId));
  const isRunning = useSessionStore((s) => !!s.runningBySession[sessionId]);
  const removeFromSplit = useSessionStore((s) => s.removeFromSplit);
  // Pane focus = plain activation. Deliberately NOT openTab: in tabs mode a
  // member pane must NOT join the tab strip (the split lives inside one
  // tab); selectSession flips activeSessionId + hydrates without touching
  // openTabs.
  const selectSession = useSessionStore((s) => s.selectSession);
  const provider = getProviderIcon(session?.providerId);
  const ProviderIcon = provider.Icon;

  return (
    <section
      className={cn(
        // Rounded card, not a square tile: overflow-hidden clips the (rectangular)
        // session surface to the corners. The 聚焦描边 lives on the OVERLAY
        // below (not on this element) — see the ring note there.
        "relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl bg-surface",
      )}
      onPointerDown={() => {
        if (!focused) void selectSession(sessionId);
      }}
    >
      <header className="flex h-7 shrink-0 items-center gap-1.5 px-2">
        <ProviderIcon size={12} className={cn("shrink-0", provider.color || "text-content-subtle")} />
        <span className="min-w-0 flex-1 truncate text-[11px] text-content-muted">
          {session?.title ?? sessionId}
        </span>
        {isRunning && (
          <span
            className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent"
            title={t("layout.split.running")}
          />
        )}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            void removeFromSplit(sessionId);
          }}
          title={t("layout.split.closePane")}
          aria-label={t("layout.split.closePane")}
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-content-subtle transition-colors hover:bg-surface-muted hover:text-content"
        >
          <IconX size={12} />
        </button>
      </header>
      {/* Chat cells inset the scroll viewport from the card's bottom border
          (pb lives on the wrapper, so it's a fixed gutter — content scrolls
          ABOVE it, never clipping the rounded edge). The focused pane's
          composer is portaled out to the strip, and hidden composers on
          unfocused panes leave nothing below the stream, so without this
          messages ride flush against the border. Terminal cells fill
          naturally — no gutter there. */}
      <div className={cn("min-h-0 flex-1", kind !== "terminal" && "pb-3")}>
        {kind === "terminal" ? (
          <TerminalSessionPane sessionId={sessionId} isActive={focused} />
        ) : (
          <ChatPane
            sessionId={sessionId}
            isActive
            hideComposer={!focused}
            composerPortalTarget={focused ? composerPortalTarget : null}
          />
        )}
      </div>
      {/* 聚焦格描边 as a paint-last overlay, NOT an inset box-shadow on the
          section: inset rings paint UNDER child content, and the terminal
          pane's opaque full-bleed canvas completely covered them. This
          transparent layer re-draws the ring above everything; z-10 beats
          the panes (they carry no z-index), pointer-events-none keeps
          clicks/drag-through intact, and it inherits the rounded corners. */}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-0 z-10 rounded-xl",
          focused ? "ring-2 ring-inset ring-accent" : "ring-1 ring-inset ring-edge-panel",
        )}
      />
    </section>
  );
}

/** The split grid + the ONE shared full-width composer strip (single
 *  displayMode, ≥ 2 members). Grid shapes per the agreed spec: 2 panes =
 *  side-by-side single row; 3 = top row + bottom-left (grid auto-flow lands
 *  there naturally); 4 = full 2×2. The strip hosts the FOCUSED pane's
 *  composer column via ChatPane's portal prop — unfocused panes show their
 *  streams (and their own pending prompts) only. A focused TERMINAL pane
 *  collapses the strip: terminal input is the PTY itself. */
function SplitChatArea({ sessionIds }: { sessionIds: string[] }) {
  const addToSplit = useSessionStore((s) => s.addToSplit);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const [dragOver, setDragOver] = useState(false);
  // One-shot ring pulse after a successful drop (see SplitDropHost).
  const [flash, setFlash] = useState(false);
  const [stripEl, setStripEl] = useState<HTMLElement | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);
  // Layout effect + state (not the ref directly) so the focused pane's first
  // paint already carries the portal target — a plain ref read would leave
  // the composer rendered in-pane for one visible frame, and setState from
  // a layout effect re-renders synchronously BEFORE paint.
  useLayoutEffect(() => {
    setStripEl(stripRef.current);
  }, []);

  // Focus must be a grid member (the store maintains this invariant; the
  // fallback covers transient desync, e.g. a mid-flight session deletion).
  const focusedId =
    activeSessionId != null && sessionIds.includes(activeSessionId) ? activeSessionId : sessionIds[0];
  const focusedKind = useSessionStore((s) => selectSessionKind(s, focusedId));
  const stripHidden = focusedKind === "terminal";

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      onDragOver={(e) => {
        if (!isSessionDrag(e.dataTransfer.types)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
      }}
      onDrop={(e) => {
        const sid = getSessionDragPayload(e.dataTransfer);
        if (!sid) return;
        e.preventDefault();
        setDragOver(false);
        setFlash(true);
        // Guards live in the store: full grid / duplicate member / unknown
        // session are silently absorbed (agreed UX).
        void addToSplit(sid);
      }}
    >
      <div
        onAnimationEnd={(e) => {
          // animationend bubbles — ignore child animations.
          if (e.target === e.currentTarget) setFlash(false);
        }}
        className={cn(
          // gap + padding (not a 1px hairline backdrop) so the rounded cards
          // have breathing room at their corners.
          "grid min-h-0 flex-1 grid-cols-2 gap-1.5 p-1.5",
          // 2 panes share one full-height row; 3-4 fill the 2×2 grid.
          sessionIds.length <= 2 ? "grid-rows-1" : "grid-rows-2",
          // Highlight fades in/out while a session drag hovers.
          "transition-[box-shadow] duration-200",
          dragOver && "rounded-xl ring-2 ring-inset ring-accent",
          flash && "rounded-xl split-drop-flash",
        )}
      >
        {sessionIds.map((sid) => (
          <SplitPaneCell
            key={sid}
            sessionId={sid}
            focused={sid === focusedId}
            composerPortalTarget={sid === focusedId ? stripEl : null}
          />
        ))}
      </div>
      {/* Shared composer strip — the focused pane's composer column portals
          into this node (see ChatPane's composerPortalTarget). The portal
          moves the column OUT of its pane's [data-chat-root] scope, which is
          where every composer-card / minipill rule and the --chat-gutter
          variable live (styles.css) — without the attribute the pill renders
          styleless (segments concatenated). Same re-scope trick as
          AutomationEditor's dialog body. As its own inline-size container
          the strip also resolves the stepped gutter by ITS width (full grid
          width), matching how a wide pane measures. */}
      <div
        ref={stripRef}
        data-chat-root
        className={cn(
          "min-h-0 shrink-0 bg-surface",
          stripHidden && "hidden",
        )}
      />
    </div>
  );
}

/** Wide-mode plan viewer: the PlanViewer as a fullscreen dialog overlay. The
 *  wide 3:7 layout has no editor column, so a plan tab (set via openPlanDrawer)
 *  would otherwise render nowhere. Mirrors the mobile shell's fullscreen plan
 *  viewer, but reuses the desktop PlanViewer as-is (edit mode, 待审阅 badge,
 *  approval-draft save). While open the embedded browser view is suppressed —
 *  the OS-level WebContentsView would otherwise float above this DOM overlay. */
function WidePlanDialog() {
  const { t } = useI18n();
  const widePanelOpen = useSessionStore((s) => s.widePanelOpen);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const planTabActive = useSessionStore((s) =>
    activeSessionId ? (s.planTabActiveBySession[activeSessionId] ?? false) : false,
  );
  const planText = useSessionStore((s) =>
    activeSessionId ? (s.planDrawerPlanBySession[activeSessionId] ?? null) : null,
  );
  const planApprovalPending = useSessionStore((s) =>
    activeSessionId ? !!s.pendingPlanApprovalBySession[activeSessionId] : false,
  );
  const closePlanDrawer = useSessionStore((s) => s.closePlanDrawer);

  const open = widePanelOpen && planTabActive && !!planText;
  // Full-window DOM overlay: the browser view must hide while it's up (no
  // popup ref — the overlay always "overlaps").
  useSuppressBrowserView(open);

  if (!open) return null;
  return (
    <div className="fixed inset-x-0 top-10 bottom-0 z-50 flex flex-col bg-surface">
      <Suspense
        fallback={
          <div className="flex h-full items-center justify-center text-[11px] text-content-subtle">
            {t("layout.loadingPlan")}
          </div>
        }
      >
        <PlanViewer
          plan={planText!}
          sessionId={activeSessionId!}
          isApprovalPending={planApprovalPending}
          onClose={() => activeSessionId && closePlanDrawer(activeSessionId)}
        />
      </Suspense>
    </div>
  );
}

/** The editor half: OpenTabsBar (only in tabs editor-mode, and not when
 *  `hideTabsBar` — the unified center bar passes that since it already
 *  renders the file tabs) + the active tab's content. Resolves the project
 *  path from the active project so FileEditor can show relative paths in
 *  its toolbar. When the plan tab is active, renders PlanViewer instead of
 *  FileEditor. */
function EditorColumn({
  filePath,
  hideTabsBar = false,
}: {
  filePath: string | null;
  hideTabsBar?: boolean;
}) {
  const { t } = useI18n();
  const editorMode = useSessionStore((s) => s.ideEditorMode);
  const activeProjectId = useSessionStore((s) => s.activeProjectId);
  const projects = useSessionStore((s) => s.projects);

  // Plan tab state: when planTabActive is true and there's plan text, render
  // PlanViewer instead of FileEditor.
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const planText = useSessionStore(
    (s) => (activeSessionId ? s.planDrawerPlanBySession[activeSessionId] ?? null : null),
  );
  const planTabActive = useSessionStore(
    (s) => (activeSessionId ? s.planTabActiveBySession[activeSessionId] ?? false : false),
  );
  // Whether an ExitPlanMode approval is pending for this session - passed to
  // PlanViewer so its save action knows to stage the draft for the approval
  // sheet (vs. just updating the local view for a historical plan).
  const planApprovalPending = useSessionStore(
    (s) => (activeSessionId ? !!s.pendingPlanApprovalBySession[activeSessionId] : false),
  );
  const closePlanDrawer = useSessionStore((s) => s.closePlanDrawer);

  const showPlan = planTabActive && !!planText;

  const projectPath = useMemo(() => {
    if (!activeProjectId) return null;
    return projects.find((p) => p.id === activeProjectId)?.path ?? null;
  }, [activeProjectId, projects]);

  return (
    <>
      {!hideTabsBar && editorMode === "tabs" && <OpenTabsBar />}
      <div className="min-h-0 flex-1">
        {showPlan ? (
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center gap-1.5 text-[11px] text-content-subtle">
                {t("layout.loadingEditor")}
              </div>
            }
          >
            <PlanViewer
              plan={planText!}
              sessionId={activeSessionId!}
              isApprovalPending={planApprovalPending}
              onClose={() => activeSessionId && closePlanDrawer(activeSessionId)}
            />
          </Suspense>
        ) : filePath && projectPath ? (
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center gap-1.5 text-[11px] text-content-subtle">
                {t("layout.loadingEditor")}
              </div>
            }
          >
            {/* NOT keyed by filePath: the editor is persistent and swaps
                models on file switches (see EditPane / editorModelCache) —
                a full remount per file would stutter. */}
            <FileEditor filePath={filePath} projectPath={projectPath} />
          </Suspense>
        ) : (
          <div className="flex h-full items-center justify-center text-[11px] text-content-subtle">
            {t("layout.noProjectPath")}
          </div>
        )}
      </div>
    </>
  );
}
