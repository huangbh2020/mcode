import { useMemo } from "react";
import { cn } from "@renderer/lib/cn.js";
import { isMac } from "@renderer/lib/platform.js";
import {
  IconArrowLeft,
  IconLayoutSidebarLeftExpand,
  IconLayoutSidebarRightExpand,
  IconCode,
  IconGitFork,
  IconTerminal2,
} from "@renderer/lib/icons.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { worktreeDisplayName } from "@renderer/lib/worktree.js";
import { ToolbarGitCommit } from "@renderer/components/layout/ToolbarGitCommit.js";
import { WorktreeMergeToolbarButton } from "@renderer/components/chat/WorktreeMergeBack.js";
import { resolveShortcut, acceleratorToDisplayString } from "@renderer/lib/shortcuts.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { UnifiedTabsBar } from "./UnifiedTabsBar.js";

type Mode = "workspace" | "settings" | "sched";

interface Props {
  mode: Mode;
  /** Left sidebar visibility (workspace mode only - drives the left-strip
   *  width so the toggle button doesn't jump when the panel opens/closes). */
  leftOpen: boolean;
  /** Right sidebar visibility (workspace mode only). */
  rightOpen: boolean;
  onToggleLeft?: () => void;
  onToggleRight?: () => void;
  /** Fullscreen-overlay modes: returns to the workspace view. */
  onBack?: () => void;
}

/** Custom toolbar — sits at the top of the right (main) column, behind the
 *  native window controls (titleBarStyle: hidden) so the toggle buttons
 *  share the same row as min/max/close. -webkit-app-region: drag makes the
 *  bar draggable; the buttons opt out with -webkit-app-region: no-drag so
 *  clicks pass through. The left sidebar runs the FULL window height beside
 *  it (see App.tsx), so this bar no longer has a sidebar-aligned left strip;
 *  bg-surface-muted matches the sidebar so the two read as one continuous
 *  frame around the center + right panes.
 *
 *  SINGLE-ROW MERGE (2026-10-31): the old second row (the standalone
 *  session/file tab strip) is gone — UnifiedTabsBar renders as the flexible
 *  middle region of this 40px row, so the session title appears exactly once
 *  (on its tab) and the chrome costs 40px instead of 72px. Layout:
 *   - workspace: sidebar-reopen toggle (only while closed) → tab strip
 *     (flex-1; empty space stays draggable like a browser tab strip) →
 *     worktree chip (worktree sessions only) → editor `</>` toggle → git
 *     pill → worktree merge-back (conditional, the ONE accent-green signal)
 *     → terminal toggle (conditional) → right-panel toggle → the reserved
 *     native-controls zone (Windows).
 *   - settings:  a "返回工作区" back button + a "设置" heading (no strip —
 *     the overlay covers the workspace).
 *   - browser overlay / wide-panel mode: the matching back button ("返回工作
 *     台" / "退出宽屏"). Wide-panel keeps the strip (sessions remain
 *     visible; file/plan tabs hide inside UnifiedTabsBar); the fullscreen
 *     browser overlay hides it (it covers the workspace entirely).
 *
 *  Platform reservation: on macOS the traffic lights sit on the LEFT — they
 *  overlay the full-height sidebar while it's open (LeftBar's header reserves
 *  room), but when the sidebar is closed the bar starts at x=0 and reserves
 *  the left padding itself. On Windows/Linux the titleBarOverlay controls
 *  (min/max/close) sit on the RIGHT, so the bar reserves right padding. */
