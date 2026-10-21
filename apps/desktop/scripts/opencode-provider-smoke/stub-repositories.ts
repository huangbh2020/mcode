/** Smoke stub for @main/store/repositories.js — fixture-backed SessionRepo
 *  surface used by the adoption-reconciler assertions. */
import type { Session } from "@contracts/session";

export const fixture = {
  /** terminal rows' claude_session_id values (the legacy claimed set). */
  terminalIds: [] as string[],
  /** provider-scoped claude_session_id values (GUI opencode-sdk rows). */
  providerIds: {} as Record<string, string[]>,
  /** updateClaudeSessionId writes land here. */
  updates: [] as Array<{ id: string; claudeSessionId: string | null }>,
  rows: new Map<string, Session>(),
};

export const SessionRepo = {
  listTerminalClaudeSessionIds(): string[] {
    return [...fixture.terminalIds];
  },
  listProviderSessionIds(providerId: string): string[] {
    return fixture.providerIds[providerId] ?? [];
  },
  updateClaudeSessionId(id: string, claudeSessionId: string | null): void {
    fixture.updates.push({ id, claudeSessionId });
    const row = fixture.rows.get(id);
    if (row) fixture.rows.set(id, { ...row, claudeSessionId });
  },
  get(id: string): Session | undefined {
    return fixture.rows.get(id);
  },
};

export const ProjectRepo = {};
export const SettingRepo = {};
export const MessageRepo = {};
