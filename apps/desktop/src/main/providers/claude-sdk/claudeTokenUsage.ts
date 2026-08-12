/**
 * Claude token usage — parsing, normalization, window resolution, warnings.
 *
 * Single source of truth for context-window math. The SdkMessageAdapter calls
 * these helpers to turn raw SDK `usage` / `modelUsage` fields into a provider-
 * neutral {@link ContextSnapshot}, which it then emits as a
 * `token-usage.updated` event. Downstream stages (renderer / persistence) are
 * provider-agnostic — they never touch raw token fields.
 *
 * Design mirrors ClaudeCode's `claudeTokenUsage.ts`
 * (docs/claude-context-usage-tracking.md §2-§5), simplified for the Agent
 * SDK's data model: we have paths A (per assistant response) and C (turn-end
 * result), but not path B (the live `getContextUsage()` control channel —
 * the SDK's stream-json surface doesn't expose it). Effects of that gap are
 * noted inline; see also doc §7.2.
 */
import type {
  ContextSnapshot,
  ContextWarning,
  ContextWarningKind,
} from "@contracts/runtime";
import type { SDKControlGetContextUsageResponse } from "@anthropic-ai/claude-agent-sdk";

/** Raw usage fields the SDK reports on assistant / result messages. Missing
 *  fields are treated as 0. Field names follow the Anthropic API convention
 *  (the SDK forwards them verbatim from `result.usage`). */
export interface RawClaudeUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  /** Approximate USD cost for this turn, if known. */
  costUsd?: number;
  /** Active model id (e.g. `claude-sonnet-4-5`, `claude-opus-4-1[1M]`). */
  model?: string;
}

/* ── thresholds (doc §5) ── */

const UNCACHED_INGESTION_TOKENS = 50_000;
const LARGE_PROMPT_TOKENS = 200_000;
const NEAR_WINDOW_RATIO = 0.8; // 80% of effective budget
// When prompt > this AND cache-read ratio < CACHE_READ_LOW_RATIO, flag
// uncached-ingestion (catches fresh sessions / resumes / large first turns).
const PROMPT_FOR_CACHE_CHECK_TOKENS = 20_000;
const CACHE_READ_LOW_RATIO = 0.2;

/* ── known window ceilings (doc §4) ── */

export const CLAUDE_CONTEXT_WINDOW_MAX_TOKENS = {
  "200k": 200_000,
  "1m": 1_000_000,
} as const;
export type ClaudeContextWindowTag = keyof typeof CLAUDE_CONTEXT_WINDOW_MAX_TOKENS;

/** "Logical prompt tokens" — the count that actually occupies the context
 *  window (doc §3). Cache reads bill at a reduced rate but occupy the window
 *  at full weight: the model still has to read them. */
export function claudePromptTokensFromRawUsage(raw: RawClaudeUsage): number {
  return (
    (raw.inputTokens ?? 0) +
    (raw.cacheCreationInputTokens ?? 0) +
    (raw.cacheReadInputTokens ?? 0)
  );
}

/** Total tokens processed this turn — input + output + cache read + cache
 *  creation. May exceed `maxTokens` (it's a throughput number, not a window
 *  occupancy number). */
export function totalProcessedTokensFromRawUsage(raw: RawClaudeUsage): number {
  return (
    (raw.inputTokens ?? 0) +
    (raw.outputTokens ?? 0) +
    (raw.cacheReadInputTokens ?? 0) +
    (raw.cacheCreationInputTokens ?? 0)
  );
}

/* ── window resolution (doc §4) ── */

/** Heuristic fallback when the SDK doesn't report a window. Recognizes a 1M
 *  context window from two model-id signals:
 *   - the `[1m]` suffix appended by this app's own `with1MSuffix` when the
 *     active role declares `supports1m` (DeepSeek-style gateways echo the
 *     model id verbatim in `message.model`, so the suffix survives the round
 *     trip); this is also the convention third-party gateways use to advertise
 *     1M context (see docs/claude-context-usage-tracking.md).
 *   - the literal substring `opus` (Opus extended mode advertises 1M).
 *  Everything else ships 200k. */
