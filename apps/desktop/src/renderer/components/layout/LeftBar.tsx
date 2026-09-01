import { cloneElement, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Menu } from "@base-ui/react/menu";
import {
  DndContext,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
  type DragOverEvent,
  type DraggableAttributes,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@renderer/lib/cn.js";
import {
  IconFolder,
  IconGitFork,
  IconGitMerge,
  IconChevronRight,
  IconPlus,
  IconArchive,
  IconTrash,
  IconLoader2,
  IconSettings,
  IconCheck,
  IconX,
  IconPencil,
  IconCopy,
  IconList,
  IconCategoryFilled,
  IconArrowRight,
  IconPalette,
  IconSearch,
  IconPin,
  IconPinnedFilled,
  IconSun,
  IconMoon,
  IconFocus,
  IconLayoutSidebarLeftExpand,
} from "@renderer/lib/icons.js";
import { useTheme, applyThemeClass } from "@renderer/lib/theme.js";
import { isMac } from "@renderer/lib/platform.js";
import { getProviderIcon } from "@renderer/lib/providerIcon.js";
import { Button, ConfirmDialog, Dialog, Input } from "@renderer/components/ui/index.js";
import { BrandLogo } from "./BrandLogo.js";
import { SidebarQuickActions } from "./SidebarQuickActions.js";
import { api } from "@renderer/lib/api.js";
import { normWorktreeKey, worktreeDisplayName } from "@renderer/lib/worktree.js";
import { WorktreeMergeBackDialog, WorktreeRemoveDialog } from "@renderer/components/chat/WorktreeMergeBack.js";
import { hexToTriplet, tripletToHex } from "@renderer/lib/colorUtils.js";
import { formatRelativeTime, formatFullTime } from "@renderer/lib/time.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import type { Project, Session } from "@contracts/session";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";

/**
 * Left bar — a tree of projects → sessions, with archive (soft) / delete (hard)
 * icon buttons revealed on hover for every row, plus a collapsible "archived"
 * section at the bottom grouped by project.
 *
 * Sessions are paginated: only the first SESSION_PAGE_SIZE (5) threads load
 * per project, and a "加载更多" button under the list appends the next page.
 *
 * Replaces the old two flat lists (Projects / Sessions) which had no project
 * switching and no lifecycle actions. Sessions are cached per-project in the
 * store (sessionsByProject = active page slice, archivedSessionsByProject =
 * unpaginated archived rows), so expanding a project is instant.
 *
 * Layout sketch:
 *   EXPLORER                       [+ 添加项目]
 *   ▾ 📁 mcode                 + 🗑
 *       💬 P2会话持久化         📦 🗑
 *       💬 自定义模型     ✓    📦 🗑
 *       加载更多（还有 3 条）
 *   ▸ 📁 blog-site             + 🗑
 *   ─────────────────────────────
 *   ▾ 已归档 (4)
 *       📁 old-project     [恢复] [删]
 *       📁 side-project
 *         💬 old-thread       [恢复] [删]
 *   ─────────────────────────────
 *   ⚙ 设置
 */
function LeftBarBase({
  showSearch = true,
  showConnectPhone = true,
}: {
  /** Forwarded to SidebarQuickActions — the mobile drawer hides the 搜索 /
      连接手机 entries (no Ctrl+K on a phone, and its visitor is already it). */
  showSearch?: boolean;
  showConnectPhone?: boolean;
} = {}) {
  const { t } = useI18n();
  const projects = useSessionStore((s) => s.projects);
  const activeProjectId = useSessionStore((s) => s.activeProjectId);
  const sessionsByProject = useSessionStore((s) => s.sessionsByProject);
  const sessionsHasMoreByProject = useSessionStore((s) => s.sessionsHasMoreByProject);
  const sessionsTotalByProject = useSessionStore((s) => s.sessionsTotalByProject);
  const archivedSessionsByProject = useSessionStore((s) => s.archivedSessionsByProject);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const expandedProjects = useSessionStore((s) => s.expandedProjects);
  const worktreeViewByProject = useSessionStore((s) => s.worktreeViewByProject);
  const expandedWorktrees = useSessionStore((s) => s.expandedWorktrees);
  const worktreeNames = useSessionStore((s) => s.worktreeNames);
  const archivedViewOpen = useSessionStore((s) => s.archivedViewOpen);
  const pinnedSessions = useSessionStore((s) => s.pinnedSessions);

  const addProject = useSessionStore((s) => s.addProjectFromFolder);
  const toggleProjectExpanded = useSessionStore((s) => s.toggleProjectExpanded);
  const setProjectWorktreeView = useSessionStore((s) => s.setProjectWorktreeView);
  const toggleWorktreeExpanded = useSessionStore((s) => s.toggleWorktreeExpanded);
  const renameWorktree = useSessionStore((s) => s.renameWorktree);
  const setArchivedViewOpen = useSessionStore((s) => s.setArchivedViewOpen);
  const loadMoreSessions = useSessionStore((s) => s.loadMoreSessions);
  const startSession = useSessionStore((s) => s.startSession);
  // Use `openTab` rather than `selectSession` so the clicked thread is
  // added to the tab strip (in `tabs` mode) or simply activated (in
  // `single` mode). Both display modes share the same entry point; the
  // difference is whether SessionTabs is mounted above the center pane.
  const openTab = useSessionStore((s) => s.openTab);
  const deleteProject = useSessionStore((s) => s.deleteProject);
  const archiveProject = useSessionStore((s) => s.archiveProject);
  const deleteSession = useSessionStore((s) => s.deleteSession);
  const archiveSession = useSessionStore((s) => s.archiveSession);
  const setSettingsOpen = useSessionStore((s) => s.setSettingsOpen);
  const setLeftOpen = useSessionStore((s) => s.setLeftOpen);
  const runningBySession = useSessionStore((s) => s.runningBySession);
  const unreadBySession = useSessionStore((s) => s.unreadBySession);
  const renameSession = useSessionStore((s) => s.renameSession);
  const setSessionPinned = useSessionStore((s) => s.setSessionPinned);
  const renameProject = useSessionStore((s) => s.renameProject);
  const setProjectPinned = useSessionStore((s) => s.setProjectPinned);
  const projectView = useSessionStore((s) => s.projectView);
  const setProjectView = useSessionStore((s) => s.setProjectView);
  const setProjectGroup = useSessionStore((s) => s.setProjectGroup);
  const reorderProjects = useSessionStore((s) => s.reorderProjects);
  const groupMeta = useSessionStore((s) => s.groupMeta);
  const setGroupColor = useSessionStore((s) => s.setGroupColor);
  const setGroupOrder = useSessionStore((s) => s.setGroupOrder);
  const renameGroupMeta = useSessionStore((s) => s.renameGroupMeta);

  // Resolve a session's owning project (for the "open project folder" menu
  // action). Falls back to undefined if the session's project isn't loaded.
  const findProject = useCallback(
    (projectId: string) => projects.find((p) => p.id === projectId),
    [projects],
  );

  // The active session's owning project, resolved from the loaded per-project
  // slices (the owning project auto-expands on activation, so its slice is
  // loaded). Used to SUPPRESS the project row's selected look while one of its
  // threads is selected: the thread row already carries the selection, and a
  // highlighted parent + child reads as two selections. Null when no session
  // is active (or it isn't loaded yet) — then a directly-selected project
  // (e.g. a freshly added empty project) keeps its highlight.
  const activeSessionProjectId = useMemo(() => {
    if (!activeSessionId) return null;
    for (const [pid, list] of Object.entries(sessionsByProject)) {
      if (list.some((s) => s.id === activeSessionId)) return pid;
    }
    // Pinned rows render in the global pinned section, not their project's
    // list — resolve the owner from the pinned bucket so the project row
    // still suppresses its own selection while the pinned row is active.
    const pinned = pinnedSessions.find((s) => s.id === activeSessionId);
    return pinned ? pinned.projectId : null;
  }, [activeSessionId, sessionsByProject, pinnedSessions]);

  // Theme quick-toggle (bottom rail). useTheme subscribes to theme.changed,
  // so the icon stays in sync when the theme changes elsewhere (settings
  // panel, or the OS flipping while in "system" mode). The toggle flips
  // between the two EXPLICIT themes based on what's currently rendering —
  // a "system" preference resolves via `effective` and lands on the opposite
  // explicit theme.
  const { effective: effectiveTheme } = useTheme();
  const toggleTheme = () => {
    const next = effectiveTheme === "dark" ? "light" : "dark";
    void api.theme.set({ theme: next }).then((s) => {
      applyThemeClass(s.effective);
    });
  };

  // ── Scroll-to-active-thread (clicking a tab should locate the thread in
  // the left bar, even across collapsed groups/projects and un-paginated
  // pages). Each SessionRow registers its <li> node here;
  // locateActiveSession() scrolls it into view and, when the row isn't in
  // the DOM yet, expands the owning group + project (whichever is
  // collapsed), then loads more pages until it mounts. Called by the effect
  // below (auto-locate on activeSessionId change, "nearest" so the list
  // barely moves) and by the bottom-rail locate button ("center" for an
  // explicit jump). Mirrors SessionTabs' tabNodes pattern + FileTree's
  // "mount-may-be-delayed" handling.
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

    // The active row isn't mounted yet. Reasons: its GROUP is collapsed
    // (grouped view — group collapse is LeftBar-local state the store can't
    // touch), its project row is collapsed (syncConfigFromSession expands it
    // on activation, but the user can collapse it again afterwards), or it's
    // beyond the loaded page slice. Find its project, reveal the ancestors,
    // then keep loading pages until the row appears or there's no more.
    void (async () => {
      // Re-check after a paint in case the expand just rendered the row.
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      if (tryScroll()) return;

      const st = useSessionStore.getState();
      let projectId: string | undefined;
      for (const pid of Object.keys(st.sessionsByProject)) {
        if (st.sessionsByProject[pid]?.some((s) => s.id === id)) {
          projectId = pid;
          break;
        }
      }
      if (!projectId) {
        // Pinned rows live in the global pinned section, not the per-project
        // slices — if it's there, expand the section (rows register nodes on
        // mount) and scroll to it; no project/page expansion needed.
        if (st.pinnedSessions.some((s) => s.id === id)) {
          setPinnedOpen(true);
          await new Promise((r) => requestAnimationFrame(() => r(null)));
          await new Promise((r) => requestAnimationFrame(() => r(null)));
          tryScroll();
          return;
        }
        return; // archived / unknown - nothing to scroll to.
      }

      // Reveal ancestors so the row can mount at all. Grouped view: expand
      // the owning group when collapsed (identity return when already open —
      // React bails out, no extra render). A PINNED parent renders inside the
      // pinned-projects section instead — expand that section too when it's
      // collapsed (mirrors the pinned-session branch above). Then expand the
      // project row when collapsed — the toggle's expand path is a pure local
      // set, so it never clobbers the loaded slice (the pagination loop below
      // refills whatever a prior collapse trimmed away).
      const proj = st.projects.find((p) => p.id === projectId);
      if (st.projectView === "grouped" && proj?.group) {
        const groupName = proj.group;
        setCollapsedGroups((g) => (g[groupName] ? { ...g, [groupName]: false } : g));
      }
      if (proj?.pinnedAt != null) {
        setPinnedProjectsOpen(true);
      }
      if (!st.expandedProjects[projectId]) {
        st.toggleProjectExpanded(projectId);
      }
      // Same reveal for the worktree group node the target thread buckets
      // under — a collapsed group keeps the row unmounted, so tryScroll would
      // silently miss it even with the project expanded.
      const target = st.sessionsByProject[projectId]?.find((s) => s.id === id);
      if (target?.worktreePath && !st.expandedWorktrees[normWorktreeKey(target.worktreePath)]) {
        st.toggleWorktreeExpanded(target.worktreePath);
      }
      // ...and the project must be in the FORK view, or a worktree thread
      // would stay unrendered even with the group expanded.
      if (target?.worktreePath && !st.worktreeViewByProject[projectId]) {
        st.setProjectWorktreeView(projectId, true);
      }
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      if (tryScroll()) return;

      // Load successive pages until the target row mounts or pages run out.
      for (;;) {
        const s = useSessionStore.getState();
        if (!s.sessionsHasMoreByProject[projectId]) break;
        await s.loadMoreSessions(projectId);
        if (tryScroll()) break;
      }
    })();
  }, []);

  useEffect(() => {
    if (!activeSessionId) return;
    locateActiveSession();
  }, [activeSessionId, locateActiveSession]);

  // ── Right-click context menu for session rows. Controlled Menu + a virtual
  // anchor positioned at the cursor, so the popup opens exactly where the user
  // right-clicked (base-ui's ContextMenu.Trigger anchors to the element edge,
  // not the cursor, which doesn't match the expected behavior).
  const [ctxMenu, setCtxMenu] = useState<{ session: Session; x: number; y: number } | null>(null);

  // ── Rename dialog state. Shared by sessions, projects, and worktree
  // groups; `kind` picks the dialog copy and the dispatch target on submit.
  // For kind "worktree" `id` carries the RAW worktree path.
  const [renaming, setRenaming] = useState<{
    id: string;
    title: string;
    kind: "session" | "project" | "worktree";
  } | null>(null);

  // ── Right-click context menu for worktree group nodes (new session in
  // this worktree / rename). Same controlled-Menu + virtual-anchor pattern
  // as the session and project menus below. `projectId` rides along so the
  // menu can spawn the new thread in the right project.
  const [wtCtxMenu, setWtCtxMenu] = useState<
    | { projectId: string; worktreePath: string; x: number; y: number }
    | null
  >(null);

  // ── Group-level merge-back dialog (left panel's "全量合并"): every
  // session under a worktree shares ONE checkout, so a single merge-back of
  // the directory covers all their unmerged work.
  const [wtMerge, setWtMerge] = useState<{ repoPath: string; worktreePath: string } | null>(null);

  // ── Group-level removal (guarded by the shared confirm dialog — dirty
  // trees get the patch-export / force options). On success the backend
  // degrades every referencing session back to local and broadcasts, which
  // also flips this project's view back to the local list.
  const [wtRemove, setWtRemove] = useState<{ repoPath: string; worktreePath: string } | null>(null);

  // ── Delete confirmation dialog state. A single controlled ConfirmDialog
  // replaces the three native confirm() calls (active project, archived
  // project, archived session). The `kind` discriminator carries enough
  // context to render the right title/description and dispatch the right
  // destructive action on confirm.
  const [confirmDelete, setConfirmDelete] = useState<
    | { kind: "project"; id: string; name: string }
    | { kind: "session"; id: string; title: string }
    | null
  >(null);

  // ── Project grouping state (left-bar "grouped" view).
  // `projectCtxMenu` is the right-click menu on a project row; the submenu of
  // existing groups + "新建分组" + "移出分组" lives inside it. `groupDialog`
  // drives the small dialog for creating a new group (or renaming one — both
  // flows share the same input UI, distinguished by `mode`). `collapsedGroups`
  // is in-memory expand state for the group headers, mirroring
  // `expandedProjects` for project rows.
  const [projectCtxMenu, setProjectCtxMenu] = useState<
    | { project: Project; x: number; y: number }
    | null
  >(null);
  const [groupDialog, setGroupDialog] = useState<
    | { mode: "create"; projectId: string }
    | { mode: "rename"; groupName: string }
    | null
  >(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  // Expand state for the global pinned section (in-memory, defaults open so
  // the feature is discoverable; mirrors the archived bin's local toggle).
  const [pinnedOpen, setPinnedOpen] = useState(true);
  // Same pattern for the pinned-PROJECTS section above the project tree.
  const [pinnedProjectsOpen, setPinnedProjectsOpen] = useState(true);

  // Split into active vs archived. Active projects show in the tree;
  // archived projects (whole-project archive) show as their own rows in
  // the archived bin, while archived SESSIONS under still-active projects
  // are grouped by their parent project in the bin.
  const activeProjects = projects.filter((p) => !p.archived);
  const archivedProjects = projects.filter((p) => p.archived);

  // Pinned projects leave the flat list / their group and render in a
  // dedicated pinned section ABOVE the tree (most recent pin first — the
  // store refetches the DB-ordered list after every pin toggle, so this
  // array's order already carries it). Everything below (grouped buckets,
  // drag order) operates on the remaining tree projects only.
  const pinnedProjects = activeProjects.filter((p) => p.pinnedAt != null);
  const treeProjects = activeProjects.filter((p) => p.pinnedAt == null);

  // Archived sessions grouped by their (still-active) parent project, in
  // the same project order as the tree above. Empty groups are skipped.
  const archivedGroups = activeProjects
    .map((p) => ({ project: p, sessions: archivedSessionsByProject[p.id] ?? [] }))
    .filter((g) => g.sessions.length > 0);
  const archivedCount = archivedProjects.length + archivedGroups.reduce((n, g) => n + g.sessions.length, 0);

  // ── Grouped view buckets. In "grouped" mode the active tree clusters
  // projects under collapsible headers keyed by `Project.group`. Groups are
  // ordered by first appearance (treeProjects is already created_at-ASC);
  // ungrouped projects (group == null) render in a trailing flat section.
  // Pinned projects never enter a bucket — they render in the pinned section
  // above the tree, outside (and independent of) their group.
  // Memoized so the bucketing only re-runs when the project list changes.
  const { groupedProjects, ungroupedProjects, knownGroups } = useMemo(() => {
    const grouped = new Map<string, Project[]>();
    const ungrouped: Project[] = [];
    for (const p of treeProjects) {
      const g = p.group && p.group.length > 0 ? p.group : null;
      if (g == null) {
        ungrouped.push(p);
      } else {
        const arr = grouped.get(g);
        if (arr) arr.push(p);
        else grouped.set(g, [p]);
      }
    }
    // Reorder groups by stored `order` (from groupMeta); groups absent from
    // meta keep their first-appearance order (stable fallback). Entries are
    // rebuilt into a new Map so iteration reflects the sorted order.
    const ordered = [...grouped.entries()].sort((a, b) => {
      const oa = groupMeta[a[0]]?.order ?? Number.MAX_SAFE_INTEGER;
      const ob = groupMeta[b[0]]?.order ?? Number.MAX_SAFE_INTEGER;
      if (oa !== ob) return oa - ob;
      return 0; // equal order (incl. both absent) → preserve insertion order
    });
    const sorted = new Map(ordered);
    return {
      groupedProjects: sorted,
      ungroupedProjects: ungrouped,
      knownGroups: Array.from(sorted.keys()),
    };
  }, [treeProjects, groupMeta]);

  // ── Drag-to-reorder. A single SortableContext covers every visible
  // project (flat list OR all groups flattened in display order). sortable
  // ids are namespaced ("proj:<id>" / "group:<name>") so project ids never
  // collide with group-header droppables. `displayOrder` is the flattened
  // visible order used by onDragEnd to compute from/to indices. Pinned
  // projects are NOT part of it — they render outside the SortableContext,
  // and their sort_order stays frozen while pinned (unpinning returns them
  // to their drag-order spot).
  const displayOrder = useMemo(() => {
    if (projectView === "flat") return treeProjects;
    const out: Project[] = [];
    for (const projs of groupedProjects.values()) out.push(...projs);
    out.push(...ungroupedProjects);
    return out;
  }, [projectView, treeProjects, groupedProjects, ungroupedProjects]);

  // Sortable ids: projects always; group headers too in grouped view (so
  // groups can be dragged to reorder among themselves). Both are namespaced
  // ("proj:<id>" / "group:<name>") so they never collide.
  const sortableItems = useMemo(() => {
    const ids = displayOrder.map((p) => `proj:${p.id}`);
    if (projectView === "grouped") {
      for (const g of groupedProjects.keys()) ids.push(`group:${g}`);
    }
    return ids;
  }, [displayOrder, projectView, groupedProjects]);

  // Sensors: a 6px movement activates a drag (less is a click, so taps on the
  // project row still expand/collapse). Touch gets a short delay so a scroll
  // isn't hijacked. Mirrors SessionTabs.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 120, tolerance: 8 } }),
  );

  const findProjectById = useCallback(
    (id: string) => treeProjects.find((p) => p.id === id),
    [treeProjects],
  );

  // Live cross-group reassignment while dragging. Fires as the pointer moves
  // over a different group's project or header; setProjectGroup is a no-op if
  // the group hasn't changed (guarded here) so we don't thrash the IPC.
  const onDragOver = useCallback(
    (e: DragOverEvent) => {
      const { active, over } = e;
      if (!over) return;
      const activeId = String(active.id);
      const overId = String(over.id);
      if (!activeId.startsWith("proj:")) return;
      const pid = activeId.slice(5);
      const proj = findProjectById(pid);
      if (!proj) return;

      if (overId.startsWith("group:")) {
        const groupName = overId.slice(6);
        if (proj.group !== groupName) void setProjectGroup(pid, groupName);
      } else if (overId.startsWith("proj:")) {
        const overProj = findProjectById(overId.slice(5));
        const targetGroup = overProj?.group ?? null;
        if ((proj.group ?? null) !== targetGroup) {
          void setProjectGroup(pid, targetGroup);
        }
      }
    },
    [findProjectById, setProjectGroup],
  );

  // Final position commit on drop. Two branches: group-on-group reorders the
  // group list (persists group order); project-on-project reorders projects.
  // Project-dropped-on-group reassignment is handled live in onDragOver.
  const onDragEnd = useCallback(
    (e: DragEndEvent) => {
      const { active, over } = e;
      if (!over || active.id === over.id) return;
      const activeId = String(active.id);
      const overId = String(over.id);
      // Group reorder
      if (activeId.startsWith("group:") && overId.startsWith("group:")) {
        const names = Array.from(groupedProjects.keys());
        const from = names.indexOf(activeId.slice(6));
        const to = names.indexOf(overId.slice(6));
        if (from === -1 || to === -1 || from === to) return;
        setGroupOrder(arrayMove(names, from, to));
        return;
      }
      // Project reorder
      if (!activeId.startsWith("proj:") || !overId.startsWith("proj:")) return;
      const ids = displayOrder.map((p) => p.id);
      const from = ids.indexOf(activeId.slice(5));
      const to = ids.indexOf(overId.slice(5));
      if (from === -1 || to === -1 || from === to) return;
      const next = arrayMove(ids, from, to);
      void reorderProjects(next);
    },
    [displayOrder, reorderProjects, groupedProjects, setGroupOrder],
  );

  // Shared <ProjectNode> renderer. Hoisted as a callback so the flat view,
  // the grouped view, AND the pinned-projects section render identical rows
  // (and the group node can embed it). Bound to onContextMenu to open the
  // project-grouping context menu. `sortable` wraps the row in
  // SortableProjectNode — false for pinned rows, which render outside the
  // DndContext (pinning, not dragging, is how they got there).
  const renderProjectNode = useCallback(
    (p: Project, sortable = true) => {
      const node = (
        <ProjectNode
          project={p}
          sessions={sessionsByProject[p.id] ?? []}
          hasMore={!!sessionsHasMoreByProject[p.id]}
          total={sessionsTotalByProject[p.id] ?? 0}
          expanded={!!expandedProjects[p.id]}
          // Selected look only when the project is active WITHOUT one of its
          // threads being the active session (see activeSessionProjectId).
          isActiveProject={p.id === activeProjectId && activeSessionProjectId !== p.id}
          activeSessionId={activeSessionId}
          runningBySession={runningBySession}
          unreadBySession={unreadBySession}
          onToggleExpand={() => toggleProjectExpanded(p.id)}
          onNewSession={() => void startSession(p.id)}
          onLoadMore={() => void loadMoreSessions(p.id)}
          onSelectSession={(sid) => void openTab(sid)}
          onDelete={() => {
            setConfirmDelete({ kind: "project", id: p.id, name: p.name });
          }}
          onArchiveSession={(sid) => void archiveSession(sid, true)}
          onDeleteSession={(s) => void deleteSession(s.id)}
          onTogglePinSession={(s) => void setSessionPinned(s.id, !s.pinnedAt)}
          onNewWorktreeHere={(s) => void startSession(s.projectId, { worktreePath: s.worktreePath ?? undefined })}
          worktreeView={!!worktreeViewByProject[p.id]}
          onToggleWorktreeView={(on) => setProjectWorktreeView(p.id, on)}
          worktreeNames={worktreeNames}
          expandedWorktrees={expandedWorktrees}
          onToggleWorktree={(path) => toggleWorktreeExpanded(path)}
          onNewSessionInWorktree={(path) => void startSession(p.id, { worktreePath: path })}
          onRemoveWorktree={(path) => setWtRemove({ repoPath: p.path, worktreePath: path })}
          onContextWorktree={(path, x, y) => setWtCtxMenu({ projectId: p.id, worktreePath: path, x, y })}
          registerNode={registerNode}
          onContextSession={(session, x, y) => setCtxMenu({ session, x, y })}
          onContextProject={(x, y) => setProjectCtxMenu({ project: p, x, y })}
        />
      );
      return sortable ? (
        <SortableProjectNode projectId={p.id}>{node}</SortableProjectNode>
      ) : (
        node
      );
    },
    [
      sessionsByProject, sessionsHasMoreByProject, sessionsTotalByProject,
      expandedProjects, worktreeViewByProject, expandedWorktrees, worktreeNames,
      activeProjectId, activeSessionId, activeSessionProjectId,
      runningBySession,
      toggleProjectExpanded, setProjectWorktreeView, toggleWorktreeExpanded, startSession, loadMoreSessions, openTab,
      archiveSession, deleteSession, setSessionPinned, registerNode,
    ],
  );

  return (
    <div className="flex h-full flex-col px-2 py-2 [font-size:var(--right-panel-font-size)]">
      {/* Top strip. mac: the brand header (logo + name) was removed — the
          strip now hosts the sidebar-collapse toggle, moved up from the
          footer, sitting right of the traffic lights (trafficLightPosition
          {x:20,y:13}: three 12px circles ending ~x=72): -mt-2 cancels the
          root's pt-2 so the box spans the Titlebar's 40px band (y 0..40) and
          the button centers on the traffic lights' centerline; pl-[70px]
          clears the buttons (toggle starts at x≈78). The strip doubles as a
          window drag handle; the button opts out. win: keeps the original
          brand header (logo + name + tagline), clicking it collapses the
          sidebar (setLeftOpen(false)) — settings remain in the footer. */}
      {isMac ? (
        <div
          className="-mt-2 mb-2 flex h-10 items-center pl-[70px]"
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
        </div>
      ) : (
        <div className="mb-2" style={{ WebkitAppRegion: "drag" } as React.CSSProperties}>
          <button
            type="button"
            onClick={() => setLeftOpen(false)}
            className={cn(
              "group flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors",
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
        </div>
      )}

      {/* Quick actions — 新建会话 / 搜索 / 连接手机. Full-width buttons
          docked directly under the brand logo so the most-used workspace
          entry points are always visible without scrolling. */}
      <SidebarQuickActions
        showSearch={showSearch}
        showConnectPhone={showConnectPhone}
      />

      {/* Header */}
      <div className="group mb-1 flex items-center justify-between px-1">
        <h3 className="font-semibold uppercase tracking-wide text-content-subtle [font-size:var(--rp-fs-md)]">
          {t("layout.projects")}
        </h3>
        <div className="flex items-center gap-1">
          {/* View-mode toggle: flat list vs grouped under headers. Hover-
              revealed (mirrors the add-project button below) to keep the
              header clean; the active segment still highlights on hover so
              the current mode is discoverable. */}
          <div
            className={cn(
              "flex items-center rounded border border-edge transition-all",
              "opacity-0 group-hover:opacity-100",
            )}
            role="group"
            aria-label={t("layout.projectViewMode")}
          >
            <button
              onClick={() => void setProjectView("flat")}
              className={cn(
                "flex items-center rounded-l px-1 py-0.5 transition-colors",
                projectView === "flat"
                  ? "bg-surface-hover text-content"
                  : "text-content-subtle hover:bg-surface-hover/60 hover:text-content",
              )}
              title={t("layout.viewFlat")}
              aria-pressed={projectView === "flat"}
            >
              <IconList size={13} />
            </button>
            <button
              onClick={() => void setProjectView("grouped")}
              className={cn(
                "flex items-center rounded-r border-l border-edge px-1 py-0.5 transition-colors",
                projectView === "grouped"
                  ? "bg-surface-hover text-content"
                  : "text-content-subtle hover:bg-surface-hover/60 hover:text-content",
              )}
              title={t("layout.viewGrouped")}
              aria-pressed={projectView === "grouped"}
            >
              <IconCategoryFilled size={13} />
            </button>
          </div>
          <button
            onClick={() => void addProject()}
            className={cn(
              "flex items-center rounded px-1 py-0.5 text-content-muted transition-all",
              // Always visible when there are no projects so the user has a
              // clear entry point to add one (no empty placeholder row anymore).
              projects.length === 0
                ? "opacity-100 hover:text-accent"
                : "opacity-0 hover:text-accent group-hover:opacity-100",
            )}
            title={t("layout.addProject")}
          >
            <IconPlus size={12} />
          </button>
        </div>
      </div>

      {/* Project → session tree. A single DndContext wraps both view modes:
          flat list reorders in place; grouped view reorders within the
          flattened display order AND supports cross-group drag-to-reassign
          (handled live in onDragOver). Group headers are droppable targets
          (not draggable) so dropping a project on a header moves it there. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* Pinned projects — the project-level counterpart of the pinned
            sessions section below: pinned projects leave the flat list /
            their group and live here until unpinned. Rows are full
            ProjectNodes (expandable, context menu, delete) rendered OUTSIDE
            the DndContext — dragging is the unpinned list's ordering tool,
            pinning is this section's. Rendered ABOVE the pinned-sessions
            section (project-before-thread mirrors the tree's hierarchy).
            Hidden entirely when nothing is pinned. */}
        {pinnedProjects.length > 0 && (
          <div className="mb-2">
            <button
              onClick={() => setPinnedProjectsOpen(!pinnedProjectsOpen)}
              className={cn(
                "flex w-full items-center gap-1 rounded px-1 py-0.5 font-medium uppercase tracking-wide [font-size:var(--rp-fs-md)]",
                "text-content-subtle transition-colors hover:bg-surface-hover/60",
              )}
            >
              <IconChevronRight
                size={12}
                className={cn(
                  "shrink-0 transition-transform",
                  pinnedProjectsOpen && "rotate-90",
                )}
              />
              <IconPin size={12} className="shrink-0 text-accent/70" />
              {t("layout.pinnedProjectsSection", { n: pinnedProjects.length })}
            </button>
            {pinnedProjectsOpen && (
              <ul className="mt-1 space-y-0.5">
                {pinnedProjects.map((p) => renderProjectNode(p, false))}
              </ul>
            )}
          </div>
        )}
        {/* Pinned sessions — a global section collecting the pinned threads
            of every project (pinned rows leave their project's list and live
            here until unpinned). Rendered INSIDE the scroll region, above the
            project tree, so it scrolls together with the grouped projects
            instead of staying fixed while the tree scrolls under it. Mirrors
            the archived bin's collapsible-header pattern, but defaults open.
            Hidden entirely when nothing is pinned. */}
        {pinnedSessions.length > 0 && (
          <div className="mb-2">
            <button
              onClick={() => setPinnedOpen(!pinnedOpen)}
              className={cn(
                "flex w-full items-center gap-1 rounded px-1 py-0.5 font-medium uppercase tracking-wide [font-size:var(--rp-fs-md)]",
                "text-content-subtle transition-colors hover:bg-surface-hover/60",
              )}
            >
              <IconChevronRight
                size={12}
                className={cn(
                  "shrink-0 transition-transform",
                  pinnedOpen && "rotate-90",
                )}
              />
              <IconPin size={12} className="shrink-0 text-accent/70" />
              {t("layout.pinnedSection", { n: pinnedSessions.length })}
            </button>
            {pinnedOpen && (
              <ul className="mt-1 space-y-0.5">
                {pinnedSessions.map((s) => (
                  <SessionRow
                    key={s.id}
                    session={s}
                    active={s.id === activeSessionId}
                    isRunning={!!runningBySession[s.id]}
                    unreadCount={unreadBySession[s.id] ?? 0}
                    onSelect={() => void openTab(s.id)}
                    onTogglePin={() => void setSessionPinned(s.id, !s.pinnedAt)}
                    onArchive={() => void archiveSession(s.id, true)}
                    onDelete={() => void deleteSession(s.id)}
                    onNewWorktreeSession={
                      s.worktreePath
                        ? () => void startSession(s.projectId, { worktreePath: s.worktreePath ?? undefined })
                        : undefined
                    }
                    registerNode={registerNode}
                    onContext={(x, y) => setCtxMenu({ session: s, x, y })}
                  />
                ))}
              </ul>
            )}
          </div>
        )}
        {projects.length === 0 ? null : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragOver={onDragOver}
            onDragEnd={onDragEnd}
          >
            <SortableContext items={sortableItems} strategy={verticalListSortingStrategy}>
              {projectView === "flat" ? (
                <ul className="space-y-0.5">
                  {treeProjects.map((p) => renderProjectNode(p))}
                </ul>
              ) : (
                <ul className="space-y-0.5">
                  {Array.from(groupedProjects.entries()).map(([groupName, projs]) => (
                    <GroupNode
                      key={groupName}
                      groupName={groupName}
                      projects={projs}
                      groupColor={groupMeta[groupName]?.color ?? null}
                      collapsed={!!collapsedGroups[groupName]}
                      onToggle={() =>
                        setCollapsedGroups((s) => ({ ...s, [groupName]: !s[groupName] }))
                      }
                      onRenameGroup={() =>
                        setGroupDialog({ mode: "rename", groupName })
                      }
                      onDeleteGroup={() => {
                        // Removing a group nulls every member's group field.
                        // Look members up across ALL active projects, not just
                        // the bucket — pinned members sit outside the tree but
                        // keep their `group` for when they return, and leaving
                        // it set would resurrect a ghost group on unpin.
                        activeProjects
                          .filter((p) => p.group === groupName)
                          .forEach((p) => void setProjectGroup(p.id, null));
                      }}
                      onSetColor={(rgb) => setGroupColor(groupName, rgb)}
                      renderProject={renderProjectNode}
                    />
                  ))}
                  {ungroupedProjects.length > 0 && (
                    <>
                      {/* Separator label only when there are also groups above;
                          a lone ungrouped section looks like the flat list. */}
                      {groupedProjects.size > 0 && (
                        <li className="px-1 py-0.5 text-content-subtle [font-size:var(--rp-fs-md)]">
                          {t("layout.ungrouped")}
                        </li>
                      )}
                      {ungroupedProjects.map((p) => renderProjectNode(p))}
                    </>
                  )}
                </ul>
              )}
            </SortableContext>
          </DndContext>
        )}
      </div>

      {/* Archived bin — archived projects first, then archived sessions
          grouped by their parent project. */}
      {archivedCount > 0 && (
        <div className="mt-2 border-t border-edge pt-2">
          <button
            onClick={() => setArchivedViewOpen(!archivedViewOpen)}
            className={cn(
              "flex w-full items-center gap-1 rounded px-1 py-0.5 font-medium uppercase tracking-wide [font-size:var(--rp-fs-md)]",
              "text-content-subtle transition-colors hover:bg-surface-hover/60",
            )}
          >
            <IconChevronRight
              size={12}
              className={cn(
                "shrink-0 transition-transform",
                archivedViewOpen && "rotate-90",
              )}
            />
            {t("layout.archivedCount", { n: archivedCount })}
          </button>
          {archivedViewOpen && (
            <ul className="mt-1 space-y-0.5">
              {archivedProjects.map((p) => (
                <ArchivedRow
                  key={p.id}
                  icon={<IconFolder size={14} className="opacity-60" />}
                  title={p.name}
                  onRestore={() => void archiveProject(p.id, false)}
                  onDelete={() => {
                    setConfirmDelete({ kind: "project", id: p.id, name: p.name });
                  }}
                />
              ))}
              {archivedGroups.map(({ project, sessions }) => (
                <li key={project.id} className="mt-0.5">
                  {/* Group header: parent project name (non-interactive). */}
                  <div className="flex items-center gap-1 px-1 py-0.5 text-content-subtle [font-size:var(--rp-fs-md)]">
                    <IconFolder size={12} className="opacity-50" />
                    <span className="truncate">{project.name}</span>
                  </div>
                  <ul className="ml-3 space-y-0.5 border-l border-edge/50 pl-2">
                    {sessions.map((s) => (
                      <ArchivedRow
                        key={s.id}
                        icon={(() => {
                          const { Icon, color } = getProviderIcon(s.providerId);
                          return <Icon size={14} className={cn("opacity-60", color)} />;
                        })()}
                        title={s.title}
                        onRestore={() => void archiveSession(s.id, false)}
                        onDelete={() => {
                          setConfirmDelete({ kind: "session", id: s.id, title: s.title });
                        }}
                      />
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Settings + locate + theme quick-toggle — entry moved here from the
          (removed) TopBar header. Docked to the bottom of the left rail so
          it's always reachable regardless of how far the project list
          scrolls. The two compact square buttons right of 设置: locate
          (scroll the project tree to the active session, centering it) and
          theme (sun while dark → light, moon while light → dark). */}
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
        {/* Collapse-sidebar toggle — win only. On mac it moved to the
            sidebar's top strip (right of the traffic lights). The toolbar
            re-shows its own toggle while the sidebar is CLOSED, since this
            footer button is inside the hidden sidebar then. */}
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

      {/* Right-click context menu for session rows. Rendered once at the bar
          level and positioned at the cursor via a virtual anchor. */}
      <SessionContextMenu
        ctxMenu={ctxMenu}
        onClose={() => setCtxMenu(null)}
        onRename={(s) => { setCtxMenu(null); setRenaming({ id: s.id, title: s.title, kind: "session" }); }}
        onCopyTitle={(s) => { void navigator.clipboard.writeText(s.title); setCtxMenu(null); }}
        onOpenFolder={(s) => {
          setCtxMenu(null);
          const proj = findProject(s.projectId);
          if (proj) void api.shell.openPath({ path: proj.path });
        }}
        onTogglePin={(s) => {
          setCtxMenu(null);
          void setSessionPinned(s.id, !s.pinnedAt);
        }}
        onNewWorktreeSession={(s) => {
          setCtxMenu(null);
          void startSession(s.projectId, { worktreePath: s.worktreePath ?? undefined });
        }}
      />

      {/* Right-click context menu for worktree group nodes. */}
      <WorktreeContextMenu
        ctxMenu={wtCtxMenu}
        onClose={() => setWtCtxMenu(null)}
        onNewSession={(path) => {
          setWtCtxMenu(null);
          const projectId = wtCtxMenu?.projectId;
          if (projectId) void startSession(projectId, { worktreePath: path });
        }}
        onMergeBack={(path) => {
          setWtCtxMenu(null);
          // The merge anchors on the owning project's root (the repo the
          // worktree was created from — materialization requires `.git`
          // there).
          const proj = wtCtxMenu ? projects.find((p) => p.id === wtCtxMenu.projectId) : undefined;
          if (proj) setWtMerge({ repoPath: proj.path, worktreePath: path });
        }}
        onRename={(path) => {
          setWtCtxMenu(null);
          setRenaming({ id: path, title: worktreeDisplayName(path, worktreeNames), kind: "worktree" });
        }}
        onRemove={(path) => {
          setWtCtxMenu(null);
          const proj = wtCtxMenu ? projects.find((p) => p.id === wtCtxMenu.projectId) : undefined;
          if (proj) setWtRemove({ repoPath: proj.path, worktreePath: path });
        }}
      />

      {/* Group-level removal — the guarded confirm dialog (dirty trees get
          the patch-export / force options). On success the backend clears
          every referencing session's worktreePath and broadcasts; the
          existing degenerate-event fallback flips the project's view back
          to the local list. */}
      <WorktreeRemoveDialog
        open={!!wtRemove}
        onOpenChange={(o) => {
          if (!o) setWtRemove(null);
        }}
        repoPath={wtRemove?.repoPath ?? null}
        worktreePath={wtRemove?.worktreePath ?? ""}
      />

      {/* Group-level merge-back — one shared checkout, one merge covers all
          the group's sessions. */}
      <WorktreeMergeBackDialog
        open={!!wtMerge}
        onOpenChange={(o) => {
          if (!o) setWtMerge(null);
        }}
        sessionId={null}
        worktreePath={wtMerge?.worktreePath ?? ""}
        repoPath={wtMerge?.repoPath ?? null}
      />

      {/* Right-click context menu for project rows. Hosts the "移动到分组"
          actions (existing groups + 新建分组 + 移出分组), plus pin / rename. */}
      <ProjectContextMenu
        ctxMenu={projectCtxMenu}
        knownGroups={knownGroups}
        onClose={() => setProjectCtxMenu(null)}
        onTogglePin={(p) => {
          void setProjectPinned(p.id, p.pinnedAt == null);
          setProjectCtxMenu(null);
        }}
        onRename={(p) => {
          setProjectCtxMenu(null);
          setRenaming({ id: p.id, title: p.name, kind: "project" });
        }}
        onMoveToGroup={(pid, group) => {
          void setProjectGroup(pid, group);
          setProjectCtxMenu(null);
        }}
        onCreateGroup={(pid) => {
          setGroupDialog({ mode: "create", projectId: pid });
          setProjectCtxMenu(null);
        }}
        onRemoveFromGroup={(pid) => {
          void setProjectGroup(pid, null);
          setProjectCtxMenu(null);
        }}
        onOpenFolder={(p) => {
          void api.shell.openPath({ path: p.path });
          setProjectCtxMenu(null);
        }}
      />

      {/* Rename dialog (shared by the session / project / worktree menus). */}
      <RenameDialog
        renaming={renaming}
        onClose={() => setRenaming(null)}
        onSubmit={async (id, title, kind) => {
          if (kind === "project") {
            await renameProject(id, title);
          } else if (kind === "worktree") {
            await renameWorktree(id, title);
          } else {
            await renameSession(id, title);
          }
          setRenaming(null);
        }}
      />

      {/* Group dialog — shared by "新建分组" (create, targets a project) and
          "重命名分组" (rename, targets every project in the group). Both
          flows collect a trimmed non-empty name then dispatch setProjectGroup.
          On rename we walk every member so the whole group moves at once. */}
      <GroupDialog
        state={groupDialog}
        onClose={() => setGroupDialog(null)}
        onSubmit={async (name) => {
          const st = groupDialog;
          if (!st) return;
          if (st.mode === "create") {
            await setProjectGroup(st.projectId, name);
          } else {
            // Rename: move every member of the old group to the new name, and
            // migrate the group's metadata (color + order) to the new name.
            const members = activeProjects.filter((p) => p.group === st.groupName);
            await Promise.all(members.map((p) => setProjectGroup(p.id, name)));
            renameGroupMeta(st.groupName, name);
          }
          setGroupDialog(null);
        }}
      />

      {/* Delete confirmation dialog (shared by project / archived project /
          archived session destructive actions). Replaces the native
          confirm() prompts that previously blocked the renderer. */}
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
          if (confirmDelete.kind === "project") {
            void deleteProject(confirmDelete.id);
          } else {
            void deleteSession(confirmDelete.id);
          }
        }}
      />
    </div>
  );
}

/** Memoized so a left-sidebar width drag (App re-renders on every mousemove
 *  via its leftWidthPct subscription) doesn't reconcile the whole project
 *  tree each frame. LeftBarBase reads its own data via zustand selectors,
 *  which still update it independently of parent re-renders. Renders with no
 *  props everywhere (workspace aside), so the shallow compare always skips. */
export const LeftBar = memo(LeftBarBase);

/* ── Project node (expandable, with its sessions nested) ── */

interface ProjectNodeProps {
  project: Project;
  sessions: Session[];
  hasMore: boolean;
  total: number;
  expanded: boolean;
  isActiveProject: boolean;
  activeSessionId: string | null;
  runningBySession: Record<string, boolean>;
  unreadBySession: Record<string, number>;
  onToggleExpand: () => void;
  onNewSession: () => void;
  onLoadMore: () => void;
  onSelectSession: (sessionId: string) => void;
  onDelete: () => void;
  onArchiveSession: (sessionId: string) => void;
  onDeleteSession: (session: Session) => void;
  /** Toggle a session's pinned state (project-scoped top-of-list pin). */
  onTogglePinSession: (session: Session) => void;
  /** "New session bound to this worktree session's checkout" — passed down
   *  to materialized worktree rows. */
  onNewWorktreeHere: (session: Session) => void;
  /** This project's left-bar view: false = local threads only (default),
   *  true = worktree groups. Flipped by the row's fork toggle. */
  worktreeView: boolean;
  onToggleWorktreeView: (on: boolean) => void;
  /** Left-bar display names for worktree directories (normalized path →
   *  name). Resolved by WorktreeGroupNode headers. */
  worktreeNames: Record<string, string>;
  /** Which worktree group nodes are expanded (normalized path → bool). */
  expandedWorktrees: Record<string, boolean>;
  onToggleWorktree: (worktreePath: string) => void;
  /** New thread bound to this worktree directory (group header "+"). */
  onNewSessionInWorktree: (worktreePath: string) => void;
  /** Remove the worktree directory (guarded confirm dialog at bar level). */
  onRemoveWorktree: (worktreePath: string) => void;
  onContextWorktree: (worktreePath: string, x: number, y: number) => void;
  /** Register a session row's DOM node for scroll-into-view. */
  registerNode: (id: string, el: HTMLLIElement | null) => void;
  /** Open the right-click context menu for a session at the given coords. */
  onContextSession: (session: Session, x: number, y: number) => void;
  /** Open the right-click context menu for this project row. */
  onContextProject: (x: number, y: number) => void;
  /** dnd-kit sortable injection: ref for the root <li>, applied by the
   *  SortableProjectNode wrapper so this row participates in drag-to-reorder.
   *  Undefined when rendered outside a SortableContext. */
  sortableRef?: (el: HTMLLIElement | null) => void;
  /** dnd-kit transform/opacity style for the root <li>. */
  sortableStyle?: React.CSSProperties;
  /** dnd-kit pointer listeners spread onto the row <div> (the drag handle).
   *  Buttons inside stopPropagation on pointerDown so they never start a drag. */
  sortableListeners?: Record<string, unknown>;
  sortableAttributes?: DraggableAttributes;
  /** When true the row is the active drag source — dims it for feedback. */
  isDragging?: boolean;
}

function ProjectNode(props: ProjectNodeProps) {
  const { t } = useI18n();
  const {
    project, sessions, hasMore, total, expanded, isActiveProject, activeSessionId,
    runningBySession, unreadBySession,
    onToggleExpand, onNewSession, onLoadMore, onSelectSession,
    onDelete, onArchiveSession, onDeleteSession, onTogglePinSession,
    onNewWorktreeHere, worktreeView, onToggleWorktreeView, worktreeNames, expandedWorktrees,
    onToggleWorktree, onNewSessionInWorktree, onRemoveWorktree, onContextWorktree,
    registerNode, onContextSession, onContextProject,
    sortableRef, sortableStyle, sortableListeners, sortableAttributes, isDragging,
  } = props;
  const loaded = sessions.length;

  // ── Worktree bucketing. Sessions bound to a materialized (or freshly
  // bound) isolated checkout group under ONE collapsible directory node per
  // worktree, so a directory reads like a folder of threads; local sessions
  // stay in the flat list above the groups. Insertion order of the Map gives
  // group order — `sessions` is newest-first, so the group containing the
  // most recently active worktree thread sorts first. Pagination is
  // untouched: loadMore appends to `sessions` and rows re-bucket naturally.
  const { localSessions, worktreeGroups } = useMemo(() => {
    const local: Session[] = [];
    const buckets = new Map<string, { path: string; sessions: Session[] }>();
    for (const s of sessions) {
      if (!s.worktreePath) {
        local.push(s);
        continue;
      }
      const key = normWorktreeKey(s.worktreePath);
      const bucket = buckets.get(key);
      if (bucket) bucket.sessions.push(s);
      else buckets.set(key, { path: s.worktreePath, sessions: [s] });
    }
    return { localSessions: local, worktreeGroups: Array.from(buckets.values()) };
  }, [sessions]);

  // Shared row renderer so local sessions and rows inside a worktree group
  // are identical (same hover actions, context menu). `inWorktreeGroup`
  // trims the worktree furniture for group members: the group node itself
  // already carries the fork identity and its "+" spawns siblings, so the
  // per-row fork badge and "new session in this worktree" hover button are
  // pure noise there. (Pinned rows keep both — they sit OUTSIDE the group.)
  const renderSessionRow = (s: Session, inWorktreeGroup = false) => (
    <SessionRow
      key={s.id}
      session={s}
      active={s.id === activeSessionId}
      isRunning={!!runningBySession[s.id]}
      unreadCount={unreadBySession[s.id] ?? 0}
      onSelect={() => onSelectSession(s.id)}
      onTogglePin={() => onTogglePinSession(s)}
      onArchive={() => onArchiveSession(s.id)}
      onDelete={() => onDeleteSession(s)}
      onNewWorktreeSession={
        !inWorktreeGroup && s.worktreePath ? () => onNewWorktreeHere(s) : undefined
      }
      hideWorktreeBadge={inWorktreeGroup}
      registerNode={registerNode}
      onContext={(x, y) => onContextSession(s, x, y)}
    />
  );

  return (
    <li
      ref={sortableRef}
      style={sortableStyle}
    >
      <div
        {...sortableAttributes}
        {...sortableListeners}
        onContextMenu={(e) => {
          e.preventDefault();
          onContextProject(e.clientX, e.clientY);
        }}
        className={cn(
          "group flex items-center gap-1 rounded px-1 py-1 [font-size:var(--right-panel-font-size)]",
          isActiveProject
            ? "bg-surface-hover text-content"
            : "text-content-muted hover:bg-surface-hover/60",
          isDragging && "opacity-50",
        )}
      >
        {/* Pinned marker — always-visible badge at the very LEFT edge (before
            the chevron), mirroring SessionRow's pinned badge so a pinned
            project reads as pinned at a glance. */}
        {project.pinnedAt != null && (
          <IconPinnedFilled
            size={12}
            className="shrink-0 text-accent/80"
            aria-label={t("layout.pinned")}
          />
        )}

        {/* Expand / collapse toggle */}
        <button
          onClick={onToggleExpand}
          className="flex w-3 shrink-0 items-center justify-center text-content-subtle"
          title={expanded ? t("layout.collapse") : t("layout.expand")}
        >
          <IconChevronRight
            size={10}
            className={cn(
              "transition-transform",
              expanded && "rotate-90",
            )}
          />
        </button>

        {/* Project name → click toggles expand/collapse (matches chevron) */}
        <button
          onClick={onToggleExpand}
          className="flex min-w-0 flex-1 items-center gap-1 text-left"
          title={project.path}
        >
          <IconFolder size={14} className="shrink-0" />
          <span className="truncate">{project.name}</span>
        </button>

        {/* Worktree view toggle — only for projects that HAVE worktree
            threads. Local list and worktree groups never mix: the fork flips
            the expanded list between the two views. Hidden (opacity) while
            idle so the row stays quiet; accent + always visible while the
            worktree view is ON so the flipped state is discoverable. */}
        {worktreeGroups.length > 0 && (
          <button
            onClick={() => onToggleWorktreeView(!worktreeView)}
            className={cn(
              "flex shrink-0 items-center rounded px-1 transition-colors",
              worktreeView
                ? "text-accent"
                : "text-content-subtle opacity-0 hover:text-accent group-hover:opacity-100",
            )}
            title={worktreeView ? t("layout.showLocalThreads") : t("layout.showWorktreeThreads")}
          >
            <IconGitFork size={12} />
          </button>
        )}

        {/* New session in this project */}
        <button
          onClick={onNewSession}
          className={cn(
            "flex shrink-0 items-center rounded px-1 text-content-subtle opacity-0 transition-colors",
            "hover:text-accent group-hover:opacity-100",
          )}
          title={t("layout.newSessionHere")}
        >
          <IconPlus size={12} />
        </button>

        {/* Delete — inline on hover (projects cannot be archived, only removed). */}
        <HoverIconButton onClick={onDelete} title={t("common.delete")} danger>
          <IconTrash size={13} />
        </HoverIconButton>
      </div>

      {expanded && (
        <ul className="ml-3 mt-0.5 space-y-0.5 border-l border-edge/50 pl-2">
          {loaded === 0 ? (
            <li className="px-2 py-1 text-content-subtle [font-size:var(--rp-fs-md)]">{t("layout.noThreads")}</li>
          ) : worktreeView ? (
            /* Fork view — worktree groups only; the local list never mixes in. */
            worktreeGroups.length > 0 ? (
              worktreeGroups.map((group) => {
                const key = normWorktreeKey(group.path);
                return (
                  <WorktreeGroupNode
                    key={key}
                    worktreePath={group.path}
                    displayName={worktreeDisplayName(group.path, worktreeNames)}
                    sessions={group.sessions}
                    expanded={!!expandedWorktrees[key]}
                    onToggle={() => onToggleWorktree(group.path)}
                    onNewSession={() => onNewSessionInWorktree(group.path)}
                    onRemove={() => onRemoveWorktree(group.path)}
                    onContext={(x, y) => onContextWorktree(group.path, x, y)}
                    renderSession={renderSessionRow}
                  />
                );
              })
            ) : (
              <li className="px-2 py-1 text-content-subtle [font-size:var(--rp-fs-md)]">{t("layout.noThreads")}</li>
            )
          ) : localSessions.length > 0 ? (
            /* Default view — local threads only. */
            localSessions.map((s) => renderSessionRow(s))
          ) : worktreeGroups.length > 0 ? (
            /* Every loaded thread lives in a worktree — point at the fork. */
            <li>
              <button
                onClick={() => onToggleWorktreeView(true)}
                className={cn(
                  "w-full rounded px-2 py-1 text-left text-content-subtle transition-colors [font-size:var(--rp-fs-md)]",
                  "hover:bg-surface-hover/60 hover:text-accent",
                )}
              >
                {t("layout.threadsInWorktrees")}
              </button>
            </li>
          ) : (
            <li className="px-2 py-1 text-content-subtle [font-size:var(--rp-fs-md)]">{t("layout.noThreads")}</li>
          )}
          {/* Load-more is the LOCAL list's pagination — the fork view shows
              whole worktree groups and has no paging of its own, so the
              button would load rows the user can't even see here. */}
          {hasMore && !worktreeView && (
            <li>
              <button
                onClick={onLoadMore}
                className={cn(
                  "w-full rounded px-2 py-1 text-left text-content-subtle transition-colors [font-size:var(--rp-fs-md)]",
                  "hover:bg-surface-hover/60 hover:text-accent",
                )}
              >
                {t("layout.loadMore")}
                {total > 0 ? t("layout.loadMoreRemaining", { n: Math.max(total - loaded, 0) }) : ""}
              </button>
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

/* ── Session row (leaf) ── */

/** Provider-branded leading icon for a session row. Kept in a tiny component
 *  so the two usages (active row + archived row) stay in sync. */
function SessionRowIcon({ providerId, className }: { providerId: string; className?: string }) {
  const { Icon, color } = getProviderIcon(providerId);
  return <Icon size={14} className={cn(className, color)} />;
}

function SessionRow({
  session, active, isRunning, unreadCount, onSelect, onTogglePin, onArchive, onDelete, onNewWorktreeSession, hideWorktreeBadge, registerNode, onContext,
}: {
  session: Session;
  active: boolean;
  isRunning: boolean;
  /** Unread event count for this session (0 = no badge). Only rendered when
   *  the row is idle (not running) and the count is > 0. */
  unreadCount: number;
  onSelect: () => void;
  /** Toggle this session's pinned state (moves it into / out of the global
   *  pinned section above the project tree). */
  onTogglePin: () => void;
  onArchive: () => void;
  onDelete: () => void;
  /** "New session in this worktree" — present only for materialized worktree
   *  rows OUTSIDE a worktree group (pinned section); creates a fresh thread
   *  BOUND to the same isolated checkout. Group members don't get it — the
   *  group header's "+" is that entry point. */
  onNewWorktreeSession?: () => void;
  /** True when the row renders INSIDE a worktree group node: the group
   *  already carries the fork identity, so the per-row fork badge is noise. */
  hideWorktreeBadge?: boolean;
  registerNode: (id: string, el: HTMLLIElement | null) => void;
  onContext: (x: number, y: number) => void;
}) {
  const { t } = useI18n();
  const [pendingConfirm, setPendingConfirm] = useState<null | "archive" | "delete">(null);
  const isPinned = session.pinnedAt != null;
  // Whether the pointer is over this row. We swap the right-aligned payload
  // between the relative-time label (default) and the archive/delete action
  // buttons (on hover), so the time can hug the right edge without the
  // always-reserved action buttons leaving a gap.
  const [hovered, setHovered] = useState(false);
  const idle = pendingConfirm === null && !isRunning;
  const hasUnread = unreadCount > 0;
  // When there are unread events, suppress the time label so the badge can
  // hug the right edge - the badge is more actionable information than the
  // timestamp. On hover the action buttons take precedence (so the user can
  // archive/delete without the badge getting in the way).
  const showTime = idle && !hovered && !hasUnread;
  const showActions = idle && hovered;
  const showUnreadBadge = idle && !hovered && hasUnread;

  const handleRowClick = () => {
    setPendingConfirm(null);
    onSelect();
  };

  return (
    <li
      ref={(el) => registerNode(session.id, el)}
      onClick={handleRowClick}
      onMouseEnter={() => {
        setHovered(true);
        // Warm the message bucket on hover — by the time the click lands
        // the history fetch is usually done (or in flight), so the center
        // pane swaps in with content instead of a skeleton frame.
        void useSessionStore.getState().prefetchSessionMessages(session.id);
      }}
      onMouseLeave={() => setHovered(false)}
      onContextMenu={(e) => {
        // Suppress the menu while an inline confirm is mid-flight, otherwise
        // right-clicking the confirm buttons would lose the pending state.
        if (pendingConfirm) return;
        e.preventDefault();
        onContext(e.clientX, e.clientY);
      }}
      className={cn(
        "group flex cursor-pointer items-center gap-1 rounded-md px-1 py-1 [font-size:var(--right-panel-font-size)]",
        active
          ? "bg-surface-hover text-content shadow-sm ring-1 ring-inset ring-accent/35"
          : "text-content-muted hover:bg-surface-hover/60",
      )}
      title={`${session.title}\n${formatFullTime(session.updatedAt)}`}
    >
      {/* Pinned marker — always-visible badge at the very LEFT edge (before
          the provider icon) so a pinned thread reads as pinned at a glance,
          independent of the hover actions / unread badge on the right edge. */}
      {isPinned && (
        <IconPinnedFilled
          size={12}
          className="shrink-0 text-accent/80"
          aria-label={t("layout.pinned")}
        />
      )}

      <SessionRowIcon providerId={session.providerId} className="shrink-0" />

      <span className="min-w-0 flex-1 truncate">{session.title}</span>

      {/* Worktree marker — this thread runs in an isolated detached checkout
          (parallel task). Small accent fork next to the title; full path via
          the row tooltip is unnecessary noise. */}
      {session.worktreePath && !hideWorktreeBadge && (
        <span className="flex shrink-0 text-accent/80" title={t("chat.worktree.active")}>
          <IconGitFork size={11} />
        </span>
      )}

      {/* Relative time of the last activity (updatedAt), docked to the right
          edge. The row swaps between two right-aligned payloads: the time
          label by default, and the archive/delete action buttons on hover.
          While an inline confirm is pending or a turn is running, neither the
          time nor the normal actions show (the confirm buttons / spinner take
          their place). The full timestamp stays available via the hover
          tooltip on the <li>. */}
      {showTime && (
        <span className="shrink-0 text-content-subtle/70 [font-size:var(--rp-fs-sm)]">
          {formatRelativeTime(session.updatedAt)}
        </span>
      )}

      {/* Unread badge - shown when this session has events the user hasn't
          seen (turn done, error, blocking approval, background task finished)
          and the row is idle (not running, not hovered, no pending confirm).
          A count > 9 renders "9+" to keep the badge compact. Uses the accent
          color so it pops without clashing with the running spinner. */}
      {showUnreadBadge && (
        <span
          className={cn(
            "shrink-0 rounded-full px-1.5 leading-none text-white [font-size:var(--rp-fs-sm)]",
            "min-w-[16px] text-center",
            active ? "bg-accent" : "bg-accent/80",
          )}
        >
          {unreadCount > 9 ? "9+" : unreadCount}
        </span>
      )}

      {/* Inline confirm — shown after the first click on archive or delete.
          Two icons replace the normal single-action button: a confirm check
          and a cancel X. The actual action only fires on the second click
          (confirm). Clicking anywhere else dismisses the pending state. */}
      {pendingConfirm === "archive" && (
        <>
          <button
            onClick={(e) => { e.stopPropagation(); setPendingConfirm(null); onArchive(); }}
            className="flex shrink-0 items-center rounded px-1 text-accent hover:bg-surface-hover"
            title={t("layout.confirmArchive")}
          >
            <IconCheck size={13} />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); setPendingConfirm(null); }}
            className="flex shrink-0 items-center rounded px-1 text-content-subtle hover:bg-surface-hover hover:text-content"
            title={t("common.cancel")}
          >
            <IconX size={13} />
          </button>
        </>
      )}
      {pendingConfirm === "delete" && (
        <>
          <button
            onClick={(e) => { e.stopPropagation(); setPendingConfirm(null); onDelete(); }}
            className="flex shrink-0 items-center rounded px-1 text-danger hover:bg-surface-hover"
            title={t("layout.confirmDelete")}
          >
            <IconCheck size={13} />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); setPendingConfirm(null); }}
            className="flex shrink-0 items-center rounded px-1 text-content-subtle hover:bg-surface-hover hover:text-content"
            title={t("common.cancel")}
          >
            <IconX size={13} />
          </button>
        </>
      )}

      {/* Normal action buttons - only mounted on hover (and only when the row
          is idle), so the relative-time label can sit flush against the right
          edge instead of sharing space with hidden-but-reserved buttons. */}
      {showActions && (
        <>
          {onNewWorktreeSession && (
            <HoverIconButton
              onClick={onNewWorktreeSession}
              title={t("layout.newSessionInWorktree")}
              className="opacity-100"
            >
              <IconGitFork size={13} />
            </HoverIconButton>
          )}
          <HoverIconButton
            onClick={onTogglePin}
            title={isPinned ? t("layout.unpin") : t("layout.pin")}
            className="opacity-100"
          >
            {isPinned ? (
              <IconPinnedFilled size={13} className="text-accent" />
            ) : (
              <IconPin size={13} />
            )}
          </HoverIconButton>
          <HoverIconButton
            onClick={() => { setPendingConfirm("archive"); }}
            title={t("layout.archive")}
            className="opacity-100"
          >
            <IconArchive size={13} />
          </HoverIconButton>
          <HoverIconButton
            onClick={() => { setPendingConfirm("delete"); }}
            title={t("common.delete")}
            danger
            className="opacity-100"
          >
            <IconTrash size={13} />
          </HoverIconButton>
        </>
      )}

      {/* Running spinner — always visible at the far right when a turn is live. */}
      {isRunning && (
        <IconLoader2
          size={12}
          className="shrink-0 animate-spin text-accent"
        />
      )}
    </li>
  );
}

/* ── Worktree group node (directory of threads sharing one checkout) ──
 * Collapsible header bucketing every session bound to the same isolated
 * worktree directory, so a worktree reads like a folder of threads under its
 * project. Mirrors ProjectNode's row layout (chevron + icon + name) but is
 * NOT sortable — group order follows the sessions' recency. "+" creates a
 * new thread bound to the SAME checkout (shared directory + node_modules);
 * right-click opens the worktree context menu (new session / rename). */

interface WorktreeGroupNodeProps {
  worktreePath: string;
  displayName: string;
  sessions: Session[];
  expanded: boolean;
  onToggle: () => void;
  onNewSession: () => void;
  onRemove: () => void;
  onContext: (x: number, y: number) => void;
  renderSession: (s: Session, inWorktreeGroup?: boolean) => React.ReactNode;
}

function WorktreeGroupNode({
  worktreePath, displayName, sessions, expanded,
  onToggle, onNewSession, onRemove, onContext, renderSession,
}: WorktreeGroupNodeProps) {
  const { t } = useI18n();
  return (
    <li>
      <div
        onContextMenu={(e) => {
          e.preventDefault();
          onContext(e.clientX, e.clientY);
        }}
        className="group flex items-center gap-1 rounded px-1 py-1 [font-size:var(--right-panel-font-size)] text-content-muted hover:bg-surface-hover/60"
      >
        {/* Expand / collapse toggle */}
        <button
          onClick={onToggle}
          className="flex w-3 shrink-0 items-center justify-center text-content-subtle"
          title={expanded ? t("layout.collapse") : t("layout.expand")}
        >
          <IconChevronRight
            size={10}
            className={cn("transition-transform", expanded && "rotate-90")}
          />
        </button>

        {/* Directory name (+ thread count) → click toggles expand/collapse */}
        <button
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-1 text-left"
          title={worktreePath}
        >
          <IconGitFork size={13} className="shrink-0 text-accent/80" />
          <span className="truncate">{displayName}</span>
          <span className="shrink-0 rounded bg-surface-muted px-1 text-content-subtle [font-size:var(--rp-fs-sm)]">
            {sessions.length}
          </span>
        </button>

        {/* New session bound to this worktree — hover only, mirrors the
            project row's "+" button. */}
        <button
          onClick={onNewSession}
          className={cn(
            "flex shrink-0 items-center rounded px-1 text-content-subtle opacity-0 transition-colors",
            "hover:text-accent group-hover:opacity-100",
          )}
          title={t("layout.newSessionInWorktree")}
        >
          <IconPlus size={12} />
        </button>

        {/* Remove the worktree — hover, danger-tinted on hover. Opens the
            same guarded confirm dialog as the context-menu entry (running
            turns refuse; dirty trees get patch-export / force options). */}
        <button
          onClick={onRemove}
          className={cn(
            "flex shrink-0 items-center rounded px-1 text-content-subtle opacity-0 transition-colors",
            "hover:text-danger group-hover:opacity-100",
          )}
          title={t("chat.worktree.removeWt")}
        >
          <IconTrash size={12} />
        </button>
      </div>

      {expanded && (
        <ul className="ml-3 mt-0.5 space-y-0.5 border-l border-edge/50 pl-2">
          {sessions.map((s) => renderSession(s, true))}
        </ul>
      )}
    </li>
  );
}

/* ── Hover-revealed inline icon button (archive / delete) ── */

function HoverIconButton({
  onClick, title, danger, className, children,
}: {
  onClick: () => void;
  title: string;
  danger?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className={cn(
        "flex shrink-0 items-center rounded px-1 text-content-subtle opacity-0 transition-colors",
        "hover:bg-surface-hover group-hover:opacity-100",
        danger ? "hover:text-danger" : "hover:text-content",
        className,
      )}
      title={title}
    >
      {children}
    </button>
  );
}

/* ── Archived row (restore + hard-delete actions inline) ── */

function ArchivedRow({
  icon, title, subtitle, onRestore, onDelete,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  return (
    <li
      className={cn(
        "flex items-center gap-1 rounded px-1 py-1 text-content-subtle [font-size:var(--right-panel-font-size)]",
        "hover:bg-surface-hover/60",
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">
        {title}
        {subtitle && (
          <span className="ml-1 text-content-subtle/70 [font-size:var(--rp-fs-sm)]">
            · {subtitle}
          </span>
        )}
      </span>
      <button
        onClick={(e) => { e.stopPropagation(); onRestore(); }}
        className={cn(
          "shrink-0 rounded px-1 text-content-subtle transition-colors [font-size:var(--rp-fs-sm)]",
          "hover:text-accent",
        )}
        title={t("layout.restoreToList")}
      >
        {t("layout.restore")}
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        className={cn(
          "shrink-0 rounded px-1 text-content-subtle transition-colors [font-size:var(--rp-fs-sm)]",
          "hover:text-danger",
        )}
        title={t("layout.deleteForever")}
      >
        {t("layout.deleteShort")}
      </button>
    </li>
  );
}

/* ── Session right-click context menu ── */

interface SessionContextMenuProps {
  ctxMenu: { session: Session; x: number; y: number } | null;
  onClose: () => void;
  onRename: (session: Session) => void;
  onCopyTitle: (session: Session) => void;
  onOpenFolder: (session: Session) => void;
  onTogglePin: (session: Session) => void;
  /** "New session in this worktree" — present only for materialized
   *  worktree sessions; spawns a sibling thread on the same checkout. */
  onNewWorktreeSession?: (session: Session) => void;
}

function SessionContextMenu({
  ctxMenu, onClose, onRename, onCopyTitle, onOpenFolder, onTogglePin, onNewWorktreeSession,
}: SessionContextMenuProps) {
  const { t } = useI18n();
  // Virtual anchor pinned to the cursor coords so the popup opens where the
  // user right-clicked (base-ui's Menu.Positioner accepts a VirtualElement).
  const anchor = useMemo(() => {
    const x = ctxMenu?.x ?? 0;
    const y = ctxMenu?.y ?? 0;
    return {
      getBoundingClientRect: () => ({
        x, y, top: y, left: x, bottom: y, right: x, width: 0, height: 0, toJSON: () => ({}),
      }),
    };
  }, [ctxMenu?.x, ctxMenu?.y]);

  const session = ctxMenu?.session;
  const isPinned = !!session?.pinnedAt;

  return (
    <Menu.Root open={!!ctxMenu} onOpenChange={(open) => { if (!open) onClose(); }}>
      <Menu.Portal>
        <Menu.Positioner anchor={anchor} side="bottom" align="start">
          <Menu.Popup
            className={cn(
              "z-50 min-w-[180px] origin-top-left rounded-md border border-edge bg-surface py-1 shadow-2xl",
              "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
              "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
              "transition-[transform,opacity] duration-100",
            )}
          >
            <Menu.Item
              onClick={() => session && onTogglePin(session)}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs outline-none select-none",
                "text-content-muted data-[highlighted]:bg-surface-muted",
              )}
            >
              {isPinned ? (
                <IconPinnedFilled size={14} className="shrink-0 text-accent" />
              ) : (
                <IconPin size={14} className="shrink-0" />
              )}
              {isPinned ? t("layout.unpin") : t("layout.pin")}
            </Menu.Item>
            <Menu.Item
              onClick={() => session && onRename(session)}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs outline-none select-none",
                "text-content-muted data-[highlighted]:bg-surface-muted",
              )}
            >
              <IconPencil size={14} className="shrink-0" />
              {t("common.rename")}
            </Menu.Item>
            <Menu.Item
              onClick={() => session && onCopyTitle(session)}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs outline-none select-none",
                "text-content-muted data-[highlighted]:bg-surface-muted",
              )}
            >
              <IconCopy size={14} className="shrink-0" />
              {t("layout.copySessionTitle")}
            </Menu.Item>
            {session?.worktreePath && onNewWorktreeSession && (
              <Menu.Item
                onClick={() => onNewWorktreeSession(session)}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs outline-none select-none",
                  "text-content-muted data-[highlighted]:bg-surface-muted",
                )}
              >
                <IconGitFork size={14} className="shrink-0" />
                {t("layout.newSessionInWorktree")}
              </Menu.Item>
            )}
            <Menu.Item
              onClick={() => session && onOpenFolder(session)}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs outline-none select-none",
                "text-content-muted data-[highlighted]:bg-surface-muted",
              )}
            >
              <IconFolder size={14} className="shrink-0" />
              {t("layout.openInFileManager")}
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/* ── Worktree right-click context menu ──
 * Opened from a worktree group node's header. Entries: spawn a sibling
 * thread bound to the same checkout, merge the directory's work back into
 * the local branch (all sessions of the group share one checkout, so one
 * merge covers everything), rename the directory's left-bar display name,
 * and REMOVE the worktree (guarded confirm dialog; referencing sessions
 * degrade back to local). */

interface WorktreeContextMenuProps {
  ctxMenu: { worktreePath: string; x: number; y: number } | null;
  onClose: () => void;
  onNewSession: (worktreePath: string) => void;
  onMergeBack: (worktreePath: string) => void;
  onRename: (worktreePath: string) => void;
  onRemove: (worktreePath: string) => void;
}

function WorktreeContextMenu({
  ctxMenu, onClose, onNewSession, onMergeBack, onRename, onRemove,
}: WorktreeContextMenuProps) {
  const { t } = useI18n();
  // Virtual anchor pinned to the cursor coords (same as SessionContextMenu).
  const anchor = useMemo(() => {
    const x = ctxMenu?.x ?? 0;
    const y = ctxMenu?.y ?? 0;
    return {
      getBoundingClientRect: () => ({
        x, y, top: y, left: x, bottom: y, right: x, width: 0, height: 0, toJSON: () => ({}),
      }),
    };
  }, [ctxMenu?.x, ctxMenu?.y]);

  const worktreePath = ctxMenu?.worktreePath;

  return (
    <Menu.Root open={!!ctxMenu} onOpenChange={(open) => { if (!open) onClose(); }}>
      <Menu.Portal>
        <Menu.Positioner anchor={anchor} side="bottom" align="start">
          <Menu.Popup
            className={cn(
              "z-50 min-w-[180px] origin-top-left rounded-md border border-edge bg-surface py-1 shadow-2xl",
              "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
              "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
              "transition-[transform,opacity] duration-100",
            )}
          >
            <Menu.Item
              onClick={() => worktreePath && onNewSession(worktreePath)}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs outline-none select-none",
                "text-content-muted data-[highlighted]:bg-surface-muted",
              )}
            >
              <IconGitFork size={14} className="shrink-0" />
              {t("layout.newSessionInWorktree")}
            </Menu.Item>
            <Menu.Item
              onClick={() => worktreePath && onMergeBack(worktreePath)}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs outline-none select-none",
                "text-content-muted data-[highlighted]:bg-surface-muted",
              )}
            >
              <IconGitMerge size={14} className="shrink-0" />
              {t("layout.mergeWorktreeBack")}
            </Menu.Item>
            <Menu.Item
              onClick={() => worktreePath && onRename(worktreePath)}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs outline-none select-none",
                "text-content-muted data-[highlighted]:bg-surface-muted",
              )}
            >
              <IconPencil size={14} className="shrink-0" />
              {t("layout.renameWorktree")}
            </Menu.Item>
            <Menu.Item
              onClick={() => worktreePath && onRemove(worktreePath)}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs outline-none select-none",
                "text-danger data-[highlighted]:bg-surface-muted",
              )}
            >
              <IconTrash size={14} className="shrink-0" />
              {t("chat.worktree.removeWt")}
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/* ── Rename dialog ── */

