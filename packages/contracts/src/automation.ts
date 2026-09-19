/**
 * Automation domain types — scheduled tasks that create a session and run a
 * prompt unattended — plus the schedule math (computeNextRun / cron parsing)
 * shared by the main-process scheduler and the renderer's live "next run"
 * preview. Both sides import the SAME pure functions so the preview shown in
 * the task editor and the time the scheduler actually fires can never drift.
 */
import { z } from "zod";

/** "HH:mm" local wall-clock time. */
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * One timed trigger rule. All wall-clock fields are LOCAL time.
 *  - once: a single absolute timestamp (ms epoch). Past-due when the app
 *    boots → the task auto-disables (a missed one-shot is not worth running
 *    hours late).
 *  - interval: every N minutes, anchored to the previous run (not to the
 *    wall clock), so a long-running turn naturally delays the next one.
 *  - daily / weekly / monthly: at "HH:mm" local on the matching day(s).
 *    monthly SKIPS months without the day (31st in April) — cron semantics,
 *    predictable over "clamp to month end".
 *  - cron: standard 5-field expression (minute hour day-of-month month
 *    day-of-week) with `* , - /`. Parsed by the hand-rolled parser below —
 *    no cron dependency (mirrors the project's minimal-dependency stance).
 *    When both day-of-month and day-of-week are restricted, cron's union
 *    rule applies (either may fire); when only one is restricted, it wins.
 */
export type AutomationSchedule =
  | { type: "once"; at: number }
  | { type: "interval"; everyMinutes: number }
  | { type: "daily"; time: string }
  | { type: "weekly"; weekdays: number[]; time: string }
  | { type: "monthly"; day: number; time: string }
  | { type: "cron"; expr: string };

export const AutomationScheduleSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("once"), at: z.number().int().positive() }),
  z.object({ type: z.literal("interval"), everyMinutes: z.number().int().min(1).max(525600) }),
  z.object({ type: z.literal("daily"), time: z.string().regex(TIME_RE) }),
  z.object({
    type: z.literal("weekly"),
    /** Day-of-week, `Date#getDay` semantics: 0=Sunday … 6=Saturday. At least one. */
    weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    time: z.string().regex(TIME_RE),
  }),
  z.object({
    type: z.literal("monthly"),
    day: z.number().int().min(1).max(31),
    time: z.string().regex(TIME_RE),
  }),
  z.object({ type: z.literal("cron"), expr: z.string().min(1).max(200) }),
]);

/** Lifecycle of the most recent run (mirrors what the task list badges show).
 *  "running" = turn in flight, "waiting-approval" = blocked on an approval /
 *  question / plan gate (main tracks this via runtime events), "success" /
 *  "failed" = terminal states of the last completed run. */
export type AutomationRunStatus = "running" | "waiting-approval" | "success" | "failed";

/**
 * One entry of a task's run ledger (`Automation.runLog`) — appended by the
 * scheduler on every fire (scheduled OR manual "run now") and updated in
 * place as the run's turn progresses to a terminal state. `status` missing =
 * backfilled from transcript anchors (pre-ledger history): we know a fire
 * happened but not how it ended.
 */
export interface AutomationRunEntry {
  /** Wall-clock fire time (ms epoch) — also the proximity key the renderer
   *  uses to match this entry to its run-turn's user message (the anchor id
   *  lives only renderer-side, so the ledger carries the timestamp). */
  firedAt: number;
  /** True when fired via "run now" rather than the schedule. */
  manual: boolean;
  status?: AutomationRunStatus;
  durationMs?: number;
}

