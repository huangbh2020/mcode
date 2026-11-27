/**
 * Empty-thread welcome — shown in the upper stage above the bottom-docked
 * composer on a fresh thread (方案 C · 项目上下文概览).
 *
 * Layout:
 *  - Header: project greeting + today's cross-session usage summary.
 *  - Context cards (2-column when a workspace path is available):
 *    - Left: live Git workspace status (branch, up to 4 changed files, and
 *      one-click review / commit-message / recent-commits prompts).
 *    - Right: quick-start prompts that pre-fill the composer without sending.
 *
 * Desktop-only IPCs (`usage.stats`, `git.status`) are guarded by `isElectron`
 * so the web/mobile shell degrades cleanly without throwing.
 */
import { useEffect, useState } from "react";
import { api } from "@renderer/lib/api.js";
import { isElectron } from "@renderer/lib/platform.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import { fmtTokens } from "@renderer/lib/contextWindow.js";
import { cn } from "@renderer/lib/cn.js";
import type { GitFileStatus, GitStatusCode, GitStatusResult, UsageSummaryStat } from "@contracts/ipc";

export interface EmptyThreadWelcomeProps {
  /** Project display name; empty string degrades the title to the plain
   *  "start a new chat" wording. */
  projectName: string;
  /** Workspace root path; used to fetch live Git status for the left card. */
  projectPath?: string | null;
  /** Pre-fill the composer input and focus it (never auto-sends). */
  onFillPrompt?: (text: string) => void;
}

const MAX_VISIBLE_GIT_FILES = 4;

interface StarterItem {
  tagKey: MessageId;
  titleKey: MessageId;
  promptKey: MessageId;
}

const STARTER_ITEMS: readonly StarterItem[] = [
  {
    tagKey: "chatStream.welcome.starter.planTag",
    titleKey: "chatStream.welcome.starter.planTitle",
    promptKey: "chatStream.welcome.starter.planPrompt",
  },
  {
    tagKey: "chatStream.welcome.starter.debugTag",
    titleKey: "chatStream.welcome.starter.debugTitle",
    promptKey: "chatStream.welcome.starter.debugPrompt",
  },
  {
    tagKey: "chatStream.welcome.starter.archTag",
    titleKey: "chatStream.welcome.starter.archTitle",
    promptKey: "chatStream.welcome.starter.archPrompt",
  },
];

/** Pick the most informative status code for a git file entry (prefer working
 *  tree changes, falling back to staged index status). */
function primaryGitCode(file: GitFileStatus): GitStatusCode {
  if (file.workingTree !== "unmodified") return file.workingTree;
  return file.index;
}

function gitStatusMeta(code: GitStatusCode): { labelKey: MessageId; toneClass: string } {
  switch (code) {
    case "added":
      return { labelKey: "chatStream.welcome.gitStatus.added", toneClass: "text-emerald-500 dark:text-emerald-400" };
    case "untracked":
      return { labelKey: "chatStream.welcome.gitStatus.untracked", toneClass: "text-emerald-500 dark:text-emerald-400" };
    case "deleted":
      return { labelKey: "chatStream.welcome.gitStatus.deleted", toneClass: "text-rose-500 dark:text-rose-400" };
    case "renamed":
      return { labelKey: "chatStream.welcome.gitStatus.renamed", toneClass: "text-sky-500 dark:text-sky-400" };
    case "copied":
      return { labelKey: "chatStream.welcome.gitStatus.copied", toneClass: "text-sky-500 dark:text-sky-400" };
    case "unmerged":
      return { labelKey: "chatStream.welcome.gitStatus.unmerged", toneClass: "text-rose-500 dark:text-rose-400" };
    default:
      return { labelKey: "chatStream.welcome.gitStatus.modified", toneClass: "text-amber-500 dark:text-amber-400" };
  }
}

