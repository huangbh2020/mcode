/**
 * Context-window display helpers for the renderer.
 *
 * The normalization math (snapshotFromUsage / resolveContextWindow /
 * isUnknownUsage) moved to the main process —
 * `apps/desktop/src/main/providers/claude-sdk/claudeTokenUsage.ts` — so the
 * provider adapter can emit a provider-neutral `token-usage.updated` event
 * carrying an already-normalized {@link ContextSnapshot}. The renderer no
 * longer touches raw token fields; it only stores snapshots and renders them.
 *
 * This module re-exports the shared snapshot types from `@contracts/runtime`
 * (so renderer components import from one place) and keeps the few genuinely
 * renderer-side concerns: token-count formatting and warning → color mapping.
 */
export type {
  ContextSnapshot,
  ContextWarning,
  ContextWarningKind,
} from "@contracts/runtime";

import type { ContextSnapshot, ContextWarning } from "@contracts/runtime";
import { translate } from "@renderer/lib/i18n/core.js";
// Cycle note: sessionStore imports this module (isValidSnapshot). Importing the
// store back is safe because the only access (`getState()`) happens inside a
// function body — never during module evaluation — so neither side of the
// cycle observes the other's TDZ.
import { useSessionStore } from "@renderer/stores/sessionStore.js";

/**
 * Validate that a persisted/received snapshot has the full post-refactor
 * shape. Pre-refactor `context_snapshot` rows stored the raw-usage object
 * (`{inputTokens, outputTokens, costUsd, ...}`) without `usedTokens` /
 * `maxTokens` / `pct` / `warning` / `warnings` — feeding those to the
 * ContextRing / StatusBar crashes (NaN strokeDashoffset, undefined.length).
 * Drop such stale snapshots and let the next emit overwrite. */
export function isValidSnapshot(s: unknown): s is ContextSnapshot {
  if (!s || typeof s !== "object") return false;
  const o = s as Record<string, unknown>;
  return (
    typeof o.usedTokens === "number" &&
    typeof o.maxTokens === "number" &&
    typeof o.pct === "number" &&
    (o.warning === "ok" || o.warning === "near-window" || o.warning === "critical") &&
    Array.isArray(o.warnings)
  );
}

/* ── formatting ── */

/** Compact token count: 1234 → "1.2k", 1_500_000 → "1.5M". */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/* ── warning → tailwind text color ── */

/** Status-bar chip color for a context-warning level.
 *  ok → neutral zinc, near-window → amber, critical → red. */
export function warningColor(w: ContextWarning): string {
  if (w === "critical") return "text-danger";
  if (w === "near-window") return "text-warning";
  return "text-content-muted";
}

/* ── breakdown for rich tooltips ── */

/** One row in the context-usage hover card. */
export interface ContextBreakdownRow {
  key: string;
  label: string;
  value: string;
  /** Optional muted secondary value (e.g. unit). */
  hint?: string;
}

/** Cache-hit percentage with one decimal ("82.4%"); "—" when the prompt
 *  denominator is 0/unknown (gateway sent no usage). */
export function fmtCacheHitRate(cacheRead: number, promptTokens: number): string {
  if (promptTokens <= 0) return "—";
  return `${Math.round((cacheRead / promptTokens) * 1000) / 10}%`;
}

/**
 * Structured token breakdown shared by ContextRing and StatusCapsule.
 * Keeps both surfaces in sync and avoids duplicating the fresh-input math.
 */
export function getContextBreakdown(s: ContextSnapshot): {
  title: string;
  subtitle: string;
  rows: ContextBreakdownRow[];
} {
  const locale = useSessionStore.getState().locale;
  const cacheRead = s.cacheReadTokens ?? 0;
  const cacheCreation = s.cacheCreationTokens ?? 0;
  // Fresh input must stay on the throughput basis (totalProcessed - output -
  // cache read - cache write), the same formula as the history table and
  // turnFlowModel.usageInputTokens. Subtracting the cache fields from
  // `usedTokens` instead mixes bases — usedTokens is a single window read
  // while they are run-cumulative (whole turn on Claude, whole session on
  // Pi) — and clamps to 0 on any cached multi-step turn.
  const freshInput = Math.max(
    0,
    s.totalProcessedTokens - s.outputTokens - cacheRead - cacheCreation,
  );
  // Hit-rate denominator = totalProcessed - output (input + cache read +
  // cache write), the same cumulative basis as cacheRead itself. usedTokens
  // would be wrong here: in merged snapshots it is a path-A window read while
  // cacheRead is run-cumulative, so the ratio could exceed 100%.
  const promptVolume = Math.max(0, s.totalProcessedTokens - s.outputTokens);
  const rows: ContextBreakdownRow[] = [
    { key: "input", label: translate(locale, "lib.context.input"), value: fmtTokens(freshInput) },
    { key: "cache-read", label: translate(locale, "lib.context.cacheRead"), value: fmtTokens(cacheRead) },
    { key: "cache-hit", label: translate(locale, "lib.context.cacheHit"), value: fmtCacheHitRate(cacheRead, promptVolume) },
    { key: "output", label: translate(locale, "lib.context.output"), value: fmtTokens(s.outputTokens) },
    {
      key: "processed",
      label: translate(locale, "lib.context.processed"),
      value: fmtTokens(s.totalProcessedTokens),
    },
  ];
  return {
    title: translate(locale, "lib.context.title"),
    subtitle: `${fmtTokens(s.usedTokens)} / ${fmtTokens(s.maxTokens)} · ${s.pct}%`,
    rows,
  };
}
