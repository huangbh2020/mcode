/**
 * Global keyboard-shortcut listener — the runtime counterpart to the static
 * command registry in `lib/commands.ts`.
 *
 * Mount once at the App root (`useGlobalShortcuts()`). It subscribes to the
 * store's `shortcutOverrides`, merges them with `DEFAULT_SHORTCUTS` into an
 * effective binding map, and registers a single `window` keydown listener
 * (capture phase, so it runs before the chat components' `document` capture
 * listeners and wins races on shared chords).
 *
 * Dispatch rules:
 *  - The first command whose effective chord matches the event wins (conflicts
 *    are prevented at record time, so there's at most one).
 *  - When the focus is in an editable element (input / textarea / contenteditable
 *    / Monaco / xterm), only chords that carry at least one modifier are
 *    dispatched — bare keys pass through so typing still works. This mirrors
 *    VS Code: Cmd+B works inside the editor, but plain "b" inserts a "b".
 *  - Available commands are filtered via `collectCommands(state)` so a chord
 *    bound to an unavailable action (e.g. "close tab" with no tabs open) is
 *    ignored rather than firing a no-op.
 *
 * The effect re-subscribes whenever `shortcutOverrides` changes, so rebinding
 * a chord in settings takes effect on the very next keydown.
 */
import { useEffect } from "react";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { collectCommands } from "@renderer/lib/commands.js";
import { voiceHandleFor } from "@renderer/lib/voiceController.js";
import {
  resolveAllShortcuts,
  findMatchingCommand,
  isEditableTarget,
  shouldDispatchInEditable,
} from "@renderer/lib/shortcuts.js";

export function useGlobalShortcuts(): void {
  const overrides = useSessionStore((s) => s.shortcutOverrides);

  useEffect(() => {
    // Build the effective map fresh on every (re)subscribe. Cheap: a dozen
    // entries, rebuilt only when the user rebinds something.
    const effective = resolveAllShortcuts(overrides);

    const onKey = (e: KeyboardEvent) => {
      // While the shortcut recorder is capturing a chord, yield completely —
      // its own capture listener consumes the event. Without this, pressing a
      // bound chord mid-recording would both record it AND fire its command.
      if (useSessionStore.getState().shortcutRecording) return;

      // Auto-repeat (holding the key down) must not re-fire toggle commands —
      // especially voice.dictation, whose chord is HELD for push-to-talk.
      if (e.repeat) return;

      const commandId = findMatchingCommand(e, effective);
      if (!commandId) return;

      // Input-source guard: if the user is typing, only intercept chords that
      // include a modifier. Bare keys always pass through to the field.
      if (isEditableTarget(e.target)) {
        const accel = effective[commandId];
        if (accel && !shouldDispatchInEditable(accel)) return;
      }

      const state = useSessionStore.getState();
      const cmd = collectCommands(state).find((c) => c.id === commandId);
      if (!cmd) return; // bound to a command that's currently filtered out

      // Consume the event so it doesn't also reach a capture listener below
      // (e.g. ApprovalPrompt's Esc handler) or trigger browser defaults.
      e.preventDefault();
      e.stopPropagation();
      void cmd.perform(state);
    };

    // Release half of the voice.dictation chord: in push-to-talk mode,
    // letting go of the chord stops the listen (hold chord = hold the talk
    // button). Continuous mode ignores keyup — its toggle is press-press.
    //
    // Besides the full chord match, ALSO stop when just the MAIN key is
    // released: users routinely release a modifier a beat earlier, and that
    // keyup (e.g. "v" with Cmd+Shift already gone) matches no chord — without
    // this fallback the mic would keep recording until the next full press.
    const onKeyUp = (e: KeyboardEvent) => {
      if (useSessionStore.getState().shortcutRecording) return;
      const commandId = findMatchingCommand(e, effective);
      const dictationKey = effective["voice.dictation"]?.key ?? "v";
      const releasedDictationKey =
        commandId !== "voice.dictation" &&
        e.key.toLowerCase() === dictationKey;
      if (commandId !== "voice.dictation" && !releasedDictationKey) return;
      const state = useSessionStore.getState();
      if (state.voiceInputMode !== "pushToTalk") return;
      const sid = state.activeSessionId;
      const handle = sid ? voiceHandleFor(sid) : undefined;
      if (handle?.isBusy()) {
        e.preventDefault();
        void handle.stopListen();
      }
    };

    // capture phase: runs before document-level capture listeners registered
    // by chat pickers, so our modifier chords always win.
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKeyUp, true);
    };
  }, [overrides]);
}
