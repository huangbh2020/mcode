/**
 * Toolbar git quick-commit widget — sits in the titlebar next to the branch
 * pill. Extends the compact ProjectBranchIndicator with a change-count badge
 * (green +added / red -deleted / muted ~modified, file counts from git
 * status) that opens a quick-commit popover:
 *
 *   - repo switcher (only for projects hosting MULTIPLE git repos; the last
 *     selection is remembered per project for the session)
 *   - commit-message box + LLM generation, reusing the right panel's
 *     configured generation model + prompt (commitGenModel / commitGenPrompt)
 *   - "commit" and "commit & push" over ALL changes — everything is
 *     auto-staged first (untracked included); fine-grained staging stays in
 *     the right panel's GitRepoCard by design
 *
 * Refresh triggers: git.changed runtime events (main bumps
 * gitChangeVersionByRepo after ANY client's git op — covers commits/stages
 * from every surface including this popover), popover open, window focus,
 * and a light 10s poll that catches plain file edits (the agent writing
 * files emits no git event).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { relativePath, joinPath, basename } from "@renderer/lib/path.js";
import { isMac } from "@renderer/lib/platform.js";
import { browserUuid } from "@renderer/lib/uuid.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useToastStore } from "@renderer/stores/toastStore.js";
import type { GitFileStatus, GitRepo, GitStatusResult } from "@contracts/ipc";
import {
  IconAlertTriangle,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconFileText,
  IconGitCommit,
  IconLoader2,
  IconMinus,
  IconPencil,
  IconPlus,
  IconRefresh,
  IconSparkles,
  IconUpload,
  IconX,
} from "@renderer/lib/icons.js";
import { ProjectBranchIndicator } from "@renderer/components/chat/ProjectBranchIndicator.js";

/** Poll cadence for the badge while the project is open. Only one
 *  `git status` per tick — cheap next to serviceScanner's 5s platform calls. */
const STATUS_POLL_MS = 10_000;

/** Per-session memory of the user's selected repo, keyed by project path.
 *  Module-level on purpose: survives popover close/unmount, resets on app
 *  restart (repo lists shift; a stale path is validated before use anyway). */
const lastRepoByProject = new Map<string, string>();

/** File-count breakdown of a status: additions (new/untracked files),
 *  deletions, everything else (modifications / renames / conflicts). A file
 *  is counted once — deletion dominates (index says new, disk says gone ⇒
 *  net nothing), then addition, then the modified bucket. */
function countChanges(files: GitFileStatus[]): {
  added: number;
  deleted: number;
  modified: number;
} {
  let added = 0;
  let deleted = 0;
  let modified = 0;
  for (const f of files) {
    if (f.index === "deleted" || f.workingTree === "deleted") {
      deleted++;
    } else if (
      f.index === "added" ||
      f.index === "untracked" ||
      f.workingTree === "added" ||
      f.workingTree === "untracked"
    ) {
      added++;
    } else {
      modified++;
    }
  }
  return { added, deleted, modified };
}

