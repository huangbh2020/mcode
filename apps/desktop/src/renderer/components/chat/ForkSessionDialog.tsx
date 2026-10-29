/**
 * ForkSessionDialog — modal to branch off an independent exploratory session
 * with cloned model context and optional Git Worktree isolation.
 */
import { useState, useEffect } from "react";
import { Dialog } from "@renderer/components/ui/dialog.js";
import { Button } from "@renderer/components/ui/button.js";
import { IconGitFork, IconLoader2 } from "@renderer/lib/icons.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useToastStore } from "@renderer/stores/toastStore.js";

export interface ForkSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  messageId?: string;
  initialTitle?: string;
}

export function ForkSessionDialog({
  open,
  onOpenChange,
  sessionId,
  messageId,
  initialTitle,
}: ForkSessionDialogProps) {
  const { t } = useI18n();
  const [title, setTitle] = useState("");
  const [useWorktree, setUseWorktree] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open) {
      setTitle(initialTitle ? `${initialTitle} (分叉)` : "");
      setUseWorktree(false);
      setLoading(false);
    }
  }, [open, initialTitle]);

  const handleConfirm = async () => {
    if (loading) return;
    setLoading(true);
    try {
      await useSessionStore.getState().forkSession({
        sessionId,
        messageId,
        title: title.trim() || undefined,
        useWorktree,
      });
      useToastStore.getState().push({
        kind: "info",
        title: t("chatStream.fork.successToast"),
      });
      onOpenChange(false);
    } catch (err) {
      useToastStore.getState().push({
        kind: "error",
        title: t("chatStream.fork.failed"),
        body: (err as Error).message,
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Popup className="w-full max-w-md p-5">
          <div className="flex items-center gap-2 mb-3 text-content">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent">
              <IconGitFork size={18} />
            </div>
            <div>
              <Dialog.Title className="text-sm font-semibold">
                {t("chatStream.fork.dialogTitle")}
              </Dialog.Title>
              <Dialog.Description className="text-xs text-content-subtle mt-0.5">
                {t("chatStream.fork.dialogDesc")}
              </Dialog.Description>
            </div>
          </div>

          <div className="space-y-4 my-4">
            <div>
              <label className="block text-xs font-medium text-content mb-1.5">
                {t("chatStream.fork.titleLabel")}
              </label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t("chatStream.fork.titlePlaceholder")}
                className="w-full rounded-md border border-edge bg-surface-muted/50 px-3 py-1.5 text-xs text-content placeholder:text-content-subtle focus:border-accent focus:outline-none"
              />
            </div>

            <label className="flex items-start gap-2.5 cursor-pointer rounded-lg border border-edge/60 bg-surface-muted/30 p-2.5 transition-colors hover:bg-surface-hover/50">
              <input
                type="checkbox"
                checked={useWorktree}
                onChange={(e) => setUseWorktree(e.target.checked)}
                className="mt-0.5 rounded border-edge text-accent focus:ring-accent"
              />
              <div className="flex-1 text-xs">
                <div className="font-medium text-content">
                  {t("chatStream.fork.useWorktreeLabel")}
                </div>
                <div className="text-[11px] text-content-subtle mt-0.5">
                  {t("chatStream.fork.useWorktreeHint")}
                </div>
              </div>
            </label>
          </div>

          <div className="flex items-center justify-end gap-2 pt-2 border-t border-edge/60">
            <Button
              variant="ghost"
              size="sm"
              disabled={loading}
              onClick={() => onOpenChange(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={loading}
              onClick={handleConfirm}
              className="gap-1.5"
            >
              {loading ? (
                <IconLoader2 size={14} className="animate-spin" />
              ) : (
                <IconGitFork size={14} />
              )}
              {t("chatStream.fork.confirm")}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
