import { lazy, Suspense, useEffect, useMemo, useRef } from "react";
import { ThreePaneLayout } from "./components/layout/ThreePaneLayout.js";
import { Divider } from "./components/layout/Divider.js";
import { Titlebar } from "./components/layout/Titlebar.js";
import { LeftBar } from "./components/layout/LeftBar.js";
import { ChatPane } from "./components/chat/ChatPane.js";
import { SessionTabs } from "./components/layout/SessionTabs.js";
import { RightPanel } from "./components/layout/RightPanel.js";
import { BottomTerminalBar } from "./components/layout/BottomTerminalBar.js";
import { SettingsPage } from "./components/settings/SettingsPage.js";
import { CommandPalette } from "./components/layout/CommandPalette.js";
import { SearchDialog } from "./components/ide/SearchDialog.js";
import { ModelConfigPrompt } from "./components/chat/ModelConfigPrompt.js";
import { BrowserPanel } from "./components/browser/BrowserPanel.js";
import { Toaster } from "./components/layout/Toaster.js";
import { useClaudeEvents } from "./hooks/useClaudeEvents.js";
import { useGlobalShortcuts } from "./hooks/useGlobalShortcuts.js";
import { useSessionStore } from "./stores/sessionStore.js";
import type { BrowserDevicePreset } from "@contracts/ipc";
import { api } from "./lib/api.js";
import { useTheme } from "./lib/theme.js";
import { useChatAppearance, useRightPanelAppearance } from "./lib/appearance.js";
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
  // Display mode is chosen by device: desktop → fullscreen overlay (wide pages
  // need room); iphone/android → right sidebar (phone-width column fits the
  // emulated viewport). setBrowserPanelOpen(true) forces the sidebar closed so
  // the two containers never fight over the shared WebContentsView.
  useEffect(() => {
    const off = api.on.browserEvent((msg) => {
      if (msg.type !== "agentOpened") return;
      const p = (msg.payload as { url?: string; title?: string; device?: BrowserDevicePreset }) ?? {};
      const st = useSessionStore.getState();
      st.adoptAgentBrowserTab(msg.browserId, p);
      const isDesktop = !p.device || p.device === "desktop";
      if (isDesktop) {
        // Overlay mode (fullscreen). setBrowserPanelOpen(true) closes the right
        // panel so the sidebar BrowserPanel unmounts; the overlay instance takes
        // over the view.
        st.setBrowserPanelOpen(true);
      } else {
        // Sidebar mode (right panel). Ensure the overlay is closed first so the
        // sidebar instance owns the view (isActive = !browserPanelOpen).
        st.setBrowserPanelOpen(false);
        st.setRightPanelTab("browser");
        st.setRightOpen(true);
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
  const setLeftOpen = useSessionStore((s) => s.setLeftOpen);
  const rightOpen = useSessionStore((s) => s.rightOpen);
  const setRightOpen = useSessionStore((s) => s.setRightOpen);
  const bottomTerminalOpen = useSessionStore((s) => s.bottomTerminalOpen);
  const setBottomTerminalOpen = useSessionStore((s) => s.setBottomTerminalOpen);

  /** Draggable pane sizes + resize actions (from the store; persisted). */
  const leftWidth = useSessionStore((s) => s.leftWidth);
  const rightWidth = useSessionStore((s) => s.rightWidth);
  const bottomTerminalHeight = useSessionStore((s) => s.bottomTerminalHeight);
  const adjustLeftWidth = useSessionStore((s) => s.adjustLeftWidth);
  const adjustRightWidth = useSessionStore((s) => s.adjustRightWidth);
  const adjustBottomTerminalHeight = useSessionStore((s) => s.adjustBottomTerminalHeight);
  const resetLeftWidth = useSessionStore((s) => s.resetLeftWidth);
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

  return (
    <div className="flex h-full w-full flex-col bg-surface text-content">
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
      {settingsOpen ? (
        <>
          <Titlebar
            mode="settings"
            leftOpen
            rightOpen={false}
            bottomTerminalOpen={false}
            onBack={() => setSettingsOpen(false)}
          />
          {/* The settings page reuses the three-pane shell with the right
              panel collapsed, so visually it reads as the same workspace
              minus the IDE sidebar. The titlebar/center divider is a border-t
              on the center <main> in ThreePaneLayout, spanning only the center
              area (not the sidebar) so the left sidebar blends seamlessly into
              the titlebar's sidebar strip above. */}
          <div className="relative flex min-h-0 flex-1 bg-surface-muted">
            <SettingsPage />
          </div>
        </>
      ) : (
        <>
          <Titlebar
            mode="workspace"
            leftOpen={leftOpen}
            rightOpen={rightOpen}
            bottomTerminalOpen={bottomTerminalOpen}
            onToggleLeft={() => setLeftOpen(!leftOpen)}
            onToggleRight={() => setRightOpen(!rightOpen)}
            onToggleBottomTerminal={() => setBottomTerminalOpen(!bottomTerminalOpen)}
          />
          {/* Panel row — bg-surface-muted as the contrasting track so the
              center pane's rounded bottom-left corner (in ThreePaneLayout)
              reveals this muted color through the notch and reads as a clean
              arc. The left sidebar is also bg-surface-muted, so it blends
              seamlessly into the track; the center pane (bg-surface) sits on
              top. */}
          <div className="relative flex min-h-0 flex-1 bg-surface-muted">
            <ThreePaneLayout
              left={<LeftBar />}
              center={<CenterPane />}
              right={<RightPanel />}
              leftOpen={leftOpen}
              rightOpen={rightOpen}
              bottomTerminal={<BottomTerminalBar active={bottomTerminalOpen} />}
              bottomTerminalOpen={bottomTerminalOpen}
              leftWidth={leftWidth}
              rightWidth={rightWidth}
              bottomTerminalHeight={bottomTerminalHeight}
              onResizeLeft={adjustLeftWidth}
              onResizeRight={adjustRightWidth}
              onResizeBottomTerminal={adjustBottomTerminalHeight}
              onResetLeft={resetLeftWidth}
              onResetRight={resetRightWidth}
              onResetBottomTerminal={resetBottomTerminalHeight}
            />
          </div>
          {/* Git diff dialog (the "dialog" open-mode). Portaled to <body>;
              renders nothing when closed or empty. Mounted at the workspace
              level so it overlays the editor while staying app-scoped.
              Lazy-loaded with monaco since it reuses the Monaco DiffPane. */}
          <Suspense fallback={null}>
            <GitDiffDialog />
          </Suspense>
        </>
      )}
      {/* Global toast stack - mounted at the root so it overlays everything.
          Renders null when empty. */}
      <Toaster />
    </div>
  );
}

/** Center pane router: a horizontal split between the chat column (left)
 *  and the file-editor column (right). When no file is open the editor
 *  column is omitted and the chat column takes the full width — the layout
 *  the user sees when they haven't clicked any files yet.
 *
 *  The chat column chooses between single-session and tabbed layouts based
 *  on the user's `displayMode` preference (see the design notes in
 *  docs/tech-stack.md). The editor column hosts the Monaco FileEditor + its
 *  tab bar, and is only rendered when `ideActiveFile` is non-null. */
function CenterPane() {
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
    adjustEditorWidthPct(Math.round((deltaPx / w) * 100));
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
          className="flex min-w-0 flex-col border-l border-edge bg-surface"
          style={{ flexGrow: 0, flexBasis: `${editorWidthPct}%` }}
        >
          <EditorColumn filePath={activeFile} />
        </div>
      )}
    </div>
  );
}

/** The chat half: SessionTabs strip (in tabs mode) + the active ChatPane.
 *  Keyed on sessionId so switching tabs re-mounts (clean composer state,
 *  fresh scroll position). */
function ChatColumn() {
  const displayMode = useSessionStore((s) => s.displayMode);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  if (displayMode === "tabs") {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <SessionTabs />
        <div className="min-h-0 flex-1">
          {activeSessionId && <ChatPane key={activeSessionId} sessionId={activeSessionId} />}
        </div>
      </div>
    );
  }
  // single mode: legacy behavior — one ChatPane, swapped by activeSessionId.
  return <ChatPane key={activeSessionId ?? "empty"} sessionId={activeSessionId} />;
}

/** The editor half: OpenTabsBar (only in tabs mode) + the active tab's
 *  content. Resolves the project path from the active project so FileEditor
 *  can show relative paths in its toolbar. When the plan tab is active,
 *  renders PlanViewer instead of FileEditor. */
function EditorColumn({ filePath }: { filePath: string | null }) {
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
      {editorMode === "tabs" && <OpenTabsBar />}
      <div className="min-h-0 flex-1">
        {showPlan ? (
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center gap-1.5 text-[11px] text-content-subtle">
                加载编辑器…
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
                加载编辑器…
              </div>
            }
          >
            <FileEditor key={filePath} filePath={filePath} projectPath={projectPath} />
          </Suspense>
        ) : (
          <div className="flex h-full items-center justify-center text-[11px] text-content-subtle">
            无法解析项目路径
          </div>
        )}
      </div>
    </>
  );
}
