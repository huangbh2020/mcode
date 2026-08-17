import { useRef, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import {
  fmtTokens,
  getContextBreakdown,
  warningColor,
} from "@renderer/lib/contextWindow.js";
import type { ContextSnapshot, TurnUsageRecord } from "@contracts/runtime";
import { Tooltip } from "@renderer/components/ui/index.js";
import {
  IconArrowBarToDown,
  IconArrowBarToUp,
  IconChartBar,
  IconChevronRight,
  IconDatabase,
  IconStack2,
} from "@renderer/lib/icons.js";
import { ContextStatsPopover } from "./ContextStatsPopover.js";

/**
 * Compact circular context-occupancy indicator for the composer row.
 *
 * Renders as a small SVG ring (ZCode-style) whose filled arc length
 * represents `snapshot.pct` and whose color escalates with the warning
 * level (ok → muted, near-window → warning amber, critical → danger red).
 * The percentage sits beside the ring.
 *
 * Hover-driven interaction (no click on the ring itself):
 *  - **hover**: the ring gains a selected (accented) state and a rich
 *    tooltip breaks the live usage down by token kind
 *    (input / cache / output / cost). The tooltip is hoverable so the
 *    pointer can move into it to click the "查看详情" affordance.
 *  - **查看详情**: clicking it dismisses the tooltip and opens
 *    {@link ContextStatsPopover} (live breakdown + per-turn history). The
 *    tooltip is force-hidden while the popover is open so the two surfaces
 *    never overlap.
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
  const breakdown = getContextBreakdown(snapshot);
  const [open, setOpen] = useState(false);
  // `tooltipOpen` tracks the base-ui tooltip's hover state so the trigger's
  // selected styling stays in sync while the pointer is over the ring OR over
  // the (hoverable) tooltip body.
  const [tooltipOpen, setTooltipOpen] = useState(false);
  // Bounding box of the ring at open time — the popover renders portaled to
  // <body> (composer overflow can't clip it) and needs a fixed anchor.
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  const selected = open || tooltipOpen;

  const openDetails = () => {
    const el = ringRef.current;
    if (el) setAnchorRect(el.getBoundingClientRect());
    setOpen(true);
  };

  return (
    <div ref={ringRef} className="relative inline-flex">
      {/* Always pass a boolean `open` (never undefined) so the tooltip stays
          fully controlled and never flips between controlled/uncontrolled —
          which would trip React's "uncontrolled → controlled" warning.
          While the details popover (`open`) is up we force the tooltip closed
          (false) so the two surfaces never overlap; otherwise it follows the
          hover-driven `tooltipOpen`. */}
      <Tooltip.Root
        open={open ? false : tooltipOpen}
        onOpenChange={(next) => {
          if (!open) setTooltipOpen(next);
        }}
      >
        <Tooltip.Trigger
          delay={200}
          // Button (not span) so the ring is keyboard-focusable; it carries
          // the hover-driven "selected" affordance rather than a click action.
          render={
            <button
              type="button"
              aria-label={t("chat.context.stats")}
              title={t("chat.context.stats")}
            />
          }
          className={cn(
            "inline-flex cursor-default items-center gap-1 rounded-sm px-0.5 tabular-nums outline-none transition-colors",
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
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
            />
          </svg>
          <span className="text-[10px] font-medium leading-none">{pct}%</span>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Positioner side="top" sideOffset={6}>
            <Tooltip.Popup className="min-w-[200px] max-w-[260px] p-0">
              <ContextTooltipBody
                snapshot={snapshot}
                breakdown={breakdown}
                historyCount={history.length}
                onShowDetails={openDetails}
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
          // The hover tooltip already showed the live breakdown, so jumping
          // straight to "history" avoids a redundant first screen.
          initialView="history"
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
 * Shared rich body used by ContextRing's hover tooltip and by the
 * ContextStatsPopover's current view.
 *
 * When `onShowDetails` is provided (the ContextRing hover tooltip), a
 * trailing "查看详情" affordance is rendered at the bottom — clicking it
 * opens the full token-details popover. When omitted (the ContextStatsPopover
 * reuses this body for its own current view), nothing extra is rendered, so
 * the popover keeps its own dedicated history affordance.
 */
export function ContextTooltipBody({
  snapshot,
  breakdown,
  historyCount,
  onShowDetails,
}: {
  snapshot: ContextSnapshot;
  breakdown: ReturnType<typeof getContextBreakdown>;
  /** Number of finalized turns, shown as a badge on the details affordance.
   *  Optional; only meaningful with `onShowDetails`. */
  historyCount?: number;
  /** Open the token-details (stats) popover. Optional; when absent, no
   *  trailing affordance is rendered. */
  onShowDetails?: () => void;
}) {
  const { t } = useI18n();
  const colorClass = warningColor(snapshot.warning);
  return (
    <div className="px-2.5 py-2">
      <div className="mb-1.5 flex items-baseline justify-between gap-3 border-b border-edge/70 pb-1.5">
        <div>
          <div className="text-[11px] font-semibold text-content">{breakdown.title}</div>
          <div className={cn("mt-0.5 text-[10px] tabular-nums", colorClass)}>
            {breakdown.subtitle}
          </div>
        </div>
        <div
          className={cn(
            "rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums",
            snapshot.warning === "critical" && "bg-danger/15 text-danger",
            snapshot.warning === "near-window" && "bg-warning/15 text-warning",
            snapshot.warning === "ok" && "bg-surface-muted text-content-muted",
          )}
        >
          {snapshot.pct}%
        </div>
      </div>
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
      {snapshot.model && (
        <div className="mt-1.5 border-t border-edge/70 pt-1.5 text-[10px] text-content-subtle">
          {t("chat.context.modelLine", { model: snapshot.model })}
        </div>
      )}
      {onShowDetails && (
        <div className="mt-1.5 border-t border-edge/70 pt-1">
          <button
            type="button"
            onClick={onShowDetails}
            className={cn(
              "flex w-full items-center gap-1.5 -mx-0.5 rounded px-0.5 py-1 text-left text-[11px] transition-colors",
              "text-content-muted hover:bg-surface-muted hover:text-content",
            )}
          >
            <IconChartBar size={12} className="shrink-0 opacity-70" />
            <span className="min-w-0 flex-1 truncate">{t("chat.context.viewDetails")}</span>
            {historyCount != null && (
              <span className="rounded-full bg-surface-muted px-1.5 py-0.5 text-[10px] tabular-nums text-content-subtle">
                {t("chat.context.turns", { n: historyCount })}
              </span>
            )}
            <IconChevronRight size={12} className="shrink-0 opacity-50" />
          </button>
        </div>
      )}
      {/* Keep fmtTokens referenced for potential future rows */}
      <span className="hidden">{fmtTokens(snapshot.usedTokens)}</span>
    </div>
  );
}
