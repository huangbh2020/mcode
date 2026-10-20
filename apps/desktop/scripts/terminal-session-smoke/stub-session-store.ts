/**
 * Stub for @renderer/stores/sessionStore.js — fileLink.ts only reads the
 * workspace-root inventory (projects / sessions / worktrees) via getState();
 * the smoke runs with no projects, so absolute-path containment always
 * fails and resolution rests on the steered IPC stubs.
 */
export const useSessionStore = {
  getState: () => ({
    projects: [] as Array<{ path?: string | null }>,
    sessionsByProject: {} as Record<string, Array<{ worktreePath?: string | null }> | undefined>,
    pinnedSessions: [] as Array<{ worktreePath?: string | null }>,
    streamSessions: [] as Array<{ worktreePath?: string | null }>,
    worktreeInfoByRepo: {} as Record<string, { worktrees: Array<{ path?: string | null }> }>,
  }),
};
