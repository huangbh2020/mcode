/**
 * 编排模板与设置面板(设置 → AI 能力 → 编排)。原 Agent 角色模块已随
 * 画布化重构移除 —— 节点配置改为直接选 厂商/模型/权限/思考级别。
 *
 * 三段结构:
 *  ① 角色列表 + 编辑表单(仿 CustomModelsPanel 的 list|form 布局,但用
 *     SettingsSection/SettingRow 脚手架):provider/model/effort/permission
 *     选项跟随所选 provider 的 capabilities 声明。
 *  ② 编排模板(内置流水线/竞争/fan-out + 用户模板,JSON 导入导出 =
 *     「模板市场」的本地形态)。
 *  ③ 编排设置(自动触发档位 / 默认并发 / 默认预算)。
 */
import { useEffect, useMemo, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import type { OrchestrationTemplate } from "@contracts/orchestration";
import { PanelHeader } from "./PanelHeader.js";
import { SettingsSection } from "./SettingsSection.js";
import { SettingRow } from "./SettingRow.js";
import { Button, Input } from "@renderer/components/ui/index.js";

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
  const templates = useSessionStore((s) => s.orchTemplates);
  const orchSettings = useSessionStore((s) => s.orchSettings);
  // Model surface: builtin (provider capabilities) ∪ user-defined custom models
  // (claude-sdk only — Pi/Codex models are loaded into pi/codexAvailableModels
  // and counted as builtins for their providers). New templates / pasted
  // profiles whose model id isn't on this list are dropped on save.
  const reloadOrchTemplates = useSessionStore((s) => s.reloadOrchTemplates);
  const saveOrchTemplate = useSessionStore((s) => s.saveOrchTemplate);
  const deleteOrchTemplate = useSessionStore((s) => s.deleteOrchTemplate);
  const saveOrchSettings = useSessionStore((s) => s.saveOrchSettings);

  useEffect(() => {
    void reloadOrchTemplates();
  }, [reloadOrchTemplates]);

  const importTemplate = async () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text()) as OrchestrationTemplate | OrchestrationTemplate[];
        const list = Array.isArray(parsed) ? parsed : [parsed];
        for (const tpl of list) {
          await saveOrchTemplate({
            ...tpl,
            id: tpl.id || `tpl_${Date.now().toString(36)}`,
            builtin: false,
          });
        }
      } catch {
        window.alert(t("orch.agents.tplImportFailed"));
      }
    };
    input.click();
  };

  const exportTemplate = (tpl: OrchestrationTemplate) => {
    const blob = new Blob([JSON.stringify(tpl, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${tpl.name.replace(/[\\/:*?"<>|]/g, "_")}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl min-h-0 flex-col">
      <PanelHeader className="mb-3" title={t("orch.agents.panelTitle")} />
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto pb-8">
        {/* ── 模板 ── */}
        <SettingsSection title={t("orch.agents.templates")} desc={t("orch.agents.templatesDesc")}>
          <div className="space-y-1 px-4 py-3">
            {templates.map((tpl) => (
              <div key={tpl.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-surface-hover">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium">{tpl.name}</span>
                  <span className="block truncate text-[0.686em] text-content-subtle">{tpl.description}</span>
                </span>
                <span className="text-[0.686em] text-content-subtle">{tpl.tasks.length} tasks</span>
                <Button variant="ghost" size="sm" onClick={() => exportTemplate(tpl)}>
                  {t("orch.agents.tplExport")}
                </Button>
                {!tpl.builtin && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-danger"
                    onClick={() => void deleteOrchTemplate(tpl.id)}
                  >
                    {t("orch.agents.tplDelete")}
                  </Button>
                )}
              </div>
            ))}
            <Button variant="outline" size="sm" className="mt-2" onClick={() => void importTemplate()}>
              {t("orch.agents.tplImport")}
            </Button>
          </div>
        </SettingsSection>

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
          <SettingRow title={t("orch.settings.concurrency")}>
            <Input
              type="number"
              min={1}
              max={16}
              value={orchSettings?.concurrency ?? 4}
              onChange={(e) =>
                void saveOrchSettings({
                  triggerMode: orchSettings?.triggerMode ?? "ask",
                  concurrency: Math.max(1, Number(e.target.value) || 1),
                  budgetUsd: orchSettings?.budgetUsd ?? 0,
                })
              }
            />
          </SettingRow>
          <SettingRow title={t("orch.settings.budget")}>
            <Input
              type="number"
              min={0}
              step="1"
              value={orchSettings?.budgetUsd ?? 0}
              onChange={(e) =>
                void saveOrchSettings({
                  triggerMode: orchSettings?.triggerMode ?? "ask",
                  concurrency: orchSettings?.concurrency ?? 4,
                  budgetUsd: Math.max(0, Number(e.target.value) || 0),
                })
              }
            />
          </SettingRow>
        </SettingsSection>
      </div>

    </div>
  );
}
