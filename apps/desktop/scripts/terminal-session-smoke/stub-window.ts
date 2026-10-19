/* Smoke stub for @main/window.js — captures every push into a global tape
 * the assertions read back (channel + payload verbatim). */
export function sendToRenderer(channel: string, msg: unknown): void {
  const g = globalThis as { __TERM_PUSH?: Array<{ channel: string; msg: unknown }> };
  (g.__TERM_PUSH ??= []).push({ channel, msg });
}
