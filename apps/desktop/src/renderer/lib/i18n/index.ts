import { useCallback } from "react";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { translate, type MessageId } from "./core.js";

export { translate, type MessageId } from "./core.js";

/**
 * Locale-bound translator for React components.
 *
 * Subscribes to the store's `locale` slice, so every component calling this
 * hook re-renders the moment the language preference flips — switching
 * languages takes effect live, without a restart or a keyed remount.
 *
 * Usage:
 *   const { t } = useI18n();
 *   <PanelHeader title={t("settings.nav.general")} />
 *   t("common.dayCount", { n: 7 })  // "7 天" / "7 days"
 */
export function useI18n() {
  const locale = useSessionStore((s) => s.locale);
  const t = useCallback(
    (key: MessageId, params?: Record<string, string | number>) =>
      translate(locale, key, params),
    [locale],
  );
  return { locale, t };
}
