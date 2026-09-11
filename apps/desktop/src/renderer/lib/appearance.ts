import { useEffect } from "react";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { applyThemeStyle } from "@renderer/lib/theme.js";
import type { ChatDensity } from "@contracts/ipc";

/**
 * Runtime application of user-configurable appearance settings.
 *
 * The settings (font size, user-message bg color, global accent color, chat
 * density) live in the session store (hydrated from the `settings` SQLite
 * table). This module mirrors them onto <html> so they cascade into the
 * rendering without per-component plumbing:
 *
 *   --chat-font-size : consumed by `[font-size:var(--chat-font-size)]`
 *                       classes in ChatPane + Markdown.
 *   --user-bubble    : an "R G B" triplet consumed by the `userBubble`
 *                       Tailwind color token (composes `/10` alpha).
 *   --accent         : an "R G B" triplet consumed by the `accent` Tailwind
 *                       color token — the global emphasis color (buttons,
 *                       links, selected states, focus rings, prompt-card
 *                       accents). Composes `/10`, `/15`, `/60` etc. alpha.
 *   data-chat-density: a `<html>` attribute ("compact"|"comfortable"|"cozy")
 *                       consumed by styles.css attribute selectors to set the
 *                       three density vars (--chat-row-gap-assistant /
 *                       --chat-row-gap-user / --chat-block-gap) that drive
 *                       message-stream vertical rhythm.
 *
 * Static fallbacks for the color/font vars live in styles.css (:root + .dark);
 * when the user has NOT customized a value we REMOVE the inline property so
 * the stylesheet default re-asserts (and correctly differs between light/
 * dark — e.g. --accent is emerald-600 in light, emerald-500 in dark). The
 * density fallback ("comfortable") is handled in styles.css via the same
 * attribute selector so an unset value still resolves.
 *
 * This is the project's first runtime CSS-variable write; lib/theme.ts's
 * `applyThemeClass` is the closest precedent (DOM mutation on <html>).
 */

/** Stylesheet default for both font-size vars (styles.css :root/.dark).
 *  When the store value equals it we REMOVE the inline property instead of
 *  writing it, so a theme-scoped stylesheet default can differ — html.sketch
 *  raises the base to 15px for the handwriting face (kaiti smears below
 *  ~13px). An explicit user choice still wins via the inline write. */
const DEFAULT_FONT_SIZE_PX = 14;

/** Write the chat font size as `--chat-font-size` on <html>. */
export function applyChatFontSize(px: number): void {
  if (px === DEFAULT_FONT_SIZE_PX) {
    document.documentElement.style.removeProperty("--chat-font-size");
  } else {
    document.documentElement.style.setProperty("--chat-font-size", `${px}px`);
  }
}

/** Set the message-stream density by writing `data-chat-density` on <html>.
 *  styles.css holds the three per-density variable maps
 *  (--chat-row-gap-assistant / --chat-row-gap-user / --chat-block-gap); this
 *  attribute is the switch. The "comfortable" default is mirrored in
 *  styles.css as the :root fallback so an unset attribute still resolves. */
export function applyChatDensity(mode: ChatDensity): void {
  document.documentElement.setAttribute("data-chat-density", mode);
}

/** Write the global side-panel + settings base font size as
 *  `--right-panel-font-size` on <html>. Despite the var's legacy name, this
 *  is the app-chrome font size: the left project bar, the right files/git/
 *  terminal panels, AND the settings page all inherit it. The derived
 *  `--rp-fs-sm/xs/xxs` variants (defined in styles.css via calc) track this
 *  automatically. Also mirrored into the xterm terminal fontSize directly
 *  from the store (see TerminalView). */
export function applyRightPanelFontSize(px: number): void {
  if (px === DEFAULT_FONT_SIZE_PX) {
    document.documentElement.style.removeProperty("--right-panel-font-size");
  } else {
    document.documentElement.style.setProperty("--right-panel-font-size", `${px}px`);
  }
}

/** Write the user-message bg color (R G B triplet) as `--user-bubble` on
 *  <html>. Pass null to remove the override and fall back to the theme
 *  default defined in styles.css. */
export function applyUserBubbleColor(rgbTriplet: string | null): void {
  if (rgbTriplet) {
    document.documentElement.style.setProperty("--user-bubble", rgbTriplet);
  } else {
    document.documentElement.style.removeProperty("--user-bubble");
  }
}

/** Write the global brand/accent color (R G B triplet) as `--accent` on
 *  <html>. Pass null to remove the override and fall back to the per-theme
 *  default defined in styles.css (emerald-600 light / emerald-500 dark). */
export function applyAccentColor(rgbTriplet: string | null): void {
  if (rgbTriplet) {
    document.documentElement.style.setProperty("--accent", rgbTriplet);
  } else {
    document.documentElement.style.removeProperty("--accent");
  }
}

/**
 * Keep the appearance CSS vars in sync with the session store. Mount once at
 * the app root (alongside useTheme). Re-runs whenever a store value changes
 * (user dragged the slider / picked a color / switched density in Settings),
 * re-applying each var idempotently.
 */
export function useChatAppearance(): void {
  const chatFontSize = useSessionStore((s) => s.chatFontSize);
  const userMessageColor = useSessionStore((s) => s.userMessageColor);
  const accentColor = useSessionStore((s) => s.accentColor);
  const chatDensity = useSessionStore((s) => s.chatDensity);

  useEffect(() => {
    applyChatFontSize(chatFontSize);
  }, [chatFontSize]);

  useEffect(() => {
    applyUserBubbleColor(userMessageColor);
  }, [userMessageColor]);

  useEffect(() => {
    applyAccentColor(accentColor);
  }, [accentColor]);

  useEffect(() => {
    applyChatDensity(chatDensity);
  }, [chatDensity]);
}

/**
 * Keep the global side-panel + settings font-size CSS var in sync with the
 * session store. Mount once at the app root (alongside useChatAppearance).
 * Re-runs whenever the store value changes (user dragged the stepper in
 * Settings), re-applying the var idempotently. The derived --rp-fs-* variants
 * (calc'd in styles.css) track this base automatically; the settings page
 * inherits the base via an inline fontSize on its container.
 *
 * The xterm terminal consumes the store value directly (not the CSS var)
 * since its fontSize is a JS option, not a style - see TerminalView.
 */
export function useRightPanelAppearance(): void {
  const rightPanelFontSize = useSessionStore((s) => s.rightPanelFontSize);

  useEffect(() => {
    applyRightPanelFontSize(rightPanelFontSize);
  }, [rightPanelFontSize]);
}

/**
 * Keep the `.sketch` class on <html> in sync with the session store's
 * themeStyle (settings key ui.themeStyle, hydrated in the first-paint batch).
 * Mount once at the app root. The boot-time FOUC guard (lib/theme.ts) has
 * already applied the localStorage-cached value before React mounts; this
 * reconciles against the SQLite source of truth once it lands.
 */
export function useThemeStyle(): void {
  const themeStyle = useSessionStore((s) => s.themeStyle);

  useEffect(() => {
    applyThemeStyle(themeStyle);
  }, [themeStyle]);
}
