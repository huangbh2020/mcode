import { useCallback, useEffect, useMemo, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { api } from "@renderer/lib/api.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import { useSessionStore, selectActiveEnvPath } from "@renderer/stores/sessionStore.js";
import { useToastStore } from "@renderer/stores/toastStore.js";
import { formatRelativeTime } from "@renderer/lib/time.js";
import {
  IconBrandGithub,
  IconGitPullRequest,
  IconGitMerge,
  IconGitBranch,
  IconRefresh,
  IconLoader2,
  IconArrowLeft,
  IconExternalLink,
  IconPlus,
  IconMessage,
  IconAlertTriangle,
  IconCircleCheck,
  IconLink,
} from "@renderer/lib/icons.js";
import { Markdown } from "@renderer/components/chat/Markdown.js";
import type {
  GitHubContextResult,
  GitHubIssueDetail,
  GitHubIssueSummary,
  GitHubPullDetail,
  GitHubPullSummary,
  GitHubRepoCandidate,
} from "@contracts/ipc";
import { GITHUB_MANUAL_REPOS_SETTING_KEY } from "@contracts/ipc";

/**
 * GitHub panel (right panel "github" tab): browse / merge PRs and manage
 * issues for the active project's github.com repository without leaving the
 * app — the "翻 GitHub → 合 PR → 关联 issue" loop, in one surface.
 *
 * Data flow: `github:getContext` resolves the token chain (settings PAT → gh
 * CLI) and the github.com repos under the active project's git remotes; the
 * renderer picks one and drives all REST calls with an explicit owner/repo.
 * User-added manual repos persist under `github.manualRepos` (per project)
 * and carry no repoPath, so local flows (push branch → create PR) are
 * disabled for them.
 */

type ListTab = "prs" | "issues";
type Detail =
  | { kind: "pull"; data: GitHubPullDetail }
  | { kind: "issue"; data: GitHubIssueDetail };

/** Module-level stable empty arrays — Zustand selector fallback guard isn't
 *  needed here (local state), but keeps render output referentially stable. */
const EMPTY_PULLS: GitHubPullSummary[] = [];
const EMPTY_ISSUES: GitHubIssueSummary[] = [];

function parseSlug(value: string): { owner: string; repo: string } | null {
  const m = /^\s*([\w.-]+)\/([\w.-]+)\s*$/.exec(value);
  if (!m) return null;
  return { owner: m[1] ?? "", repo: m[2] ?? "" };
}

export function GitHubPanel() {
  const { t } = useI18n();
  const toast = useToastStore((s) => s.push);
  const projectPath = useSessionStore(selectActiveEnvPath);
  const projectId = useSessionStore((s) => s.activeProjectId);
  const openUrlInBrowser = useSessionStore((s) => s.openUrlInBrowser);
  const setSettingsOpen = useSessionStore((s) => s.setSettingsOpen);

  // ── context: token + repo candidates ──
  const [context, setContext] = useState<GitHubContextResult | null>(null);
  const [manualSlugs, setManualSlugs] = useState<string[]>([]);
  const [contextLoading, setContextLoading] = useState(true);
  const [contextError, setContextError] = useState<string | null>(null);

  // ── repo selection ──
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);

  // ── lists ──
  const [tab, setTab] = useState<ListTab>("prs");
  const [pulls, setPulls] = useState<GitHubPullSummary[]>(EMPTY_PULLS);
  const [issues, setIssues] = useState<GitHubIssueSummary[]>(EMPTY_ISSUES);
  const [listsLoading, setListsLoading] = useState(false);
  const [listsError, setListsError] = useState<string | null>(null);

  // ── detail view ──
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // ── dialogs ──
  const [createPullOpen, setCreatePullOpen] = useState(false);
  const [createIssueOpen, setCreateIssueOpen] = useState(false);
  /** Issue number pre-linked into the create-PR dialog ("创建修复 PR" from
   *  an issue's detail — starts the body with Fixes #N). */
  const [fixIssueNumber, setFixIssueNumber] = useState<number | null>(null);

  // ── manual repo input ──
  const [manualInput, setManualInput] = useState<string | null>(null);

  const candidates: GitHubRepoCandidate[] = useMemo(() => {
    const auto = context?.repos ?? [];
    const manual: GitHubRepoCandidate[] = manualSlugs
      .map((slug) => parseSlug(slug))
      .filter((s): s is { owner: string; repo: string } => s !== null)
      .map((s) => ({
        slug: `${s.owner}/${s.repo}`,
        owner: s.owner,
        repo: s.repo,
        source: "manual" as const,
        repoPath: null,
      }))
      .filter((m) => !auto.some((a) => a.slug === m.slug));
    return [...auto, ...manual];
  }, [context, manualSlugs]);

  const selected = useMemo(
    () => candidates.find((c) => c.slug === selectedSlug) ?? candidates[0] ?? null,
    [candidates, selectedSlug],
  );

  const loadManualRepos = useCallback(async () => {
    if (!projectId) return;
    try {
      const { value } = await api.setting.get({ key: GITHUB_MANUAL_REPOS_SETTING_KEY });
      if (!value) return;
      const map = JSON.parse(value) as Record<string, string[]>;
      setManualSlugs(Array.isArray(map[projectId]) ? (map[projectId] ?? []) : []);
    } catch {
      // corrupt JSON — start clean, next save overwrites
    }
  }, [projectId]);

  const loadContext = useCallback(async () => {
    if (!projectPath) {
      setContext(null);
      setContextLoading(false);
      return;
    }
    setContextLoading(true);
    setContextError(null);
    try {
      const { context: ctx } = await api.github.getContext({ projectPath });
      setContext(ctx);
    } catch (err) {
      setContextError((err as Error).message);
    } finally {
      setContextLoading(false);
    }
  }, [projectPath]);

  useEffect(() => {
    setContext(null);
    setSelectedSlug(null);
    setDetail(null);
    void loadContext();
    void loadManualRepos();
  }, [loadContext, loadManualRepos]);

  const refreshLists = useCallback(async () => {
    if (!selected) return;
    setListsLoading(true);
    setListsError(null);
    try {
      if (tab === "prs") {
        const { pulls: list } = await api.github.listPulls({ owner: selected.owner, repo: selected.repo });
        setPulls(list);
      } else {
        const { issues: list } = await api.github.listIssues({ owner: selected.owner, repo: selected.repo, state: "open" });
        setIssues(list);
      }
    } catch (err) {
      setListsError((err as Error).message);
    } finally {
      setListsLoading(false);
    }
  }, [selected, tab]);

  // Load both lists once per repo (counts for the sub-tabs); the visible tab
  // reloads on demand.
  const [loadedForSlug, setLoadedForSlug] = useState<string | null>(null);
  useEffect(() => {
    if (!selected || selected.slug === loadedForSlug || contextError) return;
    setLoadedForSlug(selected.slug);
    setDetail(null);
    setPulls(EMPTY_PULLS);
    setIssues(EMPTY_ISSUES);
    setListsLoading(true);
    setListsError(null);
    void (async () => {
      try {
        const [prRes, isRes] = await Promise.all([
          api.github.listPulls({ owner: selected.owner, repo: selected.repo }),
          api.github.listIssues({ owner: selected.owner, repo: selected.repo, state: "open" }),
        ]);
        setPulls(prRes.pulls);
        setIssues(isRes.issues);
      } catch (err) {
        setListsError((err as Error).message);
      } finally {
        setListsLoading(false);
      }
    })();
  }, [selected, loadedForSlug, contextError]);

  const openDetail = useCallback(
    async (kind: "pull" | "issue", number: number) => {
      if (!selected) return;
      setDetailLoading(true);
      setDetail(null);
      try {
        if (kind === "pull") {
          const { pull } = await api.github.getPull({ owner: selected.owner, repo: selected.repo, number });
          setDetail({ kind: "pull", data: pull });
        } else {
          const { issue } = await api.github.getIssue({ owner: selected.owner, repo: selected.repo, number });
          setDetail({ kind: "issue", data: issue });
        }
      } catch (err) {
        toast({ kind: "error", title: t("github.loadFailed"), body: (err as Error).message });
      } finally {
        setDetailLoading(false);
      }
    },
    [selected, toast, t],
  );

  const refreshDetail = useCallback(() => {
    if (!detail) return;
    void openDetail(detail.kind, detail.data.number);
    void refreshLists();
  }, [detail, openDetail, refreshLists]);

  const addManualRepo = useCallback(async () => {
    if (manualInput === null || !projectId) return;
    const slug = manualInput.trim();
    setManualInput(null);
    if (!slug) return;
    if (!parseSlug(slug)) {
      toast({ kind: "warning", title: t("github.invalidSlug") });
      return;
    }
    const next = [...new Set([...manualSlugs, slug])];
    setManualSlugs(next);
    const map: Record<string, string[]> = { [projectId]: next };
    await api.setting
      .set({ key: GITHUB_MANUAL_REPOS_SETTING_KEY, value: JSON.stringify(map) })
      .catch((err) => console.error("setting.set(github.manualRepos) failed:", err));
  }, [manualInput, projectId, manualSlugs, toast, t]);

  // ── empty / loading states ──
  if (!projectPath) {
    return <PanelEmpty icon={<IconBrandGithub size={20} className="text-content-subtle" />} title={t("github.noProject")} hint={t("github.noProjectHint")} />;
  }
  if (contextLoading) {
    return (
      <div className="flex items-center gap-1.5 px-3 py-2 text-content-subtle [font-size:var(--right-panel-font-size)]">
        <IconLoader2 size={12} className="animate-spin" />
        {t("github.loading")}
      </div>
    );
  }
  if (context && !context.token.configured) {
    return <NoTokenEmpty onOpenSettings={() => setSettingsOpen(true, "github")} />;
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {/* header: repo picker + token status + refresh */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-edge px-2 py-1.5">
        <IconBrandGithub size={14} className="shrink-0 text-content-subtle" />
        <select
          value={selected?.slug ?? ""}
          onChange={(e) => {
            setSelectedSlug(e.target.value);
            setDetail(null);
          }}
          className="min-w-0 flex-1 truncate rounded bg-transparent px-1 py-0.5 text-content [font-size:var(--right-panel-font-size)] outline-none hover:bg-surface-hover"
          title={t("github.repoPicker")}
        >
          {candidates.length === 0 && <option value="">{t("github.noRepos")}</option>}
          {candidates.map((c) => (
            <option key={c.slug} value={c.slug}>
              {c.slug}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => setManualInput("")}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-content-muted transition-colors hover:bg-surface-hover hover:text-content"
          title={t("github.addManualRepo")}
        >
          <IconPlus size={13} />
        </button>
        <button
          type="button"
          onClick={() => {
            void loadContext();
            void refreshLists();
          }}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-content-muted transition-colors hover:bg-surface-hover hover:text-content"
          title={t("github.refresh")}
        >
          <IconRefresh size={13} />
        </button>
      </div>

      {/* manual repo input row */}
      {manualInput !== null && (
        <div className="flex shrink-0 items-center gap-1 border-b border-edge px-2 py-1.5">
          <input
            autoFocus
            value={manualInput}
            onChange={(e) => setManualInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void addManualRepo();
              if (e.key === "Escape") setManualInput(null);
            }}
            placeholder={t("github.addManualRepoPlaceholder")}
            className="min-w-0 flex-1 rounded border border-edge bg-surface px-1.5 py-1 text-content [font-size:var(--right-panel-font-size)] outline-none focus:border-accent"
          />
          <button
            type="button"
            onClick={() => void addManualRepo()}
            className="shrink-0 rounded bg-accent/15 px-2 py-1 text-accent [font-size:var(--right-panel-font-size)] hover:bg-accent/25"
          >
            <IconCircleCheck size={13} />
          </button>
        </div>
      )}

      {/* token status line */}
      {context?.token.configured && (
        <div className="shrink-0 px-3 pb-1 pt-1 text-content-subtle [font-size:var(--rp-fs-xxs)]">
          {context.token.login
            ? t("github.loginAs", { login: context.token.login })
            : ""}
          {context.token.source === "gh" && ` · ${t("github.viaGh")}`}
        </div>
      )}

      {candidates.length === 0 ? (
        <PanelEmpty
          icon={<IconBrandGithub size={20} className="text-content-subtle" />}
          title={t("github.noRepos")}
          hint={t("github.noReposHint")}
        >
          <button
            type="button"
            onClick={() => setManualInput("")}
            className="mt-1 flex items-center gap-1 rounded px-2 py-1 text-content-muted [font-size:var(--right-panel-font-size)] hover:bg-surface-hover"
          >
            <IconPlus size={11} /> {t("github.addManualRepo")}
          </button>
        </PanelEmpty>
      ) : contextError ? (
        <PanelEmpty icon={<IconAlertTriangle size={20} className="text-warning" />} title={t("github.loadFailed")} hint={contextError} />
      ) : (
        <>
          {/* sub-tab strip: PRs | Issues + new actions */}
          <div className="flex shrink-0 items-center border-b border-edge">
            <SubTabButton active={tab === "prs"} onClick={() => { setTab("prs"); setDetail(null); }} icon={<IconGitPullRequest size={12} />} label={`${t("github.prTab")} ${pulls.length > 0 ? pulls.length : ""}`} />
            <SubTabButton active={tab === "issues"} onClick={() => { setTab("issues"); setDetail(null); }} icon={<IconAlertTriangle size={12} />} label={`${t("github.issueTab")} ${issues.length > 0 ? issues.length : ""}`} />
            <div className="ml-auto flex items-center gap-1 px-1.5">
              <button
                type="button"
                onClick={() => setCreatePullOpen(true)}
                disabled={!selected?.repoPath}
                title={selected?.repoPath ? t("github.createPr") : t("github.noLocalRepo")}
                className="flex items-center gap-0.5 rounded px-1.5 py-0.5 text-content-muted [font-size:var(--rp-fs-xxs)] transition-colors hover:bg-surface-hover hover:text-content disabled:cursor-not-allowed disabled:opacity-40"
              >
                <IconGitPullRequest size={11} /> {t("github.createPr")}
              </button>
              <button
                type="button"
                onClick={() => setCreateIssueOpen(true)}
                className="flex items-center gap-0.5 rounded px-1.5 py-0.5 text-content-muted [font-size:var(--rp-fs-xxs)] transition-colors hover:bg-surface-hover hover:text-content"
              >
                <IconAlertTriangle size={11} /> {t("github.createIssue")}
              </button>
            </div>
          </div>

          {/* content: list or detail */}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {detailLoading ? (
              <div className="flex items-center gap-1.5 px-3 py-3 text-content-subtle [font-size:var(--right-panel-font-size)]">
                <IconLoader2 size={12} className="animate-spin" /> {t("github.loading")}
              </div>
            ) : detail ? (
              detail.kind === "pull" ? (
                <PullDetailView
                  key={detail.data.number}
                  pull={detail.data}
                  slug={selected!.slug}
                  onBack={() => setDetail(null)}
                  onRefresh={refreshDetail}
                  onOpenUrl={openUrlInBrowser}
                />
              ) : (
                <IssueDetailView
                  key={detail.data.number}
                  issue={detail.data}
                  owner={selected!.owner}
                  repo={selected!.repo}
                  onBack={() => setDetail(null)}
                  onRefresh={refreshDetail}
                  onOpenUrl={openUrlInBrowser}
                  onOpenPull={(n) => void openDetail("pull", n)}
                  onCreateFixPr={() => {
                    setFixIssueNumber(detail.data.number);
                    setCreatePullOpen(true);
                  }}
                />
              )
            ) : listsLoading && (tab === "prs" ? pulls.length === 0 : issues.length === 0) ? (
              <div className="flex items-center gap-1.5 px-3 py-3 text-content-subtle [font-size:var(--right-panel-font-size)]">
                <IconLoader2 size={12} className="animate-spin" /> {t("github.loading")}
              </div>
            ) : listsError ? (
              <PanelEmpty icon={<IconAlertTriangle size={20} className="text-warning" />} title={t("github.loadFailed")} hint={listsError}>
                <button type="button" onClick={() => void refreshLists()} className="mt-1 flex items-center gap-1 rounded px-2 py-1 text-content-muted [font-size:var(--right-panel-font-size)] hover:bg-surface-hover">
                  <IconRefresh size={11} /> {t("github.retry")}
                </button>
              </PanelEmpty>
            ) : tab === "prs" ? (
              pulls.length === 0 ? (
                <PanelEmpty icon={<IconGitPullRequest size={20} className="text-content-subtle" />} title={t("github.emptyPrs")} hint="" />
              ) : (
                <div className="divide-y divide-edge/60">
                  {pulls.map((p) => (
                    <PullRow key={p.number} pull={p} onClick={() => void openDetail("pull", p.number)} />
                  ))}
                </div>
              )
            ) : issues.length === 0 ? (
              <PanelEmpty icon={<IconAlertTriangle size={20} className="text-content-subtle" />} title={t("github.emptyIssues")} hint="" />
            ) : (
              <div className="divide-y divide-edge/60">
                {issues.map((i) => (
                  <IssueRow key={i.number} issue={i} onClick={() => void openDetail("issue", i.number)} />
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {/* dialogs */}
      {createPullOpen && selected && (
        <CreatePullDialog
          candidate={selected}
          prefillFixNumber={fixIssueNumber}
          onClose={() => {
            setCreatePullOpen(false);
            setFixIssueNumber(null);
          }}
          onCreated={(n) => {
            setCreatePullOpen(false);
            setFixIssueNumber(null);
            toast({ kind: "info", title: t("github.prCreated", { n }) });
            void refreshLists();
          }}
        />
      )}
      {createIssueOpen && selected && (
        <CreateIssueDialog
          owner={selected.owner}
          repo={selected.repo}
          onClose={() => setCreateIssueOpen(false)}
          onCreated={(n) => {
            setCreateIssueOpen(false);
            toast({ kind: "info", title: t("github.issueCreated", { n }) });
            void refreshLists();
          }}
        />
      )}
    </div>
  );
}

/* ── shared bits ── */

function PanelEmpty({ icon, title, hint, children }: { icon: React.ReactNode; title: string; hint: string; children?: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      {icon}
      <p className="text-content-muted [font-size:var(--right-panel-font-size)]">{title}</p>
      {hint && <p className="text-content-subtle [font-size:var(--right-panel-font-size)]">{hint}</p>}
      {children}
    </div>
  );
}

function NoTokenEmpty({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { t } = useI18n();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <IconBrandGithub size={20} className="text-content-subtle" />
      <p className="text-content-muted [font-size:var(--right-panel-font-size)]">{t("github.noToken")}</p>
      <p className="text-content-subtle [font-size:var(--right-panel-font-size)]">{t("github.noTokenHint")}</p>
      <button
        type="button"
        onClick={onOpenSettings}
        className="mt-1 rounded bg-accent/15 px-3 py-1 text-accent [font-size:var(--right-panel-font-size)] hover:bg-accent/25"
      >
        {t("github.openSettings")}
      </button>
    </div>
  );
}

function SubTabButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1 px-3 py-1.5 font-medium [font-size:var(--right-panel-font-size)] transition-colors",
        active ? "border-b-2 border-accent text-content" : "border-b-2 border-transparent text-content-subtle hover:text-content-muted",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

/** State badge chip shared by rows + details. */
function StateChip({ state }: { state: string }) {
  const { t } = useI18n();
  const meta =
    state === "open"
      ? { cls: "bg-success/15 text-success", label: t("github.prOpen") }
      : state === "merged"
        ? { cls: "bg-accent/15 text-accent", label: t("github.prMerged") }
        : state === "draft"
          ? { cls: "bg-content-subtle/15 text-content-subtle", label: t("github.prDraft") }
          : { cls: "bg-danger/10 text-danger", label: t("github.prClosed") };
  return <span className={cn("shrink-0 rounded px-1.5 py-px text-[10px] font-medium leading-4", meta.cls)}>{meta.label}</span>;
}

function mergeableStateKey(state: string): MessageId | null {
  if (state === "dirty") return "github.mergeableDirty";
  if (state === "blocked") return "github.mergeableBlocked";
  if (state === "unstable") return "github.mergeableUnstable";
  return null;
}

function LabelChips({ labels }: { labels: { name: string; color: string }[] }) {
  if (labels.length === 0) return null;
  return (
    <span className="flex shrink-0 items-center gap-1">
      {labels.slice(0, 3).map((l) => (
        <span
          key={l.name}
          className="rounded-full px-1.5 py-px text-[9px] leading-3.5"
          style={{ backgroundColor: `#${l.color}33`, color: `#${l.color}` }}
          title={l.name}
        >
          {l.name}
        </span>
      ))}
    </span>
  );
}

/* ── list rows ── */

function PullRow({ pull, onClick }: { pull: GitHubPullSummary; onClick: () => void }) {
  const { t } = useI18n();
  const blockedKey = pull.state === "open" ? mergeableStateKey(pull.mergeableState) : null;
  return (
    <button type="button" onClick={onClick} className="block w-full px-3 py-2 text-left transition-colors hover:bg-surface-hover">
      <div className="flex items-center gap-1.5">
        <span className="shrink-0 font-mono text-[10px] text-content-subtle">#{pull.number}</span>
        <span className="min-w-0 flex-1 truncate text-content [font-size:var(--right-panel-font-size)]">{pull.title}</span>
        <StateChip state={pull.state} />
      </div>
      <div className="mt-1 flex items-center gap-1.5 text-content-subtle [font-size:var(--rp-fs-xxs)]">
        <span className="truncate font-mono">
          {pull.headRef} → {pull.baseRef}
        </span>
        <LabelChips labels={pull.labels} />
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {blockedKey && <span className="text-danger">{t(blockedKey)}</span>}
          <IconMessage size={10} /> {pull.comments}
          <span>{formatRelativeTime(pull.updatedAt)}</span>
        </span>
      </div>
    </button>
  );
}

function IssueRow({ issue, onClick }: { issue: GitHubIssueSummary; onClick: () => void }) {
  const { t } = useI18n();
  return (
    <button type="button" onClick={onClick} className="block w-full px-3 py-2 text-left transition-colors hover:bg-surface-hover">
      <div className="flex items-center gap-1.5">
        <span className="shrink-0 font-mono text-[10px] text-content-subtle">#{issue.number}</span>
        <span className="min-w-0 flex-1 truncate text-content [font-size:var(--right-panel-font-size)]">{issue.title}</span>
        <LabelChips labels={issue.labels} />
      </div>
      <div className="mt-1 flex items-center gap-1.5 text-content-subtle [font-size:var(--rp-fs-xxs)]">
        <span className="truncate">{t("github.by", { author: issue.author.login })}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <IconMessage size={10} /> {issue.comments}
          <span>{formatRelativeTime(issue.updatedAt)}</span>
        </span>
      </div>
    </button>
  );
}

/* ── detail views ── */

function DetailHeader({ number, title, onBack, htmlUrl, onOpenUrl, children }: {
  number: number;
  title: string;
  onBack: () => void;
  htmlUrl: string;
  onOpenUrl: (url: string) => void;
  children?: React.ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div className="sticky top-0 z-[1] border-b border-edge bg-surface px-3 py-2">
      <div className="flex items-center gap-1.5">
        <button type="button" onClick={onBack} className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-content-muted hover:bg-surface-hover hover:text-content" title={t("github.backToList")}>
          <IconArrowLeft size={13} />
        </button>
        <span className="shrink-0 font-mono text-[10px] text-content-subtle">#{number}</span>
        <span className="min-w-0 flex-1 truncate text-content [font-size:var(--right-panel-font-size)] font-medium">{title}</span>
        <button type="button" onClick={() => onOpenUrl(htmlUrl)} className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-content-muted hover:bg-surface-hover hover:text-content" title={t("github.viewOnGithub")}>
          <IconExternalLink size={12} />
        </button>
      </div>
      {children}
    </div>
  );
}

function CommentList({ comments }: { comments: GitHubPullDetail["comments"] }) {
  return (
    <div className="space-y-2 px-3">
      {comments.map((c) => (
        <div key={c.id} className="rounded-md border border-edge bg-surface-muted/40 p-2">
          <div className="flex items-center gap-1.5">
            {c.author.avatarUrl ? (
              <img src={c.author.avatarUrl} alt={c.author.login} className="h-4 w-4 rounded-full" />
            ) : null}
            <span className="text-[10px] font-medium text-content-muted">{c.author.login}</span>
            <span className="ml-auto text-[9px] text-content-subtle">{formatRelativeTime(c.createdAt)}</span>
          </div>
          <div className="mt-1 [font-size:calc(var(--right-panel-font-size)*0.86)]">
            <Markdown>{c.body}</Markdown>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Comment box + mutation wrapper shared by both detail views. */
function CommentBox({ owner, repo, number, onPosted }: { owner: string; repo: string; number: number; onPosted: () => void }) {
  const { t } = useI18n();
  const toast = useToastStore((s) => s.push);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const text = body.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      await api.github.createComment({ owner, repo, number, body: text });
      setBody("");
      toast({ kind: "info", title: t("github.commentSuccess") });
      onPosted();
    } catch (err) {
      toast({ kind: "error", title: t("github.commentFailed"), body: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="px-3 pb-3">
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={t("github.commentPlaceholder")}
        rows={2}
        className="w-full resize-y rounded-md border border-edge bg-surface px-2 py-1.5 text-content [font-size:calc(var(--right-panel-font-size)*0.92)] outline-none focus:border-accent"
      />
      <button
        type="button"
        onClick={() => void submit()}
        disabled={!body.trim() || busy}
        className="mt-1 flex items-center gap-1 rounded bg-accent px-2.5 py-1 text-[11px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
      >
        {busy ? <IconLoader2 size={11} className="animate-spin" /> : null}
        {t("github.commentSubmit")}
      </button>
    </div>
  );
}

function PullDetailView({ pull, slug, onBack, onRefresh, onOpenUrl }: {
  pull: GitHubPullDetail;
  slug: string;
  onBack: () => void;
  onRefresh: () => void;
  onOpenUrl: (url: string) => void;
}) {
  const { t } = useI18n();
  const toast = useToastStore((s) => s.push);
  const [owner, repo] = slug.split("/");
  const [method, setMethod] = useState<"merge" | "squash" | "rebase">("squash");
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);

  const canMerge = pull.state === "open" || pull.state === "draft";
  const blockedKey = canMerge ? mergeableStateKey(pull.mergeableState) : null;

  const doMerge = async () => {
    setBusy(true);
    setMergeError(null);
    try {
      const res = await api.github.mergePull({ owner: owner ?? "", repo: repo ?? "", number: pull.number, method, deleteBranch });
      if (res.ok) {
        toast({ kind: "info", title: t("github.mergeSuccess", { n: pull.number }) });
        setConfirming(false);
        onRefresh();
      } else {
        setMergeError(res.error ?? t("github.mergeFailed"));
      }
    } catch (err) {
      setMergeError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggleState = async (state: "open" | "closed") => {
    setBusy(true);
    try {
      const res = await api.github.setIssueState({ owner: owner ?? "", repo: repo ?? "", number: pull.number, state });
      if (res.ok) {
        onRefresh();
      } else {
        toast({ kind: "error", title: t("github.stateChangeFailed"), body: res.error });
      }
    } catch (err) {
      toast({ kind: "error", title: t("github.stateChangeFailed"), body: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <DetailHeader number={pull.number} title={pull.title} onBack={onBack} htmlUrl={pull.htmlUrl} onOpenUrl={onOpenUrl}>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-content-subtle [font-size:var(--rp-fs-xxs)]">
          <StateChip state={pull.state} />
          <span className="truncate font-mono">
            {pull.headRef} → {pull.baseRef}
          </span>
          <span>· {t("github.filesChanged", { n: pull.files.length })}</span>
          {blockedKey && <span className="text-danger">· {t(blockedKey)}</span>}
        </div>
      </DetailHeader>

      {pull.body.trim() && (
        <div className="border-b border-edge px-3 py-2 [font-size:calc(var(--right-panel-font-size)*0.92)]">
          <Markdown>{pull.body}</Markdown>
        </div>
      )}

      {/* linked issues */}
      {pull.linkedIssues.length > 0 && (
        <div className="border-b border-edge px-3 py-2">
          <div className="flex items-center gap-1 text-[10px] font-medium text-content-muted">
            <IconLink size={11} /> {t("github.linkedIssues")}
          </div>
          <div className="mt-1 space-y-0.5">
            {pull.linkedIssues.map((i) => (
              <div key={i.number} className="flex items-center gap-1 text-content-subtle [font-size:var(--rp-fs-xxs)]">
                <span className="font-mono">#{i.number}</span>
                <span className="min-w-0 flex-1 truncate">{i.title}</span>
                {i.state === "closed" && <IconCircleCheck size={11} className="text-success" />}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* files changed (counts only in v1) */}
      {pull.files.length > 0 && (
        <div className="border-b border-edge px-3 py-2">
          <div className="flex items-center gap-1 text-[10px] font-medium text-content-muted">
            <IconGitBranch size={11} /> {t("github.filesChanged", { n: pull.files.length })}
          </div>
          <div className="mt-1 space-y-0.5">
            {pull.files.map((f) => (
              <div key={f.filename} className="flex items-center gap-1.5 text-content-subtle [font-size:var(--rp-fs-xxs)]">
                <span className="min-w-0 flex-1 truncate font-mono" title={f.filename}>
                  {f.filename}
                </span>
                <span className="shrink-0 font-mono text-success">+{f.additions}</span>
                <span className="shrink-0 font-mono text-danger">-{f.deletions}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* merge + state controls */}
      {canMerge && (
        <div className="border-b border-edge px-3 py-2">
          <div className="text-[10px] font-medium text-content-muted">
            <IconGitMerge size={11} className="mr-1 inline align-[-1px]" />
            {t("github.merge")}
          </div>
          <select
            value={method}
            onChange={(e) => setMethod(e.target.value as "merge" | "squash" | "rebase")}
            className="mt-1 w-full rounded border border-edge bg-surface px-1.5 py-1 text-content [font-size:var(--right-panel-font-size)] outline-none focus:border-accent"
          >
            <option value="squash">{t("github.mergeMethodSquash")}</option>
            <option value="merge">{t("github.mergeMethodMerge")}</option>
            <option value="rebase">{t("github.mergeMethodRebase")}</option>
          </select>
          <label className="mt-1 flex cursor-pointer items-center gap-1.5 text-content-muted [font-size:var(--rp-fs-xxs)]">
            <input type="checkbox" checked={deleteBranch} onChange={(e) => setDeleteBranch(e.target.checked)} className="accent-[var(--accent)]" />
            {t("github.deleteBranch")}
          </label>
          {confirming ? (
            <div className="mt-2 rounded-md border border-accent/40 bg-accent/5 p-2">
              <p className="text-content [font-size:var(--rp-fs-xxs)]">{t("github.mergeConfirm", { n: pull.number, base: pull.baseRef })}</p>
              <div className="mt-1.5 flex items-center gap-1.5">
                <button type="button" onClick={() => void doMerge()} disabled={busy} className="flex items-center gap-1 rounded bg-accent px-2.5 py-1 text-[11px] font-medium text-white hover:opacity-90 disabled:opacity-40">
                  {busy ? <IconLoader2 size={11} className="animate-spin" /> : null}
                  {t("github.merge")}
                </button>
                <button type="button" onClick={() => setConfirming(false)} className="rounded px-2 py-1 text-[11px] text-content-muted hover:bg-surface-hover">
                  {t("github.cancel")}
                </button>
              </div>
            </div>
          ) : (
            <button type="button" onClick={() => setConfirming(true)} className="mt-1.5 flex items-center gap-1 rounded bg-accent px-2.5 py-1 text-[11px] font-medium text-white hover:opacity-90">
              <IconGitMerge size={12} /> {t("github.merge")}
            </button>
          )}
          {mergeError && <p className="mt-1 text-danger [font-size:var(--rp-fs-xxs)]">{mergeError}</p>}
          <div className="mt-1.5 flex items-center gap-2">
            <button type="button" onClick={() => void toggleState("closed")} disabled={busy} className="rounded px-1.5 py-0.5 text-content-muted [font-size:var(--rp-fs-xxs)] hover:bg-surface-hover hover:text-content">
              {t("github.closePr")}
            </button>
          </div>
        </div>
      )}
      {!canMerge && pull.state === "closed" && (
        <div className="border-b border-edge px-3 py-2">
          <button type="button" onClick={() => void toggleState("open")} disabled={busy} className="rounded px-1.5 py-0.5 text-content-muted [font-size:var(--rp-fs-xxs)] hover:bg-surface-hover hover:text-content">
            {t("github.reopenPr")}
          </button>
        </div>
      )}

      {/* comments */}
      <div className="py-2">
        <CommentList comments={pull.comments} />
        <CommentBox owner={owner ?? ""} repo={repo ?? ""} number={pull.number} onPosted={onRefresh} />
      </div>
    </div>
  );
}

function IssueDetailView({ issue, owner, repo, onBack, onRefresh, onOpenUrl, onOpenPull, onCreateFixPr }: {
  issue: GitHubIssueDetail;
  owner: string;
  repo: string;
  onBack: () => void;
  onRefresh: () => void;
  onOpenUrl: (url: string) => void;
  onOpenPull: (number: number) => void;
  onCreateFixPr: () => void;
}) {
  const { t } = useI18n();
  return (
    <div>
      <DetailHeader number={issue.number} title={issue.title} onBack={onBack} htmlUrl={issue.htmlUrl} onOpenUrl={onOpenUrl}>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-content-subtle [font-size:var(--rp-fs-xxs)]">
          <span className={cn("shrink-0 rounded px-1.5 py-px text-[10px] font-medium leading-4", issue.state === "open" ? "bg-success/15 text-success" : "bg-danger/10 text-danger")}>
            {issue.state === "open" ? t("github.prOpen") : t("github.issueClosed")}
          </span>
          <LabelChips labels={issue.labels} />
          <span>· {t("github.by", { author: issue.author.login })}</span>
        </div>
      </DetailHeader>

      {issue.body.trim() && (
        <div className="border-b border-edge px-3 py-2 [font-size:calc(var(--right-panel-font-size)*0.92)]">
          <Markdown>{issue.body}</Markdown>
        </div>
      )}

      {/* linked PRs (cross-references from the timeline) */}
      <div className="border-b border-edge px-3 py-2">
        <div className="flex items-center gap-1 text-[10px] font-medium text-content-muted">
          <IconGitPullRequest size={11} /> {t("github.linkedPulls")}
        </div>
        {issue.linkedPulls.length === 0 ? (
          <p className="mt-1 text-content-subtle [font-size:var(--rp-fs-xxs)]">—</p>
        ) : (
          <div className="mt-1 space-y-0.5">
            {issue.linkedPulls.map((p) => (
              <button key={p.number} type="button" onClick={() => onOpenPull(p.number)} className="flex w-full items-center gap-1 rounded px-0.5 py-0.5 text-left text-content-subtle [font-size:var(--rp-fs-xxs)] hover:bg-surface-hover hover:text-content">
                <span className="shrink-0 font-mono">#{p.number}</span>
                <span className="min-w-0 flex-1 truncate">{p.title}</span>
                <StateChip state={p.state} />
              </button>
            ))}
          </div>
        )}
        <button type="button" onClick={onCreateFixPr} className="mt-1.5 flex items-center gap-1 rounded px-1.5 py-0.5 text-accent [font-size:var(--rp-fs-xxs)] hover:bg-accent/10">
          <IconPlus size={11} /> {t("github.createFixPr")}
        </button>
      </div>

      {/* close / reopen */}
      <IssueStateToggle owner={owner} repo={repo} issueNumber={issue.number} state={issue.state} onRefresh={onRefresh} />

      {/* comments */}
      <div className="py-2">
        <CommentList comments={issue.comments} />
        <CommentBox owner={owner} repo={repo} number={issue.number} onPosted={onRefresh} />
      </div>
    </div>
  );
}

function IssueStateToggle({ owner, repo, issueNumber, state, onRefresh }: {
  owner: string;
  repo: string;
  issueNumber: number;
  state: "open" | "closed";
  onRefresh: () => void;
}) {
  const { t } = useI18n();
  const toast = useToastStore((s) => s.push);
  const [busy, setBusy] = useState(false);
  const toggle = async (next: "open" | "closed") => {
    setBusy(true);
    try {
      const res = await api.github.setIssueState({ owner, repo, number: issueNumber, state: next });
      if (res.ok) onRefresh();
      else toast({ kind: "error", title: t("github.stateChangeFailed"), body: res.error });
    } catch (err) {
      toast({ kind: "error", title: t("github.stateChangeFailed"), body: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="border-b border-edge px-3 py-2">
      {state === "open" ? (
        <button type="button" onClick={() => void toggle("closed")} disabled={busy} className="rounded px-1.5 py-0.5 text-content-muted [font-size:var(--rp-fs-xxs)] hover:bg-surface-hover hover:text-content">
          {t("github.closeIssue")}
        </button>
      ) : (
        <button type="button" onClick={() => void toggle("open")} disabled={busy} className="rounded px-1.5 py-0.5 text-content-muted [font-size:var(--rp-fs-xxs)] hover:bg-surface-hover hover:text-content">
          {t("github.reopenIssue")}
        </button>
      )}
    </div>
  );
}

/* ── dialogs ── */

function DialogShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/40 p-3" onMouseDown={onClose}>
      <div className="max-h-full w-full overflow-y-auto rounded-lg border border-edge bg-surface p-3 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="mb-2 text-content [font-size:var(--right-panel-font-size)] font-medium">{title}</div>
        {children}
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded px-2.5 py-1 text-[11px] text-content-muted hover:bg-surface-hover">
            {t("github.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}

const FIELD_CLS =
  "w-full rounded border border-edge bg-surface px-1.5 py-1 text-content [font-size:var(--right-panel-font-size)] outline-none focus:border-accent";

function CreatePullDialog({ candidate, prefillFixNumber, onClose, onCreated }: {
  candidate: GitHubRepoCandidate;
  /** Issue number pre-linked ("Fixes #N" checked + appended on create). */
  prefillFixNumber: number | null;
  onClose: () => void;
  onCreated: (number: number) => void;
}) {
  const { t } = useI18n();
  const toast = useToastStore((s) => s.push);
  const [owner, repo] = candidate.slug.split("/");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [head, setHead] = useState("");
  const [base, setBase] = useState("");
  const [localBranches, setLocalBranches] = useState<string[]>([]);
  const [remoteBranches, setRemoteBranches] = useState<string[]>([]);
  const [openIssues, setOpenIssues] = useState<GitHubIssueSummary[]>(EMPTY_ISSUES);
  const [linkedIssueNumbers, setLinkedIssueNumbers] = useState<number[]>(() =>
    prefillFixNumber !== null ? [prefillFixNumber] : [],
  );
  const [draft, setDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const br = await api.github.listBranches({ owner: owner ?? "", repo: repo ?? "" });
        setRemoteBranches(br.branches);
        setBase(br.defaultBranch);
      } catch (err) {
        setError((err as Error).message);
      }
      if (candidate.repoPath) {
        try {
          const [st, branches] = await Promise.all([
            api.git.status({ repoPath: candidate.repoPath }),
            api.git.listBranches({ repoPath: candidate.repoPath }),
          ]);
          setLocalBranches(branches.branches.local.map((b) => b.name));
          setHead(st.status.branch || branches.branches.local[0]?.name || "");
        } catch {
          // detached/absent git — keep head empty; the user picks manually
        }
      }
      try {
        const { issues: list } = await api.github.listIssues({ owner: owner ?? "", repo: repo ?? "", state: "open" });
        setOpenIssues(list);
      } catch {
        // issues are optional for PR creation
      }
    })();
    // Load once per dialog open — the candidate is fixed for the dialog's
    // lifetime (the panel unmounts the dialog when the repo changes).
  }, [candidate.repoPath, owner, repo]);

  const submit = async () => {
    if (!title.trim() || !head || !base || busy) return;
    setBusy(true);
    setError(null);
    try {
      // Push the branch first (idempotent; --set-upstream covers first push).
      if (candidate.repoPath) {
        const push = await api.git.push({ repoPath: candidate.repoPath, setUpstream: true, branch: head });
        if (!push.ok) {
          setError(`${t("github.pushFailed")}: ${push.error ?? ""}`);
          setBusy(false);
          return;
        }
      }
      const fixes = linkedIssueNumbers.map((n) => `Fixes #${n}`).join(", ");
      const fullBody = fixes ? `${body.trim() ? `${body.trim()}\n\n` : ""}${fixes}` : body.trim();
      const res = await api.github.createPull({ owner: owner ?? "", repo: repo ?? "", title: title.trim(), head, base, body: fullBody, draft });
      if (res.ok && res.number !== null) {
        onCreated(res.number);
      } else {
        setError(res.error ?? t("github.createFailed"));
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogShell title={t("github.createPrTitle")} onClose={onClose}>
      <div className="space-y-2">
        {!candidate.repoPath && <p className="rounded bg-warning/10 px-2 py-1 text-warning [font-size:var(--rp-fs-xxs)]">{t("github.noLocalRepo")}</p>}
        <div className="flex gap-2">
          <label className="min-w-0 flex-1">
            <span className="mb-0.5 block text-content-muted [font-size:var(--rp-fs-xxs)]">{t("github.prHead")}</span>
            <select value={head} onChange={(e) => setHead(e.target.value)} className={FIELD_CLS} disabled={!candidate.repoPath}>
              {localBranches.length === 0 && <option value="">—</option>}
              {localBranches.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </label>
          <label className="min-w-0 flex-1">
            <span className="mb-0.5 block text-content-muted [font-size:var(--rp-fs-xxs)]">{t("github.prBase")}</span>
            <select value={base} onChange={(e) => setBase(e.target.value)} className={FIELD_CLS}>
              {remoteBranches.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </label>
        </div>
        {candidate.repoPath && <p className="text-content-subtle [font-size:var(--rp-fs-xxs)]">{t("github.prPushFirst")}</p>}
        <label className="block">
          <span className="mb-0.5 block text-content-muted [font-size:var(--rp-fs-xxs)]">{t("github.prTitle")}</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("github.prTitlePlaceholder")} className={FIELD_CLS} />
        </label>
        <label className="block">
          <span className="mb-0.5 block text-content-muted [font-size:var(--rp-fs-xxs)]">{t("github.prBody")}</span>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder={t("github.prBodyPlaceholder")} rows={3} className={cn(FIELD_CLS, "resize-y")} />
        </label>
        <div>
          <span className="mb-0.5 block text-content-muted [font-size:var(--rp-fs-xxs)]">{t("github.prLinkIssues")}</span>
          {openIssues.length === 0 ? (
            <p className="text-content-subtle [font-size:var(--rp-fs-xxs)]">—</p>
          ) : (
            <div className="max-h-24 space-y-0.5 overflow-y-auto rounded border border-edge p-1">
              {openIssues.map((i) => (
                <label key={i.number} className="flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 text-content-muted [font-size:var(--rp-fs-xxs)] hover:bg-surface-hover">
                  <input
                    type="checkbox"
                    checked={linkedIssueNumbers.includes(i.number)}
                    onChange={(e) =>
                      setLinkedIssueNumbers((prev) => (e.target.checked ? [...prev, i.number] : prev.filter((n) => n !== i.number)))
                    }
                    className="accent-[var(--accent)]"
                  />
                  <span className="shrink-0 font-mono">#{i.number}</span>
                  <span className="min-w-0 flex-1 truncate">{i.title}</span>
                </label>
              ))}
            </div>
          )}
          <p className="mt-0.5 text-content-subtle [font-size:var(--rp-fs-xxs)]">{t("github.prLinkIssuesHint")}</p>
        </div>
        <label className="flex cursor-pointer items-center gap-1.5 text-content-muted [font-size:var(--rp-fs-xxs)]">
          <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} className="accent-[var(--accent)]" />
          {t("github.prDraftToggle")}
        </label>
        {error && <p className="text-danger [font-size:var(--rp-fs-xxs)]">{error}</p>}
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="rounded px-2.5 py-1 text-[11px] text-content-muted hover:bg-surface-hover">
          {t("github.cancel")}
        </button>
        <button type="button" onClick={() => void submit()} disabled={!title.trim() || !head || !base || busy} className="flex items-center gap-1 rounded bg-accent px-2.5 py-1 text-[11px] font-medium text-white hover:opacity-90 disabled:opacity-40">
          {busy ? <IconLoader2 size={11} className="animate-spin" /> : null}
          {t("github.confirmCreate")}
        </button>
      </div>
    </DialogShell>
  );
}

function CreateIssueDialog({ owner, repo, onClose, onCreated }: {
  owner: string;
  repo: string;
  onClose: () => void;
  onCreated: (number: number) => void;
}) {
  const { t } = useI18n();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.github.createIssue({ owner, repo, title: title.trim(), body: body.trim() });
      if (res.ok && res.number !== null) onCreated(res.number);
      else setError(res.error ?? t("github.createFailed"));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <DialogShell title={t("github.createIssueTitle")} onClose={onClose}>
      <div className="space-y-2">
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("github.issueTitlePlaceholder")} className={FIELD_CLS} autoFocus />
        <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder={t("github.prBodyPlaceholder")} rows={4} className={cn(FIELD_CLS, "resize-y")} />
        {error && <p className="text-danger [font-size:var(--rp-fs-xxs)]">{error}</p>}
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="rounded px-2.5 py-1 text-[11px] text-content-muted hover:bg-surface-hover">
          {t("github.cancel")}
        </button>
        <button type="button" onClick={() => void submit()} disabled={!title.trim() || busy} className="flex items-center gap-1 rounded bg-accent px-2.5 py-1 text-[11px] font-medium text-white hover:opacity-90 disabled:opacity-40">
          {busy ? <IconLoader2 size={11} className="animate-spin" /> : null}
          {t("github.confirmCreate")}
        </button>
      </div>
    </DialogShell>
  );
}
