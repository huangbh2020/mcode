/**
 * Context-stats popover anchored above the ContextRing in the composer row.
 *
 * Two stacked views toggled by an in-component `view` state (no second
 * popover layer):
 *
 *  - **current**: reuses {@link ContextTooltipBody} for the live breakdown of
 *    the active session's context window, plus a trailing "history" affordance
 *    that switches to the history view.
 *  - **history**: a compact, scrollable table of every finalized turn in this
 *    session — one row per turn with tokens / cost / duration / model, and a
 *    totals row at the bottom. No back button: once here the popover just
 *    closes on outside click / blur (transparent backdrop) rather than
 *    returning to the current view.
 *
 * Which view the popover opens on is set by `initialView` (default "current").
 * The ContextRing hover tooltip's "查看详情" affordance passes "history" so
 * it jumps straight to the per-turn table — the live breakdown is already
 * what the tooltip just showed, so a redundant first screen is skipped.
 *
 * The data source is the store's `usageHistoryBySession` map (append-only,
 * per session, ephemeral — a restart starts empty, so the empty-state hint
 * guides the user). The panel renders through a portal to <body> with fixed
 * positioning anchored to the ring's captured rect — the composer card's
 * overflow-hidden would otherwise clip an in-flow absolutely positioned
 * panel (same reason the thinking-level dropdown portals via Menu.Portal).
 * It pops above the ring, flipping below when there's no room; a transparent
 * fixed backdrop handles outside-click dismissal.
 */
import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { fmtCacheHitRate, fmtTokens, getContextBreakdown, warningColor } from "@renderer/lib/contextWindow.js";
import type { ContextSnapshot, TurnUsageRecord } from "@contracts/runtime";
import { ContextTooltipBody } from "./ContextRing.js";
import { IconCalendarStats, IconChartBar, IconClock } from "@renderer/lib/icons.js";
import { useSuppressBrowserView } from "@renderer/hooks/useSuppressBrowserView.js";

type View = "current" | "history";

export function ContextStatsPopover({
  snapshot,
  history,
  maxTokens,
  anchorRect,
  onClose,
  initialView = "current",
}: {
  snapshot: ContextSnapshot;
  history: TurnUsageRecord[];
  /** Current window ceiling, used to render each history row's occupancy %.
   *  Passed down from the live snapshot since history rows don't carry it. */
  maxTokens: number;
  /** Bounding box of the ContextRing that opened this popover, in viewport
   *  coordinates (getBoundingClientRect). Drives the fixed positioning. */
  anchorRect: DOMRect;
  onClose: () => void;
  /** Which view the popover opens on. The ContextRing hover tooltip's
   *  "查看详情" affordance passes "history" so it jumps straight to the
   *  per-turn table (the live breakdown is already what the tooltip showed),
   *  avoiding a redundant first screen. Defaults to "current". */
  initialView?: View;
}) {
  // This popover is only mounted while open (parent gates `open && anchorRect`),
  // so a constant-true suppression suppresses the browser view for its whole
  // lifetime — the portaled panel can otherwise be covered by the OS-level view
  // in narrow/wide layouts.
  useSuppressBrowserView(true);
  const [view, setView] = useState<View>(initialView);
  const breakdown = getContextBreakdown(snapshot);
  const panelRef = useRef<HTMLDivElement>(null);
  // Whether the panel has room to sit ABOVE the ring; falls back to below.
  // Computed after first measure so we can read the panel's own height.
  const [placeAbove, setPlaceAbove] = useState(true);

  // Measure once mounted and decide above/below. Also re-check on resize so
  // a window shrink doesn't leave the panel overflowing the top edge.
  useLayoutEffect(() => {
    const recompute = () => {
      const el = panelRef.current;
      if (!el) return;
      // 4px gap between panel and ring (mirrors the old mb-1).
      setPlaceAbove(anchorRect.top - 4 - el.offsetHeight >= 0);
    };
    recompute();
    window.addEventListener("resize", recompute);
    return () => window.removeEventListener("resize", recompute);
  }, [anchorRect.top]);

  // Fixed positioning relative to the viewport (portaled to <body> so the
  // composer card's overflow-hidden can't clip the panel — the same reason
  // the thinking-level dropdown portals through Menu.Portal). Right-align to
  // the ring's right edge; clamp the left so a wide panel never overflows
  // the viewport. Vertically: sit just above (or below) the ring.
  const right = window.innerWidth - anchorRect.right;
  const style: React.CSSProperties = {
    position: "fixed",
    right: Math.max(right, 8),
    // When right-clamped (panel wider than the space on the right), switch
    // to a left anchor so it stays on screen.
    ...(right < 8 ? { left: 8, right: "auto" as const } : {}),
    ...(placeAbove
      ? { bottom: window.innerHeight - anchorRect.top + 4 }
      : { top: anchorRect.bottom + 4 }),
  };

  return createPortal(
    <>
      {/* Fixed full-screen backdrop: clicking anywhere outside closes. Sits
          below the panel (z-40) so the panel (z-50) still receives clicks. */}
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        ref={panelRef}
        style={style}
        className={cn(
          "z-50 w-[380px] max-w-[calc(100vw-16px)]",
          "overflow-hidden rounded-lg border border-edge bg-surface shadow-2xl",
        )}
        // Stop-click so interacting with the panel doesn't hit the backdrop.
        onClick={(e) => e.stopPropagation()}
      >
        {view === "current" ? (
          <CurrentView
            snapshot={snapshot}
            breakdown={breakdown}
            historyCount={history.length}
            onShowHistory={() => setView("history")}
          />
        ) : (
          <HistoryView history={history} maxTokens={maxTokens} />
        )}
      </div>
    </>,
    document.body,
  );
}

