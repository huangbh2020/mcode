/**
 * Compact Antigravity quota bar rendered directly below the composer card when
 * the active session uses `antigravity-acp`.
 *
 * Shows the active model group's 5-hour and weekly remaining quota inline with
 * mini progress bars, and opens an upward portal popover on click to inspect
 * every model group (Gemini Models / Claude and GPT models) and reset timers.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AntigravityUsageBucket, AntigravityUsageGroup, AntigravityUsageResult } from "@contracts/ipc";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { IconChevronDown, IconChevronUp, IconRefresh } from "@renderer/lib/icons.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useSuppressBrowserView } from "@renderer/hooks/useSuppressBrowserView.js";

function quotaBarColor(remainingPct: number): string {
  if (remainingPct < 10) return "bg-danger";
  if (remainingPct <= 30) return "bg-warning";
  return "bg-emerald-500";
}

function quotaTextColor(remainingPct: number): string {
  if (remainingPct < 10) return "text-danger";
  if (remainingPct <= 30) return "text-warning";
  return "text-content-muted";
}

function pickPrimaryGroup(
  groups: AntigravityUsageGroup[],
  activeModel: string | undefined,
): AntigravityUsageGroup | null {
  if (groups.length === 0) return null;
  const model = (activeModel ?? "").toLowerCase();
  if (model.includes("claude") || model.includes("gpt")) {
    const thirdParty = groups.find((g) => /claude|gpt/i.test(g.name));
    if (thirdParty) return thirdParty;
  }
  const gemini = groups.find((g) => /gemini/i.test(g.name));
  return gemini ?? groups[0] ?? null;
}

function formatResetCountdown(resetsAt: number | null, locale: string): string | null {
  if (resetsAt == null) return null;
  const diffMs = resetsAt - Date.now();
  if (diffMs <= 60_000) return "";
  const totalMinutes = Math.floor(diffMs / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const mins = totalMinutes % 60;
  if (locale === "zh") {
    if (days > 0) return hours > 0 ? `${days}天${hours}小时` : `${days}天`;
    if (hours > 0) return mins > 0 ? `${hours}小时${mins}分` : `${hours}小时`;
    return `${mins}分钟`;
  }
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  return `${mins}m`;
}

function windowShortLabel(
  bucket: AntigravityUsageBucket,
  t: ReturnType<typeof useI18n>["t"],
): string {
  if (bucket.window === "5h") return t("chat.agyUsage.window5h");
  if (bucket.window === "weekly") return t("chat.agyUsage.windowWeekly");
  return bucket.window;
}

function UsagePopover({
  usage,
  anchorRect,
  onClose,
}: {
  usage: AntigravityUsageResult;
  anchorRect: DOMRect;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useSuppressBrowserView(true);

  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 8;
    const left = Math.max(margin, Math.min(anchorRect.left, window.innerWidth - rect.width - margin));
    const aboveTop = anchorRect.top - rect.height - 6;
    const top = aboveTop >= margin ? aboveTop : Math.min(anchorRect.bottom + 6, window.innerHeight - rect.height - margin);
    setPos({ left, top });
  }, [anchorRect]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <>
      <div className="fixed inset-0 z-40" onMouseDown={onClose} />
      <div
        ref={panelRef}
        style={
          pos
            ? { left: `${pos.left}px`, top: `${pos.top}px` }
            : { left: `${anchorRect.left}px`, top: `${anchorRect.top}px`, visibility: "hidden" }
        }
        className="fixed z-50 w-[320px] max-w-[calc(100vw-16px)] rounded-xl border border-edge bg-surface p-3 shadow-2xl"
      >
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-medium text-content">{t("chat.agyUsage.title")}</span>
          <span className="text-[11px] text-content-subtle">
            {new Date(usage.fetchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
        </div>

        <div className="space-y-3">
          {usage.groups.map((group) => (
            <div key={group.name} className="space-y-1.5">
              <div className="text-[11px] font-medium text-content-muted">{group.name}</div>
              {group.buckets.map((bucket) => {
                const countdown = formatResetCountdown(bucket.resetsAt, locale);
                return (
                  <div key={bucket.id} className="space-y-1">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-content-subtle">
                        {windowShortLabel(bucket, t)} · {t("chat.agyUsage.remaining", { pct: bucket.remainingPercent })}
                      </span>
                      {countdown !== null && (
                        <span className="text-[10px] text-content-subtle">
                          {countdown === ""
                            ? t("chat.agyUsage.resetSoon")
                            : t("chat.agyUsage.resetsIn", { time: countdown })}
                        </span>
                      )}
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-muted">
                      <div
                        className={cn("h-full rounded-full transition-all", quotaBarColor(bucket.remainingPercent))}
                        style={{ width: `${bucket.remainingPercent}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        {usage.description && (
          <p className="mt-2.5 border-t border-edge pt-2 text-[10px] leading-relaxed text-content-subtle">
            {usage.description}
          </p>
        )}
      </div>
    </>,
    document.body,
  );
}

export function AntigravityUsageBar({
  busy,
}: {
  busy: boolean;
}) {
  const { t } = useI18n();
  const activeModel = useSessionStore((s) => s.model);
  const accountVersion = useSessionStore((s) => s.antigravityAccountVersion);
  const [usage, setUsage] = useState<AntigravityUsageResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [popoverRect, setPopoverRect] = useState<DOMRect | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const prevBusyRef = useRef(busy);
  const prevAccountVersionRef = useRef(accountVersion);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadUsage = useCallback(async (force: boolean) => {
    setLoading(true);
    try {
      const res = await window.api.antigravity.usage({ force });
      if (mountedRef.current) setUsage(res);
    } catch {
      // Ignore transient/unsupported web errors
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  // Initial fetch (hits main-process 2-min cache so switching tabs is cheap).
  useEffect(() => {
    void loadUsage(false);
  }, [loadUsage]);

  // Force refresh whenever the active Antigravity account changes.
  useEffect(() => {
    if (prevAccountVersionRef.current !== accountVersion) {
      prevAccountVersionRef.current = accountVersion;
      setPopoverRect(null);
      void loadUsage(true);
    }
  }, [accountVersion, loadUsage]);

  // Refresh quietly right after an Antigravity turn finishes.
  useEffect(() => {
    const wasBusy = prevBusyRef.current;
    prevBusyRef.current = busy;
    if (wasBusy && !busy) {
      const timer = setTimeout(() => {
        void loadUsage(true);
      }, 1200);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [busy, loadUsage]);

  const primaryGroup = usage?.ok ? pickPrimaryGroup(usage.groups, activeModel) : null;
  const fiveHour = primaryGroup?.buckets.find((b) => b.window === "5h");
  const weekly = primaryGroup?.buckets.find((b) => b.window === "weekly");
  const inlineBuckets = [fiveHour, weekly].filter((b): b is AntigravityUsageBucket => Boolean(b));

  const togglePopover = () => {
    if (popoverRect) {
      setPopoverRect(null);
      return;
    }
    if (usage?.ok && usage.groups.length > 0 && triggerRef.current) {
      setPopoverRect(triggerRef.current.getBoundingClientRect());
    }
  };

  return (
    <div className="mt-1.5 flex items-center justify-between gap-2 px-1 text-[11px] text-content-subtle select-none">
      <button
        ref={triggerRef}
        type="button"
        onClick={togglePopover}
        disabled={!usage?.ok || usage.groups.length === 0}
        title={usage?.ok ? t("chat.agyUsage.detailsHint") : usage?.error}
        className={cn(
          "flex min-w-0 items-center gap-2.5 rounded-md px-1.5 py-0.5 text-left transition-colors",
          usage?.ok && usage.groups.length > 0 && "hover:bg-surface-hover hover:text-content",
          (!usage?.ok || usage.groups.length === 0) && "cursor-default",
        )}
      >
        {!usage && loading ? (
          <span>{t("chat.agyUsage.loading")}</span>
        ) : usage?.unmetered ? (
          <span className="truncate text-content-subtle">{t("chat.agyUsage.unmetered")}</span>
        ) : usage && !usage.ok ? (
          <span className="truncate text-content-subtle" title={usage.error}>
            {t("chat.agyUsage.unavailable")}
          </span>
        ) : primaryGroup && inlineBuckets.length > 0 ? (
          <>
            <span className="truncate font-medium text-content-muted">{primaryGroup.name}</span>
            {inlineBuckets.map((b) => (
              <span key={b.id} className="inline-flex shrink-0 items-center gap-1.5">
                <span className="text-content-subtle">{windowShortLabel(b, t)}</span>
                <span className="h-1.5 w-10 overflow-hidden rounded-full bg-surface-muted">
                  <span
                    className={cn("block h-full rounded-full", quotaBarColor(b.remainingPercent))}
                    style={{ width: `${b.remainingPercent}%` }}
                  />
                </span>
                <span className={cn("tabular-nums font-medium", quotaTextColor(b.remainingPercent))}>
                  {b.remainingPercent}%
                </span>
              </span>
            ))}
            {popoverRect ? (
              <IconChevronUp size={12} className="shrink-0 opacity-70" />
            ) : (
              <IconChevronDown size={12} className="shrink-0 opacity-70" />
            )}
          </>
        ) : null}
      </button>

      <button
        type="button"
        onClick={() => void loadUsage(true)}
        disabled={loading}
        title={t("chat.agyUsage.refresh")}
        aria-label={t("chat.agyUsage.refresh")}
        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-content-subtle transition-colors hover:bg-surface-hover hover:text-content disabled:opacity-50"
      >
        <IconRefresh size={12} className={cn(loading && "animate-spin")} />
      </button>

      {popoverRect && usage?.ok && (
        <UsagePopover usage={usage} anchorRect={popoverRect} onClose={() => setPopoverRect(null)} />
      )}
    </div>
  );
}
