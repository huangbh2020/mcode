/**
 * Global portal-popup watcher — the safety net under the per-callsite
 * `useSuppressBrowserView` wiring.
 *
 * The embedded browser is an OS-level WebContentsView floating above ALL
 * renderer DOM, so a portaled popup (context menu, select dropdown, modal
 * dialog) that opens over the browser's rect is swallowed by the page. The
 * per-callsite hook covers the ~18 surfaces that were wired when the
 * geometry-aware suppression shipped, but every shared primitive added since
 * (ConfirmDialog family, base-ui ContextMenu/Select, titlebar menus, …) had to
 * remember to wire it again — and most didn't. This watcher closes the whole
 * bug class: it observes document.body and classifies any portaled popup by
 * its ARIA role, registering synthetic occluders in the same
 * lib/browserOcclusion.ts registry the hook uses — AND drives the store's
 * `suppressBrowserView` counter, because BrowserPanel's reconcile early-outs
 * while the counter is 0 (registrations alone would be dead letters).
 *
 * Role classification (base-ui sets these on its popup elements —
 * menu/popup/MenuRoot.mjs `role: 'menu'`, dialog root `'dialog'` /
 * `'alertdialog'`, select popup `'listbox'`):
 *
 *   role="menu" | "listbox" | "dialog" → GEOMETRY-AWARE union rect. Menus and
 *     selects are trigger-anchored, so only ones reaching the browser stage
 *     hide the view. role="dialog" is deliberately in this bucket too, NOT a
 *     full-window suppress: base-ui's Popover and Combobox-with-input popups
 *     also render role="dialog" (popover/popup/PopoverPopup.mjs), and
 *     suppressing those fully would re-introduce the "browser blanks whenever
 *     ANY dropdown opens anywhere" regression the geometry system killed.
 *     True modal dialogs are covered separately: ui/dialog.tsx bakes the
 *     ref-less (full-suppress) hook into its Popup, so every Dialog-based
 *     modal registers null geometry at its own mount.
 *
 *   role="alertdialog" → null rect (suppress everywhere). Alert confirms are
 *     always modal; none exist in-app today but the classification is free.
 *
 *   role="tooltip" → deliberately NOT tracked (frequent, tiny, would flicker).
 *
 * Open-state filtering: base-ui popups carry `data-open` while open and flip
 * to `data-closed` during the exit transition (utils/popupStateMapping.mjs) —
 * the selector requires [data-open], so closing popups drop out immediately
 * even though they linger in the DOM for the fade-out.
 *
 * Cost model: MutationObserver fires on every DOM change anywhere under body,
 * so the rescan is rAF-coalesced (one per frame max) and is a single
 * querySelectorAll + a handful of getBoundingClientRect calls only when a
 * popup is actually tracked. The occluder update dedupes unchanged rects, so
 * BrowserPanel's reconcile doesn't re-run for no-op rescans.
 */
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import {
  OCCLUDER_UNMEASURED,
  rectOf,
  registerOccluder,
  unregisterOccluder,
  updateOccluder,
  type OcclusionRect,
} from "./browserOcclusion.js";

/** Popup elements to track while open. Exported for the coupling smoke
 *  (scripts/browser-portal-smoke) which asserts the role literals against
 *  base-ui's actual popup attributes — see the terminal-title dictionary
 *  guard for the same pattern. */
export const POPUP_SELECTOR_FOR_TESTS = [
  '[role="menu"][data-open]',
  '[role="listbox"][data-open]',
  '[role="dialog"][data-open]',
  '[role="alertdialog"][data-open]',
].join(",");

const POPUP_SELECTOR = POPUP_SELECTOR_FOR_TESTS;

/** Elements whose open state should fully suppress (null geometry). */
const MODAL_SELECTOR = '[role="alertdialog"][data-open]';

let started = false;
let observer: MutationObserver | null = null;
let scheduledRaf = 0;
let settleTimer = 0;
/** Synthetic occluder id for the geometry-aware union of tracked popups;
 *  null while none are open. */
let floatingId: number | null = null;
/** Synthetic occluder id for the full-suppress (modal) slot; null while no
 *  alertdialog is open. */
