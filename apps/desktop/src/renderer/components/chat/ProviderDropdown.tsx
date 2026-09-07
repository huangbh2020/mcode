import { useRef, useState } from "react";
import { Menu } from "@base-ui/react/menu";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { IconCheck, IconChevronDown, IconLock, IconSettings } from "@renderer/lib/icons.js";
import { getProviderIcon } from "@renderer/lib/providerIcon.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useSuppressBrowserView } from "@renderer/hooks/useSuppressBrowserView.js";
import type { RuntimeAgentId } from "@contracts/ipc";

/** Provider id → runtime agent ("claude-sdk" → "claude", …). Providers
 *  outside the runtime-backed trio (future ones) map to null and are never
 *  gated. */
function runtimeAgentFor(providerId: string): RuntimeAgentId | null {
  switch (providerId) {
    case "claude-sdk":
      return "claude";
    case "pi-sdk":
      return "pi";
    case "codex-sdk":
      return "codex";
    default:
      return null;
  }
}

/**
 * Provider (AI backend) picker for the composer toolbar.
 *
 * Shows only when more than one provider is registered. For a thread without
 * messages it's a dropdown (the SDK for the NEXT session). Once a session has
 * messages its provider is fixed at creation — the chip stays visible but
 * becomes read-only (icon + name + lock, no dropdown) so the conversation's
 * SDK remains legible in the composer.
 *
 * Providers whose runtime isn't usable (not installed AND no dev/bundled
 * fallback — see RuntimeAgentState.source) are greyed out and unselectable;
 * a footer entry deep-links into Settings → Agent Runtimes to install one.
 *
 * Placement: directly left of the send button in ChatPane (not in the
 * ComposerToolbar chip row), so it stays visible even when the chip row
 * collapses in narrow mode. The model dropdown adapts to the chosen
 * provider's capabilities automatically.
 */
export function ProviderDropdown() {
  const { t } = useI18n();
  // While the menu is open the embedded browser view is suppressed — but only
  // when the portaled popup actually reaches the browser's rect (the ref lets
  // useSuppressBrowserView measure it). See useSuppressBrowserView.
  const [open, setOpen] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  useSuppressBrowserView(open, popupRef);
  const providerId = useSessionStore((s) => s.providerId);
  const providers = useSessionStore((s) => s.providers);
  const setProvider = useSessionStore((s) => s.setProvider);
  const runtimes = useSessionStore((s) => s.runtimes);
  const reloadRuntimes = useSessionStore((s) => s.reloadRuntimes);
  const setSettingsOpen = useSessionStore((s) => s.setSettingsOpen);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  // The active thread has messages → its provider is locked.
  const hasMessages = useSessionStore((s) => {
    if (!activeSessionId) return false;
    const bucket = s.messagesBySession[activeSessionId];
    return bucket !== undefined && bucket.length > 0;
  });

  // Availability per provider, derived from the runtime list. Before the list
  // hydrates (and on the web shell, where reloadRuntimes no-ops) it's empty —
  // treat every provider as available rather than flashing everything greyed.
  const runtimeByAgent = new Map(runtimes.map((r) => [r.agent, r]));
  const isAvailable = (pid: string): boolean => {
    const agent = runtimeAgentFor(pid);
    if (agent === null || runtimes.length === 0) return true;
    const rt = runtimeByAgent.get(agent);
    return rt !== undefined && rt.source !== null;
  };

  // Single-provider installs need no picker.
  if (providers.length <= 1) return null;

  const active = providers.find((p) => p.id === providerId);
  const activeIcon = getProviderIcon(providerId);

  // Locked (session has messages): the provider is fixed at creation. Render
  // a read-only chip (icon + name + lock) — visible for context, but with no
  // dropdown to change it.
  if (hasMessages) {
    return (
      <span
        className={cn(
          "composer-chip flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium",
          "cursor-default text-content-muted",
        )}
        title={t("chat.provider.locked")}
      >
        <activeIcon.Icon size={13} className={cn("shrink-0", activeIcon.color)} />
        <span className="min-w-0 max-w-[140px] truncate">{active?.displayName ?? providerId}</span>
        <IconLock size={11} className="shrink-0 opacity-50" />
      </span>
    );
  }

  const chip = (
    <button
      type="button"
      className={cn(
        "composer-chip flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition-all duration-150 ease-out",
        "text-content-muted hover:scale-105 hover:bg-accent/10 hover:text-accent active:scale-95",
      )}
      title={t("chat.provider.selectTitle")}
    >
      <activeIcon.Icon size={13} className={cn("shrink-0", activeIcon.color)} />
      <span className="min-w-0 max-w-[140px] truncate">{active?.displayName ?? providerId}</span>
      <IconChevronDown size={11} className="shrink-0 opacity-60" />
    </button>
  );

  // Unlocked (new thread): clicking the chip opens the provider menu.
  return (
    <Menu.Root
      open={open}
      onOpenChange={(next) => {
        // Refresh availability when (re)opening — installs from the settings
        // panel (or first hydration races) are reflected on the next open.
        if (next) void reloadRuntimes();
        setOpen(next);
      }}
    >
      <Menu.Trigger render={chip} />
      <Menu.Portal>
        <Menu.Positioner side="top" align="start">
          <Menu.Popup
            ref={popupRef}
            className={cn(
              "z-50 min-w-[220px] origin-bottom-left rounded-lg border border-edge bg-surface py-1.5 shadow-2xl",
              "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
              "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
              "transition-[transform,opacity] duration-100",
            )}
          >
            <div className="px-3 py-1 text-xs uppercase tracking-wide text-content-subtle">
              {t("chat.provider.section")}
            </div>
            {providers.map((p) => {
              const activeItem = p.id === providerId;
              const meta = getProviderIcon(p.id);
              const ItemIcon = meta.Icon;
              const available = isAvailable(p.id);
              return (
                <Menu.Item
                  key={p.id}
                  disabled={!available}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[13px] outline-none select-none",
                    "data-[highlighted]:bg-surface-muted",
                    activeItem ? "text-accent" : "text-content-muted",
                    !available && "cursor-not-allowed opacity-40",
                  )}
                  onClick={() => setProvider(p.id)}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <ItemIcon size={14} className={cn("shrink-0", meta.color)} />
                    <span className="truncate font-medium">{p.displayName}</span>
                  </span>
                  {!available ? (
                    <span className="shrink-0 text-[11px] text-content-subtle">
                      {t("chat.provider.notInstalled")}
                    </span>
                  ) : activeItem ? (
                    <IconCheck size={14} className="shrink-0" />
                  ) : null}
                </Menu.Item>
              );
            })}
            {/* Manage entry → Settings → Agent Runtimes (install / update). */}
            <div className="mx-3 my-1 border-t border-edge" />
            <Menu.Item
              className={cn(
                "flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] outline-none select-none",
                "text-content-muted data-[highlighted]:bg-surface-muted data-[highlighted]:text-content",
              )}
              onClick={() => {
                setOpen(false);
                setSettingsOpen(true, "runtimes");
              }}
            >
              <IconSettings size={14} className="shrink-0" />
              <span className="truncate">{t("chat.provider.manage")}</span>
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
