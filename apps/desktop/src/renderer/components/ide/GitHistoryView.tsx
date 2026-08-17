import { useCallback, useEffect, useState } from "react";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { joinPath, basename } from "@renderer/lib/path.js";
import { formatRelativeTime, formatFullTime } from "@renderer/lib/time.js";
import type { GitRepo, GitCommitInfo, GitCommitFile, GitCommitFileStatus } from "@contracts/ipc";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import {
  IconArrowLeft,
  IconGitCommit,
  IconLoader2,
  IconRefresh,
  IconAlertTriangle,
} from "@renderer/lib/icons.js";

const PAGE_SIZE = 50;

/**
 * Git history browser for the right-panel Git tab.
 *
 * Flow:
 *   1. Commit list (paginated) for the selected repo
 *   2. Click a commit → file list for that commit
 *   3. Click a file → center Monaco Diff (parent blob vs commit blob)
 *
 * All state is local; multi-repo selection lives here too.
 */
export function GitHistoryView({ repos }: { repos: GitRepo[] }) {
  const [repoPath, setRepoPath] = useState(repos[0]?.path ?? "");
  const [commits, setCommits] = useState<GitCommitInfo[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Detail view
  const [selected, setSelected] = useState<GitCommitInfo | null>(null);
  const [files, setFiles] = useState<GitCommitFile[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  // Keep selected repo valid when the repo list changes.
  useEffect(() => {
    if (repos.length === 0) {
      setRepoPath("");
      return;
    }
    if (!repos.some((r) => r.path === repoPath)) {
      setRepoPath(repos[0]!.path);
    }
  }, [repos, repoPath]);

  const loadCommits = useCallback(async (opts?: { append?: boolean; skip?: number }) => {
    if (!repoPath) {
      setCommits([]);
      setHasMore(false);
      setLoading(false);
      return;
    }
    const append = !!opts?.append;
    if (append) setLoadingMore(true);
    else {
      setLoading(true);
      setError(null);
      setSelected(null);
      setFiles([]);
    }
    try {
      const skip = opts?.skip ?? 0;
      const res = await api.git.log({ repoPath, limit: PAGE_SIZE, skip });
      setCommits((prev) => (append ? [...prev, ...res.commits] : res.commits));
      setHasMore(res.hasMore);
    } catch (err) {
      setError((err as Error).message || "加载提交历史失败");
      if (!append) setCommits([]);
      setHasMore(false);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [repoPath]);

  useEffect(() => {
    void loadCommits();
  }, [loadCommits]);

  // Cross-client auto-refresh: the host broadcasts `git.changed` after ANY
  // client's commit / pull / checkout; bumping this version reloads the
  // history so a fresh commit shows up without tapping the manual refresh.
  const gitChangeVersion = useSessionStore(
    (s) => (repoPath ? s.gitChangeVersionByRepo[repoPath] ?? 0 : 0),
  );
  useEffect(() => {
    void loadCommits();
  }, [gitChangeVersion, loadCommits]);

  const openCommit = async (commit: GitCommitInfo) => {
    setSelected(commit);
    setFiles([]);
    setDetailError(null);
    setFileError(null);
    setDetailLoading(true);
    try {
      const detail = await api.git.showCommit({
        repoPath,
        commitHash: commit.hash,
      });
      if (!detail) {
        setDetailError("无法加载该提交");
        return;
      }
      setSelected(detail.commit);
      setFiles(detail.files);
    } catch (err) {
      setDetailError((err as Error).message || "加载提交详情失败");
    } finally {
      setDetailLoading(false);
    }
  };

  const openFile = async (file: GitCommitFile) => {
    if (!selected) return;
    setFileError(null);
    try {
      const { before, after } = await api.git.showFile({
        repoPath,
        commitHash: selected.hash,
        filePath: file.path,
        oldPath: file.oldPath,
      });
      // Both empty usually means binary / missing - still open so the user sees empty panes.
      const absPath = joinPath(repoPath, file.path);
      const store = useSessionStore.getState();
      if (store.gitDiffOpenMode === "dialog") {
        // Dialog open-mode: open (or refresh) a history diff tab in the
        // floating dialog (both blobs supplied - DiffPane won't touch disk).
        store.openGitDiffDialogTab({
          id: absPath,
          filePath: absPath,
          before,
          after,
          title: basename(file.path),
          repoPath,
          source: "history",
        });
        return;
      }
      store.setGitDiffPair(absPath, { before, after });
      store.openFileInIde(absPath, { diff: true });
    } catch (err) {
      setFileError((err as Error).message || "打开文件差异失败");
    }
  };

  if (repos.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <IconGitCommit size={20} className="text-content-subtle" />
        <p className="[font-size:var(--right-panel-font-size)] text-content-muted">未找到 Git 仓库</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Repo picker (multi-repo) + refresh */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-edge px-2 py-1.5">
        {repos.length > 1 ? (
          <select
            value={repoPath}
            onChange={(e) => setRepoPath(e.target.value)}
            className="min-w-0 flex-1 truncate rounded border border-edge bg-surface px-1.5 py-0.5 [font-size:var(--right-panel-font-size)] text-content outline-none focus:border-accent"
            title="选择仓库"
          >
            {repos.map((r) => (
              <option key={r.path} value={r.path}>
                {r.name}
              </option>
            ))}
          </select>
        ) : (
          <span className="min-w-0 flex-1 truncate [font-size:var(--right-panel-font-size)] text-content-muted" title={repoPath}>
            {repos[0]?.name}
          </span>
        )}
        <button
          type="button"
          onClick={() => void loadCommits()}
          className="flex shrink-0 items-center rounded px-1.5 py-0.5 text-content-muted transition-colors hover:bg-surface-hover hover:text-content"
          title="刷新历史"
        >
          <IconRefresh size={12} />
        </button>
      </div>

      {error && (
        <div className="flex items-start gap-1.5 border-b border-edge bg-danger/10 px-2 py-1.5 [font-size:var(--right-panel-font-size)] text-danger">
          <IconAlertTriangle size={12} className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {selected ? (
          <CommitDetail
            commit={selected}
            files={files}
            loading={detailLoading}
            error={detailError}
            fileError={fileError}
            onBack={() => {
              setSelected(null);
              setFiles([]);
              setDetailError(null);
              setFileError(null);
            }}
            onOpenFile={(f) => void openFile(f)}
          />
        ) : loading ? (
          <div className="flex items-center gap-1.5 px-3 py-3 [font-size:var(--right-panel-font-size)] text-content-subtle">
            <IconLoader2 size={12} className="animate-spin" />
            加载提交历史…
          </div>
        ) : commits.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-1 px-4 py-10 text-center">
            <IconGitCommit size={18} className="text-content-subtle" />
            <p className="[font-size:var(--right-panel-font-size)] text-content-muted">暂无提交记录</p>
          </div>
        ) : (
          <div className="py-1">
            {commits.map((c) => (
              <CommitRow key={c.hash} commit={c} onClick={() => void openCommit(c)} />
            ))}
            {hasMore && (
              <div className="px-2 py-2">
                <button
                  type="button"
                  disabled={loadingMore}
                  onClick={() => void loadCommits({ append: true, skip: commits.length })}
                  className="flex w-full items-center justify-center gap-1 rounded px-2 py-1.5 [font-size:var(--right-panel-font-size)] text-content-muted transition-colors hover:bg-surface-hover hover:text-content disabled:opacity-50"
                >
                  {loadingMore ? (
                    <>
                      <IconLoader2 size={12} className="animate-spin" />
                      加载中…
                    </>
                  ) : (
                    "加载更多"
                  )}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ───────────────────────── rows ───────────────────────── */

function CommitRow({
  commit,
  onClick,
}: {
  commit: GitCommitInfo;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full flex-col gap-0.5 px-2.5 py-1.5 text-left transition-colors hover:bg-surface-hover/50"
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <IconGitCommit size={12} className="shrink-0 text-content-subtle" />
        <span className="shrink-0 font-mono [font-size:var(--rp-fs-xxs)] text-accent">{commit.shortHash}</span>
        <span className="min-w-0 truncate [font-size:var(--right-panel-font-size)] text-content">{commit.subject}</span>
      </div>
      <div className="flex items-center gap-1.5 pl-[18px] [font-size:var(--rp-fs-xxs)] text-content-subtle">
        <span className="truncate">{commit.author}</span>
        <span>·</span>
        <span className="shrink-0" title={formatFullTime(commit.authoredAt)}>
          {formatRelativeTime(commit.authoredAt)}
        </span>
      </div>
    </button>
  );
}

function CommitDetail({
  commit,
  files,
  loading,
  error,
  fileError,
  onBack,
  onOpenFile,
}: {
  commit: GitCommitInfo;
  files: GitCommitFile[];
  loading: boolean;
  error: string | null;
  fileError: string | null;
  onBack: () => void;
  onOpenFile: (file: GitCommitFile) => void;
}) {
  return (
    <div className="flex flex-col">
      <div className="border-b border-edge px-2 py-1.5">
        <button
          type="button"
          onClick={onBack}
          className="mb-1.5 flex items-center gap-1 rounded px-1 py-0.5 [font-size:var(--right-panel-font-size)] text-content-muted transition-colors hover:bg-surface-hover hover:text-content"
        >
          <IconArrowLeft size={12} />
          返回列表
        </button>
        <div className="flex min-w-0 items-start gap-1.5">
          <IconGitCommit size={13} className="mt-0.5 shrink-0 text-content-subtle" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-1.5">
              <span className="font-mono [font-size:var(--rp-fs-xxs)] text-accent">{commit.shortHash}</span>
              <span className="[font-size:var(--right-panel-font-size)] font-medium text-content">{commit.subject}</span>
            </div>
            {commit.body && (
              <p className="mt-1 whitespace-pre-wrap [font-size:var(--right-panel-font-size)] text-content-muted">{commit.body}</p>
            )}
            <div className="mt-1 flex flex-wrap items-center gap-1.5 [font-size:var(--rp-fs-xxs)] text-content-subtle">
              <span>{commit.author}</span>
              <span>·</span>
              <span title={commit.authoredAt}>{formatFullTime(commit.authoredAt)}</span>
            </div>
          </div>
        </div>
      </div>

      {fileError && (
        <div className="flex items-start gap-1.5 border-b border-edge bg-danger/10 px-2 py-1.5 [font-size:var(--right-panel-font-size)] text-danger">
          <IconAlertTriangle size={12} className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">{fileError}</span>
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-1.5 px-3 py-3 [font-size:var(--right-panel-font-size)] text-content-subtle">
          <IconLoader2 size={12} className="animate-spin" />
          加载变更文件…
        </div>
      ) : error ? (
        <div className="flex items-start gap-1.5 px-3 py-3 [font-size:var(--right-panel-font-size)] text-danger">
          <IconAlertTriangle size={12} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      ) : files.length === 0 ? (
        <div className="px-3 py-4 text-center [font-size:var(--right-panel-font-size)] text-content-subtle">无文件变更</div>
      ) : (
        <div className="py-1">
          <div className="px-2.5 py-1 [font-size:var(--rp-fs-xxs)] font-medium uppercase tracking-wide text-content-subtle">
            {files.length} 个文件
          </div>
          {files.map((f) => (
            <CommitFileRow key={`${f.status}:${f.oldPath ?? ""}:${f.path}`} file={f} onClick={() => onOpenFile(f)} />
          ))}
        </div>
      )}
    </div>
  );
}

function CommitFileRow({
  file,
  onClick,
}: {
  file: GitCommitFile;
  onClick: () => void;
}) {
  // Tooltip shows the full repo-relative path (with the rename arrow for
  // renamed/copied files); the visible label is just the file name(s) so the
  // list stays scannable when paths are deep.
  const fullPath =
    file.status === "renamed" || file.status === "copied"
      ? `${file.oldPath ?? "?"} -> ${file.path}`
      : file.path;
  const label =
    file.status === "renamed" || file.status === "copied"
      ? `${basename(file.oldPath ?? "?")} -> ${basename(file.path)}`
      : basename(file.path);

  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full items-center gap-1.5 px-2.5 py-1 text-left transition-colors hover:bg-surface-hover/50"
      title={fullPath}
    >
      <CommitFileStatusIcon status={file.status} />
      <span className="min-w-0 flex-1 truncate font-mono [font-size:var(--right-panel-font-size)] text-content-muted">{label}</span>
      {(file.additions != null || file.deletions != null) && (
        <span className="flex shrink-0 items-center gap-0.5 font-mono [font-size:var(--rp-fs-xxs)] tabular-nums">
          {file.additions != null && file.additions > 0 && (
            <span className="text-success">+{file.additions}</span>
          )}
          {file.deletions != null && file.deletions > 0 && (
            <span className="text-danger">−{file.deletions}</span>
          )}
        </span>
      )}
    </button>
  );
}

function CommitFileStatusIcon({ status }: { status: GitCommitFileStatus }) {
  const letter =
    status === "added"
      ? "A"
      : status === "deleted"
        ? "D"
        : status === "renamed"
          ? "R"
          : status === "copied"
            ? "C"
            : "M";
  return (
    <span
      className={cn(
        "w-3 shrink-0 text-center font-mono [font-size:var(--rp-fs-xxs)] font-semibold",
        status === "added" && "text-accent",
        status === "deleted" && "text-danger",
        status === "modified" && "text-warning",
        (status === "renamed" || status === "copied") && "text-content-muted",
      )}
    >
      {letter}
    </span>
  );
}
