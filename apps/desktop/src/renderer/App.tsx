import { lazy, Suspense, useEffect, useMemo, useRef } from "react";
import { cn } from "@renderer/lib/cn.js";
import { ThreePaneLayout } from "./components/layout/ThreePaneLayout.js";
import { Divider } from "./components/layout/Divider.js";
import { Titlebar } from "./components/layout/Titlebar.js";
import { LeftBar } from "./components/layout/LeftBar.js";
import { StreamSidebar } from "./components/layout/StreamSidebar.js";
import { ChatPane } from "./components/chat/ChatPane.js";
import { SessionTabs } from "./components/layout/SessionTabs.js";
import { UnifiedTabsBar } from "./components/layout/UnifiedTabsBar.js";
import { RightPanel } from "./components/layout/RightPanel.js";
import { BottomTerminalBar } from "./components/layout/BottomTerminalBar.js";
import { SettingsPage } from "./components/settings/SettingsPage.js";
import { CommandPalette } from "./components/layout/CommandPalette.js";
import { SearchDialog } from "./components/ide/SearchDialog.js";
import { ModelConfigPrompt } from "./components/chat/ModelConfigPrompt.js";
import { BrowserPanel } from "./components/browser/BrowserPanel.js";
import { Toaster } from "./components/layout/Toaster.js";
import { UpdateNotification } from "./components/layout/UpdateNotification.js";
import { VoiceListeningOverlay } from "./components/layout/VoiceListeningOverlay.js";
import { useClaudeEvents } from "./hooks/useClaudeEvents.js";
import { useGlobalShortcuts } from "./hooks/useGlobalShortcuts.js";
import { useSessionStore } from "./stores/sessionStore.js";
import type { BrowserDevicePreset } from "@contracts/ipc";
import { api } from "./lib/api.js";
import { useTheme } from "./lib/theme.js";
import { useChatAppearance, useRightPanelAppearance } from "./lib/appearance.js";
import { useI18n } from "./lib/i18n/index.js";
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

