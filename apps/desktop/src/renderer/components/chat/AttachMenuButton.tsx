import { useState } from "react";
import { Menu } from "@base-ui/react/menu";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { IconCommand, IconFileText, IconPhoto, IconPlus } from "@renderer/lib/icons.js";
import { useSuppressBrowserView } from "@renderer/hooks/useSuppressBrowserView.js";

/**
 * Single "+" entry for composer attachments and quick triggers.
 *
 * Replaces the two dedicated icon buttons (paperclip + image) that used to sit
 * side by side at the left of the composer's action row — one button instead of
 * two keeps the row calm. The menu carries:
 *   - attach context files (project file picker)
 *   - add images (OS picker)
 *   - slash commands: inserts a `/` at the caret, which the composer's
 *     trigger-detection (recomputePicker) turns into the inline command picker
 *     — the exact same flow as typing `/` by hand (see ChatPane's
 *     openSlashCommand).
 *
 * Direct drag-drop / paste onto the composer keeps working independently of
 * this menu, so the extra click only affects the button-initiated path.
 *
 * Built on @base-ui/react Menu like the other composer dropdowns; the popup is
 * portaled to document.body so it isn't clipped by the composer card.
 */
export function AttachMenuButton({
  disabled,
  onPickFiles,
  onPickImages,
  onSlashCommand,
}: {
  disabled: boolean;
  /** Open the project-file attach picker (same action as the old paperclip). */
  onPickFiles: () => void;
  /** Open the OS image picker (same action as the old photo button). */
  onPickImages: () => void;
  /** Insert a `/` trigger into the editor, opening the command picker. */
  onSlashCommand: () => void;
}) {
  const { t } = useI18n();
  // While the menu is open the embedded browser view is suppressed so the
  // portaled popup stays visible/clickable over the browser's rect.
  const [open, setOpen] = useState(false);
  useSuppressBrowserView(open);

  return (
    <Menu.Root open={open} onOpenChange={setOpen}>
      <Menu.Trigger
        disabled={disabled}
        className={cn(
          "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-content-muted transition-all duration-150 ease-out",
          "hover:scale-110 hover:bg-accent/10 hover:text-accent active:scale-95",
          "disabled:scale-100 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-content-muted disabled:hover:scale-100",
        )}
        title={t("chat.attachMenu")}
        aria-label={t("chat.attachMenu")}
      >
        <IconPlus size={18} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="top" align="start">
          <Menu.Popup
            className={cn(
              "z-50 min-w-[200px] origin-bottom-left rounded-lg border border-edge bg-surface py-1.5 shadow-2xl",
              "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
              "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
              "transition-[transform,opacity] duration-100",
            )}
          >
            <Menu.Item
              onClick={onPickFiles}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] outline-none select-none",
                "text-content-muted data-[highlighted]:bg-surface-muted data-[highlighted]:text-content",
              )}
            >
              <IconFileText size={14} className="shrink-0 opacity-80" />
              <span className="font-medium">{t("chat.attachFiles")}</span>
            </Menu.Item>
            <Menu.Item
              onClick={onPickImages}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] outline-none select-none",
                "text-content-muted data-[highlighted]:bg-surface-muted data-[highlighted]:text-content",
              )}
            >
              <IconPhoto size={14} className="shrink-0 opacity-80" />
              <span className="font-medium">{t("chat.addImage")}</span>
            </Menu.Item>
            <div className="my-1 border-t border-edge" />
            <Menu.Item
              onClick={onSlashCommand}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] outline-none select-none",
                "text-content-muted data-[highlighted]:bg-surface-muted data-[highlighted]:text-content",
              )}
            >
              <IconCommand size={14} className="shrink-0 opacity-80" />
              <span className="font-medium">{t("chat.slashMenu")}</span>
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
