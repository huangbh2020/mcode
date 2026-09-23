/**
 * GitHub integration contracts (PR / issue management panel).
 *
 * The main process talks to the GitHub REST API v3 directly (Node fetch) and
 * normalizes responses into these shapes before they cross IPC — the renderer
 * never sees raw GitHub payloads. All types here are plain data (no zod) for
 * the response side; request shapes live in ipc.ts's zod schemas, mirroring
 * how the git contracts are laid out.
 */

/**
 * Settings-table key under which the GitHub personal access token is stored,
 * encrypted at rest via safeStorage (same mechanism as custom-model keys).
 * Empty/absent = fall back to the `gh` CLI's stored credentials when
 * available; both absent = the panel shows the sign-in empty state.
 */
export const GITHUB_TOKEN_SETTING_KEY = "github.token";

/**
 * Settings-table key for user-added GitHub repos that are NOT discoverable
 * from a project's git remotes (JSON: `{ [projectId]: "owner/repo" }`). The
 * panel's repo picker merges these over the auto-detected candidates; a
 * manual entry carries no repoPath, so local flows (push branch → create PR)
 * are disabled for it.
 */
export const GITHUB_MANUAL_REPOS_SETTING_KEY = "github.manualRepos";

/** A GitHub account reference (author of a PR/issue/comment). */
export interface GitHubUserRef {
  login: string;
  avatarUrl: string;
}

/** A GitHub label with its color (hex, no leading `#`). */
export interface GitHubLabelRef {
  name: string;
  color: string;
}

/** PR state union. "draft" is a sub-state of open but reads better flat. */
export type GitHubPullState = "open" | "draft" | "merged" | "closed";

/** One row of the PR list. */
export interface GitHubPullSummary {
  number: number;
  title: string;
  state: GitHubPullState;
  author: GitHubUserRef;
  /** Source branch ref (e.g. "feat/foo"). */
  headRef: string;
  /** Target branch ref (e.g. "main"). */
  baseRef: string;
  labels: GitHubLabelRef[];
  createdAt: string;
  updatedAt: string;
  /** Total comment count (issue comments + review comments). */
  comments: number;
  /** null = GitHub is still computing mergeability (freshly pushed PRs). */
  mergeable: boolean | null;
  /** GitHub's mergeable_state: clean | dirty | blocked | unstable | … */
  mergeableState: string;
}

/** One row of the issue list. */
export interface GitHubIssueSummary {
  number: number;
  title: string;
  state: "open" | "closed";
  author: GitHubUserRef;
  labels: GitHubLabelRef[];
  createdAt: string;
  updatedAt: string;
  comments: number;
}

/** A comment on a PR or issue (both share the issue-comments endpoint). */
export interface GitHubCommentEntry {
  id: number;
  author: GitHubUserRef;
  body: string;
  createdAt: string;
}

/** A file changed by a PR (list-only — no patch content in v1). */
export interface GitHubPullFileEntry {
  filename: string;
  additions: number;
  deletions: number;
  status: "added" | "removed" | "modified" | "renamed" | "changed" | "copied" | "unchanged";
}

/** An issue referenced by a PR's body/comments with a closing keyword. */
export interface GitHubLinkedIssue {
  number: number;
  title: string;
  state: "open" | "closed";
}

/** A PR cross-referenced from an issue's timeline. */
export interface GitHubLinkedPull {
  number: number;
  title: string;
  state: GitHubPullState;
  author: string;
}

/** Full PR detail (detail view). */
export interface GitHubPullDetail {
  number: number;
  title: string;
  body: string;
  state: GitHubPullState;
  author: GitHubUserRef;
  headRef: string;
  headSha: string;
  baseRef: string;
  labels: GitHubLabelRef[];
  createdAt: string;
  comments: GitHubCommentEntry[];
  files: GitHubPullFileEntry[];
  mergeable: boolean | null;
  mergeableState: string;
  /** Issues the PR would close on merge (parsed from body/comments). */
  linkedIssues: GitHubLinkedIssue[];
  /** URL of the PR on github.com. */
  htmlUrl: string;
}

/** Full issue detail (detail view). */
export interface GitHubIssueDetail {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  author: GitHubUserRef;
  labels: GitHubLabelRef[];
  createdAt: string;
  comments: GitHubCommentEntry[];
  /** PRs cross-referencing this issue (timeline events). */
  linkedPulls: GitHubLinkedPull[];
  htmlUrl: string;
}

/** Repo-level facts the panel needs (permissions, default branch). */
export interface GitHubRepoInfo {
  owner: string;
  repo: string;
  /** "owner/repo" display form. */
  fullName: string;
  privateRepo: boolean;
  defaultBranch: string;
  /** Authenticated user may push (enables merge / create PR / create issue). */
  pushAllowed: boolean;
}

/** Token resolution result (panel header + settings panel status line). */
export interface GitHubTokenStatus {
  /** true when either source has a usable token. */
  configured: boolean;
  /** Where the token came from — the settings entry or the gh CLI. */
  source: "settings" | "gh" | "none";
  /** Login of the authenticated user, when the token was verified. */
  login: string | null;
}

/** A repo candidate for the panel's repo picker. */
export interface GitHubRepoCandidate {
  /** "owner/repo". */
  slug: string;
  owner: string;
  repo: string;
  /** How this candidate was found: a github.com git remote, or user-added. */
  source: "remote" | "manual";
  /** Absolute repo root when auto-detected (enables local push flows). */
  repoPath: string | null;
}

/** `github:getContext` result — everything the panel needs to boot. */
export interface GitHubContextResult {
  token: GitHubTokenStatus;
  repos: GitHubRepoCandidate[];
}

/** Initial payload returned when initiating OAuth 2.0 Device Flow. */
export interface GitHubDeviceCodeInit {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

/** Status values returned when polling GitHub OAuth Device Flow access token. */
export type GitHubDevicePollStatus = "pending" | "slow_down" | "ok" | "expired" | "denied" | "error";

/** Result of a single poll attempt for OAuth Device Flow. */
export interface GitHubDevicePollResult {
  status: GitHubDevicePollStatus;
  /** Present on status === "ok". */
  login?: string;
  /** Present on status === "slow_down" if GitHub requested a larger interval. */
  interval?: number;
  /** Error message on failure. */
  error?: string;
}

