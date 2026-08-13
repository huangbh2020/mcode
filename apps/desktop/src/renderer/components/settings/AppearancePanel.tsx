import { useEffect, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useTheme } from "@renderer/lib/theme.js";
import { api } from "@renderer/lib/api.js";
import { hexToTriplet, tripletToHex } from "@renderer/lib/colorUtils.js";
import { useSessionStore, CHAT_FONT_SIZE_MIN, CHAT_FONT_SIZE_MAX, RIGHT_PANEL_FONT_SIZE_MIN, RIGHT_PANEL_FONT_SIZE_MAX } from "@renderer/stores/sessionStore.js";
import { Button, Card, Select } from "@renderer/components/ui/index.js";
import { IconRefresh, IconSun, IconMoon, IconDeviceDesktop } from "@renderer/lib/icons.js";
import type { ThemeName } from "@contracts/theme";
import type { ReactNode } from "react";
import { PanelHeader } from "./PanelHeader.js";
import { SettingRow } from "./SettingRow.js";
import { FontSizeStepper } from "./FontSizeStepper.js";

/**
 * Appearance settings — a flat, one-row-per-feature list.
 *
 * Consolidates what used to be four separate stacked panels (ThemePanel,
 * DisplayModePanel, ChatAppearancePanel, AccentPanel) into a single compact
 * view: left column = feature description, right column = a small control
 * (dropdown / color swatch / slider).
 *
 * Note: the display-mode row used to live here but has moved to the "常规"
 * (General) panel — it's a layout/interaction preference, not visual styling.
 *
 * Persistence summary:
 *  - theme           → api.theme.set → nativeTheme.themeSource on main
 *  - chatFontSize    → setting.set(ui.chatFontSize, …)
 *  - userMessageColor→ setting.set(ui.userMessageColor, …)   "R G B" | null
 *  - accentColor     → setting.set(ui.accentColor, …)        "R G B" | null
 */

/** Default font size shown when no override is set (matches styles.css). */
const DEFAULT_FONT_SIZE = 14;

/** Hex of the default accent color (emerald-600). Used as the picker fallback. */
const DEFAULT_ACCENT_HEX = "#059669";

/** Hex of the default user-message bg color (zinc-500, neutral gray). Used as
 *  the picker fallback. Matches the --user-bubble default in styles.css. */
const DEFAULT_USER_BUBBLE_HEX = "#52525b";

/** Curated user-bubble presets. `triplet` is what we persist; `hex` drives the
 *  swatch. Mirrors ACCENT_PRESETS structure; the first entry is the default
 *  (neutral gray) so user prompts read as a calm, non-distracting bubble. */
const USER_BUBBLE_PRESETS: { name: string; triplet: string; hex: string }[] = [
  { name: "灰色", triplet: "82 82 91", hex: "#52525b" }, // zinc-500 (= default)
  { name: "翠绿", triplet: "5 150 105", hex: "#059669" }, // emerald-600
  { name: "天蓝", triplet: "2 132 199", hex: "#0284c7" }, // sky-600
  { name: "靛蓝", triplet: "67 56 202", hex: "#4338ca" }, // indigo-700
  { name: "紫罗兰", triplet: "124 58 237", hex: "#7c3aed" }, // violet-600
  { name: "玫瑰红", triplet: "225 29 72", hex: "#e11d48" }, // rose-600
  { name: "琥珀", triplet: "217 119 6", hex: "#d97706" }, // amber-600
];

/** Curated accent presets. `triplet` is what we persist; `hex` drives the swatch.
 *  The first entry (emerald) is the default and stays saturated for brand
 *  identity; the rest are softened tints (lifted lightness, middling
 *  saturation) so they read as calm chips instead of glaring ones — kinder on
 *  the eyes in dark mode. Trade-off: very soft accents reduce white-on-accent
 *  legibility on filled buttons (those prefer a darker accent). */
const ACCENT_PRESETS: { name: string; triplet: string; hex: string }[] = [
  { name: "翠绿", triplet: "5 150 105", hex: "#059669" }, // emerald-600 (default, kept saturated)
  { name: "天蓝", triplet: "111 182 224", hex: "#6fb6e0" }, // soft sky
  { name: "靛蓝", triplet: "139 151 232", hex: "#8b97e8" }, // soft indigo
  { name: "青色", triplet: "94 200 184", hex: "#5ec8b8" }, // soft teal
  { name: "紫罗兰", triplet: "184 156 230", hex: "#b89ce6" }, // soft violet
  { name: "樱粉", triplet: "244 168 168", hex: "#f4a8a8" }, // soft rose
  { name: "琥珀", triplet: "243 201 105", hex: "#f3c969" }, // soft amber
  { name: "橙色", triplet: "246 165 107", hex: "#f6a56b" }, // soft orange
];

