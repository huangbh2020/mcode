import { cn } from "@renderer/lib/cn.js";
import { isMac } from "@renderer/lib/platform.js";
import {
  IconArrowLeft,
  IconLayoutSidebarRightExpand,
  IconGitFork,
  IconTerminal2,
  IconSearch,
} from "@renderer/lib/icons.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { findSession } from "@renderer/components/layout/SessionTabs.js";
import { worktreeDisplayName } from "@renderer/lib/worktree.js";
import { ToolbarGitCommit } from "@renderer/components/layout/ToolbarGitCommit.js";
import { WorktreeMergeToolbarButton } from "@renderer/components/chat/WorktreeMergeBack.js";
import { BrandLogo } from "@renderer/components/layout/BrandLogo.js";
import { ProjectAvatar } from "@renderer/components/layout/ProjectAvatar.js";
import { projectDisplayColor } from "@renderer/lib/projectAvatar.js";
import { resolveShortcut, acceleratorToDisplayString } from "@renderer/lib/shortcuts.js";
import { useI18n } from "@renderer/lib/i18n/index.js";

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
 *     worktree chip (worktree sessions only) → git pill → worktree
 *     merge-back (conditional, the ONE accent-green signal)
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
  const setCommandPaletteOpen = useSessionStore((s) => s.setCommandPaletteOpen);

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

  const brandElement =
    !isOverlayPage && !isBrowserMode ? (
      <button
        type="button"
        onClick={onToggleLeft}
        className="flex shrink-0 items-center gap-2 rounded-lg px-1.5 py-1 transition-colors hover:bg-surface-hover/70"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        title={
          (leftOpen ? t("layout.hideLeftPanel") : t("layout.showLeftPanel")) +
          hintFor("layout.toggle-left")
        }
      >
        <BrandLogo size={22} />
        <span className="text-[13px] font-semibold tracking-tight text-content">Mcode</span>
      </button>
    ) : (
      <div className="flex shrink-0 items-center gap-2 px-1.5 py-1">
        <BrandLogo size={22} />
        <span className="text-[13px] font-semibold tracking-tight text-content">Mcode</span>
      </div>
    );

  return (
    <div
      className="relative z-20 -mx-[3px] flex h-10 shrink-0 items-stretch overflow-hidden border-b border-edge bg-surface"
      style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
    >
      <div
        className={cn(
          isOverlayPage
            ? "relative flex flex-1 items-center gap-1.5 overflow-hidden bg-surface pl-2.5 pr-2"
            : "relative grid flex-1 grid-cols-[minmax(max-content,1fr)_minmax(0,auto)_minmax(max-content,1fr)] items-center gap-2 overflow-hidden bg-surface pl-2.5 pr-2",
          !isMac && "pr-[138px]",
          // 通栏顶栏始终从窗口最左侧开始，macOS 统一预留交通灯空间。
          isMac && "pl-[78px]",
        )}
      >
        {(isOverlayPage || isBrowserOverlay) && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-0 h-px bg-edge" />
        )}
        {isOverlayPage ? (
          <>
            {brandElement}
            <span className="mx-0.5 h-3.5 w-px shrink-0 bg-edge" aria-hidden />
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
            {/* 左侧：品牌 Logo + 宽屏/浏览器覆盖层返回按钮 */}
            <div className="flex items-center gap-1.5 justify-self-start">
              {brandElement}
              {isBrowserMode && (
                <>
                  <span className="mx-0.5 h-3.5 w-px shrink-0 bg-edge" aria-hidden />
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
                </>
              )}
            </div>

            {/* 中央：原生窗口标题风格的纯文本上下文（项目 / 会话），无边框且可拖拽 */}
            <div className="flex min-w-0 max-w-[440px] items-center justify-center justify-self-center overflow-hidden">
              {!isBrowserOverlay && <ActiveContextTitle />}
            </div>

            {/* 右侧：搜索图标 + Worktree + Git + 合并回流 + 终端/右栏开关 */}
            <div className="flex items-center gap-1.5 justify-self-end">
              {!isBrowserOverlay && (
                <button
                  type="button"
                  onClick={() => setCommandPaletteOpen(true)}
                  className="flex shrink-0 items-center justify-center rounded-md p-1.5 text-content-muted transition-colors hover:bg-surface-hover hover:text-content"
                  style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
                  title={t("layout.searchPlaceholder") + hintFor("command.palette")}
                  aria-label={t("layout.searchPlaceholder")}
                >
                  <IconSearch size={16} className="shrink-0" />
                </button>
              )}

              {/* Worktree chip — the active thread's isolated-checkout name.
                  Renders only for worktree sessions; local threads leave no
                  gap (the component returns null). Neutral tone: the accent
                  green is reserved for the merge-back button next to it. */}
              <ActiveWorktreeChip />
              {/* Git indicator - change-count / clean-status pill that opens the
                  quick-commit popover (which also hosts the branch switcher,
                  moved off the titlebar 2026-11-10 to reclaim width). Placed
                  right-aligned with the workbench controls. */}
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
                    "flex shrink-0 items-center justify-center rounded-md p-1.5 transition-colors",
                    bottomTerminalOpen
                      ? "bg-accent/15 text-accent"
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
                    "flex shrink-0 items-center justify-center rounded-md p-1.5 transition-colors",
                    rightOpen
                      ? "bg-accent/15 text-accent"
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
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Centered native-style window title: displays the owning project and active
 *  session title as plain non-interactive text (`project / session`). No pill
 *  border, no background fill, and stays inside the titlebar's drag region so
 *  it reads unambiguously as a read-only document title rather than a button. */
function ActiveContextTitle() {
  const { t } = useI18n();
  const session = useSessionStore((s) => {
    if (!s.activeSessionId) return null;
    return (
      s.sessions.find((x) => x.id === s.activeSessionId) ??
      findSession(
        s.sessionsByProject,
        s.pinnedSessions,
        s.streamSessions,
        s.activeSessionId,
        s.orchWorkersById,
      ) ??
      null
    );
  });
  const activeProjectId = useSessionStore((s) => s.activeProjectId);
  const targetProjectId = session?.projectId ?? activeProjectId;
  const project = useSessionStore((s) =>
    targetProjectId ? s.projects.find((p) => p.id === targetProjectId) ?? null : null,
  );
  const projectColors = useSessionStore((s) => s.projectColors);
  if (!project && !session) return null;

  const sessionTitle = session ? session.title?.trim() || t("lib.untitledSession") : null;
  const fullTooltip =
    project && sessionTitle
      ? `${project.name} (${project.path}) / ${sessionTitle}`
      : project
        ? project.path
        : sessionTitle ?? undefined;

  return (
    <div
      className="flex min-w-0 max-w-full select-none items-center gap-1.5 text-xs"
      title={fullTooltip}
    >
      {project && (
        <span className="flex min-w-0 max-w-[160px] shrink-0 items-center gap-1.5 font-medium text-content-muted">
          <ProjectAvatar
            name={project.name}
            color={projectDisplayColor(project, projectColors)}
          />
          <span className="truncate">{project.name}</span>
        </span>
      )}
      {project && sessionTitle && (
        <span className="shrink-0 text-content-subtle/50" aria-hidden>
          /
        </span>
      )}
      {sessionTitle && (
        <span className="min-w-0 truncate font-normal text-content-subtle">
          {sessionTitle}
        </span>
      )}
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

/** Editor column toggle removed (2026-11-10, titlebar space triage): the
 *  `</>` button was cut; editor visibility is owned by the tab strip (clicking
 *  a file/plan tab activates the editor column, closing them deactivates it).
 *  layout.hideEditor / showEditor / noOpenFiles keys remain in the dicts for
 *  future surfaces. */
