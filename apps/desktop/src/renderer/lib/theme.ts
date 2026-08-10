import { useEffect, useState } from "react";
import { api } from "@renderer/lib/api.js";
import type { ThemeName, EffectiveTheme } from "@contracts/theme";

/**
 * Toggle the `.dark` class on <html>, which (with `darkMode: 'class'` in the
 * Tailwind config) is what actually re-themes the UI. Exposed for the FOUC
 * guard below and for useTheme() to keep the class in sync.
 *
 * When the effective theme actually flips, the `theme-transition` flag is
 * stamped on <html> for ~260ms so styles.css animates the whole chrome
 * between palettes (backgrounds/borders/text fade instead of hard-cutting);
 * the flag is removed afterwards so element-level hover transitions return
 * to their normal timing. No-ops when the theme didn't change (e.g. the FOUC
 * guard already applied the right class at startup) — that keeps the first
 * paint transition-free.
 */
const THEME_TRANSITION_MS = 260;

export function applyThemeClass(effective: EffectiveTheme): void {
  const root = document.documentElement;
  const wasDark = root.classList.contains("dark");
  const isDark = effective === "dark";
  if (wasDark === isDark) return;
  root.classList.add("theme-transition");
  if (isDark) root.classList.add("dark");
  else root.classList.remove("dark");
  window.setTimeout(() => root.classList.remove("theme-transition"), THEME_TRANSITION_MS);
}

/**
 * FOUC guard: apply the initial `.dark` class to <html> BEFORE React mounts,
 * so the first painted frame matches the OS theme preference. Call this once
 * at the top of main.tsx (synchronously, before createRoot).
 *
 * We can't read the persisted SQLite preference here (preload/IPC aren't ready
 * yet), so we fall back to the OS `prefers-color-scheme` media query - which
 * matches the default "system" theme. The main process has already set
 * `nativeTheme.themeSource` from the persisted preference during `whenReady`,
 * so under Electron this media query reflects the *resolved* theme, not just
 * the raw OS setting. useTheme() corrects the class the moment it loads the
 * real preference.
 *
 * Lives in an external ESM module (not an inline <script>) so it passes the
 * production CSP `script-src 'self'`.
 */
export function initFoucGuard(): void {
  try {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    applyThemeClass(prefersDark ? "dark" : "light");
  } catch {
    // matchMedia unavailable - leave default (light); useTheme() will fix up.
  }
}

export interface ThemeState {
  /** The user's persisted preference. */
  theme: ThemeName;
  /** What's actually rendering (system resolved). */
  effective: EffectiveTheme;
}

/**
 * Subscribe to the theme: load the current preference on mount, keep the
 * `.dark` class in sync, and re-apply whenever the effective theme changes
 * (user picked a new one in settings, or the OS switched in 'system' mode).
 *
 * Mount once at the app root (App.tsx). Returns the current state so the
 * appearance panel can render its radio selection.
 */
export function useTheme(): ThemeState {
  const [state, setState] = useState<ThemeState>({ theme: "system", effective: "dark" });

  useEffect(() => {
    let cancelled = false;
    // Initial load: ask main for the persisted preference + effective value.
    void api.theme.get().then((s) => {
      if (cancelled) return;
      setState(s);
      applyThemeClass(s.effective);
    });
    // Live updates: main pushes theme.changed when the user picks a new theme
    // OR when the OS theme changes while in 'system' mode.
    const off = api.on.themeChanged((msg) => {
      setState({ theme: msg.theme, effective: msg.effective });
      applyThemeClass(msg.effective);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  return state;
}
