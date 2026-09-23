/**
 * GitHub REST API v3 client for the PR / issue panel.
 *
 * Deliberately dependency-free (no octokit): the panel needs a dozen read
 * endpoints plus a handful of writes, all of which are one `fetch` each.
 * Responses are normalized into the contract shapes (packages/contracts/
 * github.ts) here — the renderer never sees raw GitHub payloads, so field
 * renames on GitHub's side stay contained to this file.
 *
 * Token resolution order: the encrypted settings entry (github.token) → the
 * `gh` CLI's stored credentials (`gh auth token`, 5s timeout). The resolved
 * token is cached for 60s so a burst of panel calls doesn't re-exec gh.
 */
import { execFile } from "node:child_process";
import { shell } from "electron";
import { SettingRepo } from "@main/store/repositories.js";
import { decrypt, encrypt } from "@main/lib/secretStore.js";
import { log } from "@main/lib/logger.js";
import {
  GITHUB_TOKEN_SETTING_KEY,
  type GitHubCommentEntry,
  type GitHubDeviceCodeInit,
  type GitHubDevicePollResult,
  type GitHubIssueDetail,
  type GitHubIssueSummary,
  type GitHubLabelRef,
  type GitHubLinkedIssue,
  type GitHubLinkedPull,
  type GitHubPullDetail,
  type GitHubPullFileEntry,
  type GitHubPullState,
  type GitHubPullSummary,
  type GitHubRepoInfo,
  type GitHubTokenStatus,
  type GitHubUserRef,
} from "@contracts/ipc";

const API_BASE = "https://api.github.com";
const GITHUB_HOST_BASE = "https://github.com";
/** Official GitHub CLI OAuth client ID (supports Device Flow without client secret). */
const GH_DEVICE_CLIENT_ID = "178c6fc778ccc68e1d6a";
const GH_DEVICE_SCOPES = "repo,read:org,gist";
const TOKEN_CACHE_TTL_MS = 60_000;
/** `gh auth token` is a local exec — should be instant; don't hang the panel. */
const GH_CLI_TIMEOUT_MS = 5_000;

/** A GitHub API error with enough context for the UI to render a reason. */
export class GitHubError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
  }
}

/* ── Token resolution ── */

let tokenCache: { value: string; source: "settings" | "gh"; at: number } | null = null;

/** Read the stored token (settings first, then gh CLI). Empty string clears
 *  the settings entry, which degrades to the gh fallback naturally. */
export async function resolveGithubToken(): Promise<{ token: string; source: "settings" | "gh" | "none" }> {
  if (tokenCache && Date.now() - tokenCache.at < TOKEN_CACHE_TTL_MS) {
    return { token: tokenCache.value, source: tokenCache.source };
  }
  // Settings entry — decrypt() reverses safeStorage (or the base64 fallback).
  // SettingRepo is synchronous (better-sqlite3).
  const stored = SettingRepo.get(GITHUB_TOKEN_SETTING_KEY);
  if (stored) {
    try {
      const token = decrypt(stored);
      if (token) {
        tokenCache = { value: token, source: "settings", at: Date.now() };
        return { token, source: "settings" };
      }
    } catch (err) {
      log.warn(`github token decrypt failed: ${(err as Error).message}`);
    }
  }
  // gh CLI fallback — no exec when gh isn't installed (ENOENT → null).
  const gh = await ghAuthToken();
  if (gh) {
    tokenCache = { value: gh, source: "gh", at: Date.now() };
    return { token: gh, source: "gh" };
  }
  return { token: "", source: "none" };
}

/** Persist (or clear, with "") the settings token. Invalidates the cache. */
export async function storeGithubToken(token: string): Promise<void> {
  tokenCache = null;
  if (!token) {
    SettingRepo.set(GITHUB_TOKEN_SETTING_KEY, "");
    return;
  }
  SettingRepo.set(GITHUB_TOKEN_SETTING_KEY, encrypt(token));
}

/** Drop the cached token (settings panel saves / verify failures). */
export function invalidateGithubTokenCache(): void {
  tokenCache = null;
}

function ghAuthToken(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("gh", ["auth", "token"], { timeout: GH_CLI_TIMEOUT_MS }, (err, stdout) => {
      if (err || !stdout) {
        resolve(null);
        return;
      }
      const token = String(stdout).trim();
      resolve(token || null);
    });
  });
}

