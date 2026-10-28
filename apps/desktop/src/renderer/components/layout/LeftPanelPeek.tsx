import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@renderer/lib/cn.js";

/** Hover-intent delay before the edge strip summons the drawer — long enough
 *  to ignore a cursor grazing the edge en route elsewhere, short enough to
 *  feel instant. Clicking the strip skips the wait. */
const OPEN_INTENT_MS = 160;

/** Grace period after the cursor leaves the peeked drawer before it slides
 *  back — absorbs boundary jitter (onto the scrim and straight back). */
const CLOSE_GRACE_MS = 220;

/** Idle-dismissal window for an AUTO-peeked drawer (opened from the store —
 *  e.g. a file open sliding the right drawer in while the panel is closed).
 *  The mouse may never enter such a drawer, so the mouse-leave grace would
 *  never arm and it would park open forever; entering the drawer cancels
 *  this timer and the normal leave-grace takes over from there. Long enough
 *  to glance at the file that summoned it. */
export const AUTO_PEEK_IDLE_MS = 4000;

/**
 * Side-panel hover-peek (left and right). When a sidebar is closed
 * (leftOpen/rightOpen=false) the always-mounted aside parks off-canvas as a
 * fixed drawer (left: App.tsx; right: ThreePaneLayout via peek props); the
 * pieces here complete the interaction:
 *
 *  · LeftEdgePeekTrigger / RightEdgePeekTrigger — an invisible full-height
 *    strip on the window's edge. Hovering it for OPEN_INTENT_MS (or clicking
 *    it) floats that side's drawer in over the workspace. A small pill fades
 *    in during the intent delay so the edge answers the cursor immediately
 *    instead of feeling dead.
 *  · PeekScrim — a light dim behind the drawer that fades in with it; clicking
 *    anywhere on it dismisses. The drawer itself closes via usePeekAutoClose
 *    when the cursor leaves it.
 *
 * z-map: strip z-30 (over the workspace z-10 and the left divider z-20), scrim
 * z-[44], drawer z-[45] — all under the z-50 dialog family. The browser
 * overlay (z-40) covers the strips, which intentionally disables the peek while
 * it owns the workspace; App.tsx gates both strips there anyway.
 */

/** Schedules a grace-period dismissal for the peek drawer. `schedule` arms
 *  the timer (mouse-leave of the drawer, or — with an explicit ms override —
 *  an auto-opened drawer that the mouse may never enter, e.g. a store-driven
 *  peek after a file open), `cancel` disarms it (re-enter, or the drawer
 *  being re-opened before the grace elapses). Re-arms overwrite —
 *  leaving/entering repeatedly never stacks timers. */
export function usePeekAutoClose(
  active: boolean,
  onClose: () => void,
  graceMs = CLOSE_GRACE_MS,
) {
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  const timer = useRef<number | null>(null);
  const cancel = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);
  const schedule = useCallback(
    (graceMsOverride?: number) => {
      cancel();
      timer.current = window.setTimeout(() => {
        timer.current = null;
        onCloseRef.current();
      }, graceMsOverride ?? graceMs);
    },
    [cancel, graceMs],
  );
  // Closing (or unmounting) the drawer never leaves a stray timer behind.
  useEffect(() => {
    if (!active) cancel();
  }, [active, cancel]);
  useEffect(() => cancel, [cancel]);
  return { schedule, cancel };
}

/** Invisible left-edge hover strip with the intent delay + handle pill. */
export function LeftEdgePeekTrigger({ onActivate }: { onActivate: () => void }) {
  const [hinted, setHinted] = useState(false);
  const timer = useRef<number | null>(null);
  const clear = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    setHinted(false);
  }, []);
  useEffect(() => clear, [clear]);
  return (
    <div
      className="group fixed left-0 top-0 z-30 h-full w-2 cursor-pointer"
      onMouseEnter={() => {
        if (timer.current !== null) return;
        setHinted(true);
        timer.current = window.setTimeout(() => {
          timer.current = null;
          onActivate();
        }, OPEN_INTENT_MS);
      }}
      onMouseLeave={clear}
      onClick={() => {
        clear();
        onActivate();
      }}
    >
      {/* Handle pill — the only visual the strip has: it answers the hover
          during the intent delay, then the drawer slides over it. */}
      <span
        aria-hidden
        className={cn(
          "absolute left-[3px] top-1/2 h-14 w-[3px] rounded-full bg-content-muted",
          "transition-[opacity,transform] duration-200 ease-out",
          hinted ? "translate-x-0 opacity-70" : "-translate-x-1 opacity-0",
        )}
      />
    </div>
  );
}

/** Invisible right-edge hover strip — the left trigger mirrored (pill grows
 *  inward from the window's right edge). */
export function RightEdgePeekTrigger({ onActivate }: { onActivate: () => void }) {
  const [hinted, setHinted] = useState(false);
  const timer = useRef<number | null>(null);
  const clear = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    setHinted(false);
  }, []);
  useEffect(() => clear, [clear]);
  return (
    <div
      className="group fixed right-0 top-0 z-30 h-full w-2 cursor-pointer"
      onMouseEnter={() => {
        if (timer.current !== null) return;
        setHinted(true);
        timer.current = window.setTimeout(() => {
          timer.current = null;
          onActivate();
        }, OPEN_INTENT_MS);
      }}
      onMouseLeave={clear}
      onClick={() => {
        clear();
        onActivate();
      }}
    >
      <span
        aria-hidden
        className={cn(
          "absolute right-[3px] top-1/2 h-14 w-[3px] rounded-full bg-content-muted",
          "transition-[opacity,transform] duration-200 ease-out",
          hinted ? "translate-x-0 opacity-70" : "translate-x-1 opacity-0",
        )}
      />
    </div>
  );
}

/** Dim behind the peeked drawer. Mounted for the whole drawer mode (so the
 *  fade-out plays), interactive only while active. Side-agnostic — covers the
 *  whole window for either drawer. */
export function PeekScrim({
  active,
  onClose,
}: {
  active: boolean;
  onClose: () => void;
}) {
  return (
    <div
      className={cn(
        "fixed inset-0 z-[44] bg-black/20 transition-opacity duration-200",
        active ? "opacity-100 backdrop-blur-[2px]" : "pointer-events-none opacity-0",
      )}
      onClick={onClose}
    />
  );
}
