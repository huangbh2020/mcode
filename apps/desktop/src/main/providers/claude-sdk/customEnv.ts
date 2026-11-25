/**
 * Build the SDK subprocess `env` for a custom endpoint, from an ApiConfig.
 *
 * The SDK's `Options.env` REPLACES the subprocess environment entirely (per
 * sdk.d.ts), so we always spread `process.env` first — otherwise PATH/HOME
 * disappear and the claude binary can't even boot.
 *
 * Shared between:
 *   - {@link ClaudeAgentSdkProvider} (live turns)
 *   - {@link ../../ipc/customModel.ts} `probeEndpoint` (connection test)
 * so the two paths stay byte-identical.
 *
 * ## How the model id reaches the API

 * The claude binary consults TWO channels and they MUST agree:
 *
 *   1. `ANTHROPIC_MODEL` (subprocess env) — the binary's native model override.
 *      Recognized in the bundled binary's env-var allowlist (verified against
 *      v0.3.218 / claude code 2.1.218). This is the channel DeepSeek's official
 *      Claude Code integration guide configures, and the channel the binary
 *      uses to route the primary turn.
 *   2. `Options.model` (→ `--model` CLI flag) — also read by the binary; an
 *      explicit `--model` generally takes precedence over the env var.
 *
 * For a custom config we deliberately drive the model through `ANTHROPIC_MODEL`
 * ONLY and leave `Options.model` unset. Passing both, with the env var carrying
 * a `[1m]` suffix and `Options.model` carrying a bare name (or vice-versa), was
 * a previous bug that produced "selected model may not exist". Letting the
 * binary resolve from a single source (the env var) matches DeepSeek's
 * documented working config and avoids the dual-channel disagreement.
 *
 * ## Background tiers — mirror the selected model everywhere
 *
 * The binary also issues BACKGROUND requests under its internal tier system
 * (sub-agent Task tool, haiku-class side calls), each routed via a dedicated
 * env var:
 *
 *   ANTHROPIC_DEFAULT_HAIKU_MODEL / _SONNET_ / _OPUS_ / _FABLE_
 *   CLAUDE_CODE_SUBAGENT_MODEL   (not a model alias — Task-tool context)
 *   ANTHROPIC_SMALL_FAST_MODEL   (legacy haiku alias read by older builds)
 *
 * The config's model list is FLAT — there are no per-tier models anymore — so
 * every tier var is set to the SELECTED model's bare id. Without this, the
 * tiers fall back to Anthropic's built-in model names, which only exist on
 * Anthropic's own endpoint: on a third-party gateway the Task tool dies with
 * "no available channel for model claude-…-…" 503s before doing anything.
 * Tier vars NEVER carry the `[1m]` suffix — background requests are
 * short-context, and a suffixed id on a tier the gateway doesn't expect was
 * the historical "haiku channel receiving deepseek-v4-pro[1m] it doesn't
 * serve" mismatch.
 *
 * ## 1M context — the `[1m]` suffix (LOWERCASE)
 *
 * Declared via a `[1m]` suffix on the model name (e.g. `deepseek-v4-pro[1m]`),
 * NOT via the SDK's `betas` option. This is the convention used by DeepSeek's
 * `/anthropic` endpoint and most third-party gateways — they do NOT recognize
 * Anthropic's native `anthropic-beta: context-1m-2025-08-07` header.
 *
 * IMPORTANT: the suffix is LOWERCASE `[1m]`, matching DeepSeek's official
 * documentation (https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code/):
 *   ANTHROPIC_MODEL=deepseek-v4-pro[1m]
 * The binary internally normalizes any casing to lowercase anyway (its init
 * handshake logs `model=deepseek-v4-pro[1m]` regardless of input casing), so
 * emitting lowercase up front keeps the diagnostic log honest.
 *
 * The suffix is carried ONLY on `ANTHROPIC_MODEL` (the primary turn's model)
 * — when the selected model's entry declares `supports1m`. Background tier
 * vars use the bare name; see above.
 *
 * ## Request headers — `ANTHROPIC_CUSTOM_HEADERS`
 *
 * The endpoint's `customHeaders` (plus an auto session id for gateways that
 * require one) ride `ANTHROPIC_CUSTOM_HEADERS`, one `Name: Value` per line.
 * This mirrors {@link ../../bridge/bridgeServer.ts} for the `openai` protocol,
 * where the bridge merges the same set into its upstream request instead —
 * the two paths must stay in sync, which is why the shared policy lives in
 * {@link ../../upstreamHeaders.ts}.
 */
import type { ApiConfig, CustomModelEntry } from "@contracts/customModel";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import {
  formatCustomHeaderLines,
  isValidEffortHeaderValue,
  MCODE_EFFORT_HEADER,
  parseCustomHeaderLines,
  resolveUpstreamHeaders,
} from "@main/providers/upstreamHeaders.js";