export interface Automation {
  id: string;
  projectId: string;
  title: string;
  /** The task's OWN session (kind="automation", visible in the left bar).
   *  Created together with the task; every fire appends one TURN to it, so
   *  the transcript accumulates across runs and the "history" is the turn
   *  list. One task = one session. */
  taskSessionId: string;
  /** The session whose composer created this task (initiator). Null when
   *  unknown/legacy. The initiator's left-bar row shows a clock badge with
   *  the count of tasks it spawned. */
  parentSessionId: string | null;
  /** Prompt sent as the first user message of each run's fresh session.
   *  May carry "/name" skill literals (display; the SDK allowlist below is
   *  what actually routes them) — "@path" reference lines for filePaths are
   *  appended by the scheduler at fire time. */
  prompt: string;
  /** Skill names picked via the composer's "/" menu (no leading "/").
   *  Forwarded as the SDK skills allowlist on every run's turn — stream-json
   *  input doesn't re-parse "/name" literals from the prompt text, so the
   *  allowlist is what actually makes the Skill tool reach them. */
  skillNames: string[];
  /** Absolute paths attached to the task (composer chips / file-tree drag).
   *  At fire time each becomes a bare "@path" reference line appended to the
   *  prompt — the same representation the chat composer sends — so the model
   *  reads CURRENT file content via its tools at run time (never a stale
   *  snapshot inlined at save). */
  filePaths: string[];
  /** Execution config, same shape as a composer selection — snapshotted onto
   *  each run's session row at creation. */
  providerId: string;
  model: string;
  customModelId: string | null;
  effort: string;
  permissionMode: string;
  schedule: AutomationSchedule;
  enabled: boolean;
  /** Retention cap: only the N most recent run sessions are kept; older ones
   *  (and their messages) are deleted after each run. In-flight runs never
   *  count toward eviction. */
  keepRuns: number;
  lastRunAt: number | null;
  /** Scheduler scan index — precomputed next trigger (ms epoch). Null when
   *  disabled or the schedule has no future occurrence. */
  nextRunAt: number | null;
  lastStatus: AutomationRunStatus | null;
  /** Run ledger, newest last — one entry per fire, trimmed to `keepRuns` in
   *  lockstep with the transcript's turn trimming. Scheduler-owned: the
   *  automation.save path never writes it. */
  runLog: AutomationRunEntry[];
  /** Session of the most recent run (the task page's "view" shortcut). */
  lastSessionId: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * Dated run header the scheduler prepends to every fire's prompt
 * (`[定时运行 MM-DD HH:mm]`). Protocol marker persisted in the transcript —
 * NOT UI copy — and shared three ways: the scheduler composes it, the main
 * store scans it to backfill pre-ledger run history, and the renderer
 * matches it (plus `AutomationRunEntry.firedAt` proximity) to locate a
 * run's anchor message for jump-to-run.
 */
export const RUN_HEADER_PREFIX = "[定时运行";

/* ───────────────────────────── cron-lite ─────────────────────────────
 * Minimal 5-field cron parsing + matching. Supports `*`, lists `,`,
 * ranges `-` and steps `/`. Day-of-week accepts 0-7 (7 normalizes to 0,
 * Sunday). Returns null on any malformed input — the task editor surfaces
 * the error and computeNextRun simply reports "no next run". */

interface CronFields {
  mins: Set<number>;
  hrs: Set<number>;
  doms: Set<number>;
  mons: Set<number>;
  dows: Set<number>;
  /** Whether the day-of-month / day-of-week field is unconstrained (`*`) —
   *  cron's union rule needs to know which fields actually restrict. */
  domStar: boolean;
  dowStar: boolean;
}

function parseCronField(field: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    let step = 1;
    let range = part;
    const slash = part.indexOf("/");
    if (slash >= 0) {
      range = part.slice(0, slash);
      step = Number(part.slice(slash + 1));
      if (!Number.isInteger(step) || step < 1) return null;
    }
    let lo = min;
    let hi = max;
    if (range !== "*" && range !== "") {
      const dash = range.indexOf("-");
      let a: number;
      let b: number;
      if (dash >= 0) {
        a = Number(range.slice(0, dash));
        b = Number(range.slice(dash + 1));
      } else {
        a = b = Number(range);
      }
      if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
      if (a < min || b > max || a > b) return null;
      lo = a;
      hi = b;
    } else if (slash >= 0) {
      lo = min;
    }
    for (let n = lo; ; n += step) {
      out.add(n);
      if (n + step > hi) break;
    }
  }
  return out;
}

