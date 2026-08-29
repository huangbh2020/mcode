import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Menu } from "@base-ui/react/menu";
import { ContextMenu } from "@base-ui/react/context-menu";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { joinPath, basename } from "@renderer/lib/path.js";
import { formatRelativeTime, formatFullTime } from "@renderer/lib/time.js";
import { browserUuid } from "@renderer/lib/uuid.js";
import type { GitRepo, GitStatusResult, GitFileStatus, GitBranchInfo, GitBranchListResult, GitMergePreviewResult } from "@contracts/ipc";
import { EMPTY_TURN_FILES, useSessionStore } from "@renderer/stores/sessionStore.js";
import type { TurnFileEntry } from "@renderer/lib/turnFiles.js";
import { lineDiff, diffSummary } from "@renderer/lib/lineDiff.js";
import { Button, Dialog } from "@renderer/components/ui/index.js";
import {
  IconChevronDown,
  IconChevronRight,
  IconGitBranch,
  IconGitCommit,
  IconArrowUp,
  IconArrowDown,
  IconRefresh,
  IconLoader2,
  IconPlayerStop,
  IconAlertTriangle,
  IconCheck,
  IconDotsVertical,
  IconTrash,
  IconEye,
  IconPlus,
  IconMinus,
  IconSparkles,
  IconMaximize,
  IconList,
  IconCircleCheck,
  IconCircleXFilled,
  IconX,
  IconTag,
  IconGitMerge,
} from "@renderer/lib/icons.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";

/** A single git operation log entry - one per pull/push/commit/sync/etc. */
type GitOpLogEntry = {
  id: string;
  op: "pull" | "push" | "commit" | "sync" | "stage" | "unstage" | "discard" | "merge" | "mergeAbort";
  /** "success" for ok results, "failure" for !ok results or thrown exceptions. */
  status: "success" | "failure";
  /** Full error message (only for failures). Omitted for successes. */
  message?: string;
  /** Epoch milliseconds (`Date.now()`). */
  timestamp: number;
};

/** Message ids for each operation type, shown in the log list (rendered via
 *  `t()` so the label follows the UI locale). */
const OP_LABEL_KEYS: Record<GitOpLogEntry["op"], MessageId> = {
  pull: "ide.git.pull",
  push: "ide.git.push",
  commit: "ide.git.commit",
  sync: "ide.git.sync",
  stage: "ide.git.stage",
  unstage: "ide.git.unstage",
  discard: "ide.git.discard",
  merge: "ide.git.merge",
  mergeAbort: "ide.git.mergeAbort",
};

/** Max number of log entries kept per repo. Older entries are dropped. */
const MAX_LOG_ENTRIES = 20;

/** Monotonic counter for log entry ids (avoids Date.now() collisions when
 *  multiple entries are written within the same millisecond, e.g. sync). */
let logIdSeq = 0;

/**
 * One git repository's card in the Git panel. Layout (top to bottom):
 *
 *   Header: repo name + branch + ahead/behind + Pull/Push/Refresh
 *   已暂存 (staged) group  - [全部取消]
 *   Commit message input   - [提交 ▾] (commit / commit+push / commit+sync)
 *   更改 (unstaged) group   - [全部放弃] [全部暂存]
 *   操作日志 (operation log) - collapsible, recent N ops with full errors
 *
 * Clicking a file opens it in the CENTER editor's diff view (not inline).
 * Right-clicking a file shows a context menu (view source / discard changes).
 * Each file row shows a +/- diff tally badge (loaded async).
 *
 * All state is local to this card - multiple cards operate independently.
 */
