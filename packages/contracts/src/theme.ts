/**
 * Theme / color-scheme domain types.
 *
 * `ThemeName` is the user's *preference* (what they picked in Settings); it
 * may be "system", which resolves at runtime to either dark or light based on
 * the OS. `EffectiveTheme` is that resolved value — what's actually rendering.
 */

/** User-selectable theme preference. */
export type ThemeName = "dark" | "light" | "system";

/** The theme currently in effect (system resolved down to one of these). */
export type EffectiveTheme = "dark" | "light";

/**
 * UI theme STYLE — a dimension ORTHOGONAL to the light/dark scheme above.
 * "classic" is the stock chrome; "sketch" applies the paper-sketch theme
 * (暖纸底 + 墨线 + 手写字体 + 图标抖动, prototypes/theme-sketch-redesign.html).
 * The renderer mirrors it as a `.sketch` class on <html> (alongside `.dark`);
 * main's nativeTheme is unaware of it. Persisted as `ui.themeStyle` via the
 * generic setting.get/set IPC — no dedicated theme module involved.
 */
export type ThemeStyle = "classic" | "sketch";

/** Payload of the theme.changed push event (main → renderer). */
export interface ThemeChangedMessage {
  /** Push channel discriminator — distinguishes this from claude/terminal events. */
  channel: "theme:changed";
  /** The user's persisted preference. */
  theme: ThemeName;
  /** What's actually rendering right now (system resolved). */
  effective: EffectiveTheme;
}
