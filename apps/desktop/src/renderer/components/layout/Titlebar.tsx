import { useMemo } from "react";
import { cn } from "@renderer/lib/cn.js";
import { isMac } from "@renderer/lib/platform.js";
import {
  IconArrowLeft,
  IconLayoutSidebarLeftExpand,
  IconLayoutSidebarRightExpand,
  IconTerminal2,
  IconCode,
} from "@renderer/lib/icons.js";
import { getProviderIcon } from "@renderer/lib/providerIcon.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { ProjectBranchIndicator } from "@renderer/components/chat/ProjectBranchIndicator.js";
import { resolveShortcut, acceleratorToDisplayString } from "@renderer/lib/shortcuts.js";

type Mode = "workspace" | "settings";

interface Props {
  mode: Mode;
  /** Left sidebar visibility (workspace mode only - drives the left-strip
   *  width so the toggle button doesn't jump when the panel opens/closes). */
  leftOpen: boolean;
  /** Right sidebar visibility (workspace mode only). */
  rightOpen: boolean;
  /** Bottom terminal bar visibility (workspace mode only). */
  bottomTerminalOpen: boolean;
  onToggleLeft?: () => void;
  onToggleRight?: () => void;
  onToggleBottomTerminal?: () => void;
  /** Settings mode: returns to the workspace view. */
  onBack?: () => void;
}

/** Custom titlebar — sits behind the native window controls (titleBarStyle:
 *  hidden) so the toggle buttons share the same row as min/max/close.
 *  -webkit-app-region: drag makes the bar draggable; the buttons opt out with
 *  -webkit-app-region: no-drag so clicks pass through.
 *
 *  The bar is split vertically to match the panes below it: a sidebar strip
 *  (bg-surface-muted) over the left panel, and a main strip (bg-surface) over
 *  the center. This makes the left panel read as one continuous block running
 *  to the top of the window (no divider between the titlebar sidebar strip and
 *  the sidebar below - they blend), while the center keeps the distinct
 *  "toolbar above editor" separation. The horizontal titlebar/center divider
 *  is drawn as a border-t on the center <main> in ThreePaneLayout (not here),
 *  so it spans only the center area and isn't clipped by the native
 *  titleBarOverlay on Windows/Linux.
 *
 *  Two modes:
 *   - workspace: left strip carries the left-panel toggle (always rendered so
 *     the button stays put whether the panel is open or closed); main strip
 *     carries the active-thread title chip + right-panel toggle.
 *   - settings:  left strip is fixed at the sidebar width (reads the same
 *     leftWidth from the store as the workspace sidebar, so the back button
 *     lines up with the settings menu below); carries a "返回工作区" back
 *     button; main strip shows "设置".
 *
 *  Platform reservation: on macOS the traffic lights sit on the LEFT, so the
 *  sidebar strip reserves left padding; on Windows/Linux the titleBarOverlay
 *  controls (min/max/close) sit on the RIGHT, so the main strip reserves
 *  right padding. */
