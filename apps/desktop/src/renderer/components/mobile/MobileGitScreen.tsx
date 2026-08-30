/**
 * MobileGitScreen — the mobile git panel (bottom-nav page of the web shell).
 *
 * A focused, mobile-first take on the desktop GitRepoCard: discover repos under
 * the active project, switch branches (bottom-sheet picker with search /
 * remote-tracking / new-branch flows), show changed/staged files with stage
 * toggles, edit a commit message (with AI generation), commit /
 * commit-and-push, and sync with the remote. Actions live in two contextual
 * zones instead of one button soup: the branch bar hosts the remote ops
 * (拉取 / 推送 / 同步, next to the ahead/behind counts they resolve), and the
 * commit box hosts the staging ops (提交 / 提交并推送). The operations map 1:1
 * to the `git:*` mobile RPC whitelist, which reuses the desktop git module's
 * helpers (same path guard, same simple-git loader, same LLM commit-message
 * core) — behavior is identical, only the transport differs.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "@renderer/lib/api.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useToastStore } from "@renderer/stores/toastStore.js";
import { cn } from "@renderer/lib/cn.js";
import type { GitRepo, GitStatusResult, GitStatusCode, GitBranchInfo, GitBranchListResult } from "@contracts/ipc";
import {
  IconGitBranch,
  IconRefresh,
  IconX,
  IconLoader2,
  IconArrowDown,
  IconArrowUp,
  IconArrowsExchange,
  IconCheck,
  IconSparkles,
  IconFile,
  IconCopy,
  IconChevronDown,
  IconTag,
  IconPlus,
} from "@renderer/lib/icons.js";
import { copyText } from "@renderer/lib/clipboard.js";
import { browserUuid } from "@renderer/lib/uuid.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { parsePatch, PatchRows } from "./PatchView.js";

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
  const { t } = useI18n();
  const activeProjectId = useSessionStore((s) => s.activeProjectId);
  const projects = useSessionStore((s) => s.projects);
  const commitGenModel = useSessionStore((s) => s.commitGenModel);
  const commitGenPrompt = useSessionStore((s) => s.commitGenPrompt);
  const project = useMemo(
    () => projects.find((p) => p.id === activeProjectId) ?? null,
    [projects, activeProjectId],
  );

  const [repos, setRepos] = useState<GitRepo[]>([]);
  const [repoPath, setRepoPath] = useState<string | null>(null);
  // True while repo discovery is in flight — distinguishes "still looking"
  // from "looked and found none" (the latter shows the no-repo empty state).
  const [reposLoading, setReposLoading] = useState(true);
  const [status, setStatus] = useState<GitStatusResult | null>(null);
  const [tab, setTab] = useState<"changes" | "staged">("changes");
  const [message, setMessage] = useState("");
  // Commit message textarea: 1 row by default, auto-grows with the content up
  // to ~4 rows (keeps the bottom bar compact; mirrors the desktop CommitBox).
  const msgRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const ta = msgRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    const lineHeight = parseFloat(getComputedStyle(ta).lineHeight) || 18;
    ta.style.height = `${Math.max(Math.min(ta.scrollHeight, lineHeight * 4), 30)}px`;
  }, [message]);
  const [busy, setBusy] = useState<string | null>(null);
  const [genLoading, setGenLoading] = useState(false);
  // Set when the user stops an in-flight generation: the aborted call's
  // result/error must NOT overwrite the commit message box (mirrors the
  // desktop GitRepoCard CommitBox).
  const genCancelledRef = useRef(false);
  const genRequestIdRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [diffPath, setDiffPath] = useState<{ path: string; staged: boolean } | null>(null);
  // Branch-switcher bottom sheet (opened by tapping the branch in the status
  // bar). The heavy lifting (list / search / checkout / create) lives in
  // BranchSheet; the parent only refreshes after a successful switch.
  const [branchSheetOpen, setBranchSheetOpen] = useState(false);

  // Discover repos when the project changes.
  const discover = useCallback(async () => {
    if (!project) {
      setReposLoading(false);
      return;
    }
    setReposLoading(true);
    try {
      const res = await api.git.discoverRepos({ projectPath: project.path });
      setRepos(res.repos);
      if (res.repos.length > 0) setRepoPath(res.repos[0].path);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setReposLoading(false);
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

  // Cross-client auto-refresh: the host broadcasts `git.changed` after ANY
  // client's git mutation (desktop panel, another phone), which bumps this
  // per-repo version in the store. Re-running status keeps this screen fresh
  // when, say, the agent (or the PC) commits while the phone sits on the Git
  // tab. Own mutations echo back too — idempotent extra refresh.
  const gitChangeVersion = useSessionStore(
    (s) => (repoPath ? s.gitChangeVersionByRepo[repoPath] ?? 0 : 0),
  );
  useEffect(() => {
    void refresh();
  }, [gitChangeVersion, refresh]);

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

  // Lightweight success feedback for remote/commit ops (3s toast). Errors
  // still go through the inline ErrorBanner for full detail + copy.
  const toast = (title: string) =>
    useToastStore.getState().push({ kind: "info", title, duration: 3000 });

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
      toast("已提交");
      if (andPush) {
        const pushRes = await api.git.push({ repoPath: repoPath! });
        if (!pushRes.ok) throw new Error(pushRes.error ?? "推送失败");
        toast("已推送至远端");
      }
    });

  /** Pull only — never pushes. A merge conflict surfaces as an error banner
   *  and stops there (nothing is auto-committed past a conflict). */
  const pull = () =>
    run("pull", async () => {
      const res = await api.git.pull({ repoPath: repoPath! });
      if (!res.ok) throw new Error(res.error ?? "拉取失败");
      if (res.conflict) {
        setError(`拉取后产生 ${res.conflictedFiles?.length ?? 0} 个冲突文件，请先解决冲突`);
        return;
      }
      toast("拉取完成");
    });

  /** Push only — local commits to the remote. */
  const push = () =>
    run("push", async () => {
      const res = await api.git.push({ repoPath: repoPath! });
      if (!res.ok) throw new Error(res.error ?? "推送失败");
      toast("推送完成");
    });

  /** Pull then push (desktop's "sync"). Never pushes past a merge conflict. */
  const sync = () =>
    run("sync", async () => {
      const pullRes = await api.git.pull({ repoPath: repoPath! });
      if (!pullRes.ok) throw new Error(pullRes.error ?? "拉取失败");
      if (pullRes.conflict) {
        setError(`拉取后产生 ${pullRes.conflictedFiles?.length ?? 0} 个冲突文件，请先解决冲突`);
        return;
      }
      const pushRes = await api.git.push({ repoPath: repoPath! });
      if (!pushRes.ok) throw new Error(pushRes.error ?? "推送失败");
      toast("同步完成");
    });

  const generate = async () => {
    setGenLoading(true);
    genCancelledRef.current = false;
    setError(null);
    // browserUuid, not crypto.randomUUID: the mobile shell runs over plain
    // HTTP on the LAN where crypto.randomUUID is undefined (non-secure
    // context) and the direct call crashes with a TypeError.
    const requestId = browserUuid();
    genRequestIdRef.current = requestId;
    try {
      // commitGenModel is stored as "configId:roleKey" — split it back, same as
      // the desktop GitRepoCard. Null means no model is configured: the main-
      // process core would fall back to the built-in Claude binary, which on a
      // machine without a Claude login errors with "Not logged in · Please run
      // login" — so guard here with an actionable message instead.
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
        setError("未配置提交信息生成模型，请在桌面端 设置 → Git 中选择");
        return;
      }
      const res = await api.git.generateCommitMessage({
        repoPath: repoPath!,
        customModelId,
        customModelRole,
        prompt: commitGenPrompt,
        requestId,
      });
      if (genCancelledRef.current) return; // aborted by the user — keep the box as-is
      if (res.ok && res.message) setMessage(res.message);
      else if (!res.ok) setError(res.error ?? "生成失败");
    } catch (err) {
      if (!genCancelledRef.current) setError((err as Error).message);
    } finally {
      genRequestIdRef.current = null;
      setGenLoading(false);
    }
  };

  /** Stop the in-flight generation (hover affordance on the generate button). */
  const stopGenerate = () => {
    genCancelledRef.current = true;
    const id = genRequestIdRef.current;
    if (id) void api.git.cancelGenerateCommitMessage({ requestId: id }).catch(() => {});
    setGenLoading(false);
  };

  return (
    <div className="flex h-full min-w-0 min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-edge px-3">
        <span className="text-sm font-medium text-content">Git</span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => void refresh()}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-content-muted active:bg-surface-muted"
          title="刷新"
          aria-label="刷新"
        >
          <IconRefresh size={15} />
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

          {/* Branch status + remote actions — one bar. The branch chip is a
              tappable button: it opens the branch-switcher sheet (chevron is
              the affordance). The ahead/behind counts sit OUTSIDE the button —
              they are read-only state, not part of the tap target. The three
              sync buttons dock right of the bar and reuse the ↑/↓ arrows so
              each button pairs with the count it resolves (推送 ↔ ↑领先,
              拉取 ↔ ↓落后). */}
          {status && (
            <div className="mb-2 flex shrink-0 items-center gap-2">
              <div className="flex min-w-0 flex-1 items-center gap-1 text-xs text-content-muted">
                <button
                  type="button"
                  onClick={() => setBranchSheetOpen(true)}
                  disabled={!!busy || !repoPath}
                  title={t("ide.git.switchBranch")}
                  className="flex min-w-0 items-center gap-1.5 rounded-lg py-1 pl-1 pr-1.5 active:bg-surface-hover disabled:opacity-50"
                >
                  <IconGitBranch size={13} className="shrink-0" />
                  <span className="min-w-0 max-w-[38vw] truncate font-mono text-content">
                    {status.branch || t("ide.git.noBranches")}
                  </span>
                  <IconChevronDown size={12} className="shrink-0 text-content-subtle" />
                </button>
                {status.ahead > 0 && (
                  <span
                    className="flex shrink-0 items-center gap-0.5 text-accent"
                    title={`领先远端 ${status.ahead} 个提交`}
                  >
                    <IconArrowUp size={11} /> {status.ahead}
                  </span>
                )}
                {status.behind > 0 && (
                  <span
                    className="flex shrink-0 items-center gap-0.5 text-warning"
                    title={`落后远端 ${status.behind} 个提交`}
                  >
                    <IconArrowDown size={11} /> {status.behind}
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() => void pull()}
                disabled={!!busy || !repoPath}
                title="拉取远端更新"
                className="flex h-9 shrink-0 items-center gap-1 rounded-lg border border-edge px-2.5 text-xs text-content-muted active:bg-surface-hover disabled:opacity-50"
              >
                {busy === "pull" ? (
                  <IconLoader2 size={12} className="animate-spin" />
                ) : (
                  <IconArrowDown size={12} />
                )}
                拉取
              </button>
              <button
                type="button"
                onClick={() => void push()}
                disabled={!!busy || !repoPath}
                title="推送本地提交到远端"
                className="flex h-9 shrink-0 items-center gap-1 rounded-lg border border-edge px-2.5 text-xs text-content-muted active:bg-surface-hover disabled:opacity-50"
              >
                {busy === "push" ? (
                  <IconLoader2 size={12} className="animate-spin" />
                ) : (
                  <IconArrowUp size={12} />
                )}
                推送
              </button>
              <button
                type="button"
                onClick={() => void sync()}
                disabled={!!busy || !repoPath}
                title="拉取远端更新后推送本地提交"
                className="flex h-9 shrink-0 items-center gap-1 rounded-lg border border-edge px-2.5 text-xs text-content-muted active:bg-surface-hover disabled:opacity-50"
              >
                {busy === "sync" ? (
                  <IconLoader2 size={12} className="animate-spin" />
                ) : (
                  <IconArrowsExchange size={12} />
                )}
                同步
              </button>
            </div>
          )}

          {/* Discovery / no-repo empty states replace the whole working area —
              the tabs, file list, and commit box are meaningless without a
              repo. */}
          {reposLoading ? (
            <div className="flex min-h-0 flex-1 items-center justify-center text-xs text-content-subtle">
              正在发现仓库…
            </div>
          ) : repos.length === 0 ? (
            <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs text-content-subtle">
              此项目下未发现 Git 仓库
            </div>
          ) : (
            <>
          {/* segmented control */}
          <div className="mb-2 flex shrink-0 gap-1 rounded-lg bg-surface-muted p-1 text-xs">
            <button
              type="button"
              onClick={() => setTab("changes")}
              className={cn(
                "flex-1 rounded px-2 py-2",
                tab === "changes" ? "bg-surface text-content shadow-sm" : "text-content-muted",
              )}
            >
              更改 {unstaged.length > 0 ? `(${unstaged.length})` : ""}
            </button>
            <button
              type="button"
              onClick={() => setTab("staged")}
              className={cn(
                "flex-1 rounded px-2 py-2",
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
                      className="h-8 shrink-0 rounded-lg border border-edge px-3 text-[11px] text-content-muted active:bg-surface-hover disabled:opacity-50"
                    >
                      {tab === "changes" ? "暂存" : "取消"}
                    </button>
                  </div>
                );
              })
            )}
          </div>

          {/* Commit message — single-row textarea that auto-grows. The
              AI-generate action is a standalone full-width button BELOW the
              input (not an absolute-positioned overlay): the overlay variant
              sat inside the textarea's padding box, where phone browsers
              frequently swallowed the tap (IME/long-press selection). Same
              affordances as the desktop CommitBox — tap again to stop. */}
          <div className="shrink-0 border-t border-edge pt-2">
            <textarea
              ref={msgRef}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="提交信息…"
              rows={1}
              className="mb-2 w-full resize-none overflow-hidden rounded-lg border border-input-edge bg-surface-muted px-2 py-1.5 text-xs leading-relaxed text-content outline-none focus:border-accent"
            />
            {commitGenModel && (
              <button
                type="button"
                onClick={() => (genLoading ? stopGenerate() : void generate())}
                disabled={!repoPath || staged.length === 0}
                title={genLoading ? "停止生成" : "使用 AI 生成提交信息"}
                aria-label={genLoading ? "停止生成" : "使用 AI 生成提交信息"}
                className="mb-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-edge px-2 py-1.5 text-xs text-content-muted transition-colors hover:bg-surface-hover hover:text-accent disabled:opacity-40"
              >
                {genLoading ? (
                  <>
                    <IconLoader2 size={14} className="animate-spin" />
                    停止生成
                  </>
                ) : (
                  <>
                    <IconSparkles size={14} />
                    AI 生成提交信息
                  </>
                )}
              </button>
            )}
            {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void commit(false)}
                disabled={!!busy || staged.length === 0 || !message.trim()}
                className="flex flex-1 items-center justify-center gap-1 rounded-lg border border-edge px-2 py-2.5 text-xs text-content-muted active:bg-surface-hover disabled:opacity-50"
              >
                {busy === "commit" ? <IconLoader2 size={12} className="animate-spin" /> : <IconCheck size={12} />}
                提交
              </button>
              <button
                type="button"
                onClick={() => void commit(true)}
                disabled={!!busy || staged.length === 0 || !message.trim()}
                className="flex flex-[1.4] items-center justify-center gap-1 rounded-lg bg-accent px-2 py-2.5 text-xs font-semibold text-surface disabled:opacity-40"
              >
                {busy === "commit+push" ? <IconLoader2 size={12} className="animate-spin" /> : <IconCheck size={12} />}
                提交并推送
              </button>
            </div>
          </div>
            </>
          )}
        </div>
      )}

      {branchSheetOpen && repoPath && (
        <BranchSheet
          repoPath={repoPath}
          onClose={() => setBranchSheetOpen(false)}
          onChanged={refresh}
        />
      )}

      {diffPath && repoPath && (
        <DiffOverlay repoPath={repoPath} file={diffPath} onClose={() => setDiffPath(null)} />
      )}
    </div>
  );
}

