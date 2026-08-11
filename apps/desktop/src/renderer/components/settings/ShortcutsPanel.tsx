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
          label: labelForId(id),
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
          label: labelForId(id),
          group: groupForId(id),
          defaultAccelerator: DEFAULT_SHORTCUTS[id],
          perform: () => {},
        });
      }
    }

    return Array.from(byId.values());
  }, []);

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

  const groupLabel: Record<CommandGroup, string> = {
    "会话": "会话",
    "视图": "视图 / 导航",
    "布局": "布局 / 面板",
    "外观": "外观 / 主题",
  };

  return (
    <section className="space-y-4">
      <PanelHeader
        title="快捷键"
        desc={
          <>
            点击右侧「修改」并按下新的组合键即可重新绑定。 Esc 取消录制。
            带 <Kbd keys={["⌘"]} size="xs" />/<Kbd keys={["Ctrl"]} size="xs" /> 的组合在输入框内依然生效。
          </>
        }
        action={
          <Button
            variant="ghost"
            size="sm"
            onClick={resetAllShortcuts}
            title="清除所有自定义绑定,恢复默认快捷键"
            className="gap-1 shrink-0"
          >
            <IconRefresh size={12} />
            恢复全部默认
          </Button>
        }
      />

      {grouped.map(({ group, items }) => (
        <SettingsSection key={group} title={groupLabel[group]}>
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
        提示:同一组合键只能绑定到一个命令;录制时会自动检测冲突并提供覆盖选项。
        修改即时生效并自动保存。
      </p>
    </section>
  );
}

/* ────────── helpers for filtered-out static commands ────────── */

/** A human label for a command id, used when the command is currently
 *  filtered out by `available` (so we can't read its label from the
 *  collected list). Falls back to the id tail. */
function labelForId(id: string): string {
  const map: Record<string, string> = {
    "session.new": "新建会话",
    "tab.close": "关闭当前标签页",
    "command.palette": "打开命令面板",
    "view.display-mode.toggle": "切换显示模式",
    "files.search": "搜索文件",
    "view.settings": "打开设置",
    "chat.focus-input": "聚焦聊天输入框",
    "layout.toggle-left": "切换左侧栏",
    "layout.toggle-right": "切换右侧栏",
    "layout.toggle-bottom-terminal": "切换底部终端",
    "appearance.theme.toggle": "切换深/浅主题",
  };
  return map[id] ?? id.split(".").pop() ?? id;
}

/** The group a command belongs to, used for the filtered-out fallback. */
function groupForId(id: string): CommandGroup {
  if (id.startsWith("session.") || id.startsWith("tab.")) return "会话";
  if (id.startsWith("layout.")) return "布局";
  if (id.startsWith("appearance.")) return "外观";
  return "视图";
}
