/**
 * MobileGitScreen — the mobile git commit panel (bottom-nav page of the web
 * shell).
 *
 * A focused, mobile-first take on the desktop GitRepoCard: discover repos under
 * the active project, show changed/staged files with stage toggles, edit a
 * commit message (with AI generation), and commit / commit-and-push / pull. The
 * operations map 1:1 to the `git:*` mobile RPC whitelist, which reuses the
 * desktop git module's helpers (same path guard, same simple-git loader, same
 * LLM commit-message core) — behavior is identical, only the transport differs.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@renderer/lib/api.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { cn } from "@renderer/lib/cn.js";
import type { GitRepo, GitStatusResult, GitStatusCode } from "@contracts/ipc";
import {
  IconGitBranch,
  IconRefresh,
  IconX,
  IconLoader2,
  IconArrowDown,
  IconArrowUp,
  IconCheck,
  IconSparkles,
  IconFile,
} from "@renderer/lib/icons.js";

/** Compact per-status glyphs for the file-list badges. */
const STATUS_LABEL: Record<GitStatusCode, string> = {
  modified: "改",
  added: "增",
  deleted: "删",
  renamed: "重",
  copied: "复",
  unmerged: "冲",
  untracked: "?",
  ignored: "略",
  unmodified: "",
};

const STATUS_COLOR: Record<string, string> = {
  deleted: "bg-danger/15 text-danger",
  added: "bg-accent/15 text-accent",
  unmerged: "bg-warning/15 text-warning",
  untracked: "bg-surface-hover text-content-muted",
  modified: "bg-surface-hover text-content-muted",
  renamed: "bg-surface-hover text-content-muted",
  copied: "bg-surface-hover text-content-muted",
};

