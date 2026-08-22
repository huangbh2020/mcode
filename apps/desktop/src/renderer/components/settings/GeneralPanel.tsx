import {
  useSessionStore,
  PASTE_TAG_THRESHOLD_CHARS_MIN,
  PASTE_TAG_THRESHOLD_CHARS_MAX,
} from "@renderer/stores/sessionStore.js";
import { Select, Input, Switch, Button } from "@renderer/components/ui/index.js";
import { IconSquare, IconStack2, IconList, IconListDetails, IconGripHorizontal, IconX } from "@renderer/lib/icons.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import type { ChatDensity, DisplayMode, AutoArchiveConfig, Locale } from "@contracts/ipc";
import type { ReactNode } from "react";
import { SettingRow } from "./SettingRow.js";
import { PanelHeader } from "./PanelHeader.js";
import { SettingsSection } from "./SettingsSection.js";
import { TitleGenPanel } from "./TitleGenPanel.js";
import { OutputStylePanel } from "./OutputStylePanel.js";

/**
 * "常规" (General) settings panel.
 *
 * Hosts general-purpose preferences that aren't tied to a specific feature
 * area. Currently:
 *  - 语言 (SettingsSection): 界面语言 (zh/en)
 *  - 显示与布局 (SettingsSection): 中间面板显示模式 + 对话紧凑度 + 长文本折叠阈值
 *  - 会话自动归档 (SettingsSection): 开关 + 默认不活跃天数 + 按项目覆盖
 *  - 会话标题生成 (TitleGenPanel, renders its own SettingsSection)
 *  - 输出风格 (OutputStylePanel, renders its own SettingsSection)
 *
 * Card-grouped layout: a page-level PanelHeader on top, then one
 * SettingsSection per functional category. TitleGenPanel / OutputStylePanel
 * are dropped in as sibling sections — the outer space-y-4 keeps the cards
 * apart.
 */

const DISPLAY_MODE_OPTIONS: { value: DisplayMode; labelKey: MessageId; icon: ReactNode }[] = [
  { value: "single", labelKey: "settings.general.displayModeSingle", icon: <IconSquare size={14} className="text-content-muted" /> },
  { value: "tabs", labelKey: "settings.general.displayModeTabs", icon: <IconStack2 size={14} className="text-content-muted" /> },
];

const DENSITY_OPTIONS: { value: ChatDensity; labelKey: MessageId; icon: ReactNode }[] = [
  { value: "compact", labelKey: "settings.general.densityCompact", icon: <IconList size={14} className="text-content-muted" /> },
  { value: "comfortable", labelKey: "settings.general.densityComfortable", icon: <IconListDetails size={14} className="text-content-muted" /> },
  { value: "cozy", labelKey: "settings.general.densityCozy", icon: <IconGripHorizontal size={14} className="text-content-muted" /> },
];

/** Inactivity day thresholds. Labels are built via t("common.dayCount") at
 *  render time — the numeric value IS the label, only the unit word localizes. */
const AUTO_ARCHIVE_DAY_VALUES = [7, 14, 30, 60, 90];

/** Sentinel value for the per-project override select, distinct from the
 *  numeric day options. */
const NEVER_OVERRIDE = "0";

