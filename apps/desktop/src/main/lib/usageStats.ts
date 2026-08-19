/**
 * Cross-session usage aggregation for the settings "用量统计" panel.
 *
 * Source of truth is the per-turn usage history persisted on each session row
 * (`sessions.usage_history`, one TurnUsageRecord per completed turn, appended
 * by RuntimeManager at turn.done). This module normalizes those records and
 * aggregates them into the summary / per-model / per-day shapes the panel
 * renders.
 *
 * Provider accounting nuance (critical for correctness):
 *  - Claude sessions (provider_id "claude-sdk"): the SDK's `result.usage` is
 *    cumulative across ONE query (= one turn), so each record is already a
 *    per-turn value and records can be summed directly.
 *  - Pi sessions (provider_id "pi-sdk"): throughput/cost fields come from
 *    `session.getSessionStats()`, which is cumulative ACROSS the whole session
 *    (piTokenUsage.ts). Summing raw records would multiply-count earlier turns,
 *    so we take adjacent differences per session (records sorted by endedAt).
 *    A stats reset (never observed — Pi keeps compacted history in the totals)
 *    would surface as a negative diff, clamped to 0 by the differ.
 *
 * `usedTokens` (context-window occupancy) is intentionally NOT part of usage
 * stats — it measures window state, not consumption.
 */
import type {
  UsageDayStat,
  UsageModelStat,
  UsageStatsPreset,
  UsageStatsResult,
  UsageSummaryStat,
} from "@contracts/ipc";
import type { TurnUsageRecord } from "@contracts/runtime";
import { SessionRepo } from "../store/repositories.js";
import { CustomModelStore } from "./secretStore.js";

/** Heatmap span: 53 weeks (366 days, today inclusive) — a full year, so the
 *  month-label row walks through all twelve months instead of a half-year. */
export const HEATMAP_DAYS = 366;

const PI_PROVIDER_ID = "pi-sdk";

/** Vendor label for the built-in Claude path (no custom-model binding). Kept
 *  as a stable identifier — a proper noun, not translated. */
const ANTHROPIC_VENDOR = "Anthropic";
/** Vendor label for Pi-agent sessions: the Pi platform hosts the model either
 *  locally or through the user's own provider config, which the record does
 *  not expose, so Pi is the coarsest honest grouping. */
const PI_VENDOR = "Pi";

/** Per-turn usage after provider normalization. */
interface NormalizedTurn {
  sessionId: string;
  endedAt: number;
  /** Vendor/endpoint the turn ran under (null = unknown). */
  vendor: string | null;
  model: string | null;
  totalTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** null = unknown for this turn (provider reported no cost). */
  costUsd: number | null;
}

/** Separator for the (vendor, model) grouping key — safe even when a model
 *  name literally contains a null byte (it can't). */
const GROUP_SEP = "\u0000";

/** Module-level cache of the normalized records. Invalidated whenever a turn
 *  appends to any session's usage history (see invalidateUsageStats). */
let cache: NormalizedTurn[] | null = null;

/** Drop the cached aggregation input. Called after SessionRepo.updateUsageHistory
 *  so the next `usage.stats` request sees fresh data. Cheap and synchronous. */
export function invalidateUsageStats(): void {
  cache = null;
}

/** Local calendar day as YYYY-MM-DD. "Today" must be the user's today, so
 *  UTC-based formatting (toISOString) is deliberately avoided. */
function localDateKey(ms: number): string {
  const d = new Date(ms);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Local midnight of the calendar day `days` away from today (negative = past).
 *  Built via the Date constructor so DST shifts can't drift the boundary. */
function localMidnightOffset(days: number): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + days).getTime();
}

function rangeStart(preset: UsageStatsPreset): number {
  switch (preset) {
    case "today":
      return localMidnightOffset(0);
    case "7d":
      return localMidnightOffset(-6);
    case "30d":
      return localMidnightOffset(-29);
    case "all":
      return 0;
  }
}

