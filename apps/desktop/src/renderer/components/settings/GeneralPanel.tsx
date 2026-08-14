import {
  useSessionStore,
  PASTE_TAG_THRESHOLD_CHARS_MIN,
  PASTE_TAG_THRESHOLD_CHARS_MAX,
} from "@renderer/stores/sessionStore.js";
import { Select, Input, Switch, Button } from "@renderer/components/ui/index.js";
import { IconSquare, IconStack2, IconList, IconListDetails, IconGripHorizontal, IconX } from "@renderer/lib/icons.js";
import type { ChatDensity, DisplayMode, AutoArchiveConfig } from "@contracts/ipc";
import type { ReactNode } from "react";
import { SettingRow } from "./SettingRow.js";
import { PanelHeader } from "./PanelHeader.js";
import { SettingsSection } from "./SettingsSection.js";
import { TitleGenPanel } from "./TitleGenPanel.js";

/**
 * "常规" (General) settings panel.
 *
 * Hosts general-purpose preferences that aren't tied to a specific feature
 * area. Currently:
 *  - 显示与布局 (SettingsSection): 中间面板显示模式 + 对话紧凑度 + 长文本折叠阈值
 *  - 会话自动归档 (SettingsSection): 开关 + 默认不活跃天数 + 按项目覆盖
 *  - 会话标题生成 (TitleGenPanel, renders its own SettingsSection)
 *
 * Card-grouped layout: a page-level PanelHeader on top, then one
 * SettingsSection per functional category. TitleGenPanel is dropped in as a
 * sibling section — the outer space-y-4 keeps the two cards apart.
 */

const DISPLAY_MODE_OPTIONS: { value: DisplayMode; label: string; icon: ReactNode }[] = [
  { value: "single", label: "单会话模式", icon: <IconSquare size={14} className="text-content-muted" /> },
  { value: "tabs", label: "Tab 标签模式", icon: <IconStack2 size={14} className="text-content-muted" /> },
];

const DENSITY_OPTIONS: { value: ChatDensity; label: string; icon: ReactNode }[] = [
  { value: "compact", label: "紧凑", icon: <IconList size={14} className="text-content-muted" /> },
  { value: "comfortable", label: "舒适", icon: <IconListDetails size={14} className="text-content-muted" /> },
  { value: "cozy", label: "宽松", icon: <IconGripHorizontal size={14} className="text-content-muted" /> },
];

/** Inactivity thresholds offered for the global default and per-project
 *  overrides. A project override of `never` maps to 0 (skip in the archiver). */
const AUTO_ARCHIVE_DAY_OPTIONS: { value: string; label: string }[] = [
  { value: "7", label: "7 天" },
  { value: "14", label: "14 天" },
  { value: "30", label: "30 天" },
  { value: "60", label: "60 天" },
  { value: "90", label: "90 天" },
];

/** Sentinel values for the per-project override select, distinct from the
 *  numeric day options. */
const NEVER_OVERRIDE = "0";

/** Options for a per-project override: "永不归档" (0) plus the numeric day
 *  thresholds. The global default select uses AUTO_ARCHIVE_DAY_OPTIONS only —
 *  the default must always be a concrete day count. */
const AUTO_ARCHIVE_OVERRIDE_OPTIONS: { value: string; label: string }[] = [
  { value: NEVER_OVERRIDE, label: "永不归档" },
  ...AUTO_ARCHIVE_DAY_OPTIONS,
];

