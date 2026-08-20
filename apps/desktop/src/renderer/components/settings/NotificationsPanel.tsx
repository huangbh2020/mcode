/**
 * Notifications settings panel.
 *
 * Controls the user's notification preferences (NotificationPrefs), persisted
 * via the `notification:setPrefs` IPC. The main-process NotificationManager
 * reads these to decide whether to fire OS notifications; the renderer's
 * in-app toast layer (sessionStore.pushToast) also respects the same prefs
 * indirectly (toasts only fire when the window is focused, at which point OS
 * notifications are suppressed - so the prefs gate the toast content too).
 *
 * Five toggles:
 *  - OS 通知总开关   (osEnabled) - master switch for system notifications
 *  - 阻塞类事件      (blocking)  - approval / question / plan approval
 *  - 回合完成        (turnComplete)
 *  - 错误            (errors)
 *  - 后台任务        (backgroundTasks)
 */
import { useEffect, useState } from "react";
import { api } from "@renderer/lib/api.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import type { NotificationPrefs } from "@contracts/ipc";
import { DEFAULT_NOTIFICATION_PREFS } from "@contracts/ipc";
import { Switch } from "@renderer/components/ui/index.js";
import { PanelHeader } from "./PanelHeader.js";
import { SettingRow } from "./SettingRow.js";
import { SettingsSection } from "./SettingsSection.js";

export function NotificationsPanel() {
  const { t } = useI18n();
  const [prefs, setPrefs] = useState<NotificationPrefs>(DEFAULT_NOTIFICATION_PREFS);
  const [loaded, setLoaded] = useState(false);

  // Load prefs on mount.
  useEffect(() => {
    void api.notification.getPrefs().then((res) => {
      setPrefs(res.prefs);
      setLoaded(true);
    });
  }, []);

  // Persist a single pref change.
  const update = (patch: Partial<NotificationPrefs>) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    void api.notification.setPrefs(next);
  };

  return (
    <section className="mx-auto w-full max-w-3xl space-y-4">
      <PanelHeader
        title={t("settings.notifications.title")}
        desc={t("settings.notifications.desc")}
      />

      {/* Single category → one card of toggle rows. */}
      <SettingsSection title={t("settings.notifications.section")}>
        {/* Master OS notification switch */}
        <SettingRow
          title={t("settings.notifications.osTitle")}
          desc={t("settings.notifications.osDesc")}
          htmlFor="setting-notif-os"
        >
          <Switch
            id="setting-notif-os"
            checked={prefs.osEnabled}
            disabled={!loaded}
            onCheckedChange={(v) => update({ osEnabled: v })}
            label={prefs.osEnabled ? t("settings.on") : t("settings.off")}
          />
        </SettingRow>

        {/* Blocking events */}
        <SettingRow
          title={t("settings.notifications.blockingTitle")}
          desc={t("settings.notifications.blockingDesc")}
        >
          <Switch
            checked={prefs.blocking}
            disabled={!loaded}
            onCheckedChange={(v) => update({ blocking: v })}
            label={prefs.blocking ? t("settings.on") : t("settings.off")}
          />
        </SettingRow>

        {/* Turn completion */}
        <SettingRow
          title={t("settings.notifications.turnTitle")}
          desc={t("settings.notifications.turnDesc")}
        >
          <Switch
            checked={prefs.turnComplete}
            disabled={!loaded}
            onCheckedChange={(v) => update({ turnComplete: v })}
            label={prefs.turnComplete ? t("settings.on") : t("settings.off")}
          />
        </SettingRow>

        {/* Errors */}
        <SettingRow
          title={t("settings.notifications.errorsTitle")}
          desc={t("settings.notifications.errorsDesc")}
        >
          <Switch
            checked={prefs.errors}
            disabled={!loaded}
            onCheckedChange={(v) => update({ errors: v })}
            label={prefs.errors ? t("settings.on") : t("settings.off")}
          />
        </SettingRow>

        {/* Background tasks */}
        <SettingRow
          title={t("settings.notifications.backgroundTitle")}
          desc={t("settings.notifications.backgroundDesc")}
        >
          <Switch
            checked={prefs.backgroundTasks}
            disabled={!loaded}
            onCheckedChange={(v) => update({ backgroundTasks: v })}
            label={prefs.backgroundTasks ? t("settings.on") : t("settings.off")}
          />
        </SettingRow>
      </SettingsSection>
    </section>
  );
}
