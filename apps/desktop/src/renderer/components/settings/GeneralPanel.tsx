import {
  useSessionStore,
  PASTE_TAG_THRESHOLD_CHARS_MIN,
  PASTE_TAG_THRESHOLD_CHARS_MAX,
} from "@renderer/stores/sessionStore.js";
import { Select, Input } from "@renderer/components/ui/index.js";
import type { ChatDensity, DisplayMode } from "@contracts/ipc";
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
 *  - 会话标题生成 (TitleGenPanel, renders its own SettingsSection)
 *
 * Card-grouped layout: a page-level PanelHeader on top, then one
 * SettingsSection per functional category. TitleGenPanel is dropped in as a
 * sibling section — the outer space-y-4 keeps the two cards apart.
 */

const DISPLAY_MODE_OPTIONS: { value: DisplayMode; label: string }[] = [
  { value: "single", label: "单会话模式" },
  { value: "tabs", label: "Tab 标签模式" },
];

const DENSITY_OPTIONS: { value: ChatDensity; label: string }[] = [
  { value: "compact", label: "紧凑" },
  { value: "comfortable", label: "舒适" },
  { value: "cozy", label: "宽松" },
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
                {(val: DisplayMode) =>
                  DISPLAY_MODE_OPTIONS.find((o) => o.value === val)?.label ??
                  "单会话模式"
                }
              </Select.Value>
            </Select.Trigger>
            <Select.Portal>
              <Select.Positioner>
                <Select.Popup>
                  <Select.List>
                    {DISPLAY_MODE_OPTIONS.map((o) => (
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

        {/* ── Message-stream density (vertical rhythm) ── */}
        <SettingRow
          title="对话紧凑度"
          desc="调整消息之间的行间距与单条消息内块间距。紧凑可在屏幕内看到更多内容,宽松阅读更舒适。"
          htmlFor="setting-chatdensity"
        >
          <Select.Root
            value={chatDensity}
            onValueChange={(v) => void setChatDensity(v as ChatDensity)}
          >
            <Select.Trigger id="setting-chatdensity" className="min-w-[8rem]">
              <Select.Value>
                {(val: ChatDensity) =>
                  DENSITY_OPTIONS.find((o) => o.value === val)?.label ?? "舒适"
                }
              </Select.Value>
            </Select.Trigger>
            <Select.Portal>
              <Select.Positioner>
                <Select.Popup>
                  <Select.List>
                    {DENSITY_OPTIONS.map((o) => (
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

      {/* ── 会话标题生成 (self-contained section) ── */}
      <TitleGenPanel />
    </section>
  );
}
