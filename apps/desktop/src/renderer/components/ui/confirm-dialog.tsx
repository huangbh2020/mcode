/**
 * ConfirmDialog - reusable confirmation modal built on the Dialog primitive.
 *
 * Replaces native `confirm()` calls with an in-app dialog. The dialog is
 * controlled (`open` + `onOpenChange`) so callers manage the pending state.
 * Use `danger` to render the confirm button with the destructive variant.
 *
 * @example
 *   <ConfirmDialog
 *     open={pending != null}
 *     title="删除项目"
 *     description="此操作不可恢复。"
 *     confirmText="删除"
 *     danger
 *     onOpenChange={(open) => { if (!open) setPending(null); }}
 *     onConfirm={() => { void remove(); }}
 *   />
 */
import { IconAlertTriangle } from "@renderer/lib/icons.js";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { Button } from "./button.js";
import { Dialog } from "./dialog.js";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  /** Render the confirm button with the destructive (danger) variant. */
  danger?: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmText,
  cancelText,
  danger = false,
  onOpenChange,
  onConfirm,
}: ConfirmDialogProps) {
  // Button labels default to the shared dictionary (callers may override with
  // a context-specific verb, e.g. 删除/恢复). Resolved here rather than via
  // parameter defaults so the labels follow the live locale.
  const { t } = useI18n();
  const confirmLabel = confirmText ?? t("common.confirm");
  const cancelLabel = cancelText ?? t("common.cancel");
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Popup className="w-[360px] max-w-[90vw] p-4">
          <div className="flex items-start gap-3">
            <span
              className={cn(
                "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
                danger ? "bg-danger/10 text-danger" : "bg-accent/10 text-accent",
              )}
            >
              <IconAlertTriangle size={16} />
            </span>
            <div className="min-w-0 flex-1">
              <Dialog.Title>{title}</Dialog.Title>
              <Dialog.Description className="mt-1">{description}</Dialog.Description>
            </div>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              {cancelLabel}
            </Button>
            <Button
              variant={danger ? "danger" : "primary"}
              size="sm"
              onClick={() => {
                onConfirm();
                onOpenChange(false);
              }}
            >
              {confirmLabel}
            </Button>
          </div>
          <Dialog.Close />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
