/**
 * Display helpers for the automation page: schedule summaries, status
 * presentation, compact clocks. Pure functions over the i18n core (same
 * discipline as lib/time.ts — locale read from the store at call time).
 */
import type { Automation, AutomationSchedule, AutomationRunStatus } from "@contracts/automation";
import { RUN_HEADER_PREFIX } from "@contracts/automation";
import type { Block, ChatMessage } from "@renderer/stores/sessionStore.js";
import { translate, type MessageId } from "@renderer/lib/i18n/core.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";

/** Localized human summary of a schedule rule ("每天 09:00" / "每 15 分钟"). */
export function describeSchedule(schedule: AutomationSchedule | undefined): string {
  const t = (key: MessageId, params?: Record<string, string | number>) =>
    translate(useSessionStore.getState().locale, key, params);
  if (!schedule) return t("automation.desc.none");
  switch (schedule.type) {
    case "once":
      return t("automation.desc.once", { time: fmtClock(schedule.at) });
    case "interval":
      // Whole hours read better than "每 60 分钟" / "每 120 分钟".
      if (schedule.everyMinutes >= 60 && schedule.everyMinutes % 60 === 0) {
        return t("automation.desc.everyHour", { n: schedule.everyMinutes / 60 });
      }
      return t("automation.desc.everyMin", { n: schedule.everyMinutes });
    case "daily":
      return t("automation.desc.daily", { time: schedule.time });
    case "weekly": {
      // zh weekday chips carry a leading 周 ("周一") that the template already
      // includes ("每周{days}"); strip it so days join as "一、五". en names
      // ("Mon") pass through untouched.
      const days = [...schedule.weekdays].sort()
        .map((d) => t(`automation.sch.wd${d}` as MessageId))
        .map((name) => (name.startsWith("周") ? name.slice(1) : name))
        .join(t("common.listSeparator"));
      return t("automation.desc.weekly", { days, time: schedule.time });
    }
    case "monthly":
      return t("automation.desc.monthly", { day: schedule.day, time: schedule.time });
    case "cron":
      return t("automation.desc.cron", { expr: schedule.expr });
  }
}

/** Status → { label, dotClass, badgeClass } for list rows / history rows.
 *  Running uses the stream sidebar's hex pair (light/dark sky) — the app has
 *  no `running` color token; amber/green/red ride the semantic tokens. */
export function statusMeta(status: AutomationRunStatus | null): {
  label: string;
  dotClass: string;
  badgeClass: string;
} {
  const t = (key: MessageId) => translate(useSessionStore.getState().locale, key);
  switch (status) {
    case "running":
      return {
        label: t("automation.status.running"),
        dotClass: "bg-[#0369a1] dark:bg-[#38bdf8]",
        badgeClass: "text-[#0369a1] dark:text-[#38bdf8] bg-[#38bdf8]/10",
      };
    case "waiting-approval":
      return { label: t("automation.status.waiting"), dotClass: "bg-warning", badgeClass: "text-warning bg-warning/10" };
    case "success":
      return { label: t("automation.status.success"), dotClass: "bg-success", badgeClass: "text-success bg-success/10" };
    case "failed":
      return { label: t("automation.status.failed"), dotClass: "bg-danger", badgeClass: "text-danger bg-danger/10" };
    default:
      return { label: t("automation.status.idle"), dotClass: "bg-content-subtle/60", badgeClass: "text-content-subtle bg-surface-hover" };
  }
}

/** "09-19 08:30" — compact locale-neutral clock for list rows and run titles. */
export function fmtClock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Future relative time for the next-run line ("35 分钟后" / "in 35 min"). */
export function formatUntil(ms: number): string {
  const locale = useSessionStore.getState().locale;
  const diffMin = Math.max(1, Math.round((ms - Date.now()) / 60_000));
  if (diffMin < 60) return translate(locale, "automation.until.minutes", { n: diffMin });
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return translate(locale, "automation.until.hours", { n: diffHr });
  return translate(locale, "automation.until.days", { n: Math.round(diffHr / 24) });
}

