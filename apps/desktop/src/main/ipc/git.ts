/**
 * IPC handlers for git operations (status / stage / commit / push / pull / diff).
 *
 * All operations are scoped to a `repoPath` that must resolve inside a known
 * project root — the same path-containment guard the file handlers use. A
 * single project folder may host MULTIPLE git repos (monorepo, submodules,
 * nested projects); `git.discoverRepos` finds them all by recursive scan.
 *
 * Git access goes through `simple-git` (wraps the system `git` CLI), so auth
 * (SSH keys, credential helpers, git credential manager) is handled by the
 * user's existing system configuration — the app never touches credentials.
 *
 * Every handler degrades gracefully: errors return `{ ok: false, error }` (or
 * empty results) rather than throwing into the renderer.
 */
import type { IpcMain } from "electron";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type simpleGitFn from "simple-git";
import {
  IPC,
  GitDiscoverReposSchema,
  GitRepoPathSchema,
  GitStageSchema,
  GitUnstageSchema,
  GitCommitSchema,
  GitDiffSchema,
  GitDiscardSchema,
  GitGenerateCommitSchema,
  GitResolveConflictsSchema,
  GitLogSchema,
  GitShowCommitSchema,
  GitShowFileSchema,
  GitCheckoutSchema,
} from "@contracts/ipc";
import type {
  GitRepo,
  GitStatusResult,
  GitFileStatus,
  GitStatusCode,
  GitCommitInfo,
  GitCommitFile,
  GitCommitFileStatus,
  GitCommitDetail,
  GitBranchInfo,
  GitBranchListResult,
} from "@contracts/ipc";
import { ProjectRepo, SettingRepo } from "@main/store/repositories.js";
import { CustomModelStore } from "@main/lib/secretStore.js";
import { buildCustomEnv, resolveActiveModel } from "@main/providers/claude-sdk/customEnv.js";
import { resolveSdkBinaryPath } from "@main/providers/claude-sdk/sdkBinaryPath.js";
import { BridgeRegistry } from "@main/providers/bridge/bridgeRegistry.js";
import { resolveProtocol } from "@contracts/customModel";
import type { ApiConfig } from "@contracts/customModel";
import { log } from "@main/lib/logger.js";

// Lazy-load simple-git so the CJS module stays out of the main-process startup
// path. Git operations only happen when the user opens the git panel - well
// after the window is visible. Mirrors the node-pty lazy-load pattern in
// TerminalManager.ts.
let simpleGitLoader: typeof simpleGitFn | null = null;
/** Lazily load simple-git (shared by the desktop IPC handlers and the mobile
 *  RPC bridge). Exported so the mobile git whitelist reuses the exact same
 *  loader + cached instance instead of re-importing. */
export async function loadSimpleGit(): Promise<typeof simpleGitFn> {
  if (!simpleGitLoader) {
    const mod = await import("simple-git");
    simpleGitLoader = mod.default;
  }
  return simpleGitLoader;
}

/** Max recursion depth for repo discovery. Keeps the scan fast on deep trees
 *  while still finding nested monorepo packages. */
export const MAX_SCAN_DEPTH = 3;

/** Directory names to skip during repo discovery (never contain repos we care
 *  about, and descending into them is slow). */
const SCAN_IGNORE = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".cache",
  ".turbo",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  "target",
  "out",
]);

/** True if `abs` is inside `root` (or equals it), after normalizing both. */
function pathWithin(root: string, abs: string): boolean {
  const r = resolve(root);
  const a = resolve(abs);
  if (a === r) return true;
  return a.startsWith(r + sep);
}

/** Verify a repoPath is inside SOME persisted project root. Returns the
 *  matching project root, or null if the path is outside all roots (refuse).
 *  Exported for the mobile git whitelist (same path-escape guard). */
export function findContainingProject(repoPath: string): string | null {
  const projects = ProjectRepo.list();
  const proj = projects.find((p) => pathWithin(p.path, repoPath));
  return proj?.path ?? null;
}

/** Resolve a custom-model config for an LLM-driven git operation (commit
 *  message / conflict resolution), activating the OpenAI→Anthropic bridge when
 *  the config speaks the OpenAI wire protocol.
 *
 *  The live-turn pipeline (`RuntimeManager.sendTurn`) does this rewrite, but the
 *  git IPC handlers bypass it — they call `buildCustomEnv(cfg)` directly. For an
 *  `openai`-protocol config that meant `ANTHROPIC_BASE_URL` pointed at the raw
 *  OpenAI endpoint, the Claude binary POSTed Anthropic-format `/v1/messages` at
 *  it, the endpoint 404'd, and the binary reported "selected model may not
 *  exist" — the exact failure seen with gateways like MiniMax-M3.
 *
 *  Mirrors RuntimeManager: acquire a bridge (shared & ref-counted via
 *  BridgeRegistry) and rewrite `baseUrl` to its local URL so the rest of the
 *  pipeline is protocol-blind. The caller MUST release the bridge when done
 *  (returned as `releaseBridge`, a no-op for anthropic-protocol configs).
 *
 *  Returns `{ config, releaseBridge }` where `config` is the (possibly
 *  rewritten) `ApiConfig` to feed into `buildCustomEnv`, and `releaseBridge`
 *  drops the registry reference once the query has finished. */
export async function resolveModelForGitOp(
  customModelId: string,
  role: string | undefined,
): Promise<
  | { ok: true; config: ApiConfig; releaseBridge: () => void }
  | { ok: false; error: string }
