/** In-memory store stub for the pi-import smoke — mirrors just the repo
 *  surface piSessionImport.ts consumes, with the same upsert/idempotency
 *  semantics the real better-sqlite3 layer provides. */
import type { MessageRecord, Project, Session } from "@contracts/session";

export const sessions = new Map<string, Session>();
export const messages = new Map<string, MessageRecord>();
export const settings = new Map<string, string>();
export const projects: Project[] = [];

export const SessionRepo = {
  get(id: string): Session | undefined {
    return sessions.get(id);
  },
  create(s: Session): void {
    sessions.set(s.id, { ...s });
  },
  delete(id: string): void {
    sessions.delete(id);
    for (const [mid, m] of messages) {
      if (m.sessionId === id) messages.delete(mid);
    }
  },
  updateTitle(id: string, title: string): void {
    const s = sessions.get(id);
    if (s) s.title = title;
  },
  touch(id: string): void {
    const s = sessions.get(id);
    if (s) s.updatedAt = Date.now();
  },
};

export const MessageRepo = {
  upsertMany(rows: MessageRecord[]): void {
    for (const r of rows) messages.set(r.id, { ...r });
  },
  deleteByIdPrefix(sessionId: string, prefix: string): void {
    for (const [id, m] of messages) {
      if (m.sessionId === sessionId && id.startsWith(prefix)) messages.delete(id);
    }
  },
};

export const ProjectRepo = {
  list(): Project[] {
    return projects;
  },
};

export const SettingRepo = {
  get(key: string): string | null {
    return settings.get(key) ?? null;
  },
  set(key: string, value: string): void {
    settings.set(key, value);
  },
};
