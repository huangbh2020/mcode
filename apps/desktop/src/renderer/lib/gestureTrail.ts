/**
 * Imperative SVG trail layer for mouse gestures — shared by the global
 * gesture listener (`useMouseGestures`) and the settings-page recorder
 * (`GestureRecorder`).
 *
 * Rendering deliberately bypasses React: pointermove fires at display rate
 * and per-frame setState would re-render the app tree for a few hundred ms
 * of decoration. Instead a single fixed-position, pointer-events-none SVG is
 * lazily attached to <body> and its <polyline> is updated via DOM attrs.
 * Idle cost is zero — nothing exists until the first stroke, and the polyline
 * is removed after its fade.
 */
import type { GesturePoint } from "@renderer/lib/gestures.js";

let svg: SVGSVGElement | null = null;
let line: SVGPolylineElement | null = null;
let trailFadeTimer: number | null = null;

function ensureLayer(): void {
  if (svg && svg.isConnected) return;
  svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.style.position = "fixed";
  svg.style.inset = "0";
  svg.style.width = "100%";
  svg.style.height = "100%";
  svg.style.pointerEvents = "none";
  svg.style.zIndex = "9999";
  document.body.appendChild(svg);
}

/** Begin (or continue) drawing a stroke. Creates the layer on first use. */
export function drawGestureTrail(points: GesturePoint[]): void {
  if (points.length === 0) return;
  ensureLayer();
  if (!svg) return;
  if (!line || !line.isConnected) {
    line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    // `--accent` is an RGB triplet in both themes (see styles.css).
    line.setAttribute("stroke", "rgb(var(--accent))");
    line.setAttribute("stroke-width", "2.5");
    line.setAttribute("stroke-linecap", "round");
    line.setAttribute("stroke-linejoin", "round");
    line.setAttribute("fill", "none");
    line.setAttribute("opacity", "0.85");
    svg.appendChild(line);
  }
  line.setAttribute("points", points.map((p) => `${p.x},${p.y}`).join(" "));
}

/** Fade the current stroke out and drop it. Safe to call with nothing drawn.
 *  The badge outlives the trail line briefly (~650ms vs 180ms) so the user
 *  can read the recognized gesture / command name after release. */
export function fadeGestureTrail(): void {
  const l = line;
  line = null;
  if (l) {
    if (trailFadeTimer !== null) window.clearTimeout(trailFadeTimer);
    l.style.transition = "opacity 180ms ease-out";
    l.setAttribute("opacity", "0");
    trailFadeTimer = window.setTimeout(() => {
      l.remove();
      trailFadeTimer = null;
    }, 200);
  }
  const b = badge;
  badge = null;
  if (b) {
    if (badgeFadeTimer !== null) window.clearTimeout(badgeFadeTimer);
    b.style.transition = "opacity 250ms ease-out";
    b.style.opacity = "0";
    badgeFadeTimer = window.setTimeout(() => {
      b.remove();
      badgeFadeTimer = null;
    }, 700);
  }
}

/* ──────────────────────── gesture badge ──────────────────────── */

let badge: HTMLDivElement | null = null;
let badgeFadeTimer: number | null = null;

/**
 * Show (or update) the gesture badge near the pointer: the live arrow
 * sequence, plus the bound command's label once the stroke matches. Updated
 * on every pointermove (the recognizer runs on the partial stroke) and once
 * more at release, so the user sees what the gesture WILL do before letting
 * go — `matched` switches the accent styling, and an unmatched final stroke
 * gets the "unrecognized" hint from the caller.
 */
export function showGestureBadge(
  text: string,
  opts: { x: number; y: number; matched: boolean },
): void {
  if (!badge || !badge.isConnected) {
    badge = document.createElement("div");
    badge.style.position = "fixed";
    badge.style.pointerEvents = "none";
    badge.style.zIndex = "9999";
    badge.style.padding = "3px 10px";
    badge.style.borderRadius = "8px";
    badge.style.fontSize = "12px";
    badge.style.fontWeight = "600";
    badge.style.letterSpacing = "0.04em";
    badge.style.whiteSpace = "nowrap";
    badge.style.boxShadow = "0 2px 8px rgb(0 0 0 / 0.18)";
    document.body.appendChild(badge);
  }
  // Reset any in-flight fade from a previous stroke.
  if (badgeFadeTimer !== null) {
    window.clearTimeout(badgeFadeTimer);
    badgeFadeTimer = null;
  }
  badge.style.opacity = "1";
  badge.style.transition = "none";
  badge.textContent = text;
  badge.style.background = "rgb(var(--surface))";
  badge.style.border = `1px solid rgb(var(--${opts.matched ? "accent" : "edge"}))`;
  badge.style.color = `rgb(var(--${opts.matched ? "accent-strong" : "content-muted"}))`;
  // Anchor above-right of the pointer, clamped inside the viewport.
  const w = badge.offsetWidth;
  const h = badge.offsetHeight;
  const left = Math.min(Math.max(opts.x + 14, 8), window.innerWidth - w - 8);
  const top = Math.min(Math.max(opts.y - h - 14, 8), window.innerHeight - h - 8);
  badge.style.left = `${left}px`;
  badge.style.top = `${top}px`;
}