> {
  const cfg = CustomModelStore.resolveApiConfig(customModelId, role);
  if (!cfg) {
    return { ok: false, error: "找不到指定的模型配置" };
  }

  if (resolveProtocol(cfg.protocol) === "openai") {
    try {
      const handle = await BridgeRegistry.acquire(customModelId, cfg);
      return {
        ok: true,
        // Rewrite baseUrl to the local bridge so buildCustomEnv/the binary see
        // an Anthropic-compatible endpoint on localhost — identical to what
        // RuntimeManager does for a live turn. Everything downstream (auth env
        // vars, ANTHROPIC_MODEL, the [1m] suffix) is unaffected by the rewrite.
        config: { ...cfg, baseUrl: handle.localUrl },
        releaseBridge: () => BridgeRegistry.release(customModelId),
      };
    } catch (err) {
      const msg = (err as Error).message || String(err);
      log.warn(`resolveModelForGitOp: bridge acquire failed for ${customModelId}: ${msg}`);
      return { ok: false, error: `启动 OpenAI 协议桥接失败: ${msg}` };
    }
  }

  // Anthropic-protocol config: pass through unchanged, nothing to release.
  return { ok: true, config: cfg, releaseBridge: () => {} };
}

/* ───────────────────────── repo discovery ───────────────────────── */

/** Recursively scan `dir` for directories containing a `.git` entry, up to
 *  `maxDepth` levels deep. Returns absolute repo-root paths. Stops descending
 *  into a directory once it's identified as a repo (nested repos inside a repo
 *  are found via their own `.git` only if they're separate worktrees — the
 *  common case is: the root is a repo OR some subdirs are repos). */
export async function findGitRepos(dir: string, maxDepth: number): Promise<string[]> {
  const results: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return results; // unreadable / gone — skip
  }

  // Check if THIS directory is a git repo (has a .git entry).
  const hasGit = entries.some((e) => e.name === ".git");
  if (hasGit) {
    results.push(dir);
    // Continue scanning subdirs — there may be nested independent repos
    // (e.g. a meta-folder containing several cloned projects).
  }

  if (maxDepth <= 0) return results;

  // Recurse into subdirectories (skip ignored dirs).
  const subdirs = entries.filter(
    (e) => e.isDirectory() && !SCAN_IGNORE.has(e.name),
  );
  await Promise.all(
    subdirs.map(async (e) => {
      const childResults = await findGitRepos(join(dir, e.name), maxDepth - 1);
      results.push(...childResults);
    }),
  );
  return results;
}

/* ───────────────────────── status mapping ───────────────────────── */

/** Map a single porcelain status character to our GitStatusCode union. */
function mapStatusCode(code: string): GitStatusCode {
  switch (code) {
    case "M":
      return "modified";
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "U":
      return "unmerged";
    case "?":
      return "untracked";
    case "!":
      return "ignored";
    default:
      return "unmodified";
  }
}

/** Map simple-git's StatusResult to our GitStatusResult contract type. Exported
 *  for the mobile git whitelist so both surfaces produce identical shapes. */
export function mapStatus(raw: import("simple-git").StatusResult): GitStatusResult {
  // simple-git's `.files` array has { path, index, working_dir } where the
  // status codes are single porcelain characters.
  const files: GitFileStatus[] = raw.files.map((f) => ({
    path: f.path,
    index: mapStatusCode(f.index || " "),
    workingTree: mapStatusCode(f.working_dir || " "),
  }));
  return {
    branch: raw.current || "",
    ahead: raw.ahead || 0,
    behind: raw.behind || 0,
    files,
  };
}

/** Shared core of `git.generateCommitMessage`: collect the staged diff, run a
 *  one-shot LLM query with the fixed commit-gen system prompt, and return the
 *  cleaned message. Extracted so the mobile git whitelist reuses the exact same
 *  code path as the desktop IPC handler (no drift in prompt / model resolution).
 *  Callers handle their own path guard + zod validation. */
export async function generateCommitMessageForRepo(input: {
  repoPath: string;
  prompt?: string;
  customModelId?: string | null;
  customModelRole?: string;
}): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  try {
    // 1. Collect the staged diff (index vs HEAD).
    const git = (await loadSimpleGit())(input.repoPath);
    const diff = await git.diff(["--cached"]);
    if (!diff.trim()) {
      return { ok: false, error: "没有已暂存的更改可生成提交信息" };
    }

    // 2. Build the prompt (system = fixed output shape; user = format pref + diff).
    const formatPrompt = input.prompt?.trim() || DEFAULT_COMMIT_FORMAT_PROMPT;
    const userPrompt =
      `# 格式与语言偏好\n${formatPrompt}\n\n` +
      `--- git diff --cached ---\n${diff}\n--- end diff ---`;

    // 3. Resolve the model config (custom model + optional OpenAI bridge).
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 60000);

    let releaseBridge: (() => void) | undefined;
    try {
      let model: string | undefined;
      let env: import("@anthropic-ai/claude-agent-sdk").Options["env"];

      if (input.customModelId) {
        const resolved = await resolveModelForGitOp(input.customModelId, input.customModelRole ?? undefined);
        if (!resolved.ok) return { ok: false, error: resolved.error };
        releaseBridge = resolved.releaseBridge;
        const cfg = resolved.config;
        model = resolveActiveModel(cfg);
        env = buildCustomEnv(cfg);
      }

      const binaryPath = resolveSdkBinaryPath();

      const q = query({
        prompt: userPrompt,
        options: {
          abortController: ac,
          maxTurns: 1,
          model,
          env,
          systemPrompt: COMMIT_GEN_SYSTEM_PROMPT,
          settingSources: ["project", "local"],
          includePartialMessages: false,
          ...(binaryPath ? { pathToClaudeCodeExecutable: binaryPath } : {}),
        },
      });

      // 4. Collect the assistant's text response.
      let message = "";
      for await (const m of q) {
        if (m.type === "assistant") {
          const content = (m as { message?: { content?: Array<{ type: string; text?: string }> } }).message?.content;
          if (Array.isArray(content)) {
            message = content
              .filter((b) => b.type === "text" && b.text)
              .map((b) => b.text!)
              .join("\n");
          }
        }
        if (m.type === "result") break;
      }

      clearTimeout(timer);
      if (!message.trim()) return { ok: false, error: "模型未返回有效内容" };
      message = message.trim().replace(/^```\w*\n?/, "").replace(/\n?```$/, "").trim();
      log.info(`git.generateCommitMessage succeeded for ${input.repoPath} (${message.length} chars)`);
      return { ok: true, message };
    } finally {
      clearTimeout(timer);
      releaseBridge?.();
    }
  } catch (err) {
    const msg = (err as Error).message || String(err);
    log.warn(`git.generateCommitMessage failed for ${input.repoPath}: ${msg}`);
    if (/401|unauthorized|invalid.*key/i.test(msg)) {
      return { ok: false, error: "认证失败,请检查模型配置的 Token/Key" };
    }
    if (/503|no available channel/i.test(msg)) {
      return { ok: false, error: "网关无此模型渠道,请检查模型名配置" };
    }
    return { ok: false, error: msg };
  }
}

