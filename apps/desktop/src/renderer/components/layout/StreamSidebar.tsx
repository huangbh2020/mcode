/**
 * StreamSidebar — the session-first left-bar view ("stream" leftBarMode),
 * modeled on T3 Code's current sidebar (apps/web Sidebar.tsx):
 *
 *   [现状快捷入口: 新建会话 / 搜索 / 连接手机]   (SidebarQuickActions,原样式;
 *      新建会话在 scope 指向项目/工作树时改道到该处)
 *   [📁 全部项目 ▾]  [+]                        (scope filter + add project)
 *   ── pinned cards ── hairline ── live cards ── (flat, each card carries
 *      its project identity + an inline status label; running rows recede)
 *   ── 已归档 shelf (collapsed) ──
 *
 * Key semantics (from the T3 source):
 *  - Status lives IN the row as a colored label — 运行中(sky)+live duration /
 *    等待输入(amber) / 失败(red) / 完成(accent, unseen) — and yields to the
 *    hover action cluster. Rows that need a human stand out; in-flight rows
 *    recede ("working threads aren't your problem yet").
 *  - Worktree is a ROW attribute, not a container: fork + mcode/* branch on
 *    the card's meta line, unmerged dot beside it; the directory-level
 *    actions (merge back / rename / remove / new sibling) live on the row's
 *    context menu (shared SessionContextMenu's worktree group).
 *  - The tree view stays fully responsible for project management; the scope
 *    dropdown only FILTERS (plus an "add project" entry).
 *
 * Data: the same store buckets the tree reads — pinnedSessions for the
 * pinned block, the streamSessions aggregate (session.listAll) for the live
 * list, archivedSessionsByProject for the shelf. Mutations mark streamDirty
 * and this view refetches its first page (see sessionStore).
 */
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Menu } from "@base-ui/react/menu";
import {
  IconArchive,
  IconInbox,
  IconListTree,
  IconCheck,
  IconChevronRight,
  IconDots,
  IconFolder,
  IconFolderPlus,
  IconFocus,
  IconGitBranch,
  IconGitFork,
  IconLayoutSidebarLeftExpand,
  IconLoader2,
  IconMoon,
  IconPin,
  IconPinnedFilled,
  IconPlus,
  IconSettings,
  IconSun,
  IconTrash,
  IconX,
} from "@renderer/lib/icons.js";
import { cn } from "@renderer/lib/cn.js";
import { getProviderIcon } from "@renderer/lib/providerIcon.js";
import { projectDisplayColor, projectInitial } from "@renderer/lib/projectAvatar.js";
import { isMac } from "@renderer/lib/platform.js";
import { formatRelativeTime, formatFullTime } from "@renderer/lib/time.js";
import { normWorktreeKey, worktreeDisplayName } from "@renderer/lib/worktree.js";
import { useTheme, applyThemeClass } from "@renderer/lib/theme.js";
import { Button, ConfirmDialog } from "@renderer/components/ui/index.js";
import { api } from "@renderer/lib/api.js";
import { useCursorAnchor } from "@renderer/hooks/useCursorAnchor.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { WorktreeMergeBackDialog, WorktreeRemoveDialog } from "@renderer/components/chat/WorktreeMergeBack.js";
import { ProjectManageMenuPopup, type ManageMenuState } from "./ProjectManageMenu.js";
import { SidebarQuickActions } from "./SidebarQuickActions.js";
import { ArchivedRow, HoverIconButton, RenameDialog, SessionContextMenu } from "./SidebarShared.js";
import { BrandLogo } from "./BrandLogo.js";
import type { Project, Session } from "@contracts/session";
import type { GitWorktreeInfo } from "@contracts/ipc";
import { useI18n } from "@renderer/lib/i18n/index.js";

/** mm:ss (h:mm:ss past an hour) for the running-turn duration label. */
function formatRunningDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

/* ── Left↔stream view switch (mounted in BOTH sidebars' top strips) ── */

export function LeftBarModeSwitch() {
  const { t } = useI18n();
  const mode = useSessionStore((s) => s.leftBarMode);
  const setLeftBarMode = useSessionStore((s) => s.setLeftBarMode);
  return (
    <button
      type="button"
      onClick={() => void setLeftBarMode(mode === "tree" ? "stream" : "tree")}
      className={cn(
        "flex h-7 w-7 items-center justify-center rounded text-content-muted transition-colors",
        "hover:bg-surface-hover hover:text-accent",
      )}
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      title={mode === "tree" ? t("layout.stream.switchToStream") : t("layout.stream.switchToTree")}
    >
      {/* Destination-view glyph: shows the view clicking leads to, matching the tooltip. */}
      {mode === "tree" ? <IconInbox size={18} className="shrink-0" /> : <IconListTree size={18} className="shrink-0" />}
    </button>
  );
}

/* ── Card status model ── */

type StreamStatus =
  | { kind: "working"; startedAt: number }
  | { kind: "input" }
  | { kind: "failed" }
  | { kind: "done" }
  | { kind: "time" };

interface StreamStatusSignals {
  runningBySession: Record<string, boolean>;
  runningTurnStartedAt: Record<string, number>;
  pendingQuestionBySession: Record<string, unknown>;
  turnErrorBySession: Record<string, boolean>;
  unreadBySession: Record<string, number>;
}

function statusOf(s: Session, sig: StreamStatusSignals): StreamStatus {
  if (sig.runningBySession[s.id]) {
    return { kind: "working", startedAt: sig.runningTurnStartedAt[s.id] ?? Date.now() };
  }
  if (sig.pendingQuestionBySession[s.id] != null) return { kind: "input" };
  if (sig.turnErrorBySession[s.id]) return { kind: "failed" };
  if ((sig.unreadBySession[s.id] ?? 0) > 0) return { kind: "done" };
  return { kind: "time" };
}

/* ── The sidebar ── */

