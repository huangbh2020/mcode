/** window.js stub — captures every pushed envelope for assertions. */
export interface CapturedEvent {
  channel: string;
  msg: unknown;
}

export function sendToRenderer(channel: string, msg: unknown): void {
  const buf = (globalThis as unknown as { __smokeEvents?: CapturedEvent[] }).__smokeEvents;
  if (buf) buf.push({ channel, msg });
}