/* ───────────────────────── handler registration ───────────────────────── */

export function registerGitHandlers(ipcMain: IpcMain): void {
  /* ── git:discoverRepos — find all git repos under a project root ── */
  ipcMain.handle(IPC.GIT_DISCOVER_REPOS, async (_evt, raw) => {
    const input = GitDiscoverReposSchema.parse(raw);
    // Verify the project path is a known persisted project.
    const known = ProjectRepo.list().some((p) => resolve(p.path) === resolve(input.projectPath));
    if (!known) {
      log.warn(`git.discoverRepos refused — unknown projectPath: ${input.projectPath}`);
      return { repos: [] };
    }
    try {
      const repoPaths = await findGitRepos(input.projectPath, MAX_SCAN_DEPTH);
      const repos: GitRepo[] = repoPaths.map((p) => {
        const rel = relative(input.projectPath, p);
        const name = rel === "" ? input.projectPath.split(/[/\\]/).pop() || p : rel;
        return { path: p, name, isRepo: true as const };
      });
      // Sort by name for stable display order.
      repos.sort((a, b) => a.name.localeCompare(b.name));
      log.info(`git.discoverRepos found ${repos.length} repo(s) under ${input.projectPath}`);
      return { repos };
    } catch (err) {
      log.error(`git.discoverRepos failed: ${(err as Error).message}`);
      return { repos: [] };
    }
  });

  /* ── git:status — status of a single repo ── */
  ipcMain.handle(IPC.GIT_STATUS, async (_evt, raw) => {
    const input = GitRepoPathSchema.parse(raw);
    if (!findContainingProject(input.repoPath)) {
      log.warn(`git.status refused — repoPath outside any project: ${input.repoPath}`);
      return { status: { branch: "", ahead: 0, behind: 0, files: [] } };
    }
    try {
      const git = (await loadSimpleGit())(input.repoPath);
      const status = await git.status();
      return { status: mapStatus(status) };
    } catch (err) {
      log.warn(`git.status failed for ${input.repoPath}: ${(err as Error).message}`);
      return { status: { branch: "", ahead: 0, behind: 0, files: [] } };
    }
  });

  /* ── git:stage — git add specific files ── */
  ipcMain.handle(IPC.GIT_STAGE, async (_evt, raw) => {
    const input = GitStageSchema.parse(raw);
    if (!findContainingProject(input.repoPath)) {
      return { ok: false, error: "仓库路径不在任何已添加的项目内" };
    }
    try {
      const git = (await loadSimpleGit())(input.repoPath);
      await git.add(input.filePaths);
      return { ok: true };
    } catch (err) {
      const msg = (err as Error).message;
      log.warn(`git.stage failed for ${input.repoPath}: ${msg}`);
      return { ok: false, error: msg };
    }
  });

  /* ── git:unstage — git reset specific files ── */
  ipcMain.handle(IPC.GIT_UNSTAGE, async (_evt, raw) => {
    const input = GitUnstageSchema.parse(raw);
    if (!findContainingProject(input.repoPath)) {
      return { ok: false, error: "仓库路径不在任何已添加的项目内" };
    }
    try {
      const git = (await loadSimpleGit())(input.repoPath);
      // `git reset HEAD -- <files>` unstages without touching working tree.
      await git.reset(input.filePaths.length > 0 ? ["--", ...input.filePaths] : []);
      return { ok: true };
    } catch (err) {
      const msg = (err as Error).message;
      log.warn(`git.unstage failed for ${input.repoPath}: ${msg}`);
      return { ok: false, error: msg };
    }
  });

  /* ── git:commit — commit staged changes ── */
  ipcMain.handle(IPC.GIT_COMMIT, async (_evt, raw) => {
    const input = GitCommitSchema.parse(raw);
    if (!findContainingProject(input.repoPath)) {
      return { ok: false, error: "仓库路径不在任何已添加的项目内" };
    }
    try {
      const git = (await loadSimpleGit())(input.repoPath);
      await git.commit(input.message);
      log.info(`git.commit succeeded in ${input.repoPath}`);
      return { ok: true };
    } catch (err) {
      const msg = (err as Error).message;
      log.warn(`git.commit failed for ${input.repoPath}: ${msg}`);
      return { ok: false, error: msg };
    }
  });

  /* ── git:push — push to upstream ── */
  ipcMain.handle(IPC.GIT_PUSH, async (_evt, raw) => {
    const input = GitRepoPathSchema.parse(raw);
    if (!findContainingProject(input.repoPath)) {
      return { ok: false, error: "仓库路径不在任何已添加的项目内" };
    }
    try {
      const git = (await loadSimpleGit())(input.repoPath);
      await git.push();
      log.info(`git.push succeeded in ${input.repoPath}`);
      return { ok: true };
    } catch (err) {
      const msg = (err as Error).message;
      log.warn(`git.push failed for ${input.repoPath}: ${msg}`);
      return { ok: false, error: msg };
    }
  });

  /* ── git:pull — pull from upstream ── */
  ipcMain.handle(IPC.GIT_PULL, async (_evt, raw) => {
    const input = GitRepoPathSchema.parse(raw);
    if (!findContainingProject(input.repoPath)) {
      return { ok: false, error: "仓库路径不在任何已添加的项目内" };
    }
    try {
      const git = (await loadSimpleGit())(input.repoPath);
      // `git.pull()` resolves a merge conflict by throwing, OR (for some merge
      // strategies) returns with the working tree left in a conflicted state.
      // We re-check `git.status().conflicted` so both paths are reported.
      try {
        await git.pull();
      } catch (pullErr) {
        // A conflict during merge surfaces as an error here. Inspect status to
        // decide whether this is a conflict (ok:true + conflict flag, so the UI
        // can offer AI resolution) vs. a genuine failure (ok:false).
        const st = await git.status().catch(() => null);
        const conflicted = st?.conflicted ?? [];
        if (conflicted.length > 0) {
          log.warn(`git.pull produced ${conflicted.length} conflict(s) in ${input.repoPath}`);
          return { ok: true, conflict: true, conflictedFiles: conflicted };
        }
        throw pullErr;
      }
      // Pull succeeded without throwing — still verify there's no lingering
      // conflicted state (some auto-merge strategies leave markers silently).
      const st = await git.status().catch(() => null);
      const conflicted = st?.conflicted ?? [];
      if (conflicted.length > 0) {
        log.warn(`git.pull left ${conflicted.length} conflict(s) in ${input.repoPath}`);
        return { ok: true, conflict: true, conflictedFiles: conflicted };
      }
      log.info(`git.pull succeeded in ${input.repoPath}`);
      return { ok: true };
    } catch (err) {
      const msg = (err as Error).message;
      log.warn(`git.pull failed for ${input.repoPath}: ${msg}`);
      return { ok: false, error: msg };
    }
  });

  /* ── git:diff — diff of a single file (staged or unstaged) ── */
  ipcMain.handle(IPC.GIT_DIFF, async (_evt, raw) => {
    const input = GitDiffSchema.parse(raw);
    if (!findContainingProject(input.repoPath)) {
      return { patch: "" };
    }
    try {
      const git = (await loadSimpleGit())(input.repoPath);
      // --cached shows the staged diff (index vs HEAD); without it, the
      // working-tree diff (index vs working tree) is shown.
      const args = input.staged ? ["--cached", "--", input.filePath] : ["--", input.filePath];
      const patch = await git.diff(args);
      return { patch };
    } catch (err) {
      log.warn(`git.diff failed for ${input.repoPath}/${input.filePath}: ${(err as Error).message}`);
      return { patch: "" };
    }
  });

  /* ── git:discard — discard local changes (checkout tracked / clean untracked) ── */
  ipcMain.handle(IPC.GIT_DISCARD, async (_evt, raw) => {
    const input = GitDiscardSchema.parse(raw);
    if (!findContainingProject(input.repoPath)) {
      return { ok: false, error: "仓库路径不在任何已添加的项目内" };
    }
    try {
      const git = (await loadSimpleGit())(input.repoPath);
      // Separate tracked (modified/staged/deleted) from untracked files:
      // tracked → git checkout -- <file> (restore to index)
      // untracked → git clean -f -- <file> (remove)
      const status = await git.status();
      const untrackedSet = new Set(
        status.files.filter((f) => f.working_dir === "?" || f.index === "?").map((f) => f.path),
      );
      const tracked: string[] = [];
      const untracked: string[] = [];
      for (const fp of input.filePaths) {
        if (untrackedSet.has(fp)) untracked.push(fp);
        else tracked.push(fp);
      }
      if (tracked.length > 0) {
        await git.checkout(["--", ...tracked]);
      }
      if (untracked.length > 0) {
        await git.clean("f", ["-d", "--", ...untracked]);
      }
      log.info(`git.discard succeeded in ${input.repoPath} (${tracked.length} tracked, ${untracked.length} untracked)`);
      return { ok: true };
    } catch (err) {
      const msg = (err as Error).message;
      log.warn(`git.discard failed for ${input.repoPath}: ${msg}`);
      return { ok: false, error: msg };
    }
  });

  /* ── git:log — paginated commit history ── */
  ipcMain.handle(IPC.GIT_LOG, async (_evt, raw) => {
    const input = GitLogSchema.parse(raw);
    if (!findContainingProject(input.repoPath)) {
      log.warn(`git.log refused — repoPath outside any project: ${input.repoPath}`);
      return { commits: [], hasMore: false };
    }
    const limit = input.limit ?? 50;
    const skip = input.skip ?? 0;
    try {
      const git = (await loadSimpleGit())(input.repoPath);
      // Custom format via raw so we control fields + --skip cleanly.
      // Record separator \x1e, field separator \x1f.
      // Request one extra row so we can tell whether another page exists.
      const args = [
        "log",
        `--max-count=${limit + 1}`,
        `--skip=${skip}`,
        "--format=%H%x1f%h%x1f%s%x1f%b%x1f%an%x1f%aI%x1f%P%x1e",
      ];
      if (input.ref) args.push(input.ref);
      const rawLog = await git.raw(args);
      const commits = parseLogOutput(rawLog);
      const hasMore = commits.length > limit;
      return {
        commits: hasMore ? commits.slice(0, limit) : commits,
        hasMore,
      };
    } catch (err) {
      log.warn(`git.log failed for ${input.repoPath}: ${(err as Error).message}`);
      return { commits: [], hasMore: false };
    }
  });

  /* ── git:showCommit — meta + changed files for one commit ── */
  ipcMain.handle(IPC.GIT_SHOW_COMMIT, async (_evt, raw) => {
    const input = GitShowCommitSchema.parse(raw);
    if (!findContainingProject(input.repoPath)) {
      log.warn(`git.showCommit refused — repoPath outside any project: ${input.repoPath}`);
      return null;
    }
    try {
      const git = (await loadSimpleGit())(input.repoPath);
      const detail = await loadCommitDetail(git, input.commitHash);
      return detail;
    } catch (err) {
      log.warn(
        `git.showCommit failed for ${input.repoPath}@${input.commitHash}: ${(err as Error).message}`,
      );
      return null;
    }
  });

  /* ── git:showFile — parent vs commit blob contents for one path ── */
  ipcMain.handle(IPC.GIT_SHOW_FILE, async (_evt, raw) => {
    const input = GitShowFileSchema.parse(raw);
    if (!findContainingProject(input.repoPath)) {
      log.warn(`git.showFile refused — repoPath outside any project: ${input.repoPath}`);
      return { before: "", after: "" };
    }
    try {
      const git = (await loadSimpleGit())(input.repoPath);
      const beforePath = input.oldPath || input.filePath;
      const after = await showBlob(git, input.commitHash, input.filePath);
      // Parent side: `${hash}^:path`. Root commits / added files yield "".
      const before = await showBlob(git, `${input.commitHash}^`, beforePath);
      return { before, after };
    } catch (err) {
      log.warn(
        `git.showFile failed for ${input.repoPath}@${input.commitHash}:${input.filePath}: ${(err as Error).message}`,
      );
      return { before: "", after: "" };
    }
  });

  /* ── git:generateCommitMessage — LLM-generated commit message from staged diff ── */
  ipcMain.handle(IPC.GIT_GENERATE_COMMIT, async (_evt, raw) => {
    const input = GitGenerateCommitSchema.parse(raw);
    if (!findContainingProject(input.repoPath)) {
      return { ok: false, error: "仓库路径不在任何已添加的项目内" };
    }
    return generateCommitMessageForRepo({
      repoPath: input.repoPath,
      prompt: input.prompt,
      customModelId: input.customModelId ?? undefined,
      customModelRole: input.customModelRole ?? undefined,
    });
  });

  /* ── git:resolveConflicts — AI-resolve all merge conflicts in a repo ── */
  ipcMain.handle(IPC.GIT_RESOLVE_CONFLICTS, async (_evt, raw) => {
    const input = GitResolveConflictsSchema.parse(raw);
    if (!findContainingProject(input.repoPath)) {
      return { ok: false, error: "仓库路径不在任何已添加的项目内" };
    }
    try {
      const git = (await loadSimpleGit())(input.repoPath);
      // 1. Gather the current conflicted files. (simple-git exposes them via
      //    `status().conflicted`.)
      const status = await git.status();
      let conflicted = status.conflicted ?? [];
      if (conflicted.length === 0) {
        return { ok: false, error: "未检测到冲突文件" };
      }

      // 2. Read each conflicted file's full content (with conflict markers).
      //    Skip files that are too large (> MAX_CONFLICT_FILE_BYTES) to avoid
      //    blowing up the prompt; they are left unresolved and reported back.
      const MAX_CONFLICT_FILE_BYTES = 100_000;
      const files: { path: string; content: string }[] = [];
      const skipped: string[] = [];
      for (const relPath of conflicted) {
        const abs = resolve(input.repoPath, relPath);
        try {
          const buf = await readFile(abs);
          if (buf.byteLength > MAX_CONFLICT_FILE_BYTES) {
            skipped.push(relPath);
            continue;
          }
          files.push({ path: relPath, content: buf.toString("utf8") });
        } catch (readErr) {
          log.warn(`git.resolveConflicts: failed to read ${relPath}: ${(readErr as Error).message}`);
          skipped.push(relPath);
        }
      }
      if (files.length === 0) {
        return { ok: false, error: "冲突文件无法读取(可能过大或已损坏),请手动解决" };
      }

      // 3. Build the user prompt. Each file is wrapped with a header carrying
      //    its path so the model can map its JSON output back to the file.
      const filesBlock = files
        .map(
          (f) =>
            `=== FILE: ${f.path} ===\n${f.content}\n=== END FILE: ${f.path} ===`,
        )
        .join("\n\n");
      const userPrompt =
        `仓库 ${input.repoPath} 在合并后产生了 ${conflicted.length} 个冲突文件。` +
        `请逐一解决冲突并输出每个文件的完整最终内容。\n\n${filesBlock}`;

      // 4. Resolve the model config (optional custom endpoint). OpenAI-protocol
      //    configs activate the bridge here too (see resolveModelForGitOp).
      const { query } = await import("@anthropic-ai/claude-agent-sdk");
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 120000); // 120s — conflicts can be large

      let releaseBridge: (() => void) | undefined;
      try {
        let model: string | undefined;
        let env: import("@anthropic-ai/claude-agent-sdk").Options["env"];

        if (input.customModelId) {
          const resolved = await resolveModelForGitOp(
            input.customModelId,
            input.customModelRole ?? undefined,
          );
          if (!resolved.ok) {
            return { ok: false, error: resolved.error };
          }
          releaseBridge = resolved.releaseBridge;
          const cfg = resolved.config;
          model = resolveActiveModel(cfg);
          env = buildCustomEnv(cfg);
        }

        // Resolve the real on-disk binary path (see generateCommitMessage).
        const binaryPath = resolveSdkBinaryPath();

        const q = query({
          prompt: userPrompt,
          options: {
            abortController: ac,
            maxTurns: 1,
            model,
            env,
            systemPrompt: CONFLICT_RESOLVE_SYSTEM_PROMPT,
            settingSources: ["project", "local"],
            includePartialMessages: false,
            // See generateCommitMessage above — must override the asar-internal
            // path in a packaged app or spawn fails with ENOTDIR.
            ...(binaryPath ? { pathToClaudeCodeExecutable: binaryPath } : {}),
          },
        });

        // 5. Collect the assistant's text response.
        let message = "";
        for await (const m of q) {
          if (m.type === "assistant") {
            const content = (m as { message?: { content?: Array<{ type: string; text?: string }> } }).message?.content;
            if (Array.isArray(content)) {
              message = content
                .filter((b) => b.type === "text" && b.text)
                .map((b) => b.text!)
                .join("\n");
            }
          }
          if (m.type === "result") break;
        }
        clearTimeout(timer);

        // 6. Parse the JSON array the model was instructed to emit, write each
        //    resolved file back to disk, and `git add` it.
        const parsed = parseConflictResolution(message);
        if (!parsed) {
          return {
            ok: false,
            error: "模型未返回可解析的冲突解决方案(JSON)。请检查模型能力或手动解决。",
          };
        }

        const resolvedFiles: string[] = [];
        const seenPaths = new Set(parsed.map((r) => r.path));
        for (const { path: relPath, content } of parsed) {
          if (!relPath || typeof content !== "string") continue;
          // Guard against path traversal: the resolved path must remain inside
          // the repo and must be one of the conflicted files.
          const abs = resolve(input.repoPath, relPath);
          if (!pathWithin(input.repoPath, abs)) {
            log.warn(`git.resolveConflicts: skipping out-of-repo path ${relPath}`);
            continue;
          }
          if (!conflicted.includes(relPath)) {
            log.warn(`git.resolveConflicts: skipping path not in conflict set: ${relPath}`);
            continue;
          }
          try {
            await writeFile(abs, content, "utf8");
            await git.add(relPath);
            resolvedFiles.push(relPath);
          } catch (writeErr) {
            log.warn(`git.resolveConflicts: failed to write/add ${relPath}: ${(writeErr as Error).message}`);
          }
        }

        if (resolvedFiles.length === 0) {
          return { ok: false, error: "模型未给出可写回的冲突解决方案" };
        }

        const note =
          skipped.length > 0
            ? `(${skipped.length} 个文件过大被跳过,需手动解决)`
            : undefined;
        const unresolved = conflicted.filter((p) => !seenPaths.has(p));
        log.info(
          `git.resolveConflicts resolved ${resolvedFiles.length}/${conflicted.length} file(s) in ${input.repoPath}` +
            (unresolved.length ? `, ${unresolved.length} unresolved` : ""),
        );
        return {
          ok: true,
          resolvedFiles,
          error: note,
        };
      } finally {
        clearTimeout(timer);
        releaseBridge?.();
      }
    } catch (err) {
      const msg = (err as Error).message || String(err);
      log.warn(`git.resolveConflicts failed for ${input.repoPath}: ${msg}`);
      if (/401|unauthorized|invalid.*key/i.test(msg)) {
        return { ok: false, error: "认证失败,请检查模型配置的 Token/Key" };
      }
      if (/503|no available channel/i.test(msg)) {
        return { ok: false, error: "网关无此模型渠道,请检查模型名配置" };
      }
      return { ok: false, error: msg };
    }
  });

  /* ── git:listBranches - local / remote branches + tags (grouped) ── */
  ipcMain.handle(IPC.GIT_LIST_BRANCHES, async (_evt, raw) => {
    const input = GitRepoPathSchema.parse(raw);
    if (!findContainingProject(input.repoPath)) {
      log.warn(`git.listBranches refused - repoPath outside any project: ${input.repoPath}`);
      return { branches: { current: "", detached: false, local: [], remote: [], tags: [] } };
    }
    try {
      const git = (await loadSimpleGit())(input.repoPath);
      // `for-each-ref` gives us refname / short hash / subject in one shot.
      // NOTE: `for-each-ref` uses `%NN` (two hex digits) for byte escapes - NOT
      // the `%xNN` form that `git log --format` uses. So `%1f` = unit sep
      // (field), `%0a` = LF (record). `%x1f` would be emitted literally and
      // break parsing. `*HEAD` symrefs under refs/remotes are excluded - they
      // duplicate a real remote branch and would confuse checkout.
      const fmt = "%(refname)%1f%(objectname:short)%1f%(contents:subject)%0a";
      const rawRefs = await git.raw([
        "for-each-ref",
        `--format=${fmt}`,
        "refs/heads",
        "refs/remotes",
        "refs/tags",
      ]);

      // Determine current ref (branch name, or empty under detached HEAD).
      let current = "";
      let detached = false;
      const curBranch = await git.revparse(["--abbrev-ref", "HEAD"]).catch(() => "");
      current = (curBranch || "").trim();
      if (current === "HEAD" || current === "") {
        detached = true;
        current = "";
      }

      const local: GitBranchInfo[] = [];
      const remote: GitBranchInfo[] = [];
      const tags: GitBranchInfo[] = [];

      for (const record of rawRefs.split("\n")) {
        const line = record.trim();
        if (!line) continue;
        const [refname, commit, label] = line.split("\x1f");
        if (!refname) continue;

        // refs/heads/<name>
        if (refname.startsWith("refs/heads/")) {
          const name = refname.slice("refs/heads/".length);
          local.push({
            name,
            current: name === current,
            commit: commit || "",
            label: label || "",
            type: "local",
          });
          continue;
        }
        // refs/remotes/<remote>/<name> - skip <remote>/HEAD symrefs.
        if (refname.startsWith("refs/remotes/")) {
          const full = refname.slice("refs/remotes/".length);
          if (full.endsWith("/HEAD")) continue;
          remote.push({
            name: full,
            current: full === current,
            commit: commit || "",
            label: label || "",
            type: "remote",
          });
          continue;
        }
        // refs/tags/<name>
        if (refname.startsWith("refs/tags/")) {
          const name = refname.slice("refs/tags/".length);
          // Under detached HEAD, mark the tag matching the current commit.
          tags.push({
            name,
            current: false,
            commit: commit || "",
            label: label || "",
            type: "tag",
          });
        }
      }

      return { branches: { current, detached, local, remote, tags } };
    } catch (err) {
      log.warn(`git.listBranches failed for ${input.repoPath}: ${(err as Error).message}`);
      return { branches: { current: "", detached: false, local: [], remote: [], tags: [] } };
    }
  });

  /* ── git:checkout - switch branch / tag / ref (optionally create new) ── */
  ipcMain.handle(IPC.GIT_CHECKOUT, async (_evt, raw) => {
    const input = GitCheckoutSchema.parse(raw);
    if (!findContainingProject(input.repoPath)) {
      return { ok: false, error: "仓库路径不在任何已添加的项目内" };
    }
    try {
      const git = (await loadSimpleGit())(input.repoPath);
      if (input.newBranch) {
        // `git checkout -b <newBranch> <branch>` - create + switch.
        await git.checkoutBranch(input.newBranch, input.branch);
        log.info(`git.checkout created ${input.newBranch} from ${input.branch} in ${input.repoPath}`);
      } else {
        await git.checkout(input.branch);
        log.info(`git.checkout switched to ${input.branch} in ${input.repoPath}`);
      }
      return { ok: true };
    } catch (err) {
      const msg = (err as Error).message;
      log.warn(`git.checkout failed for ${input.repoPath}: ${msg}`);
      return { ok: false, error: msg };
    }
  });
}

