/**
 * Stream anchor hold — the contract between fold cards inside the virtualized
 * message list (the「N 个操作」ops bar, tool cards, thinking sections) and
 * ChatPane's LegendList bottom-anchoring.
 *
 * Expanding a fold card grows the row it lives in; with `maintainScrollAtEnd`
 * active that height change snaps the scroll back to the bottom, which yanks
 * the bar the user just clicked out from under the pointer — and every
 * streaming delta keeps re-snapping while the card is open, so a one-shot
 * scroll correction can't hold it. ChatPane already solved this family for
 * the TurnPanel fold via `anchorSuspension` ("layout" mode keeps data-change
 * following but stops height-triggered pinning); this context lets any fold
 * card hold that suspension for as long as it is open.
 *
 * Pairing contract: the toggle returned by `useFoldHold` is called with the
 * NEXT open state at click time — before the flip and in the same React
 * batch, so the suspension prop is already in place when the height change
 * lands. A ref inside the hook keeps hold/release strictly paired even when
 * the card unmounts while open (turn-end regroup discards expanded ops bars):
 * the effect cleanup releases, so a hold cannot leak and pin the suspension
 * on forever. Outside a provider (SideChatPanel, OrchWorkerConsole — plain
 * scroll containers with no bottom-pinning) the context is null and the
 * toggle is a no-op; those surfaces rely on `toggleHoldPosition`'s scroll
 * correction alone.
 */
import { createContext, useCallback, useContext, useEffect, useRef } from "react";

export type StreamAnchorHold = (on: boolean) => void;

export const StreamAnchorPauseContext = createContext<StreamAnchorHold | null>(null);

/** Per-card pairing wrapper around the context value (see module doc). */
export function useFoldHold(): (opening: boolean) => void {
  const hold = useContext(StreamAnchorPauseContext);
  const heldRef = useRef(false);
  useEffect(
    () => () => {
      if (!heldRef.current) return;
      heldRef.current = false;
      hold?.(false);
    },
    [hold],
  );
  return useCallback(
    (opening: boolean) => {
      if (opening === heldRef.current) return;
      heldRef.current = opening;
      hold?.(opening);
    },
    [hold],
  );
}