/** The line under a task's name in the list: schedule summary + next run. */
export function taskNextLine(task: Automation): string | null {
  if (!task.enabled) return null;
  if (task.nextRunAt === null) {
    return task.schedule.type === "once"
      ? translate(useSessionStore.getState().locale, "automation.scheduleExpired")
      : translate(useSessionStore.getState().locale, "automation.noNextRun");
  }
  return translate(useSessionStore.getState().locale, "automation.nextRunIn", {
    time: formatUntil(task.nextRunAt),
  });
}

/** Conservative scheduled-task intent heuristic: fires only on explicit
 *  schedule vocabulary (zh or en). Deliberately narrow — a false positive
 *  costs the user an extra dialog on every send. */
const INTENT_RE_ZH = /(每天|每日|每周|每个星期|每月|每小时|每隔|定时|定期|工作日)/;
const INTENT_RE_EN = /\b(daily|every ?day|every ?morning|every ?week|weekly|monthly|hourly|every \d+ ?(min(ute)?s?|hours?|days?)|scheduled?)\b/i;

export function looksLikeScheduledTaskIntent(text: string): boolean {
  return INTENT_RE_ZH.test(text) || INTENT_RE_EN.test(text);
}

/** In-flight = the scheduler's "重叠保护" states (running | waiting-approval):
 *  the turn is live, a new fire is blocked. Soft-deleted rows never count —
 *  they're out of the schedule even if their last run is somehow still
 *  settling. Consumers: the sidebar entry's running-count badge, SchedPanel. */
export function isInFlightAutomation(task: Automation): boolean {
  if (task.deletedAt != null) return false;
  return task.lastStatus === "running" || task.lastStatus === "waiting-approval";
}

/** Urgency-first ordering for the task list: in-flight / blocked first, then
 *  failures, then enabled tasks by soonest next fire, disabled last. The
 *  tasks the user must look at float to the top without any grouping UI. */
export function sortAutomations(tasks: Automation[]): Automation[] {
  const rank = (t: Automation): number => {
    if (t.lastStatus === "running" || t.lastStatus === "waiting-approval") return 0;
    if (t.lastStatus === "failed") return 1;
    if (t.enabled) return 2;
    return 3;
  };
  return [...tasks].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 2) {
      const an = a.nextRunAt ?? Number.MAX_SAFE_INTEGER;
      const bn = b.nextRunAt ?? Number.MAX_SAFE_INTEGER;
      if (an !== bn) return an - bn;
    }
    return b.updatedAt - a.updatedAt;
  });
}

/** Tolerance when matching a ledger entry to its run-turn's anchor message:
 *  the transcript echo lands within seconds of the fire stamp, the window
 *  just absorbs persistence/flush jitter (and skipped near-duplicate fires
 *  in the same minute). */
const ANCHOR_WINDOW_MS = 5 * 60_000;

/** The run-anchor user message for one ledger entry: a user message whose
 *  text opens with the dated run header, closest in time to `firedAt`.
 *  Message ids are assigned renderer-side (messages persist via
 *  session.upsertMessages), so the ledger carries only the fire timestamp
 *  and the match happens by proximity at click time. */
export function findRunAnchor(
  messages: ReadonlyArray<ChatMessage>,
  firedAt: number,
): ChatMessage | null {
  let best: ChatMessage | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const m of messages) {
    if (m.role !== "user") continue;
    const text = m.blocks.find((b): b is Extract<Block, { kind: "text" }> => b.kind === "text")
      ?.text;
    if (!text || !text.startsWith(RUN_HEADER_PREFIX)) continue;
    const delta = Math.abs(m.createdAt - firedAt);
    if (delta < bestDelta && delta <= ANCHOR_WINDOW_MS) {
      best = m;
      bestDelta = delta;
    }
  }
  return best;
}