export function resolveContextWindowHeuristic(
  model?: string,
  configured?: ClaudeContextWindowTag,
): number {
  if (configured === "1m") return CLAUDE_CONTEXT_WINDOW_MAX_TOKENS["1m"];
  if (configured === "200k") return CLAUDE_CONTEXT_WINDOW_MAX_TOKENS["200k"];
  const m = model?.toLowerCase() ?? "";
  if (m.includes("opus") || m.includes("[1m]")) {
    return CLAUDE_CONTEXT_WINDOW_MAX_TOKENS["1m"];
  }
  return CLAUDE_CONTEXT_WINDOW_MAX_TOKENS["200k"];
}

/** Resolve the effective context-window ceiling, honoring the never-downgrade
 *  rule (doc §4): `Math.max(reported, lastKnown)`. A 1M model occasionally
 *  reports 200k transiently — we refuse to shrink once we've seen the larger
 *  value.
 *
 * @param reported   SDK-reported window from `modelUsage[model].contextWindow`
 * @param lastKnown  Last resolved ceiling for this session (adapter state)
 * @param configured User override ("200k" / "1m") — highest precedence */
export function resolveEffectiveContextWindow(opts: {
  model?: string;
  reported?: number;
  lastKnown?: number;
  configured?: ClaudeContextWindowTag;
}): number {
  const { model, reported, lastKnown, configured } = opts;
  const heuristic = resolveContextWindowHeuristic(model, configured);
  return Math.max(
    positiveOrZero(reported),
    positiveOrZero(lastKnown),
    heuristic,
  );
}

/* ── warnings (doc §5) ── */

/** Compute the granular warning kinds triggered by this usage report.
 *  Returns an empty array when nothing is amiss. Thresholds follow doc §5;
 *  the `near-window` check degrades to `maxTokens * 0.8` because path B
 *  (the live `autoCompactThreshold` control channel) is unavailable — see
 *  doc §7.2. */
export function decideClaudeContextUsageWarnings(
  raw: RawClaudeUsage,
  maxTokens: number,
): ContextWarningKind[] {
  const warnings: ContextWarningKind[] = [];
  const promptTokens = claudePromptTokensFromRawUsage(raw);
  const cacheRead = raw.cacheReadInputTokens ?? 0;
  const uncachedInput = (raw.inputTokens ?? 0) + (raw.cacheCreationInputTokens ?? 0);

  // uncached-ingestion: rapid credit burn (fresh session / resume / first
  // turn of a large context).
  const cacheReadRatio = promptTokens > 0 ? cacheRead / promptTokens : 0;
  if (
    uncachedInput > UNCACHED_INGESTION_TOKENS ||
    (promptTokens > PROMPT_FOR_CACHE_CHECK_TOKENS && cacheReadRatio < CACHE_READ_LOW_RATIO)
  ) {
    warnings.push("uncached-ingestion");
  }
  // near-window: approaching the auto-compact budget. Without path B we use
  // the resolved window ceiling as the budget proxy.
  if (promptTokens > maxTokens * NEAR_WINDOW_RATIO) {
    warnings.push("near-window");
  }
  // large-prompt: big contexts accelerate credit consumption.
  if (promptTokens > LARGE_PROMPT_TOKENS) {
    warnings.push("large-prompt");
  }
  return warnings;
}

/* ── normalization (doc §3) ── */

/** Normalize raw per-turn usage into a display-ready snapshot. Returns
 *  `undefined` when there's nothing to report (all token fields 0 / missing),
 *  so the caller can skip emitting — avoids "0 / 200k (0%)" ghost readouts
 *  from proxies / non-Anthropic gateways that zero out usage. */
