/**
 * Global mouse-gesture listener — the pointer counterpart to
 * `useGlobalShortcuts`. Mount once at the App root.
 *
 * Subscribes to the store's `gestureSettings`, merges overrides with the
 * compiled-in `DEFAULT_GESTURES`, and (while enabled) keeps three permanent
 * `window` CAPTURE listeners: pointerdown (stroke start), contextmenu (menu
 * suppression), and keydown (Escape cancels an in-flight stroke). While a
 * stroke is armed, transient pointermove/pointerup/pointercancel + blur/
 * mouseleave listeners track it. Idle cost is zero — nothing polls, and the
 * handlers early-return on the first cheap check.
 *
 * Dispatch mirrors the keyboard pipeline exactly: the recognized direction
 * sequence resolves to a commandId, the command is looked up in
 * `collectCommands(state)` (so availability filtering applies), and its
 * `perform` runs against the live store. An unmatched stroke is a silent
 * no-op.
 *
 * Context-menu interplay (the subtle part):
 *  - Win/Linux fire `contextmenu` right AFTER mouseup — a finished stroke
 *    opens a time-boxed suppression window so the trailing menu is swallowed,
 *    while a plain click (no drag past GESTURE_START_THRESHOLD_PX) passes
 *    through untouched.
 *  - macOS fires `contextmenu` at MOUSEDOWN time, before any movement — so
 *    an armed press is blocked up front, and if it never becomes a gesture,
 *    the menu is re-dispatched synthetically on release so component context
 *    menus still open (React/base-ui handlers consume real DOM events, which
 *    a bubbling synthetic MouseEvent satisfies).
 *
 * Exemptions: elements marked `data-gesture-exclude` (the terminal's
 * right-click copy/paste) and anything inside `[role="dialog"]` (never
 * gesture behind a modal). `-webkit-app-region: drag` areas and the embedded
 * browser's WebContentsView simply never deliver pointer events to this
 * renderer — natural blind zones, documented in the settings panel.
 */
import { useEffect } from "react";
import { isMac } from "@renderer/lib/platform.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { collectCommands, commandDisplayName } from "@renderer/lib/commands.js";
import { translate } from "@renderer/lib/i18n/core.js";
import {
  GESTURE_START_THRESHOLD_PX,
  MAX_POINTS,
  findMatchingGesture,
  recognizeGesture,
  resolveAllGestures,
  sequenceToArrows,
  type GesturePoint,
} from "@renderer/lib/gestures.js";
import { drawGestureTrail, fadeGestureTrail, showGestureBadge } from "@renderer/lib/gestureTrail.js";
import type { GestureSequence } from "@contracts/ipc";

/** How long after a completed stroke we keep swallowing the trailing
 *  contextmenu event (Win/Linux dispatch it right after mouseup; the window
 *  also covers dispatches that land in a later task). */
const SUPPRESS_MENU_WINDOW_MS = 250;

