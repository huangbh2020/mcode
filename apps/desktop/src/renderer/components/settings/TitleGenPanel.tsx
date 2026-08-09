import { useMemo } from "react";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { cn } from "@renderer/lib/cn.js";
import { Select, Switch } from "@renderer/components/ui/index.js";
import { SettingRow } from "./SettingRow.js";
import { SettingsSection } from "./SettingsSection.js";
import { CUSTOM_MODEL_ROLES, CUSTOM_MODEL_ROLE_LABELS } from "@contracts/customModel";

/** Sentinel for the "内置模型" (no selection) option — base-ui Select
 *  rejects empty-string item values, so the empty state maps to this and
 *  the store setter translates it back to null. */
const MODEL_NONE = "__none__";

/**
 * Thread-title generation settings.
 *
 * Two controls:
 *  - **Auto generate** (toggle): when on, the main process fires a one-shot
 *    LLM call on a session's first user message to produce a short Chinese
 *    title, overwriting the default placeholder. When off, the placeholder
 *    (first 40 chars of the prompt) is kept.
 *  - **Generation model**: pick a SPECIFIC model (supplier + role binding).
 *    Only custom-model configs with at least one bound role are listed; the
 *    user must have configured models first. Unset = built-in Claude model.
 *
 * The model value is stored as `"configId:roleKey"` in the settings table,
 * same shape as the commit-gen / conflict-resolve model selectors.
 *
 * Renders as its own SettingsSection (card) so it slots into GeneralPanel as
 * a sibling section.
 */
export function TitleGenPanel() {
  const titleGenEnabled = useSessionStore((s) => s.titleGenEnabled);
  const titleGenModel = useSessionStore((s) => s.titleGenModel);
  const setTitleGenEnabled = useSessionStore((s) => s.setTitleGenEnabled);
  const setTitleGenModel = useSessionStore((s) => s.setTitleGenModel);
  const customModels = useSessionStore((s) => s.customModels);

  // Build a flat list of selectable models: one entry per (config, bound role).
  // Each entry's value is `"configId:roleKey"`, label is `"供应商名 -> 角色名"`.
  const modelOptions = useMemo(() => {
    const opts: { value: string; label: string }[] = [];
    for (const cfg of customModels) {
      for (const role of CUSTOM_MODEL_ROLES) {
        const binding = cfg.roles[role];
        if (binding?.requestModel?.trim()) {
          const roleLabel = binding.displayName || CUSTOM_MODEL_ROLE_LABELS[role];
          opts.push({
            value: `${cfg.id}:${role}`,
            label: `${cfg.name} -> ${roleLabel}`,
          });
        }
      }
    }
    return opts;
  }, [customModels]);

  return (
    <SettingsSection
      title="线程名称生成"
      desc="开启后,在用户发送第一条消息时后台自动调用模型生成简短标题,并覆盖默认标题。生成失败时保留默认占位标题。"
    >
      {/* Auto-generate toggle */}
      <SettingRow
        title="自动生成"
        desc="开启后,新会话的首条消息会触发后台标题生成。关闭则沿用首条消息前 40 字符作为标题。"
        htmlFor="setting-titlegen-enabled"
      >
        <Switch
          id="setting-titlegen-enabled"
          checked={titleGenEnabled}
          onCheckedChange={setTitleGenEnabled}
          label={titleGenEnabled ? "已开启" : "已关闭"}
        />
      </SettingRow>

      {/* Model selector - specific supplier + role binding */}
      <SettingRow
        title="生成模型"
        desc="选择用于生成标题的具体模型。需要先在「模型配置」中添加并绑定角色。未选择则使用内置 Claude 模型。"
      >
        {modelOptions.length > 0 ? (
          <Select.Root
            value={titleGenModel ?? MODEL_NONE}
            onValueChange={(v) => setTitleGenModel(v === MODEL_NONE ? null : (v as string))}
          >
            <Select.Trigger
              disabled={!titleGenEnabled}
              className={cn("min-w-[220px]", !titleGenEnabled && "cursor-not-allowed opacity-50")}
            >
              <Select.Value>
                {(val: string) =>
                  val === MODEL_NONE
                    ? "内置模型"
                    : (modelOptions.find((o) => o.value === val)?.label ?? val)
                }
              </Select.Value>
            </Select.Trigger>
            <Select.Portal>
              <Select.Positioner>
                <Select.Popup>
                  <Select.List>
                    <Select.Item value={MODEL_NONE}>
                      <Select.ItemText>内置模型</Select.ItemText>
                    </Select.Item>
                    {modelOptions.map((opt) => (
                      <Select.Item key={opt.value} value={opt.value}>
                        <Select.ItemText>{opt.label}</Select.ItemText>
                      </Select.Item>
                    ))}
                  </Select.List>
                </Select.Popup>
              </Select.Positioner>
            </Select.Portal>
          </Select.Root>
        ) : (
          <p className={cn("text-[0.7857em] text-content-subtle", !titleGenEnabled && "opacity-50")}>
            暂无可用模型,请先在「模型配置」中添加。未选择则使用内置 Claude 模型。
          </p>
        )}
      </SettingRow>
    </SettingsSection>
  );
}