/** The rename target's kind drives the dialog copy and the dispatch target;
 *  ids are unique across tables so `id` alone disambiguates on submit —
 *  except kind "worktree", where `id` carries the RAW worktree path. */
type RenameTarget = { id: string; title: string; kind: "session" | "project" | "worktree" };

interface RenameDialogProps {
  renaming: RenameTarget | null;
  onClose: () => void;
  onSubmit: (id: string, title: string, kind: "session" | "project" | "worktree") => Promise<void>;
}

function RenameDialog({ renaming, onClose, onSubmit }: RenameDialogProps) {
  const { t } = useI18n();
  const [value, setValue] = useState("");

  // Seed the input whenever a new rename target is set.
  useEffect(() => {
    if (renaming) setValue(renaming.title);
  }, [renaming]);

  const trimmed = value.trim();
  const submit = () => {
    if (!renaming || !trimmed) return;
    void onSubmit(renaming.id, trimmed, renaming.kind);
  };

  const copy =
    renaming?.kind === "project"
      ? {
          title: t("layout.renameProject"),
          desc: t("layout.renameProjectDesc"),
          placeholder: t("layout.projectNamePlaceholder"),
        }
      : renaming?.kind === "worktree"
        ? {
            title: t("layout.renameWorktree"),
            desc: t("layout.renameWorktreeDesc"),
            placeholder: t("layout.worktreeNamePlaceholder"),
          }
        : {
            title: t("layout.renameThread"),
            desc: t("layout.renameThreadDesc"),
            placeholder: t("layout.threadTitlePlaceholder"),
          };

  return (
    <Dialog.Root open={!!renaming} onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Popup className="w-[420px] max-w-[90vw] p-4">
          <Dialog.Title>{copy.title}</Dialog.Title>
          <Dialog.Description className="mt-1">{copy.desc}</Dialog.Description>

          <div className="mt-4">
            <Input
              value={value}
              autoFocus
              placeholder={copy.placeholder}
              onChange={(e) => setValue((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); submit(); }
                if (e.key === "Escape") { e.preventDefault(); onClose(); }
              }}
              onFocus={(e) => (e.target as HTMLInputElement).select()}
            />
          </div>

          <div className="mt-4 flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" size="sm" onClick={submit} disabled={!trimmed}>
              {t("common.save")}
            </Button>
          </div>
          <Dialog.Close />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* ── Group node (grouped view) ──
 * A collapsible header that clusters its member projects. Mirrors the
 * archived bin's group-header layout but is interactive: click toggles
 * collapse, hover reveals rename/delete actions. Member projects render via
 * the shared `renderProject` callback so rows are identical to the flat view. */

interface GroupNodeProps {
  groupName: string;
  projects: Project[];
  /** Per-group color as "R G B" triplet, or null for the default. */
  groupColor: string | null;
  collapsed: boolean;
  onToggle: () => void;
  onRenameGroup: () => void;
  onDeleteGroup: () => void;
  onSetColor: (rgb: string | null) => void;
  renderProject: (p: Project) => React.ReactNode;
}

/** Preset swatches for the group color picker (mirrors ACCENT_PRESETS).
 *  Names are dictionary keys — resolved at render for the swatch tooltip. */
const GROUP_COLOR_PRESETS: { nameKey: MessageId; triplet: string; hex: string }[] = [
  { nameKey: "layout.color.emerald", triplet: "5 150 105", hex: "#059669" },
  { nameKey: "layout.color.sky", triplet: "2 132 199", hex: "#0284c7" },
  { nameKey: "layout.color.indigo", triplet: "67 56 202", hex: "#4338ca" },
  { nameKey: "layout.color.violet", triplet: "124 58 237", hex: "#7c3aed" },
  { nameKey: "layout.color.rose", triplet: "225 29 72", hex: "#e11d48" },
  { nameKey: "layout.color.amber", triplet: "217 119 6", hex: "#d97706" },
];

function GroupNode({
  groupName, projects, groupColor, collapsed,
  onToggle, onRenameGroup, onDeleteGroup, onSetColor, renderProject,
}: GroupNodeProps) {
  const { t } = useI18n();
  // The header is both a drop target (dropping a project here reassigns its
  // group) AND a sortable item (groups can be dragged to reorder among
  // themselves). useSortable provides both behaviors.
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver } =
    useSortable({ id: `group:${groupName}` });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    ...(isDragging ? { zIndex: 10 } : undefined),
  };
  const colorHex = groupColor ? tripletToHex(groupColor) : null;
  return (
    <li ref={setNodeRef} style={style} {...attributes}>
      <div
        {...listeners}
        className={cn(
          "group flex items-center gap-1 rounded px-1 py-0.5 [font-size:var(--rp-fs-md)]",
          "text-content-subtle hover:bg-surface-hover/60",
          isOver && "bg-surface-hover ring-1 ring-accent/40",
          isDragging && "opacity-50",
        )}
      >
        <button
          onClick={onToggle}
          className="flex w-3 shrink-0 items-center justify-center"
          title={collapsed ? t("layout.expand") : t("layout.collapse")}
        >
          <IconChevronRight
            size={10}
            className={cn("transition-transform", !collapsed && "rotate-90")}
          />
        </button>
        <button
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-1 text-left font-medium"
        >
          <IconCategoryFilled
            size={13}
            className="shrink-0"
            style={colorHex ? { color: colorHex } : undefined}
          />
          <span className="truncate">{groupName}</span>
          <span className="text-content-subtle/70">({projects.length})</span>
        </button>
        {/* Color picker — hover-revealed palette button. The button's tint
            reflects the current group color so it doubles as an indicator. */}
        <Menu.Root>
          <Menu.Trigger
            title={t("layout.setColor")}
            className="flex shrink-0 items-center rounded px-1 text-content-subtle opacity-0 transition-colors hover:bg-surface-hover group-hover:opacity-100"
          >
            <IconPalette size={12} style={colorHex ? { color: colorHex } : undefined} />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner align="end">
              <Menu.Popup
                className={cn(
                  "z-50 min-w-[180px] origin-top-left rounded-md border border-edge bg-surface py-1 shadow-2xl",
                  "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
                  "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
                  "transition-[transform,opacity] duration-100",
                )}
              >
                <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-content-subtle">
                  {t("layout.groupColor")}
                </div>
                <div className="flex flex-wrap gap-1.5 px-3 py-1">
                  {GROUP_COLOR_PRESETS.map((p) => (
                    <Menu.Item
                      key={p.triplet}
                      onClick={() => onSetColor(p.triplet)}
                      className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-full border-2 transition-transform hover:scale-110 data-[highlighted]:scale-110"
                      style={{
                        backgroundColor: p.hex,
                        borderColor: groupColor === p.triplet ? "var(--color-content)" : "var(--color-edge)",
                      }}
                      title={`${t(p.nameKey)} · ${p.hex.toUpperCase()}`}
                    >
                      {groupColor === p.triplet && (
                        <IconCheck size={12} className="text-white drop-shadow" />
                      )}
                    </Menu.Item>
                  ))}
                </div>
                <div className="my-1 h-px bg-edge" />
                <div className="flex items-center gap-2 px-3 py-1">
                  <span className="text-xs text-content-muted">{t("layout.customColor")}</span>
                  <input
                    type="color"
                    value={colorHex ?? "#808080"}
                    onChange={(e) => {
                      const triplet = hexToTriplet(e.target.value);
                      if (triplet) onSetColor(triplet);
                    }}
                    className="h-6 w-8 cursor-pointer rounded border border-edge bg-transparent p-0.5"
                  />
                </div>
                <Menu.Item
                  onClick={() => onSetColor(null)}
                  disabled={!groupColor}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-content-muted data-[highlighted]:bg-surface-muted disabled:opacity-40"
                >
                  {t("layout.resetColor")}
                </Menu.Item>
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
        <button
          onClick={onRenameGroup}
          className="flex shrink-0 items-center rounded px-1 text-content-subtle opacity-0 transition-colors hover:text-accent group-hover:opacity-100"
          title={t("layout.renameGroup")}
        >
          <IconPencil size={12} />
        </button>
        <HoverIconButton onClick={onDeleteGroup} title={t("layout.dissolveGroup")} danger>
          <IconX size={12} />
        </HoverIconButton>
      </div>
      {!collapsed && (
        <ul className="ml-3 mt-0.5 space-y-0.5 border-l border-edge/50 pl-2">
          {projects.map((p) => renderProject(p))}
        </ul>
      )}
    </li>
  );
}

