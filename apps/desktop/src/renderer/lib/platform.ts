/**
 * Platform detection for the renderer.
 *
 * The renderer has no direct access to `process.platform` (contextIsolation
 * is on, nodeIntegration off), but layout decisions — e.g. reserving space
 * for macOS traffic lights vs. the Windows/Linux titleBarOverlay controls —
 * need to know the OS. `navigator.userAgent` is the standard, dependency-free
 * way to do this in Electron, computed once at module load.
 *
 * For anything that touches the main process (window creation, native APIs),
 * branch on `process.platform` there instead.
 */
type Platform = "mac" | "windows" | "linux";

function detectPlatform(): Platform {
  const ua = navigator.userAgent;
  if (ua.includes("Mac")) return "mac";
  if (ua.includes("Win")) return "windows";
  return "linux";
}

export const platform: Platform = detectPlatform();
export const isMac = platform === "mac";
export const isWindows = platform === "windows";

/** True when the bundle runs inside the Mcode Electron shell (the preload
 *  bridge is present). Detected via the explicit `window.mcodeElectron`
 *  marker injected by the preload — deliberately NOT `!!window.api` (the web
 *  shim assigns `window.api` at module-evaluation time, so an object-presence
 *  check would race the import order and mis-classify the phone) and NOT UA
 *  (Electron-based third-party webviews embed "Electron" in their UA but have
 *  no preload). The marker exists before any page script runs, so the check
 *  is order-independent. */
export const isElectron = typeof window !== "undefined" && window.mcodeElectron === true;

/** True for phone/tablet browsers (drives touch-first layout tweaks inside the
 *  web shell). Non-Electron desktop browsers get the web shell too, but with
 *  `isMobileDevice` false. */
export const isMobileDevice =
  !isElectron &&
  (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ||
    (navigator.maxTouchPoints > 1 && navigator.userAgent.includes("Macintosh")));
