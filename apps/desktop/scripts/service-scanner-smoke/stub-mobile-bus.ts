/** Records broadcasts — the real bus fans out to SSE subscribers. */
export const events: unknown[] = [];

export const mobileEventBus = {
  broadcast(e: unknown): void {
    events.push(e);
  },
};
