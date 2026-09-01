import { useMemo } from "react";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { cn } from "@renderer/lib/cn.js";
import { Select } from "@renderer/components/ui/index.js";
import { IconCode, IconSquare, IconCircleOff, IconRobot } from "@renderer/lib/icons.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import { PanelHeader } from "./PanelHeader.js";
import { SettingsSection } from "./SettingsSection.js";
import { SettingRow } from "./SettingRow.js";
import { WorktreeRootSetting } from "./WorktreeRootSetting.js";
import type { GitDiffOpenMode } from "@contracts/ipc";
import type { ReactNode } from "react";

const GIT_DIFF_OPEN_MODE_OPTIONS: { value: GitDiffOpenMode; labelKey: MessageId; icon: ReactNode }[] = [
  { value: "center", labelKey: "settings.git.openCenter", icon: <IconCode size={14} className="text-content-muted" /> },
  { value: "dialog", labelKey: "settings.git.openDialog", icon: <IconSquare size={14} className="text-content-muted" /> },
];

/** Sentinel value for the "no model selected" option in the model selects —
 *  base-ui Select rejects empty-string item values, so the empty state maps
 *  to this and the store setters translate it back to null. */
const MODEL_NONE = "__none__";

/**
 * Git settings — commit-message generation configuration.
 *
 * Two controls:
 *  - **Model**: pick a SPECIFIC model (supplier + model id, e.g.
 *    "DeepSeek 中转 → deepseek-v4-pro"). Only custom-model configs with at
 *    least one model are listed; the user must have configured models first.
 *  - **Format preference**: a textarea steering only the language / wording /
 *    convention of the generated message (e.g. Conventional Commits, en/zh,
 *    emoji style). The core behavior — emit a clean, diff-derived commit
 *    message with no preamble — is fixed in the backend and cannot be
 *    overridden here. Empty = built-in default preference.
 *
 * The model value is stored as `"configId:modelId"` (e.g.
 * `"cfg_abc:deepseek-v4-pro"`) in the settings table; at commit-generation
 * time it's split back into `customModelId` + `customModelRole` for the IPC
 * call.
 *
 * Also hosts the isolated-session worktree root directory setting (where
 * managed worktrees are materialized) — it's a git-worktree concern, so it
 * lives here rather than in GeneralPanel.
 */