/* ── Sortable wrapper for a project row ──
 * Hooks ProjectNode into the DndContext: useSortable provides the ref, the
 * transform (visual reorder during drag), and the pointer listeners that make
 * the row a drag handle. These are injected into ProjectNode via its optional
 * sortable* props so the row markup stays in one place. Mirrors SessionTabs'
 * SortableTab. The id is namespaced ("proj:<id>") to avoid colliding with
 * group-header droppables ("group:<name>"). */
function SortableProjectNode({
  projectId,
  children,
}: {
  projectId: string;
  children: React.ReactElement<ProjectNodeProps>;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: `proj:${projectId}` });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    ...(isDragging ? { zIndex: 10 } : undefined),
  };
  return cloneElement(children, {
    sortableRef: setNodeRef,
    sortableStyle: style,
    sortableListeners: listeners,
    sortableAttributes: attributes,
    isDragging,
  });
}

/* ── Project right-click context menu ──
 * Hosts the "移动到分组" actions: a flat list of existing groups (click to
 * assign), "新建分组…" (opens the group dialog), and "移出分组" (only when
 * the project is currently grouped). Plus pin (top of the menu, mirroring
 * the session menu), rename, and an "open in file manager" entry for parity
 * with the session context menu. */

interface ProjectContextMenuProps {
  ctxMenu: { project: Project; x: number; y: number } | null;
  knownGroups: string[];
  onClose: () => void;
  onTogglePin: (project: Project) => void;
  onRename: (project: Project) => void;
  onMoveToGroup: (projectId: string, group: string) => void;
  onCreateGroup: (projectId: string) => void;
  onRemoveFromGroup: (projectId: string) => void;
  onOpenFolder: (project: Project) => void;
}