/**
 * Fixed system prompt for commit-message generation. NEVER overridden by user
 * input — this is what guarantees clean, diff-only output regardless of the
 * user's format/language prompt. The user's prompt (see
 * {@link DEFAULT_COMMIT_FORMAT_PROMPT}) only steers formatting & language via
 * the user message, not the system prompt.
 */
const COMMIT_GEN_SYSTEM_PROMPT = [
  "你是一个 Git 提交信息生成器。你的唯一职责是根据给定的 `git diff --cached` 输出,生成一条与实际改动相关、可直接使用的提交信息。",
  "",
  "严格输出约束:",
  "1. 只输出提交信息本身——不要任何前导语、问候、解释、分析、过程性文字(例如「这是你的提交信息:」「让我分析一下改动…」「根据以上 diff…」等一律禁止)。",
  "2. 不要使用 Markdown 代码块标记(```...)或其他包裹符号。",
  "3. 完全基于 diff 的实际内容生成;diff 中没有的改动不得臆造或补充。",
  "4. 第一行是简短摘要(不超过 50 字符,祈使语气);若改动较复杂,空一行后再写详细说明正文。",
  "5. 下方的「格式与语言偏好」仅影响提交信息的语言、措辞风格与规范格式(如 Conventional Commits、是否加 emoji 等),不得改变上述输出约束,也不得改变基于 diff 生成内容这一核心行为。",
].join("\n");

