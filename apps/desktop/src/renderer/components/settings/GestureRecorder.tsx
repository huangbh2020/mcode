/**
 * GestureRecorder — the capture control for one mouse-gesture binding.
 * The pointer twin of ShortcutRecorder.
 *
 * Three visual states:
 *   idle      — shows the effective gesture as an arrow badge ("↓→") + a
 *               "修改" button (and "恢复默认" when the user has overridden it).
 *   recording — waits for the next trigger-button drag, shows a pulsing hint;
 *               captures the stroke with the same recognizer the global
 *               listener uses. Esc cancels.
 *   conflict  — the captured sequence is already bound to another command;
 *               shows a "已被【X】占用,是否覆盖?" prompt with 确认/取消.
 *
 * While active it mirrors the target commandId into the store's
 * `gestureRecording` sentinel so the global gesture listener stands down
 * (a stroke records instead of dispatching), and installs window CAPTURE
 * listeners that swallow every related event — including contextmenu, so a
 * right-button stroke never opens a menu, and keydown, so Esc doesn't also
 * close the whole settings page (same isolation trick as ShortcutRecorder).
 */
import { useCallback, useEffect, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { Button } from "@renderer/components/ui/index.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { collectCommands } from "@renderer/lib/commands.js";
import { drawGestureTrail, fadeGestureTrail, showGestureBadge } from "@renderer/lib/gestureTrail.js";
import {
  MAX_POINTS,
  findGestureConflict,
  recognizeGesture,
  resolveAllGestures,
  resolveGesture,
  sequenceToArrows,
  type GesturePoint,
} from "@renderer/lib/gestures.js";
import type { GestureSequence } from "@contracts/ipc";
import { IconRefresh, IconCheck } from "@renderer/lib/icons.js";

type Mode = "idle" | "recording" | "conflict";

export function GestureRecorder({ commandId }: { commandId: string }) {
  const { t } = useI18n();
  const gestureSettings = useSessionStore((s) => s.gestureSettings);
  const setGestureOverride = useSessionStore((s) => s.setGestureOverride);
  const setGestureRecording = useSessionStore((s) => s.setGestureRecording);

  const effective = resolveGesture(commandId, gestureSettings.overrides);
  const hasOverride = !!gestureSettings.overrides[commandId];

  const [mode, setMode] = useState<Mode>("idle");
  const [pending, setPending] = useState<GestureSequence | null>(null);
  const [conflictLabel, setConflictLabel] = useState<string>("");

  // Mirror the active (non-idle) state into the store's `gestureRecording`
  // sentinel so the global gesture listener knows to stand down.
  useEffect(() => {
    setGestureRecording(mode !== "idle" ? commandId : null);
    return () => setGestureRecording(null);
  }, [mode, commandId, setGestureRecording]);

  const startRecording = useCallback(() => {
    setPending(null);
    setConflictLabel("");
    setMode("recording");
  }, []);

  /** Commit a captured stroke. Detects conflicts first; on conflict it enters
   *  the `conflict` state and waits for the user to confirm. */
  const commit = useCallback(
    (seq: GestureSequence) => {
      const all = resolveAllGestures(gestureSettings.overrides);
      const conflictId = findGestureConflict(seq, commandId, all);
      if (conflictId) {
        const cmd = collectCommands(useSessionStore.getState()).find(
          (c) => c.id === conflictId,
        );
        setConflictLabel(cmd?.label ?? conflictId);
        setPending(seq);
        setMode("conflict");
      } else {
        setGestureOverride(commandId, seq);
        setMode("idle");
      }
    },
    [commandId, gestureSettings.overrides, setGestureOverride],
  );

  /** Confirm an overwrite: clear the other command's override first (it falls
   *  back to its default or to unbound), then bind this command. */
  const confirmOverwrite = useCallback(() => {
    if (!pending) return;
    const all = resolveAllGestures(gestureSettings.overrides);
    const conflictId = findGestureConflict(pending, commandId, all);
    if (conflictId) setGestureOverride(conflictId, null);
    setGestureOverride(commandId, pending);
    setPending(null);
    setConflictLabel("");
    setMode("idle");
  }, [commandId, gestureSettings.overrides, pending, setGestureOverride]);

  const cancel = useCallback(() => {
    setPending(null);
    setConflictLabel("");
    setMode("idle");
  }, []);

  // The capture-phase listeners. Active only while recording OR in the
  // conflict state (so Esc can dismiss the conflict prompt too). The stroke
  // capture reads the trigger button fresh from the store at pointerdown so a
  // mid-recording trigger switch is respected.
  useEffect(() => {
    if (mode === "idle") return;
    const button =
      useSessionStore.getState().gestureSettings.trigger === "middle" ? 1 : 2;
    let pts: GesturePoint[] = [];
    let dragging = false;

    const onDown = (e: PointerEvent) => {
      if (!e.isPrimary || e.button !== button) return;
      e.preventDefault();
      e.stopPropagation();
      dragging = true;
      pts = [{ x: e.clientX, y: e.clientY }];
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      e.preventDefault();
      e.stopPropagation();
      if (pts.length < MAX_POINTS) pts.push({ x: e.clientX, y: e.clientY });
      else pts[pts.length - 1] = { x: e.clientX, y: e.clientY };
      drawGestureTrail(pts);
      // Live arrows-only badge so the user sees what they're drawing while
      // re-recording (no command label — a match here would be misleading).
      const arrows = sequenceToArrows(recognizeGesture(pts));
      if (arrows) showGestureBadge(arrows, { x: e.clientX, y: e.clientY, matched: false });
    };
    const onUp = (e: PointerEvent) => {
      if (!dragging) return;
      e.preventDefault();
      e.stopPropagation();
      dragging = false;
      fadeGestureTrail();
      const seq = recognizeGesture(pts);
      // [] = press without a real stroke — keep waiting for a proper drag.
      if (seq.length === 0) return;
      commit(seq);
    };
    // Swallow menus for the whole capture (right-button strokes must never
    // open a context menu, on any platform's firing order).
    const onCtx = (e: MouseEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    const onKey = (e: KeyboardEvent) => {
      // Always swallow the event while the recorder is open — we don't want
      // Esc to close the settings page underneath, and typing must not leak
      // into fields while a chord-like capture is pending.
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") cancel();
    };

    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("contextmenu", onCtx, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("contextmenu", onCtx, true);
      window.removeEventListener("keydown", onKey, true);
      fadeGestureTrail();
    };
  }, [mode, cancel, commit]);

  if (mode === "conflict") {
    return (
      <div className="flex items-center gap-2">
        <span className="text-[0.7857em] text-accent">
          {t("settings.gestures.conflict", { label: conflictLabel })}
        </span>
        <Button variant="primary" size="sm" onClick={confirmOverwrite}>
          <IconCheck size={11} />
          {t("settings.gestures.overwrite")}
        </Button>
        <Button variant="ghost" size="sm" onClick={cancel}>
          {t("common.cancel")}
        </Button>
      </div>
    );
  }

  if (mode === "recording") {
    return (
      <div className="flex items-center gap-2">
        <kbd
          className={cn(
            "rounded border border-accent bg-accent/10 px-2 py-1",
            "text-[0.7857em] text-accent animate-pulse",
          )}
        >
          {t("settings.gestures.recordingHint")}
        </kbd>
        <Button variant="ghost" size="sm" onClick={cancel}>
          {t("common.cancel")}
        </Button>
      </div>
    );
  }

  // idle
  return (
    <div className="flex items-center gap-2">
      {effective ? (
        <span
          className={cn(
            "rounded border border-edge bg-surface px-2 py-0.5",
            "text-[0.7857em] font-medium tracking-widest text-accent",
          )}
          title={t("settings.gestures.resetTitle")}
        >
          {sequenceToArrows(effective)}
        </span>
      ) : (
        <span className="text-[0.7857em] text-content-subtle">
          {t("settings.gestures.unbound")}
        </span>
      )}
      <Button variant="outline" size="sm" onClick={startRecording}>
        {t("settings.gestures.modify")}
      </Button>
      {hasOverride && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setGestureOverride(commandId, null)}
          title={t("settings.gestures.resetTitle")}
          className="gap-1 px-1.5"
        >
          <IconRefresh size={11} />
          {t("settings.gestures.reset")}
        </Button>
      )}
    </div>
  );
}
