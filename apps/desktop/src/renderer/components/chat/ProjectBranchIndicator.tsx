/**
 * One-line project + git-branch indicator shown above the composer on an empty
 * (brand-new) thread. Displays the project name and, when the project root is
 * a git repository, the current branch as a clickable pill that opens a
 * full branch/tag switcher (mirrors the right-panel GitRepoCard switcher).
 *
 * Non-git projects render only the project name (no branch pill). A project
 * with multiple nested repos shows the one whose root best matches the
 * project path (shallowest relative path) — the "primary" repo.
 *
 * All git state is fetched lazily in component-local state (no store fields),
 * matching how every other git surface in the app works: discover on mount,
 * refresh status, load branches on menu open, checkout then re-refresh.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Menu } from "@base-ui/react/menu";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { relativePath } from "@renderer/lib/path.js";
import type {
  GitRepo,
  GitStatusResult,
  GitBranchInfo,
  GitBranchListResult,
} from "@contracts/ipc";
import {
  IconFolder,
  IconGitBranch,
  IconChevronDown,
  IconCheck,
  IconLoader2,
  IconTag,
} from "@renderer/lib/icons.js";

export interface ProjectBranchIndicatorProps {
  /** Absolute filesystem path of the project root. */
  projectPath: string;
  /** Display name of the project (projects[].name). */
  projectName: string;
  /** Compact mode: renders ONLY the branch pill (no folder icon / project
   *  name). Used in the toolbar where space is tight and the thread title
   *  already identifies the session. Defaults to false (full indicator). */
  compact?: boolean;
}

