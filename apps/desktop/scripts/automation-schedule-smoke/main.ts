/**
 * Headless smoke for the automation schedule math (contracts/automation.ts):
 * computeNextRun's six schedule kinds, cron-lite parsing (steps, ranges,
 * union day semantics, 7=Sunday, invalid inputs) and the AutomationSchedule
 * zod schema's rejection boundaries. Pure functions — no stubs, no DB.
 *
 * Fixed anchor: Saturday 2026-09-19 07:58 local. Expected values are built
 * with local Date arithmetic so DST/timezone cannot skew the assertions.
 */
import {
  AutomationScheduleSchema,
  computeNextRun,
  parseCron,
  type AutomationSchedule,
} from "@contracts/automation";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean): void {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`FAIL: ${name}`);
  }
}

function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Local 2026-09-19 (Saturday) 07:58. */
const FROM = new Date(2026, 8, 19, 7, 58, 0, 0);
const next = (s: AutomationSchedule, from: Date = FROM): number | null =>
  computeNextRun(s, from);
const local = (y: number, mo: number, d: number, h: number, mi: number): number =>
  new Date(y, mo - 1, d, h, mi).getTime();

/* ── once ── */
check("once future fires at", next({ type: "once", at: FROM.getTime() + 3600_000 }) === FROM.getTime() + 3600_000);
check("once past → null", next({ type: "once", at: FROM.getTime() - 1000 }) === null);

/* ── interval ── */
check("interval anchors on from", next({ type: "interval", everyMinutes: 15 }) === FROM.getTime() + 900_000);

/* ── daily ── */
check("daily before time → today", next({ type: "daily", time: "09:00" }) === local(2026, 9, 19, 9, 0));
check("daily after time → tomorrow", next({ type: "daily", time: "07:00" }) === local(2026, 9, 20, 7, 0));

/* ── weekly ── */
check("weekly Sat → next Mon", next({ type: "weekly", weekdays: [1, 5], time: "18:00" }) === local(2026, 9, 21, 18, 0));
check("weekly includes today later", next({ type: "weekly", weekdays: [6], time: "09:00" }) === local(2026, 9, 19, 9, 0));
check("weekly today passed → next week", next({ type: "weekly", weekdays: [6], time: "07:00" }) === local(2026, 9, 26, 7, 0));

/* ── monthly ── */
check("monthly same month", next({ type: "monthly", day: 31, time: "09:00" }, new Date(2026, 0, 15, 7, 58)) === local(2026, 1, 31, 9, 0));
check("monthly skips short month", next({ type: "monthly", day: 31, time: "09:00" }, new Date(2026, 3, 1, 7, 58)) === local(2026, 5, 31, 9, 0));
check("monthly day 31 past Sep → Oct", next({ type: "monthly", day: 31, time: "09:00" }) === local(2026, 10, 31, 9, 0));

/* ── cron ── */
check("cron */30 rounds to :00", next({ type: "cron", expr: "*/30 * * * *" }) === local(2026, 9, 19, 8, 0));
check("cron workdays 9:00 Sat → Mon", next({ type: "cron", expr: "0 9 * * 1-5" }) === local(2026, 9, 21, 9, 0));
check("cron unrestricted dow fires today", next({ type: "cron", expr: "0 9 * * *" }) === local(2026, 9, 19, 9, 0));
check("cron dom+dow union → next Friday", next({ type: "cron", expr: "0 0 13 * 5" }) === local(2026, 9, 25, 0, 0));
check("cron dom+dow intersection when only dom restricted", next({ type: "cron", expr: "0 0 13 * *" }) === local(2026, 10, 13, 0, 0));
check("cron dow 7 ≡ Sunday", next({ type: "cron", expr: "0 22 * * 7" }) === local(2026, 9, 20, 22, 0));
check("cron step hours", next({ type: "cron", expr: "30 */5 * * *" }) === local(2026, 9, 19, 10, 30));
check("cron invalid minute → null", next({ type: "cron", expr: "61 * * * *" }) === null);
check("cron 4 fields → null", next({ type: "cron", expr: "* * * *" }) === null);
check("cron garbage → null", next({ type: "cron", expr: "hello world * * *" }) === null);

/* ── parseCron details ── */
check("parseCron list+range", eq([...(parseCron("0,30 8-10 * * *")?.hrs ?? [])], [8, 9, 10]));
check("parseCron dow 7 normalized", (parseCron("* * * * 7")?.dows.has(0) ?? false) && !(parseCron("* * * * 7")?.dows.has(7) ?? true));

/* ── schema boundaries ── */
check("schema rejects unpadded time", !AutomationScheduleSchema.safeParse({ type: "daily", time: "9:00" }).success);
check("schema rejects empty weekdays", !AutomationScheduleSchema.safeParse({ type: "weekly", weekdays: [], time: "09:00" }).success);
check("schema rejects weekday 7", !AutomationScheduleSchema.safeParse({ type: "weekly", weekdays: [7], time: "09:00" }).success);
check("schema rejects day 0", !AutomationScheduleSchema.safeParse({ type: "monthly", day: 0, time: "09:00" }).success);
check("schema rejects interval 0", !AutomationScheduleSchema.safeParse({ type: "interval", everyMinutes: 0 }).success);
check("schema rejects negative once", !AutomationScheduleSchema.safeParse({ type: "once", at: -5 }).success);
check("schema accepts cron", AutomationScheduleSchema.safeParse({ type: "cron", expr: "0 9 * * 1-5" }).success);
check("schema accepts interval", AutomationScheduleSchema.safeParse({ type: "interval", everyMinutes: 15 }).success);

console.log(`automation-schedule-smoke: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