export function App() {
  // Subscribe to the claude event stream for the app's whole lifetime.
  useClaudeEvents();
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
        st.setRightPanelTab("browser");
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
  // Apply + keep in sync the color scheme (.dark on <html>).
  useTheme();
  // Apply + keep in sync the chat appearance CSS vars (--chat-font-size,
  // --user-bubble) from the user-configurable settings.
  useChatAppearance();
  // Apply + keep in sync the global side-panel + settings font-size CSS var
  // (--right-panel-font-size) for the left bar, right files/git/terminal
  // panels, and the settings page.
  useRightPanelAppearance();

  const init = useSessionStore((s) => s.init);
  useEffect(() => {
    void init();
  }, [init]);

  /** Settings page visibility — opened from the LeftBar ⚙ footer, the
   *  CLI-missing CTA, or the model-dropdown "manage models" entry. Renders as
   *  a sibling view (not a modal) sharing the same titlebar + pane shell. */
  const settingsOpen = useSessionStore((s) => s.settingsOpen);
  const setSettingsOpen = useSessionStore((s) => s.setSettingsOpen);

  /** Left / right sidebar + bottom terminal visibility. Lifted from local
   *  useState into the store so the command palette (and any other consumer)
   *  can toggle them. Workspace-only — the settings view pins leftOpen=true /
   *  rightOpen=false. NOT persisted (matches original behavior). */
  const leftOpen = useSessionStore((s) => s.leftOpen);
  const leftBarMode = useSessionStore((s) => s.leftBarMode);
  const setLeftOpen = useSessionStore((s) => s.setLeftOpen);
  const rightOpen = useSessionStore((s) => s.rightOpen);
  const setRightOpen = useSessionStore((s) => s.setRightOpen);
  const bottomTerminalOpen = useSessionStore((s) => s.bottomTerminalOpen);
  const setBottomTerminalOpen = useSessionStore((s) => s.setBottomTerminalOpen);
  const widePanelOpen = useSessionStore((s) => s.widePanelOpen);

  /** Draggable pane sizes + resize actions (from the store; persisted). */
  const leftWidthPct = useSessionStore((s) => s.leftWidthPct);
  const rightWidth = useSessionStore((s) => s.rightWidth);
  const bottomTerminalHeight = useSessionStore((s) => s.bottomTerminalHeight);
  const adjustLeftWidthPct = useSessionStore((s) => s.adjustLeftWidthPct);
  const adjustRightWidth = useSessionStore((s) => s.adjustRightWidth);
  const adjustBottomTerminalHeight = useSessionStore((s) => s.adjustBottomTerminalHeight);
  const resetLeftWidthPct = useSessionStore((s) => s.resetLeftWidthPct);
  const resetRightWidth = useSessionStore((s) => s.resetRightWidth);
  const resetBottomTerminalHeight = useSessionStore((s) => s.resetBottomTerminalHeight);

  /** Command palette + file search dialog visibility is driven by the
   *  global shortcut listener (useGlobalShortcuts) via store actions, so we
   *  no longer wire those keys here. */

  // Auto-open the right panel when something requests its attention (the
  // 审查 button on a turn-files card, or any openFileInIde call). The store
  // can't reach into this local state, so it bumps a nonce we watch here.
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
        is a persisted percentage (default 12 ≈ a compact ~259px sidebar on a
        2160px window); the Divider below is draggable (invisible hairline —
        the sidebar and the toolbar/track share the same muted surface, a
        hairline would cut the continuous frame; the resize cursor is the
        affordance) and double-click resets to the default. Wide-panel mode
        forces leftOpen=false in the store, so the aside hides itself without
        special-casing here. While the settings view is open the aside is
        hidden via CSS (`hidden`, stays mounted to preserve scroll) so
        settings renders FULL-WIDTH below the toolbar instead of only over
        the right column.
        bg-surface-muted matches the toolbar to the right and the panel track,
        so all three read as one continuous frame — no right-edge rounding;
        rounded-tl alone carries the window-corner arc on macOS.
      */}
      {leftOpen && (
        <aside
          className={cn(
            // min-w-0 kills the flex `min-width: auto` content floor —
            // without it the widest nowrap row in LeftBar (e.g. a long
            // session title, which contributes its full text width to
            // min-content) propped the aside open no matter how small
            // leftWidthPct got.
            "flex h-full min-w-0 shrink-0 flex-col rounded-tl-3xl bg-surface-muted",
            settingsOpen && "hidden",
          )}
          style={{ flexGrow: 0, flexBasis: `${leftWidthPct}%` }}
        >
          <div className="min-h-0 flex-1 overflow-y-auto">
            {/* Left-bar view preference: classic project tree or the
                session-first stream. Both are pure renderers over the same
                store; switching keeps running turns untouched. */}
            {leftBarMode === "stream" ? <StreamSidebar /> : <LeftBar />}
          </div>
        </aside>
      )}
      {leftOpen && !settingsOpen && (
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
      <div className="flex min-w-0 flex-1 flex-col">
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
          mode={settingsOpen ? "settings" : "workspace"}
          leftOpen={leftOpen}
          rightOpen={settingsOpen ? false : rightOpen}
          bottomTerminalOpen={settingsOpen ? false : bottomTerminalOpen}
          onBack={() => setSettingsOpen(false)}
          onToggleLeft={() => setLeftOpen(!leftOpen)}
          onToggleRight={() => setRightOpen(!rightOpen)}
          onToggleBottomTerminal={() => setBottomTerminalOpen(!bottomTerminalOpen)}
        />
        {/* Main panel row — bg-surface-muted as the contrasting track so the
            center pane's rounded left-edge corners (in ThreePaneLayout)
            reveal this muted color through the notches and read as clean
            arcs. The left sidebar (bg-surface-muted) blends into the track
            on its side; the center pane (bg-surface) separates from the
            track by the flat color step alone (no shadow). */}
        <div className="relative flex min-h-0 flex-1 bg-surface-muted">
          <ThreePaneLayout
            left={null}
            center={widePanelOpen ? <WidePanelSplit /> : <CenterPane />}
            right={<RightPanel />}
            leftOpen={false}
            rightOpen={widePanelOpen ? false : rightOpen}
            bottomTerminal={<BottomTerminalBar active={bottomTerminalOpen} />}
            bottomTerminalOpen={bottomTerminalOpen}
            rightWidth={rightWidth}
            bottomTerminalHeight={bottomTerminalHeight}
            onResizeRight={adjustRightWidth}
            onResizeBottomTerminal={adjustBottomTerminalHeight}
            onResetRight={resetRightWidth}
            onResetBottomTerminal={resetBottomTerminalHeight}
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
        </div>
      </div>
      {/* Global bottom-right corner: update notification card + toast stack
          share one fixed column so they stack vertically and never overlap.
          Both render null when they have nothing to show. */}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[9999] flex flex-col items-end gap-2">
        <UpdateNotification />
        <Toaster />
      </div>
      {/* Global voice-dictation indicator - floats top-center while any
          composer is listening. Renders null when idle. */}
      <VoiceListeningOverlay />
    </div>
  );
}

/** Center pane router. `tabs` displayMode renders the UNIFIED tab bar —
 *  session tabs and editor file tabs share ONE strip, and whichever tab is
 *  active (chat or editor) takes the full center width (no split). `single`
 *  mode keeps the legacy layout: a horizontal split between the chat column
 *  (left) and the file-editor column (right), where the editor column only
 *  appears when a file or plan tab is open (see the design notes in
 *  docs/tech-stack.md). */
