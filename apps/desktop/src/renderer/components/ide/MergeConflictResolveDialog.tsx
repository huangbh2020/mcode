/**
 * AI merge-conflict resolution dialog, shared by every surface that can land
 * the repo in a merge-conflict state:
 *
 *  - `GitRepoCard` (pull / branch-merge results),
 *  - `WorktreeMergeBackDialog` (merge-back of an isolated worktree).
 *
 * The backend (`git.resolveConflicts`) self-discovers the unmerged set from
 * the repo's merge state — the `conflictedFiles` prop is display-only. Two
 * escape hatches ride along: "abort merge" (git merge --abort) and "handle
 * manually later". On AI success the repo stays in the merging state with
 * everything staged — the caller's `onResolved` decides how the user finishes
 * the merge commit (GitRepoCard pre-fills its commit box; the merge-back
 * dialog offers a dedicated finish button).
 */
import { useState } from "react";
import { api } from "@renderer/lib/api.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { Button, Dialog } from "@renderer/components/ui/index.js";
import { IconAlertTriangle, IconLoader2, IconSparkles, IconX } from "@renderer/lib/icons.js";
import { useI18n } from "@renderer/lib/i18n/index.js";

export function MergeConflictResolveDialog({
  open,
  onOpenChange,
  repoPath,
  conflictedFiles,
  source,
  branch,
  onResolved,
  onAborted,
  onError,
  onAbortError,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The repo that is mid-merge — conflict resolution and abort run here. */
  repoPath: string;
  conflictedFiles: string[];
  /** Where the conflicts came from, so the description words it correctly:
   *  "merge" = merging `branch` in; "pull" = after a fetch-merge; "state" =
   *  the repo was found mid-merge (e.g. a previous dialog was dismissed). */
  source: "pull" | "merge" | "state";
  /** Source branch name for `source: "merge"` descriptions. */
  branch?: string | null;
  /** AI resolution succeeded — conflicts staged, merge commit still pending. */
  onResolved?: (resolvedCount: number) => void;
  /** The user aborted the merge; the repo is back at its pre-merge state. */
  onAborted?: () => void;
  /** AI-resolution failure — shown inline AND handed to the caller. */
  onError?: (message: string) => void;
  /** Merge-abort failure, kept separate so callers can log/classify the op
   *  (GitRepoCard's operation log distinguishes mergeAbort entries). */
  onAbortError?: (message: string) => void;
}) {
  const { t } = useI18n();
  const [resolving, setResolving] = useState(false);
  // "放弃合并" (git merge --abort) in-flight flag.
  const [aborting, setAborting] = useState(false);
  // Last failure from either action, rendered inline (the dialog stays open
  // so the user can retry or take the abort escape hatch).
  const [actionError, setActionError] = useState<string | null>(null);
  const conflictResolveModel = useSessionStore((s) => s.conflictResolveModel);

  // Resolve the merge conflicts via AI. Reads the conflict-resolution model
  // from settings (stored as "configId:roleKey" — split it back, mirroring
  // CommitBox's commitGenModel handling), asks the backend to resolve every
  // conflicted file, then hands the outcome to the caller.
  const handleResolveConflicts = async () => {
    let customModelId: string | null = null;
    let customModelRole: string | null = null;
    if (conflictResolveModel) {
      const colonIdx = conflictResolveModel.lastIndexOf(":");
      if (colonIdx > 0) {
        customModelId = conflictResolveModel.slice(0, colonIdx);
        customModelRole = conflictResolveModel.slice(colonIdx + 1);
      } else {
        customModelId = conflictResolveModel;
      }
    }
    setResolving(true);
    setActionError(null);
    try {
      const res = await api.git.resolveConflicts({
        repoPath,
        customModelId,
        customModelRole,
      });
      if (res.ok) {
        onOpenChange(false);
        onResolved?.(res.resolvedFiles?.length ?? 0);
      } else {
        const msg = res.error ?? t("ide.git.resolveFailed");
        setActionError(msg);
        onError?.(msg);
      }
    } catch {
      const msg = t("ide.git.resolveFailed");
      setActionError(msg);
      onError?.(msg);
    } finally {
      setResolving(false);
    }
  };

  const handleMergeAbort = async () => {
    setAborting(true);
    setActionError(null);
    try {
      const res = await api.git.mergeAbort({ repoPath });
      if (res.ok) {
        onOpenChange(false);
        onAborted?.();
      } else {
        const msg = res.error ?? t("ide.git.mergeAbortFailed");
        setActionError(msg);
        onAbortError?.(msg);
      }
    } catch {
      const msg = t("ide.git.mergeAbortFailed");
      setActionError(msg);
      onAbortError?.(msg);
    } finally {
      setAborting(false);
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        // In-flight resolution/abort must not be dismissed mid-call.
        if (!o && (resolving || aborting)) return;
        onOpenChange(o);
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Popup className="w-[400px] max-w-[90vw] p-4">
          <div className="flex items-start gap-3 pr-6">
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-warning/10 text-warning">
              <IconAlertTriangle size={16} />
            </span>
            <div className="min-w-0 flex-1">
              <Dialog.Title>{t("ide.git.conflictTitle")}</Dialog.Title>
              <Dialog.Description className="mt-1">
                {source === "merge" && branch
                  ? t("ide.git.conflictDescMerge", {
                      source: branch,
                      n: conflictedFiles.length,
                    })
                  : source === "pull"
                    ? t("ide.git.conflictDesc", { n: conflictedFiles.length })
                    : t("ide.git.conflictDescState", { n: conflictedFiles.length })}
              </Dialog.Description>
              {conflictedFiles.length > 0 && (
                <div className="mt-2 max-h-28 overflow-y-auto rounded-md border border-edge bg-surface-muted px-2 py-1.5">
                  <ul className="space-y-0.5">
                    {conflictedFiles.slice(0, 20).map((f) => (
                      <li key={f} className="truncate font-mono text-[11px] text-content-muted" title={f}>
                        {f}
                      </li>
                    ))}
                    {conflictedFiles.length > 20 && (
                      <li className="text-[11px] text-content-subtle">
                        {t("ide.git.conflictMore", { n: conflictedFiles.length - 20 })}
                      </li>
                    )}
                  </ul>
                </div>
              )}
              {/* No default model for AI resolution — surface the missing
                  config instead of letting the call fail after the fact. */}
              {!conflictResolveModel && (
                <p className="mt-2 text-[11px] text-warning">{t("ide.git.resolveNoModel")}</p>
              )}
              {actionError && (
                <p className="mt-2 break-words text-[11px] text-danger">{actionError}</p>
              )}
            </div>
          </div>
          <div className="mt-4 flex items-center justify-between gap-2">
            {/* Escape hatch: unwind the whole merge back to the pre-merge
                state (git merge --abort). One click, no terminal needed. */}
            <Button
              variant="danger"
              size="sm"
              onClick={() => void handleMergeAbort()}
              disabled={resolving || aborting}
            >
              {aborting ? <IconLoader2 size={12} className="animate-spin" /> : <IconX size={12} />}
              {t("ide.git.mergeAbort")}
            </Button>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={resolving}>
                {t("ide.git.resolveLater")}
              </Button>
              <Button
                size="sm"
                onClick={() => void handleResolveConflicts()}
                disabled={resolving || !conflictResolveModel}
              >
                {resolving ? <IconLoader2 size={12} className="animate-spin" /> : <IconSparkles size={12} />}
                {t("ide.git.resolveWithAi")}
              </Button>
            </div>
          </div>
          <Dialog.Close />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
