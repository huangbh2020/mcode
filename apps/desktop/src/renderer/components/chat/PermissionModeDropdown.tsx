import { useState } from "react";
import { Menu } from "@base-ui/react/menu";
import { cn } from "@renderer/lib/cn.js";
import {
  IconCheck,
  IconShield,
  IconShieldCheck,
  IconShieldHalfFilled,
  IconShieldLock,
  IconChevronDown,
} from "@renderer/lib/icons.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useSuppressBrowserView } from "@renderer/hooks/useSuppressBrowserView.js";
import type { PermissionModeOption } from "@contracts/provider";

/**
 * Permission-mode picker for the composer toolbar.
 *
 * The mode list is NOT hardcoded here — it comes from the active provider's
 * `capabilities.permissionModes` declaration. Both Claude and Pi declare the
 * same 4 user-facing modes (default / acceptEdits / plan / bypassPermissions)
 * with matching icons/colors; Pi interprets them at runtime via its inline
 * extension's tool_call handler (see mcodeExtension.ts). Providers that
 * declare no modes (empty/undefined) hide the chip entirely.
 *
 * Icon names in the declaration ("shield", "shieldCheck", ...) are resolved
 * here so the renderer's icon map stays the single source of truth — the
 * contract only carries a string name, never a component.
 *
 * Uses @base-ui/react Menu for state management, keyboard navigation,
 * and positioning, with a compact chip-style trigger.
 */

const ICON_BY_NAME: Record<string, React.ReactNode> = {
  shield: <IconShield size={11} />,
  shieldCheck: <IconShieldCheck size={11} />,
  shieldHalf: <IconShieldHalfFilled size={11} />,
  shieldLock: <IconShieldLock size={11} />,
};

/** Fallback label used when the current value isn't in the provider's list
 *  (e.g. dontAsk/auto persisted for claude sessions, or unknown values). */
const FALLBACK_LABEL: Record<string, string> = {
  default: "Default",
  acceptEdits: "Edit Auto",
  plan: "Plan",
  bypassPermissions: "Bypass",
  dontAsk: "DontAsk",
  auto: "Auto",
};

/** Hint i18n keys by mode value. The provider's capabilities carry the zh
 *  hints as data (declared in main, identical for claude + pi); resolve known
 *  modes through the dictionary at render time and fall back to the declared
 *  hint for unknown/future values. Labels (Default/Plan/…) are intentionally
 *  locale-neutral and stay as declared. */
const PERMISSION_HINT_KEYS: Record<string, MessageId> = {
  default: "chat.permission.hintDefault",
  acceptEdits: "chat.permission.hintAcceptEdits",
  plan: "chat.permission.hintPlan",
  bypassPermissions: "chat.permission.hintBypass",
};

export function PermissionModeDropdown() {
  const { t } = useI18n();
  // While the menu is open the embedded browser view is suppressed so the
  // portaled popup stays visible/clickable when it extends over the browser.
  const [open, setOpen] = useState(false);
  useSuppressBrowserView(open);
  const permissionMode = useSessionStore((s) => s.permissionMode);
  const setPermissionMode = useSessionStore((s) => s.setPermissionMode);
  const providerId = useSessionStore((s) => s.providerId);
  const providers = useSessionStore((s) => s.providers);

  const provider = providers.find((p) => p.id === providerId);
  const modes = provider?.capabilities.permissionModes;

  // Provider declares no permission modes → hide the chip.
  if (!modes || modes.length === 0) return null;

  const activeMeta = modes.find((m) => m.value === permissionMode);
  const chipLabel = activeMeta?.label ?? FALLBACK_LABEL[permissionMode] ?? permissionMode;
  const chipIcon = activeMeta ? resolveIcon(activeMeta) : <IconShield size={11} />;
  // Mode-specific color (info / warning / danger); empty for the baseline
  // "default" mode so it inherits the chip's neutral muted text.
  const modeColor = activeMeta?.color ?? "";

  return (
    <Menu.Root open={open} onOpenChange={setOpen}>
      <Menu.Trigger
        className={cn(
          "composer-chip flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition-all duration-150 ease-out",
          "text-content-muted hover:scale-105 hover:bg-accent/10 active:scale-95",
          // Only switch the label to accent on hover for the neutral mode —
          // riskier modes (warning/danger) keep their semantic color so the
          // chip never loses its risk telegraph.
          !modeColor && "hover:text-accent",
          modeColor,
        )}
        title="Permission mode for the next session"
      >
        <span className="shrink-0 opacity-90">{chipIcon}</span>
        <span className="min-w-0 truncate">{chipLabel}</span>
        <IconChevronDown size={11} className="shrink-0 opacity-60" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="top" align="start">
          <Menu.Popup
            className={cn(
              "z-50 min-w-[260px] origin-bottom-left rounded-lg border border-edge bg-surface py-1.5 shadow-2xl",
              "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
              "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
              "transition-[transform,opacity] duration-100",
            )}
          >
            <div className="px-3 py-1 text-xs uppercase tracking-wide text-content-subtle">
              {t("chat.permission.section")}
            </div>
            {modes.map((m) => {
              const active = m.value === permissionMode;
              const hintKey = PERMISSION_HINT_KEYS[m.value];
              return (
                <Menu.Item
                  key={m.value}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[13px] outline-none select-none",
                    "data-[highlighted]:bg-surface-muted",
                    active ? "text-accent" : "text-content-muted",
                  )}
                  onClick={() => {
                    setPermissionMode(m.value);
                  }}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className={cn("shrink-0 opacity-90", active ? "" : m.color)}>{resolveIcon(m)}</span>
                    <span className={cn("font-medium", active ? "" : m.color)}>{m.label}</span>
                    <span className="truncate text-xs text-content-subtle">
                      {hintKey ? t(hintKey) : m.hint}
                    </span>
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

/** Resolve a permission mode's icon name to a rendered icon node. Falls back
 *  to the neutral shield for unknown icon names. */
function resolveIcon(m: PermissionModeOption): React.ReactNode {
  return (m.icon && ICON_BY_NAME[m.icon]) || <IconShield size={11} />;
}
