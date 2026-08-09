/**
 * ShortcutRecorder — the capture control for one keyboard shortcut.
 *
 * Three visual states:
 *   idle      — shows the current effective chord as <kbd> tokens + a
 *               "修改" button (and "恢复默认" when the user has overridden it).
 *   recording — waits for the next keydown, shows "按下组合键…", captures
 *               the chord via `eventToAccelerator`. Esc cancels.
 *   conflict  — the captured chord is already used by another command;
 *               shows a "已被【X】占用,是否覆盖?" prompt with 确认/取消.
 *
 * The recorder installs its keydown listener on `window` in the CAPTURE
 * phase and calls `stopPropagation()` on every event while active. This is
 * critical: without it, the SettingsPage's Esc-to-close listener (also on
 * `window`) would close the whole settings page the moment the user presses
 * Esc to cancel recording, and the global shortcut listener would fire the
 * bound command mid-recording. Capture + stopPropagation isolates the
 * recorder from both.
 */
import { useCallback, useEffect, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { Button, Kbd } from "@renderer/components/ui/index.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import {
  resolveShortcut,
  resolveAllShortcuts,
  eventToAccelerator,
  acceleratorToDisplayTokens,
  findConflict,
} from "@renderer/lib/shortcuts.js";
import { collectCommands } from "@renderer/lib/commands.js";
import type { Accelerator } from "@contracts/ipc";
import { IconRefresh, IconCheck } from "@renderer/lib/icons.js";

type Mode = "idle" | "recording" | "conflict";

export function ShortcutRecorder({ commandId }: { commandId: string }) {
  const overrides = useSessionStore((s) => s.shortcutOverrides);
  const setShortcutOverride = useSessionStore((s) => s.setShortcutOverride);

  const effective = resolveShortcut(commandId, overrides);
  const hasOverride = !!overrides[commandId];

  const [mode, setMode] = useState<Mode>("idle");
  const [pending, setPending] = useState<Accelerator | null>(null);
  const [conflictLabel, setConflictLabel] = useState<string>("");
  const setShortcutRecording = useSessionStore((s) => s.setShortcutRecording);

  // Mirror the active (non-idle) state into the store's `shortcutRecording`
  // sentinel so the global keydown listener knows to stand down — otherwise a
  // bound chord pressed mid-recording would fire its command too.
  useEffect(() => {
    setShortcutRecording(mode !== "idle");
    return () => setShortcutRecording(false);
  }, [mode, setShortcutRecording]);

  /** Begin recording. Clears any prior pending chord. */
  const startRecording = useCallback(() => {
    setPending(null);
    setConflictLabel("");
    setMode("recording");
  }, []);

  /** Commit a captured chord. Detects conflicts first; on conflict it enters
   *  the `conflict` state and waits for the user to confirm. */
  const commit = useCallback(
    (accel: Accelerator) => {
      const all = resolveAllShortcuts(overrides);
      const conflictId = findConflict(accel, commandId, all);
      if (conflictId) {
        // Resolve the colliding command's label for the prompt.
        const cmd = collectCommands(useSessionStore.getState()).find(
          (c) => c.id === conflictId,
        );
        setConflictLabel(cmd?.label ?? conflictId);
        setPending(accel);
        setMode("conflict");
      } else {
        setShortcutOverride(commandId, accel);
        setMode("idle");
      }
    },
    [commandId, overrides, setShortcutOverride],
  );

  /** Confirm an overwrite: clear the other command's override first (so it
   *  falls back to default or to "no binding"), then bind this command. */
  const confirmOverwrite = useCallback(() => {
    if (!pending) return;
    const all = resolveAllShortcuts(overrides);
    const conflictId = findConflict(pending, commandId, all);
    if (conflictId) {
      // Clear the colliding command's override. If it had no default, it ends
      // up unbound; if it had a default, it reverts to that. Either way the
      // new chord is freed for this command.
      setShortcutOverride(conflictId, null);
    }
    setShortcutOverride(commandId, pending);
    setPending(null);
    setConflictLabel("");
    setMode("idle");
  }, [commandId, overrides, pending, setShortcutOverride]);

  const cancel = useCallback(() => {
    setPending(null);
    setConflictLabel("");
    setMode("idle");
  }, []);

  // The capture-phase listener. Active only while recording OR in the
  // conflict state (so Esc can dismiss the conflict prompt too). It must run
  // before every other keydown handler in the app, hence capture + window.
  useEffect(() => {
    if (mode === "idle") return;
    const onKey = (e: KeyboardEvent) => {
      // Always swallow the event while the recorder is open — we don't want
      // the chord to also trigger a global shortcut or close the settings page.
      e.preventDefault();
      e.stopPropagation();

      if (e.key === "Escape") {
        cancel();
        return;
      }
      // In `conflict` mode we only care about Esc (handled above); any other
      // key is swallowed but ignored so the prompt stays until the user picks.
      if (mode !== "recording") return;

      const accel = eventToAccelerator(e);
      if (!accel) return; // pure modifier press — keep waiting for the main key.

      // Require at least one modifier; bare keys are not bindable (they'd
      // collide with typing). Show the conflict/idle flow otherwise.
      if (!accel.cmd && !accel.alt) {
        // Shift-only or no modifier: ignore, keep recording.
        return;
      }
      commit(accel);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [mode, cancel, commit]);

  if (mode === "conflict") {
    return (
      <div className="flex items-center gap-2">
        <span className="text-[0.7857em] text-accent">
          已被「{conflictLabel}」占用
        </span>
        <Button variant="primary" size="sm" onClick={confirmOverwrite}>
          <IconCheck size={11} />
          覆盖
        </Button>
        <Button variant="ghost" size="sm" onClick={cancel}>
          取消
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
          按下组合键…
        </kbd>
        <Button variant="ghost" size="sm" onClick={cancel}>
          取消
        </Button>
      </div>
    );
  }

  // idle
  return (
    <div className="flex items-center gap-2">
      {effective ? (
        <Kbd keys={acceleratorToDisplayTokens(effective)} size="xs" />
      ) : (
        <span className="text-[0.7857em] text-content-subtle">未绑定</span>
      )}
      <Button variant="outline" size="sm" onClick={startRecording}>
        修改
      </Button>
      {hasOverride && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShortcutOverride(commandId, null)}
          title="恢复为默认快捷键"
          className="gap-1 px-1.5"
        >
          <IconRefresh size={11} />
          恢复默认
        </Button>
      )}
    </div>
  );
}
