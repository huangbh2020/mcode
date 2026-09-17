/**
 * 编排设置面板(设置 → AI 能力 → 编排)。原 Agent 角色与编排模板模块已随
 * 会话内拆解重构移除 —— 拆解由模型在会话内经 orch_submit_plan 工具完成,
 * 节点配置直接写 厂商/模型/权限/思考级别,不再需要角色预设与模板骨架。
 *
 * 剩余:编排设置(自动触发档位)。
 */
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { PanelHeader } from "./PanelHeader.js";
import { SettingsSection } from "./SettingsSection.js";
import { SettingRow } from "./SettingRow.js";

const selectClass =
  "h-8 w-full rounded-md border border-edge bg-surface px-2 text-xs text-content outline-none focus:border-accent";

function FieldSelect({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <select className={selectClass} value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function AgentsPanel() {
  const { t } = useI18n();
  const orchSettings = useSessionStore((s) => s.orchSettings);
  const saveOrchSettings = useSessionStore((s) => s.saveOrchSettings);

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl min-h-0 flex-col">
      <PanelHeader className="mb-3" title={t("orch.settings.panelTitle")} />
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto pb-8">
        {/* ── 编排设置 ── */}
        <SettingsSection title={t("orch.settings.title")}>
          <SettingRow title={t("orch.settings.triggerMode")} desc={t("orch.settings.triggerHint")}>
            <FieldSelect
              value={orchSettings?.triggerMode ?? "ask"}
              onChange={(v) =>
                void saveOrchSettings({
                  triggerMode: v as "off" | "ask" | "auto",
                  concurrency: orchSettings?.concurrency ?? 4,
                  budgetUsd: orchSettings?.budgetUsd ?? 0,
                })
              }
              options={[
                { value: "off", label: t("orch.settings.trigger.off") },
                { value: "ask", label: t("orch.settings.trigger.ask") },
                { value: "auto", label: t("orch.settings.trigger.auto") },
              ]}
            />
          </SettingRow>
        </SettingsSection>
      </div>

    </div>
  );
}
