/**
 * RuntimeUpdatePrompt — non-blocking bottom-right reminder card for stale
 * agent runtimes.
 *
 * Surfaced once per app launch by `reloadRuntimes` (sessionStore) when any
 * agent's ACTIVE runtime differs from the version this Mcode build expects —
 * the "app itself updated, the on-demand copy under userData/runtimes
 * lagged" case. Mounted inside the same fixed corner column as
 * UpdateNotification + Toaster (App.tsx) so the three stack without
 * overlapping; the card is pointer-events-auto on itself only — everything
 * else on screen stays fully interactive whether or not the user acts on it.
 *
 * 立即更新 kicks the install pipeline for every outdated agent (no version →
 * installs the app's pinned expected version, the same call the Runtimes
 * panel's update button makes) and jumps to the settings runtimes section so
 * download progress stays visible; 稍后提醒 (or the X) dismisses until the
 * next launch. Install-time gates still apply (compat list — though the
 * pinned target is exempt by definition — and the running-turn guard): a
 * rejected install surfaces as a toast + the panel card's error line.
 * Installs run sequentially — codex alone is ~380MB, parallel downloads
 * would fight for bandwidth.
 */
import { useMemo } from "react";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useToastStore } from "@renderer/stores/toastStore.js";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { Button } from "@renderer/components/ui/index.js";
import { IconDownload, IconPackage, IconX } from "@renderer/lib/icons.js";
import type { RuntimeAgentId } from "@contracts/ipc";

/** Display names — proper nouns, untranslated (mirrors RuntimesPanel's
 *  AGENT_META). */
const AGENT_LABELS: Record<RuntimeAgentId, string> = {
  claude: "Claude",
  codex: "Codex",
  pi: "Pi",
};

export function RuntimeUpdatePrompt() {
  const { t } = useI18n();
  const open = useSessionStore((s) => s.runtimeUpdatePromptOpen);
  const setOpen = useSessionStore((s) => s.setRuntimeUpdatePromptOpen);
  const setSettingsOpen = useSessionStore((s) => s.setSettingsOpen);
  // Select the stable `runtimes` ref and derive here — a .filter() selector
  // would return a fresh array per store read (infinite re-render, the exact
  // hazard AGENTS.md's Zustand rules call out).
  const runtimes = useSessionStore((s) => s.runtimes);
  const outdated = useMemo(
    () => runtimes.filter((rt) => rt.updateAvailable && !rt.installing),
    [runtimes],
  );

  if (!open || outdated.length === 0) return null;

  const dismiss = () => setOpen(false);

  const startUpdates = () => {
    // Snapshot fresh state at click time — a re-list may have landed between
    // render and confirm.
    const agents = useSessionStore
      .getState()
      .runtimes.filter((rt) => rt.updateAvailable && !rt.installing);
    if (agents.length === 0) return;
    setOpen(false);
    void (async () => {
      for (const rt of agents) {
        try {
          const res = await api.runtimes.install({ agent: rt.agent });
          if (!res.ok) {
            useToastStore.getState().push({
              kind: "warning",
              title: t("settings.runtimes.updatePromptTitle"),
              body: `${AGENT_LABELS[rt.agent]}: ${res.error ?? ""}`,
            });
          }
        } catch (err) {
          useToastStore.getState().push({
            kind: "warning",
            title: t("settings.runtimes.updatePromptTitle"),
            body: `${AGENT_LABELS[rt.agent]}: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    })();
    setSettingsOpen(true, "runtimes");
  };

  return (
    <div
      role="status"
      className={cn(
        "pointer-events-auto w-80 rounded-md border border-edge border-l-2 border-l-accent bg-surface px-3 py-2.5 shadow-lg",
        "animate-[home-fade-up_160ms_ease-out]",
      )}
    >
      <div className="flex items-start gap-2">
        <div className="mt-0.5 min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[13px] font-medium text-content">
            <IconPackage size={15} className="shrink-0 text-accent" />
            {t("settings.runtimes.updatePromptTitle")}
          </div>
          <div className="mt-0.5 text-[12px] leading-relaxed text-content-muted">
            {t("settings.runtimes.updatePromptDesc")}
          </div>
          <ul className="mt-1.5 space-y-0.5">
            {outdated.map((rt) => (
              <li key={rt.agent} className="font-mono text-[11px] text-content-muted">
                {AGENT_LABELS[rt.agent]}: v{rt.activeVersion ?? "?"} → v{rt.expectedVersion}
              </li>
            ))}
          </ul>
        </div>
        <button
          onClick={dismiss}
          className="shrink-0 rounded p-0.5 text-content-subtle transition-colors hover:bg-surface-hover hover:text-content"
          aria-label={t("common.close")}
        >
          <IconX size={14} />
        </button>
      </div>
      <div className="mt-2 flex items-center justify-end gap-1.5">
        <Button variant="ghost" size="sm" onClick={dismiss}>
          {t("settings.runtimes.updateLater")}
        </Button>
        <Button variant="primary" size="sm" onClick={startUpdates} className="gap-1.5">
          <IconDownload size={14} />
          {t("settings.runtimes.updateNow")}
        </Button>
      </div>
    </div>
  );
}
