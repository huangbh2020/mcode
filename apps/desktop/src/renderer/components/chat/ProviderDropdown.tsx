import { useRef, useState } from "react";
import { Menu } from "@base-ui/react/menu";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { IconCheck, IconChevronDown, IconLock, IconSettings } from "@renderer/lib/icons.js";
import { getProviderIcon } from "@renderer/lib/providerIcon.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useSuppressBrowserView } from "@renderer/hooks/useSuppressBrowserView.js";
import { api } from "@renderer/lib/api.js";
import type { AntigravityCliStatus, ClaudeCliStatus, RuntimeAgentId } from "@contracts/ipc";

/** Actual transport / runtime backing each provider, shown in the agent
 *  picker menu so users can tell CLI, SDK, and ACP providers apart. */
const PROVIDER_TRANSPORT_TAG: Record<string, string> = {
  "claude-sdk": "CLI",
  "pi-sdk": "SDK",
  "codex-sdk": "App-Server",
  "opencode-sdk": "SDK",
  "antigravity-acp": "ACP",
};

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
 * collapses in narrow mode. At collapsed tiers (composer card under the
 * merge threshold — see useComposerRowFit) `compact` folds the label away
 * through an animatable grid shell, leaving the brand icon (plus the lock
 * while the session is fixed): the full name was one of the widest items
 * squeezing the narrow composer, and the tooltip keeps it legible.
 */
