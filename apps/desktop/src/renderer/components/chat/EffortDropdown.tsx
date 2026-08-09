import { Menu } from "@base-ui/react/menu";
import { cn } from "@renderer/lib/cn.js";
import { IconCheck, IconBolt, IconChevronDown } from "@renderer/lib/icons.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";

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
 */

/** Fallback label when the current value isn't in the provider's level list
 *  (e.g. a persisted value for a provider that no longer declares it). */
function labelFor(levels: { value: string; label: string }[] | undefined, value: string): string {
  return levels?.find((l) => l.value === value)?.label ?? value;
}

export function EffortDropdown() {
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
    <Menu.Root>
      <Menu.Trigger
        className={cn(
          "composer-chip flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition-all duration-150 ease-out",
          "text-content-muted hover:scale-105 hover:bg-accent/10 hover:text-accent active:scale-95",
        )}
        title="Reasoning effort for the next session"
      >
        <IconBolt size={13} className="shrink-0 opacity-80" />
        <span className="min-w-0 truncate">{labelFor(levels, effort)}</span>
        <IconChevronDown size={11} className="shrink-0 opacity-60" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="top" align="start">
          <Menu.Popup
            className={cn(
              "z-50 min-w-[240px] origin-bottom-left rounded-lg border border-edge bg-surface py-1.5 shadow-2xl",
              "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
              "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
              "transition-[transform,opacity] duration-100",
            )}
          >
            <div className="px-3 py-1 text-xs uppercase tracking-wide text-content-subtle">
              思考级别
            </div>
            {levels.map((m) => {
              const active = m.value === effort;
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
                    <span className="truncate text-xs text-content-subtle">{m.hint}</span>
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
