/**
 * "真实 Chrome" settings section — the mcode-connector relay lifecycle UI.
 *
 * The relay (main/browser/chromeRelay.ts) is a loopback WebSocket server the
 * mcode-connector browser extension connects to, letting the agent's browser
 * tools drive the user's REAL, logged-in Chrome (backend:"chrome" on
 * navigate/snapshot/screenshot). This panel: enable switch (owns the server
 * lifecycle via browser:chromeRelaySetEnabled), live connection status
 * (pushed as the "chromeRelay" browser event), the pairing token (reveal +
 * regenerate — disconnects the extension), and the extension install
 * pointer.
 */
import { useEffect, useState } from "react";
import { api } from "@renderer/lib/api.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { Button, Switch } from "@renderer/components/ui/index.js";
import { GlobeIcon, IconRefresh } from "@renderer/lib/icons.js";
import { SettingRow } from "./SettingRow.js";
import { SettingsSection } from "./SettingsSection.js";

export function ChromeRelayPanel() {
  const { t } = useI18n();
  const [status, setStatus] = useState<{
    enabled: boolean;
    listening: boolean;
    port: number | null;
    connected: boolean;
    chromeVersion: string | null;
  } | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api.browser.chromeRelayStatus().then(setStatus).catch(() => setStatus(null));
    const off = api.on.browserEvent((msg) => {
      if (msg.type !== "chromeRelay") return;
      setStatus(msg.payload as typeof status);
    });
    return off;
  }, []);

  const toggle = async (enabled: boolean) => {
    setBusy(true);
    try {
      const next = await api.browser.chromeRelaySetEnabled({ enabled });
      setStatus(next);
    } catch (err) {
      console.error("chromeRelaySetEnabled failed:", err);
    } finally {
      setBusy(false);
    }
  };

  const resetToken = async () => {
    setBusy(true);
    try {
      const { token: fresh } = await api.browser.chromeRelayResetToken();
      setToken(fresh);
    } catch (err) {
      console.error("chromeRelayResetToken failed:", err);
    } finally {
      setBusy(false);
    }
  };

  const enabled = status?.enabled ?? false;
  const wsUrl =
    status?.port != null ? `ws://127.0.0.1:${status.port}` : t("settings.chromeRelay.urlPending");

  return (
    <SettingsSection
      title={t("settings.chromeRelay.title")}
      desc={t("settings.chromeRelay.desc")}
      icon={GlobeIcon}
    >
      <SettingRow
        title={t("settings.chromeRelay.enableTitle")}
        desc={t("settings.chromeRelay.enableDesc")}
      >
        <Switch checked={enabled} disabled={busy} label={t("settings.chromeRelay.enableTitle")} onCheckedChange={(v) => void toggle(v)} />
      </SettingRow>

      {enabled && (
        <SettingRow title={t("settings.chromeRelay.statusTitle")} desc={t("settings.chromeRelay.howTo")} layout="vertical">
          <div className="space-y-2.5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
              <span className={status?.connected ? "text-success" : "text-content-subtle"}>
                {status?.connected
                  ? t("settings.chromeRelay.connected", { version: status.chromeVersion ?? "?" })
                  : status?.listening
                    ? t("settings.chromeRelay.listening")
                    : t("settings.chromeRelay.starting")}
              </span>
              <code className="rounded bg-surface-muted/60 px-1.5 py-0.5 font-mono">{wsUrl}</code>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="ghost" onClick={() => void resetToken()} disabled={busy}>
                <IconRefresh size={12} />
                {t("settings.chromeRelay.resetToken")}
              </Button>
              {token && (
                <code className="max-w-full truncate rounded bg-surface-muted/60 px-1.5 py-0.5 font-mono text-[11px] text-content">
                  {token}
                </code>
              )}
            </div>
            {!token && (
              <p className="text-[11px] leading-relaxed text-content-subtle">
                {t("settings.chromeRelay.tokenHint")}
              </p>
            )}
          </div>
        </SettingRow>
      )}
    </SettingsSection>
  );
}
