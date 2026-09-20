/**
 * ScheduleEditor — the six-kind trigger editor (once / interval / daily /
 * weekly / monthly / cron) with a live "next run" preview bar pinned under
 * every panel. The preview calls contracts' computeNextRun directly — the
 * SAME pure function the main-process scheduler fires on, so what the user
 * sees and when the task actually runs can never disagree.
 */
import { useMemo } from "react";
import { computeNextRun, type AutomationSchedule } from "@contracts/automation";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { IconClock } from "@renderer/lib/icons.js";
import { cn } from "@renderer/lib/cn.js";
import { fmtClock, formatUntil } from "./automationFormat.js";

const KINDS = ["once", "interval", "daily", "weekly", "monthly", "cron"] as const;
type ScheduleKind = (typeof KINDS)[number];

/** Blank schedule per kind — switching kinds starts from a sane default
 *  instead of remembering half-valid fields across types. */
function defaultFor(kind: ScheduleKind, now: number): AutomationSchedule {
  switch (kind) {
    case "once":
      return { type: "once", at: now + 24 * 3600_000 };
    case "interval":
      return { type: "interval", everyMinutes: 30 };
    case "daily":
      return { type: "daily", time: "09:00" };
    case "weekly":
      return { type: "weekly", weekdays: [1, 5], time: "18:00" };
    case "monthly":
      return { type: "monthly", day: 1, time: "09:00" };
    case "cron":
      return { type: "cron", expr: "0 9 * * 1-5" };
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** "yyyy-MM-dd" for <input type="date"> (local calendar, not UTC). */
function dateValue(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function ScheduleEditor({
  schedule,
  onChange,
}: {
  schedule: AutomationSchedule;
  onChange: (next: AutomationSchedule) => void;
}) {
  const { t } = useI18n();

  const next = useMemo(() => computeNextRun(schedule, new Date()), [schedule]);

  const kindLabel = (k: ScheduleKind) =>
    t(`automation.sch.${k}` as const);

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap gap-1 rounded-[10px] border border-edge bg-surface-muted p-0.5">
        {KINDS.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => onChange(defaultFor(k, Date.now()))}
            className={cn(
              "rounded-lg px-3 py-1 text-xs font-semibold transition-colors",
              schedule.type === k
                ? "bg-surface text-accent shadow-sm"
                : "text-content-muted hover:text-content",
            )}
          >
            {kindLabel(k)}
          </button>
        ))}
      </div>

      {schedule.type === "once" && (
        <div className="flex flex-wrap items-center gap-2 text-[13px] text-content-muted">
          <span>{t("automation.sch.runAt")}</span>
          <input
            type="date"
            value={dateValue(schedule.at)}
            onChange={(e) => {
              const [y, mo, d] = e.target.value.split("-").map(Number);
              const prev = new Date(schedule.at);
              if (Number.isInteger(y)) {
                const next2 = new Date(y, mo - 1, d, prev.getHours(), prev.getMinutes());
                onChange({ type: "once", at: next2.getTime() });
              }
            }}
            className="rounded-lg border border-input-edge bg-surface px-2 py-1 text-xs outline-none focus:border-accent"
          />
          <input
            type="time"
            value={`${pad2(new Date(schedule.at).getHours())}:${pad2(new Date(schedule.at).getMinutes())}`}
            onChange={(e) => {
              const [h, mi] = e.target.value.split(":").map(Number);
              const prev = new Date(schedule.at);
              if (Number.isInteger(h)) {
                const next2 = new Date(prev.getFullYear(), prev.getMonth(), prev.getDate(), h, mi);
                onChange({ type: "once", at: next2.getTime() });
              }
            }}
            className="rounded-lg border border-input-edge bg-surface px-2 py-1 text-xs outline-none focus:border-accent"
          />
          <span className="text-[11px] text-content-subtle">{t("automation.sch.onceNote")}</span>
        </div>
      )}

      {schedule.type === "interval" && (
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2 text-[13px] text-content-muted">
            <span>{t("automation.sch.everyPrefix")}</span>
            <input
              type="number"
              min={1}
              max={525600}
              value={schedule.everyMinutes}
              onChange={(e) =>
                onChange({
                  type: "interval",
                  everyMinutes: Math.min(525600, Math.max(1, Number(e.target.value) || 1)),
                })
              }
              className="w-20 rounded-lg border border-input-edge bg-surface px-2 py-1 text-center text-xs outline-none focus:border-accent"
            />
            <span>{t("automation.sch.everySuffix")}</span>
            <span className="w-2" />
            {([5, 15, 30, 60] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => onChange({ type: "interval", everyMinutes: m })}
                className={cn(
                  "rounded-full border px-2.5 py-1 text-xs transition-colors",
                  schedule.everyMinutes === m
                    ? "border-accent bg-accent/10 font-semibold text-accent"
                    : "border-input-edge text-content-muted hover:text-content",
                )}
              >
                {m === 60 ? t("automation.sch.quick60") : t(`automation.sch.quick${m}` as const)}
              </button>
            ))}
          </div>
          <div className="text-[11px] text-content-subtle">{t("automation.sch.intervalNote")}</div>
        </div>
      )}

      {schedule.type === "daily" && (
        <div className="flex flex-wrap items-center gap-2 text-[13px] text-content-muted">
          <span>{t("automation.sch.daily")}</span>
          <input
            type="time"
            value={schedule.time}
            onChange={(e) => onChange({ type: "daily", time: e.target.value || "09:00" })}
            className="rounded-lg border border-input-edge bg-surface px-2 py-1 text-xs outline-none focus:border-accent"
          />
        </div>
      )}

      {schedule.type === "weekly" && (
        <div className="flex flex-wrap items-center gap-2">
          {([0, 1, 2, 3, 4, 5, 6] as const).map((d) => {
            const on = schedule.weekdays.includes(d);
            return (
              <button
                key={d}
                type="button"
                onClick={() => {
                  const set = new Set(schedule.weekdays);
                  if (set.has(d)) set.delete(d);
                  else set.add(d);
                  if (set.size === 0) set.add(1); // never leave an empty week
                  onChange({ type: "weekly", weekdays: [...set].sort(), time: schedule.time });
                }}
                className={cn(
                  "rounded-full border px-2.5 py-1 text-xs transition-colors",
                  on
                    ? "border-accent bg-accent/10 font-semibold text-accent"
                    : "border-input-edge text-content-muted hover:text-content",
                )}
              >
                {t(`automation.sch.wd${d}` as const)}
              </button>
            );
          })}
          <input
            type="time"
            value={schedule.time}
            onChange={(e) => onChange({ type: "weekly", weekdays: schedule.weekdays, time: e.target.value || "09:00" })}
            className="ml-1 rounded-lg border border-input-edge bg-surface px-2 py-1 text-xs outline-none focus:border-accent"
          />
        </div>
      )}

      {schedule.type === "monthly" && (
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2 text-[13px] text-content-muted">
            <span>{t("automation.sch.monthly")}</span>
            <input
              type="number"
              min={1}
              max={31}
              value={schedule.day}
              onChange={(e) =>
                onChange({
                  type: "monthly",
                  day: Math.min(31, Math.max(1, Number(e.target.value) || 1)),
                  time: schedule.time,
                })
              }
              className="w-16 rounded-lg border border-input-edge bg-surface px-2 py-1 text-center text-xs outline-none focus:border-accent"
            />
            <span>{t("automation.sch.monthlyDaySuffix")}</span>
            <input
              type="time"
              value={schedule.time}
              onChange={(e) => onChange({ type: "monthly", day: schedule.day, time: e.target.value || "09:00" })}
              className="rounded-lg border border-input-edge bg-surface px-2 py-1 text-xs outline-none focus:border-accent"
            />
          </div>
          <div className="text-[11px] text-content-subtle">{t("automation.sch.monthlyNote")}</div>
        </div>
      )}

      {schedule.type === "cron" && (
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={schedule.expr}
              spellCheck={false}
              onChange={(e) => onChange({ type: "cron", expr: e.target.value })}
              className="w-56 rounded-lg border border-input-edge bg-surface px-2.5 py-1 font-mono text-xs outline-none focus:border-accent"
            />
            <span className={cn("text-[11px]", next === null ? "text-danger" : "text-content-subtle")}>
              {next === null ? t("automation.sch.cronInvalid") : t("automation.sch.cronFields")}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-content-subtle">{t("automation.sch.cronCommon")}</span>
            {(
              [
                ["0 9 * * 1-5", "09:00 · Mon-Fri"],
                ["0 */2 * * *", "*/2h"],
                ["30 8 1 * *", "1st · 08:30"],
                ["0 22 * * 0", "Sun 22:00"],
              ] as const
            ).map(([expr, label]) => (
              <button
                key={expr}
                type="button"
                title={expr}
                onClick={() => onChange({ type: "cron", expr })}
                className="rounded-full border border-input-edge px-2.5 py-0.5 font-mono text-[11px] text-content-muted hover:text-content"
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Live next-run preview — same function the scheduler fires on. */}
      <div className="flex items-center gap-2 rounded-[10px] border border-accent/30 bg-accent/5 px-3 py-2 text-xs">
        <IconClock size={14} className="shrink-0 text-accent" />
        {next !== null ? (
          <>
            <span className="text-content-muted">{t("automation.sch.nextRun")}</span>
            <span className="font-bold text-accent">
              {fmtClock(next)}({formatUntil(next)})
            </span>
            <span className="ml-auto text-content-subtle">{t("automation.sch.nextRunSaveNote")}</span>
          </>
        ) : (
          <span className="text-content-subtle">
            {schedule.type === "once"
              ? t("automation.sch.expiredOnce")
              : schedule.type === "cron"
                ? t("automation.sch.cronNoMatch")
                : t("automation.sch.incomplete")}
          </span>
        )}
      </div>
    </div>
  );
}