export function GitRepoCard({ repo }: { repo: GitRepo }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<GitStatusResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<GitOpLogEntry[]>([]);
  const [commitMsg, setCommitMsg] = useState("");
  const [busy, setBusy] = useState<"push" | "pull" | "commit" | "merge" | null>(null);
  const [pendingDiscard, setPendingDiscard] = useState<string[] | null>(null);
  // Merge-conflict state: when a merge/pull produces conflicts we surface a
  // dialog offering AI resolution or aborting the merge. `conflictFiles`
  // doubles as the dialog's open trigger (null = closed). `conflictSource` /
  // `conflictBranch` describe where the conflicts came from so the dialog can
  // word itself correctly ("合并 feature-x 时…" vs "拉取后…").
  const [conflictFiles, setConflictFiles] = useState<string[] | null>(null);
  const [conflictSource, setConflictSource] = useState<"pull" | "merge">("pull");
  const [conflictBranch, setConflictBranch] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  // "放弃合并" (git merge --abort) in-flight flag for the conflict dialog.
  const [aborting, setAborting] = useState(false);
  // Branch picker state: the grouped branch/tag list (fetched on menu open),
  // a search filter, the in-flight checkout, and the "new branch" dialog.
  // The menu is CONTROLLED so the merge action can close it before opening
  // the confirm dialog (two stacked overlays would be confusing).
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const [branches, setBranches] = useState<GitBranchListResult | null>(null);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branchQuery, setBranchQuery] = useState("");
  const [checkingOut, setCheckingOut] = useState(false);
  const [newBranchOpen, setNewBranchOpen] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");
  // Branch-merge state: `mergeTarget` is the branch picked in the picker (a
  // non-null value opens the confirm dialog); `mergePreviewData` holds the
  // read-only preview (incoming commits / fast-forward / up-to-date) fetched
  // when the dialog opens, so the user knows what the merge will do BEFORE
  // confirming; `merging` is the in-flight merge itself.
  const [mergeTarget, setMergeTarget] = useState<GitBranchInfo | null>(null);
  const [mergePreviewLoading, setMergePreviewLoading] = useState(false);
  const [mergePreviewData, setMergePreviewData] = useState<GitMergePreviewResult | null>(null);
  const [merging, setMerging] = useState(false);
  const collapsedGitRepos = useSessionStore((s) => s.collapsedGitRepos);
  const toggleCollapsedGitRepo = useSessionStore((s) => s.toggleCollapsedGitRepo);
  const conflictResolveModel = useSessionStore((s) => s.conflictResolveModel);
  const collapsed = !!collapsedGitRepos[repo.path];

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { status } = await api.git.status({ repoPath: repo.path });
      setStatus(status);
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, [repo.path]);

  // Auto-refresh when the agent finishes a turn that touched files. The
  // model's Write/Edit may have created/modified files on disk, so the
  // working-tree status — and the "更改 (N)" / "已暂存 (N)" tallies — go
  // stale. `turn.files` fires once per turn and only when files.length > 0,
  // so this re-runs `git status` at most once per turn (no refresh storm).
  //
  // We track the last observed (sessionId, files) pair: a first observation
  // (mount, or a session switch) only seeds the tracker, and a refresh fires
  // only when the SAME active session's turnFiles reference changes — a fresh
  // turn.files payload, or the rewind that clears it. Session switches never
  // trigger a refresh (the card stays mounted across same-project sessions).
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const turnFiles = useSessionStore((s) =>
    activeSessionId ? (s.turnFilesBySession[activeSessionId] ?? EMPTY_TURN_FILES) : EMPTY_TURN_FILES,
  );
  const prevObserved = useRef<{ sessionId: string | null; files: TurnFileEntry[] | null | undefined }>({
    sessionId: null,
    files: undefined,
  });
  useEffect(() => {
    const prev = prevObserved.current;
    prevObserved.current = { sessionId: activeSessionId, files: turnFiles };
    if (prev.files === undefined) return; // first observation -> seed only
    if (prev.sessionId !== activeSessionId) return; // session switch -> seed only
    if (turnFiles !== prev.files) void refresh();
  }, [activeSessionId, turnFiles, refresh]);

  /** Prepend a log entry (newest first) and cap to MAX_LOG_ENTRIES. */
  const prependLog = useCallback(
    (entry: Omit<GitOpLogEntry, "id" | "timestamp">) => {
      const full: GitOpLogEntry = {
        ...entry,
        id: `log-${Date.now()}-${logIdSeq++}`,
        timestamp: Date.now(),
      };
      setLogs((prev) => [full, ...prev].slice(0, MAX_LOG_ENTRIES));
    },
    [],
  );

  /** Fetch the grouped branch/tag list for the picker. Called on menu open. */
  const loadBranches = useCallback(async () => {
    setBranchesLoading(true);
    setBranchQuery("");
    try {
      const { branches: list } = await api.git.listBranches({ repoPath: repo.path });
      setBranches(list);
    } catch {
      setBranches(null);
    } finally {
      setBranchesLoading(false);
    }
  }, [repo.path]);

  /** Check out a ref, then refresh. `newBranch` (when set) creates a local
   *  branch from the target first (tracking branch / new branch). */
  const handleCheckout = useCallback(
    async (branch: string, newBranch?: string) => {
      setCheckingOut(true);
      try {
        const res = await api.git.checkout({ repoPath: repo.path, branch, newBranch });
        if (!res.ok) {
          setError(res.error ?? t("ide.git.checkoutFailed"));
          prependLog({ op: "discard", status: "failure", message: res.error });
        } else {
          prependLog({ op: "discard", status: "success" });
        }
        await refresh();
      } catch (err) {
        const msg = (err as Error).message ?? t("ide.git.checkoutFailed");
        setError(msg);
        prependLog({ op: "discard", status: "failure", message: msg });
      } finally {
        setCheckingOut(false);
      }
    },
    [repo.path, refresh, prependLog, t],
  );

  /** Create a new branch from HEAD and switch to it. */
  const handleCreateBranch = useCallback(async () => {
    const name = newBranchName.trim();
    if (!name) return;
    setNewBranchOpen(false);
    setNewBranchName("");
    await handleCheckout("HEAD", name);
  }, [newBranchName, handleCheckout]);

  /** Open the merge confirm dialog for a branch (hover action in the branch
   *  picker). Closes the picker first so only one overlay is up, then fetches
   *  the read-only preview so the dialog can state what will happen. */
  const openMergeDialog = useCallback(
    (b: GitBranchInfo) => {
      setBranchMenuOpen(false);
      setMergeTarget(b);
      setMergePreviewLoading(true);
      setMergePreviewData(null);
      api.git
        .mergePreview({ repoPath: repo.path, source: b.name })
        .then((data) => setMergePreviewData(data))
        .catch(() => setMergePreviewData(null))
        .finally(() => setMergePreviewLoading(false));
    },
    [repo.path],
  );

  /** Merge `mergeTarget` into the current branch. Conflicts route into the
   *  same AI-resolution dialog pull uses (with an added "abort merge" escape
   *  hatch); success is logged and the card refreshed. */
  const handleMerge = async () => {
    if (!mergeTarget || merging) return;
    setMerging(true);
    setBusy("merge");
    setError(null);
    try {
      const res = await api.git.merge({ repoPath: repo.path, source: mergeTarget.name });
      if (!res.ok) {
        setError(res.error ?? t("ide.git.mergeFailed"));
        prependLog({ op: "merge", status: "failure", message: res.error });
      } else if (res.conflict && res.conflictedFiles && res.conflictedFiles.length > 0) {
        setConflictSource("merge");
        setConflictBranch(mergeTarget.name);
        setConflictFiles(res.conflictedFiles);
      } else {
        prependLog({ op: "merge", status: "success" });
      }
      setMergeTarget(null);
      await refresh();
    } catch (err) {
      const msg = (err as Error).message ?? t("ide.git.mergeFailed");
      setError(msg);
      prependLog({ op: "merge", status: "failure", message: msg });
    } finally {
      setMerging(false);
      setBusy(null);
    }
  };

  /** Abort an in-progress merge (`git merge --abort`), restoring the
   *  pre-merge working tree. The "undo" escape hatch in the conflict dialog —
   *  a merge that turned out to be a bad idea should be one click to undo,
   *  not a terminal command. */
  const handleMergeAbort = async () => {
    setAborting(true);
    setError(null);
    try {
      const res = await api.git.mergeAbort({ repoPath: repo.path });
      if (!res.ok) {
        setError(res.error ?? t("ide.git.mergeAbortFailed"));
        prependLog({ op: "mergeAbort", status: "failure", message: res.error });
      } else {
        prependLog({ op: "mergeAbort", status: "success" });
        setConflictFiles(null);
        await refresh();
      }
    } catch (err) {
      const msg = (err as Error).message ?? t("ide.git.mergeAbortFailed");
      setError(msg);
      prependLog({ op: "mergeAbort", status: "failure", message: msg });
    } finally {
      setAborting(false);
    }
  };

  /** Filtered branch groups for the search box (matches name or commit subject). */
  const filteredBranches = useMemo(() => {
    if (!branches) return null;
    const q = branchQuery.trim().toLowerCase();
    if (!q) return branches;
    const match = (b: GitBranchInfo) =>
      b.name.toLowerCase().includes(q) || b.label.toLowerCase().includes(q);
    return {
      current: branches.current,
      detached: branches.detached,
      local: branches.local.filter(match),
      remote: branches.remote.filter(match),
      tags: branches.tags.filter(match),
    };
  }, [branches, branchQuery]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Cross-client auto-refresh: the host broadcasts `git.changed` after ANY
  // client's git mutation (a paired phone's commit/pull, another repo card),
  // bumping this per-repo version in the store. Own mutations echo back too
  // — an idempotent extra refresh.
  const gitChangeVersion = useSessionStore(
    (s) => s.gitChangeVersionByRepo[repo.path] ?? 0,
  );
  useEffect(() => {
    void refresh();
  }, [gitChangeVersion, refresh]);

  // Split files into staged and unstaged groups.
  const staged = useMemo(
    () => status?.files.filter((f) => f.index !== "unmodified" && f.index !== "untracked") ?? [],
    [status],
  );
  const unstaged = useMemo(
    () => status?.files.filter((f) => f.workingTree !== "unmodified" || f.index === "untracked") ?? [],
    [status],
  );
  const hasStaged = staged.length > 0;
  const hasUnstaged = unstaged.length > 0;

  /* ── operations ── */

  const handleStageAll = async () => {
    if (unstaged.length === 0) return;
    setBusy("commit");
    try {
      const res = await api.git.stage({
        repoPath: repo.path,
        filePaths: unstaged.map((f) => f.path),
      });
      if (!res.ok) {
        setError(res.error ?? t("ide.git.stageFailed"));
        prependLog({ op: "stage", status: "failure", message: res.error });
      } else {
        prependLog({ op: "stage", status: "success" });
      }
      await refresh();
    } catch (err) {
      const msg = (err as Error).message ?? t("ide.git.stageFailed");
      setError(msg);
      prependLog({ op: "stage", status: "failure", message: msg });
    } finally {
      setBusy(null);
    }
  };

  const handleUnstageAll = async () => {
    if (staged.length === 0) return;
    setBusy("commit");
    try {
      const res = await api.git.unstage({
        repoPath: repo.path,
        filePaths: staged.map((f) => f.path),
      });
      if (!res.ok) {
        setError(res.error ?? t("ide.git.unstageFailed"));
        prependLog({ op: "unstage", status: "failure", message: res.error });
      } else {
        prependLog({ op: "unstage", status: "success" });
      }
      await refresh();
    } catch (err) {
      const msg = (err as Error).message ?? t("ide.git.unstageFailed");
      setError(msg);
      prependLog({ op: "unstage", status: "failure", message: msg });
    } finally {
      setBusy(null);
    }
  };

  const handleSingleStage = async (filePath: string) => {
    setBusy("commit");
    try {
      const res = await api.git.stage({ repoPath: repo.path, filePaths: [filePath] });
      if (!res.ok) {
        setError(res.error ?? t("ide.git.stageFailed"));
        prependLog({ op: "stage", status: "failure", message: res.error });
      } else {
        prependLog({ op: "stage", status: "success" });
      }
      await refresh();
    } catch (err) {
      const msg = (err as Error).message ?? t("ide.git.stageFailed");
      setError(msg);
      prependLog({ op: "stage", status: "failure", message: msg });
    } finally {
      setBusy(null);
    }
  };

  const handleSingleUnstage = async (filePath: string) => {
    setBusy("commit");
    try {
      const res = await api.git.unstage({ repoPath: repo.path, filePaths: [filePath] });
      if (!res.ok) {
        setError(res.error ?? t("ide.git.unstageFailed"));
        prependLog({ op: "unstage", status: "failure", message: res.error });
      } else {
        prependLog({ op: "unstage", status: "success" });
      }
      await refresh();
    } catch (err) {
      const msg = (err as Error).message ?? t("ide.git.unstageFailed");
      setError(msg);
      prependLog({ op: "unstage", status: "failure", message: msg });
    } finally {
      setBusy(null);
    }
  };

  const handleCommit = async (mode: "commit" | "push" | "sync") => {
    const msg = commitMsg.trim();
    if (!msg) return;
    setBusy("commit");
    setError(null);
    try {
      const res = await api.git.commit({ repoPath: repo.path, message: msg });
      if (!res.ok) {
        setError(res.error ?? t("ide.git.commitFailed"));
        prependLog({ op: "commit", status: "failure", message: res.error });
        return;
      }
      prependLog({ op: "commit", status: "success" });
      setCommitMsg("");
      if (mode === "push") {
        const pushRes = await api.git.push({ repoPath: repo.path });
        if (!pushRes.ok) {
          setError(pushRes.error ?? t("ide.git.pushFailed"));
          prependLog({ op: "push", status: "failure", message: pushRes.error });
        } else {
          prependLog({ op: "push", status: "success" });
        }
      } else if (mode === "sync") {
        const pullRes = await api.git.pull({ repoPath: repo.path });
        if (!pullRes.ok) {
          setError(pullRes.error ?? t("ide.git.pullFailed"));
          prependLog({ op: "sync", status: "failure", message: pullRes.error });
          return; // don't push if pull failed
        }
        const pushRes = await api.git.push({ repoPath: repo.path });
        if (!pushRes.ok) {
          setError(pushRes.error ?? t("ide.git.pushFailed"));
          prependLog({ op: "push", status: "failure", message: pushRes.error });
        } else {
          prependLog({ op: "push", status: "success" });
        }
      }
      await refresh();
    } catch (err) {
      const errMsg = (err as Error).message ?? t("ide.git.commitFailed");
      setError(errMsg);
      prependLog({ op: "commit", status: "failure", message: errMsg });
    } finally {
      setBusy(null);
    }
  };

  const handlePush = async () => {
    setBusy("push");
    setError(null);
    try {
      const res = await api.git.push({ repoPath: repo.path });
      if (!res.ok) {
        setError(res.error ?? t("ide.git.pushFailed"));
        prependLog({ op: "push", status: "failure", message: res.error });
      } else {
        prependLog({ op: "push", status: "success" });
      }
      await refresh();
    } catch (err) {
      const msg = (err as Error).message ?? t("ide.git.pushFailed");
      setError(msg);
      prependLog({ op: "push", status: "failure", message: msg });
    } finally {
      setBusy(null);
    }
  };

  const handlePull = async () => {
    setBusy("pull");
    setError(null);
    try {
      const res = await api.git.pull({ repoPath: repo.path });
      if (!res.ok) {
        setError(res.error ?? t("ide.git.pullFailed"));
        prependLog({ op: "pull", status: "failure", message: res.error });
      } else if (res.conflict && res.conflictedFiles && res.conflictedFiles.length > 0) {
        // Pull succeeded but left a merge conflict. Offer AI resolution via a
        // confirmation dialog instead of just a red banner.
        setConflictSource("pull");
        setConflictBranch(null);
        setConflictFiles(res.conflictedFiles);
      } else {
        prependLog({ op: "pull", status: "success" });
      }
      await refresh();
    } catch (err) {
      const msg = (err as Error).message ?? t("ide.git.pullFailed");
      setError(msg);
      prependLog({ op: "pull", status: "failure", message: msg });
    } finally {
      setBusy(null);
    }
  };

  // Resolve the current merge conflicts via AI. Reads the conflict-resolution
  // model from settings, asks the backend to resolve every conflicted file,
  // then (on success) clears the dialog and pre-fills a merge commit message
  // for the user to review and submit manually.
  const handleResolveConflicts = async () => {
    if (!conflictFiles) return;
    // conflictResolveModel is stored as "configId:roleKey" — split it back,
    // mirroring CommitBox's commitGenModel handling.
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
    try {
      const res = await api.git.resolveConflicts({
        repoPath: repo.path,
        customModelId,
        customModelRole,
      });
      if (res.ok) {
        setConflictFiles(null);
        const resolvedCount = res.resolvedFiles?.length ?? 0;
        // Pre-fill a merge commit message so the user can finish the merge.
        // The repo is now staged for the merge commit (files added by AI).
        setCommitMsg(`Merge: conflicts auto-resolved by AI${resolvedCount ? ` (${resolvedCount} files)` : ""}`);
        setError(null);
        await refresh();
      } else {
        setError(res.error ?? t("ide.git.resolveFailed"));
      }
    } catch {
      setError(t("ide.git.resolveFailed"));
    } finally {
      setResolving(false);
    }
  };

  const handleDiscard = async () => {
    if (!pendingDiscard) return;
    setBusy("commit");
    try {
      const res = await api.git.discard({
        repoPath: repo.path,
        filePaths: pendingDiscard,
      });
      if (!res.ok) {
        setError(res.error ?? t("ide.git.discardFailed"));
        prependLog({ op: "discard", status: "failure", message: res.error });
      } else {
        prependLog({ op: "discard", status: "success" });
      }
      setPendingDiscard(null);
      await refresh();
    } catch (err) {
      const msg = (err as Error).message ?? t("ide.git.discardFailed");
      setError(msg);
      prependLog({ op: "discard", status: "failure", message: msg });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-lg border border-edge bg-surface">
      {/* ── Header ── */}
      <div className="flex flex-col gap-1 border-b border-edge px-2.5 py-1.5">
        {/* Row 1: repo name (gets the full row width so long names aren't
            squeezed off by the branch badge + remote actions) + collapse
            toggle. Splitting name and branch onto separate rows keeps long
            repo names readable. */}
        <div className="flex items-center gap-2">
          <IconGitBranch size={13} className="shrink-0 text-content-subtle" />
          <span
            className="min-w-0 flex-1 truncate [font-size:var(--right-panel-font-size)] font-medium text-content"
            title={repo.path}
          >
            {repo.name}
          </span>
          <ActionButton
            onClick={() => toggleCollapsedGitRepo(repo.path)}
            title={collapsed ? t("ide.tree.expand") : t("ide.git.collapseCard")}
          >
            {collapsed ? <IconChevronRight size={12} /> : <IconChevronDown size={12} />}
          </ActionButton>
        </div>
        {/* Row 2: branch + ahead/behind + remote actions. */}
        <div className="flex items-center gap-1.5">
          <Menu.Root
            open={branchMenuOpen}
            onOpenChange={(open) => {
              setBranchMenuOpen(open);
              if (open) void loadBranches();
            }}
          >
            <Menu.Trigger
              className={cn(
                "flex shrink-0 items-center gap-0.5 rounded bg-surface-muted px-1.5 py-0.5 font-mono [font-size:var(--rp-fs-xxs)] text-content-muted transition-colors",
                "hover:bg-surface-hover hover:text-content",
              )}
              title={t("ide.git.switchBranch")}
            >
              <IconGitBranch size={10} className="shrink-0 opacity-80" />
              <span className="truncate max-w-[120px]">{status?.branch || "HEAD"}</span>
              <IconChevronDown size={9} className="shrink-0 opacity-60" />
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Positioner side="bottom" align="start" sideOffset={4}>
                <Menu.Popup
                  className={cn(
                    "z-50 flex max-h-[360px] w-[300px] max-w-[320px] min-w-[260px] flex-col rounded-md border border-edge bg-surface py-1 shadow-2xl",
                    "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
                    "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
                    "transition-[transform,opacity] duration-100",
                  )}
                >
                  {/* Search + "new branch" header (non-menu-item, so it doesn't
                      steal keyboard navigation from the branch list below). */}
                  <div className="flex items-center gap-1 px-2 pb-1">
                    <input
                      value={branchQuery}
                      onChange={(e) => setBranchQuery(e.target.value)}
                      onKeyDown={(e) => {
                        // Prevent the Menu from interpreting arrow/Home/End as
                        // item navigation while typing in the filter box.
                        if (["ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) {
                          e.stopPropagation();
                        }
                      }}
                      placeholder={t("ide.git.searchBranches")}
                      className="min-w-0 flex-1 rounded border border-edge bg-surface px-1.5 py-0.5 text-[11px] text-content outline-none placeholder:text-content-subtle focus:border-accent"
                    />
                    <button
                      type="button"
                      onClick={() => setNewBranchOpen(true)}
                      title={t("ide.git.newBranch")}
                      className="flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-[11px] text-content-muted transition-colors hover:bg-surface-muted hover:text-accent"
                    >
                      <IconPlus size={11} />
                    </button>
                  </div>

                  {/* Scrollable grouped list. */}
                  <div className="min-h-0 flex-1 overflow-y-auto">
                    {branchesLoading ? (
                      <div className="flex items-center justify-center gap-1.5 px-3 py-4 text-[11px] text-content-subtle">
                        <IconLoader2 size={12} className="animate-spin" />
                        {t("common.loading")}
                      </div>
                    ) : !filteredBranches ? (
                      <div className="px-3 py-4 text-center text-[11px] text-content-subtle">
                        {t("ide.git.cannotReadBranches")}
                      </div>
                    ) : (
                      <>
                        {checkingOut && (
                          <div className="flex items-center justify-center gap-1.5 border-b border-edge px-3 py-1 text-[11px] text-content-subtle">
                            <IconLoader2 size={12} className="animate-spin" />
                            {t("ide.git.switching")}
                          </div>
                        )}
                        {filteredBranches.local.length === 0 &&
                          filteredBranches.remote.length === 0 &&
                          filteredBranches.tags.length === 0 && (
                            <div className="px-3 py-3 text-center text-[11px] text-content-subtle">
                              {branchQuery ? t("ide.git.noMatch") : t("ide.git.noBranches")}
                            </div>
                          )}
                        {filteredBranches.local.length > 0 && (
                          <BranchGroup
                            label={t("ide.git.localBranches")}
                            items={filteredBranches.local}
                            localNames={new Set(filteredBranches.local.map((b) => b.name))}
                            onCheckout={handleCheckout}
                            onMerge={openMergeDialog}
                          />
                        )}
                        {filteredBranches.remote.length > 0 && (
                          <BranchGroup
                            label={t("ide.git.remoteBranches")}
                            items={filteredBranches.remote}
                            localNames={new Set(filteredBranches.local.map((b) => b.name))}
                            onCheckout={handleCheckout}
                            onMerge={openMergeDialog}
                          />
                        )}
                        {filteredBranches.tags.length > 0 && (
                          <BranchGroup
                            label={t("ide.git.tags")}
                            items={filteredBranches.tags}
                            localNames={new Set(filteredBranches.local.map((b) => b.name))}
                            onCheckout={handleCheckout}
                            icon={<IconTag size={11} />}
                          />
                        )}
                      </>
                    )}
                  </div>
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
          {status && status.ahead > 0 && (
            <span className="flex shrink-0 items-center gap-0.5 [font-size:var(--rp-fs-xxs)] text-accent" title={t("ide.git.aheadOfUpstream")}>
              <IconArrowUp size={10} />
              {status.ahead}
            </span>
          )}
          {status && status.behind > 0 && (
            <span className="flex shrink-0 items-center gap-0.5 [font-size:var(--rp-fs-xxs)] text-info" title={t("ide.git.behindUpstream")}>
              <IconArrowDown size={10} />
              {status.behind}
            </span>
          )}
          <div className="ml-auto flex items-center gap-0.5">
            <ActionButton onClick={handlePull} disabled={busy !== null || loading} busy={busy === "pull"} title={t("ide.git.pullFull")}>
              <IconArrowDown size={12} />
            </ActionButton>
            <ActionButton onClick={handlePush} disabled={busy !== null || loading} busy={busy === "push"} title={t("ide.git.pushFull")}>
              <IconArrowUp size={12} />
            </ActionButton>
            <ActionButton onClick={refresh} disabled={busy !== null} title={t("ide.git.refreshStatus")}>
              <IconRefresh size={12} />
            </ActionButton>
          </div>
        </div>
      </div>

      {/* ── Error banner ── */}
      {!collapsed && error && (
        <div className="flex items-start gap-1.5 border-b border-danger/30 bg-danger/10 px-2.5 py-1.5 [font-size:var(--right-panel-font-size)] text-danger">
          <IconAlertTriangle size={12} className="mt-0.5 shrink-0" />
          <span className="break-words">{error}</span>
        </div>
      )}

      {/* ── Body ── */}
      {!collapsed && (
        <div className="p-2">
          {loading && !status ? (
            <div className="flex items-center gap-1.5 py-2 [font-size:var(--right-panel-font-size)] text-content-subtle">
              <IconLoader2 size={12} className="animate-spin" />
              {t("ide.git.readingStatus")}
            </div>
          ) : !status || (status.files.length === 0) ? (
            <div className="flex items-center gap-1.5 py-2 [font-size:var(--right-panel-font-size)] text-content-subtle">
              <IconCheck size={12} className="text-accent" />
              {t("ide.git.workingTreeClean")}
            </div>
          ) : (
            <>
              {/* Commit box (above staged, so the user writes the message first
                  then reviews what's staged before committing). */}
              {hasStaged && (
                <CommitBox
                  repoPath={repo.path}
                  value={commitMsg}
                  onChange={setCommitMsg}
                  disabled={busy !== null}
                  busy={busy === "commit"}
                  onCommit={handleCommit}
                />
              )}

              {/* 已暂存 group */}
              {hasStaged && (
                <FileGroup
                  labelKey="ide.git.staged"
                  files={staged}
                  repoPath={repo.path}
                  staged
                  onBulkAction={handleUnstageAll}
                  bulkActionLabel={t("ide.git.unstageAll")}
                  busy={busy !== null}
                  onSingleUnstage={(path) => void handleSingleUnstage(path)}
                  onSingleDiscard={undefined}
                />
              )}

              {/* 更改 group */}
              {hasUnstaged && (
                <div className={hasStaged ? "mt-2" : ""}>
                  <FileGroup
                    labelKey="ide.git.changes"
                    files={unstaged}
                    repoPath={repo.path}
                    onBulkAction={handleStageAll}
                    bulkActionLabel={t("ide.git.stageAll")}
                    busy={busy !== null}
                    onDiscard={(paths) => setPendingDiscard(paths)}
                    onDiscardAll={() => setPendingDiscard(unstaged.map((f) => f.path))}
                    onSingleStage={(path) => void handleSingleStage(path)}
                    onSingleDiscard={(path) => setPendingDiscard([path])}
                  />
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ── Operation log ── */}
      {!collapsed && logs.length > 0 && (
        <OperationLog logs={logs} onClear={() => setLogs([])} />
      )}

      {/* ── Discard confirmation dialog ── */}
      <Dialog.Root open={pendingDiscard !== null} onOpenChange={(open) => { if (!open) setPendingDiscard(null); }}>
        <Dialog.Portal>
          <Dialog.Backdrop />
          <Dialog.Popup className="w-[360px] max-w-[90vw] p-4">
            <div className="flex items-start gap-3 pr-6">
              <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-danger/10 text-danger">
                <IconAlertTriangle size={16} />
              </span>
              <div className="min-w-0 flex-1">
                <Dialog.Title>{t("ide.git.discardQ")}</Dialog.Title>
                <Dialog.Description className="mt-1">
                  {t("ide.git.discardDesc", { n: pendingDiscard?.length ?? 0 })}
                </Dialog.Description>
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setPendingDiscard(null)}>
                {t("common.cancel")}
              </Button>
              <Button variant="danger" size="sm" onClick={handleDiscard} disabled={busy !== null}>
                {busy === "commit" ? <IconLoader2 size={12} className="animate-spin" /> : <IconTrash size={12} />}
                {t("ide.git.discard")}
              </Button>
            </div>
            <Dialog.Close />
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>

      {/* ── Merge-conflict: AI resolution dialog ── */}
      <Dialog.Root open={conflictFiles !== null} onOpenChange={(open) => { if (!open && !resolving) setConflictFiles(null); }}>
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
                  {conflictSource === "merge" && conflictBranch
                    ? t("ide.git.conflictDescMerge", {
                        source: conflictBranch,
                        n: conflictFiles?.length ?? 0,
                      })
                    : t("ide.git.conflictDesc", { n: conflictFiles?.length ?? 0 })}
                </Dialog.Description>
                {conflictFiles && conflictFiles.length > 0 && (
                  <div className="mt-2 max-h-28 overflow-y-auto rounded-md border border-edge bg-surface-muted px-2 py-1.5">
                    <ul className="space-y-0.5">
                      {conflictFiles.slice(0, 20).map((f) => (
                        <li key={f} className="truncate font-mono text-[11px] text-content-muted" title={f}>
                          {f}
                        </li>
                      ))}
                      {conflictFiles.length > 20 && (
                        <li className="text-[11px] text-content-subtle">{t("ide.git.conflictMore", { n: conflictFiles.length - 20 })}</li>
                      )}
                    </ul>
                  </div>
                )}
                {/* No default model for AI resolution — surface the missing
                    config instead of letting the call fail after the fact. */}
                {!conflictResolveModel && (
                  <p className="mt-2 text-[11px] text-warning">
                    {t("ide.git.resolveNoModel")}
                  </p>
                )}
              </div>
            </div>
            <div className="mt-4 flex items-center justify-between gap-2">
              {/* Escape hatch: unwind the whole merge back to the pre-merge
                  state (git merge --abort). One click, no terminal needed. */}
              <Button
                variant="danger"
                size="sm"
                onClick={handleMergeAbort}
                disabled={resolving || aborting}
              >
                {aborting ? <IconLoader2 size={12} className="animate-spin" /> : <IconX size={12} />}
                {t("ide.git.mergeAbort")}
              </Button>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => setConflictFiles(null)} disabled={resolving}>
                  {t("ide.git.resolveLater")}
                </Button>
                <Button size="sm" onClick={handleResolveConflicts} disabled={resolving || !conflictResolveModel}>
                  {resolving ? <IconLoader2 size={12} className="animate-spin" /> : <IconSparkles size={12} />}
                  {t("ide.git.resolveWithAi")}
                </Button>
              </div>
            </div>
            <Dialog.Close />
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>

      {/* ── New branch dialog ──
          Creates a local branch from HEAD and switches to it. */}
      <Dialog.Root open={newBranchOpen} onOpenChange={setNewBranchOpen}>
        <Dialog.Portal>
          <Dialog.Backdrop />
          <Dialog.Popup className="w-[360px] max-w-[90vw] p-4">
            <Dialog.Title>{t("ide.git.newBranch")}</Dialog.Title>
            <Dialog.Description className="mt-1">
              {t("ide.git.newBranchDesc")}
            </Dialog.Description>
            <input
              value={newBranchName}
              onChange={(e) => setNewBranchName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newBranchName.trim()) void handleCreateBranch();
              }}
              autoFocus
              placeholder={t("ide.git.branchNamePlaceholder")}
              className="mt-3 w-full rounded-md border border-edge-input bg-surface px-2.5 py-1.5 text-xs text-content outline-none placeholder:text-content-subtle focus:border-accent"
            />
            <div className="mt-3 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setNewBranchOpen(false)}>
                {t("common.cancel")}
              </Button>
              <Button size="sm" onClick={handleCreateBranch} disabled={!newBranchName.trim() || checkingOut}>
                {checkingOut ? <IconLoader2 size={12} className="animate-spin" /> : <IconPlus size={12} />}
                {t("ide.git.createAndSwitch")}
              </Button>
            </div>
            <Dialog.Close />
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>

      {/* ── Merge-branch confirm dialog ──
          Direction is FIXED (source → current branch) and stated in plain
          words — the classic merge usability trap is getting the direction
          backwards. The preview fetched on open tells the user what will
          happen (incoming commits / fast-forward / nothing to do) BEFORE the
          button becomes worth clicking. */}
      <Dialog.Root
        open={mergeTarget !== null}
        onOpenChange={(open) => {
          if (!open && !merging) setMergeTarget(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Backdrop />
          <Dialog.Popup className="w-[400px] max-w-[90vw] p-4">
            <div className="flex items-start gap-3 pr-6">
              <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/10 text-accent">
                <IconGitMerge size={16} />
              </span>
              <div className="min-w-0 flex-1">
                <Dialog.Title>{t("ide.git.mergeBranch")}</Dialog.Title>
                <Dialog.Description className="mt-1">
                  {t("ide.git.mergeDesc", {
                    source: mergeTarget?.name ?? "",
                    target: status?.branch || "HEAD",
                  })}
                </Dialog.Description>
                <div className="mt-2 space-y-1 text-[11px]">
                  {mergePreviewLoading ? (
                    <div className="flex items-center gap-1.5 text-content-subtle">
                      <IconLoader2 size={12} className="animate-spin" />
                      {t("common.loading")}
                    </div>
                  ) : mergePreviewData?.ok ? (
                    mergePreviewData.upToDate ? (
                      <div className="flex items-center gap-1.5 text-content-subtle">
                        <IconCheck size={12} className="shrink-0 text-accent" />
                        {t("ide.git.mergeUpToDate")}
                      </div>
                    ) : (
                      <>
                        <div className="flex items-center gap-1.5 text-content-muted">
                          <IconGitCommit size={12} className="shrink-0 text-content-subtle" />
                          {t("ide.git.mergeIncoming", { n: mergePreviewData.incomingCommits })}
                        </div>
                        {mergePreviewData.fastForward && (
                          <div className="flex items-center gap-1.5 text-content-muted">
                            <IconChevronDown size={12} className="shrink-0 text-info" />
                            {t("ide.git.mergeFastForward")}
                          </div>
                        )}
                      </>
                    )
                  ) : (
                    <div className="flex items-start gap-1.5 text-danger">
                      <IconAlertTriangle size={12} className="mt-0.5 shrink-0" />
                      <span className="break-words">
                        {mergePreviewData?.error ?? t("ide.git.mergePreviewFailed")}
                      </span>
                    </div>
                  )}
                  {/* Dirty working tree: git may refuse the merge (or mix in
                      uncommitted content). Warn loudly but don't block —
                      git itself rejects unsafe merges. */}
                  {(status?.files.length ?? 0) > 0 && (
                    <div className="flex items-start gap-1.5 text-warning">
                      <IconAlertTriangle size={12} className="mt-0.5 shrink-0" />
                      {t("ide.git.mergeDirty")}
                    </div>
                  )}
                </div>
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setMergeTarget(null)} disabled={merging}>
                {t("common.cancel")}
              </Button>
              <Button
                size="sm"
                onClick={handleMerge}
                disabled={merging || mergePreviewLoading || !mergePreviewData?.ok || mergePreviewData.upToDate}
              >
                {merging ? <IconLoader2 size={12} className="animate-spin" /> : <IconGitMerge size={12} />}
                {t("ide.git.merge")}
              </Button>
            </div>
            <Dialog.Close />
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

function CommitBox({
  repoPath,
  value,
  onChange,
  disabled,
  busy,
  onCommit,
}: {
  repoPath: string;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  busy: boolean;
  onCommit: (mode: "commit" | "push" | "sync") => void;
}) {
  const { t } = useI18n();
  const commitGenModel = useSessionStore((s) => s.commitGenModel);
  const commitGenPrompt = useSessionStore((s) => s.commitGenPrompt);
  const [generating, setGenerating] = useState(false);
  // Set when the user stops an in-flight generation: the aborted call's
  // result/error must NOT overwrite the commit message box.
  const cancelledRef = useRef(false);
  // Cancellation key of the in-flight generation (main aborts the SDK query
  // via git.cancelGenerateCommitMessage).
  const genRequestIdRef = useRef<string | null>(null);
  // Maximize/preview panel - opened when the commit message overflows the
  // 3-row cap, so the user can edit the full text comfortably.
  const [previewOpen, setPreviewOpen] = useState(false);

  // ── Auto-grow textarea: 1 row by default, up to MAX_ROWS, then cap and
  //    surface a "maximize" affordance. Measured from scrollHeight so soft-
  //    wraps count as visual rows, not just explicit newlines. ──
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [overflowed, setOverflowed] = useState(false);
  const MAX_ROWS = 3;
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    // Reset to auto so scrollHeight reflects the full content height.
    ta.style.height = "auto";
    const lineHeight = parseFloat(getComputedStyle(ta).lineHeight) || 18;
    const contentRows = Math.round(ta.scrollHeight / lineHeight);
    const visibleRows = Math.min(Math.max(contentRows, 1), MAX_ROWS);
    // Floor at the 36px base height so single-line never collapses below it.
    ta.style.height = `${Math.max(visibleRows * lineHeight, 36)}px`;
    setOverflowed(contentRows > MAX_ROWS);
  }, [value]);

  const handleGenerate = async () => {
    if (generating || disabled) return;
    // commitGenModel is stored as "configId:roleKey" - split it back.
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
    if (!customModelId) return; // no model configured - no-op

    setGenerating(true);
    cancelledRef.current = false;
    const requestId = browserUuid();
    genRequestIdRef.current = requestId;
    try {
      const res = await api.git.generateCommitMessage({
        repoPath,
        customModelId,
        customModelRole,
        prompt: commitGenPrompt,
        requestId,
      });
      if (cancelledRef.current) return; // aborted by the user — keep the box as-is
      if (res.ok && res.message) {
        onChange(res.message);
      } else {
        onChange(res.error ?? t("ide.git.genFailed"));
      }
    } catch {
      if (!cancelledRef.current) onChange(t("ide.git.genFailed"));
    } finally {
      genRequestIdRef.current = null;
      setGenerating(false);
    }
  };

  /** Stop the in-flight generation (hover affordance on the generate button). */
  const handleCancelGenerate = () => {
    cancelledRef.current = true;
    const id = genRequestIdRef.current;
    if (id) void api.git.cancelGenerateCommitMessage({ requestId: id });
    setGenerating(false);
  };

  // Ctrl/Cmd+Enter commits (Enter itself inserts a newline, as expected in a
  // multi-line field). Shared by the inline textarea and the preview panel.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && value.trim() && !disabled) {
      e.preventDefault();
      onCommit("commit");
    }
  };

  return (
    <div className="my-2 space-y-1.5">
      {/* Textarea with inline generate + maximize icons at the top-right. */}
      <div className="relative">
        <textarea
          ref={taRef}
          rows={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t("ide.git.commitPlaceholder")}
          disabled={disabled || generating}
          className="w-full resize-none rounded-md border border-edge-input bg-surface py-1 pl-2 pr-14 [font-size:var(--right-panel-font-size)] leading-relaxed text-content outline-none focus:border-accent disabled:opacity-50 min-h-[36px]"
        />
        {/* Top-right icon row: AI generate (when configured) + maximize
            (when the content overflows the 3-row cap). Horizontal so a single
            row still fits both icons without overflowing. */}
        <div className="absolute right-1 top-1 flex items-center gap-0.5">
          {commitGenModel && (
            <button
              type="button"
              onClick={() => (generating ? handleCancelGenerate() : handleGenerate())}
              disabled={disabled}
              title={generating ? t("ide.git.stopGenerate") : t("ide.git.generateHint")}
              className={cn(
                "group/generate flex h-5 w-5 items-center justify-center rounded text-content-subtle transition-colors",
                "hover:bg-surface-hover hover:text-accent disabled:opacity-40",
              )}
            >
              {generating ? (
                <>
                  <IconLoader2 size={12} className="animate-spin group-hover/generate:hidden" />
                  <IconPlayerStop size={12} className="hidden group-hover/generate:block" />
                </>
              ) : (
                <IconSparkles size={12} />
              )}
            </button>
          )}
          {overflowed && (
            <button
              type="button"
              onClick={() => setPreviewOpen(true)}
              title={t("ide.git.expandEdit")}
              className="flex h-5 w-5 items-center justify-center rounded text-content-subtle transition-colors hover:bg-surface-hover hover:text-content"
            >
              <IconMaximize size={12} />
            </button>
          )}
        </div>
      </div>

      {/* Commit split button - main "提交" fills the row, with the dropdown
          trigger spliced on the right (shared rounded corners). Main action
          stays a raw button so the two pieces visually fuse; the Menu
          interaction is unchanged. */}
      <div className="flex overflow-hidden rounded-md">
        <button
          type="button"
          onClick={() => onCommit("commit")}
          disabled={!value.trim() || disabled}
          className="flex flex-1 items-center justify-center gap-1 bg-accent px-2 py-1 [font-size:var(--right-panel-font-size)] text-surface transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:bg-surface-hover disabled:text-content-subtle"
        >
          {busy ? <IconLoader2 size={11} className="animate-spin" /> : <IconGitCommit size={11} />}
          {t("ide.git.commit")}
        </button>
        <Menu.Root>
          <Menu.Trigger
            disabled={!value.trim() || disabled}
            className="flex items-center bg-accent px-1.5 text-surface transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:bg-surface-hover disabled:text-content-subtle"
          >
            <IconChevronDown size={12} />
          </Menu.Trigger>
            <Menu.Portal>
              <Menu.Positioner side="top" align="end" sideOffset={4}>
                <Menu.Popup
                  className={cn(
                    "z-50 min-w-[160px] rounded-md border border-edge bg-surface py-1 shadow-2xl",
                    "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
                    "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
                    "transition-[transform,opacity] duration-100",
                  )}
                >
                  <Menu.Item
                    onClick={() => onCommit("commit")}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left [font-size:var(--right-panel-font-size)] text-content-muted outline-none select-none data-[highlighted]:bg-surface-muted"
                  >
                    {t("ide.git.commit")}
                  </Menu.Item>
                  <Menu.Item
                    onClick={() => onCommit("push")}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left [font-size:var(--right-panel-font-size)] text-content-muted outline-none select-none data-[highlighted]:bg-surface-muted"
                  >
                    {t("ide.git.commitAndPush")}
                  </Menu.Item>
                  <Menu.Item
                    onClick={() => onCommit("sync")}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left [font-size:var(--right-panel-font-size)] text-content-muted outline-none select-none data-[highlighted]:bg-surface-muted"
                  >
                    {t("ide.git.commitAndSync")}
                  </Menu.Item>
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
        </div>

      {/* ── Maximize / preview panel ──
          A lightweight Dialog with a large editable textarea bound to the same
          `value`/`onChange`, so edits sync back to the inline field on close. */}
      <Dialog.Root open={previewOpen} onOpenChange={setPreviewOpen}>
        <Dialog.Portal>
          <Dialog.Backdrop />
          <Dialog.Popup className="w-[480px] max-w-[90vw] p-4">
            <Dialog.Title>{t("ide.git.editCommitTitle")}</Dialog.Title>
            <Dialog.Description className="mt-1">
              {t("ide.git.editCommitDesc")}
            </Dialog.Description>
            <textarea
              value={value}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={handleKeyDown}
              rows={10}
              autoFocus
              className="mt-3 w-full resize-y rounded-md border border-edge-input bg-surface px-2.5 py-1.5 text-xs leading-relaxed text-content outline-none focus:border-accent"
            />
            <div className="mt-3 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setPreviewOpen(false)}>
                {t("ide.git.done")}
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={!value.trim() || disabled}
                onClick={() => {
                  setPreviewOpen(false);
                  onCommit("commit");
                }}
              >
                <IconGitCommit size={12} />
                {t("ide.git.commit")}
              </Button>
            </div>
            <Dialog.Close />
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

/* ─────────────────── branch picker group ─────────────────── */

/** A labeled group of refs (local branches / remote branches / tags) inside
 *  the branch picker. Each row checks out its ref when clicked.
 *
 *  - Local branches: `git checkout <name>`.
 *  - Remote branches: if a local branch of the same short name exists, switch
 *    to it; otherwise create a tracking branch (`git checkout -b <name> <origin/name>`).
 *  - Tags: `git checkout <tag>` (detached HEAD). */
function BranchGroup({
  label,
  items,
  localNames,
  onCheckout,
  onMerge,
  icon,
}: {
  label: string;
  items: GitBranchInfo[];
  /** Short names of local branches - used to decide tracking-branch creation
   *  for remote refs. */
  localNames: Set<string>;
  onCheckout: (branch: string, newBranch?: string) => void;
  /** When provided, non-current local/remote rows get a hover "merge into
   *  current branch" action. Tags are excluded (merging a tag is rare and
   *  would clutter the row). */
  onMerge?: (b: GitBranchInfo) => void;
  icon?: React.ReactNode;
}) {
  const { t } = useI18n();
  const handleClick = (b: GitBranchInfo) => {
    if (b.current) return;
    if (b.type === "remote") {
      // `origin/foo` -> short name `foo`. Track if no local branch yet.
      const shortName = b.name.includes("/") ? b.name.slice(b.name.indexOf("/") + 1) : b.name;
      if (localNames.has(shortName)) {
        onCheckout(shortName);
      } else {
        onCheckout(b.name, shortName);
      }
    } else {
      onCheckout(b.name);
    }
  };
  return (
    <div className="py-0.5">
      <div className="px-2 py-0.5 text-[10px] uppercase tracking-wide text-content-subtle">
        {label}
      </div>
      {items.map((b) => (
        <Menu.Item
          key={`${b.type}/${b.name}`}
          onClick={() => handleClick(b)}
          className={cn(
            "group flex w-full items-center gap-1.5 px-2 py-1 text-left text-[11px] outline-none select-none",
            "data-[highlighted]:bg-surface-muted",
            b.current ? "text-accent" : "text-content-muted",
          )}
        >
          <span className="shrink-0 opacity-80">{icon ?? <IconGitBranch size={11} />}</span>
          <span className="min-w-0 flex-1 truncate font-mono">{b.name}</span>
          {b.label && (
            <span
              className="min-w-0 max-w-[120px] truncate text-[10px] text-content-subtle group-hover:opacity-0"
              title={b.label}
            >
              {b.label}
            </span>
          )}
          {/* Hover "merge into current branch" — fades in where the subject
              label was. stopPropagation keeps the click from also activating
              the surrounding checkout menu item. */}
          {!b.current && b.type !== "tag" && onMerge && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onMerge(b);
              }}
              title={t("ide.git.mergeIntoBranch")}
              className={cn(
                "flex h-5 w-5 shrink-0 items-center justify-center rounded text-content-subtle transition-opacity",
                "opacity-0 hover:bg-surface-hover hover:text-accent group-hover:opacity-100",
              )}
            >
              <IconGitMerge size={11} />
            </button>
          )}
          {b.current && <IconCheck size={11} className="shrink-0" />}
        </Menu.Item>
      ))}
    </div>
  );
}

/* ───────────────────────── action button ───────────────────────── */

function ActionButton({
  children,
  onClick,
  disabled,
  busy,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "flex h-6 w-6 items-center justify-center rounded text-content-muted transition-colors",
        "hover:bg-surface-hover hover:text-content disabled:opacity-40",
      )}
    >
      {busy ? <IconLoader2 size={12} className="animate-spin" /> : children}
    </button>
  );
}

