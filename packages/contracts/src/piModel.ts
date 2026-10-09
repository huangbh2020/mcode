/**
 * Pi models.json configuration types.
 *
 * Pi SDK loads custom providers/models from `~/.pi/agent/models.json`
 * (top-level shape: `{ providers: Record<name, ProviderConfig>, modelOverrides? }`).
 * The SDK has NO write API for this file — it only reads it (ModelRegistry.create
 * re-reads on every startTurn, so edits take effect without restarting). Mcode's
 * settings panel is the visual editor: it reads the file, lets the user edit
 * providers via forms, and writes back — preserving any fields the UI doesn't
 * manage (headers / compat / modelOverrides) so hand-written configs survive.
 *
 * Schema details verified against the SDK's model-config.d.ts / model-registry.js:
 *   - ProviderConfig: name? / baseUrl? / apiKey? / api? / headers? / compat? /
 *     authHeader? / models? / modelOverrides?
 *   - ModelDefinition: id (required) / name? / api? / baseUrl? / reasoning? /
 *     thinkingLevelMap? / input? / cost? / contextWindow? (default 128000) /
 *     maxTokens? (default 16384) / headers? / compat?
 *   - thinkingLevelMap keys: off / minimal / low / medium / high / xhigh / max
 *     (all seven of the SDK's ThinkingLevel values — verified against the
 *     1.0.2 model-config schema; "max" is a valid KEY as well as a common
 *     VALUE, e.g. `"xhigh": "max"` maps the xhigh slot onto the wire value
 *     "max").
 *     Value tri-state: omitted=use provider default, string=concrete value,
 *     null=not supported.
 *   - apiKey supports `$ENV_VAR` interpolation (e.g. "$DEEPSEEK_API_KEY") —
 *     the key never touches the file as plaintext.
 */

/** Custom provider `api` values the SDK documents as supported. */
export const PI_KNOWN_APIS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
] as const;
export type PiKnownApi = (typeof PI_KNOWN_APIS)[number];

/** thinkingLevelMap keys — all seven ThinkingLevel values the SDK accepts
 *  (`THINKING_LEVEL_OPTIONS` in pi-coding-agent's defaults.js). "max" is a
 *  valid KEY as well as a common VALUE (`"xhigh": "max"` remaps the xhigh
 *  slot onto the wire value "max"). */
export const PI_THINKING_KEYS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type PiThinkingKey = (typeof PI_THINKING_KEYS)[number];

/** Context-window presets the settings UI writes for Pi models. The UI no
 *  longer asks the user to type a raw token count (mirroring the Claude
 *  side's approach): a single "1M context" toggle picks between these two
 *  values — off → 200k (the common large-model default), on → 1M. The
 *  underlying `PiModelDefinition.contextWindow` field still stores whatever
 *  number is written; these constants only pin the two UI-driven choices. */
export const PI_DEFAULT_CONTEXT_WINDOW = 200_000;
export const PI_1M_CONTEXT_WINDOW = 1_000_000;

/** Per-model thinking-level → provider value map. Value tri-state:
 *  omitted (undefined) = use provider default; string = concrete value;
 *  null = not supported (UI hides / cycle skips). */
export type PiThinkingLevelMap = Partial<Record<PiThinkingKey, string | null>>;

/** One custom model definition in a provider's `models` array. `id` is the
 *  only required field. Unknown fields (cost / headers / compat / …) are
 *  preserved verbatim on save. */
export interface PiModelDefinition {
  /** Model id sent to the API (also used for --model matching). */
  id: string;
  /** Display name; defaults to `id` when absent. */
  name?: string;
  /** Override the provider's api type. */
  api?: string;
  /** Override the provider's base URL. */
  baseUrl?: string;
  /** Whether the model supports extended thinking. */
  reasoning?: boolean;
  /** Per-thinking-level mapping (tri-state, see above). */
  thinkingLevelMap?: PiThinkingLevelMap;
  /** Supported input types: ["text"] or ["text","image"]. */
  input?: string[];
  /** Context window size in tokens (default 128000). */
  contextWindow?: number;
  /** Max output tokens (default 16384). */
  maxTokens?: number;
  /** Unknown fields (cost / headers / compat / …) preserved on save. */
  [key: string]: unknown;
}

/** One provider entry in models.json's `providers` map. All fields optional
 *  (a provider with `models` requires baseUrl; models with no api inherit
 *  the provider's api). Unknown fields preserved on save. */
export interface PiProviderConfig {
  /** Human display name (the SDK actually keys off the map key, not this). */
  name?: string;
  /** API endpoint. Required for non-built-in providers that define models. */
  baseUrl?: string;
  /** Credential reference for the model.json file. NOTE: in Mcode's flow this
   *  field is NOT written to models.json — the actual key is encrypted in
   *  the settings table and injected at turn time via AuthStorage. The type
   *  is kept for forward-compat (legacy / hand-written configs may still
   *  carry `$ENV` references here). */
  apiKey?: string;
  /** Wire api type, e.g. "openai-completions". Required for custom models. */
  api?: string;
  /** Add `Authorization: Bearer <apiKey>` automatically when true. */
  authHeader?: boolean;
  /** Custom model definitions. */
  models?: PiModelDefinition[];
  /** Unknown fields (headers / compat / modelOverrides / …) preserved. */
  [key: string]: unknown;
}

/** Renderer-facing view of a provider (apiKey never sent — only a presence
 *  flag so the UI can show "已配置 Key" / "未配置 Key"). */
export interface PiProviderPublic extends PiProviderConfig {
  /** Whether a key is stored in the encrypted credentials map. */
  hasApiKey: boolean;
}

/** Top-level shape of ~/.pi/agent/models.json. */
export interface PiModelsFile {
  providers: Record<string, PiProviderConfig>;
  /** Unknown top-level fields (modelOverrides / …) preserved on save. */
  [key: string]: unknown;
}