export function useMouseGestures(): void {
  const gestureSettings = useSessionStore((s) => s.gestureSettings);

  useEffect(() => {
    if (!gestureSettings.enabled) return;
    const effective = resolveAllGestures(gestureSettings.overrides);
    const triggerButton = gestureSettings.trigger === "middle" ? 1 : 2;

    let armed = false; // trigger button down; stroke not yet past threshold
    let active = false; // stroke passed the start threshold — it's a gesture
    let cancelled = false; // Escape mid-stroke: finish quietly, fire nothing
    let points: GesturePoint[] = [];
    let prevCursor = "";
    let suppressMenuUntil = 0;

    /** Live badge content for a (partial) stroke: arrows + the bound
     *  command's label once it matches. Labels are cached per stroke —
     *  locale/commands/center-pane focus can't change mid-drag (the cache is
     *  cleared at pointerdown for that reason: labels are resolved against
     *  the live state, so a cached one from a stroke in a different context
     *  would go stale). `commandDisplayName` skips the availability filter
     *  so the badge names the command even while it's filtered out (the
     *  stroke then simply won't dispatch, same as the keyboard). */
    const labelCache = new Map<string, string>();
    const badgeFor = (seq: GestureSequence): { text: string; matched: boolean } => {
      const arrows = sequenceToArrows(seq);
      const id = findMatchingGesture(seq, effective);
      if (!id) return { text: arrows, matched: false };
      let label = labelCache.get(id);
      if (label === undefined) {
        const state = useSessionStore.getState();
        label =
          commandDisplayName(id, state.locale, state) ??
          collectCommands(state).find((c) => c.id === id)?.label ??
          id;
        labelCache.set(id, label);
      }
      return { text: `${arrows} · ${label}`, matched: true };
    };

    /* ── transient listeners (attached while armed) ── */

    const onPointerMove = (e: PointerEvent) => {
      if (!armed) return;
      const start = points[0];
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (!active) {
        if (dx * dx + dy * dy < GESTURE_START_THRESHOLD_PX * GESTURE_START_THRESHOLD_PX) return;
        active = true;
        prevCursor = document.body.style.cursor;
        document.body.style.cursor = "crosshair";
      }
      if (points.length < MAX_POINTS) points.push({ x: e.clientX, y: e.clientY });
      else points[points.length - 1] = { x: e.clientX, y: e.clientY };
      drawGestureTrail(points);
      const b = badgeFor(recognizeGesture(points));
      if (b.text) showGestureBadge(b.text, { x: e.clientX, y: e.clientY, matched: b.matched });
    };

    /** Tear the stroke down and report what happened. Restores the cursor,
     *  fades the trail, and (off-mac) opens the menu-suppression window. */
    const endStroke = (): { wasActive: boolean; wasCancelled: boolean; stroke: GesturePoint[] } => {
      const wasActive = active;
      const wasCancelled = cancelled;
      const stroke = points;
      removeTransient();
      armed = false;
      active = false;
      cancelled = false;
      points = [];
      if (wasActive) {
        document.body.style.cursor = prevCursor;
        fadeGestureTrail();
        if (!isMac) suppressMenuUntil = Date.now() + SUPPRESS_MENU_WINDOW_MS;
      }
      return { wasActive, wasCancelled, stroke };
    };

    const onPointerUp = (e: PointerEvent) => {
      if (!armed) return;
      const target = e.target instanceof Element ? e.target : null;
      const start = points[0];
      const seq = active ? recognizeGesture(points) : [];
      // Finalize the badge BEFORE endStroke fades it: the last segment may
      // complete exactly at release, and an unmatched stroke gets the
      // "unrecognized" hint instead of a dangling bare sequence.
      if (active && seq.length > 0) {
        const b = badgeFor(seq);
        const locale = useSessionStore.getState().locale;
        showGestureBadge(
          b.matched ? b.text : `${b.text} · ${translate(locale, "lib.gestures.unrecognized")}`,
          { x: e.clientX, y: e.clientY, matched: b.matched },
        );
      }
      const { wasActive, wasCancelled } = endStroke();

      if (!wasActive) {
        // Plain press, no drag. On macOS the real contextmenu was suppressed
        // at mousedown-time — re-dispatch it synthetically so menus open.
        if (isMac && triggerButton === 2 && target) {
          const cx = start?.x ?? e.clientX;
          const cy = start?.y ?? e.clientY;
          setTimeout(() => {
            target.dispatchEvent(
              new MouseEvent("contextmenu", {
                bubbles: true,
                cancelable: true,
                clientX: cx,
                clientY: cy,
              }),
            );
          }, 0);
        }
        return;
      }
      if (wasCancelled) return;

      const commandId = findMatchingGesture(seq, effective);
      if (!commandId) return; // unmatched stroke: silent no-op
      const state = useSessionStore.getState();
      const cmd = collectCommands(state).find((c) => c.id === commandId);
      if (cmd) void cmd.perform(state);
    };

    const onPointerCancel = () => {
      if (armed) endStroke();
    };
    const onBlur = () => {
      if (armed) endStroke();
    };
    const onDocLeave = () => {
      if (armed) endStroke();
    };

    const removeTransient = () => {
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointercancel", onPointerCancel, true);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("mouseleave", onDocLeave);
    };

    const attachTransient = () => {
      window.addEventListener("pointermove", onPointerMove, true);
      window.addEventListener("pointerup", onPointerUp, true);
      window.addEventListener("pointercancel", onPointerCancel, true);
      window.addEventListener("blur", onBlur);
      document.addEventListener("mouseleave", onDocLeave);
    };

    /* ── permanent listeners (while gestures are enabled) ── */

    const onPointerDown = (e: PointerEvent) => {
      if (!e.isPrimary) return;
      if (e.button !== triggerButton) return;
      // The settings-page gesture recorder owns the pointer while capturing.
      if (useSessionStore.getState().gestureRecording) return;
      const target = e.target;
      if (!(target instanceof Element)) return;
      // Exempt zones keep native behavior (e.g. terminal right-click paste).
      if (target.closest("[data-gesture-exclude]")) return;
      // Never gesture behind an open dialog/modal.
      if (target.closest('[role="dialog"]')) return;

      armed = true;
      active = false;
      cancelled = false;
      points = [{ x: e.clientX, y: e.clientY }];
      suppressMenuUntil = 0;
      labelCache.clear();
      attachTransient();
      // Middle trigger: cancel the pointerdown so Chromium's mousedown-driven
      // autoscroll never starts. Right-button presses pass through untouched.
      if (triggerButton === 1) e.preventDefault();
    };

    const onContextMenu = (e: MouseEvent) => {
      if (active || Date.now() < suppressMenuUntil || (isMac && armed)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (armed && active && e.key === "Escape") {
        cancelled = true;
        e.preventDefault();
        e.stopPropagation();
      }
    };

    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("contextmenu", onContextMenu, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("contextmenu", onContextMenu, true);
      window.removeEventListener("keydown", onKeyDown, true);
      removeTransient();
      // Defensive: a re-subscribe mid-stroke (user edits gesture settings in
      // the panel while gesturing) discards this closure's state — restore
      // the cursor and drop the trail here so they can't outlive it.
      if (active) {
        document.body.style.cursor = prevCursor;
        fadeGestureTrail();
      }
      armed = false;
      active = false;
      cancelled = false;
      points = [];
    };
    // Re-subscribes when the user edits gesture settings; detached entirely
    // while disabled.
  }, [gestureSettings]);
}
