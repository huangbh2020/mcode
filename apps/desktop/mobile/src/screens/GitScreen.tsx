/**
 * GitScreen — the mobile git commit panel (full-screen page).
 *
 * A focused, mobile-first take on the desktop GitRepoCard: discover repos under
 * the active project, show changed/staged files with stage toggles, edit a
 * commit message (with AI generation), and commit / commit-and-push / pull. The
 * operations map 1:1 to the `git:*` mobile RPC whitelist (which reuses the
 * desktop git module's helpers, so behavior is identical).
 */
import { useCallback, useEffect, useState } from "react";
import { mobileApi } from "../lib/mobileApi.js";
import { useMobileStore } from "../stores/mobileStore.js";

// The contracts types are JSON shapes over the wire; mirror the fields we use.
interface GitFile {
  path: string;
  statusCode: string;
  staged: boolean;
  additions?: number;
  deletions?: number;
}
interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  files: GitFile[];
}
interface GitRepo {
  path: string;
  name: string;
  isRepo: boolean;
}

const STATUS_LABEL: Record<string, string> = {
  M: "改",
  A: "增",
  D: "删",
  R: "重",
  C: "复",
  U: "冲",
  "?": "?",
};

interface Props {
  onBack: () => void;
}

export function GitScreen({ onBack }: Props) {
  const activeProjectId = useMobileStore((s) => s.activeProjectId);
  const projects = useMobileStore((s) => s.projects);
  const project = projects.find((p) => p.id === activeProjectId) ?? null;

  const [repos, setRepos] = useState<GitRepo[]>([]);
  const [repoPath, setRepoPath] = useState<string | null>(null);
  const [status, setStatus] = useState<GitStatus | null>(null);
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
      const { repos: found } = await mobileApi.git.discoverRepos({ projectPath: project.path });
      setRepos(found as GitRepo[]);
      if ((found as GitRepo[]).length > 0) setRepoPath((found as GitRepo[])[0].path);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [project]);

  useEffect(() => {
    void discover();
  }, [discover]);

  // Refresh status whenever repoPath changes (and expose a manual refresh).
  const refresh = useCallback(async () => {
    if (!repoPath) return;
    try {
      const { status: st } = await mobileApi.git.status({ repoPath });
      setStatus(st as GitStatus);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [repoPath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const changed = status?.files.filter((f) => !f.staged) ?? [];
  const staged = status?.files.filter((f) => f.staged) ?? [];
  const list = tab === "changes" ? changed : staged;

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

  const stage = (f: GitFile) => run("stage", () => mobileApi.git.stage({ repoPath, filePaths: [f.path] }));
  const unstage = (f: GitFile) => run("unstage", () => mobileApi.git.unstage({ repoPath, filePaths: [f.path] }));

  const commit = (andPush: boolean) =>
    run(andPush ? "commit+push" : "commit", async () => {
      if (!message.trim()) {
        setError("请输入提交信息");
        setBusy(null);
        return;
      }
      const res = (await mobileApi.git.commit({ repoPath, message })) as { ok: boolean; error?: string };
      if (!res.ok) throw new Error(res.error ?? "提交失败");
      setMessage("");
      if (andPush) {
        const pushRes = (await mobileApi.git.push({ repoPath })) as { ok: boolean; error?: string };
        if (!pushRes.ok) throw new Error(pushRes.error ?? "推送失败");
      }
    });

  const pull = () => run("pull", async () => {
    const res = (await mobileApi.git.pull({ repoPath })) as { ok: boolean; error?: string; conflict?: boolean };
    if (!res.ok) throw new Error(res.error ?? "拉取失败");
  });

  const generate = async () => {
    setGenLoading(true);
    setError(null);
    try {
      const res = (await mobileApi.git.generateCommitMessage({ repoPath })) as { ok: boolean; message?: string; error?: string };
      if (res.ok && res.message) setMessage(res.message);
      else if (!res.ok) setError(res.error ?? "生成失败");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setGenLoading(false);
    }
  };

  if (!project) {
    return (
      <Shell onBack={onBack} title="Git">
        <Empty>请先选择一个项目</Empty>
      </Shell>
    );
  }

  return (
    <Shell onBack={onBack} title="Git 提交" onRefresh={() => void refresh()}>
      {/* repo selector */}
      {repos.length > 1 && (
        <select
          value={repoPath ?? ""}
          onChange={(e) => setRepoPath(e.target.value)}
          className="mb-2 w-full rounded border border-edge bg-surface px-2 py-1.5 text-xs text-content"
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
          <span className="font-mono text-content">{status.branch || "(无分支)"}</span>
          {status.ahead > 0 && <span className="text-accent">↑{status.ahead}</span>}
          {status.behind > 0 && <span className="text-warning">↓{status.behind}</span>}
        </div>
      )}

      {/* segmented control */}
      <div className="mb-2 flex gap-1 rounded-lg bg-surface-muted p-1 text-xs">
        <button
          onClick={() => setTab("changes")}
          className={"flex-1 rounded px-2 py-1.5 " + (tab === "changes" ? "bg-surface text-content shadow-sm" : "text-content-muted")}
        >
          更改 {changed.length > 0 ? `(${changed.length})` : ""}
        </button>
        <button
          onClick={() => setTab("staged")}
          className={"flex-1 rounded px-2 py-1.5 " + (tab === "staged" ? "bg-surface text-content shadow-sm" : "text-content-muted")}
        >
          已暂存 {staged.length > 0 ? `(${staged.length})` : ""}
        </button>
      </div>

      {/* file list */}
      <div className="flex-1 overflow-y-auto">
        {list.length === 0 ? (
          <Empty>{tab === "changes" ? "没有未暂存的更改" : "没有已暂存的更改"}</Empty>
        ) : (
          list.map((f) => (
            <div key={f.path} className="flex items-center gap-2 border-b border-edge px-1 py-2">
              <span
                className={
                  "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold " +
                  (f.statusCode === "D" ? "bg-danger/15 text-danger" : f.statusCode === "A" ? "bg-accent/15 text-accent" : "bg-surface-hover text-content-muted")
                }
              >
                {STATUS_LABEL[f.statusCode] ?? f.statusCode}
              </span>
              <button
                onClick={() => setDiffPath({ path: f.path, staged: tab === "staged" })}
                className="min-w-0 flex-1 truncate text-left text-xs text-content"
                title={f.path}
              >
                {f.path}
              </button>
              {(f.additions !== undefined || f.deletions !== undefined) && (
                <span className="shrink-0 font-mono text-[10px]">
                  <span className="text-accent">+{f.additions ?? 0}</span>{" "}
                  <span className="text-danger">-{f.deletions ?? 0}</span>
                </span>
              )}
              <button
                onClick={() => (tab === "changes" ? void stage(f) : void unstage(f))}
                disabled={!!busy}
                className="shrink-0 rounded border border-edge px-2 py-1 text-[10px] text-content-muted disabled:opacity-50"
              >
                {tab === "changes" ? "暂存" : "取消"}
              </button>
            </div>
          ))
        )}
      </div>

      {/* commit message */}
      <div className="shrink-0 border-t border-edge pt-2" style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 0.5rem)" }}>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="提交信息…"
          rows={2}
          className="mb-2 w-full resize-none rounded border border-edge bg-surface-muted px-2 py-1.5 text-xs text-content outline-none focus:border-accent"
        />
        <button
          onClick={() => void generate()}
          disabled={genLoading || staged.length === 0}
          className="mb-2 w-full rounded border border-edge px-2 py-1.5 text-xs text-content-muted disabled:opacity-50"
        >
          {genLoading ? "AI 生成中…" : "✨ AI 生成提交信息"}
        </button>
        {error && <p className="mb-2 text-xs text-danger">{error}</p>}
        <div className="flex gap-2">
          <button
            onClick={() => void pull()}
            disabled={!!busy}
            className="flex-1 rounded border border-edge px-2 py-2 text-xs text-content-muted disabled:opacity-50"
          >
            {busy === "pull" ? "…" : "⬇ 拉取"}
          </button>
          <button
            onClick={() => void commit(true)}
            disabled={!!busy || staged.length === 0 || !message.trim()}
            className="flex-[2] rounded bg-accent px-2 py-2 text-xs font-semibold text-white disabled:opacity-40"
          >
            {busy === "commit+push" ? "…" : "✓ 提交并推送"}
          </button>
        </div>
      </div>

      {/* diff overlay */}
      {diffPath && <DiffOverlay repoPath={repoPath!} file={diffPath} onClose={() => setDiffPath(null)} />}
    </Shell>
  );
}

function Shell({ onBack, title, onRefresh, children }: { onBack: () => void; title: string; onRefresh?: () => void; children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col">
      <header className="no-select flex h-12 shrink-0 items-center gap-2 border-b border-edge bg-surface px-2">
        <button onClick={onBack} className="rounded p-2 text-content-muted hover:bg-surface-hover" aria-label="返回">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <div className="flex-1 text-sm font-medium text-content">{title}</div>
        {onRefresh && (
          <button onClick={onRefresh} className="rounded p-2 text-content-muted hover:bg-surface-hover" aria-label="刷新">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
          </button>
        )}
      </header>
      <div className="flex flex-1 flex-col overflow-hidden px-2 py-2">{children}</div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="p-6 text-center text-xs text-content-subtle">{children}</div>;
}

function DiffOverlay({ repoPath, file, onClose }: { repoPath: string; file: { path: string; staged: boolean }; onClose: () => void }) {
  const [patch, setPatch] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    setLoading(true);
    mobileApi.git
      .diff({ repoPath, filePath: file.path, staged: file.staged })
      .then((res) => setPatch((res as { patch: string }).patch))
      .finally(() => setLoading(false));
  }, [repoPath, file.path, file.staged]);
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-surface">
      <header className="no-select flex h-12 shrink-0 items-center gap-2 border-b border-edge px-2">
        <button onClick={onClose} className="rounded p-2 text-content-muted hover:bg-surface-hover" aria-label="关闭">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
        <div className="min-w-0 flex-1 truncate text-xs font-mono text-content">{file.path}</div>
      </header>
      <pre className="flex-1 overflow-auto px-3 py-2 font-mono text-[11px] leading-relaxed text-content-muted">
        {loading ? "加载中…" : patch || "(无差异)"}
      </pre>
    </div>
  );
}
