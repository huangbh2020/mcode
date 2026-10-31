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
 *
 * (连接手机 lives in the sidebars' bottom settings rail as a compact icon
 * trigger — see MobileConnectButton; 定时任务's full-window viewer opens from
 * the right panel's 定时任务 tab. Neither is a quick action anymore.)
 */
import { cn } from "@renderer/lib/cn.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import {
  resolveShortcut,
  acceleratorToDisplayTokens,
} from "@renderer/lib/shortcuts.js";
import { IconGitFork, IconPlus, IconSearch, IconChevronDown } from "@renderer/lib/icons.js";
import { NewSessionMenu } from "@renderer/components/layout/NewSessionMenu.js";
import { Kbd } from "@renderer/components/ui/index.js";
import { useI18n } from "@renderer/lib/i18n/index.js";

/** Trailing keyboard badge, consistent with the command palette. Subscribes to
 *  overrides so it updates live when the user rebinds in settings. */
function ShortcutBadge({ commandId }: { commandId: string }) {
  const overrides = useSessionStore((s) => s.shortcutOverrides);
  const accel = resolveShortcut(commandId, overrides);
  if (!accel) return null;
  return <Kbd keys={acceleratorToDisplayTokens(accel)} size="xs" />;
}

export function SidebarQuickActions({
  newSessionOverride,
  newSessionOverrideTitle,
  newTerminalSessionOverride,
}: {
  /** When set, 新建会话 dispatches here instead of the default
   *  active-project start (stream view scoped to a worktree: spawn the
   *  session in THAT checkout; scoped to a plain project: spawn it under
   *  THAT project). Title flips to the override wording unless
   *  `newSessionOverrideTitle` says otherwise. */
  newSessionOverride?: () => void;
  /** Already-translated tooltip for the override state (defaults to the
   *  worktree wording — the original override case). */
  newSessionOverrideTitle?: string;
  /** When set, 终端会话 dispatches here with the PICKED provider id instead
   *  of the default active-project start (stream view scoped to a plain
   *  project: spawn the terminal under THAT project). Worktree scopes don't
   *  override — terminal sessions are always local to a project root. */
  newTerminalSessionOverride?: (providerId: string) => void;
} = {}) {
  const { t } = useI18n();
  const startSession = useSessionStore((s) => s.startSession);
  const startTerminalSession = useSessionStore((s) => s.startTerminalSession);
  const setCommandPaletteOpen = useSessionStore((s) => s.setCommandPaletteOpen);
  const activeProjectId = useSessionStore((s) => s.activeProjectId);

  const canNewSession = newSessionOverride != null || activeProjectId !== null;

  return (
    <div className="mb-2 flex flex-col gap-1">
      {/* 新建会话 (Split Button) — integrated chat + terminal entry.
          Main area: starts a new thread in the active project (Ctrl+N).
          Right chevron: opens unified dropdown for chat & terminal CLIs. */}
      <div
        className={cn(
          "group/split flex w-full items-stretch rounded-lg transition-colors",
          canNewSession
            ? "text-content-muted hover:bg-accent/10 hover:text-accent"
            : "cursor-not-allowed text-content-subtle opacity-50",
        )}
      >
        <button
          type="button"
          onClick={() => {
            if (newSessionOverride) newSessionOverride();
            else if (canNewSession) void startSession();
          }}
          disabled={!canNewSession}
          title={
            newSessionOverride
              ? newSessionOverrideTitle ?? t("layout.newSessionInWorktree")
              : canNewSession
                ? t("layout.newSessionInProject")
                : t("layout.needProject")
          }
          className={cn(
            "flex flex-1 min-w-0 items-center gap-2 rounded-l-lg px-1 py-2 text-left transition-colors",
            "[font-size:var(--right-panel-font-size)]",
            "focus:outline-none",
            !canNewSession && "cursor-not-allowed",
          )}
        >
          {newSessionOverride ? (
            <IconGitFork size={16} className="shrink-0" />
          ) : (
            <IconPlus size={16} className="shrink-0" />
          )}
          <span className="flex-1 truncate font-medium">{t("layout.newSession")}</span>
          <ShortcutBadge commandId="session.new" />
        </button>

        <div className="my-1.5 w-[1px] bg-edge/40 transition-colors group-hover/split:bg-accent/25" />

        <NewSessionMenu
          disabled={!canNewSession}
          triggerTitle={t("layout.newSessionMenu.more")}
          onNewSession={newSessionOverride}
          onNewTerminalSession={newTerminalSessionOverride}
          triggerClassName={cn(
            "flex shrink-0 items-center justify-center rounded-r-lg px-1.5 transition-colors",
            "hover:bg-accent/20 hover:text-accent focus:outline-none",
            !canNewSession && "cursor-not-allowed",
          )}
        >
          <IconChevronDown size={13} className="shrink-0 opacity-70 group-hover/split:opacity-100" />
        </NewSessionMenu>
      </div>

      {/* 搜索 — entry to the unified Ctrl+K palette. Mirrors 新建会话's
          neutral rest + accent-on-hover so the two read as a matched pair. */}
      <button
        type="button"
        onClick={() => setCommandPaletteOpen(true)}
        title={t("layout.palette.placeholder.all")}
        className={cn(
          "flex w-full items-center gap-2 rounded-lg px-1 py-2 transition-colors",
          "[font-size:var(--right-panel-font-size)]",
          "text-content-muted hover:bg-accent/10 hover:text-accent",
        )}
      >
        <IconSearch size={16} className="shrink-0" />
        <span className="flex-1 text-left font-medium">{t("common.search")}</span>
        <ShortcutBadge commandId="command.palette" />
      </button>
    </div>
  );
}
