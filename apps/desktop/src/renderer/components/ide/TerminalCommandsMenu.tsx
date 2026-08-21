import { useState } from "react";
import { Menu } from "@base-ui/react/menu";
import { cn } from "@renderer/lib/cn.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { Button, Dialog, Input } from "@renderer/components/ui/index.js";
import {
  IconBookmark,
  IconPlus,
  IconPlayerPlay,
} from "@renderer/lib/icons.js";
import type { CustomCommand } from "@contracts/ipc";
import { useI18n } from "@renderer/lib/i18n/index.js";

/** Module-level empty array so the selector returns a stable reference when
 *  the active project has no saved commands (avoids the infinite-render trap
 *  documented in AGENTS.md). */
const EMPTY: CustomCommand[] = [];

/**
 * Terminal quick-commands menu.
 *
 * A bookmark-shaped toolbar button that opens an upward dropdown listing the
 * **active project's** saved commands. Clicking a command's name runs it in a
 * NEW terminal tab (auto-created + switched to); the hover-revealed play
 * button runs it in the current active terminal instead. The menu also carries
 * an inline **quick-add** flow (name + command) - editing and deleting existing
 * commands is done in Settings -> 终端.
 *
 * Commands are scoped per-project (see `customCommandsByProject` in the store).
 * When no project is active the menu is disabled.
 *
 * Mirrors the base-ui Menu styling of the composer dropdowns
 * (ModelDropdown / ComposerOptionsDropdown) so it reads as part of the same
 * control family. Positioned side="top" so it opens upward above the bottom
 * terminal bar.
 */
export function TerminalCommandsMenu({
  onRun,
  onRunInNewTerminal,
}: {
  onRun: (command: string) => void;
  onRunInNewTerminal: (command: string) => void;
}) {
  const { t } = useI18n();
  const activeProjectId = useSessionStore((s) => s.activeProjectId);
  const commands = useSessionStore((s) =>
    activeProjectId ? s.customCommandsByProject[activeProjectId] ?? EMPTY : EMPTY,
  );
  const addCustomCommand = useSessionStore((s) => s.addCustomCommand);

  // Quick-add dialog state: null = closed, otherwise a blank draft.
  const [adding, setAdding] = useState<{ name: string; command: string } | null>(null);

  const openAdd = () => setAdding({ name: "", command: "" });

  const save = () => {
    if (!adding || !activeProjectId) return;
    const name = adding.name.trim();
    const command = adding.command.trim();
    if (!name || !command) return; // require both fields
    addCustomCommand(activeProjectId, { name, command });
    setAdding(null);
  };

  const disabled = !activeProjectId;

  return (
    <>
      <Menu.Root>
        <Menu.Trigger
          render={
            <button
              type="button"
              title={disabled ? t("ide.term.selectProjectFirst") : t("ide.term.customCommands")}
              disabled={disabled}
              className={cn(
                "rounded p-1 text-content-subtle hover:bg-surface-hover hover:text-content",
                disabled && "cursor-not-allowed opacity-50 hover:bg-transparent hover:text-content-subtle",
              )}
            />
          }
        >
          <IconBookmark size={13} className="shrink-0" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side="top" align="end" sideOffset={4}>
            <Menu.Popup
              className={cn(
                "z-50 min-w-[240px] origin-bottom-right rounded-md border border-edge bg-surface py-1 shadow-2xl",
                "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
                "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
                "transition-[transform,opacity] duration-100",
              )}
            >
              <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-content-subtle">
                {t("ide.term.customCommands")}
              </div>

              {commands.length === 0 ? (
                <div className="px-3 py-3 text-center text-[11px] text-content-subtle">
                  {t("ide.term.noCommands")}
                </div>
              ) : (
                commands.map((cmd) => (
                  <div
                    key={cmd.id}
                    className="group flex items-center gap-1 px-1 py-0.5 data-[highlighted]:bg-surface-muted"
                  >
                    {/* Clickable body: name (primary) + command (secondary, mono).
                        Primary click opens a NEW terminal tab and runs there. */}
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-baseline gap-2 px-2 py-1 text-left"
                      onClick={() => {
                        onRunInNewTerminal(cmd.command);
                      }}
                      title={t("ide.term.runInNewTerminal", { command: cmd.command })}
                    >
                      <span className="shrink-0 text-[11px] font-medium text-content">
                        {cmd.name}
                      </span>
                      <span className="min-w-0 truncate font-mono text-[10px] text-content-subtle">
                        {cmd.command}
                      </span>
                    </button>
                    {/* Hover-revealed: run in the CURRENT terminal (the long-form
                        play icon hints "re-use existing"). Edit/delete in Settings. */}
                    <div className="flex shrink-0 items-center opacity-0 group-hover:opacity-100 data-[highlighted]:opacity-100">
                      <button
                        type="button"
                        className="rounded p-0.5 text-content-subtle hover:bg-surface-hover hover:text-accent"
                        title={t("ide.term.runInCurrent")}
                        onClick={() => onRun(cmd.command)}
                      >
                        <IconPlayerPlay size={11} />
                      </button>
                    </div>
                  </div>
                ))
              )}

              <div className="my-1 border-t border-edge" />
              <Menu.Item
                className={cn(
                  "flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[11px] outline-none select-none",
                  "text-accent data-[highlighted]:bg-surface-muted",
                )}
                onClick={openAdd}
              >
                <IconPlus size={12} className="shrink-0" />
                {t("ide.term.addCommand")}
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>

      {/* Quick-add dialog (controlled). Edit/delete existing commands is in
          Settings -> 终端. */}
      <Dialog.Root open={adding !== null} onOpenChange={(open) => !open && setAdding(null)}>
        <Dialog.Portal>
          <Dialog.Backdrop />
          <Dialog.Popup className="w-[420px] max-w-[90vw] p-4">
            <Dialog.Title>{t("ide.term.addCommand")}</Dialog.Title>
            <Dialog.Description className="mt-1">
              {t("ide.term.addCommandDesc")}
            </Dialog.Description>

            <div className="mt-4 flex flex-col gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-medium text-content-muted">{t("ide.term.nameLabel")}</span>
                <Input
                  value={adding?.name ?? ""}
                  placeholder={t("ide.term.namePlaceholder")}
                  onChange={(e) =>
                    adding && setAdding({ ...adding, name: (e.target as HTMLInputElement).value })
                  }
                  autoFocus
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-medium text-content-muted">{t("ide.term.commandLabel")}</span>
                <textarea
                  value={adding?.command ?? ""}
                  placeholder={t("ide.term.commandPlaceholder")}
                  rows={3}
                  onChange={(e) => adding && setAdding({ ...adding, command: e.target.value })}
                  className={cn(
                    "w-full resize-y rounded border border-edge bg-surface px-2.5 py-1.5 font-mono text-xs leading-relaxed text-content placeholder:text-content-subtle outline-none transition-colors",
                    "focus:border-accent",
                  )}
                />
              </label>
            </div>

            <div className="mt-4 flex items-center justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setAdding(null)}>
                {t("common.cancel")}
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={save}
                disabled={!adding?.name.trim() || !adding?.command.trim()}
              >
                {t("common.save")}
              </Button>
            </div>
            <Dialog.Close />
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