/**
 * Default *format* prompt appended to the user message when the user hasn't
 * configured a custom one. Only concerns language/convention — the fixed
 * {@link COMMIT_GEN_SYSTEM_PROMPT} carries all output-shape constraints.
 */
const DEFAULT_COMMIT_FORMAT_PROMPT = "使用中文生成提交信息,默认遵循 Conventional Commits 规范。";

/**
 * Fixed system prompt for AI conflict resolution. NEVER overridden — this is
 * what guarantees parseable JSON output of resolved file contents. The model
 * must keep BOTH sides' necessary changes, drop the conflict markers, and
 * emit a clean final version of every file.
 */
const CONFLICT_RESOLVE_SYSTEM_PROMPT = [
  "你是一个 Git 合并冲突解决助手。你的唯一职责是阅读带有冲突标记(`<<<<<<<`、`=======`、`>>>>>>>`)的文件,输出每个文件解决冲突后的完整最终内容。",
  "",
  "解决原则:",
  "1. 综合考虑「我们的改动」(ours)与「他们的改动」(theirs)两边的意图,尽可能保留双方必要的改动;若两边确有矛盾无法兼顾,选择语义上更合理的一方,并在该处用注释简要说明。",
  "2. 删除所有冲突标记行(`<<<<<<<`、`=======`、`>>>>>>>`)及其分支标签,输出干净的最终文件。",
  "3. 不要臆造文件中原本不存在的内容;不要新增功能;保持文件的语法与结构合法。",
  "4. 输出必须是单个 JSON 数组,且不包含任何 Markdown 代码块标记或其它包裹符号。数组每个元素形如 {\"path\": \"文件相对路径\", \"content\": \"解决后的完整文件内容\"}。",
  "5. path 必须与输入中给出的 FILE 路径完全一致;content 必须是该文件的完整内容(不是 diff,不是片段)。",
].join("\n");