function ProjectContextMenu({
  ctxMenu, knownGroups, onClose,
  onTogglePin, onRename, onMoveToGroup, onCreateGroup, onRemoveFromGroup, onOpenFolder,
}: ProjectContextMenuProps) {
  const { t } = useI18n();
  const anchor = useMemo(() => {
    const x = ctxMenu?.x ?? 0;
    const y = ctxMenu?.y ?? 0;
    return {
      getBoundingClientRect: () => ({
        x, y, top: y, left: x, bottom: y, right: x, width: 0, height: 0, toJSON: () => ({}),
      }),
    };
  }, [ctxMenu?.x, ctxMenu?.y]);

  const project = ctxMenu?.project;
  const currentGroup = project?.group && project.group.length > 0 ? project.group : null;
  const isPinned = project?.pinnedAt != null;

  const itemClass = cn(
    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs outline-none select-none",
    "text-content-muted data-[highlighted]:bg-surface-muted",
  );

  return (
    <Menu.Root open={!!ctxMenu} onOpenChange={(open) => { if (!open) onClose(); }}>
      <Menu.Portal>
        <Menu.Positioner anchor={anchor} side="bottom" align="start">
          <Menu.Popup
            className={cn(
              "z-50 min-w-[180px] origin-top-left rounded-md border border-edge bg-surface py-1 shadow-2xl",
              "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
              "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
              "transition-[transform,opacity] duration-100",
            )}
          >
            <Menu.Item
              onClick={() => project && onTogglePin(project)}
              className={itemClass}
            >
              {isPinned ? (
                <IconPinnedFilled size={14} className="shrink-0 text-accent" />
              ) : (
                <IconPin size={14} className="shrink-0" />
              )}
              {isPinned ? t("layout.unpin") : t("layout.pin")}
            </Menu.Item>
            <Menu.Item
              onClick={() => project && onRename(project)}
              className={itemClass}
            >
              <IconPencil size={14} className="shrink-0" />
              {t("common.rename")}
            </Menu.Item>
            <Menu.Separator className="my-1 h-px bg-edge" />
            {/* Section: move to an existing group. Each row shows the group
                name with a check on the currently-assigned one. */}
            {knownGroups.length > 0 && (
              <>
                <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-content-subtle">
                  {t("layout.moveToGroup")}
                </div>
                {knownGroups.map((g) => (
                  <Menu.Item
                    key={g}
                    onClick={() => project && onMoveToGroup(project.id, g)}
                    className={itemClass}
                  >
                    <IconCategoryFilled size={14} className="shrink-0" />
                    <span className="flex-1 truncate">{g}</span>
                    {currentGroup === g && <IconCheck size={13} className="shrink-0 text-accent" />}
                  </Menu.Item>
                ))}
                <Menu.Separator className="my-1 h-px bg-edge" />
              </>
            )}
            <Menu.Item
              onClick={() => project && onCreateGroup(project.id)}
              className={itemClass}
            >
              <IconPlus size={14} className="shrink-0" />
              {t("layout.newGroupMenu")}
            </Menu.Item>
            {currentGroup && (
              <Menu.Item
                onClick={() => project && onRemoveFromGroup(project.id)}
                className={itemClass}
              >
                <IconArrowRight size={14} className="shrink-0 rotate-45" />
                {t("layout.removeFromGroup")}
              </Menu.Item>
            )}
            <Menu.Separator className="my-1 h-px bg-edge" />
            <Menu.Item
              onClick={() => project && onOpenFolder(project)}
              className={itemClass}
            >
              <IconFolder size={14} className="shrink-0" />
              {t("layout.openInFileManager")}
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/* ── Group dialog (create / rename) ──
 * One input, one submit. In "create" mode the parent LeftBar dispatches
 * setProjectGroup(projectId, name); in "rename" mode it walks every member.
 * Empty/whitespace-only input is rejected by disabling submit (mirrors
 * RenameDialog). */

interface GroupDialogProps {
  state: { mode: "create"; projectId: string } | { mode: "rename"; groupName: string } | null;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}

function GroupDialog({ state, onClose, onSubmit }: GroupDialogProps) {
  const { t } = useI18n();
  const [value, setValue] = useState("");

  useEffect(() => {
    if (state?.mode === "rename") setValue(state.groupName);
    else setValue("");
  }, [state]);

  const trimmed = value.trim();
  const submit = () => {
    if (!state || !trimmed) return;
    void onSubmit(trimmed);
  };

  return (
    <Dialog.Root open={!!state} onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Popup className="w-[420px] max-w-[90vw] p-4">
          <Dialog.Title>{state?.mode === "rename" ? t("layout.renameGroup") : t("layout.newGroup")}</Dialog.Title>
          <Dialog.Description className="mt-1">
            {state?.mode === "rename"
              ? t("layout.renameGroupDesc")
              : t("layout.newGroupDesc")}
          </Dialog.Description>

          <div className="mt-4">
            <Input
              value={value}
              autoFocus
              placeholder={t("layout.groupNamePlaceholder")}
              onChange={(e) => setValue((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); submit(); }
                if (e.key === "Escape") { e.preventDefault(); onClose(); }
              }}
              onFocus={(e) => (e.target as HTMLInputElement).select()}
            />
          </div>

          <div className="mt-4 flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" size="sm" onClick={submit} disabled={!trimmed}>
              {state?.mode === "rename" ? t("common.save") : t("common.create")}
            </Button>
          </div>
          <Dialog.Close />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
