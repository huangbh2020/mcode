/**
 * Provider registry — singleton map of backend → AgentProvider.
 *
 * Add new providers here (one register call each). The rest of the system
 * (RuntimeManager, IPC, frontend) resolves providers by id from this registry.
 */
import type { AgentProvider } from "@contracts/provider";
import { ClaudeAgentSdkProvider } from "./claude-sdk/ClaudeAgentSdkProvider.js";
import { PiAgentSdkProvider } from "./pi-sdk/PiAgentSdkProvider.js";
import { CodexAgentSdkProvider } from "./codex-sdk/CodexAgentSdkProvider.js";

class ProviderRegistry {
  private providers = new Map<string, AgentProvider>();

  register(p: AgentProvider): void {
    if (this.providers.has(p.id)) {
      throw new Error(`Provider already registered: ${p.id}`);
    }
    this.providers.set(p.id, p);
  }

  get(id: string): AgentProvider | undefined {
    return this.providers.get(id);
  }

  /** Get a provider or fall back to the default (first registered). */
  resolve(id?: string): AgentProvider {
    if (id) {
      const p = this.providers.get(id);
      if (p) return p;
    }
    return this.default;
  }

  list(): AgentProvider[] {
    return [...this.providers.values()];
  }

  get default(): AgentProvider {
    const first = this.providers.values().next().value as AgentProvider | undefined;
    if (!first) throw new Error("No providers registered");
    return first;
  }
}

export const providerRegistry = new ProviderRegistry();

// Register built-in providers.
providerRegistry.register(new ClaudeAgentSdkProvider());
providerRegistry.register(new PiAgentSdkProvider());
providerRegistry.register(new CodexAgentSdkProvider());