/** Mcode's own Claude config directory. We always set CLAUDE_CONFIG_DIR to
 *  this path so the bundled claude binary reads its user-level config
 *  (settings.json, skills/, commands/) from here instead of ~/.claude.
 *  This decouples Mcode from the user's Claude Code CLI installation: tools
 *  like "cc switch" that overwrite ~/.claude/settings.json no longer affect
 *  Mcode's turns, and user-level skills live under ~/.mcode/skills where
 *  Mcode's import feature places them. */
export const MCODE_CONFIG_DIR = path.join(homedir(), ".mcode");

/** The Claude CLI child's environment. It REPLACES the subprocess environment
 *  entirely, so every builder spreads `process.env`` first. */
export type ClaudeCliEnv = Record<string, string | undefined>;

/** Session id handed to a gateway that requires one when the caller has no
 *  Mcode session to name — the connection probe, title generation, the
 *  commit-message helper. Stable for the process lifetime so such traffic
 *  still looks like ONE conversation to the gateway instead of a fresh id per
 *  request. Live turns pass their real session id instead (see
 *  {@link buildCustomEnv}). */
const PROCESS_SESSION_ID = `mcode-${randomBytes(6).toString("hex")}`;

/** The config entry driving this turn: the session's selected model when it's
 *  still configured, else the first entry. Callers guarantee at least one
 *  entry exists before invoking us (validated upstream). */
function resolveSelectedEntry(cfg: ApiConfig): CustomModelEntry | undefined {
  return cfg.models.find((m) => m.id === cfg.selectedModel) ?? cfg.models[0];
}

/** Append the `[1m]` context suffix used by DeepSeek-style gateways. Idempotent
 *  — a model that already carries the suffix (any casing) is returned with the
 *  canonical lowercase form, so we never produce `xxx[1m][1m]` and never emit
 *  the uppercase `[1M]` variant. DeepSeek's docs and the binary both use `[1m]`. */
export function with1MSuffix(model: string): string {
  return /\[1m\]$/i.test(model) ? `${model.replace(/\[1m\]$/i, "")}[1m]` : `${model}[1m]`;
}

/** Strip the trailing `[1m]` context suffix (any casing, repeated occurrences
 *  collapsed) — the inverse of {@link with1MSuffix}. Used where the BARE model
 *  id is required: the OpenAI-protocol bridge. The suffix is an Anthropic-wire
 *  convention that DeepSeek-style gateways parse themselves; OpenAI's
 *  chat-completions wire has no equivalent, so `model[1m]` reads as an unknown
 *  model id and gateways answer 401/404 even though the token is perfectly
 *  valid. */
export function strip1MSuffix(model: string): string {
  return model.replace(/(\[1m\])+$/i, "");
}

/**
 * Resolve the model id for this turn, with the `[1m]` suffix appended when the
 * selected model's entry declares `supports1m`. This is the same string placed
 * on `ANTHROPIC_MODEL` by {@link buildCustomEnv}; exported so the connection
 * probe (which doesn't set `ANTHROPIC_MODEL` — it passes the model via the
 * SDK `model` option instead) can stay byte-identical with the live-turn path.
 */
export function resolveActiveModel(cfg: ApiConfig): string | undefined {
  const entry = resolveSelectedEntry(cfg);
  if (!entry) return undefined;
  const roleMeta = cfg.selectedRole ? cfg.tierModels?.roleMeta?.[cfg.selectedRole] : undefined;
  const supports1m =
    roleMeta?.supports1m !== undefined ? roleMeta.supports1m : Boolean(entry.supports1m);
  return supports1m ? with1MSuffix(entry.id) : entry.id;
}

/** All Claude CLI environment variable keys managed by Mcode's custom-endpoint
 *  env builder and `settings.json` sync. Used both to clear stale keys when
 *  switching providers and to shadow ~/.mcode/settings.json via `--settings`. */
export const CLAUDE_MANAGED_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  "API_TIMEOUT_MS",
  "ANTHROPIC_CUSTOM_HEADERS",
] as const;

/**
 * Resolve the pure `Record<string, string>` of Claude CLI environment variables
 * for an `ApiConfig` (without spreading `process.env` or setting
 * `CLAUDE_CONFIG_DIR`). Shared by {@link buildCustomEnv}, `--settings.env`
 * isolation in `ClaudeAgentSdkProvider`, and `settings.json` sync so all three
 * paths emit identical model/tier/header mappings.
 */
