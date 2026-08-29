/**
 * Custom model configuration — lets the user plug in their own Anthropic-
 * compatible endpoint (DeepSeek's `/anthropic`, one-api/new-api gateways,
 * self-hosted proxies, etc.) alongside the built-in model aliases.
 *
 * Persisted on disk; the API key/token is encrypted with Electron safeStorage
 * (see main/lib/secretStore.ts) and NEVER crosses to the renderer in cleartext.
 * The renderer only ever sees {@link CustomModelPublic}.
 *
 * ## Model: flat model list
 *
 * One config = one endpoint (baseUrl + token + authMode) plus a flat list of
 * gateway-side model ids — mirroring how the Pi provider form works. The user
 * picks a MODEL in the dropdown; the selected id is injected as
 * `ANTHROPIC_MODEL` (with a `[1m]` suffix when the entry declares 1M context),
 * and the same bare id is mirrored onto the binary's background-tier env vars
 * (`ANTHROPIC_DEFAULT_HAIKU/SONNET/OPUS/FABLE_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL`)
 * so background requests also route to the user's gateway. See
 * main/providers/claude-sdk/customEnv.ts for the full mapping.
 *
 * (This flat shape replaced the earlier 5-tier "role binding" table — and, before
 * that, a `models[]` list + 3-key alias map. Older persisted records are
 * migrated transparently on read by `migrateMeta` in secretStore.ts.)
 *
 * ## Why so many fields besides the model list?
 *
 * Claude Code's own env contract for a custom endpoint isn't just base URL +
 * key. Third-party gateways differ from the official API in three ways that
 * matter:
 *
 * 1. **Auth scheme.** The official API uses `ANTHROPIC_API_KEY` (sent as
 *    `x-api-key`). Most gateways (DeepSeek, one-api, new-api) expect
 *    `ANTHROPIC_AUTH_TOKEN` (sent as `Authorization: Bearer …`). Setting the
 *    wrong one yields "no available channel for model X" 503s from the gateway.
 *
 * 2. **Non-essential traffic.** Claude Code phones home to Anthropic's
 *    telemetry endpoints by default; on a third-party gateway those fail.
 *    `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` turns them off.
 */

/** How the credential is presented to the upstream. */
export type AuthMode = "auth_token" | "api_key";

/** The wire protocol an endpoint speaks. `anthropic` (the default) means the
 *  endpoint implements Anthropic's `/v1/messages` — the binary talks to it
 *  directly via `ANTHROPIC_BASE_URL`. `openai` means the endpoint speaks
 *  OpenAI's `/v1/chat/completions`; the host runs an in-process bridge that
 *  impersonates an Anthropic endpoint and translates both directions, so the
 *  binary still thinks it's talking to Anthropic. */
export type Protocol = "anthropic" | "openai";

/** Default protocol when a stored config predates the `protocol` field, or when
 *  the user creates one without choosing. `anthropic` keeps every existing
 *  config behaving exactly as before. */
const DEFAULT_PROTOCOL: Protocol = "anthropic";

/** Normalize a possibly-undefined protocol to a concrete value. Mirrors
 *  {@link resolveAuthMode}'s pattern so old records upgrade transparently. */
export function resolveProtocol(p: Protocol | undefined): Protocol {
  return p ?? DEFAULT_PROTOCOL;
}

/** One selectable model on a custom endpoint. Mirrors the Pi side's flat
 *  per-provider model list: just the gateway-side model id plus a 1M-context
 *  declaration — no display name, no per-tier role. */
export interface CustomModelEntry {
  /** The actual model id the gateway routes to, e.g. "deepseek-v4-pro".
   *  Injected as ANTHROPIC_MODEL when selected; mirrored onto the background
   *  tier env vars (bare, without the `[1m]` suffix). */
  id: string;
  /** Declare 1M-token context support. When the session selects this model,
   *  ANTHROPIC_MODEL carries the `[1m]` suffix (the DeepSeek-style gateway
   *  convention). */
  supports1m?: boolean;
}

/** Fully-resolved config passed to the provider at turn time (main-process
 *  only — carries the cleartext credential, never crosses IPC). */
