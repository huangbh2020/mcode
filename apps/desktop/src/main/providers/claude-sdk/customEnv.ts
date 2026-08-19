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
 */
import type { ApiConfig, CustomModelEntry } from "@contracts/customModel";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { homedir } from "node:os";
import path from "node:path";

/** Mcode's own Claude config directory. We always set CLAUDE_CONFIG_DIR to
 *  this path so the bundled claude binary reads its user-level config
 *  (settings.json, skills/, commands/) from here instead of ~/.claude.
 *  This decouples Mcode from the user's Claude Code CLI installation: tools
 *  like "cc switch" that overwrite ~/.claude/settings.json no longer affect
 *  Mcode's turns, and user-level skills live under ~/.mcode/skills where
 *  Mcode's import feature places them. */
export const MCODE_CONFIG_DIR = path.join(homedir(), ".mcode");

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
  return entry.supports1m ? with1MSuffix(entry.id) : entry.id;
}

export function buildCustomEnv(cfg: ApiConfig): NonNullable<Options["env"]> {
  const env: NonNullable<Options["env"]> = { ...process.env };

  env.ANTHROPIC_BASE_URL = cfg.baseUrl;

  // Auth: gateways differ in which header they read. The official API uses
  // x-api-key (ANTHROPIC_API_KEY); most third-party gateways expect
  // Authorization: Bearer (ANTHROPIC_AUTH_TOKEN). When in token mode we
  // explicitly clear ANTHROPIC_API_KEY so the SDK doesn't send both and
  // confuse the gateway (and vice-versa).
  //
  // NOTE: DeepSeek's official Claude Code guide uses ANTHROPIC_AUTH_TOKEN
  // (Bearer). The UI defaults to auth_token for this reason. If a user picks
  // api_key and the gateway returns an opaque 404 (not 401), authMode is a
  // likely culprit — some gateways hide endpoint existence on bad auth.
  if (cfg.authMode === "api_key") {
    env.ANTHROPIC_API_KEY = cfg.authToken;
    env.ANTHROPIC_AUTH_TOKEN = undefined;
  } else {
    env.ANTHROPIC_AUTH_TOKEN = cfg.authToken;
    env.ANTHROPIC_API_KEY = undefined;
  }

  // Resolve the model driving this turn. The flat model list has no per-tier
  // bindings, so the SELECTED model is mirrored onto every background-tier
  // env var (bare id — never the `[1m]` suffix; see the file header). This
  // replaces both the old per-role binding table and its subagent fallback:
  // with a flat list there is nothing to differentiate, and unbound tiers
  // falling back to Anthropic's built-in model names was exactly what broke
  // the Task tool on third-party gateways.
  const entry = resolveSelectedEntry(cfg);
  if (entry) {
    const bare = entry.id;
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = bare;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = bare;
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = bare;
    env.ANTHROPIC_DEFAULT_FABLE_MODEL = bare;
    env.CLAUDE_CODE_SUBAGENT_MODEL = bare;
    // Legacy haiku alias: older Claude Code builds read ANTHROPIC_SMALL_FAST_MODEL
    // (37 hits in the v0.3.218 binary) before ANTHROPIC_DEFAULT_HAIKU_MODEL
    // existed. Mirror the same bare id so background "small/fast" requests
    // route correctly on builds that still consult the legacy name.
    env.ANTHROPIC_SMALL_FAST_MODEL = bare;
    // DeepSeek private convention: ANTHROPIC_DEFAULT_SONNET_MODEL_NAME records
    // the logical sonnet model name WITHOUT the `[1m]` suffix. The gateway
    // consults this for internal routing. Always the bare name.
    env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME = bare;
  }

  // Non-essential traffic (telemetry, etc.) — almost always desirable to
  // disable on a third-party gateway, since those endpoints don't exist there
  // and produce noise/errors.
  if (cfg.disableNonEssentialTraffic) {
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  }

  // Pin the primary turn's model via ANTHROPIC_MODEL. This is the channel the
  // binary uses to route the foreground request; it's what DeepSeek's official
  // Claude Code integration configures. Carries the `[1m]` suffix when the
  // selected model declares supports1m, so a 1M-context turn is routed
  // correctly. (We deliberately do NOT also pass Options.model / --model —
  // see the file header; one channel is enough and avoids disagreement.)
  const mainModel = resolveActiveModel(cfg);
  if (mainModel) {
    env.ANTHROPIC_MODEL = mainModel;
  }

  // Per-request timeout (ms). The SDK honors API_TIMEOUT_MS.
  if (cfg.timeoutMs && cfg.timeoutMs > 0) {
    env.API_TIMEOUT_MS = String(cfg.timeoutMs);
  }

  // Always redirect the claude binary's user-level config root to Mcode's
  // own directory (~/.mcode). This is the key mechanism that makes user-level
  // skills load on custom endpoints: with the config root moved here, the
  // binary's user skill auto-load scans ~/.mcode/skills/ (where Mcode's import
  // feature places skills) instead of ~/.claude/skills/. It also means the
  // cc-switch-controlled ~/.claude/settings.json is never read, so we no
  // longer need to drop "user" from settingSources to protect the env.
  env.CLAUDE_CONFIG_DIR = MCODE_CONFIG_DIR;

  return env;
}