function CenterPane() {
  const displayMode = useSessionStore((s) => s.displayMode);
  if (displayMode === "tabs") {
    return <UnifiedTabbedPane />;
  }
  return <SplitCenterPane />;
}

/** `tabs` displayMode: ONE tab bar (UnifiedTabsBar) mixing session tabs and
 *  file tabs, with the active tab's content filling the whole center width.
 *  The chat|editor split is gone — that's the point (maximum reading space
 *  for whichever view is active). All open tabs' ChatPanes stay mounted and
 *  are backgrounded via CSS (`hidden`) so drafts / scroll / undo survive
 *  focus flips (same keep-alive trick the old tabs-mode chat column used);
 *  the editor column mounts only while an editor tab holds the focus. */
function UnifiedTabbedPane() {
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
  // The editor owns the content area only while focused AND it has content.
  // The content check makes a stale "editor" focus (e.g. the last file was
  // closed by a path that didn't recompute the flag) fall back to the chat
  // instead of showing an empty editor.
  const showEditor = centerTabFocus === "editor" && (!!activeFile || planTabActive);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <UnifiedTabsBar />
      <div className="relative min-h-0 flex-1">
        {openTabs.map((sid) => (
          <div
            key={sid}
            className={cn(
              "absolute inset-0",
              sid === activeSessionId && !showEditor ? "" : "hidden",
            )}
          >
            <ChatPane sessionId={sid} isActive={sid === activeSessionId && !showEditor} />
          </div>
        ))}
        {showEditor && (
          <div className="absolute inset-0 flex min-h-0 flex-col">
            {/* hideTabsBar: the unified bar above already shows the file
                tabs — a second OpenTabsBar would duplicate them. */}
            <EditorColumn filePath={activeFile} hideTabsBar />
          </div>
        )}
      </div>
    </div>
  );
}

/** `single` displayMode: a horizontal split between the chat column (left)
 *  and the file-editor column (right). When no file is open the editor
 *  column is omitted and the chat column takes the full width — the layout
 *  the user sees when they haven't clicked any files yet. The editor column
 *  hosts the Monaco FileEditor + its own tab bar (OpenTabsBar), and is only
 *  rendered when `ideActiveFile` is non-null. */
