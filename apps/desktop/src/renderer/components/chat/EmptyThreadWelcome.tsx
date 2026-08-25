/**
 * Empty-thread welcome — the centered title shown above the composer on a
 * fresh thread. Kept minimal on purpose: the input box is the visual focus
 * of the home screen, the title just names it.
 *
 * Under the title sits a one-line "today" usage hint (今天对话 x 轮 · 消耗
 * y token), aggregated across ALL sessions by the main process's usage-stats
 * module (`usage.stats` IPC, preset "today" = local midnight → now). Fetched
 * on mount; hidden when today has no turns yet or the stats RPC fails, so a
 * fresh install shows the same clean screen as before.
 *
 * A light fade-up plays once on mount (see `home-fade-up` in styles.css);
 * disabled under prefers-reduced-motion.
 */
import { useEffect, useState } from "react";
import { api } from "@renderer/lib/api.js";
import { isElectron } from "@renderer/lib/platform.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { fmtTokens } from "@renderer/lib/contextWindow.js";
import type { UsageSummaryStat } from "@contracts/ipc";

export interface EmptyThreadWelcomeProps {
  /** Project display name; empty string degrades the title to the plain
   *  "start a new chat" wording. */
  projectName: string;
}

export function EmptyThreadWelcome({ projectName }: EmptyThreadWelcomeProps) {
  const { t } = useI18n();
  // Today's cross-session usage summary; null until the RPC resolves (or
  // forever when it failed — the hint line simply stays hidden).
  const [today, setToday] = useState<UsageSummaryStat | null>(null);
  useEffect(() => {
    // Desktop-only RPC. The web shim's `api.usage` proxy throws
    // SYNCHRONOUSLY (before `.catch` below can attach), which would crash
    // the mobile home screen — so skip the call entirely outside Electron.
    // The hint is optional chrome and stays hidden, same as on RPC failure.
    if (!isElectron) return;
    let alive = true;
    api.usage
      .stats({ preset: "today" })
      .then((res) => {
        if (alive) setToday(res.summary);
      })
      .catch(() => {
        // Stats unavailable (e.g. DB hiccup) — the hint is optional chrome,
        // not worth surfacing an error for.
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="mb-4 flex animate-[home-fade-up_160ms_ease-out] flex-col items-center gap-1.5">
      <h2 className="text-2xl font-semibold tracking-tight text-content">
        {projectName
          ? t("chatStream.welcome.withProject", { name: projectName })
          : t("chatStream.welcome.title")}
      </h2>
      {today && today.turns > 0 && (
        <p className="text-xs text-content-subtle">
          {t("chatStream.welcome.todayUsage", {
            turns: today.turns,
            tokens: fmtTokens(today.totalTokens),
          })}
        </p>
      )}
    </div>
  );
}
