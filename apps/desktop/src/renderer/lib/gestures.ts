/**
 * Mouse-gesture core logic — pure functions + the default binding table.
 * The pointer counterpart to `lib/shortcuts.ts`.
 *
 * A gesture is an Opera-style *direction sequence*: the stroke's raw points
 * are quantized into 8 directions (45° sectors) and consecutive same-direction
 * movements merge, so a slightly wobbly "down then right" stroke reads as
 * ["D","R"] regardless of noise. Matching against the binding table is exact
 * on the serialized sequence; an unmatched gesture is a silent no-op.
 *
 * Bindings target `CommandDef.id` values from `lib/commands.ts` — the same
 * registry the command palette and the keyboard shortcuts consume — so a
 * gesture performs the exact same `perform(state)` as its keyboard twin.
 *
 * Only user *overrides* are persisted (settings key `ui.gestures`); the
 * compiled-in `DEFAULT_GESTURES` below is the fallback, mirroring the
 * shortcuts pipeline.
 */
import type { GestureDirection, GestureSequence, GestureSettings } from "@contracts/ipc";

/* ──────────────────────── tuning constants ──────────────────────── */

/** Pointer must travel this far (px) from the press point before the stroke
 *  becomes a gesture — below it, the press is a plain click and native
 *  behavior (context menu etc.) is untouched. */
export const GESTURE_START_THRESHOLD_PX = 8;

/** Minimum accumulated travel (px) before a direction segment commits. Keeps
 *  jitter and slow drift from slicing one intended stroke into many. */
export const MIN_SEGMENT_PX = 24;

/** Hard cap on segments in one stroke; recognition stops adding beyond this. */
export const MAX_SEGMENTS = 8;

/** Cap on raw sample points kept per stroke (bounds trail + memory on long
 *  drags; recognition only needs segment-scale resolution anyway). */
export const MAX_POINTS = 512;

/* ──────────────────────── default bindings ──────────────────────── */

/**
 * Built-in gesture table: commandId → default direction sequence.
 *
 * All defaults are reversible view/layout actions — deliberately no deletes,
 * archives, rewinds, or sends (a misfired gesture must never destroy work).
 * Note ↓ (terminal) is a prefix of ↓→ / ↓←: releasing early after the first
 * segment fires the single-direction binding — the live badge shows what the
 * stroke currently resolves to before you let go.
 */
export const DEFAULT_GESTURES: Record<string, GestureSequence> = {
  "session.close": ["D", "R"], // ↓→ 关闭当前会话
  "session.new": ["D", "L"], // ↓← 新建会话
  "layout.toggle-bottom-terminal": ["D"], // ↓ 显示/隐藏终端
  "layout.toggle-left": ["L"], // ← 显示/隐藏左侧栏
  "layout.toggle-right": ["R"], // → 显示/隐藏右侧栏
};

/** Store-side default for the whole `ui.gestures` blob. Module-level constant
 *  so the Zustand default keeps a stable reference. */
export const DEFAULT_GESTURE_SETTINGS: GestureSettings = {
  enabled: true,
  trigger: "right",
  overrides: {},
};

/* ──────────────────────── recognition ──────────────────────── */

export interface GesturePoint {
  x: number;
  y: number;
}

/**
 * Sector table for `quantizeDirection`: index = floor((angle+22.5°)/45) mod 8
 * over atan2 in screen coordinates (y grows downward, so positive dy = down).
 */
const SECTOR_DIRS: readonly GestureDirection[] = ["R", "DR", "D", "DL", "L", "UL", "U", "UR"];

/** Quantize a movement vector into one of 8 directions (45° sectors). */
export function quantizeDirection(dx: number, dy: number): GestureDirection {
  const deg = (Math.atan2(dy, dx) * 180) / Math.PI; // −180..180
  const idx = ((Math.floor((deg + 22.5) / 45) % 8) + 8) % 8;
  return SECTOR_DIRS[idx];
}

/**
 * Recognize an ordered stroke into a direction sequence.
 *
 * Walks the points keeping a segment `origin`; once the current point is
 * ≥ MIN_SEGMENT_PX away from it, the direction commits (merging with the
 * previous segment when identical — continued same-direction travel extends
 * it instead of stacking) and the origin advances. Returns [] when the whole
 * stroke stayed under one segment's length.
 */
export function recognizeGesture(points: GesturePoint[]): GestureSequence {
  const segs: GestureDirection[] = [];
  if (points.length < 2) return segs;
  let origin = points[0];
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    const dx = p.x - origin.x;
    const dy = p.y - origin.y;
    if (dx * dx + dy * dy < MIN_SEGMENT_PX * MIN_SEGMENT_PX) continue;
    const dir = quantizeDirection(dx, dy);
    if (segs.length === 0 || segs[segs.length - 1] !== dir) {
      if (segs.length >= MAX_SEGMENTS) break;
      segs.push(dir);
    }
    origin = p;
  }
  return segs;
}

/* ──────────────────────── serialization / display ──────────────────────── */

/** Compact stable form used as the matching key and in persisted JSON. */
export function sequenceToString(seq: GestureSequence): string {
  return seq.join("");
}

const DIR_ARROWS: Record<GestureDirection, string> = {
  L: "←",
  R: "→",
  U: "↑",
  D: "↓",
  UL: "↖",
  UR: "↗",
  DL: "↙",
  DR: "↘",
};

/** Human-readable arrow form ("↓→") for badges and hints. */
export function sequenceToArrows(seq: GestureSequence): string {
  return seq.map((d) => DIR_ARROWS[d]).join("");
}

/* ──────────────────────── binding resolution ──────────────────────── */

/** Effective binding for one command: override if present, else default, else
 *  null (unbound). Mirrors `resolveShortcut`. */
export function resolveGesture(
  commandId: string,
  overrides: Record<string, GestureSequence>,
): GestureSequence | null {
  if (overrides[commandId]) return overrides[commandId];
  if (DEFAULT_GESTURES[commandId]) return DEFAULT_GESTURES[commandId];
  return null;
}

/** Merge defaults + overrides into one effective map (commandId → sequence).
 *  Mirrors `resolveAllShortcuts`. */
export function resolveAllGestures(
  overrides: Record<string, GestureSequence>,
): Record<string, GestureSequence> {
  return { ...DEFAULT_GESTURES, ...overrides };
}

/**
 * Find the commandId whose effective sequence exactly matches `seq`.
 * Returns null when the stroke matches nothing (silent no-op).
 */
export function findMatchingGesture(
  seq: GestureSequence,
  effective: Record<string, GestureSequence>,
): string | null {
  const key = sequenceToString(seq);
  if (!key) return null;
  for (const [id, s] of Object.entries(effective)) {
    if (sequenceToString(s) === key) return id;
  }
  return null;
}

/**
 * Detect a conflict: does `seq` collide with any *other* command's effective
 * binding? Returns the colliding commandId, or null if free. Used by the
 * gesture recorder to warn before overwriting.
 */
export function findGestureConflict(
  seq: GestureSequence,
  exceptCommandId: string,
  effective: Record<string, GestureSequence>,
): string | null {
  const key = sequenceToString(seq);
  if (!key) return null;
  for (const [id, s] of Object.entries(effective)) {
    if (id === exceptCommandId) continue;
    if (sequenceToString(s) === key) return id;
  }
  return null;
}
