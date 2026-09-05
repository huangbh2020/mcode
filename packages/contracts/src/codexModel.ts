/**
 * Codex model-providers configuration types.
 *
 * Mcode drives the Codex agent harness with user-configured third-party model
 * providers (OpenAI-compatible endpoints that speak the Responses API). The
 * provider list lives in the settings table (`codexProviders`, metadata only)
 * plus a safeStorage-encrypted key map (`codexProviderKeys`); at turn time the
 * provider materializes them into `<CODEX_HOME>/config.toml`'s
 * `[model_providers.<id>]` tables and injects each decrypted key into the
 * app-server subprocess env (`MCODE_CODEX_KEY_<ID>` — referenced by the TOML
 * `env_key` field). Cleartext keys never touch disk or IPC.
 *
 * ⚠️ Codex only supports `wire_api = "responses"` (the Chat Completions wire
 * API is deprecated upstream). Endpoints must expose `/v1/responses` — Mcode's
 * Claude-side custom models (chat-completions bridge) are NOT reusable here.
 */

/** One model entry under a provider. */
export interface CodexModelOption {
  /** Model id sent to the API (also used for thread/turn `model`). */
  id: string;
  /** Display name; defaults to `id` when absent. */
  label?: string;
  /** Optional trailing hint in the picker (e.g. "1M"). */
  hint?: string;
}

/** Persisted shape of one provider entry (settings table, no secrets). */
export interface CodexProviderConfig {
  /** Human display name. */
  name: string;
  /** API endpoint base URL — must speak the OpenAI Responses API. */
  baseUrl: string;
  /** Models offered by this provider (>= 1 required). */
  models: CodexModelOption[];
}

/** Renderer-facing view of a provider (apiKey never sent — only a presence
 *  flag so the UI can show "已配置 Key" / "未配置 Key"). */
export interface CodexProviderPublic extends CodexProviderConfig {
  /** Stable slug used as the TOML table key + env-var suffix. */
  id: string;
  /** Whether a key is stored in the encrypted credentials map. */
  hasApiKey: boolean;
}
