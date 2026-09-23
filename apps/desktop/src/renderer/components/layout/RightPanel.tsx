import { useEffect, useMemo, useRef, useState } from "react";
import { Menu } from "@base-ui/react/menu";
import { cn } from "@renderer/lib/cn.js";
import {
  IconFolder,
  IconGitBranch,
  IconWorld,
  IconListDetails,
  IconMessages,
  IconArrowsMaximize,
  IconArrowsMinimize,
  IconClock,
  IconGitFork,
  IconPlus,
  IconX,
  IconCheck,
  IconTerminal2,
  IconBrandGithub,
} from "@renderer/lib/icons.js";
import { useSessionStore, type SessionRightPanelTabId } from "@renderer/stores/sessionStore.js";
import { resolveShortcut, acceleratorToDisplayString } from "@renderer/lib/shortcuts.js";
import { useSuppressBrowserView } from "@renderer/hooks/useSuppressBrowserView.js";
import { FilesPanel } from "@renderer/components/ide/FilesPanel.js";
import { GitPanel } from "@renderer/components/ide/GitPanel.js";
import { TerminalPanel } from "@renderer/components/ide/TerminalPanel.js";
import { TurnFlowPanel } from "@renderer/components/ide/TurnFlowPanel.js";
import { OrchPanel } from "@renderer/components/ide/OrchPanel.js";
import { GitHubPanel } from "@renderer/components/github/GitHubPanel.js";
import { SchedPanel } from "@renderer/components/automation/SchedPanel.js";
import { BrowserPanel } from "@renderer/components/browser/BrowserPanel.js";
import { SideChatPanel } from "@renderer/components/chat/SideChatPanel.js";
import { useI18n } from "@renderer/lib/i18n/index.js";

/** Right panel: a horizontal icon rail docked at the top + a main panel
 *  area (IDE-style). The rail's fixed icons are the GLOBAL tabs — files /
 *  git / orch — whose active value is one app-wide preference (persisted).
 *  The turn-flow, sub-session and embedded-browser panels are SESSION-scoped
 *  and not fixed: the trailing "+" menu opens any of them for the ACTIVE
 *  session; an opened one appears as a rail icon that exists for that
 *  session only. Each session remembers its own open set + which of them is
 *  showing (store's sessionRightTabsBySession), so they follow the session
 *  across switches; while one is active it shadows the global tab. Closing —
 *  by clicking the showing tab again (toggle, hover swaps the icon for an ×)
 *  or via the "+" menu's × — falls back to the global tab. (The browser's
 *  tab list / WebContentsViews are global shared state; only the panel's
 *  visibility here is per-session. The PC-fullscreen browser overlay is a
 *  separate container rendered at the App root.) */

/** Module-level stable empty set — per-session selector fallback must not
 *  return a fresh [] each render (Zustand infinite-loop guard). */
const EMPTY_SESSION_TABS: SessionRightPanelTabId[] = [];

const SESSION_TAB_META: ReadonlyArray<{
  id: SessionRightPanelTabId;
  labelKey: "layout.tabTurns" | "layout.tabSideChat" | "layout.schedTasks";
  /** Tooltip while the tab is showing (= the close affordance). */
  closeTitleKey: "layout.rightPanelCloseTab";
  Icon: typeof IconListDetails;
  /** Command whose shortcut hint is appended to the tooltip (null = none). */
  commandId: string | null;
}> = [
  { id: "turns", labelKey: "layout.tabTurns", closeTitleKey: "layout.rightPanelCloseTab", Icon: IconListDetails, commandId: null },
  { id: "sidechat", labelKey: "layout.tabSideChat", closeTitleKey: "layout.rightPanelCloseTab", Icon: IconMessages, commandId: "sidechat.open" },
  { id: "sched", labelKey: "layout.schedTasks", closeTitleKey: "layout.rightPanelCloseTab", Icon: IconClock, commandId: null },
];

