/**
 * MobileSessionDrawer — the touch-first session list for the phone shell.
 *
 * Replaces the desktop LeftBar inside the mobile slide-over. The LeftBar is
 * built around pointer idioms that don't exist on a phone: hover-revealed
 * row actions, right-click context menus, drag-to-reorder, and hover-gated
 * header controls (add project / view-mode toggle). This drawer re-shapes
 * the same store data for fingers:
 *
 *  - Every row is ≥44px tall; the row body and its trailing "…" button are
 *    sibling hit areas (nested buttons are invalid HTML), so picking a
 *    session never fires an action by mistake. Feedback is `active:` state,
 *    not hover.
 *  - Row actions (pin / rename / archive / delete, project new-session,
 *    archived restore/delete) open a bottom action sheet — the touch
 *    equivalent of the desktop context menus. Delete arms on the first tap
 *    and fires on the second, replacing the desktop inline-confirm icons.
 *  - A title search box rides on the same cross-project `session:search`
 *    RPC as the desktop Ctrl+K palette; picking a result switches project
 *    first, then opens the tab (mirrors CommandPalette).
 *  - Desktop-only surfaces are dropped: add-project (pickFolder is
 *    Electron-bound and absent from the web shim), grouped view + drag
 *    reorder, and the settings / locate / theme rail (settings already
 *    lives in the mobile top bar and MobileSettingsSheet).
 */
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import { cn } from "@renderer/lib/cn.js";
import { api } from "@renderer/lib/api.js";
import { getProviderIcon } from "@renderer/lib/providerIcon.js";
import { formatRelativeTime } from "@renderer/lib/time.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { Input } from "@renderer/components/ui/index.js";
import type { Project, Session } from "@contracts/session";
import {
  IconX,
  IconSearch,
  IconPlus,
  IconDotsVertical,
  IconChevronRight,
  IconFolder,
  IconArchive,
  IconPin,
  IconPinnedFilled,
  IconPencil,
  IconTrash,
  IconLoader2,
} from "@renderer/lib/icons.js";

/** Which row's action sheet is open. Archived rows are discriminated from
 *  active ones so the sheet offers restore instead of archive. */
type SheetTarget =
  | { kind: "session"; session: Session }
  | { kind: "project"; project: Project }
  | { kind: "archived-session"; session: Session }
  | { kind: "archived-project"; project: Project };

