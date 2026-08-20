/**
 * UsagePanel — 设置页「用量统计」面板。
 *
 * Aggregates the per-turn usage history persisted on session rows into three
 * views (data computed in main by lib/usageStats.ts, provider accounting
 * already normalized — Pi sessions are cumulative and get diffed there):
 *   1. Summary cards over the selected time range (turns / sessions /
 *      tokens breakdown).
 *   2. A fixed full-year (53-week) GitHub-style daily heatmap; days outside
 *      the selected range are dimmed so the range choice reads on the grid.
 *   3. A per-model ranking with proportional bars.
 *
 * Charts are hand-rolled (no chart lib in the project): the heatmap is a
 * column-flow CSS grid, the model bars reuse the AboutPanel progress-bar
 * pattern, colors are accent-alpha tiers over semantic tokens.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  type UsageDayStat,
  type UsageStatsPreset,
  type UsageStatsResult,
} from "@contracts/ipc";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { fmtTokens } from "@renderer/lib/contextWindow.js";
import { Button, Card } from "@renderer/components/ui/index.js";
import { IconChartBar, IconLoader2 } from "@renderer/lib/icons.js";
import { PanelHeader } from "./PanelHeader.js";
import { SettingsSection } from "./SettingsSection.js";

const PRESETS: Array<{ id: UsageStatsPreset; labelKey: MessageId }> = [
  { id: "today", labelKey: "settings.usage.range.today" },
  { id: "7d", labelKey: "settings.usage.range.sevenDays" },
  { id: "30d", labelKey: "settings.usage.range.thirtyDays" },
  { id: "all", labelKey: "settings.usage.range.all" },
];

/** Heatmap geometry: cells are square via aspect-square and columns are 1fr,
 *  so the grid stretches to fill the available width; the fixed 3px gap (not
 *  em) keeps spacing stable across font-size settings. */

const MONTHS_EN = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Inclusive start date key (local YYYY-MM-DD) of a preset range, mirroring
 *  main's rangeStart(). null = no lower bound ("all"). */
