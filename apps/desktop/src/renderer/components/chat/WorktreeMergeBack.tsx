/**
 * Worktree merge-back UI, shared by its two entry points:
 *
 *  - `WorktreeMergeToolbarButton` — the top-toolbar (Titlebar) button for the
 *    ACTIVE session. Shown ONLY while the session runs in a materialized
 *    worktree AND that worktree has unmerged work (dirty files or commits
 *    not yet contained in the local branch) — a clean, fully-merged worktree
 *    renders nothing. State is re-probed on session/worktree change, on a
 *    slow interval (12s — cheap porcelain + status calls), and whenever the
 *    dialog closes (a merge/removal may have just cleared the work).
 *
 *  - `WorktreeMergeBackDialog` — the preview → confirm → merge flow, also
 *    mounted by the left bar's worktree group context menu (all sessions of
 *    a directory share ONE checkout, so a single merge covers every thread
 *    in the group).
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { normWorktreeKey } from "@renderer/lib/worktree.js";
import type { GitMergePreviewResult, GitWorktreeInfo } from "@contracts/ipc";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useSuppressBrowserView } from "@renderer/hooks/useSuppressBrowserView.js";
import { Button, Dialog, Input } from "@renderer/components/ui/index.js";
import {
  IconGitMerge,
  IconGitBranch,
  IconLoader2,
  IconAlertTriangle,
  IconCheck,
  IconTrash,
  IconSparkles,
} from "@renderer/lib/icons.js";
import { useI18n } from "@renderer/lib/i18n/index.js";

/* ───────────────────────── toolbar button ───────────────────────── */

export function WorktreeMergeToolbarButton() {
  const { t } = useI18n();
  const projects = useSessionStore((s) => s.projects);
  // The ACTIVE session (Titlebar scope — one button, foreground thread).
  const session = useSessionStore((s) => {
    const id = s.activeSessionId;
    if (!id) return undefined;
    return (
      s.sessions.find((x) => x.id === id) ??
      s.pinnedSessions.find((x) => x.id === id) ??
      (() => {
        for (const list of Object.values(s.sessionsByProject)) {
          const hit = list?.find((x) => x.id === id);
          if (hit) return hit;
        }
        return undefined;
      })()
    );
  });

  const worktreePath = session?.worktreePath ?? null;
  const repoPath = projects.find((p) => p.id === session?.projectId)?.path ?? null;

  const [open, setOpen] = useState(false);
  useSuppressBrowserView(open);
  const [hasChanges, setHasChanges] = useState(false);

  const refresh = useCallback(async () => {
    if (!repoPath || !worktreePath) {
      setHasChanges(false);
      return;
    }
    try {
      // Single-tree probe (worktreeStatus), NOT worktreeList: the list
      // enriches EVERY linked tree with its own `git status` child process,
      // and this runs on a 12s interval — the poller must only ever pay for
      // the one tree it cares about.
      const { status } = await api.git.worktreeStatus({ repoPath, worktreePath });
      // "Has work" = uncommitted files OR commits not contained in the main
      // HEAD (worktreeStatus's `merged` flag is the ancestor probe).
      setHasChanges(!!status && (status.dirty || !status.merged));
    } catch {
      setHasChanges(false);
    }
  }, [repoPath, worktreePath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (!worktreePath) return;
    const timer = setInterval(() => {
      if (document.hidden) return; // no git probing while the window is hidden
      void refresh();
    }, 12_000);
    return () => clearInterval(timer);
  }, [worktreePath, refresh]);

  if (!repoPath || !worktreePath || !hasChanges) return null;

  return (
    <>
      {/* Square icon button — same geometry as the terminal/panel toggles it
          sits between (rounded p-1.5, 18px icon). Accent tint signals "this
          session has work waiting to land"; the full explanation lives in
          the tooltip. */}
      <button
        onClick={() => setOpen(true)}
        className={cn(
          "flex shrink-0 items-center justify-center rounded p-1.5 transition-colors",
          "text-accent hover:bg-surface-hover",
        )}
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        title={t("chat.worktree.mergeBackTitle")}
      >
        <IconGitMerge size={18} className="shrink-0" />
      </button>
      <WorktreeMergeBackDialog
        open={open}
        onOpenChange={(o) => {
          if (!o) void refresh(); // a merge/removal may have cleared the work
          setOpen(o);
        }}
        sessionId={session?.id ?? null}
        worktreePath={worktreePath}
        repoPath={repoPath}
      />
    </>
  );
}

