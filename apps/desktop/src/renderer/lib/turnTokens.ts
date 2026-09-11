/**
 * Per-turn token lookup for the running-ledger receipt.
 *
 * The receipt shows what ONE turn consumed, but the persisted usage history is
 * not uniformly per-turn: Pi sessions store session-CUMULATIVE counters in
 * each record, so the per-turn figure is the DELTA against the previous record
 * of the same session. That normalization lives in the main process
 * (main/lib/usageStats.ts rotates it out for the usage panel); the renderer
 * needs the same rule to label an individual turn, so it is implemented here as
 * a pure function and covered by the smoke script.
 *
 * IMPORTANT: keep the `cumulative` rule in sync with usageStats.ts — if a
 * provider starts/​stops reporting cumulative counters there, this must follow.
 */

/** Minimal shape needed from a TurnUsageRecord (kept structural so this module
 *  stays free of contracts imports and is trivially testable). */
export interface TurnUsageLike {
  endedAt: number;
  totalProcessedTokens?: number;
}

/** Token count for the turn that ended at `endedAt`, or null when the session's
 *  history has no record for that turn yet (the turn-end snapshot lands a beat
 *  after turn.done — the receipt simply renders without tokens until then).
 *
 *  `cumulative` must be true for providers whose records carry session-running
 *  counters (Pi); the previous record is found by endedAt order, so a
 *  non-monotonic history can't produce a negative number. */
export function turnTokenUsage(
  history: readonly TurnUsageLike[] | undefined,
  endedAt: number | undefined,
  cumulative: boolean,
): number | null {
  if (!history || history.length === 0 || endedAt === undefined) return null;
  const target = history.find((r) => r.endedAt === endedAt);
  if (!target) return null;
  const cur = target.totalProcessedTokens;
  if (typeof cur !== "number" || !Number.isFinite(cur)) return null;
  if (!cumulative) return Math.max(0, cur);
  // Cumulative provider: subtract the newest record that ended BEFORE this one.
  let prevEnded = Number.NEGATIVE_INFINITY;
  let prevValue: number | undefined;
  for (const r of history) {
    if (r.endedAt >= endedAt || r.endedAt <= prevEnded) continue;
    prevEnded = r.endedAt;
    prevValue = r.totalProcessedTokens;
  }
  if (typeof prevValue !== "number" || !Number.isFinite(prevValue)) return Math.max(0, cur);
  return Math.max(0, cur - prevValue);
}

/** Providers whose usage records carry session-cumulative counters (mirrors
 *  `PI_PROVIDER_ID` in main/lib/usageStats.ts). */
export const CUMULATIVE_USAGE_PROVIDER_IDS: ReadonlySet<string> = new Set(["pi-sdk"]);
