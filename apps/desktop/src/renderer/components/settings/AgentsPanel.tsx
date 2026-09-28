/**
 * 编排设置面板(设置 → AI 能力 → 编排)。原 Agent 角色与编排模板模块已随
 * 会话内拆解重构移除 —— 拆解由模型在会话内经 orch_submit_plan 工具完成,
 * 节点配置直接写 厂商/模型/权限/思考级别,不再需要角色预设与模板骨架。
 *
 * 剩余:编排设置(自动触发档位)。
 */
import { useEffect, useState } from "react";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { AGENT_CUSTOM_PROMPT_SETTING_KEY } from "@contracts/ipc";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { Button } from "@renderer/components/ui/index.js";
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

        {/* ── 自定义提示词 ── */}
        <CustomPromptSection />
      </div>

    </div>
  );
}

/** Custom agent prompt: a free-form textarea appended after every built-in
 *  system-prompt section in all three providers (Claude/Pi/Codex). Persisted
 *  under AGENT_CUSTOM_PROMPT_SETTING_KEY via the generic setting IPC; the main
 *  side reads it per-turn (providers), so it applies from the NEXT turn. This
 *  is the supported way to add standing instructions — hand-editing Codex's
 *  AGENTS.md is clobbered by the provider's per-turn rewrite. */
function CustomPromptSection() {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<"saved" | "error" | null>(null);

  // Panel is freshly mounted per nav switch — reload the stored value each
  // time it's shown (same pattern as TerminalPanel's ShellSection).
  useEffect(() => {
    setFeedback(null);
    void (async () => {
      const { value } = await api.setting.get({ key: AGENT_CUSTOM_PROMPT_SETTING_KEY });
      setText(value ?? "");
      setLoaded(true);
    })();
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      await api.setting.set({ key: AGENT_CUSTOM_PROMPT_SETTING_KEY, value: text });
      setFeedback("saved");
    } catch {
      setFeedback("error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection
      title={t("settings.agents.customPromptSection")}
      desc={t("settings.agents.customPromptDesc")}
    >
      <SettingRow
        layout="vertical"
        title={t("settings.agents.customPromptLabel")}
        desc={t("settings.agents.customPromptHint")}
        htmlFor="setting-agent-custom-prompt"
      >
        <textarea
          id="setting-agent-custom-prompt"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setFeedback(null);
          }}
          placeholder={t("settings.agents.customPromptPlaceholder")}
          spellCheck={false}
          disabled={!loaded}
          maxLength={100_000}
          rows={8}
          className="w-full resize-y rounded-md border border-edge bg-surface px-3 py-2 font-mono text-xs leading-relaxed text-content outline-none focus:border-accent disabled:opacity-50"
        />
        <div className="mt-2 flex items-center gap-3">
          <Button variant="primary" size="sm" onClick={() => void save()} disabled={saving || !loaded}>
            {saving ? t("settings.saving") : t("common.save")}
          </Button>
          {feedback && (
            <p
              className={cn(
                "text-[0.7857em]",
                feedback === "saved" ? "text-accent" : "text-danger",
              )}
            >
              {feedback === "saved"
                ? t("settings.agents.customPromptSaved")
                : t("settings.agents.customPromptSaveFailed")}
            </p>
          )}
        </div>
      </SettingRow>
    </SettingsSection>
  );
}
