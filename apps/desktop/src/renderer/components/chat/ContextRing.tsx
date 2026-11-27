import { useMemo, useRef, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import {
  fmtCacheHitRate,
  fmtTokens,
  getContextBreakdown,
  getContextCategoryBreakdown,
  warningColor,
} from "@renderer/lib/contextWindow.js";
import type { ContextSnapshot, TurnUsageRecord } from "@contracts/runtime";
import { Tooltip } from "@renderer/components/ui/index.js";
import {
  IconArrowBarToDown,
  IconArrowBarToUp,
  IconDatabase,
  IconStack2,
} from "@renderer/lib/icons.js";
import { ContextPanelContent, ContextStatsPopover, type ContextPanelView } from "./ContextStatsPopover.js";

/**
 * Compact circular context-occupancy indicator for the composer row.
 *
 * Interaction (方案 A):
 *  - **hover**: opens a 3-band visual context breakdown card (Header with
 *    used/max + segmented stacked bar + autocompact threshold marker; Body
 *    with per-category slices on Claude CLI or aggregate usage fallback;
 *    Footer with model + cache hit rate + turn-history affordance).
 *  - **click** on the ring: pins the full popover on the Overview tab (with
 *    Overview / Turns tabs).
 *  - **click** on "轮次明细" inside the hover card: pins the full popover
 *    directly on the Turns tab.
 */
export function ContextRing({
  snapshot,
  history,
}: {
  snapshot: ContextSnapshot;
  /** Finalized-turn usage records for the active session (ephemeral, from
   *  the store's `usageHistoryBySession`). Empty until the first turn ends. */
  history: TurnUsageRecord[];
}) {
  const { t } = useI18n();
  const { pct, warning } = snapshot;
  // Geometry: 14px box, ring stroke 2.5 (so inner hole ~9px).
  const size = 14;
  const stroke = 2.5;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const dash = c * (Math.min(100, Math.max(0, pct)) / 100);
  const colorClass = warningColor(warning);
  const [open, setOpen] = useState(false);
  const [popoverInitialView, setPopoverInitialView] = useState<ContextPanelView>("current");
  // `tooltipOpen` tracks the base-ui tooltip's hover state so the trigger's
  // selected styling stays in sync while the pointer is over the ring OR over
  // the (hoverable) tooltip body.
  const [tooltipOpen, setTooltipOpen] = useState(false);
  // Bounding box of the ring at open time — the popover renders portaled to
  // <body> (composer overflow can't clip it) and needs a fixed anchor.
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  const selected = open || tooltipOpen;

  const openPopover = (view: ContextPanelView) => {
    const el = ringRef.current;
    if (el) setAnchorRect(el.getBoundingClientRect());
    setPopoverInitialView(view);
    setOpen(true);
  };

  return (
    <div ref={ringRef} className="relative inline-flex">
      <Tooltip.Root
        open={open ? false : tooltipOpen}
        onOpenChange={(next) => {
          if (!open) setTooltipOpen(next);
        }}
      >
        <Tooltip.Trigger
          delay={180}
          render={
            <button
              type="button"
              aria-label={t("chat.context.stats")}
              title={t("chat.context.stats")}
              onClick={() => (open ? setOpen(false) : openPopover("current"))}
            />
          }
          className={cn(
            "inline-flex cursor-pointer items-center gap-1 rounded-sm px-0.5 tabular-nums outline-none transition-colors",
            "hover:bg-surface-muted focus-visible:bg-surface-muted",
            colorClass,
            selected && "bg-surface-muted text-accent",
          )}
        >
          <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
            <circle
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke="currentColor"
              strokeWidth={stroke}
              className="opacity-20"
            />
            <circle
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke="currentColor"
              strokeWidth={stroke}
              strokeLinecap="round"
              strokeDasharray={`${dash} ${c - dash}`}
              className="transition-[stroke-dasharray] duration-500 ease-out"
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
            />
          </svg>
          <span className="composer-lblwrap">
            <span className="text-[10px] font-medium leading-none">{pct}%</span>
          </span>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Positioner side="top" sideOffset={6}>
            <Tooltip.Popup className="overflow-hidden rounded-lg border border-edge bg-surface p-0 shadow-2xl">
              <ContextPanelContent
                snapshot={snapshot}
                history={history}
                maxTokens={snapshot.maxTokens}
                view="current"
                onViewChange={(next) => openPopover(next)}
              />
            </Tooltip.Popup>
          </Tooltip.Positioner>
        </Tooltip.Portal>
      </Tooltip.Root>
      {open && anchorRect && (
        <ContextStatsPopover
          snapshot={snapshot}
          history={history}
          maxTokens={snapshot.maxTokens}
          anchorRect={anchorRect}
          onClose={() => setOpen(false)}
          initialView={popoverInitialView}
        />
      )}
    </div>
  );
}

function rowIcon(key: string) {
  switch (key) {
    case "input":
      return IconArrowBarToDown;
    case "cache-read":
    case "cache-write":
      return IconDatabase;
    case "output":
      return IconArrowBarToUp;
    case "processed":
      return IconStack2;
    default:
      return IconStack2;
  }
}

/**
 * Shared 3-band context breakdown body used by ContextRing's hover card and
 * ContextStatsPopover's Overview tab.
 *
 * - Header: title + `used / max` + percentage pill + segmented stacked bar
 *   (colored by category on Claude CLI, or a single-tone bar on fallback)
 *   with an optional autocompact threshold marker.
 * - Body: per-category breakdown rows (sorted largest-first, plus muted
 *   autocompact buffer & free space) when available; otherwise aggregate
 *   input/cache/output rows.
 * - Footer: compact model + cache-hit-rate meta line, plus optional turn
 *   history button when rendered inside the hover card.
 */
export function ContextTooltipBody({
  snapshot,
  breakdown,
}: {
  snapshot: ContextSnapshot;
  breakdown: ReturnType<typeof getContextBreakdown>;
}) {
  const { t } = useI18n();
  const categoryBreakdown = useMemo(() => getContextCategoryBreakdown(snapshot), [snapshot]);
  const promptVolume = Math.max(0, snapshot.totalProcessedTokens - snapshot.outputTokens);
  const cacheHit = fmtCacheHitRate(snapshot.cacheReadTokens ?? 0, promptVolume);
  const singleBarColor =
    snapshot.warning === "critical"
      ? "bg-danger"
      : snapshot.warning === "near-window"
        ? "bg-warning"
        : "bg-accent";

  return (
    <div className="px-3 py-2.5">
      {/* ── Band 1: Header (occupancy headline + stacked progress bar) ── */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold text-content">{breakdown.title}</span>
        <div className="flex items-center gap-1.5 tabular-nums">
          <span className="text-[11px] text-content-muted">
            <span className="font-semibold text-content">{fmtTokens(snapshot.usedTokens)}</span>
            <span className="text-content-subtle"> / {fmtTokens(snapshot.maxTokens)}</span>
          </span>
          <span
            className={cn(
              "rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none",
              snapshot.warning === "critical" && "bg-danger/15 text-danger",
              snapshot.warning === "near-window" && "bg-warning/15 text-warning",
              snapshot.warning === "ok" && "bg-surface-muted text-content-muted",
            )}
          >
            {snapshot.pct}%
          </span>
        </div>
      </div>

      {/* Segmented stacked bar */}
      <div className="relative mt-2 mb-2.5">
        <div className="flex h-2 w-full overflow-hidden rounded-full bg-surface-muted/90">
          {categoryBreakdown ? (
            <>
              {categoryBreakdown.occupied.map((slice) => (
                <div
                  key={slice.key}
                  style={{ width: `${Math.max(slice.pct, 0.8)}%` }}
                  title={`${slice.label}: ${fmtTokens(slice.tokens)} (${slice.pct}%)`}
                  className={cn("h-full transition-[width] duration-300", slice.barColor)}
                />
              ))}
              {categoryBreakdown.buffer && (
                <div
                  style={{ width: `${categoryBreakdown.buffer.pct}%` }}
                  title={`${categoryBreakdown.buffer.label}: ${fmtTokens(categoryBreakdown.buffer.tokens)} (${categoryBreakdown.buffer.pct}%)`}
                  className={cn("ml-auto h-full", categoryBreakdown.buffer.barColor)}
                />
              )}
            </>
          ) : (
            <div
              style={{ width: `${Math.min(100, Math.max(0, snapshot.pct))}%` }}
              className={cn("h-full rounded-full transition-[width] duration-300", singleBarColor)}
            />
          )}
        </div>
        {categoryBreakdown?.autoCompactPct != null && snapshot.autoCompactThreshold != null && (
          <div
            style={{ left: `${Math.min(99, Math.max(1, categoryBreakdown.autoCompactPct))}%` }}
            title={t("chat.context.autoCompactAt", {
              tokens: fmtTokens(snapshot.autoCompactThreshold),
              pct: categoryBreakdown.autoCompactPct,
            })}
            className="pointer-events-auto absolute -top-0.5 h-3 w-[1.5px] -translate-x-1/2 rounded-full bg-warning/90"
          />
        )}
      </div>

      {/* ── Band 2: Body (per-category composition OR aggregate fallback) ── */}
      {categoryBreakdown ? (
        <div>
          <ul className="space-y-1">
            {categoryBreakdown.occupied.map((slice) => (
              <li
                key={slice.key}
                className="flex items-center gap-2 text-[11px] leading-tight"
              >
                <span className={cn("h-2 w-2 shrink-0 rounded-full", slice.barColor)} />
                <span className="min-w-0 flex-1 truncate text-content-muted">{slice.label}</span>
                <span className="shrink-0 tabular-nums font-medium text-content">
                  {fmtTokens(slice.tokens)}
                </span>
                <span className="w-9 shrink-0 text-right tabular-nums text-[10px] text-content-subtle">
                  {slice.pct}%
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-1.5 space-y-1 border-t border-edge/50 pt-1.5">
            {categoryBreakdown.buffer && (
              <div className="flex items-center gap-2 text-[10.5px] leading-tight text-content-subtle">
                <span className="h-2 w-2 shrink-0 rounded-full border border-dashed border-content-subtle/70" />
                <span className="min-w-0 flex-1 truncate">{categoryBreakdown.buffer.label}</span>
                <span className="shrink-0 tabular-nums">{fmtTokens(categoryBreakdown.buffer.tokens)}</span>
                <span className="w-9 shrink-0 text-right tabular-nums text-[10px]">
                  {categoryBreakdown.buffer.pct}%
                </span>
              </div>
            )}
            <div className="flex items-center gap-2 text-[10.5px] leading-tight text-content-subtle">
              <span className="h-2 w-2 shrink-0 rounded-full border border-edge" />
              <span className="min-w-0 flex-1 truncate">{categoryBreakdown.free.label}</span>
              <span className="shrink-0 tabular-nums">{fmtTokens(categoryBreakdown.free.tokens)}</span>
              <span className="w-9 shrink-0 text-right tabular-nums text-[10px]">
                {categoryBreakdown.free.pct}%
              </span>
            </div>
          </div>
        </div>
      ) : (
        <ul className="space-y-1">
          {breakdown.rows.map((row) => {
            const Icon = rowIcon(row.key);
            return (
              <li
                key={row.key}
                className="flex items-center gap-1.5 text-[11px] text-content-muted"
              >
                <Icon size={12} className="shrink-0 opacity-70" />
                <span className="min-w-0 flex-1 truncate">{row.label}</span>
                <span className="tabular-nums font-medium text-content">{row.value}</span>
              </li>
            );
          })}
        </ul>
      )}

      {/* ── Band 3: Footer (model + cache efficiency) ── */}
      {(snapshot.model || cacheHit !== "—") && (
        <div className="mt-2 flex items-center justify-between gap-2 border-t border-edge/60 pt-1.5 text-[10px] text-content-subtle">
          <span className="min-w-0 truncate" title={snapshot.model}>
            {snapshot.model || ""}
          </span>
          {cacheHit !== "—" && (
            <span className="shrink-0 tabular-nums">
              {t("chat.context.cacheHitInline", { rate: cacheHit })}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
