/**
 * IPC handlers for the GitHub PR / issue panel.
 *
 * Thin wiring: each handler validates its zod schema, delegates to
 * GitHubClient, and degrades gracefully (errors return `{ ok: false, error }`
 * or empty results rather than throwing into the renderer — same convention
 * as the git handlers).
 *
 * `github:getContext` is the only handler that touches the local filesystem:
 * it scans the project for git repos, reads each repo's remotes, and keeps
 * the github.com ones as the panel's repo candidates. Everything else talks
 * to api.github.com with an explicit owner/repo passed from the renderer.
 */
import type { IpcMain } from "electron";
import {
  IPC,
  GithubGetContextSchema,
  GithubSlugSchema,
  GithubGetPullSchema,
  GithubListIssuesSchema,
  GithubMergePullSchema,
  GithubCreateCommentSchema,
  GithubSetIssueStateSchema,
  GithubCreateIssueSchema,
  GithubCreatePullSchema,
  GithubSetTokenSchema,
  GithubPollDeviceFlowSchema,
} from "@contracts/ipc";
import type { GitHubRepoCandidate } from "@contracts/ipc";
import {
  createComment,
  createIssue,
  createPull,
  getIssueDetail,
  getPullDetail,
  getRepoInfo,
  listBranches,
  listIssues,
  listPulls,
  mergePull,
  parseGithubRemote,
  setIssueState,
  storeGithubToken,
  verifyGithubToken,
  startGithubDeviceFlow,
  pollGithubDeviceFlow,
  GitHubError,
} from "@main/github/GitHubClient.js";
import { findGitRepos, loadSimpleGit } from "./git.js";
import { isKnownWorkspaceRoot } from "@main/lib/pathGuard.js";
import { log } from "@main/lib/logger.js";

/** One-line error extraction: GitHubError carries an HTTP status; anything
 *  else prints its message. Never leaks the token (fetch errors don't embed
 *  request headers, and we never put the token in a URL). */
function errorText(err: unknown): string {
  if (err instanceof GitHubError) return err.message;
  return (err as Error)?.message ?? String(err);
}

