/* Smoke stub for @main/store/repositories.js — records SessionRepo.create
 * calls + broadcast-side effects; findFresh* are steerable via globals. */
type Row = Record<string, unknown> & { id: string };

const g = globalThis as {
  __SESSION_CREATE?: Row[];
  __FIND_FRESH?: () => unknown;
};

function tape(): Row[] {
  return (g.__SESSION_CREATE ??= []);
}

export const SessionRepo = {
  create(s: Row): void {
    tape().push(s);
  },
  get(id: string): Row | undefined {
    return tape().find((r) => r.id === id);
  },
  updateSettings(_id: string, _patch: Record<string, unknown>): void {},
  findFreshByProject(_projectId: string): unknown {
    return g.__FIND_FRESH ? g.__FIND_FRESH() : undefined;
  },
  findFreshSideByParent(_parentId: string): unknown {
    return undefined;
  },
  updateWorktreePath(_id: string, _path: string): void {},
  listWorktreeRoots(): string[] {
    return [];
  },
  updateClaudeSessionId(id: string, claudeSessionId: string): void {
    const g2 = globalThis as { __CLAUDE_ID_ADOPT?: Array<[string, string]> };
    (g2.__CLAUDE_ID_ADOPT ??= []).push([id, claudeSessionId]);
  },
  listTerminalClaudeSessionIds(): string[] {
    const g2 = globalThis as { __TERMINAL_CLAIMED?: string[] };
    return g2.__TERMINAL_CLAIMED ?? [];
  },
};

export const ProjectRepo = {
  get(_id: string): { id: string; path: string; name: string } | undefined {
    return undefined;
  },
};

export const SettingRepo = {
  get(_key: string): string | null {
    return null;
  },
};
