/**
 * Agent 设置面板(设置 → AI 能力 → Agent)。
 *
 * 包含两部分核心配置:
 * 1. 任务编排调度(Orchestration): 控制意图识别后的子任务分解与执行模式(关闭/询问/自动)。
 * 2. 全局 Agent 系统提示词(Custom Prompt): 注入到所有 Provider (Claude / Pi / Codex)
 *    系统提示词末尾的全局常驻指令。
 */
import { useEffect, useState, useCallback, useMemo } from "react";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { AGENT_CUSTOM_PROMPT_SETTING_KEY } from "@contracts/ipc";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { Button } from "@renderer/components/ui/index.js";
import {
  IconArrowsSplit,
  IconPrompt,
  IconCircleOff,
  IconHelpCircle,
  IconBolt,
  IconCheck,
  IconSparkles,
  IconPlus,
} from "@renderer/lib/icons.js";
import { PanelHeader } from "./PanelHeader.js";
import { SettingsSection } from "./SettingsSection.js";
import { SettingRow } from "./SettingRow.js";

const MAX_PROMPT_LENGTH = 100_000;

/** 常用预设快捷指令 */
interface PresetRule {
  id: string;
  labelKey: MessageId;
  content: string;
}

const PRESET_RULES: PresetRule[] = [
  {
    id: "chinese",
    labelKey: "settings.agents.presetChinese",
    content: "请始终使用简体中文与我沟通和回复。",
  },
  {
    id: "comments",
    labelKey: "settings.agents.presetPreserveComments",
    content: "修改代码时，严格保留无关代码段原有的注释与文档说明。",
  },
  {
    id: "planFirst",
    labelKey: "settings.agents.presetPlanFirst",
    content: "在执行多步重大修改前，先清晰列出实施计划与改动点。",
  },
  {
    id: "typecheck",
    labelKey: "settings.agents.presetTypecheck",
    content: "在完成代码修改后，优先运行类型检查确保无类型错误。",
  },
  {
    id: "kiss",
    labelKey: "settings.agents.presetKiss",
    content: "恪守 KISS 极简设计原则，避免过度设计与冗余封装。",
  },
];

export function AgentsPanel() {
  const { t } = useI18n();
  const orchSettings = useSessionStore((s) => s.orchSettings);
  const saveOrchSettings = useSessionStore((s) => s.saveOrchSettings);

  const currentMode = orchSettings?.triggerMode ?? "ask";

  const setTriggerMode = (mode: "off" | "ask" | "auto") => {
    void saveOrchSettings({
      triggerMode: mode,
      concurrency: orchSettings?.concurrency ?? 4,
      budgetUsd: orchSettings?.budgetUsd ?? 0,
    });
  };

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl min-h-0 flex-col">
      <PanelHeader
        className="mb-3"
        title={t("orch.settings.panelTitle")}
      />

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto pb-8">
        {/* ── 模块 1: 任务编排调度 ── */}
        <SettingsSection
          title={t("settings.agents.orchSectionTitle")}
          desc={t("settings.agents.orchSectionDesc")}
          icon={IconArrowsSplit}
        >
          <div className="p-4 space-y-3">
            <div className="text-[0.8571em] font-medium text-content">
              {t("settings.agents.triggerMode")}
            </div>
            <p className="text-[0.7857em] text-content-subtle">
              {t("settings.agents.triggerModeDesc")}
            </p>

            {/* 三档位卡片选择器 */}
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3 pt-1">
              {/* 关闭 */}
              <TriggerModeCard
                active={currentMode === "off"}
                onClick={() => setTriggerMode("off")}
                icon={IconCircleOff}
                title={t("settings.agents.triggerOffTitle")}
                desc={t("settings.agents.triggerOffDesc")}
              />

              {/* 询问我 (推荐) */}
              <TriggerModeCard
                active={currentMode === "ask"}
                onClick={() => setTriggerMode("ask")}
                icon={IconHelpCircle}
                title={t("settings.agents.triggerAskTitle")}
                desc={t("settings.agents.triggerAskDesc")}
                isRecommended
              />

              {/* 自动 */}
              <TriggerModeCard
                active={currentMode === "auto"}
                onClick={() => setTriggerMode("auto")}
                icon={IconBolt}
                title={t("settings.agents.triggerAutoTitle")}
                desc={t("settings.agents.triggerAutoDesc")}
              />
            </div>
          </div>
        </SettingsSection>

        {/* ── 模块 2: 全局系统提示词 ── */}
        <CustomPromptSection />
      </div>
    </div>
  );
}

/** 触发模式选择单选卡片 */
function TriggerModeCard({
  active,
  onClick,
  icon: Icon,
  title,
  desc,
  isRecommended,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof IconCircleOff;
  title: string;
  desc: string;
  isRecommended?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative flex flex-col justify-start rounded-lg border p-3.5 text-left transition-all outline-none",
        active
          ? "border-accent bg-accent/5 ring-1 ring-accent"
          : "border-edge bg-surface hover:border-edge-strong hover:bg-surface-hover/60",
      )}
    >
      <div className="flex w-full items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Icon
            size={16}
            className={cn(
              "shrink-0",
              active ? "text-accent" : "text-content-muted",
            )}
          />
          <span
            className={cn(
              "text-xs font-semibold",
              active ? "text-accent" : "text-content",
            )}
          >
            {title}
          </span>
        </div>
        {active ? (
          <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-accent text-accent-content">
            <IconCheck size={11} strokeWidth={3} />
          </span>
        ) : isRecommended ? (
          <span className="rounded bg-accent/10 px-1 py-0.5 text-[0.6429em] font-medium text-accent">
            REC
          </span>
        ) : null}
      </div>

      <p className="mt-2 text-[0.7857em] leading-relaxed text-content-subtle">
        {desc}
      </p>
    </button>
  );
}

