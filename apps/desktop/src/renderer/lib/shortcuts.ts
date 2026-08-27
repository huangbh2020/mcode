/**
 * Keyboard-shortcut core logic — pure functions + the default binding table.
 *
 * An `Accelerator` is a platform-neutral description of a key chord:
 *   { key, cmd, shift, alt }
 * - `key` is the normalized main key: a single lowercase letter ("k"), a digit
 *   ("1"), or a named key ("f1", "space", "escape", "backspace", "enter").
 * - `cmd` is the *primary* modifier. It is stored as `cmd` everywhere; on
 *   macOS it renders and matches as ⌘ (metaKey), while on Windows/Linux it
 *   renders and matches as Ctrl (ctrlKey). This mirrors VS Code / Slack: the
 *   user binds "the platform modifier + K" once and it Just Works everywhere.
 *
 * Only user *overrides* are persisted to the settings DB (see
 * `UI_SHORTCUTS_SETTING_KEY`). The compiled-in `DEFAULT_SHORTCUTS` table is
 * the fallback for any command the user hasn't rebound, so adding a new
 * default in a future version takes effect for everyone automatically while
 * preserving each user's existing overrides.
 */
import type { Accelerator, ShortcutBindings } from "@contracts/ipc";
import { isMac } from "@renderer/lib/platform.js";

/* ──────────────────────── default bindings ──────────────────────── */

/**
 * The built-in shortcut table: commandId → default Accelerator.
 *
 * Keys here are the `CommandDef.id` values from `lib/commands.ts`. Keep this
 * map in sync with the commands that carry a `defaultAccelerator` field —
 * every entry here should have a matching command, and vice versa.
 */
export const DEFAULT_SHORTCUTS: ShortcutBindings = {
  "command.palette": { key: "k", cmd: true, shift: false, alt: false },
  "files.search": { key: "f", cmd: true, shift: true, alt: false },
  "view.settings": { key: ",", cmd: true, shift: false, alt: false },
  "session.new": { key: "n", cmd: true, shift: false, alt: false },
  "layout.toggle-left": { key: "b", cmd: true, shift: false, alt: false },
  "layout.toggle-right": { key: "b", cmd: true, shift: true, alt: false },
  "layout.toggle-bottom-terminal": { key: "`", cmd: true, shift: false, alt: false },
  "layout.toggle-browser": { key: "b", cmd: true, shift: false, alt: true },
  "sidechat.open": { key: "q", cmd: true, shift: true, alt: false },
  "layout.toggle-wide-panel": { key: "b", cmd: true, shift: true, alt: true },
  "view.display-mode.toggle": { key: "t", cmd: true, shift: true, alt: false },
  "appearance.theme.toggle": { key: "l", cmd: true, shift: true, alt: false },
  "tab.close": { key: "w", cmd: true, shift: false, alt: false },
  "chat.focus-input": { key: "n", cmd: true, shift: true, alt: false },
  // Voice dictation. Held for push-to-talk (keyup stops — see
  // useGlobalShortcuts), tapped for continuous mode. ⌘⇧V / Ctrl+Shift+V.
  "voice.dictation": { key: "v", cmd: true, shift: true, alt: false },
  "editor.nav-back": { key: "arrowleft", cmd: false, shift: false, alt: true },
  "editor.nav-forward": { key: "arrowright", cmd: false, shift: false, alt: true },
};

/**
 * Resolve the *effective* binding for a command: the user's override if any,
 * otherwise the default. Returns `null` if the command has no binding at all
 * (neither overridden nor in the default table).
 */
export function resolveShortcut(
  commandId: string,
  overrides: ShortcutBindings,
): Accelerator | null {
  if (overrides[commandId]) return normalizeAccelerator(overrides[commandId]);
  if (DEFAULT_SHORTCUTS[commandId]) return normalizeAccelerator(DEFAULT_SHORTCUTS[commandId]);
  return null;
}

/**
 * Merge defaults + overrides into a single effective map (commandId →
 * Accelerator). Used by the global keydown listener to build a lookup table
 * and by the settings panel to render every bindable command.
 */
export function resolveAllShortcuts(
  overrides: ShortcutBindings,
): Record<string, Accelerator> {
  const out: Record<string, Accelerator> = {};
  for (const [id, accel] of Object.entries(DEFAULT_SHORTCUTS)) {
    out[id] = normalizeAccelerator(accel);
  }
  for (const [id, accel] of Object.entries(overrides)) {
    out[id] = normalizeAccelerator(accel);
  }
  return out;
}

