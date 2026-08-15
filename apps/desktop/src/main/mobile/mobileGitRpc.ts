/**
 * mobileGitRpc — the mobile git whitelist, reusing the desktop git module's
 * exported helpers so behavior is identical (same path guard, same simple-git
 * loader, same commit-message LLM core).
 *
 * Registered into the mobile RPC table via {@link registerMobileRpcHandlers}.
 * Each handler parses its zod input, applies the same `findContainingProject`
 * path guard the desktop IPC handlers use, and calls simple-git / the shared
 * commit-gen core. Operations are the focused subset the mobile Git panel
 * needs: discover / status / diff / stage / unstage / commit / push / pull /
 * generateCommitMessage. Dangerous ops (discard, resolveConflicts) are
 * intentionally NOT exposed to mobile.
 */
import { resolve, relative } from "node:path";
import {
  GitDiscoverReposSchema,
  GitRepoPathSchema,
  GitStageSchema,
  GitUnstageSchema,
  GitCommitSchema,
  GitDiffSchema,
  GitGenerateCommitSchema,
  GitCancelGenerateCommitSchema,
  type GitRepo,
} from "@contracts/ipc";
import { ProjectRepo } from "@main/store/repositories.js";
import {
  loadSimpleGit,
  findContainingProject,
  mapStatus,
  findGitRepos,
  generateCommitMessageForRepo,
  cancelCommitMessageGeneration,
  MAX_SCAN_DEPTH,
} from "@main/ipc/git.js";
import { registerMobileRpcHandlers, type RpcHandler } from "./mobileRpc.js";
import { log } from "@main/lib/logger.js";

const REFUSE = "仓库路径不在任何已添加的项目内";

const handlers: Record<string, RpcHandler> = {
  "git:discoverRepos": async (raw) => {
    const input = GitDiscoverReposSchema.parse(raw);
    const known = ProjectRepo.list().some((p) => resolve(p.path) === resolve(input.projectPath));
    if (!known) return { repos: [] };
    try {
      const repoPaths = await findGitRepos(input.projectPath, MAX_SCAN_DEPTH);
      const repos: GitRepo[] = repoPaths.map((p) => {
        const rel = relative(input.projectPath, p);
        const name = rel === "" ? input.projectPath.split(/[/\\]/).pop() || p : rel;
        return { path: p, name, isRepo: true as const };
      });
      repos.sort((a, b) => a.name.localeCompare(b.name));
      return { repos };
    } catch (err) {
      log.warn(`mobile git.discoverRepos failed: ${(err as Error).message}`);
      return { repos: [] };
    }
  },

  "git:status": async (raw) => {
    const input = GitRepoPathSchema.parse(raw);
    if (!findContainingProject(input.repoPath)) {
      return { status: { branch: "", ahead: 0, behind: 0, files: [] } };
    }
    try {
      const git = (await loadSimpleGit())(input.repoPath);
      const status = await git.status();
      return { status: mapStatus(status) };
    } catch (err) {
      log.warn(`mobile git.status failed for ${input.repoPath}: ${(err as Error).message}`);
      return { status: { branch: "", ahead: 0, behind: 0, files: [] } };
    }
  },

  "git:diff": async (raw) => {
    const input = GitDiffSchema.parse(raw);
    if (!findContainingProject(input.repoPath)) return { patch: "" };
    try {
      const git = (await loadSimpleGit())(input.repoPath);
      const args = input.staged ? ["--cached", "--", input.filePath] : ["--", input.filePath];
      const patch = await git.diff(args);
      return { patch };
    } catch (err) {
      log.warn(`mobile git.diff failed: ${(err as Error).message}`);
      return { patch: "" };
    }
  },

  "git:stage": async (raw) => {
    const input = GitStageSchema.parse(raw);
    if (!findContainingProject(input.repoPath)) return { ok: false, error: REFUSE };
    try {
      const git = (await loadSimpleGit())(input.repoPath);
      await git.add(input.filePaths);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },

  "git:unstage": async (raw) => {
    const input = GitUnstageSchema.parse(raw);
    if (!findContainingProject(input.repoPath)) return { ok: false, error: REFUSE };
    try {
      const git = (await loadSimpleGit())(input.repoPath);
      await git.reset(input.filePaths.length > 0 ? ["--", ...input.filePaths] : []);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },

  "git:commit": async (raw) => {
    const input = GitCommitSchema.parse(raw);
    if (!findContainingProject(input.repoPath)) return { ok: false, error: REFUSE };
    try {
      const git = (await loadSimpleGit())(input.repoPath);
      await git.commit(input.message);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },

  "git:push": async (raw) => {
    const input = GitRepoPathSchema.parse(raw);
    if (!findContainingProject(input.repoPath)) return { ok: false, error: REFUSE };
    try {
      const git = (await loadSimpleGit())(input.repoPath);
      await git.push();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },

  "git:pull": async (raw) => {
    const input = GitRepoPathSchema.parse(raw);
    if (!findContainingProject(input.repoPath)) return { ok: false, error: REFUSE };
    try {
      const git = (await loadSimpleGit())(input.repoPath);
      try {
        await git.pull();
      } catch (pullErr) {
        const st = await git.status().catch(() => null);
        const conflicted = st?.conflicted ?? [];
        if (conflicted.length > 0) return { ok: true, conflict: true, conflictedFiles: conflicted };
        throw pullErr;
      }
      const st = await git.status().catch(() => null);
      const conflicted = st?.conflicted ?? [];
      if (conflicted.length > 0) return { ok: true, conflict: true, conflictedFiles: conflicted };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },

  "git:generateCommitMessage": async (raw) => {
    const input = GitGenerateCommitSchema.parse(raw);
    if (!findContainingProject(input.repoPath)) return { ok: false, error: REFUSE };
    return generateCommitMessageForRepo({
      repoPath: input.repoPath,
      prompt: input.prompt,
      customModelId: input.customModelId ?? undefined,
      customModelRole: input.customModelRole ?? undefined,
      requestId: input.requestId,
    });
  },

  "git:cancelGenerateCommitMessage": async (raw) => {
    const input = GitCancelGenerateCommitSchema.parse(raw);
    cancelCommitMessageGeneration(input.requestId);
    return { ok: true };
  },
};

/** Register the git subset into the mobile RPC whitelist. Called once at boot. */
export function registerMobileGitRpc(): void {
  registerMobileRpcHandlers(handlers);
  log.info("mobile: git RPC handlers registered");
}