/**
 * Parse the model's conflict-resolution output into `{ path, content }[]`.
 *
 * The model is instructed to emit a bare JSON array. In practice it sometimes
 * wraps it in a ```json fence or adds stray prose, so we try, in order:
 *   1. Strip a leading ```lang\n / trailing ``` fence (if present), then
 *      JSON.parse the whole thing.
 *   2. Otherwise, extract the first balanced `[...]` substring and parse that.
 * Returns null if no valid array can be recovered.
 */
function parseConflictResolution(
  raw: string,
): { path: string; content: string }[] | null {
  if (!raw || !raw.trim()) return null;
  const tryParse = (s: string): { path: string; content: string }[] | null => {
    try {
      const v = JSON.parse(s);
      if (Array.isArray(v)) {
        return v
          .map((it) =>
            it && typeof it === "object" && "path" in it && "content" in it
              ? { path: String(it.path), content: String(it.content) }
              : null,
          )
          .filter((x): x is { path: string; content: string } => x !== null);
      }
    } catch {
      /* fall through */
    }
    return null;
  };
  // 1. Strip code fences, then parse.
  const fenced = raw.trim().replace(/^```[a-zA-Z]*\n?/, "").replace(/\n?```$/, "").trim();
  const r1 = tryParse(fenced);
  if (r1 && r1.length > 0) return r1;
  // 2. Extract the first balanced [...] block.
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start !== -1 && end !== -1 && end > start) {
    const r2 = tryParse(raw.slice(start, end + 1));
    if (r2 && r2.length > 0) return r2;
  }
  return null;
}

