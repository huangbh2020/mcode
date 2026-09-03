/**
 * Mouse-gestures settings panel — master toggle + trigger button + the
 * per-command gesture binding list. The pointer twin of ShortcutsPanel.
 *
 * The bindable-command list is derived the same way: palette-visible commands
 * from `collectCommands(state)` (minus the dynamic per-session switch
 * entries), merged with every command that has a default gesture or a user
 * override — so a command currently filtered out by `available` (e.g.
 * "close tab" with no tabs open) can still be bound ahead of time.
 *
 * Persistence: each row's GestureRecorder calls `setGestureOverride(id, seq)`
 * on the store, which writes the whole `ui.gestures` JSON blob (enabled +
 * trigger + overrides together).
 */
import { useMemo } from "react";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import {
  collectCommands,
  COMMAND_GROUPS,
  type CommandDef,
  type CommandGroup,
} from "@renderer/lib/commands.js";
import { DEFAULT_GESTURES } from "@renderer/lib/gestures.js";
import { Button, Select, Switch } from "@renderer/components/ui/index.js";
import { PanelHeader } from "./PanelHeader.js";
import { SettingsSection } from "./SettingsSection.js";
import { SettingRow } from "./SettingRow.js";
import { GestureRecorder } from "./GestureRecorder.js";
import { IconRefresh } from "@renderer/lib/icons.js";

export function GesturesPanel() {
  const { t } = useI18n();
  const gestureSettings = useSessionStore((s) => s.gestureSettings);
  const setGestureEnabled = useSessionStore((s) => s.setGestureEnabled);
  const setGestureTrigger = useSessionStore((s) => s.setGestureTrigger);
  const resetAllGestures = useSessionStore((s) => s.resetAllGestures);

  // Build the display list: every palette-visible command, plus any command
  // that has a default gesture or a user override even if `available`
  // currently filters it out (rebinding ahead of time must be possible).
  const commands = useMemo<CommandDef[]>(() => {
    const state = useSessionStore.getState();
    const overrides = state.gestureSettings.overrides;
    const visible = collectCommands(state).filter(
      (c) => !c.id.startsWith("session.switch."),
    );
    const byId = new Map<string, CommandDef>();
    for (const cmd of visible) byId.set(cmd.id, cmd);
    const ensure = (id: string) => {
      if (byId.has(id)) return;
      const fallback = FALLBACK_LABELS[id];
      byId.set(id, {
        id,
        label: fallback ? t(fallback) : id,
        group: groupForId(id),
        perform: () => {},
      });
    };
    for (const id of Object.keys(DEFAULT_GESTURES)) ensure(id);
    for (const id of Object.keys(overrides)) ensure(id);
    return Array.from(byId.values());
    // t changes identity on locale flip, rebuilding the fallback labels.
  }, [t]);

  // Bucket by group, preserving COMMAND_GROUPS order.
  const grouped = useMemo(() => {
    const map = new Map<CommandGroup, CommandDef[]>();
    for (const g of COMMAND_GROUPS) map.set(g, []);
    for (const cmd of commands) {
      const bucket = map.get(cmd.group);
      if (bucket) bucket.push(cmd);
    }
    return COMMAND_GROUPS.map((g) => ({ group: g, items: map.get(g)! })).filter(
      (x) => x.items.length > 0,
    );
  }, [commands]);

  const groupLabel: Record<CommandGroup, MessageId> = {
    "会话": "settings.shortcuts.groupSession",
    "视图": "settings.shortcuts.groupView",
    "布局": "settings.shortcuts.groupLayout",
    "编辑器": "settings.shortcuts.groupEditor",
    "外观": "settings.shortcuts.groupAppearance",
  };

  return (
    <section className="mx-auto w-full max-w-3xl space-y-4">
      <PanelHeader
        title={t("settings.gestures.title")}
        action={
          <Button
            variant="ghost"
            size="sm"
            onClick={resetAllGestures}
            title={t("settings.gestures.resetAllTitle")}
            className="gap-1 shrink-0"
          >
            <IconRefresh size={12} />
            {t("settings.gestures.resetAll")}
          </Button>
        }
      />

      <SettingsSection title={t("settings.gestures.sectionGeneral")}>
        <SettingRow title={t("settings.gestures.enabled")}>
          <Switch
            checked={gestureSettings.enabled}
            onCheckedChange={(v) => setGestureEnabled(v)}
            label={t("settings.gestures.enabled")}
          />
        </SettingRow>
        <SettingRow
          title={t("settings.gestures.trigger")}
          desc={
            gestureSettings.trigger === "middle"
              ? t("settings.gestures.triggerMiddleNote")
              : undefined
          }
        >
          <Select.Root
            value={gestureSettings.trigger}
            onValueChange={(v) => {
              if (v === "right" || v === "middle") setGestureTrigger(v);
            }}
          >
            <Select.Trigger className="w-full">
              <Select.Value>
                {(val: string) =>
                  val === "middle"
                    ? t("settings.gestures.triggerMiddle")
                    : t("settings.gestures.triggerRight")
                }
              </Select.Value>
            </Select.Trigger>
            <Select.Portal>
              <Select.Positioner>
                <Select.Popup>
                  <Select.List>
                    <Select.Item value="right">
                      <Select.ItemText>{t("settings.gestures.triggerRight")}</Select.ItemText>
                    </Select.Item>
                    <Select.Item value="middle">
                      <Select.ItemText>{t("settings.gestures.triggerMiddle")}</Select.ItemText>
                    </Select.Item>
                  </Select.List>
                </Select.Popup>
              </Select.Positioner>
            </Select.Portal>
          </Select.Root>
        </SettingRow>
      </SettingsSection>

      {grouped.map(({ group, items }) => (
        <SettingsSection key={group} title={t(groupLabel[group])}>
          {items.map((cmd) => {
            const Icon = cmd.icon;
            return (
              <SettingRow
                key={cmd.id}
                title={
                  <span className="flex items-center gap-2">
                    {Icon && (
                      <Icon
                        size={14}
                        className="shrink-0 text-content-muted"
                      />
                    )}
                    {cmd.label}
                  </span>
                }
                htmlFor={undefined}
              >
                <GestureRecorder commandId={cmd.id} />
              </SettingRow>
            );
          })}
        </SettingsSection>
      ))}

      <p className="pt-1 text-[0.7143em] text-content-subtle">
        {t("settings.gestures.footer")}
      </p>
    </section>
  );
}

/* ────────── helpers for filtered-out static commands ────────── */

/** Dictionary keys for the commands that carry a default gesture — used when
 *  `available` filters the command out of the collected list so the row still
 *  shows a translated label. Mirrors ShortcutsPanel's labelForId. */
const FALLBACK_LABELS: Record<string, MessageId> = {
  "session.close": "lib.commands.closeSession",
  "session.new": "layout.newSession",
  "layout.toggle-left": "lib.commands.toggleLeft",
  "layout.toggle-right": "lib.commands.toggleRight",
  "layout.toggle-bottom-terminal": "lib.commands.toggleTerminal",
};

/** The group a command belongs to, used for the filtered-out fallback.
 *  Mirrors ShortcutsPanel's groupForId. */
function groupForId(id: string): CommandGroup {
  if (id.startsWith("session.") || id.startsWith("tab.") || id.startsWith("voice.")) return "会话";
  if (id.startsWith("layout.")) return "布局";
  if (id.startsWith("appearance.")) return "外观";
  return "视图";
}
