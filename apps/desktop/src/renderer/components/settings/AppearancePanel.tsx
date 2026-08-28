import { useEffect, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useTheme } from "@renderer/lib/theme.js";
import { api } from "@renderer/lib/api.js";
import { hexToTriplet, tripletToHex } from "@renderer/lib/colorUtils.js";
import { useSessionStore, CHAT_FONT_SIZE_MIN, CHAT_FONT_SIZE_MAX, RIGHT_PANEL_FONT_SIZE_MIN, RIGHT_PANEL_FONT_SIZE_MAX } from "@renderer/stores/sessionStore.js";
import { Button, Select } from "@renderer/components/ui/index.js";
import { IconRefresh, IconSun, IconMoon, IconDeviceDesktop } from "@renderer/lib/icons.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import { editorThemePresetsForMode } from "@renderer/lib/editorThemes.js";
import type { ThemeName } from "@contracts/theme";
import type { ReactNode } from "react";
import { PanelHeader } from "./PanelHeader.js";
import { SettingsSection } from "./SettingsSection.js";
import { SettingRow } from "./SettingRow.js";
import { FontSizeStepper } from "./FontSizeStepper.js";

/**
 * Appearance settings — two grouped cards: 主题与颜色 + 字号.
 *
 * Consolidates what used to be four separate stacked panels (ThemePanel,
 * DisplayModePanel, ChatAppearancePanel, AccentPanel) into a single compact
 * view. Selects fill the fixed SettingRow control slot; color palettes take
 * full-width vertical rows (swatches don't fit a 260px slot).
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
const USER_BUBBLE_PRESETS: { nameKey: MessageId; triplet: string; hex: string }[] = [
  { nameKey: "settings.appearance.colorGray", triplet: "82 82 91", hex: "#52525b" }, // zinc-500 (= default)
  { nameKey: "settings.appearance.colorEmerald", triplet: "5 150 105", hex: "#059669" }, // emerald-600
  { nameKey: "settings.appearance.colorSky", triplet: "2 132 199", hex: "#0284c7" }, // sky-600
  { nameKey: "settings.appearance.colorIndigo", triplet: "67 56 202", hex: "#4338ca" }, // indigo-700
  { nameKey: "settings.appearance.colorViolet", triplet: "124 58 237", hex: "#7c3aed" }, // violet-600
  { nameKey: "settings.appearance.colorRose", triplet: "225 29 72", hex: "#e11d48" }, // rose-600
  { nameKey: "settings.appearance.colorAmber", triplet: "217 119 6", hex: "#d97706" }, // amber-600
];

/** Curated accent presets. `triplet` is what we persist; `hex` drives the swatch.
 *  The first entry (emerald) is the default and stays saturated for brand
 *  identity; the rest are softened tints (lifted lightness, middling
 *  saturation) so they read as calm chips instead of glaring ones — kinder on
 *  the eyes in dark mode. Trade-off: very soft accents reduce white-on-accent
 *  legibility on filled buttons (those prefer a darker accent). */
const ACCENT_PRESETS: { nameKey: MessageId; triplet: string; hex: string }[] = [
  { nameKey: "settings.appearance.colorEmerald", triplet: "5 150 105", hex: "#059669" }, // emerald-600 (default, kept saturated)
  { nameKey: "settings.appearance.colorSky", triplet: "111 182 224", hex: "#6fb6e0" }, // soft sky
  { nameKey: "settings.appearance.colorIndigo", triplet: "139 151 232", hex: "#8b97e8" }, // soft indigo
  { nameKey: "settings.appearance.colorTeal", triplet: "94 200 184", hex: "#5ec8b8" }, // soft teal
  { nameKey: "settings.appearance.colorViolet", triplet: "184 156 230", hex: "#b89ce6" }, // soft violet
  { nameKey: "settings.appearance.colorPink", triplet: "244 168 168", hex: "#f4a8a8" }, // soft rose
  { nameKey: "settings.appearance.colorAmber", triplet: "243 201 105", hex: "#f3c969" }, // soft amber
  { nameKey: "settings.appearance.colorOrange", triplet: "246 165 107", hex: "#f6a56b" }, // soft orange
];

