/**
 * Mouse-gesture core logic — pure functions + the default binding table.
 * The pointer counterpart to `lib/shortcuts.ts`.
 *
 * A gesture is an Opera-style *direction sequence*: the stroke's raw points
 * are quantized into 8 directions with cardinal-tolerance cones (a hand-drawn
 * stroke never stays inside a symmetric 45° sector, so cardinals accept ±30°
 * of wobble and diagonals take the narrow remainder), and consecutive
 * same-direction movements merge, so a wobbly "down then right" stroke reads
 * as ["D","R"] regardless of noise. Matching against the binding table is
 * exact on the serialized sequence; an unmatched gesture is a silent no-op.
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

/** Travel (px) required before the press-anchored FIRST segment commits (and
 *  before a segment re-commits after a cone-exit rewind — both judge a net
 *  vector whose wobble share shrinks as it grows). Deliberately larger than
 *  `MIN_SEGMENT_PX`: a short net vector proportionally amplifies hand wobble
 *  and locks in a wrong direction the rest of the stroke can't correct (and
 *  a bigger first-step bar is exactly what stops an accidental twitch from
 *  firing the single-stroke ←/→ bindings). */
export const FIRST_SEGMENT_PX = 40;

/** How far off a cardinal axis (±deg) a stroke may wander and still read as
 *  that cardinal. A hand-drawn stroke is never ruler-straight — users cannot
 *  hold a symmetric 45°-sector boundary — so the cardinal cone is a generous
 *  ±30° (vs ±22.5° for a symmetric 8-sector split) and diagonals get the
 *  narrow 30°-wide band in between. Every default binding is cardinal, so
 *  the tolerance is biased that way deliberately. */
export const CARDINAL_TOLERANCE_DEG = 30;

/** How close (px, perpendicular) a sample must hug the current segment's
 *  axis to count as "still on the path". The path tracker freezes at the
 *  last on-path sample when the stroke departs, so a turn is measured from
 *  the corner, not from the segment's start. */
export const PATH_EPS_PX = 12;

/** A new segment commits only when recent travel (measured from the last
 *  on-path sample) points more than this far off the current direction's
 *  axis. Shallower departures are wobble — a small bump or drift that
 *  curves back — and are forgiven instead of splitting the stroke. */
export const TURN_ANGLE_DEG = 45;

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
  "session.close": ["D", "R"], // ↓→ 关闭当前会话(编辑器聚焦时先关文件/计划)
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
 * Quantize a movement vector into one of 8 directions, with cardinal
 * tolerance: within ±`CARDINAL_TOLERANCE_DEG` of a cardinal axis the
 * cardinal wins; only the narrow band in between reads as a diagonal.
 * Measured via atan2 of the absolute components so the fold is symmetric
 * across all four quadrants.
 */
export function quantizeDirection(dx: number, dy: number): GestureDirection {
  const offHorizontal = (Math.atan2(Math.abs(dy), Math.abs(dx)) * 180) / Math.PI; // 0..90
  if (offHorizontal <= CARDINAL_TOLERANCE_DEG) return dx >= 0 ? "R" : "L";
  if (offHorizontal >= 90 - CARDINAL_TOLERANCE_DEG) return dy >= 0 ? "D" : "U";
  return dx >= 0 ? (dy >= 0 ? "DR" : "UR") : (dy >= 0 ? "DL" : "UL");
}

/** Unit vector along each direction's axis — used for path/perpendicular
 *  tracking and turn-angle tests. Diagonals are un-normalized; the helpers
 *  below normalize before use. */
const AXIS_UV: Record<GestureDirection, GesturePoint> = {
  R: { x: 1, y: 0 },
  L: { x: -1, y: 0 },
  U: { x: 0, y: -1 },
  D: { x: 0, y: 1 },
  UR: { x: 1, y: -1 },
  DR: { x: 1, y: 1 },
  DL: { x: -1, y: 1 },
  UL: { x: -1, y: -1 },
};

/** Perpendicular distance from the ray `a + t·dir` (clamped at `a`: a point
 *  behind the anchor measures its full distance, so a reversal reads as
 *  leaving the path). */
function perpDistance(p: GesturePoint, a: GesturePoint, dir: GesturePoint): number {
  const len = Math.hypot(dir.x, dir.y);
  const ux = dir.x / len;
  const uy = dir.y / len;
  const vx = p.x - a.x;
  const vy = p.y - a.y;
  const t = vx * ux + vy * uy;
  if (t <= 0) return Math.hypot(vx, vy);
  return Math.hypot(vx - t * ux, vy - t * uy);
}

/** Angle (deg) between vector (vx,vy) and axis `dir`. */
function angleOff(vx: number, vy: number, dir: GesturePoint): number {
  const len = Math.hypot(vx, vy) * Math.hypot(dir.x, dir.y);
  if (len === 0) return 180;
  const cos = (vx * dir.x + vy * dir.y) / len;
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
}