export function normalizeClaudeTokenUsage(
  raw: RawClaudeUsage,
  opts: {
    reported?: number;
    lastKnown?: number;
    configured?: ClaudeContextWindowTag;
  },
): ContextSnapshot | undefined {
  const totalProcessed = totalProcessedTokensFromRawUsage(raw);
  if (totalProcessed <= 0) return undefined;

  const maxTokens = resolveEffectiveContextWindow({
    model: raw.model,
    reported: opts.reported,
    lastKnown: opts.lastKnown,
    configured: opts.configured,
  });

  // Window occupancy = logical prompt tokens, clamped to the ceiling.
  const usedTokens = Math.min(
    claudePromptTokensFromRawUsage(raw),
    maxTokens,
  );
  const pct = round1(Math.min(100, (usedTokens / maxTokens) * 100));
  const warning: ContextWarning =
    pct >= 90 ? "critical" : pct >= 70 ? "near-window" : "ok";
  const warnings = decideClaudeContextUsageWarnings(raw, maxTokens);

  return {
    usedTokens,
    totalProcessedTokens: totalProcessed,
    maxTokens,
    outputTokens: raw.outputTokens ?? 0,
    cacheReadTokens: raw.cacheReadInputTokens,
    cacheCreationTokens: raw.cacheCreationInputTokens,
    costUsd: raw.costUsd,
    model: raw.model,
    pct,
    warning,
    warnings,
  };
}

/* ── compaction (doc §6) ── */

/** Build a post-compaction snapshot from the SDK's `compact_metadata.
 *  post_tokens`.
 *
 *  Unlike `normalizeClaudeTokenUsage` (which takes raw usage fields and
 *  computes occupancy as `input + cacheCreation + cacheRead`), `post_tokens`
 *  is already the resolved window occupancy after compaction - the SDK did
 *  the math. We only clamp it to the ceiling and recompute pct / warning.
 *
 *  Throughput / cost / cache / output fields are carried over from
 *  `lastKnown` (the pre-compaction snapshot) because compaction doesn't
 *  reset billing counters - it only shrinks what's in the window.
 *
 *  Returns `undefined` when `post_tokens` is missing or zero, so the caller
 *  can skip emitting - avoids a ghost "0 / 200k (0%)" readout when the SDK
 *  doesn't report a post-compact token count. */
export function buildCompactSnapshot(opts: {
  postTokens?: number;
  lastKnown?: ContextSnapshot;
  model?: string;
  configured?: ClaudeContextWindowTag;
}): ContextSnapshot | undefined {
  const { postTokens, lastKnown } = opts;
  if (typeof postTokens !== "number" || postTokens <= 0) return undefined;

  // Preserve the resolved window ceiling (never-downgrade rule). Fall back
  // to the model heuristic when no prior snapshot exists (compaction at the
  // very start of a session - rare but possible).
  const maxTokens = lastKnown?.maxTokens
    ?? resolveEffectiveContextWindow({ model: opts.model, configured: opts.configured });

  const usedTokens = Math.min(postTokens, maxTokens);
  const pct = round1(Math.min(100, (usedTokens / maxTokens) * 100));
  const warning: ContextWarning =
    pct >= 90 ? "critical" : pct >= 70 ? "near-window" : "ok";

  // Recompute granular warnings against the post-compact occupancy. We
  // synthesize a RawClaudeUsage where inputTokens = postTokens (cache fields
  // unset) so the existing threshold logic applies cleanly.
  const warnings = decideClaudeContextUsageWarnings(
    { inputTokens: postTokens },
    maxTokens,
  );

  return {
    usedTokens,
    totalProcessedTokens: lastKnown?.totalProcessedTokens ?? 0,
    maxTokens,
    outputTokens: lastKnown?.outputTokens ?? 0,
    cacheReadTokens: lastKnown?.cacheReadTokens,
    cacheCreationTokens: lastKnown?.cacheCreationTokens,
    costUsd: lastKnown?.costUsd,
    model: opts.model ?? lastKnown?.model,
    pct,
    warning,
    warnings,
  };
}

/* ── path C merge (doc §2 path C) ── */

