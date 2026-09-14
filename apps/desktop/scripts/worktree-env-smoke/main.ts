/**
 * Headless smoke for "the IDE surfaces follow the ACTIVE SESSION's
 * environment" — the boundary that a worktree session's file tree and Git panel
 * are addressed through.
 *
 * Regression anchor (2026-09-13): the mobile file tree and Git screen rooted
 * themselves at `project.path` (the main checkout) while the session's agent
 * worked in its worktree, so the phone showed — and for git, WROTE — the wrong
 * checkout. The renderer fix routes both screens through `selectActiveEnvPath`
 * (session worktree ?? project root), which is only correct if main accepts a
 * worktree root as a workspace root; that is what this smoke pins, against a
 * REAL worktree created with the git CLI:
 *
 *   - the worktree root (which lives OUTSIDE every project root, by design —
 *     `<userData>/worktrees/<repo>/<branch>-n`) is a legal root for
 *     `file:listDir` / `git:discoverRepos` (isKnownWorkspaceRoot),
 *   - repo-level git handlers and file reads inside it resolve to the worktree
 *     (findContainingWorkspaceRoot), and
 *   - the boundary still refuses paths outside every legal root, and still
 *     refuses to walk out of the root via `dirPath`.
 *
 * Run: scripts/worktree-env-smoke/run.sh
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findContainingWorkspaceRoot, isKnownWorkspaceRoot } from "@main/lib/pathGuard.js";
import { listDirGuarded } from "@main/ipc/files.js";
import { seedWorkspaceRoots } from "./stub-repositories.js";

let checks = 0;
let failures = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  checks++;
  if (cond) {
    process.stdout.write(`  ✓ ${name}\n`);
  } else {
    failures++;
    process.stdout.write(
      `  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}\n`,
    );
  }
}

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync(
      "git",
      ["-c", "user.email=smoke@example.com", "-c", "user.name=Mcode Smoke", ...args],
      // Capture stderr instead of inheriting it: git chats on stderr for
      // `worktree add`, which would interleave with the check output. Re-throw
      // with it so a failure is still diagnosable.
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new Error(`git ${args.join(" ")} failed: ${(e.stderr ?? e.message).trim()}`);
  }
}

/** Names returned by the guarded listing, for set-style assertions. */
async function listNames(root: string, dirPath: string): Promise<string[]> {
  const { entries } = await listDirGuarded(root, dirPath);
  return entries.map((e) => e.name);
}

async function main(): Promise<void> {
  const base = mkdtempSync(join(tmpdir(), "mcode-worktree-env-smoke."));
  const projectRoot = join(base, "proj");
  // Mirrors worktreeOps' managed layout (<userData>/worktrees/<repo>/<branch>-n):
  // deliberately OUTSIDE the project root.
  const worktreeRoot = join(base, "worktrees", "proj", "wt-1");
  const outsider = join(base, "elsewhere");
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(outsider, { recursive: true });
  mkdirSync(join(base, "worktrees", "proj"), { recursive: true });

  // A real repo + a real linked worktree on its own branch.
  git(projectRoot, ["init", "-b", "main"]);
  writeFileSync(join(projectRoot, "README.md"), "# project\n");
  git(projectRoot, ["add", "."]);
  git(projectRoot, ["commit", "-m", "init"]);
  git(projectRoot, ["worktree", "add", "-b", "wt-branch", worktreeRoot, "main"]);

  // Distinct content so a listing proves WHICH checkout was read.
  writeFileSync(join(projectRoot, "project-only.txt"), "main checkout\n");
  writeFileSync(join(worktreeRoot, "worktree-only.txt"), "isolated checkout\n");
  mkdirSync(join(worktreeRoot, "nested"));
  writeFileSync(join(worktreeRoot, "nested", "inner.txt"), "nested\n");

  seedWorkspaceRoots([projectRoot], [worktreeRoot]);

  process.stdout.write("1. the worktree is a legal workspace root (mobile discoverRepos guard)\n");
  {
    check("project root admitted", isKnownWorkspaceRoot(projectRoot));
    check("worktree root admitted", isKnownWorkspaceRoot(worktreeRoot));
    check("unrelated directory still refused", !isKnownWorkspaceRoot(outsider));
    check(
      "a path INSIDE the project is not itself a root (roots are exact)",
      !isKnownWorkspaceRoot(join(projectRoot, "nested-that-does-not-exist")),
    );
  }

  process.stdout.write("2. the file tree reads the worktree, not the main checkout\n");
  {
    const wt = await listNames(worktreeRoot, "");
    check("worktree listing shows its own marker", wt.includes("worktree-only.txt"), wt);
    check("worktree listing does NOT show the main checkout's marker", !wt.includes("project-only.txt"), wt);
    check("worktree listing shows the worktree's tracked file", wt.includes("README.md"), wt);

    const proj = await listNames(projectRoot, "");
    check("project listing shows its own marker", proj.includes("project-only.txt"), proj);
    check("project listing does NOT show the worktree's marker", !proj.includes("worktree-only.txt"), proj);

    const nested = await listNames(worktreeRoot, "nested");
    check("relative dirPath resolves under the worktree root", nested.includes("inner.txt"), nested);
  }

  process.stdout.write("3. the boundary is unchanged\n");
  {
    const escape = await listNames(worktreeRoot, "../../../..");
    check("dirPath cannot escape the worktree root", escape.length === 0, escape);
    const escapeProject = await listNames(projectRoot, "..");
    check("dirPath cannot escape the project root", escapeProject.length === 0, escapeProject);

    check(
      "files inside the worktree resolve to the worktree root (git handlers + file reads)",
      findContainingWorkspaceRoot(join(worktreeRoot, "nested", "inner.txt")) === worktreeRoot,
    );
    check(
      "files inside the project resolve to the project root",
      findContainingWorkspaceRoot(join(projectRoot, "README.md")) === projectRoot,
    );
    check("outside every root → null", findContainingWorkspaceRoot(outsider) === null);
  }

  process.stdout.write("4. the worktree really is a separate checkout\n");
  {
    check(
      "git can address it and sees its own branch",
      git(worktreeRoot, ["rev-parse", "--abbrev-ref", "HEAD"]) === "wt-branch",
    );
    check("main checkout still on main", git(projectRoot, ["rev-parse", "--abbrev-ref", "HEAD"]) === "main");
    check(
      "a linked worktree's .git is a FILE (discovery matches by name, so it is found)",
      statSync(join(worktreeRoot, ".git")).isFile(),
    );
  }

  process.stdout.write(
    failures === 0 ? `\nAll ${checks} checks passed.\n` : `\n${failures}/${checks} FAILED.\n`,
  );
  if (failures > 0) process.exit(1);
}

void main();
