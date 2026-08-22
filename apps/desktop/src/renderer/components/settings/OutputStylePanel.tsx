import { useCallback, useEffect, useState } from "react";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { cn } from "@renderer/lib/cn.js";
import { api } from "@renderer/lib/api.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import { Select } from "@renderer/components/ui/index.js";
import { IconRefresh } from "@renderer/lib/icons.js";
import type { OutputStyleEntry } from "@contracts/ipc";
import { SettingRow } from "./SettingRow.js";
import { SettingsSection } from "./SettingsSection.js";

/** Builtin style ids that have a localized label + description. Any other
 *  builtin id the server ever adds renders with the raw id instead of
 *  crashing the panel (forward compatibility). */
const BUILTIN_LABEL_KEYS: Record<string, MessageId> = {
  default: "settings.outputStyle.style.default",
  Explanatory: "settings.outputStyle.style.Explanatory",
  Learning: "settings.outputStyle.style.Learning",
  Proactive: "settings.outputStyle.style.Proactive",
  Concise: "settings.outputStyle.style.Concise",
};
const BUILTIN_DESC_KEYS: Record<string, MessageId> = {
  default: "settings.outputStyle.builtinDesc.default",
  Explanatory: "settings.outputStyle.builtinDesc.Explanatory",
  Learning: "settings.outputStyle.builtinDesc.Learning",
  Proactive: "settings.outputStyle.builtinDesc.Proactive",
  Concise: "settings.outputStyle.builtinDesc.Concise",
};

/** Label for one style entry: localized name for builtins, verbatim name for
 *  customs. The stored selection may reference a style that no longer exists
 *  (e.g. a deleted custom file) — the trigger then shows the raw name so the
 *  stale value stays visible until the user re-picks. */
function styleLabel(entry: OutputStyleEntry, t: (key: MessageId) => string): string {
  if (entry.source === "builtin") {
    const key = BUILTIN_LABEL_KEYS[entry.id];
    return key ? t(key) : entry.id;
  }
  return entry.id;
}

/**
 * Output-style settings (Claude sessions).
 *
 * One control: a Select over built-in styles (availability gated by the
 * bundled CLI version, server-side) plus user styles scanned from
 * ~/.mcode/output-styles/*.md. The selection persists under
 * AGENT_OUTPUT_STYLE_SETTING_KEY via the store action and is injected into
 * options.settings by the Claude provider on every NEW turn — the SDK has no
 * runtime switch API, so a change cannot reshape an already-running turn.
 *
 * Renders as its own SettingsSection so it slots into GeneralPanel as a
 * sibling of TitleGenPanel.
 */
export function OutputStylePanel() {
  const { t } = useI18n();
  const outputStyle = useSessionStore((s) => s.outputStyle);
  const setOutputStyle = useSessionStore((s) => s.setOutputStyle);

  const [styles, setStyles] = useState<OutputStyleEntry[] | null>(null);
  const [loadError, setLoadError] = useState(false);

  const refresh = useCallback(() => {
    setLoadError(false);
    api.outputStyle
      .list({})
      .then((res) => setStyles(res.styles))
      .catch((err) => {
        console.error("outputStyle.list failed:", err);
        setLoadError(true);
      });
  }, []);

  useEffect(refresh, [refresh]);

  const builtin = (styles ?? []).filter((s) => s.source === "builtin");
  const user = (styles ?? []).filter((s) => s.source === "user");
  // null store value = never configured → display Default without persisting
  // anything (keeps untouched installs byte-identical to before this panel).
  const selected = outputStyle ?? "default";
  const selectedKnown =
    styles?.some((s) => s.id === selected) === true || selected === "default";

  const renderRow = (entry: OutputStyleEntry) => {
    const desc =
      entry.source === "builtin"
        ? BUILTIN_DESC_KEYS[entry.id]
          ? t(BUILTIN_DESC_KEYS[entry.id])
          : undefined
        : entry.description;
    return (
      <Select.Item key={`${entry.source}:${entry.id}`} value={entry.id}>
        <Select.ItemText>{styleLabel(entry, t)}</Select.ItemText>
        {desc ? (
          <span className="ml-auto max-w-[280px] truncate text-[0.7857em] text-content-subtle" title={desc}>
            {desc}
          </span>
        ) : null}
      </Select.Item>
    );
  };

  return (
    <SettingsSection
      title={t("settings.outputStyle.sectionTitle")}
      desc={t("settings.outputStyle.sectionDesc")}
    >
      <SettingRow
        title={t("settings.outputStyle.select")}
        desc={t("settings.outputStyle.selectDesc")}
        htmlFor="setting-output-style"
      >
        <div className="flex items-center gap-2">
          <Select.Root
            value={selected}
            onValueChange={(v) => setOutputStyle((v as string) ?? null)}
          >
            <Select.Trigger id="setting-output-style" className="min-w-[220px]">
              <Select.Value>
                {(val: string | null) => (
                  <span
                    className={cn(
                      "flex items-center gap-1.5",
                      val === "default" && "text-content-subtle",
                    )}
                  >
                    {val === "default"
                      ? t("settings.outputStyle.style.default")
                      : val ?? t("settings.outputStyle.style.default")}
                    {!selectedKnown && val ? (
                      <span className="text-[0.7857em] text-danger">
                        ({t("settings.outputStyle.stale")})
                      </span>
                    ) : null}
                  </span>
                )}
              </Select.Value>
            </Select.Trigger>
            <Select.Portal>
              <Select.Positioner>
                <Select.Popup>
                  <Select.List>
                    {builtin.length > 0 ? (
                      <Select.Group>
                        <Select.GroupLabel className="text-content-subtle">
                          {t("settings.outputStyle.groupBuiltin")}
                        </Select.GroupLabel>
                        {builtin.map(renderRow)}
                      </Select.Group>
                    ) : null}
                    {user.length > 0 ? (
                      <Select.Group>
                        <Select.GroupLabel className="text-content-subtle">
                          {t("settings.outputStyle.groupUser")}
                        </Select.GroupLabel>
                        {user.map(renderRow)}
                      </Select.Group>
                    ) : null}
                  </Select.List>
                </Select.Popup>
              </Select.Positioner>
            </Select.Portal>
          </Select.Root>
          <button
            type="button"
            onClick={refresh}
            title={t("settings.outputStyle.refresh")}
            aria-label={t("settings.outputStyle.refresh")}
            className={cn(
              "flex shrink-0 items-center justify-center rounded p-0.5 transition-colors",
              "text-content-subtle hover:bg-surface-hover hover:text-content",
            )}
          >
            <IconRefresh size={14} />
          </button>
        </div>
      </SettingRow>
      {loadError ? (
        <p className="text-[0.7857em] text-danger">{t("settings.outputStyle.loadFailed")}</p>
      ) : null}
    </SettingsSection>
  );
}