/** Verify the token chain by fetching the authenticated user. */
export async function verifyGithubToken(): Promise<GitHubTokenStatus & { ok: boolean; error: string | null }> {
  const { token, source } = await resolveGithubToken();
  if (!token) return { configured: false, source: "none", login: null, ok: false, error: null };
  try {
    const user = await githubRequest<{ login: string }>("/user", { token });
    return { configured: true, source, login: user.login ?? null, ok: true, error: null };
  } catch (err) {
    const msg = err instanceof GitHubError ? `HTTP ${err.status}: ${err.message}` : (err as Error).message;
    return { configured: false, source, login: null, ok: false, error: msg };
  }
}

/** Initiate GitHub OAuth 2.0 Device Flow (RFC 8628).
 *  Requests a verification code from GitHub and opens the user's default browser. */
export async function startGithubDeviceFlow(): Promise<GitHubDeviceCodeInit> {
  const params = new URLSearchParams({
    client_id: GH_DEVICE_CLIENT_ID,
    scope: GH_DEVICE_SCOPES,
  });
  const res = await fetch(`${GITHUB_HOST_BASE}/login/device/code`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Mcode-Desktop",
    },
    body: params.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`Failed to initiate GitHub Device Flow: HTTP ${res.status}`);
  }
  const data = (await res.json()) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    expires_in: number;
    interval: number;
    error?: string;
    error_description?: string;
  };
  if (data.error || !data.device_code) {
    throw new Error(data.error_description ?? data.error ?? "Failed to initiate GitHub Device Flow");
  }

  // Attempt to open the verification uri in the user's browser automatically
  try {
    void shell.openExternal(data.verification_uri);
  } catch (err) {
    log.warn(`github device flow: failed to open browser automatically: ${(err as Error).message}`);
  }

  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    expiresIn: data.expires_in ?? 900,
    interval: data.interval ?? 5,
  };
}

/** Poll GitHub token endpoint once for OAuth 2.0 Device Flow.
 *  If authorized, saves the token and returns { status: "ok", login }. */
export async function pollGithubDeviceFlow(deviceCode: string): Promise<GitHubDevicePollResult> {
  const params = new URLSearchParams({
    client_id: GH_DEVICE_CLIENT_ID,
    device_code: deviceCode,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });
  const res = await fetch(`${GITHUB_HOST_BASE}/login/oauth/access_token`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Mcode-Desktop",
    },
    body: params.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    return { status: "error", error: `HTTP ${res.status}` };
  }
  const data = (await res.json()) as {
    access_token?: string;
    token_type?: string;
    scope?: string;
    error?: string;
    error_description?: string;
    interval?: number;
  };

  if (data.error) {
    if (data.error === "authorization_pending") {
      return { status: "pending" };
    }
    if (data.error === "slow_down") {
      return { status: "slow_down", interval: data.interval };
    }
    if (data.error === "expired_token") {
      return { status: "expired", error: data.error_description ?? data.error };
    }
    if (data.error === "access_denied") {
      return { status: "denied", error: data.error_description ?? data.error };
    }
    return { status: "error", error: data.error_description ?? data.error };
  }

  if (data.access_token) {
    await storeGithubToken(data.access_token);
    const verify = await verifyGithubToken();
    return {
      status: "ok",
      login: verify.login ?? undefined,
    };
  }

  return { status: "error", error: "Unexpected response from GitHub" };
}

/* ── Core request ── */

interface RequestOpts {
  token: string;
  method?: "GET" | "POST" | "PUT" | "PATCH";
  body?: unknown;
}

async function githubRequest<T>(path: string, opts: RequestOpts): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${opts.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      // GitHub requires a UA; identify the app (no token, no user data).
      "User-Agent": "Mcode-Desktop",
      "Content-Type": "application/json",
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    // Don't let a hung gateway hold the panel open forever.
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    let detail = "";
    try {
      const payload = (await res.json()) as { message?: string };
      detail = payload.message ? `: ${payload.message}` : "";
    } catch {
      // non-JSON error body — keep the status line only
    }
    throw new GitHubError(res.status, `GitHub API ${res.status}${detail}`);
  }
  // 204 (merge success) has no body.
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Page 1 at per_page=100 is plenty for a working panel's open lists. */
async function githubList<T>(path: string, opts: RequestOpts): Promise<T[]> {
  const sep = path.includes("?") ? "&" : "?";
  return githubRequest<T[]>(`${path}${sep}per_page=100&page=1`, opts);
}