export function Titlebar({
  mode,
  leftOpen,
  rightOpen,
  onToggleLeft,
  onToggleRight,
  onBack,
}: Props) {
  const { t } = useI18n();
  const isSettings = mode === "settings";
  // 定时任务查看页 shares the settings-mode chrome (back button + page title,
  // side toggles suppressed) — only the heading text differs.
  const isSchedPage = mode === "sched";
  const isOverlayPage = isSettings || isSchedPage;
  // The browser overlay toggle now lives in the right-panel rail, but the
  // overlay still forces the side panels closed and hides their toggles when
  // open. Read its state straight from the store; the "返回工作台" button
  // below uses setBrowserPanelOpen to exit the overlay.
  const browserPanelOpen = useSessionStore((s) => s.browserPanelOpen);
  const setBrowserPanelOpen = useSessionStore((s) => s.setBrowserPanelOpen);
  // Wide-panel (3:7) mode hides the left sidebar + center editor and shows the
  // chat column + full right panel. It gets the same titlebar treatment as the
  // browser overlay: the left strip swaps to a back button and the right-panel
  // / terminal / editor toggles are hidden.
  const widePanelOpen = useSessionStore((s) => s.widePanelOpen);
  const setWidePanelOpen = useSessionStore((s) => s.setWidePanelOpen);
  const isBrowserMode = (!!browserPanelOpen || widePanelOpen) && !isOverlayPage;
  // The fullscreen browser overlay covers the whole workspace, so its side-panel
  // / terminal toggles hide while it's open. Wide-panel mode keeps them: the
  // terminal bar still renders below the split and the right-panel toggle
  // shows/hides the wide mode's right column.
  const isBrowserOverlay = !!browserPanelOpen && !isOverlayPage;
  const terminalPosition = useSessionStore((s) => s.terminalPosition);
  const bottomTerminalOpen = useSessionStore((s) => s.bottomTerminalOpen);
  const setBottomTerminalOpen = useSessionStore((s) => s.setBottomTerminalOpen);

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
          // overflow-hidden: total containment — the tab strip's flex chain
          // (min-w-0 at every level + overflow-x-auto track) normally keeps
          // everything inside, but in degenerate narrow windows the strip's
          // own shrink-0 chrome (chevrons/⋯) must never spill over the right
          // cluster; clipping beats overlapping. Portaled popups (⋯ menu,
          // git pill popover, dialogs) render at <body> and are unaffected.
          "flex flex-1 items-center overflow-hidden bg-surface-muted px-1.5",
          !isMac && "pr-[138px]",
          // macOS traffic lights sit at the window's top-left. They overlay
          // the full-height sidebar while it's visible (LeftBar's header
          // reserves the room). Whenever the sidebar is NOT visible — closed,
          // or hidden because a fullscreen page (settings / 定时任务) covers
          // the row — this bar starts at x=0 and must reserve the space itself.
          isMac && !(leftOpen && !isOverlayPage) && "pl-[78px]",
        )}
      >
        {isOverlayPage ? (
          <>
            <button
              onClick={onBack}
              className={cn(
                "flex items-center gap-1.5 rounded px-1.5 py-1 text-xs font-medium",
                "text-content-muted transition-colors hover:bg-surface-hover hover:text-content",
              )}
              style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
              title={t("layout.backToWorkspace")}
            >
              <IconArrowLeft size={16} className="shrink-0" />
              {t("layout.backToWorkspace")}
            </button>
            <h2 className="px-1.5 text-sm font-semibold text-content">
              {isSchedPage ? t("layout.schedTasks") : t("layout.settings")}
            </h2>
          </>
        ) : (
          <>
            {isBrowserMode ? (
              // Browser overlay / wide-panel mode: a back button that closes
              // the mode and returns to the IDE workspace. Mirrors the
              // settings-mode back button in form (icon + label) so the
              // "exit this mode" affordances read consistently. The tooltip
              // appends the effective toggle shortcut (the same command this
              // button triggers).
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
                  (widePanelOpen ? t("layout.exitWideMode") : t("layout.backToWorkbench")) +
                  hintFor(widePanelOpen ? "layout.toggle-wide-panel" : "layout.toggle-browser")
                }
              >
                <IconArrowLeft size={16} className="shrink-0" />
                {widePanelOpen ? t("layout.exitWideMode") : t("layout.backToWorkbench")}
              </button>
            ) : (
              // Workspace: the sidebar's collapse toggle lives in the LeftBar
              // footer now, so the toolbar HIDES this button while the sidebar
              // is open. It reappears only while the sidebar is CLOSED — the
              // footer button is inside the hidden sidebar, so this is the
              // only mouse path back (beyond the toggle-left shortcut).
              !leftOpen && (
                <>
                  <button
                    onClick={onToggleLeft}
                    className={cn(
                      "flex shrink-0 items-center justify-center rounded p-1.5 transition-colors",
                      "text-content-muted hover:bg-surface-hover hover:text-content",
                    )}
                    title={t("layout.showLeftPanel") + hintFor("layout.toggle-left")}
                    style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
                  >
                    <IconLayoutSidebarLeftExpand
                      size={18}
                      className="shrink-0 scale-x-[-1]"
                    />
                  </button>
                </>
              )
            )}
            {/* Unified tab strip — the merged single-row titlebar's middle
                region. Session title/project identity live ON the tabs now
                (the old ActiveThreadTitle/ActiveProjectChip chips are gone —
                the title appeared twice in the two-row layout). The wrapper
                stays mounted so the right cluster keeps its place even when
                the strip renders null (no tabs/files/plan). Hidden on
                overlay pages (settings/sched cover the workspace) and during
                the fullscreen browser overlay; wide-panel mode keeps it
                (sessions remain the visible surface there). */}
            {!isOverlayPage && !isBrowserOverlay && (
              <div className="flex min-w-0 flex-1 items-center">
                <UnifiedTabsBar />
              </div>
            )}
            {isBrowserOverlay && <div className="flex-1" />}
            {/* Worktree chip — the active thread's isolated-checkout name.
                Renders only for worktree sessions; local threads leave no
                gap (the component returns null). Neutral tone: the accent
                green is reserved for the merge-back button next to it. */}
            <ActiveWorktreeChip />
            {/* Editor column toggle - shows/hides the center-pane editor
                column without closing the open file. Lives in the right
                cluster with the other workbench toggles since the merge. */}
            {!isBrowserMode && <EditorColumnToggle />}
            {/* Git indicator - compact branch pill + change-count badge that
                opens the quick-commit popover. Placed right-aligned with the
                workbench controls for prominent access and clean title area. */}
            <ToolbarGitCommit />
            {/* Worktree merge-back (Land) — session-scoped, right-aligned with
                the panel toggles. Shown only while the active session runs in
                a worktree with unmerged changes; self-hiding otherwise (the
                component returns null). Hidden while the browser overlay is
                open, same as the panel toggles (kept during wide mode). */}
            {!isBrowserOverlay && <WorktreeMergeToolbarButton />}

            {/* Bottom terminal toggle - shown only when terminal is docked at bottom.
                Active state is neutral (bg-surface-hover): accent green is reserved
                for attention signals, not layout toggles. */}
            {terminalPosition === "bottom" && !isBrowserOverlay && (
              <button
                onClick={() => setBottomTerminalOpen(!bottomTerminalOpen)}
                className={cn(
                  "flex shrink-0 items-center justify-center rounded p-1.5 transition-colors",
                  bottomTerminalOpen
                    ? "bg-surface-hover text-content"
                    : "text-content-muted hover:bg-surface-hover hover:text-content",
                )}
                title={
                  (bottomTerminalOpen ? t("layout.hideTerminal") : t("layout.showTerminal")) +
                  hintFor("layout.toggle-bottom-terminal")
                }
                style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
              >
                <IconTerminal2 size={16} className="shrink-0" />
              </button>
            )}

            {/* Right-panel toggle - hidden while the browser overlay is open
                (the browser forces the right panel closed and manages its own
                restore on exit). During wide mode it stays: it hides/shows the
                wide mode's right column (chat goes full width when hidden).
                Active state is neutral (bg-surface-hover) — see the terminal
                toggle note. */}
            {!isBrowserOverlay && (
              <button
                onClick={onToggleRight}
                className={cn(
                  "flex shrink-0 items-center justify-center rounded p-1.5 transition-colors",
                  rightOpen
                    ? "bg-surface-hover text-content"
                    : "text-content-muted hover:bg-surface-hover hover:text-content",
                )}
                title={(rightOpen ? t("layout.hideRightPanel") : t("layout.showRightPanel")) + hintFor("layout.toggle-right")}
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

/** Active-session worktree chip: fork icon + the worktree's display name
 *  (custom name if renamed, else directory basename), full path in the hover
 *  tooltip. Sits at the head of the right cluster, next to the merge-back
 *  button. Deliberately NEUTRAL (text-content-subtle): it's identity context,
 *  not a warning — the accent green beside it belongs to the merge-back
 *  button ("this session has work waiting to land"). Renders only while the
 *  ACTIVE session runs in a materialized worktree — local threads render
 *  nothing. Atomic selectors (primitive / stable ref) per the store's
 *  Object.is rule; the session may live in any list bucket. */
function ActiveWorktreeChip() {
  const worktreePath = useSessionStore((s) => {
    if (!s.activeSessionId) return null;
    const sess =
      s.sessions.find((x) => x.id === s.activeSessionId) ??
      s.pinnedSessions.find((x) => x.id === s.activeSessionId);
    if (sess) return sess.worktreePath ?? null;
    for (const list of Object.values(s.sessionsByProject)) {
      const hit = list?.find((x) => x.id === s.activeSessionId);
      if (hit) return hit.worktreePath ?? null;
    }
    return null;
  });
  const worktreeNames = useSessionStore((s) => s.worktreeNames);
  if (!worktreePath) return null;
  return (
    <div
      className="flex min-w-0 max-w-[160px] shrink-0 items-center gap-1 px-1 text-xs text-content-subtle"
      title={worktreePath}
    >
      <IconGitFork size={13} className="shrink-0" />
      <span className="truncate">{worktreeDisplayName(worktreePath, worktreeNames)}</span>
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
  const { t } = useI18n();
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

  // The unified center bar decides visibility — the editor "shows" only
  // while it holds the center focus.
  const centerTabFocus = useSessionStore((s) => s.centerTabFocus);

  // Match the center pane's visibility logic: visible when a file is active
  // OR the plan tab is active. (planTabOpen alone - plan exists but is not
  // the active tab - does NOT make the editor visible, matching CenterPane.)
  const editorVisible = centerTabFocus === "editor" && (!!activeFile || planTabActive);
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
        // shrink-0: the tab strip may shrink to nothing on narrow windows,
        // but the right-cluster buttons and the git pill must keep their
        // size — the strip scrolls instead (chevrons), it never squeezes
        // the workbench controls.
        "flex shrink-0 items-center justify-center rounded p-1.5 transition-colors",
        editorVisible
          ? "bg-surface-hover text-content"
          : "text-content-muted hover:bg-surface-hover hover:text-content disabled:opacity-40 disabled:hover:bg-transparent",
      )}
      title={
        editorVisible
          ? t("layout.hideEditor")
          : canRestore
            ? t("layout.showEditor")
            : t("layout.noOpenFiles")
      }
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
    >
      <IconCode size={16} className="shrink-0" />
    </button>
  );
}
