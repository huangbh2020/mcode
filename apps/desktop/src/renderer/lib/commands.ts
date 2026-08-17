/**
 * Command registry for the Cmd/Ctrl+K command palette AND the global
 * keyboard-shortcut system. This is the single source of truth for "what
 * actions the app exposes": each command is a self-contained definition with
 * a label (search target), a group (visual cluster), an icon, a `perform`
 * that runs against the live store, and optionally a `defaultAccelerator`
 * that binds it to a keyboard chord out of the box.
 *
 * The shortcut system layers user overrides on top of `defaultAccelerator`
 * (see `lib/shortcuts.ts`): the *effective* binding for a command is its
 * override if present, else its default. The palette and the global keydown
 * listener share the same `perform`, so rebinding a chord needs no code
 * change — `collectCommands(state, overrides)` injects the resolved chord
 * into `shortcutHint` for display.
 *
 * Static commands are a module-level constant (their `perform` reads the live
 * store via the argument, never capturing stale state). Dynamic commands
 * (e.g. "switch to session X") are produced by `collectCommands()`, which
 * merges the static list with per-store-state items.
 *
 * i18n: static entries store a `labelKey` (a MessageId) instead of a baked
 * label; `collectCommands` resolves it against the live store locale so the
 * label is translated at collection time and consumers keep receiving a
 * plain `label: string`. `keywords` deliberately keep BOTH languages — they
 * are search targets (matched by `commandMatches`), never rendered, so a
 * Chinese query still finds commands while the UI is in English.
 * `COMMAND_GROUPS` values stay as-is: they double as stable bucket
 * identifiers for the settings shortcuts panel.
 */
import type { ComponentType } from "react";
import type { Accelerator } from "@contracts/ipc";
import type { SessionState } from "@renderer/stores/sessionStore.js";
import type { TablerIconProps } from "@renderer/lib/icons.js";
import { api } from "@renderer/lib/api.js";
import { isMac } from "@renderer/lib/platform.js";
import { DEFAULT_SHORTCUTS } from "@renderer/lib/shortcuts.js";
import { translate, type MessageId } from "@renderer/lib/i18n/core.js";
import {
  IconPlus,
  IconMessage,
  IconColumns3,
  IconList,
  IconLayoutSidebarLeftExpand,
  IconLayoutSidebarRightExpand,
  IconTerminal2,
  IconWorld,
  IconFolder,
  IconGitBranch,
  IconSettings,
  IconSun,
  IconMoon,
  IconSearch,
  IconKeyboard,
  IconX,
  IconArrowsExchange,
  IconArrowsMaximize,
  IconFocus,
} from "@renderer/lib/icons.js";

/** Visual grouping label shown as a section header in the palette. */
export const COMMAND_GROUPS = [
  "会话",
  "视图",
  "布局",
  "外观",
] as const;
export type CommandGroup = (typeof COMMAND_GROUPS)[number];

export interface CommandDef {
  /** Stable id for keying / dedup. Also the key into the shortcut bindings. */
  id: string;
  /** Display label — also the primary search target. */
  label: string;
  group: CommandGroup;
  /** Extra lowercase keywords matched by the filter (alongside the label). */
  keywords?: string[];
  /** Leading icon. */
  icon?: ComponentType<TablerIconProps>;
  /**
   * Default keyboard chord for this command. The effective binding is the
   * user's override (if any) falling back to this. Commands without a
   * `defaultAccelerator` simply have no shortcut until the user binds one.
   */
  defaultAccelerator?: Accelerator;
  /**
   * Effective chord for display, filled in by `collectCommands` from the
   * user's overrides + `defaultAccelerator`. Purely presentational; the
   * global keydown listener resolves bindings independently.
   */
  shortcutHint?: string;
  /** Run the command. Called with the live store so actions are fresh. */
  perform: (s: SessionState) => void | Promise<void>;
  /** Return false to hide the command for the current state. */
  available?: (s: SessionState) => boolean;
}

/* ───────────────────── static commands ───────────────────── */

/** Internal shape: same as CommandDef but with a dictionary key instead of a
 *  baked label, resolved per-collect against the current UI locale. */
type StaticCommandDef = Omit<CommandDef, "label"> & { labelKey: MessageId };