/** Run a call with the resolved token; surfaces "no token" as a clean 401. */
async function withToken<T>(fn: (token: string) => Promise<T>): Promise<T> {
  const { token } = await resolveGithubToken();
  if (!token) {
    throw new GitHubError(401, "no GitHub token configured");
  }
  return fn(token);
}

/* ── Remote URL parsing (project repo → owner/repo) ── */

const GITHUB_SSH_RE = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/;
const GITHUB_HTTPS_RE = /^https?:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/;
const GITHUB_SSH_URL_RE = /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/;

/** Parse a git remote URL into a github.com owner/repo slug. Null for other
 *  hosts (GitLab, corporate Gerrit…) and non-URL noise. Pure — unit-smoked. */
export function parseGithubRemote(url: string): { owner: string; repo: string } | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  const match =
    GITHUB_SSH_RE.exec(trimmed) ?? GITHUB_HTTPS_RE.exec(trimmed) ?? GITHUB_SSH_URL_RE.exec(trimmed);
  if (!match) return null;
  const owner = match[1];
  const repo = match[2];
  if (!owner || !repo) return null;
  return { owner, repo };
}

/* ── Normalizers (raw GitHub payloads → contract shapes) ── */

// GitHub's raw shapes are much wider than what we render; picking the fields
// off with narrow types keeps `any` out without modeling the whole payload.
interface RawUser {
  login?: string;
  avatar_url?: string;
}
interface RawLabel {
  name?: string;
  color?: string;
}
interface RawIssueLike {
  number?: number;
  title?: string;
  body?: string | null;
  state?: string;
  draft?: boolean;
  merged_at?: string | null;
  closed_at?: string | null;
  created_at?: string;
  updated_at?: string;
  comments?: number;
  html_url?: string;
  user?: RawUser;
  labels?: RawLabel[];
  pull_request?: unknown;
  head?: { ref?: string; sha?: string };
  base?: { ref?: string };
  mergeable?: boolean | null;
  mergeable_state?: string;
}

function toUser(u: RawUser | undefined): GitHubUserRef {
  return { login: u?.login ?? "unknown", avatarUrl: u?.avatar_url ?? "" };
}

function toLabels(labels: RawLabel[] | undefined): GitHubLabelRef[] {
  return (labels ?? [])
    .filter((l): l is { name: string; color: string } => typeof l?.name === "string")
    .map((l) => ({ name: l.name, color: l.color || "666666" }));
}

function toPullState(raw: RawIssueLike): GitHubPullState {
  if (raw.draft === true) return "draft";
  if (raw.merged_at) return "merged";
  if (raw.state === "closed") return "closed";
  return "open";
}

function toPullSummary(raw: RawIssueLike): GitHubPullSummary {
  return {
    number: raw.number ?? 0,
    title: raw.title ?? "",
    state: toPullState(raw),
    author: toUser(raw.user),
    headRef: raw.head?.ref ?? "",
    baseRef: raw.base?.ref ?? "",
    labels: toLabels(raw.labels),
    createdAt: raw.created_at ?? "",
    updatedAt: raw.updated_at ?? "",
    comments: raw.comments ?? 0,
    mergeable: raw.mergeable === null || raw.mergeable === undefined ? null : raw.mergeable,
    mergeableState: raw.mergeable_state ?? "unknown",
  };
}

function toIssueSummary(raw: RawIssueLike): GitHubIssueSummary {
  return {
    number: raw.number ?? 0,
    title: raw.title ?? "",
    state: raw.state === "closed" ? "closed" : "open",
    author: toUser(raw.user),
    labels: toLabels(raw.labels),
    createdAt: raw.created_at ?? "",
    updatedAt: raw.updated_at ?? "",
    comments: raw.comments ?? 0,
  };
}

function toComment(raw: RawIssueLike & { id?: number }): GitHubCommentEntry {
  return {
    id: raw.id ?? 0,
    author: toUser(raw.user),
    body: raw.body ?? "",
    createdAt: raw.created_at ?? "",
  };
}

/* ── Closing-keyword issue linking ──
 * GitHub auto-closes issues when a PR with "Fixes #N" merges into the default
 * branch. The REST pull object doesn't expose the parsed references, so we
 * re-parse the same keywords the CLI/website recognize. */