function rangeStartKey(preset: UsageStatsPreset): string | null {
  if (preset === "all") return null;
  const days = preset === "today" ? 0 : preset === "7d" ? 6 : 29;
  const d = new Date();
  d.setDate(d.getDate() - days);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 5-tier accent-alpha ramp relative to the window's busiest day. */
function heatClass(value: number, max: number): string {
  if (value <= 0 || max <= 0) return "bg-surface-muted";
  const ratio = value / max;
  if (ratio <= 0.25) return "bg-accent/25";
  if (ratio <= 0.5) return "bg-accent/45";
  if (ratio <= 0.75) return "bg-accent/70";
  return "bg-accent";
}

/** Parse a local YYYY-MM-DD key into a Date (a bare "YYYY-MM-DD" string would
 *  be parsed as UTC and shift the weekday in non-UTC timezones). */
function parseDateKey(key: string): Date {
  return new Date(`${key}T00:00:00`);
}

export function UsagePanel() {
  const { t } = useI18n();
  const locale = useSessionStore((s) => s.locale);

  const [preset, setPreset] = useState<UsageStatsPreset>("7d");
  const [result, setResult] = useState<UsageStatsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── shared cell tooltip: one div for the whole grid (366 per-cell Tooltip
  //    instances would be heavy and flicker between adjacent cells). Position
  //    is cell-relative to the grid wrapper; shown instantly on hover.
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const heatWrapRef = useRef<HTMLDivElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);

  // Keep the centered tooltip inside the wrapper so first/last columns don't
  // overflow the panel. Direct style write pre-paint — no visible jump.
  useLayoutEffect(() => {
    const el = tipRef.current;
    const wrap = heatWrapRef.current;
    if (!tip || !el || !wrap) return;
    const half = el.offsetWidth / 2;
    const max = Math.max(half + 4, wrap.clientWidth - half - 4);
    el.style.left = `${Math.min(Math.max(tip.x, half + 4), max)}px`;
  }, [tip]);

  const load = useCallback(async (p: UsageStatsPreset) => {
    setLoading(true);
    try {
      const res = await api.usage.stats({ preset: p });
      setResult(res);
      setError(null);
    } catch (err) {
      console.error("UsagePanel load failed:", err);
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(preset);
  }, [load, preset]);

  const daily = result?.daily ?? [];
  const summary = result?.summary;
  const models = useMemo(() => result?.models ?? [], [result]);

  // ── heatmap geometry: pad the first column so day 1 lands on its weekday ──
  const { cells, weeks, monthLabels, dailyMax } = useMemo(() => {
    const dailyStats: UsageDayStat[] = daily;
    const empty = { cells: [] as Array<UsageDayStat | null>, weeks: [] as Array<Array<UsageDayStat | null>>[], monthLabels: [] as Array<string | null>, dailyMax: 0 };
    if (dailyStats.length === 0) return empty;

    let max = 0;
    for (const d of dailyStats) if (d.totalTokens > max) max = d.totalTokens;

    // Monday-based weekday index (Mon=0 … Sun=6); leading nulls align the
    // first real day to its row inside the first grid column.
    const firstDow = (parseDateKey(dailyStats[0].date).getDay() + 6) % 7;
    const cells: Array<UsageDayStat | null> = [
      ...Array.from({ length: firstDow }, () => null),
      ...dailyStats,
    ];
    while (cells.length % 7 !== 0) cells.push(null);

    const weeks: Array<Array<UsageDayStat | null>> = [];
    for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

    const monthLabels: Array<string | null> = weeks.map((week, i) => {
      const first = week.find((c) => c != null);
      if (!first) return null;
      const month = parseDateKey(first.date).getMonth();
      const prevWeek = i > 0 ? weeks[i - 1].find((c) => c != null) : undefined;
      const prevMonth = prevWeek ? parseDateKey(prevWeek.date).getMonth() : null;
      if (prevMonth === month) return null;
      return locale === "zh" ? `${month + 1}月` : MONTHS_EN[month];
    });

    return { cells, weeks, monthLabels, dailyMax: max };
  }, [daily, locale]);

  const startKey = rangeStartKey(preset);
  const modelMax = models.length > 0 ? models[0].totalTokens : 0;

  const summaryItems: Array<{ key: string; label: string; value: string }> = summary
    ? [
        { key: "turns", label: t("settings.usage.summary.turns"), value: summary.turns.toLocaleString() },
        { key: "sessions", label: t("settings.usage.summary.sessions"), value: summary.sessions.toLocaleString() },
        { key: "totalTokens", label: t("settings.usage.summary.totalTokens"), value: fmtTokens(summary.totalTokens) },
        { key: "outputTokens", label: t("settings.usage.summary.outputTokens"), value: fmtTokens(summary.outputTokens) },
        { key: "cacheRead", label: t("settings.usage.summary.cacheRead"), value: fmtTokens(summary.cacheReadTokens) },
        { key: "cacheWrite", label: t("settings.usage.summary.cacheWrite"), value: fmtTokens(summary.cacheCreationTokens) },
      ]
    : [];

  return (
    // Constrained width + centered (same pattern as LspLanguagesPanel):
    // the 53-week heatmap stretches by 1fr columns, so at full panel width
    // the cells grow huge — max-w-3xl keeps them GitHub-sized.
    <section className="mx-auto w-full max-w-3xl space-y-4">
      <PanelHeader
        title={t("settings.usage.title")}
        icon={IconChartBar}
        desc={t("settings.usage.desc")}
        action={
          <div className="flex flex-wrap gap-1">
            {PRESETS.map((p) => (
              <Button
                key={p.id}
                size="sm"
                variant={p.id === preset ? "primary" : "secondary"}
                onClick={() => setPreset(p.id)}
                disabled={loading}
              >
                {t(p.labelKey)}
              </Button>
            ))}
          </div>
        }
      />

      {error && (
        <div className="rounded border border-danger/40 bg-danger/5 px-3 py-2 text-[0.7857em] text-danger">
          {error}
        </div>
      )}

      {loading && !result ? (
        <div className="flex items-center justify-center gap-2 py-10 text-[0.7857em] text-content-subtle">
          <IconLoader2 size={14} className="animate-spin" />
          {t("common.loading")}
        </div>
      ) : (
        <>
          {/* ───────── 区间汇总 ───────── */}
          <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
            {summaryItems.map((item) => (
              <Card key={item.key} className="px-3 py-2.5">
                <div className="text-[0.7143em] text-content-subtle">{item.label}</div>
                <div className="mt-0.5 text-[1.2em] font-semibold tabular-nums leading-relaxed text-content">
                  {item.value}
                </div>
              </Card>
            ))}
          </div>

          {/* ───────── 每日热力图 ───────── */}
          <SettingsSection title={t("settings.usage.heatmap.title")}>
            <div className="px-4 py-3">
              {cells.length === 0 ? (
                <div className="py-4 text-center text-[0.7143em] text-content-subtle">
                  {t("common.loading")}
                </div>
              ) : (
                <div className="flex w-full gap-1.5">
                  {/* weekday labels — h/gap mirror the cell grid so rows align */}
                  <div
                    className="grid shrink-0 gap-[3px] pt-[17px]"
                    style={{ gridTemplateRows: "repeat(7, minmax(0, 1fr))" }}
                  >
                    {[0, 1, 2, 3, 4, 5, 6].map((row) => (
                      <span
                        key={row}
                        className="flex items-center text-[9px] leading-none text-content-subtle"
                      >
                        {row === 0
                          ? t("settings.usage.heatmap.weekdayMon")
                          : row === 3
                            ? t("settings.usage.heatmap.weekdayThu")
                            : ""}
                      </span>
                    ))}
                  </div>
                  <div ref={heatWrapRef} className="relative min-w-0 flex-1">
                    {/* month labels — one span per week column (same 1fr track
                        sizing as the cell grid), first week of each month
                        carries the label */}
                    <div
                      className="mb-[3px] grid h-[14px] gap-[3px]"
                      style={{ gridTemplateColumns: `repeat(${weeks.length}, minmax(0, 1fr))` }}
                    >
                      {weeks.map((_, i) => (
                        <span
                          key={i}
                          className="whitespace-nowrap text-[9px] leading-none text-content-subtle"
                        >
                          {monthLabels[i] ?? ""}
                        </span>
                      ))}
                    </div>
                    {/* grid-flow-col needs the explicit 7-row template to wrap
                        into the next week column — without it every cell lands
                        in one endless vertical column */}
                    <div
                      className="grid w-full grid-flow-col gap-[3px]"
                      style={{
                        gridTemplateRows: "repeat(7, auto)",
                        gridTemplateColumns: `repeat(${weeks.length}, minmax(0, 1fr))`,
                      }}
                    >
                      {cells.map((cell, i) =>
                        cell == null ? (
                          <span key={i} className="aspect-square" />
                        ) : (
                          <span
                            key={i}
                            onMouseEnter={(e) => {
                              const wrap = heatWrapRef.current;
                              if (!wrap) return;
                              const r = e.currentTarget.getBoundingClientRect();
                              const w = wrap.getBoundingClientRect();
                              setTip({
                                x: r.left + r.width / 2 - w.left,
                                y: r.top - w.top,
                                text: t("settings.usage.cellTip", {
                                  date: cell.date,
                                  turns: cell.turns.toLocaleString(),
                                  tokens: cell.totalTokens.toLocaleString(),
                                }),
                              });
                            }}
                            onMouseLeave={() => setTip(null)}
                            className={cn(
                              "aspect-square cursor-pointer rounded-[3px] transition-opacity",
                              heatClass(cell.totalTokens, dailyMax),
                              startKey && cell.date < startKey && "opacity-25",
                            )}
                          />
                        ),
                      )}
                    </div>
                    {tip && (
                      <div
                        ref={tipRef}
                        className="pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md border border-edge bg-surface px-2.5 py-1.5 text-[11px] text-content shadow-lg"
                        style={{ left: tip.x, top: tip.y - 6 }}
                      >
                        {tip.text}
                      </div>
                    )}
                  </div>
                </div>
              )}
              <div className="mt-3 flex items-center justify-end gap-1 text-[0.7143em] text-content-subtle">
                {t("settings.usage.heatmap.less")}
                <span className="h-3 w-3 rounded-[3px] bg-surface-muted" />
                <span className="h-3 w-3 rounded-[3px] bg-accent/25" />
                <span className="h-3 w-3 rounded-[3px] bg-accent/45" />
                <span className="h-3 w-3 rounded-[3px] bg-accent/70" />
                <span className="h-3 w-3 rounded-[3px] bg-accent" />
                {t("settings.usage.heatmap.more")}
              </div>
            </div>
          </SettingsSection>

          {/* ───────── 模型用量 ───────── */}
          <SettingsSection title={t("settings.usage.models.title")}>
            {models.length === 0 ? (
              <div className="px-4 py-4 text-center text-[0.7143em] leading-relaxed text-content-subtle">
                {t("settings.usage.empty")}
              </div>
            ) : (
              models.map((m) => {
                const vendor = m.vendor ?? t("settings.usage.unknownVendor");
                const name = m.model ?? t("settings.usage.unknownModel");
                const title = `${vendor} · ${name}`;
                const pct = modelMax > 0 ? Math.max(2, (m.totalTokens / modelMax) * 100) : 0;
                return (
                  <div key={`${vendor}\u0000${name}`} className="px-4 py-3">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="truncate text-[0.8571em] font-medium text-content" title={title}>
                        <span className="mr-1.5 inline-flex translate-y-[-1px] rounded bg-surface-muted px-1 py-px align-baseline text-[0.8em] font-normal text-content-muted">
                          {vendor}
                        </span>
                        {name}
                      </span>
                      <span className="shrink-0 text-[0.7857em] tabular-nums text-content-muted">
                        {fmtTokens(m.totalTokens)} {t("settings.usage.models.tokens")}
                        {" · "}
                        {m.turns.toLocaleString()} {t("settings.usage.models.turns")}
                      </span>
                    </div>
                    <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-surface-muted">
                      <div
                        className="h-full rounded-full bg-accent transition-[width] duration-150 ease-out"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })
            )}
          </SettingsSection>
        </>
      )}
    </section>
  );
}