export function ProjectBranchIndicator({
  projectPath,
  projectName,
  compact = false,
}: ProjectBranchIndicatorProps) {
  const { t } = useI18n();
  // Primary repo (best match for project root). null = not a git project.
  const [repo, setRepo] = useState<GitRepo | null>(null);
  const [status, setStatus] = useState<GitStatusResult | null>(null);
  const [branches, setBranches] = useState<GitBranchListResult | null>(null);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branchQuery, setBranchQuery] = useState("");
  const [checkingOut, setCheckingOut] = useState(false);

  /** Re-fetch the current branch + ahead/behind for the primary repo. */
  const refresh = useCallback(async () => {
    if (!repo) {
      setStatus(null);
      return;
    }
    try {
      const { status } = await api.git.status({ repoPath: repo.path });
      setStatus(status);
    } catch {
      setStatus(null);
    }
  }, [repo]);

  /** Discover the primary repo for this project, then refresh its status.
   *  Keyed on projectPath so switching projects re-scans. Picks the repo whose
   *  root is closest to the project path (shallowest relative path) — for a
   *  project that IS a repo this is the project root itself (rel = ""). */
  useEffect(() => {
    let cancelled = false;
    setRepo(null);
    setStatus(null);
    setBranches(null);
    (async () => {
      try {
        const { repos } = await api.git.discoverRepos({ projectPath });
        if (cancelled) return;
        if (repos.length === 0) return; // not a git project
        // Shallowest relative path wins; tiebreak by name for stability.
        const primary = repos
          .map((r) => ({ r, rel: relativePath(r.path, projectPath).length }))
          .sort((a, b) => (a.rel - b.rel) || a.r.name.localeCompare(b.r.name))[0]?.r ?? null;
        if (cancelled) return;
        setRepo(primary);
      } catch {
        // discoverRepos degrades to empty on refusal; nothing more to do.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  // Refresh status whenever the primary repo changes.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Fetch the grouped branch/tag list for the picker (on menu open). */
  const loadBranches = useCallback(async () => {
    if (!repo) return;
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
  }, [repo]);

  /** Check out a ref, then refresh. `newBranch` (when set) creates a local
   *  tracking branch from the target first (remote-tracking / new branch). */
  const handleCheckout = useCallback(
    async (branch: string, newBranch?: string) => {
      if (!repo) return;
      setCheckingOut(true);
      try {
        await api.git.checkout({ repoPath: repo.path, branch, newBranch });
        await refresh();
      } catch {
        // Checkout failed — leave the current branch shown as-is.
      } finally {
        setCheckingOut(false);
      }
    },
    [repo, refresh],
  );

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

  const localNames = useMemo(
    () => new Set(filteredBranches?.local.map((b) => b.name) ?? []),
    [filteredBranches],
  );

  return (
    <div className="flex items-center gap-1.5 text-[12px] text-content-muted">
      {!compact && (
        <>
          <IconFolder size={13} className="shrink-0 opacity-70" />
          <span className="max-w-[240px] truncate font-medium text-content" title={projectPath}>
            {projectName}
          </span>
        </>
      )}

      {repo && (
        <Menu.Root onOpenChange={(open) => open && void loadBranches()}>
          <Menu.Trigger
            className={cn(
              "flex shrink-0 items-center gap-0.5 rounded bg-surface-muted px-1.5 py-0.5 font-mono text-[11px] text-content-muted transition-colors",
              "hover:bg-surface-hover hover:text-content",
            )}
            title={t("chat.branch.switchTitle")}
          >
            <IconGitBranch size={11} className="shrink-0 opacity-80" />
            <span className="max-w-[140px] truncate">{status?.branch || "HEAD"}</span>
            <IconChevronDown size={10} className="shrink-0 opacity-60" />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner side={compact ? "bottom" : "top"} align="start" sideOffset={6}>
              <Menu.Popup
                className={cn(
                  "z-50 flex max-h-[320px] w-[300px] max-w-[320px] min-w-[240px] flex-col rounded-md border border-edge bg-surface py-1 shadow-2xl",
                  "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
                  "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
                  "transition-[transform,opacity] duration-100",
                )}
              >
                {/* Search filter (non-menu-item so it doesn't hijack arrow nav). */}
                <div className="flex items-center gap-1 px-2 pb-1">
                  <input
                    value={branchQuery}
                    onChange={(e) => setBranchQuery(e.target.value)}
                    onKeyDown={(e) => {
                      // Stop the Menu from treating arrows/Home/End as item nav.
                      if (["ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) {
                        e.stopPropagation();
                      }
                    }}
                    placeholder={t("chat.branch.searchPlaceholder")}
                    className="min-w-0 flex-1 rounded border border-edge bg-surface px-1.5 py-0.5 text-[11px] text-content outline-none placeholder:text-content-subtle focus:border-accent"
                  />
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto">
                  {branchesLoading ? (
                    <div className="flex items-center justify-center gap-1.5 px-3 py-4 text-[11px] text-content-subtle">
                      <IconLoader2 size={12} className="animate-spin" />
                      {t("common.loading")}
                    </div>
                  ) : !filteredBranches ? (
                    <div className="px-3 py-4 text-center text-[11px] text-content-subtle">
                      {t("chat.branch.loadFailed")}
                    </div>
                  ) : (
                    <>
                      {checkingOut && (
                        <div className="flex items-center justify-center gap-1.5 border-b border-edge px-3 py-1 text-[11px] text-content-subtle">
                          <IconLoader2 size={12} className="animate-spin" />
                          {t("chat.branch.switching")}
                        </div>
                      )}
                      {filteredBranches.local.length === 0 &&
                        filteredBranches.remote.length === 0 &&
                        filteredBranches.tags.length === 0 && (
                          <div className="px-3 py-3 text-center text-[11px] text-content-subtle">
                            {branchQuery ? t("chat.branch.noMatch") : t("chat.branch.none")}
                          </div>
                        )}
                      {filteredBranches.local.length > 0 && (
                        <BranchGroup
                          label={t("chat.branch.local")}
                          items={filteredBranches.local}
                          localNames={localNames}
                          onCheckout={handleCheckout}
                        />
                      )}
                      {filteredBranches.remote.length > 0 && (
                        <BranchGroup
                          label={t("chat.branch.remote")}
                          items={filteredBranches.remote}
                          localNames={localNames}
                          onCheckout={handleCheckout}
                        />
                      )}
                      {filteredBranches.tags.length > 0 && (
                        <BranchGroup
                          label={t("chat.branch.tags")}
                          items={filteredBranches.tags}
                          localNames={localNames}
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
      )}
    </div>
  );
}

/** A grouped, scrollable list of branches/tags. Each row checks out its ref
 *  on click (no-op for the current branch). Remote refs that have no local
 *  counterpart create a tracking local branch. Mirrors GitRepoCard's helper. */
function BranchGroup({
  label,
  items,
  localNames,
  onCheckout,
  icon,
}: {
  label: string;
  items: GitBranchInfo[];
  /** Short names of local branches — used to decide tracking-branch creation
   *  for remote refs. */
  localNames: Set<string>;
  onCheckout: (branch: string, newBranch?: string) => void;
  icon?: React.ReactNode;
}) {
  const handleClick = (b: GitBranchInfo) => {
    if (b.current) return;
    if (b.type === "remote") {
      // `origin/foo` -> short name `foo`. Track if no local branch yet.
      const shortName = b.name.includes("/")
        ? b.name.slice(b.name.indexOf("/") + 1)
        : b.name;
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
            "flex w-full items-center gap-1.5 px-2 py-1 text-left text-[11px] outline-none select-none",
            "data-[highlighted]:bg-surface-muted",
            b.current ? "text-accent" : "text-content-muted",
          )}
        >
          <span className="shrink-0 opacity-80">{icon ?? <IconGitBranch size={11} />}</span>
          <span className="min-w-0 flex-1 truncate font-mono">{b.name}</span>
          {b.label && (
            <span
              className="min-w-0 max-w-[120px] truncate text-[10px] text-content-subtle"
              title={b.label}
            >
              {b.label}
            </span>
          )}
          {b.current && <IconCheck size={11} className="shrink-0" />}
        </Menu.Item>
      ))}
    </div>
  );
}