/* ───────────────────────── operation log ───────────────────────── */

/**
 * Collapsible operation log shown at the bottom of a repo card. Lists the most
 * recent pull/push/commit/etc. operations (newest first), each as one line with
 * a status icon, op label, and relative time. Failed entries expand on click to
 * reveal the full error message - the key surface for diagnosing network/auth
 * failures that would otherwise be lost.
 */
function OperationLog({
  logs,
  onClear,
}: {
  logs: GitOpLogEntry[];
  onClear: () => void;
}) {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <div className="border-t border-edge">
      {/* Header row: collapse toggle + clear-all */}
      <div className="flex items-center gap-1 px-2.5 py-1">
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="flex items-center gap-1 [font-size:var(--rp-fs-xxs)] font-medium uppercase tracking-wide text-content-subtle transition-colors hover:text-content-muted"
        >
          {collapsed ? <IconChevronRight size={10} /> : <IconChevronDown size={10} />}
          <IconList size={11} />
          {t("ide.git.opLog", { n: logs.length })}
        </button>
        <button
          type="button"
          onClick={onClear}
          title={t("ide.git.clearLog")}
          className="ml-auto flex h-5 w-5 items-center justify-center rounded text-content-subtle transition-colors hover:bg-surface-hover hover:text-content-muted"
        >
          <IconX size={12} />
        </button>
      </div>
      {/* List */}
      {!collapsed && (
        <div className="max-h-[160px] overflow-y-auto px-2.5 pb-1.5">
          {logs.map((entry) => {
            const isFailure = entry.status === "failure";
            const expanded = expandedId === entry.id;
            const hasMessage = isFailure && !!entry.message;
            return (
              <div key={entry.id} className="border-b border-edge/50 last:border-b-0">
                <button
                  type="button"
                  disabled={!hasMessage}
                  onClick={() => setExpandedId(expanded ? null : entry.id)}
                  className={cn(
                    "flex w-full items-center gap-1.5 py-1 text-left [font-size:var(--right-panel-font-size)]",
                    hasMessage ? "cursor-pointer" : "cursor-default",
                  )}
                >
                  {isFailure ? (
                    <IconCircleXFilled size={11} className="shrink-0 text-danger" />
                  ) : (
                    <IconCircleCheck size={11} className="shrink-0 text-accent" />
                  )}
                  <span
                    className={cn(
                      "shrink-0",
                      isFailure ? "text-danger" : "text-content-muted",
                    )}
                  >
                    {t(OP_LABEL_KEYS[entry.op])}
                  </span>
                  <span
                    className="ml-auto shrink-0 [font-size:var(--rp-fs-xxs)] text-content-subtle"
                    title={formatFullTime(entry.timestamp)}
                  >
                    {formatRelativeTime(entry.timestamp)}
                  </span>
                </button>
                {expanded && hasMessage && (
                  <div className="break-words whitespace-pre-wrap pb-1.5 pl-5 [font-size:var(--rp-fs-xxs)] leading-relaxed text-danger">
                    {entry.message}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ───────────────────────── file group ───────────────────────── */

function FileGroup({
  labelKey,
  files,
  repoPath,
  staged,
  onBulkAction,
  bulkActionLabel,
  busy,
  onDiscard,
  onDiscardAll,
  onSingleStage,
  onSingleUnstage,
  onSingleDiscard,
}: {
  labelKey: MessageId;
  files: GitFileStatus[];
  repoPath: string;
  staged?: boolean;
  onBulkAction: () => void;
  bulkActionLabel: string;
  busy: boolean;
  onDiscard?: (paths: string[]) => void;
  /** Discard every file in this group at once (opens the same confirmation
   *  dialog as a single-file discard). Only wired for the unstaged group. */
  onDiscardAll?: () => void;
  onSingleStage?: (filePath: string) => void;
  onSingleUnstage?: (filePath: string) => void;
  onSingleDiscard?: (filePath: string) => void;
}) {
  const { t } = useI18n();
  const label = t(labelKey);
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div>
      <div className="group mb-1 flex items-center gap-1">
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="flex items-center gap-1 [font-size:var(--rp-fs-xxs)] font-medium uppercase tracking-wide text-content-subtle"
        >
          {collapsed ? <IconChevronRight size={10} /> : <IconChevronDown size={10} />}
          {label} ({files.length})
        </button>
        <div className="ml-auto flex items-center gap-1">
          {onDiscardAll && (
            <button
              type="button"
              onClick={onDiscardAll}
              disabled={busy}
              title={t("ide.git.discardAllHint", { group: label })}
              aria-label={t("ide.git.discardAllHint", { group: label })}
              className="rounded p-0.5 text-content-subtle opacity-0 transition-all hover:bg-danger/10 hover:text-danger focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-0"
            >
              <IconTrash size={13} />
            </button>
          )}
          <button
            type="button"
            onClick={onBulkAction}
            disabled={busy}
            className="rounded px-1.5 py-0.5 [font-size:var(--rp-fs-xxs)] text-content-muted transition-colors hover:bg-surface-hover hover:text-content disabled:opacity-40"
          >
            {bulkActionLabel}
          </button>
        </div>
      </div>
      {!collapsed && (
        <div className="space-y-0.5">
          {files.map((f) => (
            <FileRow
              key={f.path}
              file={f}
              repoPath={repoPath}
              staged={staged}
              onDiscard={onDiscard}
              onSingleStage={onSingleStage}
              onSingleUnstage={onSingleUnstage}
              onSingleDiscard={onSingleDiscard}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ───────────────────────── file row ───────────────────────── */

function FileRow({
  file,
  repoPath,
  staged,
  onDiscard,
  onSingleStage,
  onSingleUnstage,
  onSingleDiscard,
}: {
  file: GitFileStatus;
  repoPath: string;
  staged?: boolean;
  onDiscard?: (paths: string[]) => void;
  onSingleStage?: (filePath: string) => void;
  onSingleUnstage?: (filePath: string) => void;
  onSingleDiscard?: (filePath: string) => void;
}) {
  const { t } = useI18n();
  const openFileInIde = useSessionStore((s) => s.openFileInIde);
  const setGitDiffBefore = useSessionStore((s) => s.setGitDiffBefore);
  const gitDiffOpenMode = useSessionStore((s) => s.gitDiffOpenMode);
  const openGitDiffDialogTab = useSessionStore((s) => s.openGitDiffDialogTab);
  const [diffTally, setDiffTally] = useState<{ adds: number; dels: number } | null>(null);

  const absPath = joinPath(repoPath, file.path);
  const code = staged ? file.index : file.workingTree;

  // Async-load the +/- tally for this file. For staged files we diff against
  // HEAD (what will be committed); for unstaged we diff the working tree.
  useEffect(() => {
    if (code === "untracked" || code === "unmodified") {
      setDiffTally(null);
      return;
    }
    let cancelled = false;
    api.git
      .diff({ repoPath, filePath: file.path, staged: !!staged })
      .then(({ patch }) => {
        if (cancelled || !patch) return;
        const { before, after } = parsePatchToBeforeAfter(patch);
        const diff = lineDiff(before, after);
        setDiffTally(diffSummary(diff));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [repoPath, file.path, code, staged]);

  // Click → open in center editor with diff. Fetches the appropriate diff
  // (staged vs HEAD for staged files, working tree for unstaged), stashes
  // the "before" content, and opens the file in diff mode.
  const handleClick = async () => {
    let before: string | undefined;
    let after: string | undefined;
    try {
      const { patch } = await api.git.diff({ repoPath, filePath: file.path, staged: !!staged });
      if (patch) {
        const parsed = parsePatchToBeforeAfter(patch);
        before = parsed.before;
        after = parsed.after;
        setGitDiffBefore(absPath, before);
      }
    } catch {
      // fall through - open in edit mode if diff fetch fails
    }
    if (gitDiffOpenMode === "dialog") {
      // Dialog open-mode: open (or refresh) a diff tab in the floating dialog.
      // Staged vs unstaged of the same path are distinct tabs (id suffix).
      // Staged diffs always supply `after` from the patch (index blob); unstaged
      // may omit it so DiffPane reads the live working tree from disk.
      openGitDiffDialogTab({
        id: `${absPath}::${staged ? "staged" : "work"}`,
        filePath: absPath,
        before: before ?? "",
        after: staged ? (after ?? "") : after,
        title: basename(file.path),
        repoPath,
        source: "working",
        staged: !!staged,
      });
      return;
    }
    openFileInIde(absPath, { diff: true });
  };

  return (
    <ContextMenu.Root>
        <ContextMenu.Trigger
        render={
          <div className="group relative flex items-center gap-1.5 rounded px-1 py-0.5 hover:bg-surface-hover/40" />
        }
      >
        <button
          type="button"
          onClick={handleClick}
          className="flex min-w-0 flex-1 items-center gap-1 text-left"
          title={absPath}
        >
          <StatusCodeIcon code={code} />
          <span className="truncate font-mono [font-size:var(--right-panel-font-size)] text-content-muted">{basename(file.path)}</span>
        </button>
        {/* +/- tally badge — hidden on hover so the action buttons have room. */}
        {diffTally && (diffTally.adds > 0 || diffTally.dels > 0) && (
          <span className="flex shrink-0 items-center gap-0.5 font-mono [font-size:var(--rp-fs-xxs)] tabular-nums group-hover:opacity-0">
            {diffTally.adds > 0 && <span className="text-success">+{diffTally.adds}</span>}
            {diffTally.dels > 0 && <span className="text-danger">−{diffTally.dels}</span>}
          </span>
        )}
        {/* Hover action buttons — absolutely positioned so the +/- tally badge
            can sit flush right; this layer fades in over the badge on hover. */}
        <div className="absolute right-0.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          {/* Staged files: unstage button. Unstaged: stage button. */}
          {staged ? (
            <RowActionIcon
              icon={<IconMinus size={11} />}
              title={t("ide.git.unstage")}
              onClick={(e) => {
                e.stopPropagation();
                onSingleUnstage?.(file.path);
              }}
            />
          ) : (
            <RowActionIcon
              icon={<IconPlus size={11} />}
              title={t("ide.git.stage")}
              onClick={(e) => {
                e.stopPropagation();
                onSingleStage?.(file.path);
              }}
            />
          )}
          {/* Discard — only for unstaged files (staged files can be unstaged first). */}
          {!staged && onSingleDiscard && (
            <RowActionIcon
              icon={<IconTrash size={11} />}
              title={t("ide.git.discard")}
              danger
              onClick={(e) => {
                e.stopPropagation();
                onSingleDiscard(file.path);
              }}
            />
          )}
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner>
          <ContextMenu.Popup
            className={cn(
              "z-50 min-w-[140px] rounded-md border border-edge bg-surface py-1 shadow-2xl",
              "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
              "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
              "transition-[transform,opacity] duration-100",
            )}
          >
            <ContextMenu.Item
              onClick={handleClick}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left [font-size:var(--right-panel-font-size)] text-content-muted outline-none select-none data-[highlighted]:bg-surface-muted"
            >
              <IconEye size={12} />
              {t("ide.git.viewDiff")}
            </ContextMenu.Item>
            <ContextMenu.Item
              onClick={() => openFileInIde(absPath)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left [font-size:var(--right-panel-font-size)] text-content-muted outline-none select-none data-[highlighted]:bg-surface-muted"
            >
              <IconGitCommit size={12} />
              {t("ide.git.viewSource")}
            </ContextMenu.Item>
            {!staged && onDiscard && (
              <ContextMenu.Item
                onClick={() => onDiscard([file.path])}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left [font-size:var(--right-panel-font-size)] text-danger outline-none select-none data-[highlighted]:bg-danger/10"
              >
                <IconTrash size={12} />
                {t("ide.git.discardEllipsis")}
              </ContextMenu.Item>
            )}
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/** A tiny icon button shown on file-row hover. */
function RowActionIcon({
  icon,
  title,
  onClick,
  danger,
}: {
  icon: React.ReactNode;
  title: string;
  onClick: (e: React.MouseEvent) => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "flex h-5 w-5 items-center justify-center rounded text-content-subtle transition-colors",
        "hover:bg-surface-hover",
        danger ? "hover:text-danger" : "hover:text-content",
      )}
    >
      {icon}
    </button>
  );
}

/* ───────────────────────── status code icon ───────────────────────── */

function StatusCodeIcon({ code }: { code: GitFileStatus["index"] }) {
  const label =
    code === "modified" ? "M" :
    code === "added" ? "A" :
    code === "deleted" ? "D" :
    code === "untracked" ? "?" :
    code === "renamed" ? "R" :
    code === "copied" ? "C" : "·";
  const color =
    code === "added" || code === "untracked" ? "text-accent" :
    code === "modified" || code === "renamed" || code === "copied" ? "text-warning" :
    code === "deleted" ? "text-danger" : "text-content-subtle";
  return (
    <span className={cn("w-3 shrink-0 text-center font-mono [font-size:var(--rp-fs-xxs)] font-bold", color)} title={code}>
      {label}
    </span>
  );
}

/* ───────────────────────── patch parser ───────────────────────── */

/** Parse a unified diff patch into before/after text for line-based diffing. */
function parsePatchToBeforeAfter(patch: string): { before: string; after: string } {
  const beforeLines: string[] = [];
  const afterLines: string[] = [];
  const lines = patch.split("\n");
  let inHunk = false;
  for (const line of lines) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) {
      afterLines.push(line.slice(1));
    } else if (line.startsWith("-")) {
      beforeLines.push(line.slice(1));
    } else if (line.startsWith(" ")) {
      beforeLines.push(line.slice(1));
      afterLines.push(line.slice(1));
    } else if (line === "") {
      beforeLines.push("");
      afterLines.push("");
    }
  }
  return { before: beforeLines.join("\n"), after: afterLines.join("\n") };
}