export function RightPanel() {
  const { t } = useI18n();
  const sessionId = useSessionStore((s) => s.activeSessionId);
  const rightOpen = useSessionStore((s) => s.rightOpen);
  const globalTab = useSessionStore((s) => s.rightPanelTab);
  // This session's session-scoped tabs (open set + which one is showing).
  const sessionTabs = useSessionStore((s) => (sessionId ? s.sessionRightTabsBySession[sessionId] : undefined));
  const openSessionTab = useSessionStore((s) => s.openSessionRightTab);
  const closeSessionTab = useSessionStore((s) => s.closeSessionRightTab);
  const setTab = useSessionStore((s) => s.setRightPanelTab);
  const browserTabCount = useSessionStore((s) => s.browserTabCount);
  const terminalPosition = useSessionStore((s) => s.terminalPosition);
  const bottomTerminalOpen = useSessionStore((s) => s.bottomTerminalOpen);
  const setBottomTerminalOpen = useSessionStore((s) => s.setBottomTerminalOpen);
  const widePanelOpen = useSessionStore((s) => s.widePanelOpen);
  const setWidePanelOpen = useSessionStore((s) => s.setWidePanelOpen);
  const orchRuns = useSessionStore((s) => (sessionId ? s.orchRunsBySession[sessionId] : undefined));
  const orchAuto = useSessionStore((s) => (sessionId ? !!s.orchAutoBySession[sessionId] : false));
  const messages = useSessionStore((s) => (sessionId ? s.messagesBySession[sessionId] : undefined));
  const loadOrchRuns = useSessionStore((s) => s.loadOrchRuns);

  // "+" menu state — opens the session-scoped tabs. Its popup can overlap the
  // embedded browser's WebContentsView, so suppress the view while open
  // (geometry-aware; same pattern as the other renderer popups).
  const [addOpen, setAddOpen] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  useSuppressBrowserView(addOpen, popupRef);

  // Effective tab: an active session-scoped tab shadows the global one.
  const tab = sessionTabs?.active ?? globalTab;
  const openSessionTabs = sessionTabs?.open ?? EMPTY_SESSION_TABS;
  const effectiveOpenTabs = useMemo(() => {
    if (tab === "sched" && !openSessionTabs.includes("sched")) {
      return [...openSessionTabs, "sched" as const];
    }
    return openSessionTabs;
  }, [openSessionTabs, tab]);

  // 保证当前会话的编排运行记录已拉取
  useEffect(() => {
    if (sessionId && orchRuns === undefined) {
      void loadOrchRuns(sessionId);
    }
  }, [sessionId, orchRuns, loadOrchRuns]);

  // 判断当前会话是否有编排:
  // 1. 开启了自动编排开关
  // 2. 本地已拉取且存在编排运行
  // 3. 当前会话消息流中包含编排卡片(画布或结果整理卡)
  const hasOrchestration = useMemo(() => {
    if (!sessionId) return false;
    if (orchAuto) return true;
    if ((orchRuns?.length ?? 0) > 0) return true;
    if (messages?.some((m) => m.blocks.some((b) => b.kind === "orch-canvas" || b.kind === "orch-synth"))) {
      return true;
    }
    return false;
  }, [sessionId, orchAuto, orchRuns, messages]);

  // 当处于编排 tab 但当前会话数据拉取完毕后确认无编排时,自动回退到文件面板
  useEffect(() => {
    if (tab === "orch" && orchRuns !== undefined && !hasOrchestration) {
      setTab("files");
    }
  }, [tab, orchRuns, hasOrchestration, setTab]);

  // Append the effective shortcut for a command's tooltip (same pattern as the
  // Titlebar's hintFor; cheap - a handful of lookups per render).
  const overrides = useSessionStore((s) => s.shortcutOverrides);
  const hintFor = (commandId: string): string => {
    const a = resolveShortcut(commandId, overrides);
    return a ? ` (${acceleratorToDisplayString(a)})` : "";
  };

  return (
    <div className="flex h-full flex-col">
      {/* Horizontal icon rail — always visible, docked at the panel's top
          edge. Each icon is a square button; the active one is marked with
          the accent token. Fixed (global) tabs first, then this session's
          opened session-scoped tabs, then the trailing "+" menu. */}
      <div className="flex h-9 shrink-0 flex-row items-center gap-1 border-b border-edge-panel bg-surface px-1.5">
        <RailButton
          active={tab === "files"}
          onClick={() => setTab("files")}
          title={t("layout.tabFiles")}
        >
          <IconFolder size={16} className="shrink-0" />
        </RailButton>
        <RailButton
          active={tab === "git"}
          onClick={() => setTab("git")}
          title="Git" /* brand name */
        >
          <IconGitBranch size={16} className="shrink-0" />
        </RailButton>
        <RailButton
          active={tab === "github"}
          onClick={() => setTab("github")}
          title={t("layout.tabGithub")}
        >
          <IconBrandGithub size={16} className="shrink-0" />
        </RailButton>
        {terminalPosition !== "bottom" && (
          <RailButton
            active={tab === "terminal"}
            onClick={() => setTab("terminal")}
            title={t("layout.tabTerminal")}
          >
            <IconTerminal2 size={16} className="shrink-0" />
          </RailButton>
        )}
        <RailButton
          active={tab === "browser"}
          onClick={() => setTab("browser")}
          badgeCount={browserTabCount}
          title={t("layout.tabBrowser") + hintFor("layout.toggle-browser")}
        >
          <IconWorld size={16} className="shrink-0" />
        </RailButton>
        {/* Orchestration DAG — runs scoped to the active (coordinator)
            session: task graph, node controls, gates, worker reports.
            仅有编排的会话才展示该 tab */}
        {hasOrchestration && (
          <RailButton
            active={tab === "orch"}
            onClick={() => setTab("orch")}
            title={t("layout.tabOrch")}
          >
            <IconGitFork size={16} className="shrink-0" />
          </RailButton>
        )}
        {/* Session-scoped tabs (turn flow / sub-sessions / browser / automation) — rendered
            only for opened set. Same toggle semantics: click a
            non-showing tab to show it; click the showing one to CLOSE it
            (panel falls back to the global tab). Hovering the showing tab
            swaps its icon for an × so the close affordance is discoverable;
            the "+" menu's × closes the ones that aren't showing. The browser
            icon carries the open-tab-count badge. */}
        {SESSION_TAB_META.filter((m) => effectiveOpenTabs.includes(m.id)).map(({ id, labelKey, closeTitleKey, Icon, commandId }) => {
          const showing = tab === id;
          return (
            <RailButton
              key={id}
              active={showing}
              badgeCount={id === "browser" ? browserTabCount : undefined}
              onClick={() => {
                if (showing) {
                  closeSessionTab(id);
                  if (globalTab === id) setTab("files");
                } else {
                  openSessionTab(id);
                }
              }}
              title={
                showing
                  ? t(closeTitleKey)
                  : t(labelKey) + (commandId ? hintFor(commandId) : "")
              }
            >
              {showing ? (
                <>
                  <Icon size={16} className="shrink-0 group-hover:hidden" />
                  <IconX size={16} className="hidden shrink-0 group-hover:block" />
                </>
              ) : (
                <Icon size={16} className="shrink-0" />
              )}
            </RailButton>
          );
        })}
        {/* Right end: the "+" menu that opens the session-scoped tabs, then
            the wide-panel (3:7) toggle. Pushed to the rail's far right with
            ml-auto. */}
        <div className="ml-auto flex items-center gap-1">
          <Menu.Root open={addOpen} onOpenChange={setAddOpen}>
            <Menu.Trigger
              className={cn(
                "flex h-7 w-7 items-center justify-center rounded-md outline-none transition-colors",
                "text-content-muted hover:bg-surface-hover hover:text-content",
                "data-[popup-open]:bg-surface-hover data-[popup-open]:text-content",
              )}
              title={t("layout.rightPanelAddTab")}
              aria-label={t("layout.rightPanelAddTab")}
            >
              <IconPlus size={16} className="shrink-0" />
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Positioner side="bottom" align="end" sideOffset={6}>
                <Menu.Popup
                  ref={popupRef}
                  className={cn(
                    "z-50 min-w-[210px] origin-top-right rounded-lg border border-edge bg-surface py-1 shadow-2xl",
                    "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
                    "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
                    "transition-[transform,opacity] duration-100",
                  )}
                >
                  {SESSION_TAB_META.map(({ id, labelKey, Icon, commandId }) => {
                    const isOpen = effectiveOpenTabs.includes(id);
                    const active = tab === id;
                    return (
                      <Menu.Item
                        key={id}
                        onClick={() => openSessionTab(id)}
                        className={cn(
                          "group flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs outline-none select-none",
                          "data-[highlighted]:bg-surface-muted",
                          active ? "text-accent" : "text-content-muted",
                        )}
                        title={t(labelKey) + (commandId ? hintFor(commandId) : "")}
                      >
                        <Icon size={14} className="shrink-0" />
                        <span className="min-w-0 flex-1 truncate">{t(labelKey)}</span>
                        {active && <IconCheck size={13} className="shrink-0" />}
                        {/* Close affordance for an opened tab. stopPropagation
                            keeps base-ui from treating the × click as the
                            row's activate action, so the menu stays open and
                            both tabs can be managed in one pass. */}
                        {isOpen && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              closeSessionTab(id);
                              if (globalTab === id) setTab("files");
                            }}
                            className={cn(
                              "-mr-1 flex h-4 w-4 shrink-0 items-center justify-center rounded text-content-subtle opacity-50 transition-opacity",
                              "hover:bg-surface-hover hover:text-content group-hover:opacity-100",
                            )}
                            title={t("layout.rightPanelCloseTab")}
                          >
                            <IconX size={12} />
                          </button>
                        )}
                      </Menu.Item>
                    );
                  })}
                  <div className="px-3 pb-1 pt-0.5 text-[9px] text-content-subtle/60">
                    {t("layout.rightPanelSessionHint")}
                  </div>
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
          <div className="h-5 w-px bg-edge" />
          <RailButton
            active={widePanelOpen}
            onClick={() => setWidePanelOpen(!widePanelOpen)}
            title={
              (widePanelOpen ? t("layout.exitWideMode") : t("layout.wideMode")) +
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
          overflow). Renders the panel matching the effective tab (an active
          session-scoped tab shadows the global one). The browser sidebar
          (mobile-first) renders inline here; the PC-fullscreen overlay is
          rendered at the App root and covers the whole workspace. */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {tab === "files" && <FilesPanel />}
        {tab === "git" && <GitPanel />}
        {tab === "github" && <GitHubPanel />}
        {terminalPosition === "right" && (
          <div className={cn("h-full w-full", tab === "terminal" ? "" : "hidden")}>
            <TerminalPanel active={tab === "terminal" && rightOpen} />
          </div>
        )}
        {tab === "turns" && <TurnFlowPanel />}
        {tab === "sidechat" && <SideChatPanel />}
        {tab === "orch" && hasOrchestration && <OrchPanel />}
        {tab === "sched" && <SchedPanel />}
        <div className={cn("h-full w-full", tab === "browser" ? "" : "hidden")}>
          <BrowserPanel mode="sidebar" />
        </div>
      </div>
    </div>
  );
}

/** A square icon button in the panel's rail. Active state uses the accent
 *  token; idle state uses the muted content token with a hover surface.
 *  Optional badgeCount renders the open-tab-count pill (browser). */
function RailButton({
  active,
  onClick,
  title,
  badgeCount,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  badgeCount?: number;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "group relative flex h-7 w-7 items-center justify-center rounded-md transition-colors",
        active
          ? "bg-accent/15 text-accent"
          : "text-content-muted hover:bg-surface-hover hover:text-content",
      )}
    >
      {children}
      {badgeCount !== undefined && badgeCount > 0 && (
        <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent px-1 text-[9px] font-bold leading-none text-white">
          {badgeCount}
        </span>
      )}
    </button>
  );
}