let modalId: number | null = null;
/** Whether this watcher currently holds one unit on the store's suppression
 *  counter — registered after the first occluder, released when the last
 *  popup drops out (same ordering contract as useSuppressBrowserView:
 *  register geometry BEFORE bumping, unregister BEFORE decrementing). */
let counterHeld = false;

function unionOf(els: Element[]): OcclusionRect | null {
  let union: OcclusionRect | null = null;
  for (const el of els) {
    if (!(el instanceof HTMLElement)) continue;
    const rect = rectOf(el);
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
}

function holdCounter(): void {
  if (counterHeld) return;
  counterHeld = true;
  useSessionStore.getState().suppressBrowserView(true);
}

function releaseCounter(): void {
  if (!counterHeld) return;
  counterHeld = false;
  useSessionStore.getState().suppressBrowserView(false);
}

/** One classification pass: re-derive both synthetic occluders from the live
 *  DOM. Runs rAF-coalesced off DOM mutations; while popups are tracked, a
 *  settle timer re-measures after entry transitions (same 120ms convention as
 *  useSuppressBrowserView) and window resizes re-measure too (menus anchored
 *  at the viewport edge move with it). */
function rescan(): void {
  const body = document.body;
  if (!body) return;
  const tracked = Array.from(body.querySelectorAll(POPUP_SELECTOR)).filter(
    (el) => el.isConnected,
  );
  const modal = tracked.some((el) => el.matches(MODAL_SELECTOR));

  // Geometry-aware slot, held only while at least one popup is open. A popup
  // in its entry transition can measure <1px — registering null there would
  // full-suppress for a frame (the "browser flashes when a select opens"
  // bug), so the sentinel stands in until the settle remeasure swaps the
  // real rect (never-overlaps in the meantime, same as the hook).
  if (tracked.length > 0) {
    holdCounter();
    const rect = unionOf(tracked) ?? OCCLUDER_UNMEASURED;
    if (floatingId === null) floatingId = registerOccluder(rect);
    else updateOccluder(floatingId, rect);
  } else if (floatingId !== null) {
    unregisterOccluder(floatingId);
    floatingId = null;
  }

  // Modal slot: null rect = suppress everywhere while an alertdialog is open.
  if (modal) {
    if (modalId === null) modalId = registerOccluder(null);
  } else if (modalId !== null) {
    unregisterOccluder(modalId);
    modalId = null;
  }

  // The counter tracks "watcher sees at least one open popup" — released
  // only after both slots are gone (both guards are idempotent).
  if (floatingId === null && modalId === null) releaseCounter();

  // While anything is tracked, keep re-measuring: entry transitions settle,
  // and floating-ui repositioning (flip on scroll) changes rects without DOM
  // mutations we observe.
  if (tracked.length > 0) {
    window.clearTimeout(settleTimer);
    settleTimer = window.setTimeout(() => rescan(), 120);
  }
}

function scheduleRescan(): void {
  if (scheduledRaf) return;
  scheduledRaf = requestAnimationFrame(() => {
    scheduledRaf = 0;
    rescan();
  });
}

function onWindowResize(): void {
  rescan();
}

/** Start the watcher (idempotent). Called once from the app root. */
export function startPortalPopupWatcher(): void {
  if (started || typeof MutationObserver === "undefined") return;
  started = true;
  observer = new MutationObserver(scheduleRescan);
  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener("resize", onWindowResize);
  rescan();
}

/** Stop and release (tests). */
export function stopPortalPopupWatcher(): void {
  if (!started) return;
  started = false;
  observer?.disconnect();
  observer = null;
  if (scheduledRaf) {
    cancelAnimationFrame(scheduledRaf);
    scheduledRaf = 0;
  }
  window.clearTimeout(settleTimer);
  window.removeEventListener("resize", onWindowResize);
  if (floatingId !== null) {
    unregisterOccluder(floatingId);
    floatingId = null;
  }
  if (modalId !== null) {
    unregisterOccluder(modalId);
    modalId = null;
  }
  releaseCounter();
}