export function MobileSessionDrawer({
  open,
  onClose,
  onPickSession,
}: {
  open: boolean;
  onClose: () => void;
  /** Fired when a session was picked or created — the caller flips the
   *  bottom-nav view back to "chat" so the user lands on the thread. */
  onPickSession: () => void;
}) {
  const projects = useSessionStore((s) => s.projects);
  const activeProjectId = useSessionStore((s) => s.activeProjectId);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const sessionsByProject = useSessionStore((s) => s.sessionsByProject);
  const sessionsHasMoreByProject = useSessionStore((s) => s.sessionsHasMoreByProject);
  const sessionsTotalByProject = useSessionStore((s) => s.sessionsTotalByProject);
  const archivedSessionsByProject = useSessionStore((s) => s.archivedSessionsByProject);
  const expandedProjects = useSessionStore((s) => s.expandedProjects);
  const runningBySession = useSessionStore((s) => s.runningBySession);
  const unreadBySession = useSessionStore((s) => s.unreadBySession);

  const toggleProjectExpanded = useSessionStore((s) => s.toggleProjectExpanded);
  const loadMoreSessions = useSessionStore((s) => s.loadMoreSessions);
  const startSession = useSessionStore((s) => s.startSession);
  const renameSession = useSessionStore((s) => s.renameSession);
  const setSessionPinned = useSessionStore((s) => s.setSessionPinned);
  const archiveSession = useSessionStore((s) => s.archiveSession);
  const deleteSession = useSessionStore((s) => s.deleteSession);
  const archiveProject = useSessionStore((s) => s.archiveProject);
  const deleteProject = useSessionStore((s) => s.deleteProject);

  const { mounted, entered } = useEnterExit(open, 200);

  const [sheet, setSheet] = useState<SheetTarget | null>(null);
  const [renaming, setRenaming] = useState<Session | null>(null);
  // Two-tap delete arm inside the sheet; reset whenever the sheet changes.
  const [armDelete, setArmDelete] = useState(false);
  // Archived bin expand state (local — the phone renderer has its own store
  // instance, so sharing the desktop's archivedViewOpen key buys nothing).
  const [archiveOpen, setArchiveOpen] = useState(false);

  // Search: a non-empty query swaps the project tree for a flat,
  // cross-project result list.
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Session[] | null>(null);
  const [searching, setSearching] = useState(false);

  // Reset transient state when the drawer closes so it reopens fresh.
  useEffect(() => {
    if (open) return;
    setSheet(null);
    setRenaming(null);
    setArmDelete(false);
    setQuery("");
    setResults(null);
  }, [open]);

  // Debounced cross-project title search (same RPC as Ctrl+K). An error
  // collapses to an empty result so the UI never gets stuck on "搜索中".
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const t = setTimeout(() => {
      void api.session
        .search({ query: q, limit: 30 })
        .then((r) => setResults(r.sessions))
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  const openSheet = useCallback((next: SheetTarget) => {
    setArmDelete(false);
    setSheet(next);
  }, []);

  // Pick a session: switch project first when jumping across projects
  // (openTab assumes the owning project is active), then open the tab.
  const pickSession = useCallback(
    (s: Session) => {
      void (async () => {
        const store = useSessionStore.getState();
        if (s.projectId !== store.activeProjectId) {
          await store.selectProject(s.projectId);
        }
        await store.openTab(s.id);
      })();
      onPickSession();
    },
    [onPickSession],
  );

  const startNewSession = useCallback(
    (projectId: string) => {
      void startSession(projectId);
      onPickSession();
    },
    [startSession, onPickSession],
  );

  const activeProjects = projects.filter((p) => !p.archived);
  const archivedProjects = projects.filter((p) => p.archived);
  // Archived sessions grouped under their (still-active) parent project,
  // same shape as the desktop bin.
  const archivedGroups = activeProjects
    .map((p) => ({ project: p, sessions: archivedSessionsByProject[p.id] ?? [] }))
    .filter((g) => g.sessions.length > 0);
  const archivedCount =
    archivedProjects.length + archivedGroups.reduce((n, g) => n + g.sessions.length, 0);

  // The header button targets the active project, falling back to the first
  // (the phone can't add projects — pickFolder is Electron-bound).
  const newSessionProjectId = activeProjectId ?? activeProjects[0]?.id ?? null;

  if (!mounted) return null;

  const renderSessionRow = (s: Session) => (
    <SessionRow
      key={s.id}
      session={s}
      active={s.id === activeSessionId}
      isRunning={!!runningBySession[s.id]}
      unreadCount={unreadBySession[s.id] ?? 0}
      onPick={() => pickSession(s)}
      onMore={() => openSheet({ kind: "session", session: s })}
    />
  );

  return createPortal(
    <div className="fixed inset-0 z-40">
      <button
        type="button"
        aria-label="关闭会话列表"
        onClick={onClose}
        className={cn(
          "absolute inset-0 bg-black/40 transition-opacity duration-200",
          entered ? "opacity-100" : "opacity-0",
        )}
      />
      <aside
        className={cn(
          "absolute inset-y-0 left-0 flex w-[min(88vw,340px)] flex-col border-r border-edge bg-surface shadow-2xl",
          "transition-transform duration-200 ease-out",
          entered ? "translate-x-0" : "-translate-x-full",
        )}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between px-4 pb-1 pt-3">
          <span className="text-base font-semibold text-content">会话</span>
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-content-muted active:bg-surface-muted"
          >
            <IconX size={18} />
          </button>
        </div>

        {/* Search */}
        <div className="shrink-0 px-3 pb-2 pt-1">
          <div className="flex h-10 items-center gap-2 rounded-xl border border-edge bg-surface-muted/60 px-3">
            <IconSearch size={16} className="shrink-0 text-content-subtle" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索线程"
              // text-base (16px): iOS Safari zooms the viewport on focusing
              // an input rendered below 16px — keep it at the threshold.
              className="min-w-0 flex-1 bg-transparent text-base text-content outline-none placeholder:text-content-subtle"
            />
            {searching ? (
              <IconLoader2 size={14} className="shrink-0 animate-spin text-content-subtle" />
            ) : query ? (
              <button
                type="button"
                aria-label="清除搜索"
                onClick={() => setQuery("")}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-content-subtle active:bg-surface-muted"
              >
                <IconX size={14} />
              </button>
            ) : null}
          </div>
        </div>

        {/* New session — primary action, one tap from anywhere. */}
        {newSessionProjectId && (
          <div className="shrink-0 px-3 pb-2">
            <button
              type="button"
              onClick={() => startNewSession(newSessionProjectId)}
              className="flex h-10 w-full items-center justify-center gap-1.5 rounded-xl bg-accent text-sm font-medium text-surface active:opacity-80"
            >
              <IconPlus size={16} />
              新建会话
            </button>
          </div>
        )}

        {/* Body: search results, or the project → session tree + archive bin.
            select-none keeps long-press from selecting row text on iOS. */}
        <div className="min-h-0 flex-1 select-none overflow-y-auto overscroll-contain pb-4">
          {results ? (
            <ul className="px-1">
              {results.length === 0 ? (
                <li className="px-3 py-8 text-center text-sm text-content-subtle">
                  没有匹配的线程
                </li>
              ) : (
                results.map((s) => renderSessionRow(s))
              )}
            </ul>
          ) : activeProjects.length === 0 ? (
            <div className="px-6 py-10 text-center text-sm leading-relaxed text-content-subtle">
              暂无项目。项目在电脑端添加后，这里会显示它的会话。
            </div>
          ) : (
            <>
              {activeProjects.map((p) => {
                const sessions = sessionsByProject[p.id] ?? [];
                const total = sessionsTotalByProject[p.id] ?? sessions.length;
                const hasMore = !!sessionsHasMoreByProject[p.id];
                const expanded = !!expandedProjects[p.id];
                return (
                  <section key={p.id} className="mb-1">
                    <ProjectHeader
                      project={p}
                      count={total}
                      expanded={expanded}
                      onToggle={() => toggleProjectExpanded(p.id)}
                      onMore={() => openSheet({ kind: "project", project: p })}
                    />
                    {expanded && (
                      <div className="ml-5 border-l border-edge/60 pl-1">
                        {sessions.length === 0 ? (
                          <div className="px-3 py-2.5 text-sm text-content-subtle">暂无线程</div>
                        ) : (
                          <ul>
                            {sessions.map((s) => renderSessionRow(s))}
                            {hasMore && (
                              <li>
                                <button
                                  type="button"
                                  onClick={() => void loadMoreSessions(p.id)}
                                  className="flex min-h-[44px] w-full items-center rounded-lg px-3 text-left text-sm text-content-subtle active:bg-surface-muted"
                                >
                                  加载更多
                                  {total > sessions.length ? `（还有 ${total - sessions.length} 条）` : ""}
                                </button>
                              </li>
                            )}
                          </ul>
                        )}
                      </div>
                    )}
                  </section>
                );
              })}

              {/* Archived bin */}
              {archivedCount > 0 && (
                <div className="mt-2 border-t border-edge pt-1">
                  <button
                    type="button"
                    onClick={() => setArchiveOpen((v) => !v)}
                    className="flex min-h-[44px] w-full items-center gap-2 rounded-lg px-3 text-left active:bg-surface-muted"
                  >
                    <IconChevronRight
                      size={14}
                      className={cn(
                        "shrink-0 text-content-subtle transition-transform",
                        archiveOpen && "rotate-90",
                      )}
                    />
                    <IconArchive size={15} className="shrink-0 text-content-muted" />
                    <span className="text-sm font-medium text-content">已归档</span>
                    <span className="text-xs text-content-subtle">{archivedCount}</span>
                  </button>
                  {archiveOpen && (
                    <div className="ml-5 border-l border-edge/60 pl-1">
                      {archivedProjects.map((p) => (
                        <ArchivedRow
                          key={p.id}
                          icon={<IconFolder size={16} className="shrink-0 text-content-subtle" />}
                          title={p.name}
                          onMore={() => openSheet({ kind: "archived-project", project: p })}
                        />
                      ))}
                      {archivedGroups.map(({ project, sessions }) => (
                        <div key={project.id}>
                          <div className="flex min-h-[36px] items-center gap-2 px-3 text-xs text-content-subtle">
                            <IconFolder size={13} className="shrink-0 opacity-60" />
                            <span className="truncate">{project.name}</span>
                          </div>
                          <ul>
                            {sessions.map((s) => (
                              <ArchivedRow
                                key={s.id}
                                icon={<SessionRowIcon providerId={s.providerId} />}
                                title={s.title}
                                onMore={() =>
                                  openSheet({ kind: "archived-session", session: s })
                                }
                              />
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </aside>

      {/* Sheets render above the drawer panel (later sibling + inset-0). */}
      {sheet && (
        <ActionSheet
          target={sheet}
          armDelete={armDelete}
          onArmDelete={() => setArmDelete(true)}
          onClose={() => setSheet(null)}
          onTogglePin={(s) => {
            void setSessionPinned(s.id, s.pinnedAt == null);
            setSheet(null);
          }}
          onRename={(s) => {
            setRenaming(s);
            setSheet(null);
          }}
          onArchive={(s) => {
            void archiveSession(s.id, true);
            setSheet(null);
          }}
          onRestoreSession={(s) => {
            void archiveSession(s.id, false);
            setSheet(null);
          }}
          onDeleteSession={(s) => {
            void deleteSession(s.id);
            setSheet(null);
          }}
          onNewSession={(pid) => {
            startNewSession(pid);
            setSheet(null);
          }}
          onRestoreProject={(pid) => {
            void archiveProject(pid, false);
            setSheet(null);
          }}
          onDeleteProject={(pid) => {
            void deleteProject(pid);
            setSheet(null);
          }}
        />
      )}
      {renaming && (
        <RenameSheet
          session={renaming}
          onClose={() => setRenaming(null)}
          onSubmit={(title) => {
            void renameSession(renaming.id, title);
            setRenaming(null);
          }}
        />
      )}
    </div>,
    document.body,
  );
}

/* ── Mount/enter animation helper ──
 * Keeps the node mounted during the exit transition. `entered` flips on two
 * rAFs after mount so the off-screen starting style paints first — a single
 * rAF can coalesce with the mount paint and skip the animation entirely. */
function useEnterExit(open: boolean, exitMs: number) {
  const [mounted, setMounted] = useState(open);
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    if (open) {
      setMounted(true);
      let raf2 = 0;
      const raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => setEntered(true));
      });
      return () => {
        cancelAnimationFrame(raf1);
        cancelAnimationFrame(raf2);
      };
    }
    setEntered(false);
    const t = setTimeout(() => setMounted(false), exitMs);
    return () => clearTimeout(t);
  }, [open, exitMs]);
  return { mounted, entered };
}

/* ── Bottom-sheet shell (matches ActivitySheet's idiom) ── */

function SheetShell({
  entered,
  onClose,
  closeLabel,
  children,
}: {
  entered: boolean;
  onClose: () => void;
  closeLabel: string;
  children: ReactNode;
}) {
  return (
    <div className="absolute inset-0 z-10">
      <button
        type="button"
        aria-label={closeLabel}
        onClick={onClose}
        className="absolute inset-0 bg-black/40"
      />
      <div
        className={cn(
          "absolute inset-x-0 bottom-0 rounded-t-2xl border-t border-edge bg-surface pb-2 shadow-2xl",
          "transition-transform duration-200 ease-out",
          entered ? "translate-y-0" : "translate-y-full",
        )}
      >
        <div className="flex justify-center pb-1 pt-2">
          <span className="h-1 w-8 rounded-full bg-edge" />
        </div>
        {children}
      </div>
    </div>
  );
}

/** One full-width sheet row — 48px tall, icon + label, danger for red rows. */
function SheetItem({
  icon,
  label,
  danger,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex min-h-12 w-full items-center gap-3 px-4 text-left text-sm active:bg-surface-muted",
        danger ? "text-danger" : "text-content",
      )}
    >
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}

/* ── Row action sheet — the touch equivalent of the desktop context menus.
 *  Deletes arm on the first tap ("再次点击确认删除") and fire on the second,
 *  so a stray tap can't destroy a thread. ── */

function ActionSheet({
  target,
  armDelete,
  onArmDelete,
  onClose,
  onTogglePin,
  onRename,
  onArchive,
  onRestoreSession,
  onDeleteSession,
  onNewSession,
  onRestoreProject,
  onDeleteProject,
}: {
  target: SheetTarget;
  armDelete: boolean;
  onArmDelete: () => void;
  onClose: () => void;
  onTogglePin: (s: Session) => void;
  onRename: (s: Session) => void;
  /** Active-row 归档 (archive=true). */
  onArchive: (s: Session) => void;
  /** Archived-row 恢复到列表 (archive=false). */
  onRestoreSession: (s: Session) => void;
  onDeleteSession: (s: Session) => void;
  onNewSession: (projectId: string) => void;
  onRestoreProject: (projectId: string) => void;
  onDeleteProject: (projectId: string) => void;
}) {
  const { entered } = useEnterExit(true, 0);

  let body: ReactNode;
  switch (target.kind) {
    case "session": {
      const s = target.session;
      const pinned = s.pinnedAt != null;
      body = (
        <>
          <SheetItem
            icon={pinned ? <IconPinnedFilled size={18} /> : <IconPin size={18} />}
            label={pinned ? "取消置顶" : "置顶"}
            onClick={() => onTogglePin(s)}
          />
          <SheetItem
            icon={<IconPencil size={18} />}
            label="重命名"
            onClick={() => onRename(s)}
          />
          <SheetItem
            icon={<IconArchive size={18} />}
            label="归档"
            onClick={() => onArchive(s)}
          />
          <SheetItem
            danger
            icon={<IconTrash size={18} />}
            label={armDelete ? "再次点击确认删除" : "删除"}
            onClick={() => (armDelete ? onDeleteSession(s) : onArmDelete())}
          />
        </>
      );
      break;
    }
    case "project":
      body = (
        <SheetItem
          icon={<IconPlus size={18} />}
          label="在此项目新建会话"
          onClick={() => onNewSession(target.project.id)}
        />
      );
      break;
    case "archived-session": {
      const s = target.session;
      body = (
        <>
          <SheetItem
            icon={<IconArchive size={18} />}
            label="恢复到列表"
            onClick={() => onRestoreSession(s)}
          />
          <SheetItem
            danger
            icon={<IconTrash size={18} />}
            label={armDelete ? "再次点击确认删除" : "彻底删除"}
            onClick={() => (armDelete ? onDeleteSession(s) : onArmDelete())}
          />
        </>
      );
      break;
    }
    case "archived-project": {
      const p = target.project;
      body = (
        <>
          <SheetItem
            icon={<IconArchive size={18} />}
            label="恢复到列表"
            onClick={() => onRestoreProject(p.id)}
          />
          <SheetItem
            danger
            icon={<IconTrash size={18} />}
            label={armDelete ? "再次点击确认删除" : "彻底删除"}
            onClick={() => (armDelete ? onDeleteProject(p.id) : onArmDelete())}
          />
        </>
      );
      break;
    }
  }

  return (
    <SheetShell entered={entered} onClose={onClose} closeLabel="关闭操作菜单">
      {body}
    </SheetShell>
  );
}

/* ── Rename sheet — one input, Enter or 保存 submits. ── */

function RenameSheet({
  session,
  onClose,
  onSubmit,
}: {
  session: Session;
  onClose: () => void;
  onSubmit: (title: string) => void;
}) {
  const [value, setValue] = useState(session.title);
  const { entered } = useEnterExit(true, 0);
  const trimmed = value.trim();
  const submit = () => {
    if (trimmed) onSubmit(trimmed);
  };

  return (
    <SheetShell entered={entered} onClose={onClose} closeLabel="取消重命名">
      <div className="px-4 pb-3 pt-1">
        <div className="mb-2 text-sm font-semibold text-content">重命名线程</div>
        <Input
          value={value}
          autoFocus
          placeholder="线程标题"
          onChange={(e) => setValue((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
          onFocus={(e) => (e.target as HTMLInputElement).select()}
          // text-base (16px) — see the search input's iOS zoom note.
          className="h-11 rounded-lg px-3 font-sans text-base"
        />
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-10 flex-1 rounded-xl border border-edge text-sm text-content-muted active:bg-surface-muted"
          >
            取消
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!trimmed}
            className="h-10 flex-1 rounded-xl bg-accent text-sm font-medium text-surface active:opacity-80 disabled:opacity-40"
          >
            保存
          </button>
        </div>
      </div>
    </SheetShell>
  );
}

/* ── Session row — body button (pick) + "…" button (actions) as siblings. ── */

function SessionRow({
  session,
  active,
  isRunning,
  unreadCount,
  onPick,
  onMore,
}: {
  session: Session;
  active: boolean;
  isRunning: boolean;
  unreadCount: number;
  onPick: () => void;
  onMore: () => void;
}) {
  return (
    <li className="flex items-stretch">
      <button
        type="button"
        onClick={onPick}
        className={cn(
          "flex min-h-[48px] min-w-0 flex-1 items-center gap-2.5 rounded-lg py-1.5 pl-3 pr-1 text-left active:bg-surface-muted",
          active && "bg-surface-hover",
        )}
      >
        <SessionRowIcon providerId={session.providerId} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5">
            {session.pinnedAt != null && (
              <IconPinnedFilled size={11} className="shrink-0 text-accent/80" aria-label="已置顶" />
            )}
            <span className="truncate text-sm text-content">{session.title}</span>
          </span>
          <span className="text-xs leading-none text-content-subtle">
            {formatRelativeTime(session.updatedAt)}
          </span>
        </span>
        {isRunning ? (
          <IconLoader2 size={14} className="shrink-0 animate-spin text-accent" />
        ) : unreadCount > 0 ? (
          <span className="shrink-0 min-w-[18px] rounded-full bg-accent/85 px-1 text-center text-[10px] font-medium leading-[18px] text-surface">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        ) : null}
      </button>
      <button
        type="button"
        aria-label="更多操作"
        onClick={onMore}
        className="flex w-11 shrink-0 items-center justify-center self-stretch rounded-lg text-content-subtle active:bg-surface-muted"
      >
        <IconDotsVertical size={18} />
      </button>
    </li>
  );
}

/** Provider-branded leading icon for a session row. */
function SessionRowIcon({ providerId }: { providerId: string }) {
  const { Icon, color } = getProviderIcon(providerId);
  return <Icon size={16} className={cn("shrink-0", color)} />;
}

/* ── Project header — tap toggles expand, "…" offers project actions. ── */

function ProjectHeader({
  project,
  count,
  expanded,
  onToggle,
  onMore,
}: {
  project: Project;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  onMore: () => void;
}) {
  return (
    <div className="flex items-stretch">
      <button
        type="button"
        onClick={onToggle}
        className="flex min-h-[44px] min-w-0 flex-1 items-center gap-2 rounded-lg px-3 text-left active:bg-surface-muted"
      >
        <IconChevronRight
          size={14}
          className={cn("shrink-0 text-content-subtle transition-transform", expanded && "rotate-90")}
        />
        <IconFolder size={16} className="shrink-0 text-content-muted" />
        <span className="truncate text-sm font-medium text-content">{project.name}</span>
        {count > 0 && <span className="shrink-0 text-xs text-content-subtle">{count}</span>}
      </button>
      <button
        type="button"
        aria-label="项目操作"
        onClick={onMore}
        className="flex w-11 shrink-0 items-center justify-center self-stretch rounded-lg text-content-subtle active:bg-surface-muted"
      >
        <IconDotsVertical size={18} />
      </button>
    </div>
  );
}

/* ── Archived row — non-interactive body + "…" (restore / delete). ── */

function ArchivedRow({
  icon,
  title,
  onMore,
}: {
  icon: ReactNode;
  title: string;
  onMore: () => void;
}) {
  return (
    <li className="flex items-stretch">
      <div className="flex min-h-[44px] min-w-0 flex-1 items-center gap-2.5 py-1.5 pl-3 pr-1">
        {icon}
        <span className="truncate text-sm text-content-muted">{title}</span>
      </div>
      <button
        type="button"
        aria-label="归档项操作"
        onClick={onMore}
        className="flex w-11 shrink-0 items-center justify-center self-stretch rounded-lg text-content-subtle active:bg-surface-muted"
      >
        <IconDotsVertical size={18} />
      </button>
    </li>
  );
}
