/**
 * One-shot "fly to capsule" animation after adding a bookmark: a small
 * glowing dot travels from the selection to the status capsule, conveying
 * "the selection was collected up there". Mounts only for the ~400ms flight.
 *
 * The start point is a captured viewport snapshot; the target rect is read
 * live from `targetRef` at mount (the capsule segment may be mounting for
 * the very first time as the optimistic bookmark count lands, so the caller
 * renders this only after the capsule is guaranteed present — same commit).
 *
 * Reduced-motion users skip the flight entirely (the capsule's badge pop
 * alone conveys the change).
 */
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

const FLY_MS = 380;
/** Margin after the transition before unmounting (catches a missed
 *  transitionend on a backgrounded/occluded window — rAF and transitions can
 *  be throttled, a timer always fires). */
const FLY_TOTAL_MS = FLY_MS + 60;

export function BookmarkFly({
  from,
  targetRef,
  onDone,
}: {
  from: { top: number; left: number };
  targetRef: React.RefObject<HTMLDivElement | null>;
  onDone: () => void;
}) {
  const dotRef = useRef<HTMLDivElement>(null);
  // Read once per mount (not via a hook subscription): the animation is a
  // single flight, mid-flight preference flips can't retroactively apply.
  const reduced = useRef(
    typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  ).current;

  useEffect(() => {
    if (reduced) {
      const t = window.setTimeout(onDone, 0);
      return () => window.clearTimeout(t);
    }
    const el = dotRef.current;
    const target = targetRef.current;
    if (!el || !target) {
      const t = window.setTimeout(onDone, 0);
      return () => window.clearTimeout(t);
    }
    const rect = target.getBoundingClientRect();
    // Translate from the start point to the capsule's center, shrinking +
    // fading as it goes — reads as the dot being "absorbed" by the capsule.
    const dx = rect.left + rect.width / 2 - from.left;
    const dy = rect.top + rect.height / 2 - from.top;
    // Force the initial transform to commit before switching to the target,
    // otherwise the browser can coalesce both into a single jump.
    el.style.transform = "translate(0px, 0px) scale(1)";
    el.style.opacity = "1";
    const raf = requestAnimationFrame(() => {
      el.style.transform = `translate(${dx}px, ${dy}px) scale(0.3)`;
      el.style.opacity = "0.55";
    });
    // onDone is idempotent (parent clears already-null state); the timer
    // guarantees completion even if transitionend never fires.
    const timer = window.setTimeout(onDone, FLY_TOTAL_MS);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
  }, [from, targetRef, onDone, reduced]);

  return createPortal(
    <div
      ref={dotRef}
      style={{
        position: "fixed",
        left: from.left,
        top: from.top,
        width: 14,
        height: 14,
        marginLeft: -7,
        marginTop: -7,
        borderRadius: "9999px",
        // Follows the theme's warning (gold) token — same color as the
        // capsule segment and the timeline bookmark dashes.
        backgroundColor: "rgb(var(--warning))",
        boxShadow: "0 0 8px rgb(var(--warning) / 0.75)",
        zIndex: 60,
        pointerEvents: "none",
        transform: "translate(0px, 0px) scale(1)",
        transition: `transform ${FLY_MS}ms cubic-bezier(0.2, 0.8, 0.3, 1), opacity ${FLY_MS}ms ease-out`,
      }}
    />,
    document.body,
  );
}