export function buildClaudeSettingsEnv(
  cfg: ApiConfig,
  opts?: { sessionId?: string; thinkingEffort?: string; inheritedCustomHeaders?: string },
): Record<string, string> {
  const env: Record<string, string> = {};

  env.ANTHROPIC_BASE_URL = cfg.baseUrl;

  if (cfg.authMode === "api_key") {
    env.ANTHROPIC_API_KEY = cfg.authToken;
  } else {
    env.ANTHROPIC_AUTH_TOKEN = cfg.authToken;
  }

  // Resolve primary model + per-tier overrides. Any blank tier falls back to
  // the selected model's bare id so third-party gateways never fail with
  // unknown built-in Anthropic model names (503).
  const entry = resolveSelectedEntry(cfg);
  const bare = entry?.id ? strip1MSuffix(entry.id) : "";
  const pickTier = (raw?: string): string => {
    const trimmed = raw?.trim();
    return trimmed ? strip1MSuffix(trimmed) : bare;
  };
  const haiku = pickTier(cfg.tierModels?.haiku);
  const sonnet = pickTier(cfg.tierModels?.sonnet);
  const opus = pickTier(cfg.tierModels?.opus);
  const subagent = pickTier(cfg.tierModels?.subagent ?? cfg.subagentModel);
  const fable = pickTier(cfg.tierModels?.fable) || opus;

  if (haiku) {
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = haiku;
    env.ANTHROPIC_SMALL_FAST_MODEL = haiku;
  }
  if (sonnet) {
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = sonnet;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME = sonnet;
  }
  if (opus) {
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = opus;
  }
  if (fable) {
    env.ANTHROPIC_DEFAULT_FABLE_MODEL = fable;
  }
  if (subagent) {
    env.CLAUDE_CODE_SUBAGENT_MODEL = subagent;
  }

  if (cfg.disableNonEssentialTraffic) {
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  }

  const mainModel = resolveActiveModel(cfg);
  if (mainModel) {
    env.ANTHROPIC_MODEL = mainModel;
  }

  if (cfg.timeoutMs && cfg.timeoutMs > 0) {
    env.API_TIMEOUT_MS = String(cfg.timeoutMs);
  }

  if (cfg.protocol === "anthropic") {
    const upstreamHeaders = resolveUpstreamHeaders(
      {
        ...parseCustomHeaderLines(opts?.inheritedCustomHeaders),
        ...cfg.customHeaders,
      },
      cfg.baseUrl,
      opts?.sessionId ? `mcode-${opts.sessionId}` : PROCESS_SESSION_ID,
    );
    if (Object.keys(upstreamHeaders).length > 0) {
      env.ANTHROPIC_CUSTOM_HEADERS = formatCustomHeaderLines(upstreamHeaders);
    }
  } else if (cfg.protocol === "openai" && isValidEffortHeaderValue(opts?.thinkingEffort)) {
    env.ANTHROPIC_CUSTOM_HEADERS = formatCustomHeaderLines({
      ...parseCustomHeaderLines(opts?.inheritedCustomHeaders),
      [MCODE_EFFORT_HEADER]: opts.thinkingEffort,
    });
  }

  return env;
}

/**
 * @param opts.sessionId Mcode session driving this turn. Only used to name the
 *   gateway's required session header — see the `ANTHROPIC_CUSTOM_HEADERS`
 *   block below. Callers without a session (probe / title / commit-message
 *   helpers) may omit it and get a stable per-process id instead.
 * @param opts.thinkingEffort Thinking level for the turn, on `openai`-protocol
 *   configs ONLY (see {@link MCODE_EFFORT_HEADER}). It rides
 *   ANTHROPIC_CUSTOM_HEADERS to the local bridge, which translates it into the
 *   endpoint's native field. Ignored entirely on `anthropic` configs — there
 *   the level goes through the SDK's own effort option instead.
 */
export function buildCustomEnv(
  cfg: ApiConfig,
  opts?: { sessionId?: string; thinkingEffort?: string },
): ClaudeCliEnv {
  const env: ClaudeCliEnv = { ...process.env };
  const overrides = buildClaudeSettingsEnv(cfg, {
    ...opts,
    inheritedCustomHeaders: env.ANTHROPIC_CUSTOM_HEADERS,
  });

  // Explicitly clear the inactive auth channel from inherited process.env so
  // the CLI never sends both Authorization and x-api-key.
  if (cfg.authMode === "api_key") {
    env.ANTHROPIC_AUTH_TOKEN = undefined;
  } else {
    env.ANTHROPIC_API_KEY = undefined;
  }

  Object.assign(env, overrides);

  // Always redirect the claude binary's user-level config root to Mcode's
  // own directory (~/.mcode).
  env.CLAUDE_CONFIG_DIR = MCODE_CONFIG_DIR;

  return env;
}
