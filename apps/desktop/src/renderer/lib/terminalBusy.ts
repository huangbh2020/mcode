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
 *  - EXTERNAL SUSTAIN: the CLI's own status bar advertises background work
 *    ("1 task(s)" in claude's footer — a Bash command it keeps tracking
 *    after the turn ended). While that signal is on, busy is held true no
 *    matter what the Enter/quiet bookkeeping says, and it also RAISES busy
 *    with no Enter at all (a task outliving its turn — the spinner must
 *    not die just because the output stream went quiet). When the signal
 *    drops, busy ends after one QUIET_MS grace counted from the drop: the
 *    task-completion footer redraw does NOT refresh lastOutputAt
 *    (output() ignores chunks while disarmed), so the drop timestamp is
 *    the only fresh clock available.
 *
 * Honest limits: a foreground shell command's output with >QUIET_MS stalls
 * flickers the spinner off mid-command (the footer signal covers commands
 * the CLI tracks as tasks; untracked foreground commands still flicker);
 * and a turn whose CLI redraws less often than QUIET_MS would too (none
 * observed — ink redraws are ~10Hz). This also runs for plain shell usage,
 * where "command producing output" reading as busy is arguably correct.
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
  /** External "work is verifiably still running" signal (the host scans
   *  the terminal footer for the CLI's task indicator each tick). */
  sustain(active: boolean, now: number): void;
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
  let sustained = false;
  let sustainedDroppedAt = 0;

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
    sustain(active, now) {
      if (active === sustained) return;
      sustained = active;
      if (!active) sustainedDroppedAt = now;
    },
    tick(now) {
      if (sustained) {
        // Work is verifiably running — hold busy and ignore the Enter/quiet
        // bookkeeping (a task started by an earlier turn must not be ended
        // by the quiet window, and an Enter that produces no output must
        // not pre-arm-cancel while something is actually running).
        armed = false;
        setBusy(true);
        return;
      }
      if (emitted && !armed) {
        // Busy was held by sustain and the signal just dropped — honor the
        // quiet window from the drop before ending.
        if (now - sustainedDroppedAt > BUSY_QUIET_MS) setBusy(false);
        return;
      }
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
      sustained = false;
      setBusy(false);
    },
  };
}

/** The claude CLI's status bar advertises work it keeps tracking after the
 *  turn's output went quiet: `… · 1 task(s) · /ta…` (bottom-right). The host
 *  feeds the last few VIEWPORT lines (the chrome, not the transcript body —
 *  prose saying "3 tasks" mid-transcript must never hold the spinner) into
 *  this predicate; N ≥ 1 sustains busy. Format-coupled to the CLI's TUI by
 *  nature (terminal sessions have no structured protocol); other CLIs
 *  simply never match and keep the pure output-quiet behavior. */
export function footerIndicatesRunningTasks(lines: string[]): boolean {
  for (const line of lines) {
    const m = line.match(/(\d+)\s+tasks?\b/i);
    if (m && Number(m[1]) >= 1) return true;
  }
  return false;
}

/**
 * Broader "the turn's chrome still shows live work" scan — the DURING-turn
 * sibling of {@link footerIndicatesRunningTasks}. A foreground command or a
 * file-read stretch can leave the PTY stream silent past BUSY_QUIET_MS (the
 * command produces no output and the spinner line sits as a static frame),
 * which drops the spinner while the turn is objectively still running. The
 * chrome keeps EPHEMERAL activity hints on screen for exactly those phases:
 *
 *  - `esc to interrupt` — claude's turn-active hint; present only while a
 *    turn is in flight, gone the moment it ends (idle chrome shows
 *    "? for shortcuts" etc.).
 *  - `esc interrupt` — opencode's footer pill for the same phase (its
 *    idle footer shows `ctrl+p commands` instead; the pills render
 *    key + verb with no "to", so the claude hint never collides).
 *  - `esc to cancel` — agy's (Antigravity CLI) turn-active footer
 *    ("esc to cancel" + model name); idle swaps it for "? for
 *    shortcuts". This footer is the ONLY in-window during-turn signal
 *    agy renders: its spinner caption ("⢿  Running command...") sits
 *    ~8 rows above the buffer end (input box + footer + trailing blank
 *    rows), outside the six-row window the host scans — so a silent
 *    stretch that produces no caption output (file reads, long thinks)
 *    must be held by the footer alone (2026-10-27: the reported "reads
 *    drop the spinner" session was agy).
 *  - `Running command…` — the foreground-command spinner caption.
 *  - the `N task(s)` footer indicator (delegated).
 *
 * EPHEMERALITY is the load-bearing property: a hint that vanished when the
 * work ended can never stick the spinner on a dead turn — which is why the
 * PERSISTENT transcript lines ("Ran (…)", "Explored 3 files") are deliberately
 * NOT markers: they survive the turn and would hold the spinner forever.
 * Soft-wrapped rows can split a marker mid-phrase, so the rows are also
 * scanned joined (no separator). CLIs whose chrome lacks these strings keep
 * the pure output-quiet behavior.
 */
export function screenIndicatesActivity(lines: string[]): boolean {
  if (footerIndicatesRunningTasks(lines)) return true;
  const joined = lines.join("").toLowerCase();
  return (
    joined.includes("esc to interrupt") ||
    joined.includes("esc interrupt") ||
    joined.includes("esc to cancel") ||
    joined.includes("running command")
  );
}