/* ───────────────────────── remove dialog ───────────────────────── */

/** Guarded worktree removal, shared by the left bar's group context menu
 *  (and available to other surfaces). Same safety rails as the Git panel's
 *  manager row: a dirty tree gets the patch-export and force checkboxes,
 *  failures surface inline, and `onRemoved` fires AFTER the IPC succeeds
 *  (the backend then degrades every referencing session back to local and
 *  broadcasts — the left bar's view fallback rides on that). */
export function WorktreeRemoveDialog({
  open,
  onOpenChange,
  repoPath,
  worktreePath,
  onRemoved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repoPath: string | null;
  worktreePath: string;
  onRemoved?: () => void;
}) {
  const { t } = useI18n();
  // "Exportable" = dirty OR carrying commits the main branch doesn't have —
  // both are work that dies with the directory (committed work on a detached
  // HEAD leaves no ref behind), so the patch option must appear for either.
  const [exportable, setExportable] = useState(false);
  // Dirty specifically — gates the force checkbox, which is about
  // uncommitted changes git's worktree remove would refuse to delete.
  const [dirty, setDirty] = useState(false);
  const [force, setForce] = useState(false);
  const [exportPatch, setExportPatch] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when removal succeeded but the generated mcode/* branch was unmerged
  // and therefore RETAINED — the dialog stays open showing where the
  // discarded commits live instead of closing silently.
  const [retained, setRetained] = useState<string | null>(null);

  // Probe lifecycle state on open so the force/patch options only appear
  // when they matter (single-tree probe — the backend matches the porcelain
  // path against ours with normalization, so no renderer-side matching).
  useEffect(() => {
    if (!open) {
      setError(null);
      setForce(false);
      setExportPatch(true);
      setBusy(false);
      setRetained(null);
      return;
    }
    if (!repoPath) return;
    let cancelled = false;
    api.git
      .worktreeStatus({ repoPath, worktreePath })
      .then(({ status }) => {
        if (cancelled) return;
        setDirty(!!status?.dirty);
        setExportable(!!status && (status.dirty || !status.merged));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, repoPath, worktreePath]);

  const handleRemove = async () => {
    if (busy || !repoPath) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.git.worktreeRemove({ repoPath, worktreePath, force, exportPatch });
      if (!res.ok) {
        setError(res.error ?? t("chat.worktree.removeFailed"));
        return;
      }
      if (res.retainedBranch) {
        setRetained(res.retainedBranch);
        return;
      }
      onOpenChange(false);
      onRemoved?.();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o && !busy) onOpenChange(false);
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
                {t("chat.worktree.removeDesc", { path: worktreePath })}
              </Dialog.Description>
              {retained && (
                <div className="mt-2 flex items-start gap-1.5 rounded border border-warning/30 bg-warning/10 px-2 py-1.5 text-[11px] text-warning">
                  <IconGitBranch size={12} className="mt-0.5 shrink-0" />
                  <span className="break-words">
                    {t("chat.worktree.retainedBranch", { branch: retained })}
                  </span>
                </div>
              )}
              {!retained && (exportable || dirty) && (
                <div className="mt-2.5 space-y-1.5">
                  {exportable && (
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
                  {dirty && (
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
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
              {t(retained ? "common.close" : "common.cancel")}
            </Button>
            {!retained && (
              <Button variant="danger" size="sm" onClick={() => void handleRemove()} disabled={busy}>
                {busy ? <IconLoader2 size={12} className="animate-spin" /> : <IconTrash size={12} />}
                {t("chat.worktree.removeWt")}
              </Button>
            )}
          </div>
          <Dialog.Close />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* ───────────────────────── merge-back dialog ───────────────────────── */

/** "Merge the isolated work back" flow: preview (incoming commits / ff /
 *  up-to-date) → confirm → merge (server auto-commits uncommitted changes
 *  first) → done state offering worktree removal. Conflicts surface inline
 *  with a pointer to the Git panel's conflict tooling; the worktree is kept
 *  so the user can resolve and retry. */
export function WorktreeMergeBackDialog({
  open,
  onOpenChange,
  sessionId,
  worktreePath,
  repoPath,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string | null;
  worktreePath: string;
  repoPath: string | null;
}) {
  void sessionId; // reserved (future: per-session result phrasing)
  const { t } = useI18n();
  const [info, setInfo] = useState<GitWorktreeInfo | null>(null);
  // The MAIN worktree's current branch — the merge-back target, stated in
  // the dialog so the direction is unambiguous.
  const [mainBranch, setMainBranch] = useState<string>("");
  const [preview, setPreview] = useState<GitMergePreviewResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Result state: null = not merged yet; otherwise the merge outcome.
  const [done, setDone] = useState<{
    targetBranch: string;
    fastForward: boolean;
  } | null>(null);
  const [conflictFiles, setConflictFiles] = useState<string[] | null>(null);
  const [removing, setRemoving] = useState(false);
  // Pre-merge auto-commit message for the worktree's uncommitted changes.
  // Seeded with the built-in default so the user sees (and can edit) exactly
  // what will land in the log; a blank input falls back to the same default
  // server-side.
  const [commitMessage, setCommitMessage] = useState("");
  // AI generation state — same model/prompt settings the Git panel's commit
  // box uses, fed the worktree's WHOLE uncommitted diff (scope: "worktree").
  const [generating, setGenerating] = useState(false);
  const commitGenModel = useSessionStore((s) => s.commitGenModel);
  const commitGenPrompt = useSessionStore((s) => s.commitGenPrompt);

  const handleGenerateMessage = async () => {
    if (generating) return;
    // commitGenModel is stored as "configId:roleKey" — split it back
    // (mirrors GitRepoCard's commit-box parsing).
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
    if (!customModelId) {
      setError(t("chat.worktree.genCommitNoModel"));
      return;
    }
    setGenerating(true);
    setError(null);
    try {
      // The generation anchors on the WORKTREE path (its guard accepts
      // managed worktree roots) and diffs the whole working tree vs HEAD.
      const res = await api.git.generateCommitMessage({
        repoPath: worktreePath,
        customModelId,
        customModelRole,
        prompt: commitGenPrompt ?? "",
        scope: "worktree",
      });
      if (res.ok && res.message) setCommitMessage(res.message);
      else setError(res.error ?? t("chat.worktree.genCommitFailed"));
    } catch (err) {
      setError((err as Error).message || t("chat.worktree.genCommitFailed"));
    } finally {
      setGenerating(false);
    }
  };

  const load = useCallback(async () => {
    if (!repoPath) return;
    setError(null);
    setDone(null);
    setConflictFiles(null);
    setInfo(null);
    setPreview(null);
    setMainBranch("");
    // Starts EMPTY: the input's placeholder describes the backend's built-in
    // default, and a blank submit falls back to that same default server-side
    // — the exact string lives in ONE place (worktreeOps autoCommitMessage),
    // never duplicated here.
    setCommitMessage("");
    setPreviewLoading(true);
    try {
      const { worktrees } = await api.git.worktreeList({ repoPath });
      setMainBranch(worktrees.find((w) => w.main)?.branch ?? "");
      // Match by NORMALIZED path: git's porcelain echoes the worktree path in
      // its own surface form (forward slashes on win32) while the DB stores
      // the `path.join` form (backslashes) — strict equality never matches,
      // `mine` comes back null, and the preview silently degrades to the
      // "cannot read merge info" fallback.
      const target = normWorktreeKey(worktreePath);
      const mine = worktrees.find((w) => normWorktreeKey(w.path) === target) ?? null;
      setInfo(mine);
      if (mine?.head) {
        api.git
          .mergePreview({ repoPath, source: mine.head })
          .then(setPreview)
          .catch((err) => {
            // Surface the real failure instead of the generic fallback copy.
            setPreview(null);
            setError((err as Error).message || null);
          })
          .finally(() => setPreviewLoading(false));
      } else {
        setPreviewLoading(false);
      }
    } catch (err) {
      setError((err as Error).message);
      setPreviewLoading(false);
    }
  }, [repoPath, worktreePath]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  // "Work to merge" = new commits OR uncommitted worktree changes (the
  // backend auto-commits a dirty worktree before merging). `upToDate` only
  // means "no new COMMITS" — rev-list cannot see uncommitted file changes,
  // so a dirty worktree must stay mergeable even when upToDate.
  const hasWork = (!!preview?.ok && !preview.upToDate) || !!info?.dirty;
  const canMerge =
    !!info?.head && !busy && !done && !conflictFiles && preview?.ok && hasWork;

  const handleMerge = async () => {
    if (!repoPath || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.git.worktreeMergeBack({
        repoPath,
        worktreePath,
        // Blank input → undefined-ish (trim'd server-side) → the backend's
        // built-in default message.
        message: commitMessage.trim() || undefined,
      });
      if (!res.ok) {
        setError(res.error ?? t("ide.git.mergeFailed"));
      } else if (res.conflict) {
        setConflictFiles(res.conflictedFiles ?? []);
      } else {
        setDone({ targetBranch: res.targetBranch ?? "?", fastForward: !!res.fastForward });
      }
    } catch (err) {
      setError((err as Error).message ?? t("ide.git.mergeFailed"));
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async () => {
    if (!repoPath || removing) return;
    setRemoving(true);
    setError(null);
    try {
      // After a successful merge the worktree is clean — plain remove.
      const res = await api.git.worktreeRemove({ repoPath, worktreePath });
      if (!res.ok) {
        setError(res.error ?? t("chat.worktree.removeFailed"));
        return;
      }
      onOpenChange(false);
    } finally {
      setRemoving(false);
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o && !busy && !removing) onOpenChange(false);
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Popup className="w-[420px] max-w-[90vw] p-4">
          <div className="flex items-start gap-3 pr-6">
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/10 text-accent">
              <IconGitMerge size={16} />
            </span>
            <div className="min-w-0 flex-1">
              <Dialog.Title>{t("chat.worktree.mergeBackQ")}</Dialog.Title>
              <Dialog.Description className="mt-1">
                {t("chat.worktree.mergeBackDesc", {
                  target: done?.targetBranch || mainBranch || "HEAD",
                })}
              </Dialog.Description>
              <div className="mt-2 space-y-1 text-[11px]">
                {previewLoading ? (
                  <div className="flex items-center gap-1.5 text-content-subtle">
                    <IconLoader2 size={12} className="animate-spin" />
                    {t("common.loading")}
                  </div>
                ) : done ? (
                  <div className="flex items-start gap-1.5">
                    <IconCheck size={12} className="mt-0.5 shrink-0 text-accent" />
                    <span className="text-content-muted">
                      {t("chat.worktree.mergeDone", { target: done.targetBranch })}
                      {t("chat.worktree.mergeDoneHint")}
                    </span>
                  </div>
                ) : conflictFiles ? (
                  <div className="flex items-start gap-1.5 text-warning">
                    <IconAlertTriangle size={12} className="mt-0.5 shrink-0" />
                    <span className="break-words">
                      {t("chat.worktree.mergeConflict", { n: conflictFiles.length })}
                    </span>
                  </div>
                ) : preview?.ok ? (
                  preview.upToDate && !info?.dirty ? (
                    // Truly nothing to do: no new commits AND a clean
                    // worktree. rev-list only counts commits — "upToDate"
                    // alone must NOT read as "nothing to merge" when the
                    // worktree still holds uncommitted file changes.
                    <div className="flex items-center gap-1.5 text-content-subtle">
                      <IconCheck size={12} className="shrink-0 text-accent" />
                      {t("chat.worktree.mergeUpToDate")}
                    </div>
                  ) : (
                    <>
                      {!preview.upToDate && (
                        <div className="flex items-center gap-1.5 text-content-muted">
                          <IconCheck size={12} className="shrink-0 text-content-subtle" />
                          {t("chat.worktree.mergeIncoming", { n: preview.incomingCommits })}
                        </div>
                      )}
                      {info?.dirty && (
                        <div className="flex items-start gap-1.5 text-warning">
                          <IconAlertTriangle size={12} className="mt-0.5 shrink-0" />
                          {t("chat.worktree.wtDirty")}
                        </div>
                      )}
                    </>
                  )
                ) : (
                  <div className="flex items-start gap-1.5 text-danger">
                    <IconAlertTriangle size={12} className="mt-0.5 shrink-0" />
                    <span className="break-words">
                      {preview?.error ?? t("chat.worktree.previewFailed")}
                    </span>
                  </div>
                )}
                {error && (
                  <div className="flex items-start gap-1.5 text-danger">
                    <IconAlertTriangle size={12} className="mt-0.5 shrink-0" />
                    <span className="break-words">{error}</span>
                  </div>
                )}
              </div>
              {/* Editable commit message for the auto-commit — only relevant
                  while the worktree is dirty and nothing has landed yet.
                  The sparkles generate one from the worktree's uncommitted
                  diff via the same model the Git panel's commit box uses. */}
              {info?.dirty && !done && !conflictFiles && (
                <div className="mt-3">
                  <div className="text-[11px] text-content-subtle">
                    {t("chat.worktree.commitMsgLabel")}
                  </div>
                  <div className="mt-1 flex items-center gap-1.5">
                    <Input
                      value={commitMessage}
                      onChange={(e) => setCommitMessage((e.target as HTMLInputElement).value)}
                      placeholder={t("chat.worktree.commitMsgPlaceholder", {
                        name: worktreePath.split(/[\\/]/).pop() ?? "worktree",
                      })}
                      className="min-w-0 flex-1 text-xs"
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void handleGenerateMessage()}
                      disabled={generating}
                      title={t("chat.worktree.genCommit")}
                    >
                      {generating ? (
                        <IconLoader2 size={12} className="animate-spin" />
                      ) : (
                        <IconSparkles size={12} />
                      )}
                      {t("chat.worktree.genCommit")}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            {done ? (
              <>
                <Button variant="danger" size="sm" onClick={handleRemove} disabled={removing}>
                  {removing ? (
                    <IconLoader2 size={12} className="animate-spin" />
                  ) : (
                    <IconTrash size={12} />
                  )}
                  {t("chat.worktree.removeWt")}
                </Button>
                <Button size="sm" onClick={() => onOpenChange(false)}>
                  {t("chat.worktree.keepWt")}
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onOpenChange(false)}
                  disabled={busy || removing}
                >
                  {t("common.cancel")}
                </Button>
                <Button size="sm" onClick={handleMerge} disabled={!canMerge}>
                  {busy ? (
                    <IconLoader2 size={12} className="animate-spin" />
                  ) : (
                    <IconGitMerge size={12} />
                  )}
                  {t("ide.git.merge")}
                </Button>
              </>
            )}
          </div>
          <Dialog.Close />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