/* ──────────────────────── normalization ──────────────────────── */

/** Defensive normalization: ensure all three modifier flags exist (older
 *  persisted blobs may predate a newly added flag). Mutates a copy. */
function normalizeAccelerator(a: Accelerator): Accelerator {
  return {
    key: String(a.key ?? "").toLowerCase(),
    cmd: !!a.cmd,
    shift: !!a.shift,
    alt: !!a.alt,
  };
}

/* ──────────────────────── serialization ──────────────────────── */

/**
 * Serialize an Accelerator to a compact, stable string for storage/logging:
 * modifiers sorted `cmd > shift > alt` then the key. e.g. `cmd+shift+f`.
 * Round-trips via `parseAcceleratorString`.
 */
export function acceleratorToString(a: Accelerator): string {
  const parts: string[] = [];
  if (a.cmd) parts.push("cmd");
  if (a.shift) parts.push("shift");
  if (a.alt) parts.push("alt");
  parts.push(a.key.toLowerCase());
  return parts.join("+");
}

/** Parse the compact string form back into an Accelerator. Tolerant of
 *  unknown modifiers (ignored) and arbitrary ordering. Returns null if the
 *  string is empty or has no key segment. */
export function parseAcceleratorString(s: string): Accelerator | null {
  const tokens = s.trim().toLowerCase().split("+").map((t) => t.trim()).filter(Boolean);
  if (tokens.length === 0) return null;
  const key = tokens[tokens.length - 1];
  if (!key) return null;
  return {
    key,
    cmd: tokens.includes("cmd") || tokens.includes("ctrl") || tokens.includes("mod"),
    shift: tokens.includes("shift"),
    alt: tokens.includes("alt") || tokens.includes("option") || tokens.includes("opt"),
  };
}

/* ──────────────────────── display ──────────────────────── */

/** Symbol/glyph used to render the primary modifier on the current platform. */
export const MOD_LABEL = isMac ? "⌘" : "Ctrl";
export const SHIFT_LABEL = isMac ? "⇧" : "Shift";
export const ALT_LABEL = isMac ? "⌥" : "Alt";
/** Separator between tokens for display: "" on mac (symbols abut), "+" elsewhere. */
const DISP_SEP = isMac ? "" : "+";

/**
 * Render an Accelerator as an array of display tokens — one per modifier/key —
 * for per-keycap rendering (e.g. `<Kbd keys={...} />` from the UI library).
 * Same glyphs and rules as `acceleratorToDisplayString`, just unjoined so each
 * token can sit in its own keycap.
 */
export function acceleratorToDisplayTokens(a: Accelerator): string[] {
  const parts: string[] = [];
  if (a.cmd) parts.push(MOD_LABEL);
  if (a.shift) parts.push(SHIFT_LABEL);
  if (a.alt) parts.push(ALT_LABEL);
  parts.push(prettyKey(a.key, a.shift));
  return parts;
}

/**
 * Render an Accelerator as a human-readable chord for the current platform.
 * macOS uses symbol glyphs that abut (`⌘⇧F`); other platforms use labeled
 * tokens joined by `+` (`Ctrl+Shift+F`). The key is uppercased for letters
 * when Shift is *not* already part of the chord, so `cmd+k` reads as `⌘K`
 * but `cmd+shift+f` reads as `⌘⇧F` (Shift already conveys casing).
 */
export function acceleratorToDisplayString(a: Accelerator): string {
  return acceleratorToDisplayTokens(a).join(DISP_SEP);
}

/** Render a single raw key token for display. */
function prettyKey(key: string, shiftHeld: boolean): string {
  const k = key.toLowerCase();
  // Single letter / digit: show as-is, uppercased unless Shift is part of
  // the chord (Shift already implies uppercase visually).
  if (/^[a-z0-9]$/.test(k)) return shiftHeld ? k.toUpperCase() : k.toUpperCase();
  switch (k) {
    case "space": return isMac ? "Space" : "Space";
    case "enter": return isMac ? "↵" : "Enter";
    case "escape": return isMac ? "⎋" : "Esc";
    case "backspace": return isMac ? "⌫" : "Backspace";
    case "tab": return isMac ? "⇥" : "Tab";
    case "arrowup": return "↑";
    case "arrowdown": return "↓";
    case "arrowleft": return "←";
    case "arrowright": return "→";
    default:
      return k;
  }
}

