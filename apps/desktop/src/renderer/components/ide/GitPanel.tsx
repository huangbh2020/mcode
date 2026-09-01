import { useEffect, useState, type ReactNode } from "react";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { useSessionStore, selectActiveEnvPath } from "@renderer/stores/sessionStore.js";
import type { GitRepo } from "@contracts/ipc";
import { GitRepoCard } from "./GitRepoCard.js";
import { GitHistoryView } from "./GitHistoryView.js";
import { WorktreeManagerPanel } from "./WorktreeManagerPanel.js";
import { IconGitBranch, IconGitCommit, IconGitFork, IconLoader2, IconRefresh } from "@renderer/lib/icons.js";
import { useI18n } from "@renderer/lib/i18n/index.js";

type GitSubTab = "changes" | "history" | "worktrees";

/**
 * Git panel — the right-panel "Git" tab body.
 *
 * Discovers all git repositories under the active project's root (a project
 * folder may contain multiple repos: monorepo, submodules, nested projects).
 *
 * Sub-tabs:
 *   - 更改: working-tree status / stage / commit via {@link GitRepoCard}
 *   - 历史: commit log + per-commit file list via {@link GitHistoryView}
 *
 * The scan runs on mount and whenever the active project changes. A manual
 * refresh button re-scans (useful after cloning a new repo into the folder).
 */
export function GitPanel() {
  const { t } = useI18n();
  const [subTab, setSubTab] = useState<GitSubTab>("changes");

  // Follows the active session's environment — a materialized worktree
  // session gets the worktree's OWN repo in this panel (its commits, its
  // status); local sessions see the project's repos as before.
  const projectPath = useSessionStore(selectActiveEnvPath);

  const [repos, setRepos] = useState<GitRepo[]>([]);
  const [loading, setLoading] = useState(true);

  const scan = async (path: string) => {
    setLoading(true);
    try {
      const { repos } = await api.git.discoverRepos({ projectPath: path });
      setRepos(repos);
    } catch {
      setRepos([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!projectPath) {
      setRepos([]);
      setLoading(false);
      return;
    }
    void scan(projectPath);
  }, [projectPath]);

  if (!projectPath) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <IconGitBranch size={20} className="text-content-subtle" />
        <p className="[font-size:var(--right-panel-font-size)] text-content-muted">{t("ide.files.noProjectTitle")}</p>
        <p className="[font-size:var(--right-panel-font-size)] text-content-subtle">{t("ide.git.noProjectHint")}</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center gap-1.5 px-3 py-2 [font-size:var(--right-panel-font-size)] text-content-subtle">
        <IconLoader2 size={12} className="animate-spin" />
        {t("ide.git.scanning")}
      </div>
    );
  }

  if (repos.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <IconGitBranch size={20} className="text-content-subtle" />
        <p className="[font-size:var(--right-panel-font-size)] text-content-muted">{t("ide.git.noRepos")}</p>
        <p className="[font-size:var(--right-panel-font-size)] text-content-subtle">
          {t("ide.git.noReposHint", { path: projectPath })}
        </p>
        <button
          type="button"
          onClick={() => void scan(projectPath)}
          className="mt-1 flex items-center gap-1 rounded px-2 py-1 [font-size:var(--right-panel-font-size)] text-content-muted hover:bg-surface-hover"
        >
          <IconRefresh size={11} /> {t("ide.git.rescan")}
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Sub-tab strip: 更改 | 历史 + rescan */}
      <div className="flex shrink-0 items-center border-b border-edge">
        <SubTabButton
          active={subTab === "changes"}
          onClick={() => setSubTab("changes")}
          icon={<IconGitBranch size={12} />}
          label={t("ide.git.changes")}
        />
        <SubTabButton
          active={subTab === "history"}
          onClick={() => setSubTab("history")}
          icon={<IconGitCommit size={12} />}
          label={t("ide.git.history")}
        />
        <SubTabButton
          active={subTab === "worktrees"}
          onClick={() => setSubTab("worktrees")}
          icon={<IconGitFork size={12} />}
          label={t("ide.git.worktreeTab")}
        />
        <div className="ml-auto flex items-center gap-1 px-1.5">
          <span className="[font-size:var(--rp-fs-xxs)] text-content-subtle">{t("ide.git.repoCount", { n: repos.length })}</span>
          <button
            type="button"
            onClick={() => void scan(projectPath)}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 [font-size:var(--right-panel-font-size)] text-content-muted transition-colors hover:bg-surface-hover hover:text-content"
            title={t("ide.git.rescanRepos")}
          >
            <IconRefresh size={12} />
          </button>
        </div>
      </div>

      {subTab === "changes" ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          <div className="space-y-2">
            {repos.map((repo) => (
              <GitRepoCard key={repo.path} repo={repo} />
            ))}
          </div>
        </div>
      ) : subTab === "worktrees" ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <WorktreeManagerPanel repos={repos} />
        </div>
      ) : (
        <div className="min-h-0 flex-1">
          <GitHistoryView repos={repos} />
        </div>
      )}
    </div>
  );
}

function SubTabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1 px-3 py-1.5 [font-size:var(--right-panel-font-size)] font-medium transition-colors",
        active
          ? "border-b-2 border-accent text-content"
          : "border-b-2 border-transparent text-content-subtle hover:text-content-muted",
      )}
    >
      {icon}
      {label}
    </button>
  );
}
