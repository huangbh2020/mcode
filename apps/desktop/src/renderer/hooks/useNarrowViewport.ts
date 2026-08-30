import { useSyncExternalStore } from "react";

/**
 * Reactive "phone-class viewport" flag for PORTALED popups.
 *
 * Portaled menus/popups land on document.body, escaping their pane's
 * container queries — CSS can't position them against the pane, and the only
 * horizontal room that matters is the viewport itself. Below this breakpoint
 * a cascading (right-side) menu cannot fit next to a settings panel
 * (≈300px panel + ≈260px menu ≈ 560px), so callers fall back to vertical
 * (top) placement, where a phone's tall screen has plenty of room.
 *
 * 34rem (544px) comfortably covers phone portrait (320–430px) while leaving
 * phone landscape and every desktop window on the cascading path.
 */
const NARROW_QUERY = "(max-width: 34rem)";

function subscribe(onChange: () => void): () => void {
  const mql = window.matchMedia(NARROW_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

function getSnapshot(): boolean {
  return window.matchMedia(NARROW_QUERY).matches;
}

export function useNarrowViewport(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot);
}