const STATIC_COMMANDS: StaticCommandDef[] = [
  // ── 会话 ──
  {
    id: "session.new",
    labelKey: "layout.newSession",
    group: "会话",
    keywords: ["new", "session", "chat", "thread", "新建", "对话"],
    icon: IconPlus,
    defaultAccelerator: DEFAULT_SHORTCUTS["session.new"],
    perform: (s) => {
      void s.startSession();
    },
    available: (s) => s.activeProjectId !== null,
  },
  {
    id: "tab.close",
    labelKey: "lib.commands.closeTab",
    group: "会话",
    keywords: ["close", "tab", "关闭", "标签"],
    icon: IconX,
    defaultAccelerator: DEFAULT_SHORTCUTS["tab.close"],
    perform: (s) => {
      if (s.activeSessionId) s.closeTab(s.activeSessionId);
    },
    available: (s) => s.displayMode === "tabs" && s.openTabs.length > 0,
  },

  // ── 视图 ──
  {
    id: "command.palette",
    labelKey: "lib.commands.openPalette",
    group: "视图",
    keywords: ["command", "palette", "search", "命令", "面板"],
    icon: IconKeyboard,
    defaultAccelerator: DEFAULT_SHORTCUTS["command.palette"],
    perform: (s) => {
      s.setCommandPaletteOpen(!s.commandPaletteOpen);
    },
  },
  {
    id: "view.display-mode.single",
    labelKey: "lib.commands.displaySingle",
    group: "视图",
    keywords: ["single", "display", "mode", "单", "模式"],
    icon: IconMessage,
    perform: (s) => {
      void s.setDisplayMode("single");
    },
    available: (s) => s.displayMode !== "single",
  },
  {
    id: "view.display-mode.tabs",
    labelKey: "lib.commands.displayTabs",
    group: "视图",
    keywords: ["tabs", "display", "mode", "标签", "多开", "模式"],
    icon: IconColumns3,
    perform: (s) => {
      void s.setDisplayMode("tabs");
    },
    available: (s) => s.displayMode !== "tabs",
  },
  {
    id: "view.display-mode.toggle",
    labelKey: "lib.commands.displayToggle",
    group: "视图",
    keywords: ["toggle", "display", "mode", "切换", "模式"],
    icon: IconArrowsExchange,
    defaultAccelerator: DEFAULT_SHORTCUTS["view.display-mode.toggle"],
    perform: (s) => {
      void s.setDisplayMode(s.displayMode === "tabs" ? "single" : "tabs");
    },
    available: (s) => s.activeProjectId !== null,
  },
  {
    id: "view.right-panel.files",
    labelKey: "lib.commands.rightPanelFiles",
    group: "视图",
    keywords: ["files", "right", "panel", "文件", "右栏"],
    icon: IconFolder,
    perform: (s) => {
      s.setRightPanelTab("files");
      s.setRightOpen(true);
    },
  },
  {
    id: "files.search",
    labelKey: "lib.commands.searchFiles",
    group: "视图",
    keywords: ["search", "files", "grep", "搜索", "查找", "文件"],
    icon: IconSearch,
    defaultAccelerator: DEFAULT_SHORTCUTS["files.search"],
    perform: (s) => {
      s.setSearchDialogOpen(true);
    },
    available: (s) => s.activeProjectId !== null,
  },
  {
    id: "view.right-panel.git",
    labelKey: "lib.commands.rightPanelGit",
    group: "视图",
    keywords: ["git", "right", "panel", "右栏"],
    icon: IconGitBranch,
    perform: (s) => {
      s.setRightPanelTab("git");
      s.setRightOpen(true);
    },
  },
  {
    id: "view.settings",
    labelKey: "lib.commands.openSettings",
    group: "视图",
    keywords: ["settings", "preferences", "设置", "偏好"],
    icon: IconSettings,
    defaultAccelerator: DEFAULT_SHORTCUTS["view.settings"],
    perform: (s) => {
      s.setSettingsOpen(true);
    },
  },
  {
    id: "chat.focus-input",
    labelKey: "lib.commands.focusComposer",
    group: "视图",
    keywords: ["focus", "chat", "input", "composer", "聚焦", "输入"],
    icon: IconFocus,
    defaultAccelerator: DEFAULT_SHORTCUTS["chat.focus-input"],
    perform: () => {
      // The composer is a Tiptap contentEditable; its inner .ProseMirror node
      // is the actual focusable element. Reaching it via querySelector keeps
      // this command decoupled from the composer's ref/imperative handle.
      const el = document.querySelector<HTMLElement>(
        ".composer-host .ProseMirror",
      );
      if (el) el.focus();
    },
  },

  // ── 布局 ──
  {
    id: "layout.toggle-left",
    labelKey: "lib.commands.toggleLeft",
    group: "布局",
    keywords: ["left", "sidebar", "toggle", "左侧", "侧栏"],
    icon: IconLayoutSidebarLeftExpand,
    defaultAccelerator: DEFAULT_SHORTCUTS["layout.toggle-left"],
    // Hidden while wide-panel (2:8) mode is on: the left sidebar is locked
    // closed there and must not be reopened via palette/shortcut.
    available: (s) => !s.widePanelOpen,
    perform: (s) => {
      s.setLeftOpen(!s.leftOpen);
    },
  },
  {
    id: "layout.toggle-right",
    labelKey: "lib.commands.toggleRight",
    group: "布局",
    keywords: ["right", "sidebar", "panel", "toggle", "右侧", "右栏"],
    icon: IconLayoutSidebarRightExpand,
    defaultAccelerator: DEFAULT_SHORTCUTS["layout.toggle-right"],
    perform: (s) => {
      s.setRightOpen(!s.rightOpen);
    },
  },
  {
    id: "layout.toggle-bottom-terminal",
    labelKey: "lib.commands.toggleTerminal",
    group: "布局",
    keywords: ["terminal", "bottom", "toggle", "终端", "底部"],
    icon: IconTerminal2,
    defaultAccelerator: DEFAULT_SHORTCUTS["layout.toggle-bottom-terminal"],
    perform: (s) => {
      s.setBottomTerminalOpen(!s.bottomTerminalOpen);
    },
  },
  {
    id: "layout.toggle-browser",
    labelKey: "lib.commands.toggleBrowser",
    group: "布局",
    keywords: ["browser", "web", "toggle", "浏览器", "网页"],
    icon: IconWorld,
    defaultAccelerator: DEFAULT_SHORTCUTS["layout.toggle-browser"],
    perform: (s) => {
      // Toggle the embedded sidebar browser (mobile-first). Mirrors the rail
      // icon: open it if another tab is active, or close it (fall back to
      // files) if it's already showing. The PC-fullscreen overlay is reached
      // from inside the sidebar via its own "展开为 PC 全屏" button.
      s.setRightPanelTab(s.rightPanelTab === "browser" ? "files" : "browser");
    },
  },
  {
    id: "layout.toggle-wide-panel",
    labelKey: "lib.commands.toggleWide",
    group: "布局",
    keywords: ["wide", "panel", "fullscreen", "width", "宽屏", "全屏", "2:8", "右栏"],
    icon: IconArrowsMaximize,
    defaultAccelerator: DEFAULT_SHORTCUTS["layout.toggle-wide-panel"],
    perform: (s) => {
      // 2:8 layout: hide the left sidebar + center editor and show the chat
      // column + full right panel. Entering snapshots the layout for restore on
      // exit; the right panel keeps its current tab.
      s.setWidePanelOpen(!s.widePanelOpen);
    },
  },

  // ── 外观 ──
  {
    id: "appearance.theme.light",
    labelKey: "lib.commands.themeLight",
    group: "外观",
    keywords: ["theme", "light", "主题", "浅色", "亮色"],
    icon: IconSun,
    perform: () => {
      void api.theme.set({ theme: "light" });
    },
  },
  {
    id: "appearance.theme.dark",
    labelKey: "lib.commands.themeDark",
    group: "外观",
    keywords: ["theme", "dark", "主题", "深色", "暗色"],
    icon: IconMoon,
    perform: () => {
      void api.theme.set({ theme: "dark" });
    },
  },
  {
    id: "appearance.theme.toggle",
    labelKey: "lib.commands.themeToggle",
    group: "外观",
    keywords: ["toggle", "theme", "切换", "主题"],
    icon: IconArrowsExchange,
    defaultAccelerator: DEFAULT_SHORTCUTS["appearance.theme.toggle"],
    perform: () => {
      // Derive the current effective theme from the <html> class set by
      // useTheme (kept in sync with the persisted preference + OS). Toggling
      // then writes the explicit opposite so it sticks across restarts.
      const isDark = document.documentElement.classList.contains("dark");
      void api.theme.set({ theme: isDark ? "light" : "dark" });
    },
  },
];