/**
 * Recognize an ordered stroke into a direction sequence — tolerant of
 * hand-drawn imprecision. Three cooperating mechanisms, one per failure
 * mode of the naive "re-quantize every MIN_SEGMENT_PX" walk:
 *
 *  1. Anchored continuation — a committed segment keeps its anchor at the
 *     segment start; later samples CONTINUE it while the vector from the
 *     anchor still quantizes the same (inside the cardinal cone). Lateral
 *     wobble cancels out in that net vector instead of being re-judged
 *     window by window, so one slightly-curved stroke stays one segment.
 *
 *  2. Local hard-turn trigger — a perpendicular corner after a dominant
 *     first leg (↓100 then →50) never leaves the first leg's cone as seen
 *     from its anchor, so turns are ALSO watched locally: when travel since
 *     the last on-path sample exceeds `MIN_SEGMENT_PX` at more than
 *     `TURN_ANGLE_DEG` off the current axis, the new direction commits and
 *     the anchor moves to that corner (`PATH_EPS_PX` defines "on-path").
 *
 *  3. Corner rewind on cone exit — when the from-anchor vector DOES leave
 *     the cone (e.g. a slanted first leg followed by a clear turn), the
 *     anchor rewinds to the sample furthest along the old axis — the
 *     stroke's extreme point in that direction — so the new segment measures
 *     its own travel from the turn rather than inheriting the old leg.
 */
export function recognizeGesture(points: GesturePoint[]): GestureSequence {
  const segs: GestureDirection[] = [];
  if (points.length < 2) return segs;
  let anchorIdx = 0; // where the current segment started measuring
  let baseIdx = 0; // last sample still on the current segment's path
  let curDir: GestureDirection | null = null;
  let i = 1;
  while (i < points.length) {
    const p = points[i];
    const a = points[anchorIdx];
    const dx = p.x - a.x;
    const dy = p.y - a.y;

    if (curDir !== null) {
      const u = AXIS_UV[curDir];
      // (2) local hard turn — measured from the last on-path sample so a
      // short leg after a dominant one still reads as a turn.
      const b = points[baseIdx];
      const bx = p.x - b.x;
      const by = p.y - b.y;
      if (
        Math.hypot(bx, by) >= MIN_SEGMENT_PX &&
        angleOff(bx, by, u) > TURN_ANGLE_DEG
      ) {
        if (segs.length >= MAX_SEGMENTS) break;
        const nd = quantizeDirection(bx, by);
        segs.push(nd);
        curDir = nd;
        anchorIdx = baseIdx; // the new segment measures from the corner
        baseIdx = i;
        i++;
        continue;
      }
      // Still on the path: the tracker rides along (frozen otherwise, so
      // turn travel keeps accumulating from the departure point).
      if (perpDistance(p, a, u) <= PATH_EPS_PX) baseIdx = i;
    }

    // Commit bar for THIS segment's net vector: the press-anchored (or
    // post-rewind) segment waits for `FIRST_SEGMENT_PX`, continuation legs
    // only need `MIN_SEGMENT_PX`.
    const commitPx = curDir === null ? FIRST_SEGMENT_PX : MIN_SEGMENT_PX;
    if (dx * dx + dy * dy < commitPx * commitPx) {
      i++;
      continue;
    }
    const dir = quantizeDirection(dx, dy);
    if (curDir === null) {
      // First commit (or re-commit after a cone-exit rewind): the anchor
      // stays put — continuation is judged from here for this segment.
      if (segs.length >= MAX_SEGMENTS) break;
      segs.push(dir);
      curDir = dir;
      baseIdx = i;
      i++;
      continue;
    }
    if (dir === curDir) {
      i++;
      continue;
    }
    // (3) left the current cone: rewind the anchor to the corner — the
    // sample furthest along the old axis — and let the new direction commit
    // from there.
    const u = AXIS_UV[curDir];
    let bestIdx = anchorIdx;
    let bestProj = -Infinity;
    for (let j = anchorIdx; j <= i; j++) {
      const proj = (points[j].x - a.x) * u.x + (points[j].y - a.y) * u.y;
      if (proj > bestProj) {
        bestProj = proj;
        bestIdx = j;
      }
    }
    anchorIdx = bestIdx;
    baseIdx = bestIdx;
    curDir = null;
    i = bestIdx + 1;
  }
  return segs;
}

/* ──────────────────────── serialization / display ──────────────────────── */

/** Compact stable form used as the matching key. The separator matters:
 *  a bare join would collide ["D","R"] with ["DR"] (both "DR") and make a
 *  single ↘ stroke fire the ↓→ binding. Direction tokens never contain
 *  commas, so a comma join is injective. (The persisted `ui.gestures` blob
 *  stores the raw arrays, not this string — the format is free to change.) */
export function sequenceToString(seq: GestureSequence): string {
  return seq.join(",");
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
