/**
 * In-memory stand-in for `@main/store/repositories.js` in the headless smoke.
 *
 * pathGuard resolves legal workspace roots through exactly two reads —
 * `ProjectRepo.listPaths()` (persisted projects) and
 * `SessionRepo.listWorktreeRoots()` (materialized session worktrees) — so the
 * smoke seeds those instead of standing up sql.js + a real DB file. Aliased in
 * run.sh; main.ts imports this module directly to seed it (esbuild resolves
 * both specifiers to the same file, so it is one instance).
 */
let projectPaths: string[] = [];
let worktreeRoots: string[] = [];

/** Seed the roots under test: the project checkout + this session's worktree. */
export function seedWorkspaceRoots(projects: string[], worktrees: string[]): void {
  projectPaths = projects;
  worktreeRoots = worktrees;
}

export const ProjectRepo = {
  listPaths: (): string[] => projectPaths,
};

export const SessionRepo = {
  listWorktreeRoots: (): string[] => worktreeRoots,
};

export const SettingRepo = {
  get: (): string | null => null,
  set: (): void => {},
};
