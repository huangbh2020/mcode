/**
 * Geometry registry deciding whether open renderer-DOM popups actually
 * overlap the embedded browser's WebContentsView rect.
 *
 * The browser view is an OS-level surface that always floats ABOVE the
 * renderer DOM — no CSS z-index can stack a portaled popup on top of it. A
 * popup that reaches into the browser's on-screen rect therefore forces the
 * view to hide (BrowserPanel parks it offscreen). But popups elsewhere —
 * composer dropdowns in the center pane, etc. — don't: hiding the view
 * anyway blanked the whole browser panel (its white stage showing through)
 * every time any dropdown opened anywhere.
 *
 * BrowserPanel publishes its stage rect (setBrowserStageRect) on every bounds
 * sync; each `useSuppressBrowserView(open, popupRef)` callsite registers its
 * popup's measured rect while open. `shouldSuppressBrowserView()` is the
 * decision: hide only when some open popup overlaps the stage — unknown
 * geometry (no measurable popup or no active stage) suppresses
 * conservatively, matching the old always-hide behavior.
 */

export interface OcclusionRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

let stageRect: OcclusionRect | null = null;
let nextOccluderId = 1;
/** occluderId -> viewport rect; null = "geometry unknown, suppress everywhere". */
const occluders = new Map<number, OcclusionRect | null>();
let version = 0;
const listeners = new Set<() => void>();

function notify(): void {
  version += 1;
  for (const l of listeners) l();
}

/** Viewport rect of a live element, or null when it can't be measured
 *  (unmounted / zero-sized). Null must suppress conservatively. */
export function rectOf(el: HTMLElement | null | undefined): OcclusionRect | null {
  if (!el || !el.isConnected) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 1 && r.height < 1) return null;
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}

/** Publish the browser stage's viewport rect (called by BrowserPanel on every
 *  bounds sync). Deliberately does NOT notify: the panel drives its own
 *  reconcile on the resize/scroll paths that move the stage, and notifying
 *  from here would re-render into every bounds sync. Null = no active
 *  browser surface. */
export function setBrowserStageRect(rect: OcclusionRect | null): void {
  stageRect = rect;
}

export function registerOccluder(rect: OcclusionRect | null): number {
  const id = nextOccluderId++;
  occluders.set(id, rect);
  notify();
  return id;
}

export function updateOccluder(id: number, rect: OcclusionRect | null): void {
  const prev = occluders.get(id);
  if (prev === undefined) return;
  // Skip the notify when the measured rect didn't move — the remeasure ticks
  // (rAF after open, window resizes) would otherwise re-render BrowserPanel
  // and re-run its reconcile for no change.
  if (
    (prev === null && rect === null) ||
    (prev !== null &&
      rect !== null &&
      prev.left === rect.left &&
      prev.top === rect.top &&
      prev.right === rect.right &&
      prev.bottom === rect.bottom)
  ) {
    return;
  }
  occluders.set(id, rect);
  notify();
}

export function unregisterOccluder(id: number): void {
  if (occluders.delete(id)) notify();
}

/** Subscription for useSyncExternalStore — version bumps only on occluder
 *  (popup open/close/move) changes. */
export function subscribeOcclusion(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getOcclusionVersion(): number {
  return version;
}

/** True when at least one open popup overlaps the browser's stage rect.
 *  Callers that suppress via the raw store counter (modal dialogs with a
 *  full-window backdrop, the image lightbox) never register geometry here —
 *  an empty registry or an unknown rect must suppress conservatively (the
 *  old always-hide behavior) so those keep working untouched. */
export function shouldSuppressBrowserView(): boolean {
  if (occluders.size === 0) return true;
  if (!stageRect) return true;
  for (const r of occluders.values()) {
    if (!r) return true;
    if (
      r.left < stageRect.right &&
      r.right > stageRect.left &&
      r.top < stageRect.bottom &&
      r.bottom > stageRect.top
    ) {
      return true;
    }
  }
  return false;
}
