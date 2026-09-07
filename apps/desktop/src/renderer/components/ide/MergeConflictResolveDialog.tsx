/**
 * Merge-conflict resolution dialog, shared by every surface that can land
 * the repo in a merge-conflict state:
 *
 *  - `GitRepoCard` (pull / branch-merge results),
 *  - `WorktreeMergeBack` (merge-back of an isolated worktree).
 *
 * "用 AI 解决" opens a NEW Mcode session (bound to the project that owns the
 * repo) whose kickoff prompt asks the agent to resolve the conflicted files
 * and stage them — the work happens visibly in that conversation instead of
 * a hidden background query. The merge commit stays with the user. Two
 * escape hatches ride along: "abort merge" (git merge --abort) and "handle
 * manually later".
 */
import { useState } from "react";
import { api } from "@renderer/lib/api.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { Button, Dialog } from "@renderer/components/ui/index.js";
import { IconAlertTriangle, IconLoader2, IconSparkles, IconX } from "@renderer/lib/icons.js";
import { useI18n } from "@renderer/lib/i18n/index.js";

/** Nearest project whose root contains `repoPath`. The repo originally came
 *  from that project's discoverRepos scan, so a match always exists in
 *  practice; longest root wins (nested repos). */
function findProjectIdForRepo(
  repoPath: string,
  projects: { id: string; path: string }[],
): string | null {
  const norm = (p: string) => p.replace(/[\\/]+$/, "");
  const target = norm(repoPath);
  let best: { id: string; len: number } | null = null;
  for (const p of projects) {
    const root = norm(p.path);
    if (target === root || target.startsWith(root + "/") || target.startsWith(root + "\\")) {
      if (!best || root.length > best.len) best = { id: p.id, len: root.length };
    }
  }
  return best?.id ?? null;
}

/** Kickoff prompt for the resolution session. The file list is a snapshot
 *  from click time — the agent re-probes the live unmerged set itself. */
function buildConflictPrompt(repoPath: string, snapshotFiles: string[]): string {
  const fileList = snapshotFiles.map((f) => `- ${f}`).join("\n");
  return [
    `解决 git 仓库 ${repoPath} 的合并冲突。该仓库当前处于合并进行中状态(存在 MERGE_HEAD)。触发「用 AI 解决」时检测到的冲突文件:`,
    fileList || "(未列出)",
    "",
    "请按以下步骤处理:",
    `1. 运行 git -C ${repoPath} diff --name-only --diff-filter=U 获取当前实际的冲突文件列表(以上仅为快照,以实际结果为准)。`,
    "2. 逐个打开冲突文件,阅读 <<<<<<< / ======= / >>>>>>> 标记两侧的改动,结合语义给出正确的合并结果——保留双方有意义的修改,不要机械地只取一边。",
    "3. 编辑文件,移除全部冲突标记,确保内容完整、语法正确。",
    "4. 全部解决后用 git add 将这些文件写入暂存区。",
    "5. 不要执行 git commit——合并提交由用户检查后自行完成;也不要执行 git merge --abort。",
    "6. 某个冲突若无法确定正确结果,保留该文件的冲突标记、不要 git add 它,并在回复中说明原因。",
    "最后逐一总结每个文件的处理结果。",
  ].join("\n");
}

export function MergeConflictResolveDialog({
  open,
  onOpenChange,
  repoPath,
  conflictedFiles,
  source,
  branch,
  onKickoff,
  onAborted,
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
  /** The resolution session was kicked off — the dialog has closed; callers
   *  can refresh their view of the (still mid-merge) repo. */
  onKickoff?: () => void;
  /** The user aborted the merge; the repo is back at its pre-merge state. */
  onAborted?: () => void;
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
  // Optional dedicated model (Settings → Git) — seeds the resolution
  // session's config. Stored as "configId:roleKey".
  const conflictResolveModel = useSessionStore((s) => s.conflictResolveModel);

  // Resolve the merge conflicts in a NEW session: create a session bound to
  // the project that owns the repo, then send it a kickoff prompt describing
  // the conflict. The agent works visibly in that conversation (edits +
  // git add); the merge commit stays with the user.
  const handleResolveWithSession = async () => {
    setResolving(true);
    setActionError(null);
    try {
      const store = useSessionStore.getState();
      const projectId = findProjectIdForRepo(repoPath, store.projects);
      if (!projectId) {
        setActionError(t("ide.git.resolveNoProject"));
        return;
      }
      let overrides: Parameters<typeof store.startSession>[1] = { envMode: "local" };
      if (conflictResolveModel) {
        const colonIdx = conflictResolveModel.lastIndexOf(":");
        overrides = {
          providerId: "claude-sdk",
          customModelId:
            colonIdx > 0 ? conflictResolveModel.slice(0, colonIdx) : conflictResolveModel,
          model: colonIdx > 0 ? conflictResolveModel.slice(colonIdx + 1) : undefined,
          envMode: "local",
        };
      }
      await store.startSession(projectId, overrides);
      const sessionId = useSessionStore.getState().activeSessionId;
      if (!sessionId) throw new Error(t("ide.git.resolveFailed"));
      const sent = await store.sendPrompt(
        buildConflictPrompt(repoPath, conflictedFiles),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        sessionId,
      );
      // false = the store's send-time guard fired (e.g. no model configured —
      // it raises its own guiding toast). Keep the dialog open for a retry.
      if (!sent) return;
      onOpenChange(false);
      onKickoff?.();
    } catch (err) {
      setActionError((err as Error).message || t("ide.git.resolveFailed"));
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
              {/* Resolution opens a real session — the agent works visibly
                  in that conversation, edits the files and stages them; the
                  merge commit stays with the user. */}
              <p className="mt-2 text-[11px] text-content-subtle">
                {t("ide.git.resolveOpenSession")}
              </p>
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
                onClick={() => void handleResolveWithSession()}
                disabled={resolving}
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