/** Merge a turn-end accumulated snapshot (from `result.usage`) with the last
 *  known mid-turn snapshot (from path A).
 *
 *  CRITICAL: the SDK's `result.usage` is a **cumulative sum across the whole
 *  run** (suitable for billing), NOT the current context-window occupancy
 *  (see https://code.claude.com/docs/en/agent-sdk/cost-tracking and
 *  claude-agent-sdk-typescript#66). Treating it as occupancy makes the ring
 *  jump up at turn-end and monotonically approach 100%.
 *
 *  So the accumulated snapshot contributes only `totalProcessedTokens`,
 *  `outputTokens`, `cacheReadTokens`, `cacheCreationTokens`, `costUsd`,
 *  `model`, and `maxTokens` (window resolution). `usedTokens` / `pct` /
 *  `warning` come ENTIRELY from `lastKnown` (the most recent path-A window
 *  read) — the accumulated occupancy is ignored on purpose. When no path-A
 *  snapshot exists, the caller should fall back to the accumulated values
 *  directly (better-than-nothing) rather than calling this merge. */
export function mergeClaudeTokenUsageSnapshot(
  lastKnown: ContextSnapshot,
  accumulated: ContextSnapshot,
  maxTokens: number,
): ContextSnapshot {
  // usedTokens = the path-A window read, clamped to the resolved ceiling.
  const usedTokens = Math.min(lastKnown.usedTokens, maxTokens);
  const pct = round1(Math.min(100, (usedTokens / maxTokens) * 100));
  const warning: ContextWarning =
    pct >= 90 ? "critical" : pct >= 70 ? "near-window" : "ok";
  return {
    ...accumulated,
    usedTokens,
    pct,
    warning,
    // Take the union of warnings from both — both are "this turn" signals.
    warnings: dedupeWarnings([...accumulated.warnings, ...lastKnown.warnings]),
  };
}

/* ── helpers ── */

function positiveOrZero(n: number | undefined | null): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}

/** Round to 1 decimal place (e.g. 0.18 -> 0.2, 83.456 -> 83.5). Used for
 *  `pct` so the context ring shows "0.2%" instead of "0%" for small but
 *  non-zero occupancy. */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function dedupeWarnings(ws: ContextWarningKind[]): ContextWarningKind[] {
  return Array.from(new Set(ws));
}

/* ── control-channel snapshot (path B, doc §2 / §7.2) ── */

/** Build a {@link ContextSnapshot} from the SDK's {@link Query.getContextUsage}
 *  control-channel response. This is the most authoritative source for
 *  `usedTokens` / `maxTokens` / `pct` — the CLI reports the live context-
 *  window occupancy directly, without any client-side math.
 *
 *  Throughput / billing fields (`totalProcessedTokens`, `outputTokens`,
 *  `cacheReadTokens`, `cacheCreationTokens`, `costUsd`) are NOT provided by
 *  the control channel — they must come from the accumulated `result.usage`
 *  (see {@link normalizeClaudeTokenUsage} and path C merge).
 *
 *  @param cc       Response from `Query.getContextUsage()`
 *  @param accumulated  Snapshot built from accumulated `result.usage` (path C)
 *                      — only its throughput/billing fields are used here
 *  @returns A complete snapshot with authoritative window occupancy */
export function buildSnapshotFromControlChannel(
  cc: SDKControlGetContextUsageResponse,
  accumulated: ContextSnapshot,
): ContextSnapshot {
  const usedTokens = Math.min(cc.totalTokens, cc.maxTokens);
  const pct = round1(Math.min(100, cc.percentage));
  const warning: ContextWarning =
    pct >= 90 ? "critical" : pct >= 70 ? "near-window" : "ok";

  return {
    usedTokens,
    totalProcessedTokens: accumulated.totalProcessedTokens,
    maxTokens: cc.maxTokens,
    outputTokens: accumulated.outputTokens,
    cacheReadTokens: accumulated.cacheReadTokens,
    cacheCreationTokens: accumulated.cacheCreationTokens,
    costUsd: accumulated.costUsd,
    model: cc.model || accumulated.model,
    pct,
    warning,
    // Control channel doesn't surface warning kinds; carry forward any
    // warnings the accumulated snapshot detected (e.g. large-prompt).
    warnings: accumulated.warnings,
  };
}