export function registerGithubHandlers(ipcMain: IpcMain): void {
  /* ── github:getContext — token status + github repos under a project ── */
  ipcMain.handle(IPC.GITHUB_GET_CONTEXT, async (_evt, raw) => {
    const input = GithubGetContextSchema.parse(raw);
    const token = await verifyGithubToken();
    if (!isKnownWorkspaceRoot(input.projectPath)) {
      log.warn(`github.getContext refused — unknown projectPath: ${input.projectPath}`);
      return { context: { token: { configured: token.ok, source: token.source, login: token.login }, repos: [] } };
    }
    const repos: GitHubRepoCandidate[] = [];
    try {
      const repoPaths = await findGitRepos(input.projectPath, 2);
      await Promise.all(
        repoPaths.map(async (repoPath) => {
          try {
            const git = (await loadSimpleGit())(repoPath);
            const remotes = await git.getRemotes(true);
            for (const remote of remotes) {
              const slug = parseGithubRemote(remote.refs.fetch ?? remote.refs.push ?? "");
              // One candidate per repo: the first github.com remote wins.
              if (slug && !repos.some((r) => r.repoPath === repoPath)) {
                repos.push({ slug: `${slug.owner}/${slug.repo}`, owner: slug.owner, repo: slug.repo, source: "remote", repoPath });
                return;
              }
            }
          } catch (err) {
            log.warn(`github.getContext: failed to read remotes of ${repoPath}: ${errorText(err)}`);
          }
        }),
      );
    } catch (err) {
      log.warn(`github.getContext repo scan failed: ${errorText(err)}`);
    }
    repos.sort((a, b) => a.slug.localeCompare(b.slug));
    return {
      context: {
        token: { configured: token.ok, source: token.source, login: token.login },
        repos,
      },
    };
  });

  /* ── github:getRepo — default branch + push permission ── */
  ipcMain.handle(IPC.GITHUB_GET_REPO, async (_evt, raw) => {
    const { owner, repo } = GithubSlugSchema.parse(raw);
    try {
      return { repo: await getRepoInfo(owner, repo) };
    } catch (err) {
      log.warn(`github.getRepo ${owner}/${repo} failed: ${errorText(err)}`);
      throw err;
    }
  });

  ipcMain.handle(IPC.GITHUB_LIST_PULLS, async (_evt, raw) => {
    const { owner, repo } = GithubSlugSchema.parse(raw);
    try {
      return { pulls: await listPulls(owner, repo) };
    } catch (err) {
      log.warn(`github.listPulls ${owner}/${repo} failed: ${errorText(err)}`);
      throw err;
    }
  });

  ipcMain.handle(IPC.GITHUB_LIST_ISSUES, async (_evt, raw) => {
    const input = GithubListIssuesSchema.parse(raw);
    try {
      return { issues: await listIssues(input.owner, input.repo, input.state) };
    } catch (err) {
      log.warn(`github.listIssues ${input.owner}/${input.repo} failed: ${errorText(err)}`);
      throw err;
    }
  });

  ipcMain.handle(IPC.GITHUB_GET_PULL, async (_evt, raw) => {
    const input = GithubGetPullSchema.parse(raw);
    try {
      return { pull: await getPullDetail(input.owner, input.repo, input.number) };
    } catch (err) {
      log.warn(`github.getPull ${input.owner}/${input.repo}#${input.number} failed: ${errorText(err)}`);
      throw err;
    }
  });

  ipcMain.handle(IPC.GITHUB_GET_ISSUE, async (_evt, raw) => {
    const input = GithubGetPullSchema.parse(raw);
    try {
      return { issue: await getIssueDetail(input.owner, input.repo, input.number) };
    } catch (err) {
      log.warn(`github.getIssue ${input.owner}/${input.repo}#${input.number} failed: ${errorText(err)}`);
      throw err;
    }
  });

  ipcMain.handle(IPC.GITHUB_MERGE_PULL, async (_evt, raw) => {
    const input = GithubMergePullSchema.parse(raw);
    try {
      const res = await mergePull({
        owner: input.owner,
        repo: input.repo,
        number: input.number,
        method: input.method,
        deleteBranch: input.deleteBranch,
        commitTitle: input.commitTitle ?? null,
        commitMessage: input.commitMessage ?? null,
      });
      log.info(`github.mergePull ${input.owner}/${input.repo}#${input.number} merged=${res.merged} (${input.method})`);
      return { ok: res.merged, error: res.merged ? undefined : (res.message ?? "merge rejected") };
    } catch (err) {
      log.warn(`github.mergePull ${input.owner}/${input.repo}#${input.number} failed: ${errorText(err)}`);
      return { ok: false, error: errorText(err) };
    }
  });

  ipcMain.handle(IPC.GITHUB_CREATE_COMMENT, async (_evt, raw) => {
    const input = GithubCreateCommentSchema.parse(raw);
    try {
      return { comment: await createComment(input.owner, input.repo, input.number, input.body) };
    } catch (err) {
      log.warn(`github.createComment ${input.owner}/${input.repo}#${input.number} failed: ${errorText(err)}`);
      throw err;
    }
  });

  ipcMain.handle(IPC.GITHUB_SET_ISSUE_STATE, async (_evt, raw) => {
    const input = GithubSetIssueStateSchema.parse(raw);
    try {
      await setIssueState(input.owner, input.repo, input.number, input.state);
      return { ok: true };
    } catch (err) {
      log.warn(`github.setIssueState ${input.owner}/${input.repo}#${input.number} → ${input.state} failed: ${errorText(err)}`);
      return { ok: false, error: errorText(err) };
    }
  });

  ipcMain.handle(IPC.GITHUB_CREATE_ISSUE, async (_evt, raw) => {
    const input = GithubCreateIssueSchema.parse(raw);
    try {
      const number = await createIssue(input.owner, input.repo, input.title, input.body);
      log.info(`github.createIssue ${input.owner}/${input.repo} #${number}`);
      return { ok: number !== null, number, error: number === null ? "no number in response" : undefined };
    } catch (err) {
      log.warn(`github.createIssue ${input.owner}/${input.repo} failed: ${errorText(err)}`);
      return { ok: false, number: null, error: errorText(err) };
    }
  });

  ipcMain.handle(IPC.GITHUB_CREATE_PULL, async (_evt, raw) => {
    const input = GithubCreatePullSchema.parse(raw);
    try {
      const res = await createPull({
        owner: input.owner,
        repo: input.repo,
        title: input.title,
        head: input.head,
        base: input.base,
        body: input.body,
        draft: input.draft,
      });
      log.info(`github.createPull ${input.owner}/${input.repo} ${input.head}→${input.base} #${res.number}`);
      return { ok: res.number !== null, number: res.number, htmlUrl: res.htmlUrl, error: res.number === null ? "no number in response" : undefined };
    } catch (err) {
      log.warn(`github.createPull ${input.owner}/${input.repo} failed: ${errorText(err)}`);
      return { ok: false, number: null, htmlUrl: null, error: errorText(err) };
    }
  });

  ipcMain.handle(IPC.GITHUB_LIST_BRANCHES, async (_evt, raw) => {
    const { owner, repo } = GithubSlugSchema.parse(raw);
    try {
      const [branches, info] = await Promise.all([listBranches(owner, repo), getRepoInfo(owner, repo)]);
      return { branches, defaultBranch: info.defaultBranch };
    } catch (err) {
      log.warn(`github.listBranches ${owner}/${repo} failed: ${errorText(err)}`);
      throw err;
    }
  });

  /* ── github:setToken — persist (or clear) the PAT, encrypted at rest ── */
  ipcMain.handle(IPC.GITHUB_SET_TOKEN, async (_evt, raw) => {
    const { token } = GithubSetTokenSchema.parse(raw);
    await storeGithubToken(token.trim());
    log.info("github.setToken: stored a new token (value never logged)");
  });

  /* ── github:verifyToken — settings-panel test button ── */
  ipcMain.handle(IPC.GITHUB_VERIFY_TOKEN, async () => {
    const res = await verifyGithubToken();
    return { ok: res.ok, login: res.login, source: res.source, error: res.error };
  });

  /* ── github:startDeviceFlow — initiate OAuth 2.0 Device Flow ── */
  ipcMain.handle(IPC.GITHUB_START_DEVICE_FLOW, async () => {
    try {
      return await startGithubDeviceFlow();
    } catch (err) {
      log.warn(`github.startDeviceFlow failed: ${errorText(err)}`);
      throw err;
    }
  });

  /* ── github:pollDeviceFlow — poll token endpoint for Device Flow ── */
  ipcMain.handle(IPC.GITHUB_POLL_DEVICE_FLOW, async (_evt, raw) => {
    const { deviceCode } = GithubPollDeviceFlowSchema.parse(raw);
    try {
      return await pollGithubDeviceFlow(deviceCode);
    } catch (err) {
      log.warn(`github.pollDeviceFlow failed: ${errorText(err)}`);
      return { status: "error", error: errorText(err) };
    }
  });
}