export function GeneralPanel() {
  const { t } = useI18n();

  // ── UI language ──
  const locale = useSessionStore((s) => s.locale);
  const setLocale = useSessionStore((s) => s.setLocale);

  // ── Display mode ──
  const displayMode = useSessionStore((s) => s.displayMode);
  const setDisplayMode = useSessionStore((s) => s.setDisplayMode);

  // ── Message-stream density ──
  const chatDensity = useSessionStore((s) => s.chatDensity);
  const setChatDensity = useSessionStore((s) => s.setChatDensity);

  // ── Paste-to-card threshold ──
  const pasteTagThresholdChars = useSessionStore((s) => s.pasteTagThresholdChars);
  const setPasteTagThresholdChars = useSessionStore((s) => s.setPasteTagThresholdChars);

  // ── Session auto-archive rules ──
  const autoArchiveConfig = useSessionStore((s) => s.autoArchiveConfig);
  const setAutoArchiveConfig = useSessionStore((s) => s.setAutoArchiveConfig);
  const projects = useSessionStore((s) => s.projects);

  const dayLabel = (val: string) =>
    AUTO_ARCHIVE_DAY_VALUES.some((d) => String(d) === val)
      ? t("common.dayCount", { n: val })
      : t("settings.general.archiveNever");

  const patchAutoArchive = (patch: Partial<AutoArchiveConfig>) =>
    void setAutoArchiveConfig({ ...autoArchiveConfig, ...patch });

  const setProjectOverride = (projectId: string, value: string) => {
    const days = Number(value);
    if (!Number.isFinite(days) || days < 0) return;
    patchAutoArchive({ overrides: { ...autoArchiveConfig.overrides, [projectId]: days } });
  };

  const addProjectOverride = (projectId: string) => {
    // Start the new override at the current default; the user then adjusts it.
    patchAutoArchive({
      overrides: { ...autoArchiveConfig.overrides, [projectId]: autoArchiveConfig.defaultDays },
    });
  };

  const removeProjectOverride = (projectId: string) => {
    const overrides = { ...autoArchiveConfig.overrides };
    delete overrides[projectId];
    patchAutoArchive({ overrides });
  };

  const activeProjects = projects.filter((p) => !p.archived);
  // Only projects WITH a custom override are listed; the rest stay hidden
  // behind the "add" picker so the panel stays compact.
  const overriddenProjects = activeProjects.filter(
    (p) => autoArchiveConfig.overrides[p.id] !== undefined,
  );
  const addableProjects = activeProjects.filter(
    (p) => autoArchiveConfig.overrides[p.id] === undefined,
  );

  return (
    <section className="mx-auto w-full max-w-3xl space-y-4">
      <PanelHeader
        title={t("settings.general.title")}
        desc={t("settings.general.desc")}
      />

      {/* ── 语言 ── */}
      <SettingsSection title={t("settings.general.sectionLanguage")}>
        <SettingRow
          title={t("settings.general.language")}
          desc={t("settings.general.languageDesc")}
          htmlFor="setting-locale"
        >
          <Select.Root
            value={locale}
            onValueChange={(v) => void setLocale(v as Locale)}
          >
            <Select.Trigger id="setting-locale" className="min-w-[10rem]">
              <Select.Value>
                {(val: Locale) =>
                  val === "en"
                    ? t("settings.general.languageEn")
                    : t("settings.general.languageZh")
                }
              </Select.Value>
            </Select.Trigger>
            <Select.Portal>
              <Select.Positioner>
                <Select.Popup>
                  <Select.List>
                    <Select.Item value="zh">
                      <Select.ItemText>{t("settings.general.languageZh")}</Select.ItemText>
                    </Select.Item>
                    <Select.Item value="en">
                      <Select.ItemText>{t("settings.general.languageEn")}</Select.ItemText>
                    </Select.Item>
                  </Select.List>
                </Select.Popup>
              </Select.Positioner>
            </Select.Portal>
          </Select.Root>
        </SettingRow>
      </SettingsSection>

      {/* ── 显示与布局 ── */}
      <SettingsSection title={t("settings.general.sectionDisplay")}>
        {/* ── Center-pane display mode ── */}
        <SettingRow
          title={t("settings.general.displayMode")}
          desc={t("settings.general.displayModeDesc")}
          htmlFor="setting-displaymode"
        >
          <Select.Root
            value={displayMode}
            onValueChange={(v) => void setDisplayMode(v as DisplayMode)}
          >
            <Select.Trigger id="setting-displaymode" className="min-w-[10rem]">
              <Select.Value>
                {(val: DisplayMode) => {
                  const o =
                    DISPLAY_MODE_OPTIONS.find((x) => x.value === val) ??
                    DISPLAY_MODE_OPTIONS[0];
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
                    {DISPLAY_MODE_OPTIONS.map((o) => (
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

        {/* ── Message-stream density (vertical rhythm) ── */}
        <SettingRow
          title={t("settings.general.density")}
          desc={t("settings.general.densityDesc")}
          htmlFor="setting-chatdensity"
        >
          <Select.Root
            value={chatDensity}
            onValueChange={(v) => void setChatDensity(v as ChatDensity)}
          >
            <Select.Trigger id="setting-chatdensity" className="min-w-[8rem]">
              <Select.Value>
                {(val: ChatDensity) => {
                  const o =
                    DENSITY_OPTIONS.find((x) => x.value === val) ??
                    DENSITY_OPTIONS[1];
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
                    {DENSITY_OPTIONS.map((o) => (
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

        {/* ── Long-text paste folding threshold ── */}
        <SettingRow
          title={t("settings.general.pasteThreshold")}
          desc={t("settings.general.pasteThresholdDesc", {
            min: PASTE_TAG_THRESHOLD_CHARS_MIN,
            max: PASTE_TAG_THRESHOLD_CHARS_MAX,
          })}
          htmlFor="setting-paste-threshold"
        >
          <Input
            id="setting-paste-threshold"
            type="number"
            min={PASTE_TAG_THRESHOLD_CHARS_MIN}
            max={PASTE_TAG_THRESHOLD_CHARS_MAX}
            step={50}
            value={pasteTagThresholdChars}
            onChange={(e) => void setPasteTagThresholdChars(Number(e.target.value))}
            className="w-24"
          />
        </SettingRow>
      </SettingsSection>

      {/* ── 会话自动归档 ── */}
      <SettingsSection title={t("settings.general.sectionArchive")}>
        <SettingRow
          title={t("settings.general.archiveEnabled")}
          desc={t("settings.general.archiveEnabledDesc")}
        >
          <Switch
            id="setting-autoarchive-enabled"
            checked={autoArchiveConfig.enabled}
            onCheckedChange={(v) => patchAutoArchive({ enabled: v })}
            label={autoArchiveConfig.enabled ? t("settings.general.archiveOn") : t("settings.general.archiveOff")}
          />
        </SettingRow>

        <SettingRow
          title={t("settings.general.archiveDefaultDays")}
          desc={t("settings.general.archiveDefaultDaysDesc")}
          htmlFor="setting-autoarchive-default-days"
        >
          <Select.Root
            value={String(autoArchiveConfig.defaultDays)}
            onValueChange={(v) => patchAutoArchive({ defaultDays: Number(v) })}
          >
            <Select.Trigger id="setting-autoarchive-default-days" className="min-w-[7rem]">
              <Select.Value>
                {(val: string) =>
                  AUTO_ARCHIVE_DAY_VALUES.some((d) => String(d) === val)
                    ? t("common.dayCount", { n: val })
                    : t("common.dayCount", { n: 30 })
                }
              </Select.Value>
            </Select.Trigger>
            <Select.Portal>
              <Select.Positioner>
                <Select.Popup>
                  <Select.List>
                    {AUTO_ARCHIVE_DAY_VALUES.map((d) => (
                      <Select.Item key={d} value={String(d)}>
                        <Select.ItemText>{t("common.dayCount", { n: d })}</Select.ItemText>
                      </Select.Item>
                    ))}
                  </Select.List>
                </Select.Popup>
              </Select.Positioner>
            </Select.Portal>
          </Select.Root>
        </SettingRow>

        {overriddenProjects.map((p) => (
          <SettingRow
            key={p.id}
            title={p.name}
            desc={t("settings.general.archiveOverrideDesc")}
            htmlFor={`setting-autoarchive-project-${p.id}`}
          >
            <div className="flex items-center gap-2">
              <Select.Root
                value={String(autoArchiveConfig.overrides[p.id])}
                onValueChange={(v) => setProjectOverride(p.id, v as string)}
              >
                <Select.Trigger id={`setting-autoarchive-project-${p.id}`} className="min-w-[7rem]">
                  <Select.Value>{(val: string) => dayLabel(val)}</Select.Value>
                </Select.Trigger>
                <Select.Portal>
                  <Select.Positioner>
                    <Select.Popup>
                      <Select.List>
                        <Select.Item value={NEVER_OVERRIDE}>
                          <Select.ItemText>{t("settings.general.archiveNever")}</Select.ItemText>
                        </Select.Item>
                        {AUTO_ARCHIVE_DAY_VALUES.map((d) => (
                          <Select.Item key={d} value={String(d)}>
                            <Select.ItemText>{t("common.dayCount", { n: d })}</Select.ItemText>
                          </Select.Item>
                        ))}
                      </Select.List>
                    </Select.Popup>
                  </Select.Positioner>
                </Select.Portal>
              </Select.Root>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => removeProjectOverride(p.id)}
                aria-label={t("settings.general.archiveRemoveOverrideAria", { name: p.name })}
                title={t("settings.general.archiveRemoveOverrideTitle")}
              >
                <IconX size={14} />
              </Button>
            </div>
          </SettingRow>
        ))}

        {addableProjects.length > 0 && (
          <SettingRow
            title={t("settings.general.archiveAddOverride")}
            desc={t("settings.general.archiveAddOverrideDesc")}
          >
            <Select.Root value={null} onValueChange={(v) => addProjectOverride(v as string)}>
              <Select.Trigger className="min-w-[10rem]">
                <Select.Value placeholder={t("settings.general.archivePickProject")} />
              </Select.Trigger>
              <Select.Portal>
                <Select.Positioner>
                  <Select.Popup>
                    <Select.List>
                      {addableProjects.map((p) => (
                        <Select.Item key={p.id} value={p.id}>
                          <Select.ItemText>{p.name}</Select.ItemText>
                        </Select.Item>
                      ))}
                    </Select.List>
                  </Select.Popup>
                </Select.Positioner>
              </Select.Portal>
            </Select.Root>
          </SettingRow>
        )}
      </SettingsSection>

      {/* ── 会话标题生成 (self-contained section) ── */}
      <TitleGenPanel />

      {/* ── 输出风格 (self-contained section) ── */}
      <OutputStylePanel />
    </section>
  );
}
