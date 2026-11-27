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
  ContextCategory,
  ContextSnapshot,
  ContextWarning,
  ContextWarningKind,
} from "@contracts/runtime";

import type { ContextCategory, ContextSnapshot, ContextWarning } from "@contracts/runtime";
import { translate, type MessageId } from "@renderer/lib/i18n/core.js";
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

/* ── category breakdown (Claude CLI `/context` parity) ── */

export interface ContextCategorySlice {
  key: string;
  label: string;
  tokens: number;
  pct: number;
  /** Tailwind background class used by both the stacked bar segment and legend dot. */
  barColor: string;
}

export interface ContextCategoryBreakdown {
  /** Active occupied categories, sorted largest-first (excludes free space & autocompact buffer). */
  occupied: ContextCategorySlice[];
  /** Reserved autocompact buffer slice if reported by CLI. */
  buffer: ContextCategorySlice | null;
  /** Remaining free space slice. */
  free: ContextCategorySlice;
  /** Auto-compact trigger threshold as a percentage [0, 100] of maxTokens, if enabled. */
  autoCompactPct: number | null;
}

const FALLBACK_COLORS = [
  "bg-blue-400",
  "bg-orange-400",
  "bg-pink-400",
  "bg-lime-500",
];

function matchCategoryMeta(cat: ContextCategory): {
  role: "occupied" | "buffer" | "free";
  labelKey?: MessageId;
  color: string;
} {
  const probe = `${cat.id ?? ""} ${cat.name}`.toLowerCase();
  if (probe.includes("free space") || probe.includes("free_space")) {
    return { role: "free", labelKey: "chat.context.catFreeSpace", color: "bg-surface-muted" };
  }
  if (probe.includes("autocompact") || probe.includes("auto-compact") || probe.includes("compact buffer")) {
    return { role: "buffer", labelKey: "chat.context.catAutocompact", color: "bg-content-subtle/25" };
  }
  if (probe.includes("system prompt") || probe.includes("system_prompt")) {
    return { role: "occupied", labelKey: "chat.context.catSystemPrompt", color: "bg-indigo-500" };
  }
  if (probe.includes("system tools") || probe.includes("system_tools")) {
    return { role: "occupied", labelKey: "chat.context.catSystemTools", color: "bg-sky-500" };
  }
  if (probe.includes("mcp")) {
    return { role: "occupied", labelKey: "chat.context.catMcpTools", color: "bg-amber-500" };
  }
  if (probe.includes("memory")) {
    return { role: "occupied", labelKey: "chat.context.catMemoryFiles", color: "bg-teal-500" };
  }
  if (probe.includes("skill")) {
    return { role: "occupied", labelKey: "chat.context.catSkills", color: "bg-cyan-500" };
  }
  if (probe.includes("agent")) {
    return { role: "occupied", labelKey: "chat.context.catAgents", color: "bg-rose-500" };
  }
  if (probe.includes("message")) {
    return { role: "occupied", labelKey: "chat.context.catMessages", color: "bg-emerald-500" };
  }
  return { role: "occupied", color: "" };
}

function pctOfWindow(tokens: number, maxTokens: number): number {
  if (maxTokens <= 0 || tokens <= 0) return 0;
  return Math.min(100, Math.round((tokens / maxTokens) * 1000) / 10);
}

/** Build a structured, localized category breakdown from a ContextSnapshot when
 *  Claude CLI reported `categories`. Returns null when no category data is
 *  available so callers can fall back cleanly to aggregate usage. */
export function getContextCategoryBreakdown(
  s: ContextSnapshot,
): ContextCategoryBreakdown | null {
  if (!s.categories || s.categories.length === 0 || s.maxTokens <= 0) return null;
  const locale = useSessionStore.getState().locale;
  const occupied: ContextCategorySlice[] = [];
  let buffer: ContextCategorySlice | null = null;
  let reportedFree: number | null = null;
  let fallbackColorIdx = 0;

  for (let i = 0; i < s.categories.length; i++) {
    const cat = s.categories[i];
    if (cat.isDeferred && cat.tokens <= 0) continue;
    const meta = matchCategoryMeta(cat);
    const label = meta.labelKey ? translate(locale, meta.labelKey) : cat.name;

    if (meta.role === "free") {
      reportedFree = (reportedFree ?? 0) + cat.tokens;
      continue;
    }
    if (meta.role === "buffer") {
      if (cat.tokens > 0) {
        buffer = {
          key: cat.id ?? `buffer-${i}`,
          label,
          tokens: cat.tokens,
          pct: pctOfWindow(cat.tokens, s.maxTokens),
          barColor: meta.color,
        };
      }
      continue;
    }
    if (cat.tokens <= 0) continue;
    const barColor = meta.color || FALLBACK_COLORS[fallbackColorIdx++ % FALLBACK_COLORS.length];
    occupied.push({
      key: cat.id ?? `${cat.name}-${i}`,
      label,
      tokens: cat.tokens,
      pct: pctOfWindow(cat.tokens, s.maxTokens),
      barColor,
    });
  }

  if (occupied.length === 0) return null;
  occupied.sort((a, b) => b.tokens - a.tokens);

  const occupiedSum = occupied.reduce((sum, x) => sum + x.tokens, 0);
  const bufferTokens = buffer?.tokens ?? 0;
  const freeTokens =
    reportedFree !== null
      ? Math.max(0, reportedFree)
      : Math.max(0, s.maxTokens - Math.max(s.usedTokens, occupiedSum) - bufferTokens);

  const autoCompactPct =
    s.isAutoCompactEnabled && typeof s.autoCompactThreshold === "number" && s.autoCompactThreshold > 0
      ? pctOfWindow(s.autoCompactThreshold, s.maxTokens)
      : null;

  return {
    occupied,
    buffer,
    free: {
      key: "free-space",
      label: translate(locale, "chat.context.catFreeSpace"),
      tokens: freeTokens,
      pct: pctOfWindow(freeTokens, s.maxTokens),
      barColor: "bg-surface-muted",
    },
    autoCompactPct,
  };
}