function finiteNum(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

/** Adjacent difference for a monotonically-growing cumulative counter.
 *  No baseline yet (first record) → the value itself is the increment; no
 *  current value → unknown (null). */
function diffCumulative(prev: number | null, cur: number | null): number | null {
  if (cur == null) return null;
  if (prev == null) return Math.max(0, cur);
  return Math.max(0, cur - prev);
}

/** Vendor label for one session's records:
 *  - Pi sessions → "Pi" (the record carries no provider info beyond that).
 *  - Claude sessions bound to a custom-model config → the config's user-chosen
 *    name (that name IS the user's mental "vendor" — e.g. "浩联云", "ds",
 *    "opencode", "智谱"). null when the binding config no longer exists.
 *  - Claude sessions on the built-in path → "Anthropic". */
function vendorFor(
  providerId: string,
  customModelId: string | null,
  nameById: Map<string, string>,
): string | null {
  if (providerId === PI_PROVIDER_ID) return PI_VENDOR;
  if (customModelId) return nameById.get(customModelId) ?? null;
  return ANTHROPIC_VENDOR;
}

function loadTurnRecords(): NormalizedTurn[] {
  if (cache) return cache;
  const nameById = new Map(
    CustomModelStore.listPublic().map((m) => [m.id, m.name]),
  );
  const out: NormalizedTurn[] = [];
  for (const row of SessionRepo.listUsageRows()) {
    const cumulative = row.providerId === PI_PROVIDER_ID;
    const vendor = vendorFor(row.providerId, row.customModelId, nameById);
    const records = [...row.usageHistory].sort((a, b) => a.endedAt - b.endedAt);
    let prev: TurnUsageRecord | null = null;
    for (const r of records) {
      const endedAt = finiteNum(r.endedAt);
      if (endedAt == null) continue;
      if (cumulative) {
        out.push({
          sessionId: row.id,
          endedAt,
          vendor,
          model: r.model ?? null,
          totalTokens: diffCumulative(finiteNum(prev?.totalProcessedTokens), finiteNum(r.totalProcessedTokens)) ?? 0,
          outputTokens: diffCumulative(finiteNum(prev?.outputTokens), finiteNum(r.outputTokens)) ?? 0,
          cacheReadTokens: diffCumulative(finiteNum(prev?.cacheReadTokens), finiteNum(r.cacheReadTokens)) ?? 0,
          cacheCreationTokens: diffCumulative(finiteNum(prev?.cacheCreationTokens), finiteNum(r.cacheCreationTokens)) ?? 0,
          costUsd: diffCumulative(finiteNum(prev?.costUsd), finiteNum(r.costUsd)),
        });
      } else {
        out.push({
          sessionId: row.id,
          endedAt,
          vendor,
          model: r.model ?? null,
          totalTokens: Math.max(0, finiteNum(r.totalProcessedTokens) ?? 0),
          outputTokens: Math.max(0, finiteNum(r.outputTokens) ?? 0),
          cacheReadTokens: Math.max(0, finiteNum(r.cacheReadTokens) ?? 0),
          cacheCreationTokens: Math.max(0, finiteNum(r.cacheCreationTokens) ?? 0),
          costUsd: finiteNum(r.costUsd),
        });
      }
      prev = r;
    }
  }
  cache = out;
  return out;
}

export function buildUsageStats(preset: UsageStatsPreset): UsageStatsResult {
  const records = loadTurnRecords();

  // ── daily heatmap buckets: fixed 366-day (full-year) window regardless of preset ──
  const daily: UsageDayStat[] = [];
  const dayMap = new Map<string, UsageDayStat>();
  for (let i = HEATMAP_DAYS - 1; i >= 0; i--) {
    const stat: UsageDayStat = {
      date: localDateKey(localMidnightOffset(-i)),
      turns: 0,
      totalTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    };
    daily.push(stat);
    dayMap.set(stat.date, stat);
  }
  for (const r of records) {
    const stat = dayMap.get(localDateKey(r.endedAt));
    if (!stat) continue; // older than the heatmap window
    stat.turns += 1;
    stat.totalTokens += r.totalTokens;
    stat.outputTokens += r.outputTokens;
    if (r.costUsd != null) stat.costUsd += r.costUsd;
  }

  // ── summary + per-model over the selected preset range ──
  const from = rangeStart(preset);
  const summary: UsageSummaryStat = {
    turns: 0,
    sessions: 0,
    totalTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
  };
  const sessionIds = new Set<string>();
  const modelMap = new Map<string, UsageModelStat>();
  for (const r of records) {
    if (r.endedAt < from) continue;
    summary.turns += 1;
    sessionIds.add(r.sessionId);
    summary.totalTokens += r.totalTokens;
    summary.outputTokens += r.outputTokens;
    summary.cacheReadTokens += r.cacheReadTokens;
    summary.cacheCreationTokens += r.cacheCreationTokens;
    if (r.costUsd != null) summary.costUsd += r.costUsd;

    // Group by (vendor, model): identical model names from different vendors
    // must not merge into one bar.
    const groupKey = `${r.vendor ?? ""}${GROUP_SEP}${r.model ?? ""}`;
    let m = modelMap.get(groupKey);
    if (!m) {
      m = {
        vendor: r.vendor,
        model: r.model,
        turns: 0,
        totalTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
      };
      modelMap.set(groupKey, m);
    }
    m.turns += 1;
    m.totalTokens += r.totalTokens;
    m.outputTokens += r.outputTokens;
    m.cacheReadTokens += r.cacheReadTokens;
    m.cacheCreationTokens += r.cacheCreationTokens;
    if (r.costUsd != null) m.costUsd += r.costUsd;
  }
  summary.sessions = sessionIds.size;
  const models = [...modelMap.values()].sort(
    (a, b) => b.totalTokens - a.totalTokens || b.turns - a.turns,
  );

  return { summary, models, daily };
}
