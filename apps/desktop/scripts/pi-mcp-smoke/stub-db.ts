/** Stub for @main/store/db.js — no sqlite in the smoke. */
export async function awaitDb(): Promise<void> {}
export function getDb(): unknown {
  throw new Error("getDb not available in pi-mcp-smoke");
}