export function Titlebar({
  mode,
  leftOpen,
  rightOpen,
  bottomTerminalOpen,
  onToggleLeft,
  onToggleRight,
  onToggleBottomTerminal,
  onBack,
}: Props) {
  const isSettings = mode === "settings";
  // The browser overlay toggle now lives in the right-panel rail, but the
  // overlay still forces the side panels closed and hides their toggles when
  // open. Read its state straight from the store; the "返回工作台" button
  // below uses setBrowserPanelOpen to exit the overlay.
  const browserPanelOpen = useSessionStore((s) => s.browserPanelOpen);
  const setBrowserPanelOpen = useSessionStore((s) => s.setBrowserPanelOpen);
  // Wide-panel (2:8) mode hides the left sidebar + center editor and shows the
  // chat column + full right panel. It gets the same titlebar treatment as the
  // browser overlay: the left strip swaps to a back button and the right-panel
  // / terminal / editor toggles are hidden.
  const widePanelOpen = useSessionStore((s) => s.widePanelOpen);
  const setWidePanelOpen = useSessionStore((s) => s.setWidePanelOpen);
  const isBrowserMode = (!!browserPanelOpen || widePanelOpen) && !isSettings;
  // The fullscreen browser overlay covers the whole workspace, so its side-panel
  // / terminal toggles hide while it's open. Wide-panel mode keeps them: the
  // terminal bar still renders below the split and the right-panel toggle
  // shows/hides the wide mode's right column.
  const isBrowserOverlay = !!browserPanelOpen && !isSettings;

  // The left strip tracks the sidebar's draggable width so the toggle button
  // and the settings back button stay aligned with the panel edge below.
  const leftWidth = useSessionStore((s) => s.leftWidth);
  const showLeftStrip = (leftOpen || isSettings) && !isBrowserMode;

  // Subscribe once to the shortcut overrides so every toggle button's tooltip
  // shows the *effective* chord (override ?? default). Re-resolved per render
  // via `hintFor` below — cheap (a handful of lookups).
  const overrides = useSessionStore((s) => s.shortcutOverrides);
  /** Append the effective shortcut for `commandId` to a label, e.g.
   *  "隐藏左侧面板" → "隐藏左侧面板 (⌘B)". Returns the label unchanged when
   *  the command has no binding. */
  const hintFor = (commandId: string): string => {
    const a = resolveShortcut(commandId, overrides);
    return a ? ` (${acceleratorToDisplayString(a)})` : "";
  };

  return (
    <div
      className="flex h-10 shrink-0 items-stretch"
      style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
    >
      <div
        className={cn(
          "flex shrink-0 items-center rounded-tl-lg pr-1.5",
          // When the left panel is open (or in settings), the strip uses the
          // muted surface so it blends with the sidebar below it as one
          // continuous block. When collapsed, match the main strip's
          // bg-surface so the toggle reads as part of the main titlebar.
          showLeftStrip ? "bg-surface-muted" : "bg-surface",
          // In settings mode the sidebar strip is always shown so the back
          // button lines up with the settings menu below.
          showLeftStrip && "rounded-tr-lg border-r border-edge",
          isMac ? "pl-[78px]" : "pl-1.5",
        )}
        // Align the strip's right edge with the panel row's left column below.
        // In workspace mode the panel row is <aside width=leftWidth> + a
        // separate 1px <Divider>, so the left column spans leftWidth+1 and the
        // strip must match (+1) for the border-r to land directly above the
        // divider. Settings mode renders no divider (SettingsPage passes no
        // resize handler), so the strip stays exactly leftWidth.
        style={showLeftStrip ? { width: leftWidth + (isSettings ? 0 : 1) } : undefined}
      >
        {isSettings ? (
          <button
            onClick={onBack}
            className={cn(
              "flex items-center gap-1.5 rounded px-1.5 py-1 text-xs font-medium",
              "text-content-muted transition-colors hover:bg-surface-hover hover:text-content",
            )}
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            title="返回工作区"
          >
            <IconArrowLeft size={16} className="shrink-0" />
            返回工作区
          </button>
        ) : isBrowserMode ? (
          // Browser overlay open: show a "返回工作台" button that closes the
          // browser and returns to the IDE workspace. Mirrors the settings-mode
          // back button in form (icon + label) so the two "exit this mode"
          // affordances read consistently. The tooltip appends the effective
          // toggle-browser shortcut (the same command this button triggers).
          <button
            onClick={() =>
              widePanelOpen ? setWidePanelOpen(false) : setBrowserPanelOpen(false)
            }
            className={cn(
              "flex items-center gap-1.5 rounded px-1.5 py-1 text-xs font-medium",
              "text-content-muted transition-colors hover:bg-surface-hover hover:text-content",
            )}
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            title={
              (widePanelOpen ? "退出宽屏模式" : "返回工作台") +
              hintFor(widePanelOpen ? "layout.toggle-wide-panel" : "layout.toggle-browser")
            }
          >
            <IconArrowLeft size={16} className="shrink-0" />
            {widePanelOpen ? "退出宽屏模式" : "返回工作台"}
          </button>
        ) : (
          <button
            onClick={onToggleLeft}
            className={cn(
              "flex items-center justify-center rounded p-1.5 transition-colors",
              leftOpen
                ? "bg-surface-hover text-accent"
                : "text-content-muted hover:bg-surface-hover hover:text-content",
            )}
            title={(leftOpen ? "隐藏左侧面板" : "显示左侧面板") + hintFor("layout.toggle-left")}
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          >
            <IconLayoutSidebarLeftExpand
              size={18}
              className={cn(
                "shrink-0 transition-transform",
                !leftOpen && "scale-x-[-1]",
              )}
            />
          </button>
        )}
      </div>

      <div
        className={cn(
          "flex flex-1 items-center bg-surface px-1.5",
          !isMac && "pr-[138px]",
        )}
      >
        {isSettings ? (
          <h2 className="px-1.5 text-sm font-semibold text-content">设置</h2>
        ) : (
          <>
            <ActiveThreadTitle />
            {/* Git branch indicator - compact pill (no project name), click to
                switch branches. Only renders when a project is active and is a
                git repo. Sits right of the thread title. */}
            <ToolbarBranchIndicator />
            {/* Editor column toggle - shows/hides the center-pane editor column
                without closing the open file. Sits right of the branch pill. */}
            {!isBrowserMode && <EditorColumnToggle />}
            <div className="flex-1" />
            {/* Bottom terminal toggle — sits just left of the right-panel
                toggle. Active state highlighted with the accent token. */}
            {/* Bottom terminal toggle - hidden while the browser overlay is
                open, same as the side-panel toggles (kept during wide mode). */}
            {!isBrowserOverlay && (
              <button
                onClick={onToggleBottomTerminal}
                className={cn(
                  "flex items-center justify-center rounded p-1.5 transition-colors",
                  bottomTerminalOpen
                    ? "bg-surface-hover text-accent"
                    : "text-content-muted hover:bg-surface-hover hover:text-content",
                )}
                title={(bottomTerminalOpen ? "隐藏终端" : "显示终端") + hintFor("layout.toggle-bottom-terminal")}
                style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
              >
              <IconTerminal2 size={18} className="shrink-0" />
            </button>
            )}
            {/* Right-panel toggle - hidden while the browser overlay is open
                (the browser forces the right panel closed and manages its own
                restore on exit). During wide mode it stays: it hides/shows the
                wide mode's right column (chat goes full width when hidden). */}
            {!isBrowserOverlay && (
              <button
                onClick={onToggleRight}
                className={cn(
                  "flex items-center justify-center rounded p-1.5 transition-colors",
                  rightOpen
                    ? "bg-surface-hover text-accent"
                    : "text-content-muted hover:bg-surface-hover hover:text-content",
                )}
                title={(rightOpen ? "隐藏右侧面板" : "显示右侧面板") + hintFor("layout.toggle-right")}
                style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
              >
                <IconLayoutSidebarRightExpand
                  size={18}
                  className={cn(
                    "shrink-0 transition-transform",
                    !rightOpen && "scale-x-[-1]",
                  )}
                />
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Active-thread title chip rendered on the left of the main titlebar strip.
 *  Fixed width, single line, truncated with ellipsis when too long; the full
 *  name shows in a native title tooltip on hover. Hidden when no session is
 *  open (leaves an empty drag region). */
function ActiveThreadTitle() {
  // Two atomic selectors — returning a fresh object literal here would
  // trip zustand's "snapshot should be cached" check (Object.is sees a
  // new ref every render → infinite loop). title and providerId are read
  // independently so each returns a primitive (or undefined) that's stable.
  const title = useSessionStore((s) => {
    if (!s.activeSessionId) return null;
    const sess = s.sessions.find((x) => x.id === s.activeSessionId);
    return sess?.title ?? null;
  });
  const providerId = useSessionStore((s) => {
    if (!s.activeSessionId) return null;
    const sess = s.sessions.find((x) => x.id === s.activeSessionId);
    return sess?.providerId ?? null;
  });
  if (!title) return null;
  const { Icon, color } = getProviderIcon(providerId);
  return (
    <div className="flex min-w-0 max-w-[280px] shrink-0 items-center gap-1 px-1.5 text-xs font-medium text-content-muted">
      <Icon size={13} className={cn("shrink-0", color)} />
      <span className="truncate" title={title}>
        {title}
      </span>
    </div>
  );
}

/** Compact git-branch pill for the toolbar. Renders only the branch switcher
 *  (no folder icon / project name) via ProjectBranchIndicator's compact mode.
 *  Hidden when no project is active. The interactive pill opts out of the
 *  titlebar's drag region so clicks work. */
function ToolbarBranchIndicator() {
  const activeProjectId = useSessionStore((s) => s.activeProjectId);
  const projects = useSessionStore((s) => s.projects);
  const { projectPath, projectName } = useMemo(() => {
    if (!activeProjectId) return { projectPath: "", projectName: "" };
    const p = projects.find((x) => x.id === activeProjectId);
    return { projectPath: p?.path ?? "", projectName: p?.name ?? "" };
  }, [activeProjectId, projects]);
  if (!projectPath) return null;
  return (
    <div
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      className="shrink-0"
    >
      <ProjectBranchIndicator
        projectPath={projectPath}
        projectName={projectName}
        compact
      />
    </div>
  );
}

/** Stable empty array so the openFiles selector never returns a fresh []
 *  (Zustand Object.is rule - a new [] every render causes an infinite loop). */
const EMPTY_OPEN_FILES: string[] = [];

/** Editor column toggle button. Shows/hides the center-pane editor column.
 *  The editor is visible when a file tab is active OR a plan tab is open.
 *  Clicking when visible hides it (clears the active file AND deactivates the
 *  plan tab so neither renders); clicking when hidden re-opens the first file
 *  from the open-files list (or does nothing if none are open). */
function EditorColumnToggle() {
  const activeProjectId = useSessionStore((s) => s.activeProjectId);
  const activeFile = useSessionStore((s) =>
    activeProjectId ? s.ideActiveFileByProject[activeProjectId] ?? null : null,
  );
  const openFiles = useSessionStore((s) =>
    activeProjectId ? s.ideOpenFilesByProject[activeProjectId] ?? EMPTY_OPEN_FILES : EMPTY_OPEN_FILES,
  );
  const clearIdeActiveFile = useSessionStore((s) => s.clearIdeActiveFile);
  const setIdeActiveFile = useSessionStore((s) => s.setIdeActiveFile);

  // Plan tab state: the editor column is also visible when the plan tab is
  // the active tab (same condition CenterPane uses).
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const planTabActive = useSessionStore(
    (s) => (activeSessionId ? s.planTabActiveBySession[activeSessionId] ?? false : false),
  );
  const planTabOpen = useSessionStore(
    (s) => (activeSessionId ? s.planDrawerPlanBySession[activeSessionId] != null : false),
  );
  const setPlanTabActive = useSessionStore((s) => s.setPlanTabActive);

  // Match CenterPane's visibility logic: visible when a file is active OR the
  // plan tab is active. (planTabOpen alone - plan exists but is not the active
  // tab - does NOT make the editor visible, matching CenterPane.)
  const editorVisible = !!activeFile || planTabActive;
  // Whether there's something to restore when the editor is hidden: either an
  // open file OR a plan tab that can be re-activated.
  const canRestore = openFiles.length > 0 || planTabOpen;

  const handleClick = () => {
    if (editorVisible) {
      // Hide the editor: clear the active file AND deactivate the plan tab so
      // neither the FileEditor nor PlanViewer renders.
      clearIdeActiveFile();
      if (activeSessionId && planTabActive) {
        setPlanTabActive(activeSessionId, false);
      }
    } else if (openFiles.length > 0) {
      // Re-open the first file in the open list.
      setIdeActiveFile(openFiles[0]);
    } else if (activeSessionId && planTabOpen) {
      // No files open but a plan tab exists - re-activate it.
      setPlanTabActive(activeSessionId, true);
    }
  };

  return (
    <button
      onClick={handleClick}
      disabled={!editorVisible && !canRestore}
      className={cn(
        "flex items-center justify-center rounded p-1.5 transition-colors",
        editorVisible
          ? "bg-surface-hover text-accent"
          : "text-content-muted hover:bg-surface-hover hover:text-content disabled:opacity-40 disabled:hover:bg-transparent",
      )}
      title={
        editorVisible
          ? "隐藏编辑器"
          : canRestore
            ? "显示编辑器"
            : "无打开的文件"
      }
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
    >
      <IconCode size={16} className="shrink-0" />
    </button>
  );
}
