/**
 * Shortcuts settings panel — lists every bindable command grouped by
 * `CommandGroup`, each with a `ShortcutRecorder` for rebinding.
 *
 * The list is derived from `collectCommands(getState())`: only commands
 * visible in the command palette show up here, so a command gated behind
 * `available` (e.g. "close tab" with no tabs) is hidden until it applies.
 * Static bindable commands (those in `DEFAULT_SHORTCUTS`) are always shown
 * even if filtered out by `available`, so the user can rebind them ahead of
 * time — we merge the static defaults in unconditionally.
 *
 * Persistence: each recorder calls `setShortcutOverride(id, accel)` on the
 * store, which writes the whole override map to `ui.shortcuts` as JSON.
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
import { DEFAULT_SHORTCUTS } from "@renderer/lib/shortcuts.js";
import { Button, Kbd } from "@renderer/components/ui/index.js";
import { PanelHeader } from "./PanelHeader.js";
import { SettingsSection } from "./SettingsSection.js";
import { SettingRow } from "./SettingRow.js";
import { ShortcutRecorder } from "./ShortcutRecorder.js";
import { IconRefresh } from "@renderer/lib/icons.js";

export function ShortcutsPanel() {
  const { t } = useI18n();
  const resetAllShortcuts = useSessionStore((s) => s.resetAllShortcuts);

  // Build the display list: every command that has a default binding, plus
  // any palette-visible command the user has manually rebound (even if it
  // had no default). Dynamic session-switch commands are excluded — they're
  // not bindable (one per session).
  const commands = useMemo<CommandDef[]>(() => {
    const state = useSessionStore.getState();
    const overrides = state.shortcutOverrides;
    const visible = collectCommands(state).filter(
      (c) => !c.id.startsWith("session.switch."),
    );

    // Index by id to dedupe; prefer the static definition's metadata but
    // keep any command that's either in DEFAULT_SHORTCUTS or in overrides.
    const byId = new Map<string, CommandDef>();
    for (const cmd of visible) byId.set(cmd.id, cmd);

    // Ensure every bindable command (default or overridden) is shown even if
    // `available` currently filters it out — the user should be able to
    // rebind "close tab" before opening any tabs.
    for (const id of Object.keys(DEFAULT_SHORTCUTS)) {
      if (!byId.has(id)) {
        // Find the static definition (it was filtered by `available`).
        // collectCommands already applied availability, so re-scan the raw
        // static list via the same path: collect with a permissive state.
        // Simplest: synthesize a minimal stub from the id + default accel.
        byId.set(id, {
          id,
          label: t(labelForId(id)),
          group: groupForId(id),
          defaultAccelerator: DEFAULT_SHORTCUTS[id],
          perform: () => {},
        });
      }
    }
    for (const id of Object.keys(overrides)) {
      if (!byId.has(id) && !id.startsWith("session.switch.")) {
        byId.set(id, {
          id,
          label: t(labelForId(id)),
          group: groupForId(id),
          defaultAccelerator: DEFAULT_SHORTCUTS[id],
          perform: () => {},
        });
      }
    }

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
    "外观": "settings.shortcuts.groupAppearance",
  };

  return (
    <section className="space-y-4">
      <PanelHeader
        title={t("settings.shortcuts.title")}
        desc={
          <>
            {t("settings.shortcuts.desc1")}
            <Kbd keys={["⌘"]} size="xs" />
            {t("settings.shortcuts.desc2")}
            <Kbd keys={["Ctrl"]} size="xs" />
            {t("settings.shortcuts.desc3")}
          </>
        }
        action={
          <Button
            variant="ghost"
            size="sm"
            onClick={resetAllShortcuts}
            title={t("settings.shortcuts.resetAllTitle")}
            className="gap-1 shrink-0"
          >
            <IconRefresh size={12} />
            {t("settings.shortcuts.resetAll")}
          </Button>
        }
      />

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
                <ShortcutRecorder commandId={cmd.id} />
              </SettingRow>
            );
          })}
        </SettingsSection>
      ))}

      <p className="pt-1 text-[0.7143em] text-content-subtle">
        {t("settings.shortcuts.footer")}
      </p>
    </section>
  );
}

/* ────────── helpers for filtered-out static commands ────────── */

/** A message key for a command id, used when the command is currently
 *  filtered out by `available` (so we can't read its label from the
 *  collected list). Falls back to the id tail. */
function labelForId(id: string): MessageId {
  const map: Record<string, MessageId> = {
    "session.new": "settings.shortcuts.cmdNewSession",
    "tab.close": "settings.shortcuts.cmdCloseTab",
    "command.palette": "settings.shortcuts.cmdPalette",
    "view.display-mode.toggle": "settings.shortcuts.cmdToggleDisplayMode",
    "files.search": "settings.shortcuts.cmdSearchFiles",
    "view.settings": "settings.shortcuts.cmdSettings",
    "chat.focus-input": "settings.shortcuts.cmdFocusInput",
    "layout.toggle-left": "settings.shortcuts.cmdToggleLeft",
    "layout.toggle-right": "settings.shortcuts.cmdToggleRight",
    "layout.toggle-bottom-terminal": "settings.shortcuts.cmdToggleTerminal",
    "appearance.theme.toggle": "settings.shortcuts.cmdToggleTheme",
  };
  return map[id] ?? (id as MessageId);
}

/** The group a command belongs to, used for the filtered-out fallback. */
function groupForId(id: string): CommandGroup {
  if (id.startsWith("session.") || id.startsWith("tab.")) return "会话";
  if (id.startsWith("layout.")) return "布局";
  if (id.startsWith("appearance.")) return "外观";
  return "视图";
}