/* ───────────────────────── history helpers ───────────────────────── */

/** Parse `git log --format=...%x1e` output into GitCommitInfo[]. */
function parseLogOutput(raw: string): GitCommitInfo[] {
  const commits: GitCommitInfo[] = [];
  for (const record of raw.split("\x1e")) {
    const line = record.replace(/^\n+/, "").trimEnd();
    if (!line.trim()) continue;
    const [hash, shortHash, subject, body, author, authoredAt, parentsRaw] =
      line.split("\x1f");
    if (!hash) continue;
    const parents = (parentsRaw || "")
      .split(/\s+/)
      .map((p) => p.trim())
      .filter(Boolean);
    commits.push({
      hash,
      shortHash: shortHash || hash.slice(0, 7),
      subject: subject || "",
      body: body?.trim() || undefined,
      author: author || "",
      authoredAt: authoredAt || "",
      parents: parents.length > 0 ? parents : undefined,
    });
  }
  return commits;
}

/** Read a blob at `rev:path`. Missing path / root-parent → "". */
async function showBlob(
  git: import("simple-git").SimpleGit,
  rev: string,
  filePath: string,
): Promise<string> {
  try {
    // `git show rev:path` — simple-git's show() returns stdout as string.
    const content = await git.show([`${rev}:${filePath}`]);
    return typeof content === "string" ? content : String(content ?? "");
  } catch {
    return "";
  }
}

