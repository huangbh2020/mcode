/**
 * Subagent-model pinning for Claude sessions (per custom-endpoint config).
 *
 * The channel is the `CLAUDE_CODE_SUBAGENT_MODEL` subprocess env var — the
 * claude binary's native override for the model used by Task-tool subagents
 * (consumed in the bundled binary; verified against 2.1.238). The SDK has no
 * declarative Options/Settings field for this, so the config-level pick
 * (`ApiConfig.subagentModel`, set per provider in the settings panel) is
 * resolved per-turn by ClaudeAgentSdkProvider and layered onto `options.env`
 * AFTER buildCustomEnv — the pin thereby overrides the custom endpoint
 * path's default mirror of the main model onto the same var.
 *
 * Official-endpoint sessions (no ApiConfig) have nowhere to hang a pin, so
 * they always follow the main model — by design: this is a per-provider
 * setting, and the official endpoint is not a user-configured provider.
 *
 * The value is always re-checked against the config's model list before
 * injection (both at save time in CustomModelStore and here): an id the
 * gateway doesn't serve doesn't just fail one request — it kills the Task
 * tool outright with model-not-found 503s, the exact failure mode
 * buildCustomEnv's tier mirroring exists to prevent (see customEnv.ts
 * "Background tiers"). A stale pin therefore degrades to "follow the main
 * model" instead of breaking subagents.
 */
import type { ApiConfig } from "@contracts/customModel";

/**
 * The config's pinned subagent model, or null when nothing should be
 * injected (no config, no pin, or a pin the config's model list no longer
 * contains — see the file header for why silently dropping beats injecting
 * a broken id).
 */
export function resolveSubagentModelValue(apiConfig: ApiConfig | undefined): string | null {
  const pick = apiConfig?.subagentModel?.trim();
  if (!pick || !apiConfig) return null;
  return apiConfig.models.some((m) => m.id === pick) ? pick : null;
}