export function GitPanel() {
  const { t } = useI18n();
  const commitGenModel = useSessionStore((s) => s.commitGenModel);
  const commitGenPrompt = useSessionStore((s) => s.commitGenPrompt);
  const setCommitGenModel = useSessionStore((s) => s.setCommitGenModel);
  const setCommitGenPrompt = useSessionStore((s) => s.setCommitGenPrompt);
  const conflictResolveModel = useSessionStore((s) => s.conflictResolveModel);
  const setConflictResolveModel = useSessionStore((s) => s.setConflictResolveModel);
  const customModels = useSessionStore((s) => s.customModels);

  // ── Git diff open mode ──
  const gitDiffOpenMode = useSessionStore((s) => s.gitDiffOpenMode);
  const setGitDiffOpenMode = useSessionStore((s) => s.setGitDiffOpenMode);

  // Build a flat list of selectable models: one entry per (config, model).
  // Each entry's value is `"configId:modelId"`, label is `"供应商名 → 模型id"`.
  const modelOptions = useMemo(() => {
    const opts: { value: string; label: string }[] = [];
    for (const cfg of customModels) {
      for (const entry of cfg.models) {
        if (entry.id.trim()) {
          opts.push({
            value: `${cfg.id}:${entry.id}`,
            label: `${cfg.name} → ${entry.id}`,
          });
        }
      }
    }
    return opts;
  }, [customModels]);

  return (
    <section className="mx-auto w-full max-w-3xl space-y-4">
      <PanelHeader title="Git" />

      {/* ── Git 差异打开方式 ── */}
      <SettingsSection
        title={t("settings.git.diffSection")}
        desc={t("settings.git.diffSectionDesc")}
      >
        <SettingRow
          title={t("settings.git.diffMode")}
          desc={t("settings.git.diffModeDesc")}
          htmlFor="setting-gitdiff-openmode"
        >
          <Select.Root
            value={gitDiffOpenMode}
            onValueChange={(v) => void setGitDiffOpenMode(v as GitDiffOpenMode)}
          >
            <Select.Trigger id="setting-gitdiff-openmode" className="w-full">
              <Select.Value>
                {(val: GitDiffOpenMode) => {
                  const o =
                    GIT_DIFF_OPEN_MODE_OPTIONS.find((x) => x.value === val) ??
                    GIT_DIFF_OPEN_MODE_OPTIONS[0];
                  return (
                    <span className="flex items-center gap-1.5">
                      {o.icon}
                      {t(o.labelKey)}
                    </span>
                  );
                }}
              </Select.Value>
            </Select.Trigger>
            <Select.Portal>
              <Select.Positioner>
                <Select.Popup>
                  <Select.List>
                    {GIT_DIFF_OPEN_MODE_OPTIONS.map((o) => (
                      <Select.Item key={o.value} value={o.value}>
                        {o.icon}
                        <Select.ItemText>{t(o.labelKey)}</Select.ItemText>
                      </Select.Item>
                    ))}
                  </Select.List>
                </Select.Popup>
              </Select.Positioner>
            </Select.Portal>
          </Select.Root>
        </SettingRow>
      </SettingsSection>

      {/* ── Git 提交信息生成 ── */}
      <SettingsSection
        title={t("settings.git.commitSection")}
        desc={t("settings.git.commitSectionDesc")}
      >
        {/* Model selector — specific supplier + role binding */}
        <SettingRow
          title={t("settings.genModel")}
          desc={t("settings.git.genModelDesc")}
        >
          {modelOptions.length > 0 ? (
            <Select.Root
              value={commitGenModel ?? MODEL_NONE}
              onValueChange={(v) => setCommitGenModel(v === MODEL_NONE ? null : (v as string))}
            >
              <Select.Trigger className="w-full">
                <Select.Value>
                  {(val: string) =>
                    val === MODEL_NONE ? (
                      <span className="flex min-w-0 items-center gap-1.5">
                        <IconCircleOff size={14} className="text-content-muted" />
                        <span className="truncate">{t("settings.git.noModelSelected")}</span>
                      </span>
                    ) : (
                      <span className="flex min-w-0 items-center gap-1.5">
                        <IconRobot size={14} className="text-content-muted" />
                        <span className="truncate">
                          {modelOptions.find((o) => o.value === val)?.label ?? val}
                        </span>
                      </span>
                    )
                  }
                </Select.Value>
              </Select.Trigger>
              <Select.Portal>
                <Select.Positioner>
                  <Select.Popup>
                    <Select.List>
                      <Select.Item value={MODEL_NONE}>
                        <IconCircleOff size={14} className="text-content-muted" />
                        <Select.ItemText>{t("settings.git.noModelSelected")}</Select.ItemText>
                      </Select.Item>
                      {modelOptions.map((opt) => (
                        <Select.Item key={opt.value} value={opt.value}>
                          <IconRobot size={14} className="text-content-muted" />
                          <Select.ItemText>{opt.label}</Select.ItemText>
                        </Select.Item>
                      ))}
                    </Select.List>
                  </Select.Popup>
                </Select.Positioner>
              </Select.Portal>
            </Select.Root>
          ) : (
            <p className="text-[0.7857em] text-content-subtle">
              {t("settings.git.noModelsHint")}
            </p>
          )}
        </SettingRow>

        {/* Prompt template — format/language preference only */}
        <SettingRow
          layout="vertical"
          title={t("settings.git.promptTitle")}
          desc={t("settings.git.promptDesc")}
        >
          <textarea
            value={commitGenPrompt}
            onChange={(e) => setCommitGenPrompt(e.target.value)}
            placeholder={t("settings.git.promptPlaceholder")}
            rows={5}
            className={cn(
              "w-full resize-y rounded-md border border-edge-input bg-surface px-2.5 py-1.5 text-[0.8571em] leading-relaxed text-content outline-none",
              "focus:border-accent",
            )}
          />
        </SettingRow>
      </SettingsSection>

      {/* ── Git 冲突解决 ── */}
      <SettingsSection
        title={t("settings.git.conflictSection")}
        desc={t("settings.git.conflictSectionDesc")}
      >
        {/* Conflict-resolution model selector */}
        <SettingRow
          title={t("settings.git.resolveModel")}
          desc={t("settings.git.resolveModelDesc")}
        >
          {modelOptions.length > 0 ? (
            <Select.Root
              value={conflictResolveModel ?? MODEL_NONE}
              onValueChange={(v) => setConflictResolveModel(v === MODEL_NONE ? null : (v as string))}
            >
              <Select.Trigger className="w-full">
                <Select.Value>
                  {(val: string) =>
                    val === MODEL_NONE ? (
                      <span className="flex min-w-0 items-center gap-1.5">
                        <IconCircleOff size={14} className="text-content-muted" />
                        <span className="truncate">{t("settings.git.noModelSelected")}</span>
                      </span>
                    ) : (
                      <span className="flex min-w-0 items-center gap-1.5">
                        <IconRobot size={14} className="text-content-muted" />
                        <span className="truncate">
                          {modelOptions.find((o) => o.value === val)?.label ?? val}
                        </span>
                      </span>
                    )
                  }
                </Select.Value>
              </Select.Trigger>
              <Select.Portal>
                <Select.Positioner>
                  <Select.Popup>
                    <Select.List>
                      <Select.Item value={MODEL_NONE}>
                        <IconCircleOff size={14} className="text-content-muted" />
                        <Select.ItemText>{t("settings.git.noModelSelected")}</Select.ItemText>
                      </Select.Item>
                      {modelOptions.map((opt) => (
                        <Select.Item key={opt.value} value={opt.value}>
                          <IconRobot size={14} className="text-content-muted" />
                          <Select.ItemText>{opt.label}</Select.ItemText>
                        </Select.Item>
                      ))}
                    </Select.List>
                  </Select.Popup>
                </Select.Positioner>
              </Select.Portal>
            </Select.Root>
          ) : (
            <p className="text-xs text-content-subtle">
              {t("settings.git.noModelsFallback")}
            </p>
          )}
        </SettingRow>
      </SettingsSection>

      {/* ── 工作树(隔离会话的托管根目录) ── */}
      <SettingsSection
        title={t("settings.git.worktreeSection")}
        desc={t("settings.git.worktreeSectionDesc")}
      >
        <SettingRow
          title={t("settings.git.worktreeRoot")}
          desc={t("settings.git.worktreeRootDesc")}
        >
          <WorktreeRootSetting />
        </SettingRow>
      </SettingsSection>
    </section>
  );
}