export function MobileGitScreen() {
  const activeProjectId = useSessionStore((s) => s.activeProjectId);
  const projects = useSessionStore((s) => s.projects);
  const project = useMemo(
    () => projects.find((p) => p.id === activeProjectId) ?? null,
    [projects, activeProjectId],
  );

  const [repos, setRepos] = useState<GitRepo[]>([]);
  const [repoPath, setRepoPath] = useState<string | null>(null);
  const [status, setStatus] = useState<GitStatusResult | null>(null);
  const [tab, setTab] = useState<"changes" | "staged">("changes");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [genLoading, setGenLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diffPath, setDiffPath] = useState<{ path: string; staged: boolean } | null>(null);

  // Discover repos when the project changes.
  const discover = useCallback(async () => {
    if (!project) return;
    try {
      const res = await api.git.discoverRepos({ projectPath: project.path });
      setRepos(res.repos);
      if (res.repos.length > 0) setRepoPath(res.repos[0].path);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [project]);

  useEffect(() => {
    setRepoPath(null);
    setStatus(null);
    void discover();
  }, [discover]);

  // Refresh status whenever repoPath changes (and expose a manual refresh).
  const refresh = useCallback(async () => {
    if (!repoPath) return;
    try {
      const res = await api.git.status({ repoPath });
      setStatus(res.status);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [repoPath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Same staged/unstaged split as the desktop GitRepoCard.
  const staged = useMemo(
    () => status?.files.filter((f) => f.index !== "unmodified" && f.index !== "untracked") ?? [],
    [status],
  );
  const unstaged = useMemo(
    () => status?.files.filter((f) => f.workingTree !== "unmodified" || f.index === "untracked") ?? [],
    [status],
  );
  const list = tab === "changes" ? unstaged : staged;

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const stage = (path: string) =>
    run("stage", () => api.git.stage({ repoPath: repoPath!, filePaths: [path] }));
  const unstage = (path: string) =>
    run("unstage", () => api.git.unstage({ repoPath: repoPath!, filePaths: [path] }));

  const commit = (andPush: boolean) =>
    run(andPush ? "commit+push" : "commit", async () => {
      if (!message.trim()) {
        setError("请输入提交信息");
        setBusy(null);
        return;
      }
      const res = await api.git.commit({ repoPath: repoPath!, message: message.trim() });
      if (!res.ok) throw new Error(res.error ?? "提交失败");
      setMessage("");
      if (andPush) {
        const pushRes = await api.git.push({ repoPath: repoPath! });
        if (!pushRes.ok) throw new Error(pushRes.error ?? "推送失败");
      }
    });

  const pull = () =>
    run("pull", async () => {
      const res = await api.git.pull({ repoPath: repoPath! });
      if (!res.ok) throw new Error(res.error ?? "拉取失败");
    });

  const generate = async () => {
    setGenLoading(true);
    setError(null);
    try {
      // customModelId/customModelRole: null = the built-in model (the desktop
      // git panel passes the user's configured custom model; the mobile panel
      // keeps the default — same shape on the wire).
      const res = await api.git.generateCommitMessage({
        repoPath: repoPath!,
        customModelId: null,
        customModelRole: null,
        prompt: "",
      });
      if (res.ok && res.message) setMessage(res.message);
      else if (!res.ok) setError(res.error ?? "生成失败");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setGenLoading(false);
    }
  };

  return (
    <div className="flex h-full min-w-0 min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-edge px-3">
        <span className="text-sm font-medium text-content">Git</span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => void refresh()}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-content-muted hover:bg-surface-muted"
          title="刷新"
        >
          <IconRefresh size={14} />
        </button>
      </div>

      {!project ? (
        <div className="p-6 text-center text-xs text-content-subtle">请先选择一个项目</div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col px-3 py-2">
          {/* repo selector */}
          {repos.length > 1 && (
            <select
              value={repoPath ?? ""}
              onChange={(e) => setRepoPath(e.target.value)}
              className="mb-2 w-full rounded-lg border border-input-edge bg-surface px-2 py-1.5 text-xs text-content outline-none"
            >
              {repos.map((r) => (
                <option key={r.path} value={r.path}>
                  {r.name}
                </option>
              ))}
            </select>
          )}

          {/* branch + ahead/behind */}
          {status && (
            <div className="mb-2 flex items-center gap-2 text-xs text-content-muted">
              <IconGitBranch size={13} className="shrink-0" />
              <span className="min-w-0 truncate font-mono text-content" title={status.branch}>
                {status.branch || "(无分支)"}
              </span>
              {status.ahead > 0 && (
                <span className="flex items-center gap-0.5 text-accent">
                  <IconArrowUp size={11} /> {status.ahead}
                </span>
              )}
              {status.behind > 0 && (
                <span className="flex items-center gap-0.5 text-warning">
                  <IconArrowDown size={11} /> {status.behind}
                </span>
              )}
            </div>
          )}

          {/* segmented control */}
          <div className="mb-2 flex shrink-0 gap-1 rounded-lg bg-surface-muted p-1 text-xs">
            <button
              type="button"
              onClick={() => setTab("changes")}
              className={cn(
                "flex-1 rounded px-2 py-1.5",
                tab === "changes" ? "bg-surface text-content shadow-sm" : "text-content-muted",
              )}
            >
              更改 {unstaged.length > 0 ? `(${unstaged.length})` : ""}
            </button>
            <button
              type="button"
              onClick={() => setTab("staged")}
              className={cn(
                "flex-1 rounded px-2 py-1.5",
                tab === "staged" ? "bg-surface text-content shadow-sm" : "text-content-muted",
              )}
            >
              已暂存 {staged.length > 0 ? `(${staged.length})` : ""}
            </button>
          </div>

          {/* file list */}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {list.length === 0 ? (
              <div className="p-6 text-center text-xs text-content-subtle">
                {tab === "changes" ? "没有未暂存的更改" : "没有已暂存的更改"}
              </div>
            ) : (
              list.map((f) => {
                const code = tab === "changes" ? f.workingTree : f.index;
                return (
                  <div key={f.path} className="flex items-center gap-2 border-b border-edge px-1 py-2">
                    <span
                      className={cn(
                        "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold",
                        STATUS_COLOR[code] ?? "bg-surface-hover text-content-muted",
                      )}
                    >
                      {STATUS_LABEL[code] ?? "?"}
                    </span>
                    <button
                      type="button"
                      onClick={() => setDiffPath({ path: f.path, staged: tab === "staged" })}
                      className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-left text-xs text-content"
                      title={f.path}
                    >
                      <IconFile size={12} className="shrink-0 text-content-subtle" />
                      <span className="truncate">{f.path}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => (tab === "changes" ? void stage(f.path) : void unstage(f.path))}
                      disabled={!!busy}
                      className="shrink-0 rounded border border-edge px-2 py-1 text-[10px] text-content-muted disabled:opacity-50"
                    >
                      {tab === "changes" ? "暂存" : "取消"}
                    </button>
                  </div>
                );
              })
            )}
          </div>

          {/* commit message */}
          <div className="shrink-0 border-t border-edge pt-2">
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="提交信息…"
              rows={2}
              className="mb-2 w-full resize-none rounded-lg border border-input-edge bg-surface-muted px-2 py-1.5 text-xs text-content outline-none focus:border-accent"
            />
            <button
              type="button"
              onClick={() => void generate()}
              disabled={genLoading || staged.length === 0 || !repoPath}
              className="mb-2 flex w-full items-center justify-center gap-1 rounded-lg border border-edge px-2 py-1.5 text-xs text-content-muted disabled:opacity-50"
            >
              <IconSparkles size={12} />
              {genLoading ? "AI 生成中…" : "AI 生成提交信息"}
            </button>
            {error && <p className="mb-2 text-xs text-danger">{error}</p>}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void pull()}
                disabled={!!busy || !repoPath}
                className="flex flex-1 items-center justify-center gap-1 rounded-lg border border-edge px-2 py-2 text-xs text-content-muted disabled:opacity-50"
              >
                {busy === "pull" ? <IconLoader2 size={12} className="animate-spin" /> : <IconArrowDown size={12} />}
                拉取
              </button>
              <button
                type="button"
                onClick={() => void commit(true)}
                disabled={!!busy || staged.length === 0 || !message.trim()}
                className="flex flex-[2] items-center justify-center gap-1 rounded-lg bg-accent px-2 py-2 text-xs font-semibold text-surface disabled:opacity-40"
              >
                {busy === "commit+push" ? <IconLoader2 size={12} className="animate-spin" /> : <IconCheck size={12} />}
                提交并推送
              </button>
            </div>
          </div>
        </div>
      )}

      {diffPath && repoPath && (
        <DiffOverlay repoPath={repoPath} file={diffPath} onClose={() => setDiffPath(null)} />
      )}
    </div>
  );
}

function DiffOverlay({
  repoPath,
  file,
  onClose,
}: {
  repoPath: string;
  file: { path: string; staged: boolean };
  onClose: () => void;
}) {
  const [patch, setPatch] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void api.git
      .diff({ repoPath, filePath: file.path, staged: file.staged })
      .then((res) => {
        if (!cancelled) setPatch(res.patch);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [repoPath, file.path, file.staged]);
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-surface">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-edge px-2">
        <button
          type="button"
          onClick={onClose}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-content-muted hover:bg-surface-muted"
          aria-label="关闭"
        >
          <IconX size={16} />
        </button>
        <div className="min-w-0 flex-1 truncate text-center font-mono text-xs text-content">
          {file.path}
        </div>
        <span className="w-8" />
      </div>
      <pre className="min-h-0 flex-1 overflow-auto px-3 py-2 font-mono text-[11px] leading-relaxed text-content-muted">
        {loading ? "加载中…" : patch || "(无差异)"}
      </pre>
    </div>
  );
}
