/**
 * Sidebar quick actions — two full-width primary buttons docked directly under
 * the brand logo at the top of the left bar:
 *
 *   新建会话 — starts a new thread in the active project (primary, accent CTA).
 *   搜索     — opens the unified Ctrl+K search palette.
 *
 * Each button occupies its own row and carries a trailing `<Kbd>` keycap badge
 * (from the UI component library) built from the effective shortcut (user
 * override ?? default), so the hint always matches what the keyboard actually
 * does. "新建会话" is disabled when there is no active project (mirrors the
 * `session.new` command's `available` guard).
 *
 * The pair sits above the "项目" header so the two most-used workspace entry
 * points are always visible without scrolling, regardless of how long the
 * project list grows.
 */
import { cn } from "@renderer/lib/cn.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import {
  resolveShortcut,
  acceleratorToDisplayTokens,
} from "@renderer/lib/shortcuts.js";
import { IconPlus, IconSearch } from "@renderer/lib/icons.js";
import { Kbd } from "@renderer/components/ui/index.js";
import { MobileConnectButton } from "@renderer/components/layout/MobileConnectDialog.js";

/** Trailing keyboard badge, consistent with the command palette. Subscribes to
 *  overrides so it updates live when the user rebinds in settings. */
function ShortcutBadge({ commandId }: { commandId: string }) {
  const overrides = useSessionStore((s) => s.shortcutOverrides);
  const accel = resolveShortcut(commandId, overrides);
  if (!accel) return null;
  return <Kbd keys={acceleratorToDisplayTokens(accel)} size="xs" />;
}

export function SidebarQuickActions() {
  const startSession = useSessionStore((s) => s.startSession);
  const setCommandPaletteOpen = useSessionStore((s) => s.setCommandPaletteOpen);
  const activeProjectId = useSessionStore((s) => s.activeProjectId);

  const canNewSession = activeProjectId !== null;

  return (
    <div className="mb-2 flex flex-col gap-1">
      {/* 新建会话 — neutral resting state (no persistent highlight), accent
          only on hover so it doesn't read as an "active/selected" row. */}
      <button
        type="button"
        onClick={() => {
          if (canNewSession) void startSession();
        }}
        disabled={!canNewSession}
        title={canNewSession ? "在当前项目下新建会话" : "请先打开一个项目"}
        className={cn(
          "flex w-full items-center gap-2 rounded-lg px-1 py-2 transition-colors",
          "[font-size:var(--right-panel-font-size)]",
          canNewSession
            ? "text-content-muted hover:bg-accent/10 hover:text-accent"
            : "cursor-not-allowed text-content-subtle opacity-50",
        )}
      >
        <IconPlus size={16} className="shrink-0" />
        <span className="flex-1 text-left font-medium">新建会话</span>
        <ShortcutBadge commandId="session.new" />
      </button>

      {/* 搜索 — entry to the unified Ctrl+K palette. Mirrors 新建会话's
          neutral rest + accent-on-hover so the two read as a matched pair. */}
      <button
        type="button"
        onClick={() => setCommandPaletteOpen(true)}
        title="搜索命令、线程、文件…"
        className={cn(
          "flex w-full items-center gap-2 rounded-lg px-1 py-2 transition-colors",
          "[font-size:var(--right-panel-font-size)]",
          "text-content-muted hover:bg-accent/10 hover:text-accent",
        )}
      >
        <IconSearch size={16} className="shrink-0" />
        <span className="flex-1 text-left font-medium">搜索</span>
        <ShortcutBadge commandId="command.palette" />
      </button>

      {/* 连接手机 — LAN pairing (QR + 6-digit code) / remote relay. Rendered
          as a self-contained trigger + dialog so the sidebar just hosts it;
          the button style mirrors 搜索/新建会话 so all three read as a matched
          group of workspace entry points. */}
      <MobileConnectButton />
    </div>
  );
}
