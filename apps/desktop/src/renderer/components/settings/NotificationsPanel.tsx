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
import type { NotificationPrefs } from "@contracts/ipc";
import { DEFAULT_NOTIFICATION_PREFS } from "@contracts/ipc";
import { Switch } from "@renderer/components/ui/index.js";
import { PanelHeader } from "./PanelHeader.js";
import { SettingRow } from "./SettingRow.js";
import { SettingsSection } from "./SettingsSection.js";

export function NotificationsPanel() {
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
    <section className="space-y-4">
      <PanelHeader
        title="消息通知"
        desc="配置后台会话活动何时通知你。应用失焦时使用系统通知,聚焦时使用应用内 Toast。未读事件始终在左侧会话列表和标签栏显示角标。"
      />

      {/* Single category → one card of toggle rows. */}
      <SettingsSection title="通知类型">
        {/* Master OS notification switch */}
        <SettingRow
          title="系统通知"
          desc="开启后,应用失焦或最小化时通过操作系统通知中心推送通知。关闭后仅保留应用内 Toast 和角标。"
          htmlFor="setting-notif-os"
        >
          <Switch
            id="setting-notif-os"
            checked={prefs.osEnabled}
            disabled={!loaded}
            onCheckedChange={(v) => update({ osEnabled: v })}
            label={prefs.osEnabled ? "已开启" : "已关闭"}
          />
        </SettingRow>

        {/* Blocking events */}
        <SettingRow
          title="阻塞类事件"
          desc="Agent 请求审批工具调用、向你提问、或提交计划待批准时通知。这是最高优先级通知——不响应 Agent 会一直等待。"
        >
          <Switch
            checked={prefs.blocking}
            disabled={!loaded}
            onCheckedChange={(v) => update({ blocking: v })}
            label={prefs.blocking ? "已开启" : "已关闭"}
          />
        </SettingRow>

        {/* Turn completion */}
        <SettingRow
          title="回合完成"
          desc="Agent 完成一轮任务时通知。适用于你切走后想知道任务是否做完的场景。"
        >
          <Switch
            checked={prefs.turnComplete}
            disabled={!loaded}
            onCheckedChange={(v) => update({ turnComplete: v })}
            label={prefs.turnComplete ? "已开启" : "已关闭"}
          />
        </SettingRow>

        {/* Errors */}
        <SettingRow
          title="错误"
          desc="Agent 运行出错时通知。适用于你切走后 Agent 意外中断需要处理的场景。"
        >
          <Switch
            checked={prefs.errors}
            disabled={!loaded}
            onCheckedChange={(v) => update({ errors: v })}
            label={prefs.errors ? "已开启" : "已关闭"}
          />
        </SettingRow>

        {/* Background tasks */}
        <SettingRow
          title="后台任务"
          desc="后台运行的子代理任务完成时通知。适用于你启动了后台任务后切走,想知道它何时结束的场景。"
        >
          <Switch
            checked={prefs.backgroundTasks}
            disabled={!loaded}
            onCheckedChange={(v) => update({ backgroundTasks: v })}
            label={prefs.backgroundTasks ? "已开启" : "已关闭"}
          />
        </SettingRow>
      </SettingsSection>
    </section>
  );
}

