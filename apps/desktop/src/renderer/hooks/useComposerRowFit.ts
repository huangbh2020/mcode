import { useLayoutEffect, useRef, useState } from "react";

/** Composer-card width floor: below this the bottom tool row ALWAYS folds into
 *  the single-icon toggle, even when the (short-locale) chips would technically
 *  fit — at these widths the chips + the always-visible mic/provider/send
 *  cluster squeeze the textarea too hard. */
const COLLAPSE_BELOW_PX = 580;

/** After collapsing, the action row must widen by at least this many px before
 *  the inline chip row is shown again. Without hysteresis the hide-on-overflow
 *  decision sits exactly on the fit boundary and flaps between the two modes
 *  on every pixel of resize. */
const RESHOW_SLACK_PX = 24;

/**
 * Content-aware collapse for the composer's bottom action row.
 *
 * Two triggers fold the chip cluster (Model / Effort / Permission /
 * ContextRing) into the single-icon {@link ComposerToolbarToggle}:
 *
 * 1. Width floor — when the composer card itself is narrower than
 *    COLLAPSE_BELOW_PX (580px), collapse unconditionally. This is the
 *    predictable, user-facing breakpoint ("input box under 580px → one icon").
 * 2. Measured fit — the chip cluster has a wide, content-dependent min width
 *    (labels differ by locale and selected value), so above the floor the hook
 *    still measures the row: while the chip row is visible it momentarily
 *    freezes the cluster at its natural width (`flex: 0 0 auto` +
 *    `min-width: max-content` on the chips, `flex-wrap: nowrap` on the row) and
 *    checks whether the row overflows. All style changes are restored
 *    synchronously, so nothing paints mid-measure.
 *
 * When either fires, the caller adds `composer-row-collapsed` to the action
 * row; the CSS in styles.css then hides the inline chip row and reveals the
 * toggle icon. Re-showing distinguishes the two causes: a floor-caused
 * collapse re-expands as soon as the card is back at/above the floor, while an
 * overflow-caused one must also clear the RESHOW_SLACK_PX hysteresis past the
 * width where it collapsed (the hidden state can't re-measure itself, so the
 * slack keeps the fit boundary from flapping).
 *
 * `forceCollapsed = true` skips the measurement entirely — the chips stay in
 * the single-icon state at every pane width. Used by narrow always-folded
 * surfaces (the side-chat panel), where folding shouldn't depend on measured
 * fit and must never flip back to inline chips on a resize.
 */
export function useComposerRowFit(forceCollapsed = false) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  /** The composer card (the rounded input box) — the element whose width the
   *  COLLAPSE_BELOW_PX floor is measured against. Attached by the caller to
   *  the card container so the floor tracks the box the user sees, not the
   *  action row (which currently stretches to the same width but could gain
   *  independent padding). */
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [collapsed, setCollapsed] = useState(forceCollapsed);
  const collapseAtRef = useRef(0);
  // Whether the current collapsed state came from the width floor (vs a
  // measured overflow). Floor collapses re-show immediately once the card is
  // back above the floor; overflow collapses keep the RESHOW_SLACK_PX gate.
  const floorCollapsedRef = useRef(false);

  useLayoutEffect(() => {
    // Always-folded mode: no measuring, no observer — permanently collapsed.
    if (forceCollapsed) return;

    const row = rowRef.current;
    if (!row) return;

    const measure = () => {
      // Width floor first: an input box narrower than COLLAPSE_BELOW_PX
      // always folds, regardless of whether the chips would fit.
      const card = cardRef.current;
      if (card && card.clientWidth < COLLAPSE_BELOW_PX) {
        floorCollapsedRef.current = true;
        setCollapsed(true);
        return;
      }
      const chips = row.querySelector<HTMLElement>(".composer-chips-root");
      // Chips hidden (collapsed) or absent: only consider re-showing once the
      // card is back above the floor (floor-caused collapse) or the row is
      // clearly wider than when it collapsed (overflow-caused).
      // `offsetWidth === 0` also covers a backgrounded tab whose pane isn't
      // laid out.
      if (!chips || chips.offsetWidth === 0) {
        if (
          collapsed &&
          (floorCollapsedRef.current || row.clientWidth > collapseAtRef.current + RESHOW_SLACK_PX)
        ) {
          floorCollapsedRef.current = false;
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
        floorCollapsedRef.current = false;
        collapseAtRef.current = row.clientWidth;
        setCollapsed(true);
      } else {
        floorCollapsedRef.current = false;
        setCollapsed(false);
      }
    };

    // Observe the row (pane/sidebar resizes) and the chip cluster itself
    // (locale switches / value selections change its natural width without
    // resizing the row). The card is observed too because the floor reads its
    // width; the row happens to stretch with the card, but the card is the
    // authoritative source for the floor decision. Size changes of a collapsed
    // (display:none) cluster don't fire; re-showing is driven by the row/card
    // branch above.
    const ro = new ResizeObserver(measure);
    ro.observe(row);
    if (cardRef.current) ro.observe(cardRef.current);
    const chips = row.querySelector<HTMLElement>(".composer-chips-root");
    if (chips) ro.observe(chips);
    measure();
    return () => ro.disconnect();
  }, [collapsed]);

  return { rowRef, cardRef, collapsed };
}