/* ───────────────────── dynamic commands ───────────────────── */

/** Build the full command list for the current store state.
 *
 *  Merges the static commands with dynamic "switch to session X" entries
 *  (one per session in the active project's loaded page). `s` is the live
 *  store snapshot — the palette passes `useSessionStore.getState()` so
 *  `perform` runs against fresh actions.
 *
 *  `overrides` (optional) injects each command's *effective* shortcut into
 *  `shortcutHint` for display: the user's override if present, else the
 *  command's `defaultAccelerator`. The global keydown listener resolves
 *  bindings from the same source, so what the palette shows always matches
 *  what the keyboard does. Rendering is platform-aware (⌘ on mac, Ctrl
 *  elsewhere) via `acceleratorToDisplayString`. */
export function collectCommands(s: SessionState): CommandDef[] {
  const locale = s.locale;
  const cmds: CommandDef[] = STATIC_COMMANDS.filter(
    (c) => !c.available || c.available(s),
  ).map((c) => ({ ...c, label: translate(locale, c.labelKey) }));

  // Dynamic: "switch to session" — one per session in the active project's
  // currently-loaded page. Rendered under the 会话 group so the user can
  // fuzzy-jump to any open thread.
  const pid = s.activeProjectId;
  const sessions = pid ? s.sessionsByProject[pid] ?? [] : [];
  for (const sess of sessions) {
    const title = sess.title?.trim() || translate(locale, "lib.untitledSession");
    cmds.push({
      id: `session.switch.${sess.id}`,
      label: translate(locale, "lib.commands.switchToSession", { title }),
      group: "会话",
      keywords: ["switch", "session", "open", "tab", "切换", "跳转", title],
      icon: IconList,
      perform: (store) => {
        void store.openTab(sess.id);
      },
    });
  }

  return cmds;
}

/** Case-insensitive substring match against a command's label + keywords.
 *  An empty query matches everything. */
export function commandMatches(cmd: CommandDef, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (cmd.label.toLowerCase().includes(q)) return true;
  return (cmd.keywords ?? []).some((k) => k.toLowerCase().includes(q));
}

/** Re-exported for the settings panel + shortcut listener. The platform
 *  label is also handy for UI hints ("hold ⌘/Ctrl to…"). */
export { isMac };