/* ──────────────────────── keyboard events ──────────────────────── */

/**
 * Normalize `KeyboardEvent.key` into our canonical `key` token.
 * Letters → lowercase single char; named keys → lowercase name.
 * Returns "" for modifier-only keys (Shift/Cmd/Ctrl/Alt in isolation) since
 * those aren't bindable on their own.
 */
export function normalizeEventKey(e: KeyboardEvent): string {
  const raw = e.key;
  // Pure modifier press (the key IS the modifier, e.g. pressing Shift alone).
  if (raw === "Meta" || raw === "Control" || raw === "Alt" || raw === "Shift") {
    return "";
  }
  if (raw.length === 1) {
    // Single char: letters/digits/punctuation. Lowercase for letters.
    return raw.toLowerCase();
  }
  // Named key. Normalize common ones to lowercase names.
  return raw.toLowerCase();
}

/**
 * Build an Accelerator from a keydown event. Used by the shortcut recorder
 * to capture a user's chord. Returns null if the event is a pure-modifier
 * press (no main key) — the recorder waits for a real key.
 *
 * `cmd` is set when EITHER metaKey or ctrlKey is held, so the same physical
 * gesture (Cmd on mac, Ctrl elsewhere) maps to one logical binding.
 */
export function eventToAccelerator(e: KeyboardEvent): Accelerator | null {
  const key = normalizeEventKey(e);
  if (!key) return null;
  return {
    key,
    cmd: e.metaKey || e.ctrlKey,
    shift: e.shiftKey,
    alt: e.altKey,
  };
}

/**
 * Does a keydown event match an Accelerator? Used by the global listener.
 * Matches when the main key is equal and every modifier flag matches, with
 * `cmd` accepting either metaKey or ctrlKey (platform-neutral).
 */
export function matchAccelerator(e: KeyboardEvent, a: Accelerator): boolean {
  const key = normalizeEventKey(e);
  if (!key || key !== a.key.toLowerCase()) return false;
  const cmd = e.metaKey || e.ctrlKey;
  if (cmd !== a.cmd) return false;
  if (e.shiftKey !== a.shift) return false;
  if (e.altKey !== a.alt) return false;
  return true;
}

/* ──────────────────────── input-source guard ──────────────────────── */

/**
 * Is the event target an editable element where unmodified keys should pass
 * through (so the user can type)? Returns true for `<input>`, `<textarea>`,
 * `[contenteditable]`, Monaco editors (`.monaco-editor`), and xterm
 * terminals (`.xterm`).
 *
 * The global shortcut listener uses this to decide: when the focus is in one
 * of these, only chords that include at least one modifier (cmd/ctrl/alt) are
 * intercepted; bare keys are left for the field to handle. This matches VS
 * Code: Cmd+B works inside the editor, but plain "b" just inserts a "b".
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  // Monaco / xterm host elements.
  if (target.closest(".monaco-editor") || target.closest(".xterm")) return true;
  return false;
}

/**
 * Decide whether a chord should be dispatched when the focus is in an
 * editable element. We allow any chord that carries at least one modifier
 * (cmd/ctrl/alt) — those are reserved for app commands — and let everything
 * else through to the field.
 */
export function shouldDispatchInEditable(a: Accelerator): boolean {
  return a.cmd || a.shift || a.alt;
}

/**
 * Find the commandId whose effective binding matches a keydown event.
 * Returns the first match (conflicts are prevented at record time, so at
 * most one command binds any given chord). Scans the effective map produced
 * by `resolveAllShortcuts`.
 */
export function findMatchingCommand(
  e: KeyboardEvent,
  effective: Record<string, Accelerator>,
): string | null {
  for (const [id, accel] of Object.entries(effective)) {
    if (matchAccelerator(e, accel)) return id;
  }
  return null;
}

/**
 * Detect a conflict: does `accel` collide with any *other* command's
 * effective binding? Returns the colliding commandId, or null if free.
 * Used by the recorder to warn before overwriting.
 */
export function findConflict(
  accel: Accelerator,
  exceptCommandId: string,
  effective: Record<string, Accelerator>,
): string | null {
  const target = acceleratorToString(accel);
  for (const [id, a] of Object.entries(effective)) {
    if (id === exceptCommandId) continue;
    if (acceleratorToString(a) === target) return id;
  }
  return null;
}