function SplitCenterPane() {
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

  // The editor column is visible when EITHER a file is active OR the plan tab
  // is active. (The plan tab's mere existence in the bar doesn't force the
  // editor visible - only when it's the active tab.)
  const editorVisible = !!activeFile || planTabActive;

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
        className="flex min-w-0 flex-col"
        style={editorVisible ? { flexGrow: 0, flexBasis: `${100 - editorWidthPct}%` } : { flexGrow: 1, flexBasis: "0%" }}
      >
        <ChatColumn />
      </div>
      {/* Divider between chat and editor - only when the editor column is
          visible (a file or plan is active). */}
      {editorVisible && (
        <Divider
          orientation="vertical"
          onResize={handleEditorResize}
          onDoubleClick={resetEditorWidthPct}
        />
      )}
      {/* Editor column - visible when a file or plan tab is open. Always
          rendered through EditorColumn (which includes the tab bar + either
          FileEditor or PlanViewer based on which tab is active). */}
      {editorVisible && (
        <div
          className="flex min-w-0 flex-col border-l border-edge-panel bg-surface"
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
 *  BOTH display modes keep every pane in the keep-alive bucket mounted and
 *  background the inactive ones via CSS (display:none). This keeps each
 *  pane's composer draft, scroll position, and Tiptap undo history alive
 *  across switches — switching is a visibility swap instead of re-mounting
 *  and re-measuring, so a left-bar click lands instantly. Events still
 *  stream into backgrounded panes (they read their own session bucket).
 *  Closing a tab removes its id from openTabs, letting React unmount it.
 *  Tabs mode shows the bucket in the SessionTabs strip; single mode has no
 *  strip, so the bucket self-prunes: only the active session plus the most
 *  recently TOUCHED ones stay mounted (see keepAliveOrder). */

/** LRU of recently-activated sessions for single mode's keep-alive window.
 *  Module-level so it survives ChatColumn re-mounts (mode switches). Tabs
 *  mode doesn't consult it — its bucket is the user's own tab strip. */
const keepAliveOrder: string[] = [];
const KEEP_ALIVE_MAX = 8;

function ChatColumn() {
  const displayMode = useSessionStore((s) => s.displayMode);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const openTabs = useSessionStore((s) => s.openTabs);

  // Touch the LRU whenever the foreground session changes (single-mode
  // window membership follows usage, not just open order).
  useEffect(() => {
    if (activeSessionId == null) return;
    const i = keepAliveOrder.indexOf(activeSessionId);
    if (i >= 0) keepAliveOrder.splice(i, 1);
    keepAliveOrder.push(activeSessionId);
    if (keepAliveOrder.length > KEEP_ALIVE_MAX * 2) {
      keepAliveOrder.splice(0, keepAliveOrder.length - KEEP_ALIVE_MAX * 2);
    }
  }, [activeSessionId]);

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
              <ChatPane sessionId={sid} isActive={sid === activeSessionId} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  // single mode: same keep-alive structure, no tab strip. Without it the
  // keyed remount (`key={activeSessionId}`) tore down and rebuilt the whole
  // ChatPane on every left-bar switch — composer Tiptap re-init, full
  // timeline re-parse — which read as a lag before the new session appeared.
  //
  // Mounted set = the active session (always — defends against a path that
  // activates a session without adding it to openTabs; the tabs branch makes
  // the same assumption the other way) + the most recently touched ones that
  // are still in openTabs (the filter hands pane lifetime to openTabs'
  // delete/archive cleanup, so panes of removed sessions unmount instead of
  // lingering here). Sessions pushed out of the window unmount and re-mount
  // cold on their next visit — same cost as the old keyed remount, so the
  // window can only ever improve on the baseline.
  if (activeSessionId == null) {
    return <ChatPane sessionId={null} />;
  }
  const keepAlive = keepAliveOrder
    .slice(-KEEP_ALIVE_MAX)
    .filter((sid) => sid !== activeSessionId && openTabs.includes(sid));
  const panes = [activeSessionId, ...keepAlive];
  return (
    <div className="relative min-h-0 flex-1">
      {panes.map((sid) => (
        <div
          key={sid}
          className={`absolute inset-0 ${sid === activeSessionId ? "" : "hidden"}`}
        >
          <ChatPane sessionId={sid} isActive={sid === activeSessionId} />
        </div>
      ))}
    </div>
  );
}

/** Wide-panel (3:7) split — the chat column (3) on the left and the full
 *  right panel (7) on the right, shown while `widePanelOpen`. Replaces the
 *  ThreePaneLayout center+right composition entirely: the left sidebar is
 *  hidden and the center editor column never renders here. The split is
 *  draggable (percentage-based, same pattern as the chat|editor split);
 *  double-click resets to the default 3:7. */
function WidePanelSplit() {
  const widePanelPct = useSessionStore((s) => s.widePanelPct);
  const rightOpen = useSessionStore((s) => s.rightOpen);
  const adjustWidePanelPct = useSessionStore((s) => s.adjustWidePanelPct);
  const resetWidePanelPct = useSessionStore((s) => s.resetWidePanelPct);
  const splitRef = useRef<HTMLDivElement>(null);

  // Convert a px drag delta into a percentage-point delta relative to the
  // container width (the sign flip lives in adjustWidePanelPct).
  const handleResize = (deltaPx: number) => {
    const el = splitRef.current;
    if (!el) return;
    const w = el.getBoundingClientRect().width;
    if (w <= 0) return;
    adjustWidePanelPct((deltaPx / w) * 100);
  };

  // The titlebar right-panel toggle drives `rightOpen`. While hidden in wide
  // mode the right column is omitted and the chat takes the full width.
  if (!rightOpen) {
    return (
      <div ref={splitRef} className="flex h-full min-h-0">
        <div className="flex min-w-0 flex-1 flex-col">
          <ChatColumn />
        </div>
      </div>
    );
  }

  return (
    <div ref={splitRef} className="flex h-full min-h-0">
      {/* Chat column - the left share. ChatColumn keeps its single/tabs mode. */}
      <div
        className="flex min-w-0 flex-col"
        style={{ flexGrow: 0, flexBasis: `${100 - widePanelPct}%` }}
      >
        <ChatColumn />
      </div>
      <Divider
        orientation="vertical"
        onResize={handleResize}
        onDoubleClick={resetWidePanelPct}
      />
      {/* Right panel - the right share (files/git/browser tabs). */}
      <div
        className="flex min-w-0 flex-col border-l border-edge-panel bg-surface"
        style={{ flexGrow: 0, flexBasis: `${widePanelPct}%` }}
      >
        <RightPanel />
      </div>
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
  const suppressBrowserView = useSessionStore((s) => s.suppressBrowserView);

  const open = widePanelOpen && planTabActive && !!planText;
  useEffect(() => {
    if (!open) return;
    suppressBrowserView(true);
    return () => suppressBrowserView(false);
  }, [open, suppressBrowserView]);

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