/** Load commit meta + name-status file list with optional numstat tallies. */
async function loadCommitDetail(
  git: import("simple-git").SimpleGit,
  commitHash: string,
): Promise<GitCommitDetail> {
  // Custom pretty format so we don't depend on simple-git's log field set for
  // a single-commit lookup. Fields separated by \x1f, record ends with \x1e.
  const metaRaw = await git.raw([
    "show",
    "--no-patch",
    "--format=%H%x1f%h%x1f%s%x1f%b%x1f%an%x1f%aI%x1f%P%x1e",
    commitHash,
  ]);
  const metaLine = metaRaw.split("\x1e")[0]?.trim() ?? "";
  const [hash, shortHash, subject, body, author, authoredAt, parentsRaw] =
    metaLine.split("\x1f");
  if (!hash) {
    throw new Error(`commit not found: ${commitHash}`);
  }
  const parents = (parentsRaw || "")
    .split(/\s+/)
    .map((p) => p.trim())
    .filter(Boolean);

  const commit: GitCommitInfo = {
    hash,
    shortHash: shortHash || hash.slice(0, 7),
    subject: subject || "",
    body: body?.trim() || undefined,
    author: author || "",
    authoredAt: authoredAt || "",
    parents,
  };

  // name-status: status letter + path(s). --root handles the initial commit.
  const nameStatusRaw = await git.raw([
    "diff-tree",
    "--no-commit-id",
    "--name-status",
    "-r",
    "-M",
    "--root",
    commitHash,
  ]);
  const files = parseNameStatus(nameStatusRaw);

  // numstat for +/- tallies (best-effort; binary files report "-" ).
  try {
    const numstatRaw = await git.raw([
      "diff-tree",
      "--no-commit-id",
      "--numstat",
      "-r",
      "-M",
      "--root",
      commitHash,
    ]);
    applyNumstat(files, numstatRaw);
  } catch {
    // tallies are optional
  }

  return { commit, files };
}

/** Parse `git diff-tree --name-status` output into GitCommitFile[]. */
function parseNameStatus(raw: string): GitCommitFile[] {
  const files: GitCommitFile[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trimEnd();
    if (!trimmed) continue;
    // Formats:
    //   M\tpath
    //   A\tpath
    //   D\tpath
    //   R100\told\tnew
    //   C100\told\tnew
    const parts = trimmed.split("\t");
    if (parts.length < 2) continue;
    const code = parts[0] ?? "";
    const letter = code.charAt(0).toUpperCase();
    const status = mapCommitFileStatus(letter);
    if (letter === "R" || letter === "C") {
      const oldPath = parts[1] ?? "";
      const path = parts[2] ?? oldPath;
      files.push({ path, status, oldPath: oldPath || undefined });
    } else {
      files.push({ path: parts[1] ?? "", status });
    }
  }
  return files.filter((f) => f.path.length > 0);
}

function mapCommitFileStatus(letter: string): GitCommitFileStatus {
  switch (letter) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    default:
      return "modified";
  }
}

/** Merge `git diff-tree --numstat` tallies into an existing file list. */
function applyNumstat(files: GitCommitFile[], raw: string): void {
  const byPath = new Map(files.map((f) => [f.path, f]));
  for (const line of raw.split("\n")) {
    const trimmed = line.trimEnd();
    if (!trimmed) continue;
    // numstat: additions\tdeletions\tpath
    // rename:  additions\tdeletions\told\tnew  OR path with => 
    const parts = trimmed.split("\t");
    if (parts.length < 3) continue;
    const addStr = parts[0] ?? "0";
    const delStr = parts[1] ?? "0";
    const additions = addStr === "-" ? undefined : Number.parseInt(addStr, 10);
    const deletions = delStr === "-" ? undefined : Number.parseInt(delStr, 10);
    // For renames, last field is the new path.
    const path = parts[parts.length - 1] ?? "";
    const file = byPath.get(path);
    if (!file) continue;
    if (additions != null && !Number.isNaN(additions)) file.additions = additions;
    if (deletions != null && !Number.isNaN(deletions)) file.deletions = deletions;
  }
}
