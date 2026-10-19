/**
 * Terminal "model processing" detector — the TTY has no structured
 * turn signal, but the physical signal is reliable: while a CLI TUI is
 * processing (spinner frames, thinking-status redraws, streaming tokens),
 * it EMITS output continuously; when the turn ends the stream goes quiet.
 *
 * State machine (deterministic, clock injected for testability):
 *  - ARM on user Enter ("\r" in pty input) → busy=true immediately (the
 *    model starts working; the spinner belongs on right away).
 *  - PRE-ARM CANCEL: an Enter that produces NO output within PRE_ARM_MS
 *    (empty line, no-op confirm) disarms quietly.
 *  - SUSTAIN: output chunks refresh the activity timestamp.
 *  - END: QUIET_MS with no output → busy=false. Typing echo afterwards
 *    does NOT re-arm — only the next Enter does (post-turn typing must not
 *    resurrect the spinner).
 *
 * Honest limits: a foreground shell command's output with >QUIET_MS stalls
 * flickers the spinner off mid-command; and a turn whose CLI redraws less
 * often than QUIET_MS would too (none observed — ink redraws are ~10Hz).
 * This also runs for plain shell usage, where "command producing output"
 * reading as busy is arguably correct.
 */

/** Enter that produced no output within this window disarms (no-op enter). */
export const BUSY_PRE_ARM_MS = 700;
/** Output silence that long ends the busy phase. */
export const BUSY_QUIET_MS = 1500;

export interface BusyDetector {
  /** PTY input from the user (only "\r" arms). */
  userInput(data: string, now: number): void;
  /** A PTY output chunk (sustains an armed phase). */
  output(chunk: string, now: number): void;
  /** Periodic evaluation (caller drives the clock, ~500ms cadence). */
  tick(now: number): void;
  /** Force-idle (process exited / view torn down). */
  reset(): void;
}

export function createBusyDetector(onChange: (busy: boolean) => void): BusyDetector {
  let armed = false;
  let sawOutput = false;
  let armedAt = 0;
  let lastOutputAt = 0;
  let emitted = false;

  function setBusy(next: boolean): void {
    if (emitted === next) return;
    emitted = next;
    onChange(next);
  }

  return {
    userInput(data, now) {
      if (!data.includes("\r")) return;
      armed = true;
      sawOutput = false;
      armedAt = now;
      lastOutputAt = now;
      setBusy(true);
    },
    output(_chunk, now) {
      if (!armed) return;
      sawOutput = true;
      lastOutputAt = now;
    },
    tick(now) {
      if (!armed) return;
      if (!sawOutput && now - armedAt > BUSY_PRE_ARM_MS) {
        armed = false;
        setBusy(false);
        return;
      }
      if (sawOutput && now - lastOutputAt > BUSY_QUIET_MS) {
        armed = false;
        setBusy(false);
      }
    },
    reset() {
      armed = false;
      setBusy(false);
    },
  };
}
