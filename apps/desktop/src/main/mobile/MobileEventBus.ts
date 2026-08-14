/**
 * MobileEventBus — a multi-subscriber fan-out for {@link RuntimeEvent}.
 *
 * The renderer receives events through a single `sendToRenderer` call inside
 * `RuntimeManager.emit`. Mobile clients (one or more phones over SSE) need the
 * same events, so `RuntimeManager.emit` also calls {@link broadcast} here, and
 * each connected SSE client registers a subscriber via {@link subscribe}.
 *
 * The bus deliberately keeps no buffer: a subscriber that isn't connected (or
 * is mid-reconnect) simply misses the live `text.delta` frames. On reconnect
 * the mobile client re-fetches the session message snapshot via RPC to recover
 * the fully-aggregated state — cheaper and simpler than replaying a ring buffer.
 */
import type { RuntimeEvent } from "@contracts/runtime";

type Subscriber = (e: RuntimeEvent) => void;

export class MobileEventBus {
  private subscribers = new Set<Subscriber>();

  /** Register a subscriber. Returns an unsubscribe function. */
  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  /** Fan an event out to every current subscriber. Subscriber errors are
   *  swallowed — one dead client must not disrupt the others or the stream. */
  broadcast(e: RuntimeEvent): void {
    for (const fn of this.subscribers) {
      try {
        fn(e);
      } catch {
        // ignore — a throwing subscriber is dropped for this event only
      }
    }
  }

  /** Number of currently-subscribed clients (for diagnostics / UI). */
  get size(): number {
    return this.subscribers.size;
  }
}

/** Process-wide singleton. RuntimeManager.emit broadcasts into it; the HTTP
 *  server's SSE handler subscribes per connection. */
export const mobileEventBus = new MobileEventBus();