/* ───────── current view ───────── */

function CurrentView({
  snapshot,
  breakdown,
  historyCount,
  onShowHistory,
}: {
  snapshot: ContextSnapshot;
  breakdown: ReturnType<typeof getContextBreakdown>;
  historyCount: number;
  onShowHistory: () => void;
}) {
  const { t } = useI18n();
  return (
    <div>
      <ContextTooltipBody snapshot={snapshot} breakdown={breakdown} />
      <div className="border-t border-edge/70">
        <button
          type="button"
          onClick={onShowHistory}
          className={cn(
            "flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[11px] transition-colors",
            "text-content-muted hover:bg-surface-muted",
          )}
        >
          <IconChartBar size={12} className="shrink-0 opacity-70" />
          <span className="min-w-0 flex-1 truncate">{t("chat.context.history")}</span>
          <span className="rounded-full bg-surface-muted px-1.5 py-0.5 text-[10px] tabular-nums text-content-subtle">
            {t("chat.context.turns", { n: historyCount })}
          </span>
        </button>
      </div>
    </div>
  );
}

/* ───────── history view ───────── */

/** Format a wall-clock ms as a short local time (HH:mm). */
function fmtTime(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** Format a duration in ms as e.g. "12s" or "1m 03s". */
function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${String(rem).padStart(2, "0")}s`;
}

function HistoryView({
  history,
  maxTokens,
}: {
  history: TurnUsageRecord[];
  maxTokens: number;
}) {
  const { t } = useI18n();
  // Newest first so the most recent turn is on top without scrolling.
  const ordered = [...history].reverse();
  // Per-turn "input" isn't stored directly — derive it as the non-cached,
  // non-output share of totalProcessedTokens (mirrors the live tooltip's
  // `freshInput` definition in getContextBreakdown). `prompt` (input + cache
  // read + cache write) is the hit-rate denominator for the 合计 row.
  const totals = history.reduce(
    (acc, r) => {
      const input = Math.max(
        0,
        r.totalProcessedTokens - r.outputTokens - r.cacheReadTokens - r.cacheCreationTokens,
      );
      acc.input += input;
      acc.output += r.outputTokens;
      acc.cacheRead += r.cacheReadTokens;
      acc.prompt += Math.max(0, r.totalProcessedTokens - r.outputTokens);
      return acc;
    },
    { input: 0, output: 0, cacheRead: 0, prompt: 0 },
  );

  return (
    <div>
      {/* Header: title + count. No back button — the popover closes on
          outside click / blur (transparent backdrop) rather than returning
          to the current view. */}
      <div className="flex items-center gap-1 border-b border-edge/70 px-2.5 py-1.5">
        <span className="flex items-center gap-1 text-[11px] font-semibold text-content">
          <IconChartBar size={12} className="opacity-80" />
          {t("chat.context.historyTurns", { n: history.length })}
        </span>
      </div>

      {ordered.length === 0 ? (
        <div className="px-3 py-6 text-center text-[11px] text-content-subtle">
          {t("chat.context.historyEmpty")}
        </div>
      ) : (
        <div className="max-h-80 overflow-y-auto">
          <table className="w-full border-collapse text-[10px] tabular-nums">
            <thead className="sticky top-0 bg-surface text-content-subtle">
              <tr className="border-b border-edge/70">
                <th className="px-1.5 py-1 text-left font-medium">{t("chat.context.colTurn")}</th>
                <th className="px-1 py-1 text-right font-medium">{t("chat.context.colInput")}</th>
                <th className="px-1 py-1 text-right font-medium">{t("chat.context.colOutput")}</th>
                <th className="px-1 py-1 text-right font-medium">{t("chat.context.colCacheRead")}</th>
                <th className="px-1 py-1 text-right font-medium">{t("chat.context.colCacheHit")}</th>
                <th className="px-1 py-1 text-right font-medium">{t("chat.context.colUsed")}</th>
              </tr>
            </thead>
            <tbody>
              {ordered.map((r, i) => {
                const turnNo = history.length - i;
                const pct =
                  maxTokens > 0
                    ? Math.min(100, Math.round((r.usedTokens / maxTokens) * 1000) / 10)
                    : 0;
                const input = Math.max(
                  0,
                  r.totalProcessedTokens - r.outputTokens - r.cacheReadTokens - r.cacheCreationTokens,
                );
                return (
                  <tr
                    key={`${r.endedAt}-${i}`}
                    className="border-b border-edge/30 hover:bg-surface-muted"
                    title={
                      `#${turnNo} · ${fmtTime(r.endedAt)} · ${fmtDuration(r.durationMs)}\n` +
                      t("chat.context.rowTooltip", {
                        processed: fmtTokens(r.totalProcessedTokens),
                        used: fmtTokens(r.usedTokens),
                      }) +
                      "\n" +
                      (r.model ? t("chat.context.rowModel", { model: r.model }) : "")
                    }
                  >
                    <td className="whitespace-nowrap px-1.5 py-1 text-content-muted">#{turnNo}</td>
                    <td className="whitespace-nowrap px-1 py-1 text-right text-content-muted">
                      {fmtTokens(input)}
                    </td>
                    <td className="whitespace-nowrap px-1 py-1 text-right text-content-muted">
                      {fmtTokens(r.outputTokens)}
                    </td>
                    <td className="whitespace-nowrap px-1 py-1 text-right text-content-muted">
                      {r.cacheReadTokens > 0 ? fmtTokens(r.cacheReadTokens) : "—"}
                    </td>
                    <td className="whitespace-nowrap px-1 py-1 text-right text-content-muted">
                      {fmtCacheHitRate(r.cacheReadTokens, r.totalProcessedTokens - r.outputTokens)}
                    </td>
                    <td className="whitespace-nowrap px-1 py-1 text-right text-content-muted">
                      {pct}%
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot className="border-t border-edge/70 bg-surface-muted/50">
              <tr>
                <td className="px-1.5 py-1 font-medium text-content">{t("chat.context.total")}</td>
                <td className="whitespace-nowrap px-1 py-1 text-right font-medium text-content">
                  {fmtTokens(totals.input)}
                </td>
                <td className="whitespace-nowrap px-1 py-1 text-right font-medium text-content">
                  {fmtTokens(totals.output)}
                </td>
                <td className="whitespace-nowrap px-1 py-1 text-right font-medium text-content">
                  {fmtTokens(totals.cacheRead)}
                </td>
                <td className="whitespace-nowrap px-1 py-1 text-right font-medium text-content">
                  {fmtCacheHitRate(totals.cacheRead, totals.prompt)}
                </td>
                <td className="px-1 py-1 text-right text-content-subtle">—</td>
              </tr>
            </tfoot>
          </table>

          {/* Footer legend: time/duration/model aren't columns in the table —
              surfaced here as a muted hint so the user knows they live in each
              row's tooltip. */}
          <div className="flex items-center gap-3 px-2 py-1 text-[9px] text-content-subtle">
            <span className="inline-flex items-center gap-0.5">
              <IconCalendarStats size={10} /> {t("chat.context.timeDuration")}
            </span>
            <span className="inline-flex items-center gap-0.5">
              <IconClock size={10} /> {t("chat.context.modelLabel")}
            </span>
            <span className="ml-auto italic">{t("chat.context.hoverRow")}</span>
          </div>
        </div>
      )}
    </div>
  );
}
