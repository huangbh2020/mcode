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
    /** Union of all measurable popup rects; null (suppress everywhere) when
     *  no ref measures — unmounted/zero-sized popups are skipped so a closed
     *  sibling (e.g. a submenu ref while only a hint bubble shows) can't
     *  force the conservative path while a real rect is available. */
    const measureUnion = (): OcclusionRect | null => {
      const refs = popupRefRef.current;
      const list = refs ? (Array.isArray(refs) ? refs : [refs]) : [];
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
    // BrowserPanel's reconcile, and this way it already sees final geometry.
    const id = registerOccluder(measureUnion());
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