/**
 * BranchSheet — the bottom-sheet branch switcher, opened from the branch chip
 * in the status bar. Lists local branches / remote branches / tags with a
 * search filter and a "new branch" flow, reusing the desktop picker's ref
 * semantics: local → `git checkout <name>`; remote → switch to the same-named
 * local branch when one exists, otherwise create a tracking branch; tag →
 * detached-HEAD checkout. Chrome follows the mobile shell's muted surface
 * (the same layer as the top bar / drawer / settings sheet), with wells and
 * press states inverted one step (surface / hover).
 */
function BranchSheet({
  repoPath,
  onClose,
  onChanged,
}: {
  repoPath: string;
  onClose: () => void;
  /** Called after a successful checkout so the parent refreshes its status. */
  onChanged: () => Promise<void> | void;
}) {
  const { t } = useI18n();
  const [branches, setBranches] = useState<GitBranchListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  // Display name of the ref with an in-flight checkout — drives the per-row
  // spinner and disables the rest of the list while a switch is running.
  const [checkingOut, setCheckingOut] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // New-branch flow: collapsed "+" row ↔ expanded inline input (autofocus).
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.git
      .listBranches({ repoPath })
      .then((res) => {
        if (!cancelled) setBranches(res.branches);
      })
      .catch(() => {
        if (!cancelled) setBranches(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [repoPath]);

  const checkout = async (
    branch: string,
    opts?: { newBranch?: string; busyKey?: string },
  ) => {
    if (checkingOut) return;
    setCheckingOut(opts?.busyKey ?? opts?.newBranch ?? branch);
    setError(null);
    try {
      const res = await api.git.checkout({ repoPath, branch, newBranch: opts?.newBranch });
      if (!res.ok) {
        setError(res.error ?? t("ide.git.checkoutFailed"));
        return;
      }
      useToastStore.getState().push({
        kind: "info",
        title: t("ide.git.switchedTo", { branch: opts?.newBranch ?? branch }),
        duration: 3000,
      });
      await onChanged();
      onClose();
    } catch (err) {
      setError((err as Error).message ?? t("ide.git.checkoutFailed"));
    } finally {
      setCheckingOut(null);
    }
  };

  /** Same ref semantics as the desktop picker's BranchGroup. */
  const pick = (b: GitBranchInfo, localNames: Set<string>) => {
    if (b.current || checkingOut) return;
    if (b.type === "remote") {
      // `origin/foo` -> short name `foo`. Track if no local branch yet.
      const shortName = b.name.includes("/") ? b.name.slice(b.name.indexOf("/") + 1) : b.name;
      if (localNames.has(shortName)) {
        void checkout(shortName);
      } else {
        void checkout(b.name, { newBranch: shortName, busyKey: b.name });
      }
    } else {
      void checkout(b.name);
    }
  };

  const createNew = () => {
    const name = newName.trim();
    if (!name || checkingOut) return;
    setCreating(false);
    setNewName("");
    void checkout("HEAD", { newBranch: name });
  };

  // Search filter (name + commit subject), same fields as the desktop picker.
  const filtered = useMemo(() => {
    if (!branches) return null;
    const q = query.trim().toLowerCase();
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
  }, [branches, query]);

  const localNames = useMemo(
    () => new Set(branches?.local.map((b) => b.name) ?? []),
    [branches],
  );

  const groups: { label: string; items: GitBranchInfo[] }[] | null = filtered
    ? [
        { label: t("ide.git.localBranches"), items: filtered.local },
        { label: t("ide.git.remoteBranches"), items: filtered.remote },
        { label: t("ide.git.tags"), items: filtered.tags },
      ]
    : null;
  const totalRefs = filtered
    ? filtered.local.length + filtered.remote.length + filtered.tags.length
    : 0;

  return (
    <div className="fixed inset-0 z-50">
      <button
        type="button"
        aria-label="关闭"
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
      />
      <div className="absolute inset-x-0 bottom-0 flex max-h-[78vh] flex-col rounded-t-2xl border-t border-edge bg-surface-muted shadow-2xl">
        <div className="flex justify-center pb-1 pt-2">
          <span className="h-1 w-8 rounded-full bg-edge" />
        </div>
        <div className="flex h-9 shrink-0 items-center justify-between px-4">
          <span className="text-sm font-semibold text-content">{t("ide.git.switchBranch")}</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-content-muted active:bg-surface-hover"
          >
            <IconX size={16} />
          </button>
        </div>

        {/* Search — filters by branch/tag name and commit subject. */}
        <div className="shrink-0 px-4 pb-2 pt-1">
          <div className="flex h-10 items-center gap-2 rounded-xl border border-edge bg-surface/60 px-3">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("ide.git.searchBranches")}
              // text-base: iOS Safari zooms on focus below 16px (same as the
              // drawer's search box).
              className="min-w-0 flex-1 bg-transparent text-base text-content outline-none placeholder:text-content-subtle"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="清除搜索"
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-content-subtle active:bg-surface-hover"
              >
                <IconX size={13} />
              </button>
            )}
          </div>
        </div>

        {/* New branch — a collapsed "+" row keeps the sheet calm for the
            common switch flow; tapping expands an inline input. */}
        <div className="shrink-0 px-4 pb-2">
          {creating ? (
            <div className="flex items-center gap-2">
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && createNew()}
                placeholder={t("ide.git.newBranchNamePlaceholder")}
                className="h-10 min-w-0 flex-1 rounded-xl border border-input-edge bg-surface/60 px-3 text-base text-content outline-none focus:border-accent"
              />
              <button
                type="button"
                onClick={createNew}
                disabled={!newName.trim() || !!checkingOut}
                className="h-10 shrink-0 rounded-xl border border-edge px-3 text-xs text-content active:bg-surface-hover disabled:opacity-50"
              >
                {t("ide.git.createBranchAction")}
              </button>
              <button
                type="button"
                onClick={() => {
                  setCreating(false);
                  setNewName("");
                }}
                aria-label="取消新建分支"
                className="flex h-10 w-9 shrink-0 items-center justify-center rounded-xl text-content-muted active:bg-surface-hover"
              >
                <IconX size={15} />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setCreating(true)}
              disabled={!!checkingOut}
              className="flex min-h-[40px] w-full items-center gap-1.5 rounded-lg px-1 text-left text-xs text-content-muted active:bg-surface-hover disabled:opacity-50"
            >
              <IconPlus size={14} className="shrink-0" />
              {t("ide.git.newBranch")}
            </button>
          )}
        </div>

        {error && (
          <div className="mx-4 mb-2 shrink-0">
            <ErrorBanner message={error} onDismiss={() => setError(null)} />
          </div>
        )}

        {/* Grouped ref list — 44px rows for touch targets, two-line rows so
            the commit subject survives narrow screens (the desktop picker
            truncates it to the right; that doesn't fit a phone). */}
        <div className="min-h-0 flex-1 overflow-y-auto pb-4">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <IconLoader2 size={16} className="animate-spin text-content-subtle" />
            </div>
          ) : !filtered ? (
            <div className="py-8 text-center text-xs text-content-subtle">
              {t("ide.git.cannotReadBranches")}
            </div>
          ) : totalRefs === 0 ? (
            <div className="py-8 text-center text-xs text-content-subtle">{t("ide.git.noMatch")}</div>
          ) : (
            groups?.map(({ label, items }) =>
              items.length === 0 ? null : (
                <div key={label}>
                  <div className="px-4 pb-0.5 pt-2 text-[10px] font-medium uppercase tracking-wide text-content-subtle">
                    {label}
                  </div>
                  {items.map((b) => {
                    const switching = checkingOut === b.name;
                    return (
                      <button
                        key={`${b.type}/${b.name}`}
                        type="button"
                        onClick={() => pick(b, localNames)}
                        disabled={!!checkingOut}
                        className={cn(
                          "flex min-h-[44px] w-full items-center gap-2.5 px-4 text-left active:bg-surface-hover disabled:opacity-60",
                          b.current && "text-accent",
                        )}
                      >
                        {switching ? (
                          <IconLoader2 size={14} className="shrink-0 animate-spin" />
                        ) : b.type === "tag" ? (
                          <IconTag size={14} className="shrink-0 text-content-subtle" />
                        ) : (
                          <IconGitBranch size={14} className="shrink-0 text-content-subtle" />
                        )}
                        <span className="min-w-0 flex-1">
                          <span
                            className={cn(
                              "block truncate font-mono text-xs",
                              b.current ? "text-accent" : "text-content",
                            )}
                          >
                            {b.name}
                          </span>
                          {b.label && (
                            <span className="block truncate text-[10px] text-content-subtle">
                              {b.commit} {b.label}
                            </span>
                          )}
                        </span>
                        {b.current && <IconCheck size={14} className="shrink-0" />}
                      </button>
                    );
                  })}
                </div>
              ),
            )
          )}
        </div>
      </div>
    </div>
  );
}

/** Git-operation error banner: multi-line-friendly message with copy (for
 *  pasting the failure into a search / chat) and dismiss affordances. Copy
 *  uses the shared helper so it works over the mobile shell's plain-HTTP
 *  LAN transport, where navigator.clipboard is unavailable. */function ErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    if (await copyText(message)) setCopied(true);
  };

  return (
    <div className="mb-2 flex items-start gap-1 rounded-lg border border-danger/30 bg-danger/10 px-2 py-1.5 text-xs text-danger">
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-all">{message}</span>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={copied ? "已复制" : "复制错误信息"}
        title={copied ? "已复制" : "复制错误信息"}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-danger/70 hover:bg-danger/10 hover:text-danger"
      >
        {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="关闭错误提示"
        title="关闭错误提示"
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-danger/70 hover:bg-danger/10 hover:text-danger"
      >
        <IconX size={13} />
      </button>
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
  const rows = useMemo(() => parsePatch(patch), [patch]);
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
      {loading ? (
        <div className="flex flex-1 items-center justify-center text-xs text-content-subtle">加载中…</div>
      ) : rows.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-xs text-content-subtle">(无差异)</div>
      ) : (
        <PatchRows rows={rows} />
      )}
    </div>
  );
}
