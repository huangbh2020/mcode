import { cn } from "@renderer/lib/cn.js";
import {
  IconFolder,
  IconGitBranch,
  IconWorld,
  IconArrowsMaximize,
  IconArrowsMinimize,
} from "@renderer/lib/icons.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { resolveShortcut, acceleratorToDisplayString } from "@renderer/lib/shortcuts.js";
import { FilesPanel } from "@renderer/components/ide/FilesPanel.js";
import { GitPanel } from "@renderer/components/ide/GitPanel.js";
import { BrowserPanel } from "@renderer/components/browser/BrowserPanel.js";

/** Right panel: a horizontal icon rail docked at the top + a main panel
 *  area (IDE-style). The rail is always visible and holds three icons:
 *    - Files   → shows FilesPanel in the main area
 *    - Git     → shows GitPanel in the main area
 *    - Browser → toggles an embedded browser panel in the main area
 *      (mobile-first sidebar mode). Clicking again closes it. The PC-fullscreen
 *      overlay is a separate container rendered at the App root; while that
 *      overlay is open the right panel isn't visible at all.
 *
 *  The active panel (files / git) is read from / written to the session store
 *  (persisted in the settings table), so it survives restarts. The browser tab
 *  is session-only (hydrate ignores a persisted "browser" value so the browser
 *  never auto-opens at boot). The browser icon shows a badge with the open-tab
 *  count. */
export function RightPanel() {
  const tab = useSessionStore((s) => s.rightPanelTab);
  const setTab = useSessionStore((s) => s.setRightPanelTab);
  const browserTabCount = useSessionStore((s) => s.browserTabCount);
  const widePanelOpen = useSessionStore((s) => s.widePanelOpen);
  const setWidePanelOpen = useSessionStore((s) => s.setWidePanelOpen);

  // Append the effective shortcut for a command's tooltip (same pattern as the
  // Titlebar's hintFor; cheap - a handful of lookups per render).
  const overrides = useSessionStore((s) => s.shortcutOverrides);
  const hintFor = (commandId: string): string => {
    const a = resolveShortcut(commandId, overrides);
    return a ? ` (${acceleratorToDisplayString(a)})` : "";
  };

  /** Toggle the embedded sidebar browser: open it if another tab is active,
   *  or close it (fall back to files) if it's already showing. */
  const toggleBrowser = () => {
    setTab(tab === "browser" ? "files" : "browser");
  };

  return (
    <div className="flex h-full flex-col">
      {/* Horizontal icon rail — always visible, docked at the panel's top
          edge. Each icon is a square button; the active one is marked with
          the accent token. */}
      <div className="flex h-9 shrink-0 flex-row items-center gap-1 border-b border-edge bg-surface px-1.5">
        <RailButton
          active={tab === "files"}
          onClick={() => setTab("files")}
          title="文件"
        >
          <IconFolder size={16} className="shrink-0" />
        </RailButton>
        <RailButton
          active={tab === "git"}
          onClick={() => setTab("git")}
          title="Git"
        >
          <IconGitBranch size={16} className="shrink-0" />
        </RailButton>
        {/* Browser — toggles the embedded sidebar (mobile-first). */}
        <div className="relative">
          <RailButton
            active={tab === "browser"}
            onClick={toggleBrowser}
            title={tab === "browser" ? "关闭侧边栏浏览器" : "打开浏览器"}
          >
            <IconWorld size={16} className="shrink-0" />
          </RailButton>
          {browserTabCount > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent px-1 text-[9px] font-bold leading-none text-white">
              {browserTabCount}
            </span>
          )}
        </div>
        {/* Wide-panel (2:8) mode - hide the left sidebar + center editor and
            split the workspace into this right panel (8/10) + the chat column
            (2/10). Toggled here, via the command palette / shortcut, or the
            titlebar back button. Pushed to the rail's far right with ml-auto. */}
        <div className="ml-auto flex items-center gap-1">
          <div className="h-5 w-px bg-edge" />
          <RailButton
            active={widePanelOpen}
            onClick={() => setWidePanelOpen(!widePanelOpen)}
            title={
              (widePanelOpen ? "退出宽屏模式" : "宽屏模式 (聊天+面板 2:8)") +
              hintFor("layout.toggle-wide-panel")
            }
          >
            {/* Maximize when entering, minimize (restore) when already wide —
                the standard expand/collapse affordance pair. */}
            {widePanelOpen ? (
              <IconArrowsMinimize size={16} className="shrink-0" />
            ) : (
              <IconArrowsMaximize size={16} className="shrink-0" />
            )}
          </RailButton>
        </div>
      </div>

      {/* Main panel area — must NOT scroll itself (children own height /
          overflow). Renders the panel matching the active tab. The browser
          sidebar (mobile-first) renders inline here; the PC-fullscreen overlay
          is rendered at the App root and covers the whole workspace. */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {tab === "files" && <FilesPanel />}
        {tab === "git" && <GitPanel />}
        {tab === "browser" && <BrowserPanel mode="sidebar" />}
      </div>
    </div>
  );
}

/** A square icon button in the panel's rail. Active state uses the accent
 *  token; idle state uses the muted content token with a hover surface. */
function RailButton({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "flex h-7 w-7 items-center justify-center rounded-md transition-colors",
        active
          ? "bg-accent/15 text-accent"
          : "text-content-muted hover:bg-surface-hover hover:text-content",
      )}
    >
      {children}
    </button>
  );
}