export interface ApiConfig {
  baseUrl: string;
  /** Cleartext credential. */
  authToken: string;
  authMode: AuthMode;
  /** Wire protocol of the upstream endpoint. `anthropic` (default) talks to it
   *  directly; `openai` activates the in-process protocol bridge. */
  protocol: Protocol;
  /** The model id the session has selected for this turn (one of
   *  `models[].id`). It becomes ANTHROPIC_MODEL (with the `[1m]` suffix when
   *  the entry declares it). Falls back to the first entry. */
  selectedModel: string;
  /** The config's flat model list. The selected model's bare id is mirrored
   *  onto the background-tier env vars so background requests also route to
   *  the user's gateway. */
  models: CustomModelEntry[];
  /** Model id (one of `models[].id`) pinned for Task-tool subagents in
   *  sessions using this config — injected per-turn as
   *  CLAUDE_CODE_SUBAGENT_MODEL, overriding the default mirror of the
   *  selected model. Absent = follow the main session's model. */
  subagentModel?: string;
  /** Disable Claude Code's non-essential (telemetry) traffic. Default true
   *  for custom endpoints — almost always what you want on a gateway. */
  disableNonEssentialTraffic: boolean;
  /** Per-request timeout in ms (passed through as API_TIMEOUT_MS). */
  timeoutMs?: number;
}

/** Credential storage shape (encrypted at rest, decrypted in main only). */
export interface StoredCredential {
  authToken: string;
  authMode: AuthMode;
}

/** A stored custom-model config (main-process side; holds the cleartext token).
 *  One config = one endpoint + a flat model list. */
export interface CustomModel {
  id: string;
  /** User-facing name, e.g. "DeepSeek 中转". */
  name: string;
  baseUrl: string;
  /** Cleartext token. Only exists in main memory; persisted encrypted. */
  authToken: string;
  authMode: AuthMode;
  protocol: Protocol;
  models: CustomModelEntry[];
  disableNonEssentialTraffic: boolean;
  timeoutMs?: number;
  createdAt: number;
}

/**
 * Renderer-facing (desensitized) view of a custom model. The token is masked
 * (e.g. "sk-***ab12"); the cleartext never leaves the main process.
 */
export interface CustomModelPublic {
  id: string;
  name: string;
  baseUrl: string;
  authMode: AuthMode;
  /** Wire protocol (resolved to a concrete value, never undefined). */
  protocol: Protocol;
  /** Masked token, e.g. "sk-***ab12". For display only. */
  authTokenMasked: string;
  models: CustomModelEntry[];
  /** Task-subagent model pinned for this config (one of `models[].id`), or
   *  undefined = follow the main session's model. See ApiConfig.subagentModel. */
  subagentModel?: string;
  disableNonEssentialTraffic: boolean;
  timeoutMs?: number;
  createdAt: number;
}

/** Persisted metadata record (everything except the credential, which lives
 *  in the encrypted secret store keyed by id). Stored as JSON under the
 *  settings key `customModels`. */
export interface CustomModelMeta {
  id: string;
  name: string;
  baseUrl: string;
  authMode: AuthMode;
  /** Wire protocol. Absent on legacy records; resolve via {@link resolveProtocol}. */
  protocol?: Protocol;
  models: CustomModelEntry[];
  /** Task-subagent model pinned for this config, or undefined = follow the
   *  main session's model. See ApiConfig.subagentModel. */
  subagentModel?: string;
  disableNonEssentialTraffic: boolean;
  timeoutMs?: number;
  createdAt: number;
}

/** Input for creating or updating a custom model. `authToken` is optional on
 *  update so the user can edit other fields without re-entering the secret
 *  (omitting it = keep the existing stored token). */
export interface CustomModelInput {
  /** Omit on create; present on update to target an existing record. */
  id?: string;
  name: string;
  baseUrl: string;
  authMode?: AuthMode;
  /** Wire protocol. Optional for backward compat; defaults to "anthropic". */
  protocol?: Protocol;
  /** Cleartext. Required on create; optional on update (omit = keep existing). */
  authToken?: string;
  /** The flat model list (≥1 entry, enforced by the IPC schema). */
  models: CustomModelEntry[];
  /** Task-subagent model to pin for this config. Must be one of
   *  `models[].id`; a value not in the list is dropped by the store (falls
   *  back to following the main model). Empty/undefined = no pin. */
  subagentModel?: string;
  disableNonEssentialTraffic?: boolean;
  timeoutMs?: number;
}

/** Result of a connection probe using the user-supplied (not-yet-saved) values. */
export interface TestCustomModelResult {
  ok: boolean;
  /** claude's version string or model echo, when available. */
  detail?: string;
  /** Error message on failure (auth / network / timeout / bad model). */
  error?: string;
}
