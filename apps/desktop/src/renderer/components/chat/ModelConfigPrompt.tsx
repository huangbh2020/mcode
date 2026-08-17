/**
 * ModelConfigPrompt — send-time guard dialog for providers with no model.
 *
 * Opened by sessionStore.sendPrompt / editAndResendMessage when the active
 * provider has nothing configured to send with (model is "default"/auto and
 * no model exists for it — e.g. pi-sdk with an empty models list, or
 * claude-sdk with no custom endpoint). [去配置] jumps straight to the unified
 * model-config settings page ("custom-models" hosts both claude endpoints and
 * pi providers).
 */
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { ConfirmDialog } from "@renderer/components/ui/index.js";

export function ModelConfigPrompt() {
  const { t } = useI18n();
  const open = useSessionStore((s) => s.modelConfigPromptOpen);
  const setOpen = useSessionStore((s) => s.setModelConfigPromptOpen);
  const setSettingsOpen = useSessionStore((s) => s.setSettingsOpen);

  return (
    <ConfirmDialog
      open={open}
      title={t("chat.modelConfig.title")}
      description={t("chat.modelConfig.desc")}
      confirmText={t("chat.modelConfig.configure")}
      cancelText={t("common.cancel")}
      onOpenChange={(o) => setOpen(o)}
      onConfirm={() => setSettingsOpen(true, "custom-models")}
    />
  );
}
