/* Smoke stub for @main/lib/sessionSync.js — records broadcasts. */
export function broadcastSessionChanged(session: unknown): void {
  const g = globalThis as { __BROADCASTS?: unknown[] };
  (g.__BROADCASTS ??= []).push(session);
}