export function GeneralPanel() {
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
    <section className="space-y-4">
      <PanelHeader
        title="常规"
        desc="调整界面布局、消息显示与会话标题等基础偏好。"
      />

      {/* ── 显示与布局 ── */}
      <SettingsSection title="显示与布局">
        {/* ── Center-pane display mode ── */}
        <SettingRow
          title="中间面板显示模式"
          desc="点击左侧会话时,中间聊天区的呈现方式。"
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
                      {o.label}
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
                        <Select.ItemText>{o.label}</Select.ItemText>
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
          title="对话紧凑度"
          desc="调整消息之间的行间距、消息内块间距,以及回复正文的段落间距与行高。紧凑可在屏幕内看到更多内容,宽松阅读更舒适。"
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
                      {o.label}
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
                        <Select.ItemText>{o.label}</Select.ItemText>
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
          title="长文本折叠阈值"
          desc={`在输入框粘贴超过此字符数的内容时,会折叠为输入框上方的卡片而非直接插入正文(${PASTE_TAG_THRESHOLD_CHARS_MIN}–${PASTE_TAG_THRESHOLD_CHARS_MAX})。`}
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
      <SettingsSection title="会话自动归档">
        <SettingRow
          title="自动归档不活跃会话"
          desc="开启后,长时间没有活动的会话会自动移入左侧底部的「已归档」分区(可随时恢复)。置顶与正在运行的会话不会被归档。"
        >
          <Switch
            id="setting-autoarchive-enabled"
            checked={autoArchiveConfig.enabled}
            onCheckedChange={(v) => patchAutoArchive({ enabled: v })}
            label={autoArchiveConfig.enabled ? "已开启" : "已关闭"}
          />
        </SettingRow>

        <SettingRow
          title="默认不活跃天数"
          desc="会话超过该天数没有任何活动(收发消息、改名、置顶等)后自动归档。可在下方为单个项目单独覆盖。"
          htmlFor="setting-autoarchive-default-days"
        >
          <Select.Root
            value={String(autoArchiveConfig.defaultDays)}
            onValueChange={(v) => patchAutoArchive({ defaultDays: Number(v) })}
          >
            <Select.Trigger id="setting-autoarchive-default-days" className="min-w-[7rem]">
              <Select.Value>
                {(val: string) => {
                  const label =
                    AUTO_ARCHIVE_DAY_OPTIONS.find((o) => o.value === val)?.label ?? "30 天";
                  return label;
                }}
              </Select.Value>
            </Select.Trigger>
            <Select.Portal>
              <Select.Positioner>
                <Select.Popup>
                  <Select.List>
                    {AUTO_ARCHIVE_DAY_OPTIONS.map((o) => (
                      <Select.Item key={o.value} value={o.value}>
                        <Select.ItemText>{o.label}</Select.ItemText>
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
            desc="覆盖上方默认归档天数。"
            htmlFor={`setting-autoarchive-project-${p.id}`}
          >
            <div className="flex items-center gap-2">
              <Select.Root
                value={String(autoArchiveConfig.overrides[p.id])}
                onValueChange={(v) => setProjectOverride(p.id, v as string)}
              >
                <Select.Trigger id={`setting-autoarchive-project-${p.id}`} className="min-w-[7rem]">
                  <Select.Value>
                    {(val: string) =>
                      AUTO_ARCHIVE_OVERRIDE_OPTIONS.find((o) => o.value === val)?.label ?? "30 天"
                    }
                  </Select.Value>
                </Select.Trigger>
                <Select.Portal>
                  <Select.Positioner>
                    <Select.Popup>
                      <Select.List>
                        {AUTO_ARCHIVE_OVERRIDE_OPTIONS.map((o) => (
                          <Select.Item key={o.value} value={o.value}>
                            <Select.ItemText>{o.label}</Select.ItemText>
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
                aria-label={`移除 ${p.name} 的归档覆盖`}
                title="移除覆盖"
              >
                <IconX size={14} />
              </Button>
            </div>
          </SettingRow>
        ))}

        {addableProjects.length > 0 && (
          <SettingRow
            title="添加项目覆盖"
            desc="为需要单独设置归档规则的项目添加覆盖。"
          >
            <Select.Root value={null} onValueChange={(v) => addProjectOverride(v as string)}>
              <Select.Trigger className="min-w-[10rem]">
                <Select.Value placeholder="选择项目…" />
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
    </section>
  );
}
