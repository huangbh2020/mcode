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
import { ConfirmDialog } from "@renderer/components/ui/index.js";

export function ModelConfigPrompt() {
  const open = useSessionStore((s) => s.modelConfigPromptOpen);
  const setOpen = useSessionStore((s) => s.setModelConfigPromptOpen);
  const setSettingsOpen = useSessionStore((s) => s.setSettingsOpen);

  return (
    <ConfirmDialog
      open={open}
      title="尚未配置模型"
      description="当前 SDK 没有可用的模型,请先配置模型后再发送。"
      confirmText="去配置"
      cancelText="取消"
      onOpenChange={(o) => setOpen(o)}
      onConfirm={() => setSettingsOpen(true, "custom-models")}
    />
  );
}
