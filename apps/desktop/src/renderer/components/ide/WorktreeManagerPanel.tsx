import { useCallback, useEffect, useState } from "react";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { basename } from "@renderer/lib/path.js";
import type { GitRepo, GitWorktreeInfo } from "@contracts/ipc";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { Button, Dialog } from "@renderer/components/ui/index.js";
import {
  IconGitFork,
  IconGitBranch,
  IconLoader2,
  IconRefresh,
  IconTrash,
  IconAlertTriangle,
} from "@renderer/lib/icons.js";
import { useI18n } from "@renderer/lib/i18n/index.js";

/**
 * Git panel "工作树" sub-tab — the cleanup surface for isolated agent-task
 * worktrees (creation lives in the composer; merge-back lives in the
 * session's merge dialog). Per repo: lists linked worktrees with lifecycle
 * badges (dirty / missing / orphan = no referencing session / already
 * merged) and a guarded remove (force + optional patch export for dirty
 * trees). The main worktree renders as a read-only reference row stating
 * the branch parallel tasks merge back into.
 */
export function WorktreeManagerPanel({ repos }: { repos: GitRepo[] }) {
  const { t } = useI18n();
  const [entries, setEntries] = useState<Record<string, GitWorktreeInfo[]>>({});
  const [loading, setLoading] = useState(true);

  // Refresh whenever ANY of the listed repos sees a git mutation (merge-back
  // in the session dialog, commits from the changes tab, …). Summed version —
  // a stable number that changes on any bump.
  const gitChangeVersion = useSessionStore((s) =>
    repos.reduce((n, r) => n + (s.gitChangeVersionByRepo[r.path] ?? 0), 0),
  );
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next: Record<string, GitWorktreeInfo[]> = {};
      await Promise.all(
        repos.map(async (r) => {
          const { worktrees } = await api.git.worktreeList({ repoPath: r.path });
          next[r.path] = worktrees;
        }),
      );
      setEntries(next);
    } catch {
      setEntries({});
    } finally {
      setLoading(false);
    }
    // repo paths identity: repos come from GitPanel's scan state.
  }, [repos]);

  useEffect(() => {
    void load();
  }, [load, gitChangeVersion]);

  if (loading) {
    return (
      <div className="flex items-center gap-1.5 px-3 py-2 [font-size:var(--right-panel-font-size)] text-content-subtle">
        <IconLoader2 size={12} className="animate-spin" />
        {t("chat.worktree.loading")}
      </div>
    );
  }

  const total = Object.values(entries)
    .map((list) => list.filter((w) => !w.main).length)
    .reduce((a, b) => a + b, 0);

  if (total === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 p-6 text-center">
        <IconGitFork size={20} className="text-content-subtle" />
        <p className="[font-size:var(--right-panel-font-size)] text-content-muted">
          {t("chat.worktree.managerEmpty")}
        </p>
        <p className="[font-size:var(--right-panel-font-size)] text-content-subtle">
          {t("chat.worktree.managerEmptyHint")}
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-2">
      <div className="space-y-2">
        {repos.map((repo) => {
          const list = entries[repo.path] ?? [];
          const linked = list.filter((w) => !w.main);
          const main = list.find((w) => w.main);
          if (linked.length === 0) return null;
          return (
            <div key={repo.path} className="rounded-md border border-edge">
              <div className="flex items-center gap-1.5 border-b border-edge px-2 py-1.5">
                <IconGitBranch size={12} className="shrink-0 text-content-subtle" />
                <span className="truncate text-xs font-medium text-content" title={repo.path}>
                  {repo.name}
                </span>
                {main?.branch && (
                  <span className="ml-auto shrink-0 text-[10px] text-content-subtle">
                    {t("chat.worktree.mainIs", { branch: main.branch })}
                  </span>
                )}
              </div>
              <ul>
                {linked.map((w) => (
                  <WorktreeManagerRow key={w.path} repoPath={repo.path} info={w} onRemoved={load} />
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function WorktreeManagerRow({
  repoPath,
  info,
  onRemoved,
}: {
  repoPath: string;
  info: GitWorktreeInfo;
  onRemoved: () => void;
}) {
  const { t } = useI18n();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [force, setForce] = useState(false);
  const [exportPatch, setExportPatch] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when removal succeeded but the generated mcode/* branch was unmerged
  // and therefore RETAINED — the dialog stays open showing where the
  // discarded commits live instead of closing silently.
  const [retained, setRetained] = useState<string | null>(null);

  const handleRemove = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.git.worktreeRemove({
        repoPath,
        worktreePath: info.path,
        force,
        exportPatch,
      });
      if (!res.ok) {
        setError(res.error ?? t("chat.worktree.removeFailed"));
        return;
      }
      if (res.retainedBranch) {
        setRetained(res.retainedBranch);
        return;
      }
      setConfirmOpen(false);
      onRemoved();
    } finally {
      setBusy(false);
    }
  };

  // Cleanup-priority badges: merged > orphan > dirty — anything that makes
  // the row safe (or unsafe) to delete deserves a glance-level signal.
  const badge = info.missing
    ? { text: t("chat.worktree.badgeMissing"), cls: "text-danger" }
    : info.merged
      ? { text: t("chat.worktree.badgeMerged"), cls: "text-accent" }
      : info.referencedBy === 0
        ? { text: t("chat.worktree.badgeOrphan"), cls: "text-warning" }
        : info.dirty
          ? { text: t("chat.worktree.badgeDirty"), cls: "text-warning" }
          : null;

  return (
    <li className="group flex items-center gap-1.5 px-2 py-1.5 hover:bg-surface-hover/50">
      <IconGitFork size={11} className="shrink-0 text-content-subtle" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-xs text-content" title={info.path}>
            {basename(info.path)}
          </span>
          {info.branch ? (
            // Branch-style worktree: the generated ref IS the work's name —
            // show it ahead of the abbreviated SHA (detached rows show the
            // SHA alone, as before).
            <span
              className="flex shrink-0 items-center gap-0.5 font-mono text-[10px] text-content-subtle"
              title={info.branch}
            >
              <IconGitBranch size={10} className="shrink-0" />
              {info.branch}
            </span>
          ) : (
            <span className="shrink-0 font-mono text-[10px] text-content-subtle">{info.head}</span>
          )}
          {badge && (
            <span className={cn("shrink-0 text-[10px]", badge.cls)}>{badge.text}</span>
          )}
          {info.referencedBy > 0 && (
            <span
              className="shrink-0 text-[10px] text-content-subtle"
              title={t("chat.worktree.badgeRefTitle")}
            >
              ×{info.referencedBy}
            </span>
          )}
        </div>
        <div className="truncate text-[10px] text-content-subtle" title={info.path}>
          {info.path}
        </div>
      </div>
      <button
        type="button"
        onClick={() => {
          setError(null);
          setForce(false);
          setConfirmOpen(true);
        }}
        className="flex shrink-0 items-center rounded p-1 text-content-subtle opacity-0 transition-colors hover:bg-surface-muted hover:text-danger group-hover:opacity-100"
        title={t("common.delete")}
      >
        <IconTrash size={12} />
      </button>

      {/* Remove confirm: dirty trees get the force + patch-export options. */}
      <Dialog.Root
        open={confirmOpen}
        onOpenChange={(o) => {
          if (!o && !busy) {
            setConfirmOpen(false);
            // Closing after a retained-branch removal still refreshes the
            // list — the worktree itself is gone either way.
            if (retained) {
              setRetained(null);
              onRemoved();
            }
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Backdrop />
          <Dialog.Popup className="w-[420px] max-w-[90vw] p-4">
            <div className="flex items-start gap-3 pr-6">
              <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-danger/10 text-danger">
                <IconAlertTriangle size={16} />
              </span>
              <div className="min-w-0 flex-1">
                <Dialog.Title>{t("chat.worktree.removeQ")}</Dialog.Title>
                <Dialog.Description className="mt-1">
                  {t("chat.worktree.removeDesc", { path: info.path })}
                </Dialog.Description>
                {retained && (
                  <div className="mt-2 flex items-start gap-1.5 rounded border border-warning/30 bg-warning/10 px-2 py-1.5 text-[11px] text-warning">
                    <IconGitBranch size={12} className="mt-0.5 shrink-0" />
                    <span className="break-words">
                      {t("chat.worktree.retainedBranch", { branch: retained })}
                    </span>
                  </div>
                )}
                {/* Remove confirm. The patch-export option appears for dirty
                    trees AND clean-but-unmerged ones (committed work dies
                    with the directory too, and a detached HEAD leaves no ref
                    behind); force only concerns uncommitted changes. */}
                {!retained && (info.dirty || !info.merged) && (
                  <div className="mt-2.5 space-y-1.5">
                    {(info.dirty || !info.merged) && (
                      <label className="flex items-center gap-1.5 text-xs text-content-muted">
                        <input
                          type="checkbox"
                          checked={exportPatch}
                          onChange={(e) => setExportPatch(e.target.checked)}
                          className="accent-accent"
                        />
                        {t("chat.worktree.exportPatch")}
                      </label>
                    )}
                    {info.dirty && (
                      <label className="flex items-center gap-1.5 text-xs text-content-muted">
                        <input
                          type="checkbox"
                          checked={force}
                          onChange={(e) => setForce(e.target.checked)}
                          className="accent-accent"
                        />
                        {t("chat.worktree.forceRemove")}
                      </label>
                    )}
                  </div>
                )}
                {error && (
                  <div className="mt-2 flex items-start gap-1.5 rounded border border-danger/30 bg-danger/10 px-2 py-1.5 text-[11px] text-danger">
                    <IconAlertTriangle size={12} className="mt-0.5 shrink-0" />
                    <span className="break-words">{error}</span>
                  </div>
                )}
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setConfirmOpen(false)} disabled={busy}>
                {t(retained ? "common.close" : "common.cancel")}
              </Button>
              {!retained && (
                <Button variant="danger" size="sm" onClick={handleRemove} disabled={busy}>
                  {busy ? <IconLoader2 size={12} className="animate-spin" /> : <IconTrash size={12} />}
                  {t("common.delete")}
                </Button>
              )}
            </div>
            <Dialog.Close />
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </li>
  );
}
