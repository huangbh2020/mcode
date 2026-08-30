import { useState } from "react";
import { Menu } from "@base-ui/react/menu";
import { cn } from "@renderer/lib/cn.js";
import { IconCheck, IconBolt, IconChevronDown, IconChevronRight } from "@renderer/lib/icons.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useSuppressBrowserView } from "@renderer/hooks/useSuppressBrowserView.js";
import { useNarrowViewport } from "@renderer/hooks/useNarrowViewport.js";

/**
 * Reasoning-effort / thinking-level picker for the composer toolbar.
 *
 * The level list is NOT hardcoded here — it comes from the active provider's
 * `capabilities.thinkingLevels` declaration, so a third provider needs zero
 * UI changes to expose its own levels (claude: 6, pi: 8 incl. off/minimal).
 *
 * When the active provider declares no thinking levels (empty/undefined), the
 * chip is hidden entirely (`null`).
 *
 * Uses @base-ui/react Menu like PermissionModeDropdown; the popup renders
 * through Menu.Portal so it isn't clipped by the composer card's overflow.
 *
 * Presentation: layout="chip" (default) renders the compact composer chip;
 * layout="row" (the collapsed-toolbar popup) renders a full-width settings
 * row — icon + label on the left, current level + chevron on the right — and
 * opens the menu to the RIGHT of the row so the popup's vertical list stays
 * visible; on phone-class viewports (no room for panel + menu side by side)
 * it opens upward instead, where the tall screen has plenty of space.
 */

/** Fallback label when the current value isn't in the provider's level list
 *  (e.g. a persisted value for a provider that no longer declares it). */
function labelFor(levels: { value: string; label: string }[] | undefined, value: string): string {
  return levels?.find((l) => l.value === value)?.label ?? value;
}

/** Hint i18n keys by level value. The provider's capabilities carry the zh
 *  hints as data (declared in main, not localizable there); we resolve the
 *  known levels through the dictionary at render time and fall back to the
 *  provider-declared hint for unknown/future values. Labels (Auto/Low/…) are
 *  intentionally locale-neutral and stay as declared. */
const EFFORT_HINT_KEYS: Record<string, MessageId> = {
  default: "chat.effort.hintDefault",
  off: "chat.effort.hintOff",
  minimal: "chat.effort.hintMinimal",
  low: "chat.effort.hintLow",
  medium: "chat.effort.hintMedium",
  high: "chat.effort.hintHigh",
  xhigh: "chat.effort.hintXhigh",
  max: "chat.effort.hintMax",
};

export function EffortDropdown({
  layout = "chip",
}: {
  /** Presentation: composer chip ("chip") vs settings row ("row"). */
  layout?: "chip" | "row";
}) {
  const stacked = layout === "row";
  // Stacked rows cascade to the RIGHT; phone-class viewports have no room
  // for panel + menu side by side, so they open upward instead (vertical
  // space is plentiful there). Chip mode always opens upward.
  const cascade = stacked && !useNarrowViewport();
  const { t } = useI18n();
  // While the menu is open the embedded browser view is suppressed so the
  // portaled popup (which can extend over the browser's rect in narrow/wide
  // layouts) stays visible and clickable. See useSuppressBrowserView.
  const [open, setOpen] = useState(false);
  useSuppressBrowserView(open);
  const effort = useSessionStore((s) => s.effort);
  const setEffort = useSessionStore((s) => s.setEffort);
  const providerId = useSessionStore((s) => s.providerId);
  const providers = useSessionStore((s) => s.providers);

  // The active provider's declared thinking levels. Unknown provider id
  // (providers still loading) falls back to the current claude-sdk provider
  // being the default — but we only hide when the resolved provider explicitly
  // declares none.
  const provider = providers.find((p) => p.id === providerId);
  const levels = provider?.capabilities.thinkingLevels;

  // Provider declares no thinking levels → hide the chip.
  if (!levels || levels.length === 0) return null;

  return (
    <Menu.Root open={open} onOpenChange={setOpen}>
      <Menu.Trigger
        className={cn(
          stacked
            ? "flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-[13px] outline-none select-none transition-colors duration-100"
            : "composer-chip flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition-all duration-150 ease-out",
          stacked
            ? "text-content-muted hover:bg-surface-muted hover:text-content"
            : "text-content-muted hover:scale-105 hover:bg-accent/10 hover:text-accent active:scale-95",
        )}
        title="Reasoning effort for the next session"
      >
        {stacked ? (
          <>
            <span className="flex min-w-0 items-center gap-2">
              <IconBolt size={14} className="shrink-0 opacity-80" />
              <span className="shrink-0 font-medium text-content">{t("chat.effort.rowLabel")}</span>
            </span>
            <span className="flex min-w-0 items-center gap-1">
              <span className="min-w-0 truncate text-xs text-content-muted">
                {labelFor(levels, effort)}
              </span>
              <IconChevronRight size={12} className="shrink-0 opacity-60" />
            </span>
          </>
        ) : (
          <>
            <IconBolt size={13} className="shrink-0 opacity-80" />
            <span className="min-w-0 truncate">{labelFor(levels, effort)}</span>
            <IconChevronDown size={11} className="shrink-0 opacity-60" />
          </>
        )}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner
          side={cascade ? "right" : "top"}
          align="start"
          sideOffset={cascade ? 6 : 0}
        >
          <Menu.Popup
            className={cn(
              "z-50 min-w-[240px] rounded-lg border border-edge bg-surface py-1.5 shadow-2xl",
              cascade ? "origin-top-left" : "origin-bottom-left",
              "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
              "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
              "transition-[transform,opacity] duration-100",
            )}
          >
            <div className="px-3 py-1 text-xs uppercase tracking-wide text-content-subtle">
              {t("chat.effort.section")}
            </div>
            {levels.map((m) => {
              const active = m.value === effort;
              const hintKey = EFFORT_HINT_KEYS[m.value];
              const hint = hintKey
                ? t(hintKey, { provider: provider?.displayName ?? "" })
                : m.hint;
              return (
                <Menu.Item
                  key={m.value}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[13px] outline-none select-none",
                    "data-[highlighted]:bg-surface-muted",
                    active ? "text-accent" : "text-content-muted",
                  )}
                  onClick={() => setEffort(m.value)}
                >
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="font-medium">{m.label}</span>
                    <span className="truncate text-xs text-content-subtle">{hint}</span>
                  </span>
                  {active && <IconCheck size={14} className="shrink-0" />}
                </Menu.Item>
              );
            })}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