export function EmptyThreadWelcome({ projectName, projectPath, onFillPrompt }: EmptyThreadWelcomeProps) {
  const { t } = useI18n();
  // Today's cross-session usage summary; null until the RPC resolves (or
  // forever when it failed — the hint line simply stays hidden).
  const [today, setToday] = useState<UsageSummaryStat | null>(null);
  // Live git status for the workspace card: undefined = loading, null = not a
  // git repo / unavailable, GitStatusResult = loaded.
  const [gitStatus, setGitStatus] = useState<GitStatusResult | null | undefined>(
    isElectron && projectPath ? undefined : null,
  );

  useEffect(() => {
    if (!isElectron) return;
    let alive = true;
    api.usage
      .stats({ preset: "today" })
      .then((res) => {
        if (alive) setToday(res.summary);
      })
      .catch(() => {
        // Optional chrome — ignore stats failures silently.
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!isElectron || !projectPath) {
      setGitStatus(null);
      return;
    }
    let alive = true;
    setGitStatus(undefined);
    api.git
      .status({ repoPath: projectPath })
      .then((res) => {
        if (alive) setGitStatus(res.status);
      })
      .catch(() => {
        if (alive) setGitStatus(null);
      });
    return () => {
      alive = false;
    };
  }, [projectPath]);

  const showWorkspaceCard = isElectron && Boolean(projectPath);
  const changedFiles = gitStatus?.files ?? [];
  const visibleFiles = changedFiles.slice(0, MAX_VISIBLE_GIT_FILES);
  const hiddenFileCount = Math.max(0, changedFiles.length - visibleFiles.length);
  const hasChanges = changedFiles.length > 0;

  return (
    <div
      className={cn(
        "flex w-full animate-[home-fade-up_160ms_ease-out] flex-col items-center",
        showWorkspaceCard ? "max-w-3xl" : "max-w-md",
      )}
    >
      {/* Title & today's usage */}
      <div className="flex flex-col items-center gap-1.5 text-center">
        <h2 className="text-2xl font-semibold tracking-tight text-content">
          {projectName
            ? t("chatStream.welcome.withProject", { name: projectName })
            : t("chatStream.welcome.title")}
        </h2>
        {today && today.turns > 0 && (
          <p className="text-xs text-content-subtle">
            {t("chatStream.welcome.todayUsage", {
              turns: today.turns,
              tokens: fmtTokens(today.totalTokens),
            })}
          </p>
        )}
      </div>

      {/* Two-column context overview (or centered quick-start card when no workspace path) */}
      <div
        className={cn(
          "mt-7 grid w-full grid-cols-1 gap-3",
          showWorkspaceCard && "md:grid-cols-2",
        )}
      >
        {showWorkspaceCard && (
          <div className="flex flex-col justify-between gap-3 rounded-xl border border-edge/80 bg-surface-card/75 p-4">
            <div className="min-w-0">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="font-medium text-content">{t("chatStream.welcome.workspaceStatus")}</span>
                {gitStatus && (
                  <span className="inline-flex max-w-[160px] items-center gap-1 truncate rounded bg-surface-muted px-2 py-0.5 font-mono text-[11px] text-emerald-500 dark:text-emerald-400">
                    {gitStatus.branch || "HEAD"}
                  </span>
                )}
              </div>

              <div className="mt-3 space-y-1.5 text-xs text-content-subtle">
                {gitStatus === undefined ? (
                  <div className="space-y-2 py-1">
                    <div className="h-3.5 w-3/4 animate-pulse rounded bg-surface-muted" />
                    <div className="h-3.5 w-1/2 animate-pulse rounded bg-surface-muted" />
                  </div>
                ) : gitStatus === null ? (
                  <p className="py-1 text-content-subtle">{t("chatStream.welcome.workspaceNotGit")}</p>
                ) : hasChanges ? (
                  <>
                    {visibleFiles.map((file) => {
                      const meta = gitStatusMeta(primaryGitCode(file));
                      return (
                        <div key={file.path} className="flex items-center justify-between gap-2">
                          <span className="min-w-0 truncate font-mono text-[11px] text-content-muted" title={file.path}>
                            {file.path}
                          </span>
                          <span className={cn("shrink-0 text-[11px]", meta.toneClass)}>
                            {t(meta.labelKey)}
                          </span>
                        </div>
                      );
                    })}
                    {hiddenFileCount > 0 && (
                      <div className="pt-0.5 text-[11px] text-content-subtle">
                        {t("chatStream.welcome.workspaceMoreFiles", { n: hiddenFileCount })}
                      </div>
                    )}
                  </>
                ) : (
                  <p className="py-1 text-content-subtle">{t("chatStream.welcome.workspaceClean")}</p>
                )}
              </div>
            </div>

            {onFillPrompt && (
              <div className="flex items-center gap-2 border-t border-edge/60 pt-2.5">
                {gitStatus && hasChanges ? (
                  <>
                    <button
                      type="button"
                      onClick={() => onFillPrompt(t("chatStream.welcome.action.reviewDiffPrompt"))}
                      className="flex-1 rounded-lg border border-edge/80 bg-surface px-2 py-1.5 text-xs text-content-muted transition-colors hover:border-accent/50 hover:text-content"
                    >
                      {t("chatStream.welcome.action.reviewDiff")}
                    </button>
                    <button
                      type="button"
                      onClick={() => onFillPrompt(t("chatStream.welcome.action.commitMsgPrompt"))}
                      className="flex-1 rounded-lg border border-edge/80 bg-surface px-2 py-1.5 text-xs text-content-muted transition-colors hover:border-accent/50 hover:text-content"
                    >
                      {t("chatStream.welcome.action.commitMsg")}
                    </button>
                  </>
                ) : (
                  <>
                    {gitStatus && (
                      <button
                        type="button"
                        onClick={() => onFillPrompt(t("chatStream.welcome.action.recentCommitsPrompt"))}
                        className="flex-1 rounded-lg border border-edge/80 bg-surface px-2 py-1.5 text-xs text-content-muted transition-colors hover:border-accent/50 hover:text-content"
                      >
                        {t("chatStream.welcome.action.recentCommits")}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => onFillPrompt(t("chatStream.welcome.action.projectOverviewPrompt"))}
                      className="flex-1 rounded-lg border border-edge/80 bg-surface px-2 py-1.5 text-xs text-content-muted transition-colors hover:border-accent/50 hover:text-content"
                    >
                      {t("chatStream.welcome.action.projectOverview")}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {/* Right column: quick-start prompts */}
        <div className="flex flex-col justify-between gap-2.5 rounded-xl border border-edge/80 bg-surface-card/75 p-4">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium text-content">{t("chatStream.welcome.quickStart")}</span>
            <span className="text-[11px] text-content-subtle">{t("chatStream.welcome.clickToFill")}</span>
          </div>
          <div className="space-y-1.5">
            {STARTER_ITEMS.map((item) => (
              <button
                key={item.titleKey}
                type="button"
                onClick={() => onFillPrompt?.(t(item.promptKey))}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs transition-colors hover:bg-surface-hover/60"
              >
                <span className="shrink-0 rounded border border-edge/80 bg-surface px-1.5 py-0.5 font-mono text-[11px] text-accent">
                  {t(item.tagKey)}
                </span>
                <span className="truncate text-content-muted">{t(item.titleKey)}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
