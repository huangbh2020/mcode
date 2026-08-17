/**
 * Hide the embedded browser's OS-level WebContentsView while a renderer-DOM
 * overlay/popup is open.
 *
 * The browser is a native Electron view that always floats ABOVE the renderer
 * DOM — no CSS z-index can stack a DOM popup (portaled menu/popover, dialog,
 * lightbox) on top of it, so clicks into its rect get swallowed by the page.
 * The established fix is the store's `suppressBrowserView` counter: while > 0
 * BrowserPanel parks the active view offscreen and re-shows it on release.
 * Mirrors image-preview.tsx / GitDiffDialog.tsx. Call with the popup's open
 * state; the view hides only while it's open.
 */
import { useEffect } from "react";
import { useSessionStore } from "@renderer/stores/sessionStore.js";

export function useSuppressBrowserView(open: boolean): void {
  const suppressBrowserView = useSessionStore((s) => s.suppressBrowserView);
  useEffect(() => {
    if (!open) return;
    suppressBrowserView(true);
    return () => suppressBrowserView(false);
  }, [open, suppressBrowserView]);
}