export function parseCron(expr: string): CronFields | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const mins = parseCronField(fields[0], 0, 59);
  if (!mins) return null;
  const hrs = parseCronField(fields[1], 0, 23);
  if (!hrs) return null;
  const doms = parseCronField(fields[2], 1, 31);
  if (!doms) return null;
  const mons = parseCronField(fields[3], 1, 12);
  if (!mons) return null;
  // Day-of-week parses over cron's 0-7 convention, then 7 folds onto 0
  // (Sunday) — a plain % on every value also folds ranges ("5-7" → 5,6,0).
  const dowsRaw = parseCronField(fields[4], 0, 7);
  if (!dowsRaw) return null;
  const dows = new Set([...dowsRaw].map((v) => v % 7));
  return {
    mins,
    hrs,
    doms,
    mons,
    dows,
    domStar: fields[2] === "*",
    dowStar: fields[4] === "*",
  };
}

/** Cron's day-of-month vs day-of-week matching: both `*` → every day; exactly
 *  one restricted → that field decides; BOTH restricted → UNION (cron's
 *  documented quirk — "13th or Friday", not "Friday the 13th"). */
function cronDayMatches(c: CronFields, d: Date): boolean {
  if (c.domStar && c.dowStar) return true;
  if (c.domStar) return c.dows.has(d.getDay());
  if (c.dowStar) return c.doms.has(d.getDate());
  return c.doms.has(d.getDate()) || c.dows.has(d.getDay());
}

function atTime(base: Date, h: number, m: number): Date {
  const d = new Date(base);
  d.setHours(h, m, 0, 0);
  return d;
}

function parseHm(time: string): [number, number] | null {
  const m = TIME_RE.exec(time);
  if (!m) return null;
  return [Number(m[1]), Number(m[2])];
}

/**
 * Next fire time for `schedule` strictly after `from` (default: now), in ms
 * epoch — or null when the schedule never fires again (past-due once, no
 * matching weekday, invalid cron…). Pure + deterministic: the scheduler's
 * persisted nextRunAt and the editor's live preview both come from here.
 * Cron matching advances minute-by-minute but is bounded by a 366-day scan
 * horizon (same guard as the scheduler's catch-up logic).
 */
export function computeNextRun(schedule: AutomationSchedule, from: Date = new Date()): number | null {
  if (schedule.type === "once") {
    return schedule.at > from.getTime() ? schedule.at : null;
  }
  if (schedule.type === "interval") {
    return from.getTime() + schedule.everyMinutes * 60_000;
  }
  if (schedule.type === "daily") {
    const hm = parseHm(schedule.time);
    if (!hm) return null;
    let d = atTime(from, hm[0], hm[1]);
    if (d.getTime() <= from.getTime()) {
      d = atTime(new Date(from.getTime() + 86_400_000), hm[0], hm[1]);
    }
    return d.getTime();
  }
  if (schedule.type === "weekly") {
    const hm = parseHm(schedule.time);
    if (!hm || schedule.weekdays.length === 0) return null;
    for (let i = 0; i < 8; i++) {
      const d = atTime(new Date(from.getTime() + i * 86_400_000), hm[0], hm[1]);
      if (d.getTime() > from.getTime() && schedule.weekdays.includes(d.getDay())) {
        return d.getTime();
      }
    }
    return null;
  }
  if (schedule.type === "monthly") {
    const hm = parseHm(schedule.time);
    if (!hm) return null;
    const start = new Date(from);
    for (let i = 0; i < 13; i++) {
      const y = start.getFullYear();
      const mo = start.getMonth() + i;
      const daysInMonth = new Date(y, mo + 1, 0).getDate();
      if (schedule.day > daysInMonth) continue; // month has no such day — skip
      const d = new Date(y, mo, schedule.day, hm[0], hm[1], 0, 0);
      if (d.getTime() > from.getTime()) return d.getTime();
    }
    return null;
  }
  // cron
  const c = parseCron(schedule.expr);
  if (!c) return null;
  const d = new Date(from.getTime() + 60_000);
  d.setSeconds(0, 0);
  const horizon = new Date(from.getTime() + 366 * 86_400_000);
  while (d <= horizon) {
    if (
      c.mons.has(d.getMonth() + 1) &&
      cronDayMatches(c, d) &&
      c.hrs.has(d.getHours()) &&
      c.mins.has(d.getMinutes())
    ) {
      return d.getTime();
    }
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}
