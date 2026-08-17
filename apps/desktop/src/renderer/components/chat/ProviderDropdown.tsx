import { useState } from "react";
import { Menu } from "@base-ui/react/menu";
import { cn } from "@renderer/lib/cn.js";
import { IconCheck, IconChevronDown, IconLock } from "@renderer/lib/icons.js";
import { getProviderIcon } from "@renderer/lib/providerIcon.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useSuppressBrowserView } from "@renderer/hooks/useSuppressBrowserView.js";

/**
 * Provider (AI backend) picker for the composer toolbar.
 *
 * Shows only when more than one provider is registered. For a thread without
 * messages it's a dropdown (the SDK for the NEXT session). Once a session has
 * messages its provider is fixed at creation — the chip stays visible but
 * becomes read-only (icon + name + lock, no dropdown) so the conversation's
 * SDK remains legible in the composer.
 *
 * Placement: directly left of the send button in ChatPane (not in the
 * ComposerToolbar chip row), so it stays visible even when the chip row
 * collapses in narrow mode. The model dropdown adapts to the chosen
 * provider's capabilities automatically.
 */
export function ProviderDropdown() {
  // While the menu is open the embedded browser view is suppressed so the
  // portaled popup stays visible/clickable when it extends over the browser.
  const [open, setOpen] = useState(false);
  useSuppressBrowserView(open);
  const providerId = useSessionStore((s) => s.providerId);
  const providers = useSessionStore((s) => s.providers);
  const setProvider = useSessionStore((s) => s.setProvider);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  // The active thread has messages → its provider is locked.
  const hasMessages = useSessionStore((s) => {
    if (!activeSessionId) return false;
    const bucket = s.messagesBySession[activeSessionId];
    return bucket !== undefined && bucket.length > 0;
  });

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
        title="该会话的 SDK 已固定,不可更改"
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
      title="选择会话使用的 SDK"
    >
      <activeIcon.Icon size={13} className={cn("shrink-0", activeIcon.color)} />
      <span className="min-w-0 max-w-[140px] truncate">{active?.displayName ?? providerId}</span>
      <IconChevronDown size={11} className="shrink-0 opacity-60" />
    </button>
  );

  // Unlocked (new thread): clicking the chip opens the provider menu.
  return (
    <Menu.Root open={open} onOpenChange={setOpen}>
      <Menu.Trigger render={chip} />
      <Menu.Portal>
        <Menu.Positioner side="top" align="start">
          <Menu.Popup
            className={cn(
              "z-50 min-w-[220px] origin-bottom-left rounded-lg border border-edge bg-surface py-1.5 shadow-2xl",
              "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
              "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
              "transition-[transform,opacity] duration-100",
            )}
          >
            <div className="px-3 py-1 text-xs uppercase tracking-wide text-content-subtle">
              选择 SDK
            </div>
            {providers.map((p) => {
              const activeItem = p.id === providerId;
              const meta = getProviderIcon(p.id);
              const ItemIcon = meta.Icon;
              return (
                <Menu.Item
                  key={p.id}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[13px] outline-none select-none",
                    "data-[highlighted]:bg-surface-muted",
                    activeItem ? "text-accent" : "text-content-muted",
                  )}
                  onClick={() => setProvider(p.id)}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <ItemIcon size={14} className={cn("shrink-0", meta.color)} />
                    <span className="truncate font-medium">{p.displayName}</span>
                  </span>
                  {activeItem && <IconCheck size={14} className="shrink-0" />}
                </Menu.Item>
              );
            })}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