const CLOSES_RE =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*[:#]?\s*#(\d+)\b/gi;

/** Extract the issue numbers a PR's text closes ("Fixes #12, closes #34").
 *  Pure — unit-smoked. */
export function parseClosingIssues(text: string): number[] {
  const found = new Set<number>();
  for (const match of text.matchAll(CLOSES_RE)) {
    const n = Number(match[1]);
    if (n > 0) found.add(n);
  }
  return [...found];
}

/* ── Public API surface (used by ipc/github.ts) ── */

export async function getRepoInfo(owner: string, repo: string): Promise<GitHubRepoInfo> {
  return withToken(async (token) => {
    const raw = await githubRequest<RawIssueLike & {
      full_name?: string;
      private?: boolean;
      default_branch?: string;
      permissions?: { push?: boolean };
    }>(`/repos/${owner}/${repo}`, { token });
    return {
      owner,
      repo,
      fullName: raw.full_name ?? `${owner}/${repo}`,
      privateRepo: raw.private === true,
      defaultBranch: raw.default_branch ?? "main",
      pushAllowed: raw.permissions?.push === true,
    };
  });
}

export async function listPulls(owner: string, repo: string): Promise<GitHubPullSummary[]> {
  return withToken(async (token) => {
    const raws = await githubList<RawIssueLike>(`/repos/${owner}/${repo}/pulls`, { token });
    // `mergeable` is null while GitHub computes it — such summaries carry no
    // usable badge, but the detail view re-fetches, so pass them through.
    return raws.filter((r) => r.pull_request === undefined).map(toPullSummary);
  });
}

export async function listIssues(
  owner: string,
  repo: string,
  state: "open" | "closed" | "all",
): Promise<GitHubIssueSummary[]> {
  return withToken(async (token) => {
    const raws = await githubList<RawIssueLike>(
      `/repos/${owner}/${repo}/issues?state=${state}`,
      { token },
    );
    // The issues endpoint deliberately includes PRs — drop them.
    return raws.filter((r) => r.pull_request === undefined).map(toIssueSummary);
  });
}

export async function getPullDetail(owner: string, repo: string, number: number): Promise<GitHubPullDetail> {
  return withToken(async (token) => {
    const pull = await githubRequest<RawIssueLike>(`/repos/${owner}/${repo}/pulls/${number}`, { token });
    const [comments, files] = await Promise.all([
      githubRequest<RawIssueLike[]>(`/repos/${owner}/${repo}/issues/${number}/comments`, { token }),
      githubRequest<Array<Record<string, unknown>>>(`/repos/${owner}/${repo}/pulls/${number}/files`, { token }).catch(() => []),
    ]);
    // Linked issues = parsed closing keywords from body + comments, resolved
    // against the repo for title/state (best-effort — a failed lookup keeps
    // the number with empty title).
    const numbers = parseClosingIssues(
      [pull.body ?? "", ...comments.map((c) => c.body ?? "")].join("\n"),
    );
    const linked: GitHubLinkedIssue[] = await Promise.all(
      numbers.map(async (n) => {
        try {
          const raw = await githubRequest<RawIssueLike>(`/repos/${owner}/${repo}/issues/${n}`, { token });
          return { number: n, title: raw.title ?? "", state: raw.state === "closed" ? "closed" : "open" };
        } catch {
          return { number: n, title: "", state: "open" as const };
        }
      }),
    );
    return {
      number: pull.number ?? number,
      title: pull.title ?? "",
      body: pull.body ?? "",
      state: toPullState(pull),
      author: toUser(pull.user),
      headRef: pull.head?.ref ?? "",
      headSha: pull.head?.sha ?? "",
      baseRef: pull.base?.ref ?? "",
      labels: toLabels(pull.labels),
      createdAt: pull.created_at ?? "",
      comments: comments.map(toComment),
      files: files.map((f) => ({
        filename: String(f.filename ?? ""),
        additions: Number(f.additions ?? 0),
        deletions: Number(f.deletions ?? 0),
        status: String(f.status ?? "changed") as GitHubPullFileEntry["status"],
      })),
      mergeable: pull.mergeable === null || pull.mergeable === undefined ? null : pull.mergeable,
      mergeableState: pull.mergeable_state ?? "unknown",
      linkedIssues: linked,
      htmlUrl: pull.html_url ?? "",
    };
  });
}

export async function getIssueDetail(owner: string, repo: string, number: number): Promise<GitHubIssueDetail> {
  return withToken(async (token) => {
    const issue = await githubRequest<RawIssueLike>(`/repos/${owner}/${repo}/issues/${number}`, { token });
    const [comments, timeline] = await Promise.all([
      githubRequest<RawIssueLike[]>(`/repos/${owner}/${repo}/issues/${number}/comments`, { token }),
      // Timeline is GA under the plain +json media type; failures degrade to
      // "no linked PRs" (e.g. fine-grained tokens without timeline read).
      githubRequest<Array<Record<string, unknown>>>(
        `/repos/${owner}/${repo}/issues/${number}/timeline`,
        { token },
      ).catch(() => [] as Array<Record<string, unknown>>),
    ]);
    const linkedPulls: GitHubLinkedPull[] = [];
    for (const event of timeline) {
      if (event.event !== "cross-referenced") continue;
      const source = event.source as { issue?: RawIssueLike } | undefined;
      const ref = source?.issue;
      if (!ref || ref.pull_request === undefined || typeof ref.number !== "number") continue;
      if (linkedPulls.some((p) => p.number === ref.number)) continue;
      linkedPulls.push({
        number: ref.number,
        title: ref.title ?? "",
        state: toPullState(ref),
        author: ref.user?.login ?? "",
      });
    }
    return {
      number: issue.number ?? number,
      title: issue.title ?? "",
      body: issue.body ?? "",
      state: issue.state === "closed" ? "closed" : "open",
      author: toUser(issue.user),
      labels: toLabels(issue.labels),
      createdAt: issue.created_at ?? "",
      comments: comments.map(toComment),
      linkedPulls,
      htmlUrl: issue.html_url ?? "",
    };
  });
}

export async function mergePull(opts: {
  owner: string;
  repo: string;
  number: number;
  method: "merge" | "squash" | "rebase";
  deleteBranch: boolean;
  commitTitle: string | null;
  commitMessage: string | null;
}): Promise<{ merged: boolean; message: string | null }> {
  return withToken(async (token) => {
    const body: Record<string, unknown> = { merge_method: opts.method };
    if (opts.deleteBranch) body.delete_branch_after_merge = true;
    if (opts.commitTitle) body.commit_title = opts.commitTitle;
    if (opts.commitMessage) body.commit_message = opts.commitMessage;
    const raw = await githubRequest<{ merged?: boolean; message?: string }>(
      `/repos/${opts.owner}/${opts.repo}/pulls/${opts.number}/merge`,
      { token, method: "PUT", body },
    );
    return { merged: raw.merged === true, message: raw.message ?? null };
  });
}

export async function createComment(
  owner: string,
  repo: string,
  number: number,
  body: string,
): Promise<GitHubCommentEntry> {
  return withToken(async (token) => {
    const raw = await githubRequest<RawIssueLike & { id?: number }>(
      `/repos/${owner}/${repo}/issues/${number}/comments`,
      { token, method: "POST", body: { body } },
    );
    return toComment(raw);
  });
}

export async function setIssueState(
  owner: string,
  repo: string,
  number: number,
  state: "open" | "closed",
): Promise<void> {
  return withToken(async (token) => {
    await githubRequest(`/repos/${owner}/${repo}/issues/${number}`, {
      token,
      method: "PATCH",
      body: { state },
    });
  });
}

export async function createIssue(
  owner: string,
  repo: string,
  title: string,
  body: string,
): Promise<number | null> {
  return withToken(async (token) => {
    const raw = await githubRequest<RawIssueLike>(`/repos/${owner}/${repo}/issues`, {
      token,
      method: "POST",
      body: { title, body },
    });
    return raw.number ?? null;
  });
}

export async function createPull(opts: {
  owner: string;
  repo: string;
  title: string;
  head: string;
  base: string;
  body: string;
  draft: boolean;
}): Promise<{ number: number | null; htmlUrl: string | null }> {
  return withToken(async (token) => {
    const raw = await githubRequest<RawIssueLike>(`/repos/${opts.owner}/${opts.repo}/pulls`, {
      token,
      method: "POST",
      body: { title: opts.title, head: opts.head, base: opts.base, body: opts.body, draft: opts.draft },
    });
    return { number: raw.number ?? null, htmlUrl: raw.html_url ?? null };
  });
}

export async function listBranches(owner: string, repo: string): Promise<string[]> {
  return withToken(async (token) => {
    const raws = await githubList<{ name?: string }>(`/repos/${owner}/${repo}/branches`, { token });
    return raws.map((b) => b.name ?? "").filter((n) => n !== "");
  });
}
