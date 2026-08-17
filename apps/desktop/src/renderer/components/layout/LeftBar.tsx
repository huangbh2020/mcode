import { cloneElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
} from "@renderer/lib/icons.js";
import { useTheme, applyThemeClass } from "@renderer/lib/theme.js";
import { getProviderIcon } from "@renderer/lib/providerIcon.js";
import { Button, ConfirmDialog, Dialog, Input } from "@renderer/components/ui/index.js";
import { BrandLogo } from "./BrandLogo.js";
import { SidebarQuickActions } from "./SidebarQuickActions.js";
import { api } from "@renderer/lib/api.js";
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
export function LeftBar({
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
  const archivedViewOpen = useSessionStore((s) => s.archivedViewOpen);

  const addProject = useSessionStore((s) => s.addProjectFromFolder);
  const toggleProjectExpanded = useSessionStore((s) => s.toggleProjectExpanded);
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
  const runningBySession = useSessionStore((s) => s.runningBySession);
  const unreadBySession = useSessionStore((s) => s.unreadBySession);
  const renameSession = useSessionStore((s) => s.renameSession);
  const setSessionPinned = useSessionStore((s) => s.setSessionPinned);
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
    return null;
  }, [activeSessionId, sessionsByProject]);

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
  // the left bar, even across collapsed projects and un-paginated pages).
  // Each SessionRow registers its <li> node here; locateActiveSession()
  // scrolls it into view and, when the row isn't in the DOM yet, loads more
  // pages until it mounts. Called by the effect below (auto-locate on
  // activeSessionId change, "nearest" so the list barely moves) and by the
  // bottom-rail locate button ("center" for an explicit jump). Mirrors
  // SessionTabs' tabNodes pattern + FileTree's "mount-may-be-delayed"
  // handling.
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

    // The active row isn't mounted yet. Two reasons: its project is collapsed
    // (syncConfigFromSession already expanded it, but React hasn't painted),
    // or it's beyond the loaded page slice. Find its project, then keep
    // loading pages until the row appears or there's nothing more to load.
    void (async () => {
      // Re-check after a paint in case the expand just rendered the row.
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      if (tryScroll()) return;

      let projectId: string | undefined;
      for (const pid of Object.keys(useSessionStore.getState().sessionsByProject)) {
        if (useSessionStore.getState().sessionsByProject[pid]?.some((s) => s.id === id)) {
          projectId = pid;
          break;
        }
      }
      if (!projectId) return; // archived / unknown - nothing to scroll to.

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

  // ── Rename dialog state.
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);

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

  // Split into active vs archived. Active projects show in the tree;
  // archived projects (whole-project archive) show as their own rows in
  // the archived bin, while archived SESSIONS under still-active projects
  // are grouped by their parent project in the bin.
  const activeProjects = projects.filter((p) => !p.archived);
  const archivedProjects = projects.filter((p) => p.archived);

  // Archived sessions grouped by their (still-active) parent project, in
  // the same project order as the tree above. Empty groups are skipped.
  const archivedGroups = activeProjects
    .map((p) => ({ project: p, sessions: archivedSessionsByProject[p.id] ?? [] }))
    .filter((g) => g.sessions.length > 0);
  const archivedCount = archivedProjects.length + archivedGroups.reduce((n, g) => n + g.sessions.length, 0);

  // ── Grouped view buckets. In "grouped" mode the active tree clusters
  // projects under collapsible headers keyed by `Project.group`. Groups are
  // ordered by first appearance (activeProjects is already created_at-ASC);
  // ungrouped projects (group == null) render in a trailing flat section.
  // Memoized so the bucketing only re-runs when the project list changes.
  const { groupedProjects, ungroupedProjects, knownGroups } = useMemo(() => {
    const grouped = new Map<string, Project[]>();
    const ungrouped: Project[] = [];
    for (const p of activeProjects) {
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
  }, [activeProjects, groupMeta]);

  // ── Drag-to-reorder. A single SortableContext covers every visible
  // project (flat list OR all groups flattened in display order). sortable
  // ids are namespaced ("proj:<id>" / "group:<name>") so project ids never
  // collide with group-header droppables. `displayOrder` is the flattened
  // visible order used by onDragEnd to compute from/to indices.
  const displayOrder = useMemo(() => {
    if (projectView === "flat") return activeProjects;
    const out: Project[] = [];
    for (const projs of groupedProjects.values()) out.push(...projs);
    out.push(...ungroupedProjects);
    return out;
  }, [projectView, activeProjects, groupedProjects, ungroupedProjects]);

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
    (id: string) => activeProjects.find((p) => p.id === id),
    [activeProjects],
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

  // Shared <ProjectNode> renderer. Hoisted as a callback so both the flat and
  // grouped views render identical rows (and the group node can embed it).
  // Bound to onContextMenu to open the project-grouping context menu.
  const renderProjectNode = useCallback(
    (p: Project) => (
      <SortableProjectNode key={p.id} projectId={p.id}>
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
          registerNode={registerNode}
          onContextSession={(session, x, y) => setCtxMenu({ session, x, y })}
          onContextProject={(x, y) => setProjectCtxMenu({ project: p, x, y })}
        />
      </SortableProjectNode>
    ),
    [
      sessionsByProject, sessionsHasMoreByProject, sessionsTotalByProject,
      expandedProjects, activeProjectId, activeSessionId, activeSessionProjectId,
      runningBySession,
      toggleProjectExpanded, startSession, loadMoreSessions, openTab,
      archiveSession, deleteSession, setSessionPinned, registerNode,
    ],
  );

  return (
    <div className="flex h-full flex-col px-2 py-2 [font-size:var(--right-panel-font-size)]">
      {/* Brand header — 应用名称与 logo,置于项目列表之上。
          点击打开设置(与底部「设置」入口一致,顶部作为身份锚点)。 */}
      <button
        type="button"
        onClick={() => setSettingsOpen(true)}
        className={cn(
          "group mb-2 flex items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors",
          "hover:bg-surface-hover/60",
        )}
        title={t("layout.about")}
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
                  {activeProjects.map((p) => renderProjectNode(p))}
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
                        projs.forEach((p) => void setProjectGroup(p.id, null));
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
      </div>

      {/* Right-click context menu for session rows. Rendered once at the bar
          level and positioned at the cursor via a virtual anchor. */}
      <SessionContextMenu
        ctxMenu={ctxMenu}
        onClose={() => setCtxMenu(null)}
        onRename={(s) => { setCtxMenu(null); setRenaming({ id: s.id, title: s.title }); }}
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
      />

      {/* Right-click context menu for project rows. Hosts the "移动到分组"
          actions (existing groups + 新建分组 + 移出分组). */}
      <ProjectContextMenu
        ctxMenu={projectCtxMenu}
        knownGroups={knownGroups}
        onClose={() => setProjectCtxMenu(null)}
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

      {/* Rename dialog (shared by the context menu). */}
      <RenameDialog
        renaming={renaming}
        onClose={() => setRenaming(null)}
        onSubmit={async (id, title) => {
          await renameSession(id, title);
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
    registerNode, onContextSession, onContextProject,
    sortableRef, sortableStyle, sortableListeners, sortableAttributes, isDragging,
  } = props;
  const loaded = sessions.length;

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
          ) : (
            sessions.map((s) => (
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
                registerNode={registerNode}
                onContext={(x, y) => onContextSession(s, x, y)}
              />
            ))
          )}
          {hasMore && (
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
  session, active, isRunning, unreadCount, onSelect, onTogglePin, onArchive, onDelete, registerNode, onContext,
}: {
  session: Session;
  active: boolean;
  isRunning: boolean;
  /** Unread event count for this session (0 = no badge). Only rendered when
   *  the row is idle (not running) and the count is > 0. */
  unreadCount: number;
  onSelect: () => void;
  /** Toggle this session's pinned state (project-scoped top-of-list pin). */
  onTogglePin: () => void;
  onArchive: () => void;
  onDelete: () => void;
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
      <SessionRowIcon providerId={session.providerId} className="shrink-0" />

      {/* Pinned marker — always-visible badge on the LEFT (leading edge, next
          to the provider icon) so a pinned thread reads as pinned at a glance,
          independent of the hover actions / unread badge on the right edge. */}
      {isPinned && (
        <IconPinnedFilled
          size={12}
          className="shrink-0 text-accent/80"
          aria-label={t("layout.pinned")}
        />
      )}

      <span className="min-w-0 flex-1 truncate">{session.title}</span>

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
}

function SessionContextMenu({
  ctxMenu, onClose, onRename, onCopyTitle, onOpenFolder, onTogglePin,
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

/* ── Rename dialog ── */

interface RenameDialogProps {
  renaming: { id: string; title: string } | null;
  onClose: () => void;
  onSubmit: (id: string, title: string) => Promise<void>;
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
    void onSubmit(renaming.id, trimmed);
  };

  return (
    <Dialog.Root open={!!renaming} onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Popup className="w-[420px] max-w-[90vw] p-4">
          <Dialog.Title>{t("layout.renameThread")}</Dialog.Title>
          <Dialog.Description className="mt-1">
            {t("layout.renameThreadDesc")}
          </Dialog.Description>

          <div className="mt-4">
            <Input
              value={value}
              autoFocus
              placeholder={t("layout.threadTitlePlaceholder")}
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
 * the project is currently grouped). Plus an "open in file manager" entry
 * for parity with the session context menu. */

interface ProjectContextMenuProps {
  ctxMenu: { project: Project; x: number; y: number } | null;
  knownGroups: string[];
  onClose: () => void;
  onMoveToGroup: (projectId: string, group: string) => void;
  onCreateGroup: (projectId: string) => void;
  onRemoveFromGroup: (projectId: string) => void;
  onOpenFolder: (project: Project) => void;
}

function ProjectContextMenu({
  ctxMenu, knownGroups, onClose,
  onMoveToGroup, onCreateGroup, onRemoveFromGroup, onOpenFolder,
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
