/**
 * Singleton registry of bridge servers, keyed by custom-model config id.
 *
 * A bridge server is relatively heavyweight (a listening socket) but stateless
 * per-request, so we want to share ONE server across every session/turn that
 * uses the same OpenAI-format config. At the same time, the server must be
 * kept alive across the many requests a single turn generates — the Claude
 * binary fires background tier requests (Task subagents, haiku-class checks)
 * alongside the main message — so we can't tear it down per turn.
 *
 * This registry reference-counts: the first `acquire` for a config id starts a
 * server, subsequent ones just bump the count, and `release` only closes once
 * the count reaches zero. `disposeAll()` (called at app shutdown) force-closes
 * everything regardless of count.
 *
 * Pattern mirrors `TerminalManager.disposeAll()` / `fileSnapshotRegistry`.
 */
import type { ApiConfig } from "@contracts/customModel";
import { log } from "@main/lib/logger.js";
import { startBridge, type BridgeHandle } from "./bridgeServer.js";

interface Entry {
  handle: BridgeHandle;
  /** The upstream config the server was built from. Used to detect config
   *  drift — if a saved config's token/URL changed, the next acquire rebuilds
   *  the server rather than serving a stale upstream. */
  fingerprint: string;
  refCount: number;
}

/** A minimal fingerprint of the upstream bits that affect the running server.
 *  If any of these change, the existing server is stale and must be rebuilt. */
function fingerprint(cfg: ApiConfig): string {
  return JSON.stringify({
    baseUrl: cfg.baseUrl,
    authToken: cfg.authToken,
    authMode: cfg.authMode,
    timeoutMs: cfg.timeoutMs ?? null,
    // Headers are baked into every upstream request this server makes, so an
    // edit that doesn't rebuild would keep sending the OLD set for the rest of
    // the bridge's life (it outlives the turn that created it).
    customHeaders: cfg.customHeaders ?? null,
  });
}

class BridgeRegistryImpl {
  private entries = new Map<string, Entry>();

  /** Acquire a bridge for the given config id. Reuses an existing server when
   *  the config hasn't changed; rebuilds when the fingerprint drifts; creates
   *  fresh when none exists. Always bumps the ref count for the caller, who
   *  MUST pair this with {@link release}. */
  async acquire(customModelId: string, upstream: ApiConfig): Promise<BridgeHandle> {
    const fp = fingerprint(upstream);
    const existing = this.entries.get(customModelId);
    if (existing) {
      if (existing.fingerprint !== fp) {
        // Config changed under us (user edited token/URL). Rebuild.
        log.info(`bridge: config ${customModelId} changed, rebuilding server`);
        existing.handle.close();
        const handle = await startBridge(upstream);
        this.entries.set(customModelId, { handle, fingerprint: fp, refCount: 1 });
        return handle;
      }
      existing.refCount += 1;
      return existing.handle;
    }
    const handle = await startBridge(upstream);
    this.entries.set(customModelId, { handle, fingerprint: fp, refCount: 1 });
    return handle;
  }

  /** Release a previously-acquired bridge. Decrements the ref count; closes the
   *  server only when the last holder releases. Safe to call without a prior
   *  acquire (no-op). */
  release(customModelId: string): void {
    const entry = this.entries.get(customModelId);
    if (!entry) return;
    entry.refCount -= 1;
    if (entry.refCount <= 0) {
      entry.handle.close();
      this.entries.delete(customModelId);
    }
  }

  /** Close every bridge, regardless of ref count. Called at app shutdown. */
  disposeAll(): void {
    for (const [id, entry] of this.entries) {
      entry.handle.close();
      this.entries.delete(id);
    }
  }
}

export const BridgeRegistry = new BridgeRegistryImpl();
