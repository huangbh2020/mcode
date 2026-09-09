/**
 * Hide the embedded browser's OS-level WebContentsView while a renderer-DOM
 * overlay/popup is open — but only when that popup actually reaches the
 * browser's on-screen rect.
 *
 * The browser is a native Electron view that always floats ABOVE the renderer
 * DOM — no CSS z-index can stack a DOM popup (portaled menu/popover, dialog,
 * lightbox) on top of it, so clicks into its rect get swallowed by the page.
 * The established fix is the store's `suppressBrowserView` counter: while > 0
 * BrowserPanel parks the active view offscreen and re-shows it on release.
 *
 * Unconditional suppression blanked the browser panel whenever ANY popup
 * opened anywhere (e.g. a composer dropdown in the center pane), so this hook
 * is geometry-aware: pass a ref (or refs) to the popup element(s) and the
 * view is hidden only while one of them overlaps the browser's stage rect
 * (see lib/browserOcclusion.ts). Without a ref the behavior falls back to
 * always-hide — right for full-screen backdrops and unknown-geometry
 * surfaces.
 */
import { useEffect, useRef, type RefObject } from "react";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import {
  OCCLUDER_UNMEASURED,
  rectOf,
  registerOccluder,
  unregisterOccluder,
  updateOccluder,
  type OcclusionRect,
} from "@renderer/lib/browserOcclusion.js";

export function useSuppressBrowserView(
  open: boolean,
  popupRef?: RefObject<HTMLElement | null> | ReadonlyArray<RefObject<HTMLElement | null>>,
): void {
  const suppressBrowserView = useSessionStore((s) => s.suppressBrowserView);
  // Ref mirror so the effect deps stay [open] — callers may pass inline ref
  // arrays whose identity changes per render, and refs are read lazily here.
  const popupRefRef = useRef(popupRef);
  popupRefRef.current = popupRef;
  useEffect(() => {
    if (!open) return;
    const refs = popupRefRef.current;
    const list = refs ? (Array.isArray(refs) ? refs : [refs]) : [];
    /** Union of all measurable popup rects. Unmounted/zero-sized popups are
     *  skipped so a closed sibling (e.g. a submenu ref while only a hint
     *  bubble shows) can't shrink the union while a real rect is available. */
    const measureUnion = (): OcclusionRect | null => {
      let union: OcclusionRect | null = null;
      for (const ref of list) {
        const rect = rectOf(ref.current);
        if (!rect) continue;
        union = union
          ? {
              left: Math.min(union.left, rect.left),
              top: Math.min(union.top, rect.top),
              right: Math.max(union.right, rect.right),
              bottom: Math.max(union.bottom, rect.bottom),
            }
          : rect;
      }
      return union;
    };
    // Register BEFORE bumping the counter: the counter flip is what triggers
    // BrowserPanel's reconcile, so it sees whatever we register here. Portal
    // popups are NOT mounted yet in this effect (React portals create their
    // container node one render after `open` flips — base-ui's FloatingPortal
    // builds it via setState), so measureUnion() is null on the first frame.
    // Ref-less callers (full-window dialogs) keep the conservative null =
    // suppress everywhere; ref-aware callers get the never-overlapping
    // OCCLUDER_UNMEASURED sentinel instead — the popup is still invisible in
    // its entry transition, and the rAF remeasure below swaps in the real
    // rect within a frame (hiding the view before the popup becomes visible
    // if it truly overlaps). Registering null here flashed the view on EVERY
    // popup open (hide → remeasure → show).
    const id = registerOccluder(list.length > 0 ? (measureUnion() ?? OCCLUDER_UNMEASURED) : null);
    suppressBrowserView(true);
    // Popups are often positioned/animated after the commit — re-measure a
    // frame later, once more after the entry transition settles (the
    // scale-95→100 starting style makes getBoundingClientRect read ~5% small
    // while animating), and on window resizes (the popup moves with it).
    const remeasure = () => updateOccluder(id, measureUnion());
    const raf = requestAnimationFrame(remeasure);
    const settleTimer = window.setTimeout(remeasure, 120);
    window.addEventListener("resize", remeasure);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(settleTimer);
      window.removeEventListener("resize", remeasure);
      unregisterOccluder(id);
      suppressBrowserView(false);
    };
  }, [open, suppressBrowserView]);
}
