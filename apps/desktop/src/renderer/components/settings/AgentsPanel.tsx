/**
 * Agent 角色管理面板(设置 → AI 能力 → Agent 角色)。
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
import type { AgentProfile, AgentProfileTag, OrchestrationTemplate } from "@contracts/orchestration";
import { PanelHeader } from "./PanelHeader.js";
import { SettingsSection } from "./SettingsSection.js";
import { SettingRow } from "./SettingRow.js";
import { Button, ConfirmDialog, Input } from "@renderer/components/ui/index.js";

const TAGS: AgentProfileTag[] = ["planning", "coding", "writing", "image", "review", "testing", "generic"];
const COLORS = ["sky", "violet", "emerald", "amber", "pink", "rose", "cyan", "lime"] as const;

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

type Draft = AgentProfile;

export function AgentsPanel() {
  const { t } = useI18n();
  const agents = useSessionStore((s) => s.orchAgents);
  const providers = useSessionStore((s) => s.providers);
  const templates = useSessionStore((s) => s.orchTemplates);
  const orchSettings = useSessionStore((s) => s.orchSettings);
  const reloadOrchAgents = useSessionStore((s) => s.reloadOrchAgents);
  const saveOrchAgent = useSessionStore((s) => s.saveOrchAgent);
  const deleteOrchAgent = useSessionStore((s) => s.deleteOrchAgent);
  const reloadOrchTemplates = useSessionStore((s) => s.reloadOrchTemplates);
  const saveOrchTemplate = useSessionStore((s) => s.saveOrchTemplate);
  const deleteOrchTemplate = useSessionStore((s) => s.deleteOrchTemplate);
  const saveOrchSettings = useSessionStore((s) => s.saveOrchSettings);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [pendingDelete, setPendingDelete] = useState<AgentProfile | null>(null);

  useEffect(() => {
    void reloadOrchAgents();
    void reloadOrchTemplates();
  }, [reloadOrchAgents, reloadOrchTemplates]);

  const provider = providers.find((p) => p.id === draft?.providerId);
  const modelOptions = useMemo(() => {
    const builtins = provider?.capabilities.builtinModels ?? [];
    return [
      { value: "default", label: t("orch.agents.model") + " · auto" },
      ...builtins.map((m) => ({ value: m.id, label: m.label ?? m.id })),
    ];
  }, [provider, t]);
  const effortOptions = useMemo(() => {
    const levels = provider?.capabilities.thinkingLevels ?? [];
    return levels.length > 0
      ? levels.map((l) => ({ value: l.value, label: l.label ?? l.value }))
      : [{ value: "default", label: "default" }];
  }, [provider]);
  const permOptions = useMemo(() => {
    const modes = provider?.capabilities.permissionModes ?? [];
    return modes.length > 0
      ? modes.map((m) => ({ value: m.value, label: m.label ?? m.value }))
      : [{ value: "default", label: "default" }];
  }, [provider]);

  const update = <K extends keyof Draft>(key: K, v: Draft[K]) => {
    setDraft((d) => (d ? { ...d, [key]: v } : d));
    setError("");
  };

  const startNew = () => {
    setDraft({
      id: `agent_${Date.now().toString(36)}`,
      name: "",
      icon: "🤖",
      color: "sky",
      providerId: providers[0]?.id ?? "claude-sdk",
      model: "default",
      effort: "default",
      systemPrompt: "",
      allowedTools: [],
      permissionMode: "default",
      defaultWorktree: "none",
      tags: ["generic"],
      costPerMtok: 0,
      builtin: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    setError("");
  };

  const save = async () => {
    if (!draft) return;
    if (!draft.name.trim()) {
      setError(t("orch.agents.errName"));
      return;
    }
    setSaving(true);
    try {
      await saveOrchAgent(draft);
      setDraft(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

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
      <PanelHeader className="mb-3" title={t("orch.agents.title")} />
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto pb-8">
        {/* ── 角色列表 ── */}
        <SettingsSection title={t("orch.agents.title")} desc={t("orch.agents.desc")}>
          <div className="space-y-1 px-4 py-3">
            {agents.length === 0 && (
              <div className="py-2 text-xs text-content-subtle">{t("orch.agents.emptyList")}</div>
            )}
            {agents.map((a) => (
              <div
                key={a.id}
                className={cn(
                  "group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-surface-hover",
                  draft?.id === a.id && "bg-surface-hover",
                )}
              >
                <span className="text-base leading-none">{a.icon || "🤖"}</span>
                <span className="min-w-0 flex-1 truncate text-xs font-medium">{a.name}</span>
                {a.builtin && (
                  <span className="rounded bg-surface-muted px-1.5 py-0.5 text-[0.686em] text-content-subtle">
                    {t("orch.agents.builtin")}
                  </span>
                )}
                <span className="text-[0.686em] text-content-subtle">
                  {a.providerId}/{a.model} · {a.tags.join("/")}
                </span>
                <Button variant="ghost" size="sm" onClick={() => setDraft({ ...a })}>
                  {t("orch.agents.edit")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-danger"
                  onClick={() => setPendingDelete(a)}
                >
                  {t("orch.agents.delete")}
                </Button>
              </div>
            ))}
            <Button variant="outline" size="sm" className="mt-2" onClick={startNew}>
              + {t("orch.agents.new")}
            </Button>
          </div>

          {/* ── 编辑表单 ── */}
          {draft && (
            <div className="space-y-3 border-t border-edge px-4 py-4">
              <SettingRow title={t("orch.agents.name")}>
                <Input
                  value={draft.name}
                  placeholder={t("orch.agents.namePh")}
                  onChange={(e) => update("name", e.target.value)}
                />
              </SettingRow>
              <SettingRow title={t("orch.agents.icon")}>
                <Input value={draft.icon} onChange={(e) => update("icon", e.target.value)} />
              </SettingRow>
              <SettingRow title={t("orch.agents.color")} layout="vertical">
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {COLORS.map((c) => (
                    <button
                      key={c}
                      onClick={() => update("color", c)}
                      className={cn(
                        "h-5 w-5 rounded-full border-2",
                        `bg-${c}-500/70`,
                        draft.color === c ? "border-content" : "border-transparent",
                      )}
                      aria-label={c}
                    />
                  ))}
                </div>
              </SettingRow>
              <SettingRow title={t("orch.agents.provider")}>
                <FieldSelect
                  value={draft.providerId}
                  onChange={(v) =>
                    setDraft((d) =>
                      d
                        ? {
                            ...d,
                            providerId: v,
                            model: "default",
                            effort: "default",
                            permissionMode: "default",
                          }
                        : d,
                    )
                  }
                  options={providers.map((p) => ({ value: p.id, label: p.displayName }))}
                />
              </SettingRow>
              <SettingRow title={t("orch.agents.model")}>
                <FieldSelect value={draft.model} onChange={(v) => update("model", v)} options={modelOptions} />
              </SettingRow>
              <SettingRow title={t("orch.agents.effort")}>
                <FieldSelect value={draft.effort} onChange={(v) => update("effort", v)} options={effortOptions} />
              </SettingRow>
              <SettingRow title={t("orch.agents.permission")}>
                <FieldSelect
                  value={draft.permissionMode}
                  onChange={(v) => update("permissionMode", v)}
                  options={permOptions}
                />
              </SettingRow>
              <SettingRow title={t("orch.agents.worktree")}>
                <FieldSelect
                  value={draft.defaultWorktree}
                  onChange={(v) => update("defaultWorktree", v as AgentProfile["defaultWorktree"])}
                  options={[
                    { value: "none", label: t("orch.agents.worktree.none") },
                    { value: "active", label: t("orch.agents.worktree.active") },
                    { value: "new", label: t("orch.agents.worktree.new") },
                  ]}
                />
              </SettingRow>
              <SettingRow title={t("orch.agents.cost")}>
                <Input
                  type="number"
                  min={0}
                  step="0.5"
                  value={draft.costPerMtok}
                  onChange={(e) => update("costPerMtok", Number(e.target.value) || 0)}
                />
              </SettingRow>
              <SettingRow title={t("orch.agents.tags")} layout="vertical">
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {TAGS.map((tag) => {
                    const on = draft.tags.includes(tag);
                    return (
                      <button
                        key={tag}
                        onClick={() =>
                          update("tags", on ? draft.tags.filter((x) => x !== tag) : [...draft.tags, tag])
                        }
                        className={cn(
                          "rounded-full border px-2 py-0.5 text-[0.686em]",
                          on
                            ? "border-accent bg-accent/15 text-accent"
                            : "border-edge text-content-subtle hover:text-content",
                        )}
                      >
                        {tag}
                      </button>
                    );
                  })}
                </div>
              </SettingRow>
              <SettingRow title={t("orch.agents.prompt")} layout="vertical">
                <textarea
                  className="min-h-[72px] w-full rounded-md border border-edge bg-surface px-2 py-1.5 text-xs outline-none focus:border-accent"
                  value={draft.systemPrompt}
                  placeholder={t("orch.agents.promptPh")}
                  onChange={(e) => update("systemPrompt", e.target.value)}
                />
              </SettingRow>
              {error && <div className="px-4 text-xs text-danger">{error}</div>}
              <div className="flex justify-end gap-2 px-4">
                <Button variant="ghost" size="sm" onClick={() => setDraft(null)}>
                  {t("orch.wizard.cancel")}
                </Button>
                <Button size="sm" disabled={saving} onClick={() => void save()}>
                  {t("orch.agents.save")}
                </Button>
              </div>
            </div>
          )}
        </SettingsSection>

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
        <SettingsSection title={t("orch.composer.orchestrate")}>
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

      <ConfirmDialog
        open={!!pendingDelete}
        title={t("orch.agents.delete")}
        description={t("orch.agents.deleteConfirm")}
        confirmText={t("orch.agents.delete")}
        cancelText={t("orch.wizard.cancel")}
        danger
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        onConfirm={() => {
          if (pendingDelete) void deleteOrchAgent(pendingDelete.id);
          setPendingDelete(null);
        }}
      />
    </div>
  );
}