const THEME_OPTIONS: { value: ThemeName; label: string; icon: ReactNode }[] = [
  { value: "light", label: "浅色", icon: <IconSun size={14} className="text-content-muted" /> },
  { value: "dark", label: "深色", icon: <IconMoon size={14} className="text-content-muted" /> },
  { value: "system", label: "跟随系统", icon: <IconDeviceDesktop size={14} className="text-content-muted" /> },
];

export function AppearancePanel() {
  const { theme, effective } = useTheme();

  // ── Chat font size ──
  const chatFontSize = useSessionStore((s) => s.chatFontSize);
  const setChatFontSize = useSessionStore((s) => s.setChatFontSize);

  // ── Side-panel (left bar + right panel) font size ──
  const rightPanelFontSize = useSessionStore((s) => s.rightPanelFontSize);
  const setRightPanelFontSize = useSessionStore((s) => s.setRightPanelFontSize);

  // ── User message bg color ──
  const userMessageColor = useSessionStore((s) => s.userMessageColor);
  const setUserMessageColor = useSessionStore((s) => s.setUserMessageColor);

  // ── Accent color ──
  const accentColor = useSessionStore((s) => s.accentColor);
  const setAccentColor = useSessionStore((s) => s.setAccentColor);

  // Local pending hex strings for snappy color-picker feedback while the IPC
  // write is in flight. The store value is the source of truth; pending just
  // makes the swatch/picker flip instantly. Reset on each fresh mount.
  const [pendingUserHex, setPendingUserHex] = useState<string>("");
  const [pendingAccentHex, setPendingAccentHex] = useState<string>("");
  useEffect(() => {
    setPendingUserHex("");
    setPendingAccentHex("");
  }, []);

  const userColorHex =
    pendingUserHex ||
    tripletToHex(userMessageColor) ||
    DEFAULT_USER_BUBBLE_HEX;
  const accentHex =
    pendingAccentHex ||
    tripletToHex(accentColor) ||
    DEFAULT_ACCENT_HEX;

  const effectiveLabel = effective === "dark" ? "深色" : "浅色";

  return (
    <section className="space-y-4">
      <PanelHeader
        title="外观"
        desc="调整界面主题、聊天样式与全局强调色,所有改动实时生效。"
      />

      {/* Single category → rows go straight into one card. Rows share a
          `divide-y` so each SettingRow is separated by a hairline without each
          row having to know about borders. */}
      <Card className="divide-y divide-edge">
        {/* ── Theme ── */}
        <SettingRow
          title="界面主题"
          desc={
            <>
              选择应用的外观配色;选&quot;跟随系统&quot;会随操作系统自动切换。
              {theme === "system" && (
                <span className="text-content-muted"> 当前:{effectiveLabel}。</span>
              )}
            </>
          }
          htmlFor="setting-theme"
        >
          <Select.Root
            value={theme}
            onValueChange={(v) => void api.theme.set({ theme: v as ThemeName })}
          >
            <Select.Trigger id="setting-theme" className="min-w-[8rem]">
              <Select.Value>
                {(val: ThemeName) => {
                  const o =
                    THEME_OPTIONS.find((x) => x.value === val) ??
                    THEME_OPTIONS[0];
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
                    {THEME_OPTIONS.map((o) => (
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

        {/* ── Global font size (left bar + right panel + settings) ── */}
        <SettingRow
          title="全局字体大小"
          desc={`统一设置左侧项目栏、右侧文件树/Git/终端以及设置面板的字体大小(${RIGHT_PANEL_FONT_SIZE_MIN}–${RIGHT_PANEL_FONT_SIZE_MAX} px)。`}
          htmlFor="setting-sidepanel-fontsize"
        >
          <FontSizeStepper
            id="setting-sidepanel-fontsize"
            value={rightPanelFontSize}
            min={RIGHT_PANEL_FONT_SIZE_MIN}
            max={RIGHT_PANEL_FONT_SIZE_MAX}
            onChange={(px) => void setRightPanelFontSize(px)}
          />
        </SettingRow>

        {/* ── Chat font size ── */}
        <SettingRow
          title="聊天字体大小"
          desc={`自定义聊天内容的字体大小(${CHAT_FONT_SIZE_MIN}–${CHAT_FONT_SIZE_MAX} px)。`}
          htmlFor="setting-fontsize"
        >
          <FontSizeStepper
            id="setting-fontsize"
            value={chatFontSize}
            min={CHAT_FONT_SIZE_MIN}
            max={CHAT_FONT_SIZE_MAX}
            onChange={(px) => void setChatFontSize(px)}
          />
        </SettingRow>

        {/* ── User message background color ── */}
        <SettingRow
          title="用户消息背景色"
          desc={
            userMessageColor
              ? `自定义 ${userColorHex.toUpperCase()}`
              : "主题默认色(灰色)"
          }
          descExtra={
            <span className="text-[0.7143em] text-content-subtle">
              影响聊天中用户消息气泡的背景色调。
            </span>
          }
          controlAlign="start"
          htmlFor="setting-usercolor"
        >
          {/* Preset swatches */}
          <div className="flex flex-wrap gap-1.5">
            {USER_BUBBLE_PRESETS.map((p) => {
              const active = userMessageColor === p.triplet && !pendingUserHex;
              return (
                <button
                  key={p.triplet}
                  type="button"
                  onClick={() => {
                    setPendingUserHex("");
                    void setUserMessageColor(p.triplet);
                  }}
                  title={`${p.name} · ${p.hex.toUpperCase()}`}
                  aria-label={`选择${p.name}`}
                  aria-pressed={active}
                  className={cn(
                    "h-6 w-6 rounded-full border-2 transition-transform hover:scale-110",
                    active
                      ? "border-content ring-2 ring-content/20 ring-offset-1 ring-offset-surface"
                      : "border-edge",
                  )}
                  style={{ backgroundColor: p.hex }}
                />
              );
            })}
          </div>
          <input
            id="setting-usercolor"
            type="color"
            value={userColorHex}
            onChange={(e) => {
              const hex = e.target.value;
              const triplet = hexToTriplet(hex);
              setPendingUserHex(hex);
              if (triplet) void setUserMessageColor(triplet);
            }}
            className="h-7 w-10 cursor-pointer rounded border border-edge bg-transparent p-0.5"
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setPendingUserHex("");
              void setUserMessageColor(null);
            }}
            disabled={!userMessageColor && !pendingUserHex}
            title="恢复为主题默认色(灰色)"
            className="gap-1 px-1.5"
          >
            <IconRefresh size={11} />
            恢复默认
          </Button>
        </SettingRow>

        {/* ── Accent color ── */}
        <SettingRow
          title="品牌强调色"
          desc={
            accentColor
              ? `自定义 ${accentHex.toUpperCase()}`
              : "主题默认色(翠绿)"
          }
          descExtra={
            <span className="text-[0.7143em] text-content-subtle">
              影响按钮、链接、选中态、输入框聚焦边框等。
            </span>
          }
          controlAlign="start"
        >
          {/* Preset swatches */}
          <div className="flex flex-wrap gap-1.5">
            {ACCENT_PRESETS.map((p) => {
              const active = accentColor === p.triplet && !pendingAccentHex;
              return (
                <button
                  key={p.triplet}
                  type="button"
                  onClick={() => {
                    setPendingAccentHex("");
                    void setAccentColor(p.triplet);
                  }}
                  title={`${p.name} · ${p.hex.toUpperCase()}`}
                  aria-label={`选择${p.name}`}
                  aria-pressed={active}
                  className={cn(
                    "h-6 w-6 rounded-full border-2 transition-transform hover:scale-110",
                    active
                      ? "border-content ring-2 ring-content/20 ring-offset-1 ring-offset-surface"
                      : "border-edge",
                  )}
                  style={{ backgroundColor: p.hex }}
                />
              );
            })}
          </div>
          <input
            id="setting-accent"
            type="color"
            value={accentHex}
            onChange={(e) => {
              const hex = e.target.value;
              const triplet = hexToTriplet(hex);
              setPendingAccentHex(hex);
              if (triplet) void setAccentColor(triplet);
            }}
            className="h-7 w-10 cursor-pointer rounded border border-edge bg-transparent p-0.5"
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setPendingAccentHex("");
              void setAccentColor(null);
            }}
            disabled={!accentColor && !pendingAccentHex}
            title="恢复为主题默认色(翠绿)"
            className="gap-1 px-1.5"
          >
            <IconRefresh size={11} />
            恢复默认
          </Button>
        </SettingRow>

      {/* Tiny footer note — the card above intentionally ends after the last
          accent row. */}
      </Card>
      <p className="pt-1 text-[0.7143em] text-content-subtle">
        提示:主题切换整窗即时生效;颜色透明度按各场景预设固定,无需手动调节。
      </p>
    </section>
  );
}
