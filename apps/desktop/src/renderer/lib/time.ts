/**
 * Time formatting helpers shared across the Git panel.
 *
 * Relative time is shown inline (e.g. "2 分钟前"); the full time is shown as a
 * hover `title`. The input accepts either an ISO string (git log timestamps)
 * or a numeric epoch-ms value (e.g. `Date.now()` for operation logs).
 */
import { translate } from "@renderer/lib/i18n/core.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";

/** Format a time as a short relative string ("刚刚" / "N 分钟前" / ...).
 *  Localized via the store's current locale; callers render during render or
 *  in event callbacks, so a language switch re-evaluates on the next render. */
export function formatRelativeTime(input: number | string): string {
  const t = typeof input === "number" ? input : new Date(input).getTime();
  if (Number.isNaN(t)) return String(input);
  const locale = useSessionStore.getState().locale;
  const diffSec = Math.round((Date.now() - t) / 1000);
  if (diffSec < 60) return translate(locale, "lib.time.justNow");
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return translate(locale, "lib.time.minutesAgo", { n: diffMin });
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return translate(locale, "lib.time.hoursAgo", { n: diffHr });
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 30) return translate(locale, "lib.time.daysAgo", { n: diffDay });
  const diffMonth = Math.round(diffDay / 30);
  if (diffMonth < 12) return translate(locale, "lib.time.monthsAgo", { n: diffMonth });
  const diffYear = Math.round(diffMonth / 12);
  return translate(locale, "lib.time.yearsAgo", { n: diffYear });
}

/** Format a time as a full locale string, for hover tooltips. */
export function formatFullTime(input: number | string): string {
  const d = typeof input === "number" ? new Date(input) : new Date(input);
  if (Number.isNaN(d.getTime())) return String(input);
  try {
    return d.toLocaleString();
  } catch {
    return String(input);
  }
}