const THEME_OPTIONS: { value: ThemeName; labelKey: MessageId; icon: ReactNode }[] = [
  { value: "light", labelKey: "settings.appearance.themeLight", icon: <IconSun size={14} className="text-content-muted" /> },
  { value: "dark", labelKey: "settings.appearance.themeDark", icon: <IconMoon size={14} className="text-content-muted" /> },
  { value: "system", labelKey: "settings.appearance.themeSystem", icon: <IconDeviceDesktop size={14} className="text-content-muted" /> },
];

/** Mini preview strip for an editor scheme: the scheme's editor-background
 *  square followed by its four headline token colors (keyword / string /
 *  number / comment) so the picker communicates the palette at a glance. */
function SchemeSwatch({ swatch }: { swatch: (ReturnType<typeof editorThemePresetsForMode>)[number]["swatch"] }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1" aria-hidden>
      <span
        className="h-3 w-4 rounded-[3px] border border-edge"
        style={{ backgroundColor: swatch.background }}
      />
      {[swatch.keyword, swatch.string, swatch.number, swatch.comment].map((c) => (
        <span key={c} className="h-2 w-2 rounded-full" style={{ backgroundColor: c }} />
      ))}
    </span>
  );
}

/** One editor color-scheme Select, bound to the store's per-mode choice.
 *  Options come from lib/editorThemes.ts; picking one re-themes every
 *  mounted Monaco instance live (useMonacoTheme subscribes to the store). */