function StreamSidebarBase() {
  const { t } = useI18n();
  const projects = useSessionStore((s) => s.projects);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const pinnedSessions = useSessionStore((s) => s.pinnedSessions);
  const streamSessions = useSessionStore((s) => s.streamSessions);
  const streamHasMore = useSessionStore((s) => s.streamHasMore);
  const streamTotal = useSessionStore((s) => s.streamTotal);
  const streamDirty = useSessionStore((s) => s.streamDirty);
  const archivedSessionsByProject = useSessionStore((s) => s.archivedSessionsByProject);
  const runningBySession = useSessionStore((s) => s.runningBySession);
  const runningTurnStartedAt = useSessionStore((s) => s.runningTurnStartedAt);
  const pendingQuestionBySession = useSessionStore((s) => s.pendingQuestionBySession);
  const turnErrorBySession = useSessionStore((s) => s.turnErrorBySession);
  const unreadBySession = useSessionStore((s) => s.unreadBySession);
  const worktreeInfoByRepo = useSessionStore((s) => s.worktreeInfoByRepo);
  const worktreeNames = useSessionStore((s) => s.worktreeNames);
  const projectColors = useSessionStore((s) => s.projectColors);
  const gitChangeVersionByRepo = useSessionStore((s) => s.gitChangeVersionByRepo);

  const loadStreamSessions = useSessionStore((s) => s.loadStreamSessions);
  const loadMoreStreamSessions = useSessionStore((s) => s.loadMoreStreamSessions);
  const ensureWorktreeInfo = useSessionStore((s) => s.ensureWorktreeInfo);
  const openTab = useSessionStore((s) => s.openTab);
  const startSession = useSessionStore((s) => s.startSession);
  const archiveSession = useSessionStore((s) => s.archiveSession);
  const deleteSession = useSessionStore((s) => s.deleteSession);
  const setSessionPinned = useSessionStore((s) => s.setSessionPinned);
  const renameSession = useSessionStore((s) => s.renameSession);
  const renameWorktree = useSessionStore((s) => s.renameWorktree);
  const archiveProject = useSessionStore((s) => s.archiveProject);
  const deleteProject = useSessionStore((s) => s.deleteProject);
  const addProject = useSessionStore((s) => s.addProjectFromFolder);
  const setProjectGroup = useSessionStore((s) => s.setProjectGroup);
  const renameProject = useSessionStore((s) => s.renameProject);
  const setProjectColor = useSessionStore((s) => s.setProjectColor);
  const setSettingsOpen = useSessionStore((s) => s.setSettingsOpen);
  const setLeftOpen = useSessionStore((s) => s.setLeftOpen);

  // ── Data lifecycle. The aggregate refetches whenever the dirty flag is
  // set while this view is mounted (send / remote change / pin / archive…).
  // Warm+clean mounts are a no-op. Worktree inventories refresh per repo on
  // mount and whenever any repo's git version bumps.
  useEffect(() => {
    void loadStreamSessions();
  }, [streamDirty, loadStreamSessions]);

  useEffect(() => {
    for (const p of projects) void ensureWorktreeInfo(p.path);
  }, [projects, gitChangeVersionByRepo, ensureWorktreeInfo]);

  // ── Project lookup + scope filter. Scope lives in the store (persisted
  // under `ui.streamScope`): null = 全部项目, "g:<name>" = a project group,
  // otherwise a projectId — so the last selected project is still selected
  // the next time the user enters the view.
  const projectById = useMemo(() => {
    const map = new Map<string, Project>();
    for (const p of projects) map.set(p.id, p);
    return map;
  }, [projects]);

  const streamScope = useSessionStore((s) => s.streamScope);
  // Store action, aliased to the old local-setter name — every scope menu
  // row writes through it (persisting the choice for the next visit).
  const setScope = useSessionStore((s) => s.setStreamScope);
  const [scopeOpen, setScopeOpen] = useState(false);
  // A persisted scope can go stale (project deleted / archived, group
  // dissolved) between write and read — degrade those to the unfiltered
  // view instead of an empty list. Reactive (not dropped at hydration)
  // because the project list lands AFTER the sidebar's first paint.
  // Worktree scopes pass through: their matcher is safe and the inventory
  // probe may simply not have landed yet.
  const scope = useMemo(() => {
    if (streamScope == null) return null;
    if (streamScope.startsWith("g:")) {
      const name = streamScope.slice(2);
      return projects.some((p) => !p.archived && p.group === name) ? streamScope : null;
    }
    if (streamScope.startsWith("wt:")) return streamScope;
    const project = projectById.get(streamScope);
    return project && !project.archived ? streamScope : null;
  }, [streamScope, projectById]);
  const scopeMatches = useCallback(
    (s: Session) => {
      if (scope == null) return true;
      if (scope.startsWith("g:")) return projectById.get(s.projectId)?.group === scope.slice(2);
      // "wt:<normWorktreeKey>" — sessions bound to that isolated checkout.
      if (scope.startsWith("wt:")) {
        return s.worktreePath != null && normWorktreeKey(s.worktreePath) === scope.slice(3);
      }
      return s.projectId === scope;
    },
    [scope, projectById],
  );

  // Project → its selectable worktrees (non-main, non-missing entries from
  // the per-repo inventory; empty while the probe hasn't landed). Shared by
  // the scope menu rows, the trigger label, and the quick-action override.
  const worktreesByProject = useMemo(() => {
    const map = new Map<
      string,
      { key: string; name: string; path: string; referencedBy: number }[]
    >();
    for (const p of projects) {
      const info = worktreeInfoByRepo[p.path];
      if (!info) continue;
      const wts = info.worktrees
        .filter((w) => !w.main && !w.missing)
        .map((w) => ({
          key: normWorktreeKey(w.path),
          name: worktreeDisplayName(w.path, worktreeNames),
          path: w.path,
          referencedBy: w.referencedBy,
        }));
      if (wts.length > 0) map.set(p.id, wts);
    }
    return map;
  }, [projects, worktreeInfoByRepo, worktreeNames]);

  // The worktree the scope currently points at, if it can host a new
  // session: the main-side bind validation only accepts MANAGED checkout
  // paths (referenced by at least one existing session), so a foreign /
  // orphaned worktree scope falls back to the default new-session behavior.
  const scopedWorktree = useMemo(() => {
    if (!scope?.startsWith("wt:")) return null;
    const key = scope.slice(3);
    for (const [projectId, wts] of worktreesByProject) {
      const hit = wts.find((w) => w.key === key);
      if (hit) return hit.referencedBy > 0 ? { projectId, path: hit.path } : null;
    }
    return null;
  }, [scope, worktreesByProject]);

  // The plain project the scope points at, if any (group / worktree / null
  // scopes don't single one out). The 新建会话 quick action spawns the new
  // thread HERE instead of the active project — the user filtered to this
  // project, so that's where "new session" should land.
  const scopedProjectId =
    scope != null && !scope.startsWith("g:") && !scope.startsWith("wt:") ? scope : null;

  const scopeLabel = useMemo(() => {
    if (scope == null) return t("layout.stream.scopeAll");
    if (scope.startsWith("g:")) return scope.slice(2);
    if (scope.startsWith("wt:")) {
      const key = scope.slice(3);
      for (const wts of worktreesByProject.values()) {
        const hit = wts.find((w) => w.key === key);
        if (hit) return hit.name;
      }
      // Inventory probe not landed (or raced): fall back to any cached
      // session row bound to that checkout before giving up.
      const bound = useSessionStore
        .getState()
        .streamSessions.find((x) => x.worktreePath && normWorktreeKey(x.worktreePath) === key);
      if (bound?.worktreePath) return worktreeDisplayName(bound.worktreePath, worktreeNames);
      return t("layout.stream.scopeWorktree");
    }
    return projectById.get(scope)?.name ?? t("layout.stream.scopeAll");
  }, [scope, worktreesByProject, worktreeNames, t]);

  const knownGroups = useMemo(() => {
    const set = new Set<string>();
    for (const p of projects) if (!p.archived && p.group) set.add(p.group);
    return Array.from(set);
  }, [projects]);

  // Worktree row info (branch / dirty / merged), resolved from the per-repo
  // inventory; null while the probe hasn't landed yet (chip/dot simply hide).
  const worktreeOf = useCallback(
    (s: Session): GitWorktreeInfo | null => {
      if (!s.worktreePath) return null;
      const proj = projectById.get(s.projectId);
      if (!proj) return null;
      const info = worktreeInfoByRepo[proj.path];
      if (!info) return null;
      const key = normWorktreeKey(s.worktreePath);
      return info.worktrees.find((w) => normWorktreeKey(w.path) === key) ?? null;
    },
    [projectById, worktreeInfoByRepo],
  );

  // Local sessions show the PROJECT ROOT's checked-out branch in the meta
  // line (the main worktree's branch; detached HEAD degrades to the short
  // SHA). null while the probe hasn't landed or the project isn't a git
  // repo — the slot simply stays empty, same as worktree chips.
  const localBranchOf = useCallback(
    (s: Session): string | null => {
      if (s.worktreePath) return null;
      const proj = projectById.get(s.projectId);
      if (!proj) return null;
      const info = worktreeInfoByRepo[proj.path];
      if (!info) return null;
      const main = info.worktrees.find((w) => w.main);
      if (!main) return null;
      return main.branch || (main.head ? main.head.slice(0, 7) : null);
    },
    [projectById, worktreeInfoByRepo],
  );

  // ── Live duration ticker: only ticks while something is running.
  const anyRunning = streamSessions.some((s) => runningBySession[s.id]) ||
    pinnedSessions.some((s) => runningBySession[s.id]);
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (!anyRunning) return;
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [anyRunning]);

  const statusSignals: StreamStatusSignals = {
    runningBySession,
    runningTurnStartedAt,
    pendingQuestionBySession,
    turnErrorBySession,
    unreadBySession,
  };

  // ── Archive shelf content: archived projects + archived sessions
  // (flattened across projects, newest first), matching the tree's bin.
  const archivedProjects = useMemo(() => projects.filter((p) => p.archived), [projects]);
  const archivedList = useMemo(() => {
    const out: Session[] = [];
    for (const list of Object.values(archivedSessionsByProject)) out.push(...list);
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }, [archivedSessionsByProject]);
  const archivedCount = archivedProjects.length + archivedList.length;
  const [archiveOpen, setArchiveOpen] = useState(false);

  // ── Dialogs / menus (same wiring as the tree view).
  const [ctxMenu, setCtxMenu] = useState<{ session: Session; x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<
    { id: string; title: string; kind: "session" | "project" | "worktree" | "group" } | null
  >(null);
  const [confirmDelete, setConfirmDelete] = useState<
    | { kind: "project"; id: string; name: string }
    | { kind: "session"; id: string; title: string }
    | null
  >(null);
  const [wtMerge, setWtMerge] = useState<{ repoPath: string; worktreePath: string } | null>(null);
  const [wtRemove, setWtRemove] = useState<{ repoPath: string; worktreePath: string } | null>(null);

  // ── Project manage menu (⋯ icon on a scope-dropdown project row) — the
  // same light manager the composer chip shows: rename / group / color.
  const [manageMenu, setManageMenu] = useState<ManageMenuState | null>(null);
  const manageAnchor = useCursorAnchor(manageMenu);
  const openProjectManage = (p: Project, e: React.MouseEvent) => {
    e.stopPropagation();
    setScopeOpen(false);
    setManageMenu({ project: p, x: e.clientX, y: e.clientY });
  };

  // Row-end manage affordance on project rows: faintly visible always, full
  // strength on row hover (matches the chip). stopPropagation keeps the
  // click from switching scope; base-ui never sees it.
  const manageButton = (p: Project) => (
    <button
      type="button"
      onClick={(e) => openProjectManage(p, e)}
      className={cn(
        "-mr-1 flex h-4 w-4 shrink-0 items-center justify-center rounded text-content-subtle opacity-50 transition-opacity",
        "hover:bg-surface-hover hover:text-content group-hover:opacity-100",
      )}
      title={t("layout.projectManageIcon")}
    >
      <IconDots size={12} />
    </button>
  );

  // ── Scroll-to-active (flat version of the tree's locate logic): rows
  // register nodes; when the active row isn't mounted, load pages until it
  // appears (pinned rows are always mounted; archived ones need the shelf).
  const rowNodes = useRef<Map<string, HTMLLIElement>>(new Map());
  const registerNode = useCallback((id: string, el: HTMLLIElement | null) => {
    if (el) rowNodes.current.set(id, el);
    else rowNodes.current.delete(id);
  }, []);

  const locateActiveSession = useCallback((center = false) => {
    const id = useSessionStore.getState().activeSessionId;
    if (!id) return;
    const tryScroll = () => {
      const el = rowNodes.current.get(id);
      if (el) {
        el.scrollIntoView({ block: center ? "center" : "nearest", behavior: "smooth" });
        return true;
      }
      return false;
    };
    if (tryScroll()) return;
    void (async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      if (tryScroll()) return;
      const st = useSessionStore.getState();
      if (st.archivedSessionsByProject && Object.values(st.archivedSessionsByProject).some((l) => l.some((x) => x.id === id))) {
        setArchiveOpen(true);
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        tryScroll();
        return;
      }
      for (;;) {
        const s = useSessionStore.getState();
        if (!s.streamHasMore) break;
        await s.loadMoreStreamSessions();
        if (tryScroll()) break;
      }
    })();
  }, []);

  useEffect(() => {
    if (!activeSessionId) return;
    locateActiveSession();
  }, [activeSessionId, locateActiveSession]);

  // ── Shared card renderer (pinned block + live list).
  const renderCard = useCallback(
    (s: Session, opts: { pinned: boolean }) => {
      const proj = projectById.get(s.projectId);
      const status = statusOf(s, statusSignals);
      const wt = worktreeOf(s);
      const unmerged = wt != null && (wt.dirty || !wt.merged);
      return (
        <StreamCard
          key={s.id}
          session={s}
          projectName={proj?.name ?? "?"}
          projectColor={proj ? projectDisplayColor(proj, projectColors) : "#71717a"}
          status={status}
          now={nowTick}
          active={s.id === activeSessionId}
          pinned={opts.pinned}
          worktreeBranch={wt?.branch || null}
          worktreeUnmerged={unmerged}
          localBranch={localBranchOf(s)}
          onSelect={() => void openTab(s.id)}
          onNewSession={() => {
            // Worktree-bound card spawns a sibling thread on the SAME
            // checkout (fork button + worktree wording); a local card
            // starts a plain session under the project.
            if (s.worktreePath) void startSession(s.projectId, { worktreePath: s.worktreePath ?? undefined });
            else void startSession(s.projectId);
          }}
          onTogglePin={() => void setSessionPinned(s.id, s.pinnedAt == null)}
          onArchive={() => void archiveSession(s.id, true)}
          onDelete={() => setConfirmDelete({ kind: "session", id: s.id, title: s.title })}
          onContext={(x, y) => setCtxMenu({ session: s, x, y })}
          registerNode={registerNode}
        />
      );
    },
    // statusSignals fields are read inside; they're all store slices this
    // component subscribes to already, so the callback refreshes with them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectById, projectColors, nowTick, activeSessionId, runningBySession, runningTurnStartedAt,
      pendingQuestionBySession, turnErrorBySession, unreadBySession, worktreeOf, localBranchOf,
      openTab, startSession, setSessionPinned, archiveSession, registerNode],
  );

  const liveSessions = useMemo(
    () => streamSessions.filter(scopeMatches),
    [streamSessions, scopeMatches],
  );
  const pinnedList = useMemo(
    () => pinnedSessions.filter(scopeMatches),
    [pinnedSessions, scopeMatches],
  );

  const { effective: effectiveTheme } = useTheme();
  const toggleTheme = () => {
    const next = effectiveTheme === "dark" ? "light" : "dark";
    void api.theme.set({ theme: next }).then((s) => {
      applyThemeClass(s.effective);
    });
  };

  const menuItemClass = cn(
    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs outline-none select-none",
    "text-content-muted data-[highlighted]:bg-surface-muted",
  );

  // Worktree filter rows nested under their owning project's entry
  // (`indentClass` deepens one level for grouped projects). Each row filters
  // sessions bound to that checkout.
  const renderWorktreeItems = (projectId: string, indentClass: string) => {
    const wts = worktreesByProject.get(projectId);
    if (!wts) return null;
    return wts.map((w) => (
      <Menu.Item
        key={w.key}
        className={cn(menuItemClass, indentClass)}
        onClick={() => setScope(`wt:${w.key}`)}
      >
        <IconGitFork size={12} className="shrink-0 text-accent/80" />
        <span className="min-w-0 flex-1 truncate" title={w.path}>
          {w.name}
        </span>
        {scope === `wt:${w.key}` && <IconCheck size={13} className="shrink-0 text-accent" />}
      </Menu.Item>
    ));
  };

  return (
    <div className="flex h-full flex-col px-2 py-2 [font-size:var(--right-panel-font-size)]">
      {/* Top strip — same layout contract as the tree view (mac: traffic
          lights strip; win: brand header), plus the mode switch. */}
      {isMac ? (
        <div
          className="-mt-2 mb-2 flex h-10 items-center gap-1 pl-[70px]"
          style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
        >
          <button
            type="button"
            onClick={() => setLeftOpen(false)}
            className={cn(
              "flex h-7 w-7 items-center justify-center rounded text-content-muted transition-colors",
              "hover:bg-surface-hover hover:text-content",
            )}
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            title={t("layout.hideLeftPanel")}
          >
            <IconLayoutSidebarLeftExpand size={18} className="shrink-0" />
          </button>
          <LeftBarModeSwitch />
        </div>
      ) : (
        <div className="mb-2" style={{ WebkitAppRegion: "drag" } as React.CSSProperties}>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setLeftOpen(false)}
              className={cn(
                "group flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors",
                "hover:bg-surface-hover/60",
              )}
              style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
              title={t("layout.hideLeftPanel")}
            >
              <BrandLogo size={30} />
              <span className="flex min-w-0 flex-col leading-tight">
                <span className="truncate text-[1.07em] font-semibold tracking-tight text-content">
                  Mcode
                </span>
                <span className="truncate text-content-subtle [font-size:var(--rp-fs-sm)]">
                  {t("layout.tagline")}
                </span>
              </span>
            </button>
            <LeftBarModeSwitch />
          </div>
        </div>
      )}

      {/* 快捷入口 — 现状组件,原样挂载。Scoped to a managed worktree, the
          新建会话 entry spawns the session in THAT checkout; scoped to a
          plain project, it spawns under THAT project — both instead of the
          active project, since the user has explicitly narrowed where they
          are working. */}
      <SidebarQuickActions
        newSessionOverride={
          scopedWorktree
            ? () => void startSession(scopedWorktree.projectId, { worktreePath: scopedWorktree.path })
            : scopedProjectId
              ? () => void startSession(scopedProjectId)
              : undefined
        }
        newSessionOverrideTitle={scopedWorktree ? undefined : scopedProjectId ? t("layout.newSessionHere") : undefined}
      />

      {/* Scope filter: 全部项目 / per-project (+ its worktrees) / group +
          add project. Box metrics mirror SidebarQuickActions' rows (full
          width, rounded-lg, px-1 py-2, 16px icon) so the control reads as
          part of the same dock. */}
      <div className="mb-1">
        <Menu.Root open={scopeOpen} onOpenChange={setScopeOpen}>
          <Menu.Trigger
            className={cn(
              "flex w-full min-w-0 items-center gap-2 rounded-lg px-1 py-2 text-left transition-colors",
              "[font-size:var(--right-panel-font-size)]",
              "text-content-muted hover:bg-surface-hover/60",
            )}
          >
            {scope?.startsWith("wt:") ? (
              <IconGitFork size={16} className="shrink-0 text-accent/80" />
            ) : scope != null && !scope.startsWith("g:") && projectById.get(scope) ? (
              <span
                className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-[9px] font-bold text-white"
                style={{ backgroundColor: projectDisplayColor(projectById.get(scope)!, projectColors) }}
                aria-hidden
              >
                {projectInitial(projectById.get(scope)!.name)}
              </span>
            ) : (
              <IconFolder size={16} className="shrink-0 text-content-subtle" />
            )}
            <span className="min-w-0 flex-1 truncate font-medium">{scopeLabel}</span>
            <IconChevronRight size={12} className="shrink-0 rotate-90 text-content-subtle" />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner align="start">
              <Menu.Popup
                className={cn(
                  "z-50 min-w-[200px] origin-top-left rounded-md border border-edge bg-surface py-1 shadow-2xl",
                  "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
                  "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
                  "transition-[transform,opacity] duration-100",
                )}
              >
                <Menu.Item className={menuItemClass} onClick={() => setScope(null)}>
                  <IconFolder size={14} className="shrink-0" />
                  <span className="flex-1 truncate">{t("layout.stream.scopeAll")}</span>
                  {scope == null && <IconCheck size={13} className="shrink-0 text-accent" />}
                </Menu.Item>
                {projects
                  .filter((p) => !p.archived && !p.group)
                  .map((p) => (
                    <Fragment key={p.id}>
                      <Menu.Item
                        className={cn(menuItemClass, "group")}
                        onClick={() => setScope(p.id)}
                      >
                        <span
                          className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded text-[8px] font-bold text-white"
                          style={{ backgroundColor: projectDisplayColor(p, projectColors) }}
                          aria-hidden
                        >
                          {projectInitial(p.name)}
                        </span>
                        <span className="flex-1 truncate">{p.name}</span>
                        {scope === p.id && <IconCheck size={13} className="shrink-0 text-accent" />}
                        {manageButton(p)}
                      </Menu.Item>
                      {renderWorktreeItems(p.id, "pl-7")}
                    </Fragment>
                  ))}
                {knownGroups.length > 0 && (
                  <>
                    <Menu.Separator className="my-1 h-px bg-edge" />
                    <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-content-subtle">
                      {t("layout.stream.scopeGroupCap")}
                    </div>
                    {/* Each group stays directly selectable (filters the
                        whole group), with its member projects listed
                        indented beneath it as their own filter entries. */}
                    {knownGroups.map((g) => {
                      const members = projects.filter((p) => !p.archived && p.group === g);
                      return (
                        <Fragment key={g}>
                          <Menu.Item
                            className={menuItemClass}
                            onClick={() => setScope(`g:${g}`)}
                          >
                            <IconFolder size={14} className="shrink-0" />
                            <span className="flex-1 truncate">{g}</span>
                            {scope === `g:${g}` && <IconCheck size={13} className="shrink-0 text-accent" />}
                          </Menu.Item>
                          {members.map((p) => (
                            <Fragment key={p.id}>
                              <Menu.Item
                                className={cn(menuItemClass, "group", "pl-7")}
                                onClick={() => setScope(p.id)}
                              >
                                <span
                                  className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded text-[8px] font-bold text-white"
                                  style={{ backgroundColor: projectDisplayColor(p, projectColors) }}
                                  aria-hidden
                                >
                                  {projectInitial(p.name)}
                                </span>
                                <span className="flex-1 truncate">{p.name}</span>
                                {scope === p.id && <IconCheck size={13} className="shrink-0 text-accent" />}
                                {manageButton(p)}
                              </Menu.Item>
                              {renderWorktreeItems(p.id, "pl-11")}
                            </Fragment>
                          ))}
                        </Fragment>
                      );
                    })}
                  </>
                )}
                <Menu.Separator className="my-1 h-px bg-edge" />
                <Menu.Item className={menuItemClass} onClick={() => void addProject()}>
                  <IconFolderPlus size={14} className="shrink-0 text-accent" />
                  {t("layout.addProject")}
                </Menu.Item>
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      </div>

      {/* Flat list: pinned cards ─ hairline ─ live cards ─ show more. */}
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {liveSessions.length === 0 && pinnedList.length === 0 ? (
          <div className="px-2 py-8 text-center text-content-subtle [font-size:var(--rp-fs-sm)]">
            {t("layout.stream.empty")}
          </div>
        ) : (
          <ul className="space-y-0.5">
            {pinnedList.map((s) => renderCard(s, { pinned: true }))}
            {pinnedList.length > 0 && <div className="mx-2.5 my-1.5 h-px bg-edge/60" aria-hidden />}
            {liveSessions.map((s) => renderCard(s, { pinned: false }))}
            {streamHasMore && (
              <li>
                <button
                  onClick={() => void loadMoreStreamSessions()}
                  className={cn(
                    "w-full rounded px-2.5 py-1.5 text-left text-content-subtle transition-colors [font-size:var(--rp-fs-sm)]",
                    "hover:bg-surface-hover/60 hover:text-accent",
                  )}
                >
                  {t("layout.stream.showMore", {
                    // streamTotal counts the CURRENT scope's unpinned rows
                    // (the server filters by scope; pinned never counted) —
                    // so the remainder is total minus the loaded live rows.
                    n: Math.max(streamTotal - liveSessions.length, 0),
                  })}
                </button>
              </li>
            )}
          </ul>
        )}

        {/* Archive shelf — collapsed by default (the tree's bin contents). */}
        {archivedCount > 0 && (
          <div className="mt-2">
            <button
              onClick={() => setArchiveOpen(!archiveOpen)}
              className="mb-1 mt-2 flex w-full items-center gap-2 px-1.5 text-left"
            >
              <span className="[font-size:var(--rp-fs-sm)] font-medium text-content-subtle/70">
                {t("layout.archivedCount", { n: archivedCount })}
              </span>
              <span className="h-px flex-1 bg-edge/60" aria-hidden />
              <IconChevronRight
                size={12}
                className={cn(
                  "shrink-0 text-content-subtle/70 transition-transform",
                  archiveOpen && "rotate-90",
                )}
              />
            </button>
            {archiveOpen && (
              <ul className="space-y-0.5">
                {archivedProjects.map((p) => (
                  <ArchivedRow
                    key={p.id}
                    icon={<IconFolder size={14} className="opacity-60" />}
                    title={p.name}
                    onRestore={() => void archiveProject(p.id, false)}
                    onDelete={() => setConfirmDelete({ kind: "project", id: p.id, name: p.name })}
                  />
                ))}
                {archivedList.map((s) => (
                  <ArchivedRow
                    key={s.id}
                    icon={(() => {
                      const { Icon, color } = getProviderIcon(s.providerId);
                      return <Icon size={14} className={cn("opacity-60", color)} />;
                    })()}
                    title={s.title}
                    onRestore={() => void archiveSession(s.id, false)}
                    onDelete={() => setConfirmDelete({ kind: "session", id: s.id, title: s.title })}
                  />
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {/* Footer — same dock as the tree view. */}
      <div className="mt-2 flex shrink-0 items-center gap-1 border-t border-edge pt-1.5">
        <button
          onClick={() => setSettingsOpen(true)}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1.5 text-content-muted transition-colors [font-size:var(--right-panel-font-size)]",
            "hover:bg-surface-hover hover:text-content",
          )}
          title={t("layout.settings")}
        >
          <IconSettings size={14} className="shrink-0" />
          {t("layout.settings")}
        </button>
        <button
          onClick={() => locateActiveSession(true)}
          disabled={!activeSessionId}
          className={cn(
            "flex h-7 w-7 shrink-0 items-center justify-center rounded text-content-muted transition-colors [font-size:var(--right-panel-font-size)]",
            "hover:bg-surface-hover hover:text-content disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent",
          )}
          title={t("layout.locateSession")}
        >
          <IconFocus size={14} />
        </button>
        <button
          onClick={toggleTheme}
          className={cn(
            "flex h-7 w-7 shrink-0 items-center justify-center rounded text-content-muted transition-colors [font-size:var(--right-panel-font-size)]",
            "hover:bg-surface-hover hover:text-content",
          )}
          title={effectiveTheme === "dark" ? t("layout.themeToLight") : t("layout.themeToDark")}
        >
          {effectiveTheme === "dark" ? <IconSun size={14} /> : <IconMoon size={14} />}
        </button>
        {!isMac && (
          <button
            onClick={() => setLeftOpen(false)}
            className={cn(
              "flex h-7 w-7 shrink-0 items-center justify-center rounded text-content-muted transition-colors [font-size:var(--right-panel-font-size)]",
              "hover:bg-surface-hover hover:text-content",
            )}
            title={t("layout.hideLeftPanel")}
          >
            <IconLayoutSidebarLeftExpand size={14} />
          </button>
        )}
      </div>

      {/* Session context menu — with the worktree action group wired to the
          same dialogs the tree uses. */}
      <SessionContextMenu
        ctxMenu={ctxMenu}
        onClose={() => setCtxMenu(null)}
        onRename={(s) => { setCtxMenu(null); setRenaming({ id: s.id, title: s.title, kind: "session" }); }}
        onCopyTitle={(s) => { void navigator.clipboard.writeText(s.title); setCtxMenu(null); }}
        onOpenFolder={(s) => {
          setCtxMenu(null);
          const proj = projectById.get(s.projectId);
          if (proj) void api.shell.openPath({ path: proj.path });
        }}
        onTogglePin={(s) => { setCtxMenu(null); void setSessionPinned(s.id, s.pinnedAt == null); }}
        onNewWorktreeSession={(s) => {
          setCtxMenu(null);
          void startSession(s.projectId, { worktreePath: s.worktreePath ?? undefined });
        }}
        onMergeWorktree={(s) => {
          setCtxMenu(null);
          const proj = projectById.get(s.projectId);
          if (proj && s.worktreePath) setWtMerge({ repoPath: proj.path, worktreePath: s.worktreePath });
        }}
        onRenameWorktree={(s) => {
          setCtxMenu(null);
          if (s.worktreePath) setRenaming({ id: s.worktreePath, title: s.worktreePath.split(/[/\\/]/).pop() ?? s.worktreePath, kind: "worktree" });
        }}
        onRemoveWorktree={(s) => {
          setCtxMenu(null);
          const proj = projectById.get(s.projectId);
          if (proj && s.worktreePath) setWtRemove({ repoPath: proj.path, worktreePath: s.worktreePath });
        }}
      />

      <WorktreeRemoveDialog
        open={!!wtRemove}
        onOpenChange={(o) => { if (!o) setWtRemove(null); }}
        repoPath={wtRemove?.repoPath ?? null}
        worktreePath={wtRemove?.worktreePath ?? ""}
      />
      <WorktreeMergeBackDialog
        open={!!wtMerge}
        onOpenChange={(o) => { if (!o) setWtMerge(null); }}
        sessionId={null}
        worktreePath={wtMerge?.worktreePath ?? ""}
        repoPath={wtMerge?.repoPath ?? null}
      />

      {/* Project manage menu — opened from the ⋯ on a scope-dropdown
          project row; cursor-anchored, independent Menu.Root. */}
      <ProjectManageMenuPopup
        manageMenu={manageMenu}
        anchor={manageAnchor}
        knownGroups={knownGroups}
        projectColors={projectColors}
        onClose={() => setManageMenu(null)}
        onRename={(p) => setRenaming({ id: p.id, title: p.name, kind: "project" })}
        onLeaveGroup={(p) => void setProjectGroup(p.id, null)}
        onJoinGroup={(p, g) => void setProjectGroup(p.id, g)}
        onNewGroup={(p) => setRenaming({ id: p.id, title: "", kind: "group" })}
        onSetColor={(p, hex) => void setProjectColor(p.id, hex)}
        menuItemClass={menuItemClass}
      />

      <RenameDialog
        renaming={renaming}
        onClose={() => setRenaming(null)}
        onSubmit={async (id, title, kind) => {
          if (kind === "worktree") await renameWorktree(id, title);
          else if (kind === "project") await renameProject(id, title);
          else if (kind === "group") await setProjectGroup(id, title);
          else await renameSession(id, title);
          setRenaming(null);
        }}
      />

      <ConfirmDialog
        open={confirmDelete != null}
        danger
        title={confirmDelete?.kind === "project" ? t("layout.deleteProject") : t("layout.deleteThread")}
        description={
          confirmDelete?.kind === "project"
            ? t("layout.deleteProjectDesc", { name: confirmDelete.name })
            : t("layout.deleteThreadDesc", { title: confirmDelete?.title ?? "" })
        }
        confirmText={t("common.delete")}
        onOpenChange={(open) => { if (!open) setConfirmDelete(null); }}
        onConfirm={() => {
          if (!confirmDelete) return;
          if (confirmDelete.kind === "project") void deleteProject(confirmDelete.id);
          else void deleteSession(confirmDelete.id);
        }}
      />
    </div>
  );
}

export const StreamSidebar = memo(StreamSidebarBase);

/* ── One rich card (3 lines: project identity+status / title / branch+provider) ── */

function StreamCard({
  session, projectName, projectColor, status, now, active, pinned,
  worktreeBranch, worktreeUnmerged, localBranch, onSelect, onNewSession, onTogglePin, onArchive, onDelete,
  onContext, registerNode,
}: {
  session: Session;
  projectName: string;
  projectColor: string;
  status: StreamStatus;
  /** Ticker snapshot for the running duration; only advances while running. */
  now: number;
  active: boolean;
  pinned: boolean;
  /** Checked-out branch (null = detached or probe not landed). */
  worktreeBranch: string | null;
  /** dirty || !merged — the amber "work waiting to land" dot. */
  worktreeUnmerged: boolean;
  /** Project root's checked-out branch for LOCAL sessions (null = probe
   *  not landed / not a git repo / worktree session). */
  localBranch: string | null;
  onSelect: () => void;
  /** Spawn a new session: worktree-bound card → sibling on the same
   *  checkout; local card → plain session under the project. */
  onNewSession: () => void;
  onTogglePin: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onContext: (x: number, y: number) => void;
  registerNode: (id: string, el: HTMLLIElement | null) => void;
}) {
  const { t } = useI18n();
  const [pendingConfirm, setPendingConfirm] = useState<null | "archive" | "delete">(null);
  const [hovered, setHovered] = useState(false);
  const idle = pendingConfirm === null && status.kind !== "working";
  const showActions = idle && hovered;
  const { Icon: ProviderIcon, color: providerColor, label: providerLabel } =
    getProviderIcon(session.providerId);

  // In-flight recede: a running row that ISN'T the active one dims — the
  // prominence budget stays with rows that need a human (T3 semantics).
  const recede = status.kind === "working" && !active;

  // The meta line (L3) only ever carries content for a worktree-bound
  // session (fork + branch) or a local session whose project root is a git
  // repo (checked-out branch). A local session in a NON-git project has
  // neither — the card degrades to two lines and the provider icon moves up
  // next to the title instead of orphaning an empty row.
  const hasMetaLine = session.worktreePath != null || localBranch != null;

  const statusLabel = (() => {
    if (status.kind === "working") {
      return (
        <span className="flex items-center gap-1 font-semibold text-[#0369a1] dark:text-[#38bdf8]">
          <IconLoader2 size={11} className="animate-spin" />
          {t("layout.stream.statusWorking", { dur: formatRunningDuration(now - status.startedAt) })}
        </span>
      );
    }
    if (status.kind === "input") {
      return (
        <span className="font-semibold text-[#b45309] dark:text-[#fbbf24]">
          {t("layout.stream.statusInput")}
        </span>
      );
    }
    if (status.kind === "failed") {
      return <span className="font-semibold text-danger">{t("layout.stream.statusFailed")}</span>;
    }
    if (status.kind === "done") {
      return (
        <span className="flex items-center gap-1 font-semibold text-accent-strong">
          <IconCheck size={12} />
          {t("layout.stream.statusDone")}
        </span>
      );
    }
    return (
      <span className="text-content-subtle/80">
        {formatRelativeTime(session.updatedAt)}
      </span>
    );
  })();

  return (
    <li
      ref={(el) => registerNode(session.id, el)}
      onClick={() => { setPendingConfirm(null); onSelect(); }}
      onMouseEnter={() => {
        setHovered(true);
        void useSessionStore.getState().prefetchSessionMessages(session.id);
      }}
      onMouseLeave={() => setHovered(false)}
      onContextMenu={(e) => {
        if (pendingConfirm) return;
        e.preventDefault();
        onContext(e.clientX, e.clientY);
      }}
      title={`${session.title}\n${formatFullTime(session.updatedAt)}`}
      className={cn(
        "group relative flex cursor-pointer flex-col gap-[3px] rounded-lg px-2.5 py-2",
        active
          ? "bg-surface-hover text-content"
          : "text-content-muted hover:bg-surface-hover/60",
        recede && "opacity-75 transition-opacity hover:opacity-100",
      )}
    >
      {active && (
        <span className="absolute bottom-1.5 left-0 top-1.5 w-[2px] rounded-full bg-accent" />
      )}

      {/* L1 — project identity + status (status yields to hover actions). */}
      <div className="flex h-4 min-w-0 items-center gap-1.5">
        <span
          className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded text-[8px] font-bold text-white"
          style={{ backgroundColor: projectColor }}
          aria-hidden
        >
          {projectInitial(projectName)}
        </span>
        <span className="min-w-0 flex-1 truncate text-[10.5px] font-medium text-content-subtle">
          {projectName}
        </span>
        {pinned && <IconPinnedFilled size={10} className="shrink-0 text-accent/70" aria-label={t("layout.pinned")} />}
        <span className="ml-auto flex h-4 min-w-8 shrink-0 items-center justify-end text-[10.5px]">
          {!showActions && statusLabel}
          {showActions && (
            <span className="flex items-center gap-0.5">
              {/* Worktree-bound rows fork a sibling on the same checkout
                  (fork icon + worktree wording, same as the tree view's
                  SessionRow); local rows start a plain project session. */}
              <HoverIconButton
                onClick={onNewSession}
                title={session.worktreePath ? t("layout.newSessionInWorktree") : t("layout.newSessionHere")}
                className="opacity-100"
              >
                {session.worktreePath ? <IconGitFork size={12} /> : <IconPlus size={12} />}
              </HoverIconButton>
              <HoverIconButton onClick={onTogglePin} title={pinned ? t("layout.unpin") : t("layout.pin")} className="opacity-100">
                {pinned ? <IconPinnedFilled size={12} className="text-accent" /> : <IconPin size={12} />}
              </HoverIconButton>
              <HoverIconButton onClick={() => setPendingConfirm("archive")} title={t("layout.archive")} className="opacity-100">
                <IconArchive size={12} />
              </HoverIconButton>
              <HoverIconButton onClick={() => setPendingConfirm("delete")} title={t("common.delete")} danger className="opacity-100">
                <IconTrash size={12} />
              </HoverIconButton>
            </span>
          )}
          {pendingConfirm === "archive" && (
            <span className="flex items-center gap-0.5">
              <button
                onClick={(e) => { e.stopPropagation(); setPendingConfirm(null); onArchive(); }}
                className="flex items-center rounded px-1 text-accent hover:bg-surface-hover"
                title={t("layout.confirmArchive")}
              >
                <IconCheck size={12} />
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); setPendingConfirm(null); }}
                className="flex items-center rounded px-1 text-content-subtle hover:bg-surface-hover hover:text-content"
                title={t("common.cancel")}
              >
                <IconX size={12} />
              </button>
            </span>
          )}
          {pendingConfirm === "delete" && (
            <span className="flex items-center gap-0.5">
              <button
                onClick={(e) => { e.stopPropagation(); setPendingConfirm(null); onDelete(); }}
                className="flex items-center rounded px-1 text-danger hover:bg-surface-hover"
                title={t("layout.confirmDelete")}
              >
                <IconCheck size={12} />
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); setPendingConfirm(null); }}
                className="flex items-center rounded px-1 text-content-subtle hover:bg-surface-hover hover:text-content"
                title={t("common.cancel")}
              >
                <IconX size={12} />
              </button>
            </span>
          )}
        </span>
      </div>

      {/* L2 — title. Sized/colored exactly like the tree view's SessionRow
          title (rp font-size var, the row's own color — muted at rest,
          content when active — and regular weight): a fixed 12.5px medium
          text-content diverged visibly from the old panel, most of all in
          the light theme where --content is near-black. When the meta line
          has nothing to say (local session, project not a git repo), the
          card degrades to TWO lines and the provider icon — otherwise an
          orphan at the right edge of an empty L3 — moves up here, trailing
          the title. */}
      <div className="flex min-w-0 items-center gap-1.5 [font-size:var(--right-panel-font-size)]">
        <span className="min-w-0 flex-1 truncate">{session.title}</span>
        {!hasMetaLine && (
          <span className="flex shrink-0 items-center" title={providerLabel || undefined}>
            <ProviderIcon size={12} className={cn("shrink-0", providerColor)} />
          </span>
        )}
      </div>

      {/* L3 — worktree identity + provider dot ("always the branch"). Only
          rendered when it HAS content: a local session in a non-git project
          (or before the probe lands) skips the line entirely — an empty
          flex-1 spacer + a lone provider icon read as a blank row. */}
      {hasMetaLine && (
        <div className="flex h-3.5 min-w-0 items-center gap-1.5 text-[10.5px] text-content-subtle">
          {session.worktreePath ? (
            <span className="flex min-w-0 items-center gap-1">
              <IconGitFork size={10} className="shrink-0 text-accent/80" />
              <span className="min-w-0 truncate font-mono text-[9.5px]" title={session.worktreePath}>
                {worktreeBranch || session.worktreePath.split(/[/\\/]/).pop()}
              </span>
              {worktreeUnmerged && (
                <span className="flex shrink-0 items-center gap-1 text-[9.5px] text-[#b45309] dark:text-[#fbbf24]" title={t("layout.stream.unmerged")}>
                  <span className="h-[5px] w-[5px] rounded-full bg-[#d97706] dark:bg-[#f59e0b]" aria-hidden />
                  {t("layout.stream.unmerged")}
                </span>
              )}
            </span>
          ) : (
            <span className="flex min-w-0 items-center gap-1" title={localBranch ?? undefined}>
              <IconGitBranch size={10} className="shrink-0 text-content-subtle/80" />
              <span className="min-w-0 truncate font-mono text-[9.5px]">{localBranch}</span>
            </span>
          )}
          <span className="ml-auto flex shrink-0 items-center" title={providerLabel || undefined}>
            <ProviderIcon size={12} className={cn("shrink-0", providerColor)} />
          </span>
        </div>
      )}
    </li>
  );
}
