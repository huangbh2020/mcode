/**
 * 「新建会话」统一菜单 — a base-ui dropdown menu integrating both standard chat
 * sessions and terminal CLI sessions (claude / pi / codex / opencode / antigravity).
 *
 * Used by:
 * 1. SidebarQuickActions: attached to the split button's chevron dropdown trigger.
 * 2. LeftBar project row: attached to the project hover action button.
 */
import type { ReactNode } from "react";
import { Menu } from "@base-ui/react/menu";
import { cn } from "@renderer/lib/cn.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { getProviderIcon } from "@renderer/lib/providerIcon.js";
import { IconPlus } from "@renderer/lib/icons.js";
import { Kbd } from "@renderer/components/ui/index.js";
import {
  resolveShortcut,
  acceleratorToDisplayTokens,
} from "@renderer/lib/shortcuts.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import {
  TERMINAL_CLI_PROVIDER_IDS,
  TERMINAL_CLI_FALLBACK_LABELS,
} from "@renderer/lib/terminalCli.js";

function ShortcutBadge({ commandId }: { commandId: string }) {
  const overrides = useSessionStore((s) => s.shortcutOverrides);
  const accel = resolveShortcut(commandId, overrides);
  if (!accel) return null;
  return <Kbd keys={acceleratorToDisplayTokens(accel)} size="xs" />;
}

export function NewSessionMenu({
  projectId,
  disabled,
  triggerTitle,
  triggerClassName,
  children,
  showChatOption = true,
  onNewSession,
  onNewTerminalSession,
}: {
  /** Target project (undefined = the store's active project). */
  projectId?: string;
  disabled?: boolean;
  triggerTitle?: string;
  triggerClassName?: string;
  children: ReactNode;
  /** Whether to include the standard chat session option in the dropdown (defaults to true). */
  showChatOption?: boolean;
  /** Custom dispatch for new chat session (e.g. worktree override). */
  onNewSession?: () => void;
  /** Custom dispatch for new terminal session (e.g. stream view scoped project). */
  onNewTerminalSession?: (providerId: string) => void;
}) {
  const { t } = useI18n();
  const startSession = useSessionStore((s) => s.startSession);
  const startTerminalSession = useSessionStore((s) => s.startTerminalSession);
  const providers = useSessionStore((s) => s.providers);
  const cliEnabled = useSessionStore((s) => s.terminalCliEnabled);
  const setSettingsOpen = useSessionStore((s) => s.setSettingsOpen);
  const offered = TERMINAL_CLI_PROVIDER_IDS.filter((id) => cliEnabled[id] !== false);

  const handleNewChat = () => {
    if (onNewSession) {
      onNewSession();
    } else {
      void startSession(projectId);
    }
  };

  const handleNewTerminal = (id: string) => {
    if (onNewTerminalSession) {
      onNewTerminalSession(id);
    } else {
      void startTerminalSession(projectId, id);
    }
  };

  return (
    <Menu.Root>
      <Menu.Trigger
        disabled={disabled}
        title={triggerTitle}
        className={triggerClassName}
      >
        {children}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="end" sideOffset={4}>
          <Menu.Popup
            className={cn(
              "z-50 min-w-44 origin-top-left rounded-md border border-edge bg-surface py-1 shadow-2xl",
              "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
              "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
              "transition-[transform,opacity] duration-100",
            )}
          >
            {showChatOption && (
              <>
                <Menu.Item
                  className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-[0.8571em] text-content outline-none transition-colors data-[highlighted]:bg-surface-hover data-[highlighted]:text-accent"
                  onClick={handleNewChat}
                >
                  <IconPlus size={14} className="shrink-0 text-accent" />
                  <span className="flex-1 truncate font-medium">
                    {t("layout.newSessionMenu.chatSession")}
                  </span>
                  <ShortcutBadge commandId="session.new" />
                </Menu.Item>
                <div className="my-1 h-[1px] bg-edge/50" />
              </>
            )}

            <div className="px-2 py-1 text-[11px] font-medium text-content-subtle">
              {t("layout.newSessionMenu.terminalSection")}
            </div>

            {offered.length === 0 ? (
              <Menu.Item
                className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-[0.8571em] text-content-muted outline-none transition-colors data-[highlighted]:bg-surface-hover data-[highlighted]:text-content"
                onClick={() => setSettingsOpen(true, "runtimes")}
              >
                <span className="flex-1 truncate">{t("layout.terminalMenu.noneEnabled")}</span>
              </Menu.Item>
            ) : (
              offered.map((id) => {
                const { Icon, color } = getProviderIcon(id);
                const label =
                  providers.find((p) => p.id === id)?.displayName ??
                  TERMINAL_CLI_FALLBACK_LABELS[id] ??
                  id;
                return (
                  <Menu.Item
                    key={id}
                    className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-[0.8571em] text-content-muted outline-none transition-colors data-[highlighted]:bg-surface-hover data-[highlighted]:text-content"
                    onClick={() => handleNewTerminal(id)}
                  >
                    <Icon size={14} className={cn("shrink-0", color)} />
                    <span className="flex-1 truncate">{label}</span>
                  </Menu.Item>
                );
              })
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