function EditorSchemeSelect({ mode, id }: { mode: "dark" | "light"; id: string }) {
  const { t } = useI18n();
  const value = useSessionStore((s) =>
    mode === "dark" ? s.editorTheme.dark : s.editorTheme.light,
  );
  const setEditorTheme = useSessionStore((s) => s.setEditorTheme);
  const presets = editorThemePresetsForMode(mode);
  return (
    <Select.Root
      value={value}
      onValueChange={(v) => void setEditorTheme(mode, v as (typeof presets)[number]["id"])}
    >
      <Select.Trigger id={id} className="w-full">
        <Select.Value>
          {(val: string) => {
            const p = presets.find((x) => x.id === val) ?? presets[0];
            return (
              <span className="flex items-center gap-1.5">
                <SchemeSwatch swatch={p.swatch} />
                {t(p.labelKey)}
              </span>
            );
          }}
        </Select.Value>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner>
          <Select.Popup>
            <Select.List>
              {presets.map((p) => (
                <Select.Item key={p.id} value={p.id}>
                  <SchemeSwatch swatch={p.swatch} />
                  <Select.ItemText>{t(p.labelKey)}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}

export function AppearancePanel() {
  const { t } = useI18n();
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

  const effectiveLabel = t(effective === "dark" ? "settings.appearance.themeDark" : "settings.appearance.themeLight");

  return (
    <section className="mx-auto w-full max-w-3xl space-y-4">
      <PanelHeader
        title={t("settings.appearance.title")}
      />

      {/* ── 主题与颜色 ── */}
      <SettingsSection title={t("settings.appearance.sectionThemeColor")}>
        {/* ── Theme ── */}
        <SettingRow
          title={t("settings.appearance.theme")}
          desc={
            <>
              {t("settings.appearance.themeDesc")}
              {theme === "system" && (
                <span className="text-content-muted">
                  {t("settings.appearance.currentTheme", { theme: effectiveLabel })}
                </span>
              )}
            </>
          }
          htmlFor="setting-theme"
        >
          <Select.Root
            value={theme}
            onValueChange={(v) => void api.theme.set({ theme: v as ThemeName })}
          >
            <Select.Trigger id="setting-theme" className="w-full">
              <Select.Value>
                {(val: ThemeName) => {
                  const o =
                    THEME_OPTIONS.find((x) => x.value === val) ??
                    THEME_OPTIONS[0];
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
                    {THEME_OPTIONS.map((o) => (
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

        {/* ── Editor color scheme (one pick per app theme) ── */}
        <SettingRow
          title={t("settings.appearance.editorThemeDark")}
          desc={t("settings.appearance.editorThemeDesc")}
          htmlFor="setting-editor-theme-dark"
        >
          <EditorSchemeSelect mode="dark" id="setting-editor-theme-dark" />
        </SettingRow>
        <SettingRow
          title={t("settings.appearance.editorThemeLight")}
          htmlFor="setting-editor-theme-light"
        >
          <EditorSchemeSelect mode="light" id="setting-editor-theme-light" />
        </SettingRow>

        {/* ── User message background color ── */}
        <SettingRow
          layout="vertical"
          title={t("settings.appearance.userColor")}
          desc={
            userMessageColor
              ? t("settings.appearance.userColorCustom", { hex: userColorHex.toUpperCase() })
              : t("settings.appearance.userColorDefault")
          }
          descExtra={
            <span className="text-[0.7143em] text-content-subtle">
              {t("settings.appearance.userColorDescExtra")}
            </span>
          }
        >
          {/* Preset swatches — full-row row (palettes don't fit the fixed
              control slot) */}
          <div className="flex flex-wrap items-center gap-1.5">
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
                  title={`${t(p.nameKey)} · ${p.hex.toUpperCase()}`}
                  aria-label={t("settings.appearance.pickColor", { name: t(p.nameKey) })}
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
              title={t("settings.appearance.userColorResetTitle")}
              className="gap-1 px-1.5"
            >
              <IconRefresh size={11} />
              {t("settings.appearance.resetDefault")}
            </Button>
          </div>
        </SettingRow>

        {/* ── Accent color ── */}
        <SettingRow
          layout="vertical"
          title={t("settings.appearance.accentColor")}
          desc={
            accentColor
              ? t("settings.appearance.accentColorCustom", { hex: accentHex.toUpperCase() })
              : t("settings.appearance.accentColorDefault")
          }
          descExtra={
            <span className="text-[0.7143em] text-content-subtle">
              {t("settings.appearance.accentColorDescExtra")}
            </span>
          }
        >
          {/* Preset swatches — full-row row (palettes don't fit the fixed
              control slot) */}
          <div className="flex flex-wrap items-center gap-1.5">
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
                  title={`${t(p.nameKey)} · ${p.hex.toUpperCase()}`}
                  aria-label={t("settings.appearance.pickColor", { name: t(p.nameKey) })}
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
              title={t("settings.appearance.accentColorResetTitle")}
              className="gap-1 px-1.5"
            >
              <IconRefresh size={11} />
              {t("settings.appearance.resetDefault")}
            </Button>
          </div>
        </SettingRow>
      </SettingsSection>

      {/* ── 字号 ── */}
      <SettingsSection title={t("settings.appearance.sectionFontSize")}>
        {/* ── Global font size (left bar + right panel + settings) ── */}
        <SettingRow
          title={t("settings.appearance.globalFontSize")}
          desc={t("settings.appearance.globalFontSizeDesc", {
            min: RIGHT_PANEL_FONT_SIZE_MIN,
            max: RIGHT_PANEL_FONT_SIZE_MAX,
          })}
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
          title={t("settings.appearance.chatFontSize")}
          desc={t("settings.appearance.chatFontSizeDesc", {
            min: CHAT_FONT_SIZE_MIN,
            max: CHAT_FONT_SIZE_MAX,
          })}
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
      </SettingsSection>

      <p className="pt-1 text-[0.7143em] text-content-subtle">
        {t("settings.appearance.footer")}
      </p>
    </section>
  );
}