export function ProviderDropdown({
  compact = false,
  segment = false,
  controller,
}: {
  compact?: boolean;
  /** Render the trigger as a composer-minipill segment (定时任务编辑弹窗's
   *  SDK slot inside the pill) instead of the standalone provider chip. */
  segment?: boolean;
  /** Controlled override: bind to a LOCAL draft instead of the global
   *  composer slots — same provider menu (availability grey-out included),
   *  the pick routes through `onChange`. Never renders the locked read-only
   *  chip: the editor's SDK is always choosable. */
  controller?: {
    providerId: string;
    onChange: (providerId: string) => void;
  };
} = {}) {
  const { t } = useI18n();
  // While the menu is open the embedded browser view is suppressed — but only
  // when the portaled popup actually reaches the browser's rect (the ref lets
  // useSuppressBrowserView measure it). See useSuppressBrowserView.
  const [open, setOpen] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  useSuppressBrowserView(open, popupRef);
  const storeProviderId = useSessionStore((s) => s.providerId);
  const providerId = controller ? controller.providerId : storeProviderId;
  const providers = useSessionStore((s) => s.providers);
  const storeSetProvider = useSessionStore((s) => s.setProvider);
  const setProvider = (pid: string): void => {
    if (controller) controller.onChange(pid);
    else storeSetProvider(pid);
  };
  const runtimes = useSessionStore((s) => s.runtimes);
  const reloadRuntimes = useSessionStore((s) => s.reloadRuntimes);
  const setSettingsOpen = useSessionStore((s) => s.setSettingsOpen);
  // Claude left the managed-runtime set (2026-11-24): its sessions spawn the
  // USER'S CLI, so its availability comes from the CLI probe, not the
  // runtimes list (which no longer carries a claude row). null = not yet
  // probed — treated as available so the item doesn't flash grey before the
  // answer lands (and on the web shell, where the call is unsupported).
  const [claudeCli, setClaudeCli] = useState<ClaudeCliStatus | null>(null);
  const [agyCli, setAgyCli] = useState<AntigravityCliStatus | null>(null);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  // The active thread has messages → its provider is locked. (Controlled
  // mode skips the lock: the editor's SDK is always choosable.)
  const hasMessages = useSessionStore((s) => {
    if (!activeSessionId) return false;
    const bucket = s.messagesBySession[activeSessionId];
    return bucket !== undefined && bucket.length > 0;
  });

  // Availability per provider, derived from the runtime list — except
  // claude-sdk and antigravity-acp, which key on the user's CLI probes.
  // Before the list hydrates (and on the web shell, where reloadRuntimes
  // no-ops) it's empty — treat every provider as available rather than
  // flashing everything greyed.
  const runtimeByAgent = new Map(runtimes.map((r) => [r.agent, r]));
  const isAvailable = (pid: string): boolean => {
    if (pid === "claude-sdk") return claudeCli === null || claudeCli.usable;
    if (pid === "antigravity-acp") return agyCli === null || agyCli.usable;
    const agent = runtimeAgentFor(pid);
    if (agent === null || runtimes.length === 0) return true;
    const rt = runtimeByAgent.get(agent);
    return rt !== undefined && rt.source !== null;
  };
  /** Menu-row subtitle for an unavailable provider ("Runtime not installed" /
   *  "CLI too old — update it"). */
  const unavailableLabel = (pid: string): string => {
    if (pid === "claude-sdk" && claudeCli?.reason === "too-old") return t("chat.provider.cliTooOld");
    if (pid === "antigravity-acp" && agyCli?.reason === "too-old") return t("chat.provider.cliTooOld");
    return t("chat.provider.notInstalled");
  };

  // Single-provider installs need no picker.
  if (providers.length <= 1) return null;

  const active = providers.find((p) => p.id === providerId);
  const activeIcon = getProviderIcon(providerId);

  // Locked (session has messages): the provider is fixed at creation. Render
  // a read-only chip (icon + name + lock) — visible for context, but with no
  // dropdown to change it.
  if (!controller && hasMessages) {
    return (
      <span
        className={cn(
          "composer-chip composer-provider-chip flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
          "cursor-default text-content-muted",
        )}
        data-compact={compact ? "1" : "0"}
        title={t("chat.provider.locked")}
      >
        <activeIcon.Icon size={13} className={cn("shrink-0", activeIcon.color)} />
        <span className="composer-lblwrap">
          <span className="max-w-[140px] truncate">{active?.displayName ?? providerId}</span>
        </span>
        <IconLock size={11} className="shrink-0 opacity-50" />
      </span>
    );
  }

  const chip = segment ? (
    // Pill-segment presentation (定时任务编辑弹窗): same minipill-seg hook as
    // the model/effort/permission segments so the pill reads as one control.
    <button
      type="button"
      className="composer-minipill-seg"
      title={t("chat.provider.selectTitle")}
    >
      <activeIcon.Icon size={13} className={cn("shrink-0", activeIcon.color)} />
      <span className="composer-lblwrap">
        <span className="max-w-[110px] truncate">{active?.displayName ?? providerId}</span>
      </span>
    </button>
  ) : (
    <button
      type="button"
      className={cn(
        "composer-chip composer-provider-chip flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-all duration-150 ease-out",
        "text-content-muted hover:scale-105 hover:bg-accent/10 hover:text-accent active:scale-95",
      )}
      data-compact={compact ? "1" : "0"}
      title={t("chat.provider.selectTitle")}
    >
      <activeIcon.Icon size={13} className={cn("shrink-0", activeIcon.color)} />
      <span className="composer-lblwrap">
        <span className="flex min-w-0 items-center gap-1">
          <span className="max-w-[140px] truncate">{active?.displayName ?? providerId}</span>
          <IconChevronDown size={11} className="shrink-0 opacity-60" />
        </span>
      </span>
    </button>
  );

  // Unlocked (new thread): clicking the chip opens the provider menu.
  return (
    <Menu.Root
      open={open}
      onOpenChange={(next) => {
        // Refresh availability when (re)opening — installs from the settings
        // panel (or first hydration races) are reflected on the next open.
        // `force` also drops the main-side ~10-min CLI caches, so a CLI the
        // user installed OUTSIDE Mcode shows up on the next open; a probe is
        // one `claude --version` spawn, cheap for a user-opened menu.
        if (next) {
          void reloadRuntimes();
          void api.runtimes
            .claudeCli({ force: true })
            .then(setClaudeCli)
            .catch(() => setClaudeCli(null));
          void api.antigravity
            .cliStatus({ force: true })
            .then(setAgyCli)
            .catch(() => setAgyCli(null));
        }
        setOpen(next);
      }}
    >
      <Menu.Trigger render={chip} />
      <Menu.Portal>
        <Menu.Positioner side={segment ? "top" : "top"} align="start">
          <Menu.Popup
            ref={popupRef}
            className={cn(
              "z-50 min-w-[232px] origin-bottom-left rounded-lg border border-edge bg-surface py-1.5 shadow-2xl",
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
              const transportTag = PROVIDER_TRANSPORT_TAG[p.id];
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
                    {transportTag && (
                      <span
                        className={cn(
                          "shrink-0 rounded px-1 py-0.5 font-mono text-[10px] leading-none",
                          activeItem
                            ? "bg-accent/15 text-accent"
                            : "bg-surface-muted text-content-subtle",
                        )}
                      >
                        {transportTag}
                      </span>
                    )}
                  </span>
                  {!available ? (
                    <span className="shrink-0 text-[11px] text-content-subtle">
                      {unavailableLabel(p.id)}
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