/** 全局 Agent 自定义提示词配置块 */
function CustomPromptSection() {
  const { t } = useI18n();
  const [initialText, setInitialText] = useState("");
  const [text, setText] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<"saved" | "error" | null>(null);

  // 加载已存储的设置
  useEffect(() => {
    setFeedback(null);
    void (async () => {
      const { value } = await api.setting.get({ key: AGENT_CUSTOM_PROMPT_SETTING_KEY });
      const val = value ?? "";
      setInitialText(val);
      setText(val);
      setLoaded(true);
    })();
  }, []);

  const isDirty = useMemo(() => text !== initialText, [text, initialText]);

  const save = useCallback(async () => {
    if (saving || !loaded) return;
    setSaving(true);
    try {
      await api.setting.set({ key: AGENT_CUSTOM_PROMPT_SETTING_KEY, value: text });
      setInitialText(text);
      setFeedback("saved");
    } catch {
      setFeedback("error");
    } finally {
      setSaving(false);
    }
  }, [saving, loaded, text]);

  // 支持 Ctrl+S / ⌘S 快捷保存
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      void save();
    }
  };

  // 快捷追加预设指令
  const handleAppendPreset = (presetContent: string) => {
    setFeedback(null);
    setText((prev) => {
      const trimmed = prev.trim();
      if (!trimmed) {
        return presetContent;
      }
      if (trimmed.includes(presetContent)) {
        return prev;
      }
      return `${trimmed}\n${presetContent}`;
    });
  };

  return (
    <SettingsSection
      title={t("settings.agents.customPromptSection")}
      desc={t("settings.agents.customPromptDesc")}
      icon={IconPrompt}
    >
      <SettingRow
        layout="vertical"
        title={
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>{t("settings.agents.customPromptLabel")}</span>
            <div className="flex items-center gap-1.5 text-[0.7143em] text-content-subtle">
              <span className="rounded border border-edge bg-surface-muted/50 px-1.5 py-0.5">
                Claude SDK
              </span>
              <span className="rounded border border-edge bg-surface-muted/50 px-1.5 py-0.5">
                Pi SDK
              </span>
              <span className="rounded border border-edge bg-surface-muted/50 px-1.5 py-0.5">
                Codex
              </span>
            </div>
          </div>
        }
        desc={t("settings.agents.customPromptHint")}
        htmlFor="setting-agent-custom-prompt"
      >
        <div className="space-y-3">
          {/* 快捷常用预设标签胶囊 */}
          <div className="space-y-1.5">
            <div className="flex items-center gap-1 text-[0.75em] text-content-subtle">
              <IconSparkles size={13} className="text-accent" />
              <span>{t("settings.agents.customPromptPillsLabel")}</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {PRESET_RULES.map((preset) => {
                const isContained = text.includes(preset.content);
                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => handleAppendPreset(preset.content)}
                    disabled={isContained || !loaded}
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors",
                      isContained
                        ? "border-edge bg-surface-muted/40 text-content-subtle cursor-default"
                        : "border-edge bg-surface text-content hover:border-accent hover:text-accent hover:bg-surface-hover active:scale-[0.98]",
                    )}
                    title={preset.content}
                  >
                    {!isContained && <IconPlus size={11} className="shrink-0" />}
                    {isContained && <IconCheck size={11} className="shrink-0 text-accent" />}
                    <span>{t(preset.labelKey)}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 文本输入区 */}
          <div className="relative rounded-lg border border-edge bg-surface transition-colors focus-within:border-accent">
            <textarea
              id="setting-agent-custom-prompt"
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setFeedback(null);
              }}
              onKeyDown={handleKeyDown}
              placeholder={t("settings.agents.customPromptPlaceholder")}
              spellCheck={false}
              disabled={!loaded}
              maxLength={MAX_PROMPT_LENGTH}
              rows={9}
              className="w-full resize-y rounded-lg bg-transparent px-3 py-2.5 font-mono text-xs leading-relaxed text-content outline-none placeholder:text-content-subtle disabled:opacity-50"
            />

            {/* 字符数指示器 */}
            <div className="flex justify-end px-3 pb-2 text-[0.7143em] text-content-subtle">
              {t("settings.agents.charCount", {
                count: text.length.toLocaleString(),
                max: MAX_PROMPT_LENGTH.toLocaleString(),
              })}
            </div>
          </div>

          {/* 底部操作与反馈 */}
          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <div className="flex items-center gap-2">
              {isDirty && !feedback && (
                <span className="flex items-center gap-1.5 text-xs text-amber-500">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
                  {t("settings.agents.customPromptUnsaved")}
                </span>
              )}

              {feedback && (
                <span
                  className={cn(
                    "text-xs flex items-center gap-1",
                    feedback === "saved" ? "text-accent" : "text-danger",
                  )}
                >
                  {feedback === "saved" && <IconCheck size={13} />}
                  {feedback === "saved"
                    ? t("settings.agents.customPromptSaved")
                    : t("settings.agents.customPromptSaveFailed")}
                </span>
              )}
            </div>

            <div className="flex items-center gap-2">
              {isDirty && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setText(initialText);
                    setFeedback(null);
                  }}
                  disabled={saving || !loaded}
                >
                  {t("settings.agents.customPromptReset")}
                </Button>
              )}

              <Button
                variant="primary"
                size="sm"
                onClick={() => void save()}
                disabled={saving || !loaded || !isDirty}
              >
                {saving ? t("settings.saving") : t("common.save")}
              </Button>
            </div>
          </div>
        </div>
      </SettingRow>
    </SettingsSection>
  );
}
