import { useLayoutEffect, useRef, useState } from "react";

/** After collapsing, the action row must widen by at least this many px before
 *  the inline chip row is shown again. Without hysteresis the hide-on-overflow
 *  decision sits exactly on the fit boundary and flaps between the two modes
 *  on every pixel of resize. */
const RESHOW_SLACK_PX = 24;

/**
 * Content-aware collapse for the composer's bottom action row.
 *
 * The chip cluster (Model / Effort / Permission / ContextRing) has a wide,
 * content-dependent min width — labels differ by locale and selected value —
 * so a fixed CSS breakpoint cannot tell when the row actually stops fitting
 * (the pane width also differs from the composer's real width by the side
 * gutters and the always-visible mic/provider/send cluster). This hook
 * measures the row instead: while the chip row is visible it momentarily
 * freezes the cluster at its natural width (`flex: 0 0 auto` +
 * `min-width: max-content` on the chips, `flex-wrap: nowrap` on the row) and
 * checks whether the row overflows. All style changes are restored
 * synchronously, so nothing paints mid-measure.
 *
 * When the chips don't fit, the caller adds `composer-row-collapsed` to the
 * action row; the CSS in styles.css then hides the inline chip row and
 * reveals the single-icon {@link ComposerToolbarToggle} entry. Re-showing is
 * gated on the row growing past the width at collapse time (RESHOW_SLACK_PX),
 * so the hidden state never re-measures itself into a loop.
 */
export function useComposerRowFit() {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const collapseAtRef = useRef(0);

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;

    const measure = () => {
      const chips = row.querySelector<HTMLElement>(".composer-chips-root");
      // Chips hidden (collapsed) or absent: only consider re-showing once the
      // row is clearly wider than when it was collapsed. `offsetWidth === 0`
      // also covers a backgrounded tab whose pane isn't laid out.
      if (!chips || chips.offsetWidth === 0) {
        if (collapsed && row.clientWidth > collapseAtRef.current + RESHOW_SLACK_PX) {
          setCollapsed(false);
        }
        return;
      }
      const prevFlex = chips.style.flex;
      const prevMinWidth = chips.style.minWidth;
      const prevWrap = row.style.flexWrap;
      chips.style.flex = "0 0 auto";
      chips.style.minWidth = "max-content";
      row.style.flexWrap = "nowrap";
      const overflows = row.scrollWidth > row.clientWidth + 1;
      chips.style.flex = prevFlex;
      chips.style.minWidth = prevMinWidth;
      row.style.flexWrap = prevWrap;

      if (overflows) {
        collapseAtRef.current = row.clientWidth;
        setCollapsed(true);
      } else {
        setCollapsed(false);
      }
    };

    // Observe the row (pane/sidebar resizes) and the chip cluster itself
    // (locale switches / value selections change its natural width without
    // resizing the row). Size changes of a collapsed (display:none) cluster
    // don't fire; re-showing is driven by the row branch above.
    const ro = new ResizeObserver(measure);
    ro.observe(row);
    const chips = row.querySelector<HTMLElement>(".composer-chips-root");
    if (chips) ro.observe(chips);
    measure();
    return () => ro.disconnect();
  }, [collapsed]);

  return { rowRef, collapsed };
}