/**
 * ArchivedDialogButton — compact footer icon trigger + modal dialog for
 * viewing, searching, restoring, and permanently deleting archived projects
 * and sessions. Shared by both LeftBar (tree view) and StreamSidebar so the
 * sidebar list stays uncluttered even with 100+ archived items.
 */
import { useMemo, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import {
  IconArchive,
  IconFolder,
  IconSearch,
  IconTrash,
  IconX,
} from "@renderer/lib/icons.js";
import { ConfirmDialog, Dialog } from "@renderer/components/ui/index.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { getProviderIcon } from "@renderer/lib/providerIcon.js";
import { formatRelativeTime } from "@renderer/lib/time.js";
import { ProjectAvatar } from "./ProjectAvatar.js";
import { projectDisplayColor } from "@renderer/lib/projectAvatar.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import type { Project, Session } from "@contracts/session";

type DeleteTarget =
  | { kind: "project"; id: string; name: string }
  | { kind: "session"; id: string; title: string };

export function ArchivedDialogButton() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<DeleteTarget | null>(null);

  const projects = useSessionStore((s) => s.projects);
  const projectColors = useSessionStore((s) => s.projectColors);
  const archivedSessionsByProject = useSessionStore((s) => s.archivedSessionsByProject);
  const archiveProject = useSessionStore((s) => s.archiveProject);
  const archiveSession = useSessionStore((s) => s.archiveSession);
  const deleteProject = useSessionStore((s) => s.deleteProject);
  const deleteSession = useSessionStore((s) => s.deleteSession);

  const { archivedProjects, archivedGroups, totalCount } = useMemo(() => {
    const archProjs: Project[] = [];
    const groups: Array<{ project: Project; sessions: Session[] }> = [];
    let count = 0;

    for (const p of projects) {
      if (p.archived) {
        archProjs.push(p);
        count += 1;
        continue;
      }
      const list = (archivedSessionsByProject[p.id] ?? []).filter(
        (s) => s.kind !== "automation",
      );
      if (list.length > 0) {
        groups.push({ project: p, sessions: list });
        count += list.length;
      }
    }
    return { archivedProjects: archProjs, archivedGroups: groups, totalCount: count };
  }, [projects, archivedSessionsByProject]);

  const normalizedQuery = query.trim().toLowerCase();

  const filteredProjects = useMemo(() => {
    if (!normalizedQuery) return archivedProjects;
    return archivedProjects.filter(
      (p) =>
        p.name.toLowerCase().includes(normalizedQuery) ||
        p.path.toLowerCase().includes(normalizedQuery),
    );
  }, [archivedProjects, normalizedQuery]);

  const filteredGroups = useMemo(() => {
    if (!normalizedQuery) return archivedGroups;
    const out: Array<{ project: Project; sessions: Session[] }> = [];
    for (const g of archivedGroups) {
      const projMatches = g.project.name.toLowerCase().includes(normalizedQuery);
      const matched = projMatches
        ? g.sessions
        : g.sessions.filter((s) => s.title.toLowerCase().includes(normalizedQuery));
      if (matched.length > 0) {
        out.push({ project: g.project, sessions: matched });
      }
    }
    return out;
  }, [archivedGroups, normalizedQuery]);

  const hasVisibleItems = filteredProjects.length > 0 || filteredGroups.length > 0;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "relative flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors [font-size:var(--right-panel-font-size)]",
          open
            ? "bg-accent/15 text-accent"
            : "text-content-muted hover:bg-surface-hover hover:text-content",
        )}
        title={totalCount > 0 ? t("layout.archivedCount", { n: totalCount }) : t("layout.archived")}
        aria-label={totalCount > 0 ? t("layout.archivedCount", { n: totalCount }) : t("layout.archived")}
      >
        <IconArchive size={14} />
        {totalCount > 0 && (
          <span
            className="pointer-events-none absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-accent/80"
            aria-hidden
          />
        )}
      </button>

      <Dialog.Root
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setQuery("");
        }}
      >
        <Dialog.Portal>
          <Dialog.Backdrop />
          <Dialog.Popup className="flex max-h-[78vh] w-[540px] max-w-[92vw] flex-col overflow-hidden rounded-xl border border-edge bg-surface p-0 shadow-2xl">
            {/* Header */}
            <div className="flex shrink-0 items-center justify-between border-b border-edge px-4 py-3">
              <div className="flex items-center gap-2">
                <IconArchive size={16} className="shrink-0 text-content-muted" />
                <Dialog.Title className="text-sm font-semibold text-content">
                  {totalCount > 0
                    ? t("layout.archivedCount", { n: totalCount })
                    : t("layout.archived")}
                </Dialog.Title>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label={t("common.close")}
                className="flex h-7 w-7 items-center justify-center rounded-md text-content-subtle transition-colors hover:bg-surface-hover hover:text-content"
              >
                <IconX size={15} />
              </button>
            </div>

            {/* Search bar */}
            {totalCount > 0 && (
              <div className="shrink-0 border-b border-edge/70 px-4 py-2.5">
                <div className="flex items-center gap-2 rounded-lg border border-edge bg-surface-muted/70 px-2.5 py-1.5 focus-within:border-accent/60">
                  <IconSearch size={13} className="shrink-0 text-content-subtle" />
                  <input
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={t("layout.archivedSearchPlaceholder")}
                    className="min-w-0 flex-1 bg-transparent text-xs text-content placeholder:text-content-subtle focus:outline-none"
                  />
                  {query && (
                    <button
                      type="button"
                      onClick={() => setQuery("")}
                      className="flex h-4 w-4 items-center justify-center rounded text-content-subtle hover:text-content"
                    >
                      <IconX size={12} />
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Scrollable body */}
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
              {!hasVisibleItems ? (
                <div className="flex flex-col items-center justify-center py-12 text-center text-xs text-content-subtle">
                  <IconArchive size={24} className="mb-2 opacity-40" />
                  <span>{t("layout.archivedEmpty")}</span>
                </div>
              ) : (
                <div className="space-y-4">
                  {/* Archived projects */}
                  {filteredProjects.length > 0 && (
                    <div className="space-y-1.5">
                      <div className="px-1 text-[11px] font-medium text-content-subtle">
                        {t("layout.projects")} ({filteredProjects.length})
                      </div>
                      <ul className="space-y-1">
                        {filteredProjects.map((p) => (
                          <li
                            key={p.id}
                            className="group flex items-center gap-2.5 rounded-lg border border-edge/70 bg-surface-card/60 px-3 py-2 text-xs transition-colors hover:bg-surface-hover/50"
                          >
                            <IconFolder size={14} className="shrink-0 text-content-subtle" />
                            <div className="min-w-0 flex-1">
                              <div className="truncate font-medium text-content">{p.name}</div>
                              <div className="truncate text-[11px] text-content-subtle" title={p.path}>
                                {p.path}
                              </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-1">
                              <button
                                type="button"
                                onClick={() => void archiveProject(p.id, false)}
                                className="rounded-md px-2 py-1 text-[11px] font-medium text-accent transition-colors hover:bg-accent/15"
                              >
                                {t("layout.restore")}
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  setConfirmDelete({ kind: "project", id: p.id, name: p.name })
                                }
                                title={t("layout.deleteForever")}
                                className="flex h-6 w-6 items-center justify-center rounded-md text-content-subtle transition-colors hover:bg-danger/15 hover:text-danger"
                              >
                                <IconTrash size={13} />
                              </button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* Archived sessions grouped by project */}
                  {filteredGroups.map(({ project, sessions }) => (
                    <div key={project.id} className="space-y-1.5">
                      <div className="flex items-center gap-1.5 px-1 text-[11px] font-medium text-content-subtle">
                        <ProjectAvatar
                          name={project.name}
                          color={projectDisplayColor(project, projectColors)}
                        />
                        <span className="truncate">{project.name}</span>
                        <span className="opacity-65">({sessions.length})</span>
                      </div>
                      <ul className="space-y-1">
                        {sessions.map((s) => {
                          const { Icon, color } = getProviderIcon(s.providerId);
                          return (
                            <li
                              key={s.id}
                              className="group flex items-center gap-2.5 rounded-lg border border-edge/60 bg-surface-card/45 px-3 py-2 text-xs transition-colors hover:bg-surface-hover/50"
                            >
                              <Icon size={14} className={cn("shrink-0 opacity-75", color)} />
                              <span className="min-w-0 flex-1 truncate text-content" title={s.title}>
                                {s.title}
                              </span>
                              <span className="shrink-0 text-[11px] tabular-nums text-content-subtle">
                                {formatRelativeTime(s.updatedAt)}
                              </span>
                              <div className="flex shrink-0 items-center gap-1">
                                <button
                                  type="button"
                                  onClick={() => void archiveSession(s.id, false)}
                                  className="rounded-md px-2 py-1 text-[11px] font-medium text-accent transition-colors hover:bg-accent/15"
                                >
                                  {t("layout.restore")}
                                </button>
                                <button
                                  type="button"
                                  onClick={() =>
                                    setConfirmDelete({ kind: "session", id: s.id, title: s.title })
                                  }
                                  title={t("layout.deleteForever")}
                                  className="flex h-6 w-6 items-center justify-center rounded-md text-content-subtle transition-colors hover:bg-danger/15 hover:text-danger"
                                >
                                  <IconTrash size={13} />
                                </button>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>

      <ConfirmDialog
        open={confirmDelete !== null}
        onOpenChange={(v) => {
          if (!v) setConfirmDelete(null);
        }}
        title={
          confirmDelete?.kind === "project"
            ? t("layout.deleteProject")
            : t("layout.deleteThread")
        }
        description={
          confirmDelete?.kind === "project"
            ? t("layout.deleteProjectDesc", { name: confirmDelete.name })
            : confirmDelete?.kind === "session"
              ? t("layout.deleteThreadDesc", { title: confirmDelete.title })
              : ""
        }
        confirmText={t("layout.deleteForever")}
        danger
        onConfirm={() => {
          if (!confirmDelete) return;
          if (confirmDelete.kind === "project") {
            void deleteProject(confirmDelete.id);
          } else {
            void deleteSession(confirmDelete.id);
          }
          setConfirmDelete(null);
        }}
      />
    </>
  );
}