export function ToolbarGitCommit() {
  const { t } = useI18n();
  const activeProjectId = useSessionStore((s) => s.activeProjectId);
  const projects = useSessionStore((s) => s.projects);
  const commitGenModel = useSessionStore((s) => s.commitGenModel);
  const commitGenPrompt = useSessionStore((s) => s.commitGenPrompt);
  const openFileInIde = useSessionStore((s) => s.openFileInIde);

  const { projectPath } = useMemo(() => {
    if (!activeProjectId) return { projectPath: "" };
    const p = projects.find((x) => x.id === activeProjectId);
    return { projectPath: p?.path ?? "" };
  }, [activeProjectId, projects]);

  // ── repo discovery + selection ──
  const [repos, setRepos] = useState<GitRepo[] | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const selectedRepo = useMemo(
    () => repos?.find((r) => r.path === selectedPath) ?? null,
    [repos, selectedPath],
  );

  // ── status of the selected repo ──
  const [status, setStatus] = useState<GitStatusResult | null>(null);
  const counts = useMemo(() => countChanges(status?.files ?? []), [status]);
  const totalChanges = counts.added + counts.deleted + counts.modified;

  // ── popover / actions state ──
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<null | "generate" | "commit" | "push">(null);
  const [error, setError] = useState<string | null>(null);
  const [filesExpanded, setFilesExpanded] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Stop-generation bookkeeping
  const cancelledRef = useRef(false);
  const genRequestIdRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRepos(null);
    setSelectedPath(null);
    setStatus(null);
    setMessage("");
    setError(null);
    (async () => {
      if (!projectPath) return;
      try {
        const { repos: found } = await api.git.discoverRepos({ projectPath });
        if (cancelled) return;
        setRepos(found);
        if (found.length === 0) return;
        const remembered = lastRepoByProject.get(projectPath);
        const primary =
          found
            .map((r) => ({ r, rel: relativePath(r.path, projectPath).length }))
            .sort((a, b) => a.rel - b.rel || a.r.name.localeCompare(b.r.name))[0]?.r ?? null;
        const initial =
          remembered && found.some((r) => r.path === remembered)
            ? remembered
            : primary?.path ?? null;
        if (!cancelled) setSelectedPath(initial);
      } catch {
        if (!cancelled) setRepos([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  /** Re-fetch status of the selected repo. */
  const refreshStatus = useCallback(async () => {
    if (!selectedRepo) {
      setStatus(null);
      return;
    }
    setIsRefreshing(true);
    try {
      const { status: st } = await api.git.status({ repoPath: selectedRepo.path });
      setStatus(st);
    } catch {
      setStatus(null);
    } finally {
      setIsRefreshing(false);
    }
  }, [selectedRepo]);

  // Repo (re)selection refetches immediately.
  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  // Any git op on this repo bumps store version -> refetch
  const changeVersion = useSessionStore((s) =>
    selectedRepo ? s.gitChangeVersionByRepo[selectedRepo.path] ?? 0 : 0,
  );
  useEffect(() => {
    void refreshStatus();
  }, [changeVersion, refreshStatus]);

  // Light poll + focus refresh
  useEffect(() => {
    if (!selectedRepo) return;
    const id = window.setInterval(() => void refreshStatus(), STATUS_POLL_MS);
    const onFocus = () => void refreshStatus();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [selectedRepo, refreshStatus]);

  const handleRepoSwitch = useCallback(
    (path: string) => {
      lastRepoByProject.set(projectPath, path);
      setSelectedPath(path);
      setMessage("");
      setError(null);
    },
    [projectPath],
  );

  /** `git add .` from repo root */
  const stageAll = useCallback(async (repoPath: string) => {
    const res = await api.git.stage({ repoPath, filePaths: ["."] });
    if (!res.ok) throw new Error(res.error || "git add failed");
  }, []);

  /** LLM commit-message generation */
  const handleGenerate = useCallback(async () => {
    if (!selectedRepo || busy) return;
    let customModelId: string | null = null;
    let customModelRole: string | null = null;
    if (commitGenModel) {
      const colonIdx = commitGenModel.lastIndexOf(":");
      if (colonIdx > 0) {
        customModelId = commitGenModel.slice(0, colonIdx);
        customModelRole = commitGenModel.slice(colonIdx + 1);
      } else {
        customModelId = commitGenModel;
      }
    }
    if (!customModelId) return;

    setBusy("generate");
    setError(null);
    cancelledRef.current = false;
    const requestId = browserUuid();
    genRequestIdRef.current = requestId;
    try {
      await stageAll(selectedRepo.path);
      const res = await api.git.generateCommitMessage({
        repoPath: selectedRepo.path,
        customModelId,
        customModelRole,
        prompt: commitGenPrompt,
        requestId,
        scope: "staged",
      });
      if (cancelledRef.current) return;
      if (res.ok && res.message) {
        setMessage(res.message);
      } else {
        setError(res.error ?? t("layout.gitCommit.generateFailed"));
      }
    } catch (err) {
      if (!cancelledRef.current) {
        setError((err as Error).message || t("layout.gitCommit.generateFailed"));
      }
    } finally {
      genRequestIdRef.current = null;
      setBusy(null);
    }
  }, [selectedRepo, busy, commitGenModel, commitGenPrompt, stageAll, t]);

  /** Commit ALL changes, optionally push */
  const handleCommit = useCallback(
    async (push: boolean) => {
      if (!selectedRepo || busy) return;
      const trimmed = message.trim();
      if (!trimmed || totalChanges === 0) return;
      setBusy(push ? "push" : "commit");
      setError(null);
      try {
        await stageAll(selectedRepo.path);
        const res = await api.git.commit({ repoPath: selectedRepo.path, message: trimmed });
        if (!res.ok) throw new Error(res.error || t("layout.gitCommit.commitFailed"));
        setMessage("");
        if (push) {
          const pres = await api.git.push({ repoPath: selectedRepo.path });
          if (!pres.ok) throw new Error(pres.error || t("layout.gitCommit.pushFailed"));
        }
        setOpen(false);
        useToastStore.getState().push({
          kind: "info",
          title: t(push ? "layout.gitCommit.committedPushed" : "layout.gitCommit.committed"),
          body: selectedRepo.name,
        });
        void refreshStatus();
      } catch (err) {
        const msg = (err as Error).message || t("layout.gitCommit.commitFailed");
        setError(msg);
        useToastStore.getState().push({
          kind: "error",
          title: t(push ? "layout.gitCommit.pushFailed" : "layout.gitCommit.commitFailed"),
          body: msg,
        });
      } finally {
        setBusy(null);
      }
    },
    [selectedRepo, busy, message, totalChanges, stageAll, refreshStatus, t],
  );

  // Not a git project — render nothing
  if (!projectPath || !repos || repos.length === 0 || !selectedRepo) return null;

  const hasModel = !!commitGenModel;
  const canCommit = totalChanges > 0 && !!message.trim() && busy === null;

  return (
    <div
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      className="inline-flex h-7 shrink-0 items-center rounded-lg border border-edge/80 bg-surface px-1 py-0.5 shadow-xs transition-all hover:border-accent/40 hover:shadow-sm"
    >
      {/* Left segment: Branch button */}
      <ProjectBranchIndicator
        projectPath={projectPath}
        projectName=""
        compact
        repos={repos}
        repoOverride={selectedRepo}
        triggerClassName="flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-medium text-content/90 hover:text-content hover:bg-surface-hover/80 active:scale-[0.98] transition-all cursor-pointer"
      />

      {/* Hairline divider */}
      <div className="mx-1 h-3.5 w-[1px] shrink-0 bg-edge/70" />

      {/* Right segment: Change-count or Clean status trigger */}
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger
          className={cn(
            "flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 font-mono text-[11px] tabular-nums transition-all select-none cursor-pointer active:scale-[0.98]",
            totalChanges > 0
              ? "bg-accent/5 hover:bg-accent/15 text-content hover:text-content"
              : "text-content-muted hover:bg-surface-hover/80 hover:text-content",
          )}
          title={
            totalChanges > 0
              ? t("layout.gitCommit.badgeTitle", {
                  added: counts.added,
                  deleted: counts.deleted,
                  modified: counts.modified,
                })
              : t("layout.gitCommit.badgeTitleClean")
          }
        >
          {totalChanges > 0 ? (
            <div className="flex items-center gap-1.5">
              <IconGitCommit size={12} className="text-accent shrink-0" />
              <div className="flex items-center gap-1">
                {counts.added > 0 && (
                  <span className="font-semibold text-success">+{counts.added}</span>
                )}
                {counts.deleted > 0 && (
                  <span className="font-semibold text-danger">-{counts.deleted}</span>
                )}
                {counts.added === 0 && counts.deleted === 0 && counts.modified > 0 && (
                  <span className="font-semibold text-content-muted">~{counts.modified}</span>
                )}
              </div>
              <IconChevronDown size={10} className="shrink-0 opacity-60 ml-0.5" />
            </div>
          ) : (
            <div className="flex items-center gap-1.5 font-sans">
              <IconCheck size={12} className="text-success shrink-0" />
              <span className="text-[11px] font-medium text-content-muted">{t("layout.gitCommit.clean")}</span>
              <IconChevronDown size={10} className="shrink-0 opacity-40 ml-0.5" />
            </div>
          )}
        </Popover.Trigger>

        <Popover.Portal>
          <Popover.Positioner
            side="bottom"
            align="end"
            sideOffset={6}
            className="z-[60]"
          >
            <Popover.Popup
              className={cn(
                "flex w-[380px] flex-col gap-2.5 overflow-hidden rounded-xl border border-edge/80 bg-surface/95 backdrop-blur-md p-3 shadow-2xl ring-1 ring-black/5 dark:ring-white/10",
                "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
                "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
                "transition-[transform,opacity] duration-100",
              )}
            >
              {/* Header: Title + branch badge + repo switcher + actions */}
              <div className="flex items-center gap-1.5">
                <div className="flex items-center gap-1.5">
                  <div className="flex h-5 w-5 items-center justify-center rounded-md bg-accent/10 text-accent">
                    <IconGitCommit size={13} />
                  </div>
                  <span className="text-xs font-semibold text-content">
                    {t("layout.gitCommit.title")}
                  </span>
                  <span className="max-w-[120px] truncate rounded bg-surface-muted px-1.5 py-0.5 font-mono text-[10px] text-content-muted">
                    {status?.branch || selectedRepo.name}
                  </span>
                </div>

                <div className="flex-1" />

                {/* Multi-repo switcher */}
                {repos.length > 1 && (
                  <div className="relative flex items-center">
                    <select
                      value={selectedPath ?? ""}
                      onChange={(e) => handleRepoSwitch(e.target.value)}
                      title={t("layout.gitCommit.repoSelectTitle")}
                      className={cn(
                        "max-w-[140px] truncate rounded-md border border-edge/60 bg-surface-muted/60 py-0.5 pl-1.5 pr-5 font-mono text-[10px] text-content-muted",
                        "outline-none appearance-none cursor-pointer hover:bg-surface-hover/80 hover:text-content focus:border-accent/80 transition-colors",
                      )}
                    >
                      {repos.map((r) => (
                        <option key={r.path} value={r.path}>
                          {r.name}
                        </option>
                      ))}
                    </select>
                    <IconChevronDown
                      size={10}
                      className="pointer-events-none absolute right-1.5 text-content-subtle"
                    />
                  </div>
                )}

                {/* Refresh button */}
                <button
                  onClick={() => void refreshStatus()}
                  disabled={isRefreshing}
                  title={t("layout.gitCommit.refresh")}
                  className="flex h-6 w-6 items-center justify-center rounded-md text-content-subtle hover:bg-surface-hover hover:text-content transition-colors"
                >
                  <IconRefresh
                    size={12}
                    className={cn(isRefreshing && "animate-spin text-accent")}
                  />
                </button>

                {/* Close button */}
                <button
                  onClick={() => setOpen(false)}
                  className="flex h-6 w-6 items-center justify-center rounded-md text-content-subtle hover:bg-surface-hover hover:text-content transition-colors"
                >
                  <IconX size={12} />
                </button>
              </div>

              {/* Changes section: summary tags + collapsible file list */}
              {totalChanges > 0 ? (
                <div className="flex flex-col rounded-lg border border-edge/50 bg-surface-muted/40 p-2">
                  <div className="flex items-center justify-between text-[11px]">
                    <div className="flex items-center gap-1.5 font-mono">
                      {counts.added > 0 && (
                        <span className="rounded bg-success/10 px-1.5 py-0.5 font-semibold text-success">
                          +{counts.added} {t("layout.gitCommit.addedShort")}
                        </span>
                      )}
                      {counts.deleted > 0 && (
                        <span className="rounded bg-danger/10 px-1.5 py-0.5 font-semibold text-danger">
                          -{counts.deleted} {t("layout.gitCommit.deletedShort")}
                        </span>
                      )}
                      {counts.modified > 0 && (
                        <span className="rounded bg-surface-muted px-1.5 py-0.5 font-semibold text-content-muted">
                          ~{counts.modified} {t("layout.gitCommit.modifiedShort")}
                        </span>
                      )}
                    </div>

                    <button
                      onClick={() => setFilesExpanded(!filesExpanded)}
                      className="flex items-center gap-0.5 text-[10px] text-content-subtle hover:text-content transition-colors"
                    >
                      <span>
                        {t("layout.gitCommit.filesChanged", { n: status?.files.length ?? 0 })}
                      </span>
                      {filesExpanded ? (
                        <IconChevronDown size={11} />
                      ) : (
                        <IconChevronRight size={11} />
                      )}
                    </button>
                  </div>

                  {/* Collapsible file changes list */}
                  {filesExpanded && status?.files && status.files.length > 0 && (
                    <div className="mt-1.5 max-h-[140px] space-y-0.5 overflow-y-auto pr-0.5 pt-1 border-t border-edge/40">
                      {status.files.map((f) => {
                        const isDeleted =
                          f.index === "deleted" || f.workingTree === "deleted";
                        const isAdded =
                          f.index === "added" ||
                          f.index === "untracked" ||
                          f.workingTree === "added" ||
                          f.workingTree === "untracked";

                        const name = basename(f.path);
                        const dir = f.path.includes("/")
                          ? f.path.slice(0, f.path.lastIndexOf("/"))
                          : "";

                        return (
                          <div
                            key={f.path}
                            onClick={() => {
                              openFileInIde(joinPath(selectedRepo.path, f.path), {
                                diff: true,
                              });
                            }}
                            title={`${f.path} — ${t("layout.gitCommit.viewDiff")}`}
                            className="group flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[11px] hover:bg-surface-hover/80 cursor-pointer transition-colors"
                          >
                            <span className="shrink-0">
                              {isDeleted ? (
                                <IconMinus size={11} className="text-danger" />
                              ) : isAdded ? (
                                <IconPlus size={11} className="text-success" />
                              ) : (
                                <IconPencil size={11} className="text-content-subtle" />
                              )}
                            </span>
                            <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
                              <span className="text-content font-medium">{name}</span>
                              {dir && (
                                <span className="ml-1 text-[10px] text-content-subtle opacity-70">
                                  {dir}
                                </span>
                              )}
                            </span>
                            <span className="shrink-0 text-[10px] text-content-subtle opacity-0 group-hover:opacity-100 transition-opacity">
                              {t("layout.gitCommit.viewDiff")}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex items-center justify-center gap-1.5 rounded-lg border border-edge/40 bg-surface-muted/30 py-3 text-[11px] text-content-subtle">
                  <IconCheck size={13} className="text-success" />
                  <span>{t("layout.gitCommit.noChanges")}</span>
                </div>
              )}

              {/* Commit message input card */}
              <div className="flex flex-col rounded-lg border border-edge/70 bg-surface-muted/40 transition-all focus-within:border-accent/80 focus-within:bg-surface focus-within:ring-2 focus-within:ring-accent/15">
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && canCommit) {
                      e.preventDefault();
                      void handleCommit(false);
                    }
                  }}
                  placeholder={t("layout.gitCommit.messagePlaceholder")}
                  rows={3}
                  className="w-full resize-none bg-transparent p-2 text-xs leading-relaxed text-content outline-none placeholder:text-content-subtle"
                />

                {/* Inline toolbar: AI Generator + shortcut hint */}
                <div className="flex items-center justify-between border-t border-edge/40 px-2 py-1 bg-surface-muted/30">
                  <button
                    onClick={handleGenerate}
                    disabled={!hasModel || busy !== null || totalChanges === 0}
                    title={
                      hasModel
                        ? t("layout.gitCommit.generate")
                        : t("layout.gitCommit.generateNoModel")
                    }
                    className={cn(
                      "flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-accent transition-all",
                      "hover:bg-accent/10 active:scale-95",
                      "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent",
                    )}
                  >
                    {busy === "generate" ? (
                      <IconLoader2 size={12} className="animate-spin" />
                    ) : (
                      <IconSparkles size={12} />
                    )}
                    <span>
                      {busy === "generate"
                        ? t("layout.gitCommit.generating")
                        : t("layout.gitCommit.generate")}
                    </span>
                  </button>

                  <span className="font-mono text-[10px] text-content-subtle">
                    {isMac ? "⌘↵" : "Ctrl+↵"}
                  </span>
                </div>
              </div>

              {/* Footer actions: note on its own line + commit buttons row */}
              <div className="flex flex-col gap-1.5 pt-0.5">
                <span className="text-[10px] leading-tight text-content-subtle">
                  {t("layout.gitCommit.stageNote")}
                </span>

                <div className="flex items-center justify-end gap-1.5">
                <button
                  onClick={() => void handleCommit(false)}
                  disabled={!canCommit}
                  className={cn(
                    "flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-edge/80 bg-surface px-2.5 py-1 text-xs font-medium text-content transition-all",
                    "hover:bg-surface-hover active:scale-95",
                    "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-surface",
                  )}
                >
                  {busy === "commit" ? (
                    <IconLoader2 size={12} className="animate-spin text-accent" />
                  ) : (
                    <IconCheck size={12} />
                  )}
                  <span>{t("layout.gitCommit.commit")}</span>
                </button>

                <button
                  onClick={() => void handleCommit(true)}
                  disabled={!canCommit}
                  title={t("layout.gitCommit.commitPush")}
                  className={cn(
                    "flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-white shadow-xs transition-all",
                    "hover:bg-accent/90 active:scale-95",
                    "disabled:cursor-not-allowed disabled:opacity-40",
                  )}
                >
                  {busy === "push" ? (
                    <IconLoader2 size={12} className="animate-spin text-white" />
                  ) : (
                    <IconUpload size={12} />
                  )}
                  <span>{t("layout.gitCommit.commitPush")}</span>
                </button>
                </div>
              </div>

              {/* Inline error feedback */}
              {error && (
                <div className="flex items-start gap-1.5 rounded-lg border border-danger/20 bg-danger/10 p-2 text-[11px] text-danger">
                  <IconAlertTriangle size={13} className="mt-0.5 shrink-0" />
                  <span className="break-words leading-tight">{error}</span>
                </div>
              )}
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
