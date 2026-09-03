import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Menu } from "@base-ui/react/menu";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import {
  IconAlertTriangle,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconCpu,
  IconPlus,
} from "@renderer/lib/icons.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useSuppressBrowserView } from "@renderer/hooks/useSuppressBrowserView.js";
import { useNarrowViewport } from "@renderer/hooks/useNarrowViewport.js";

/**
 * Model picker for the composer toolbar.
 *
 * The model surface is provider-driven, not hardcoded:
 *   - Built-in aliases come from the active provider's
 *     `capabilities.builtinModels` (claude: Auto/Sonnet/Opus/Fable).
 *   - The custom-endpoint configs (user-defined gateways with a flat model
 *     list) are shown only when the provider declares
 *     `supportsCustomEndpoint` (claude: true, pi: false).
 *
 * Selection state is the pair (customModelId, model):
 *   - built-in alias → customModelId=null, model=<alias id>
 *   - custom model   → customModelId=<cfg id>, model=<one of cfg.models[].id>
 *
 * Built on @base-ui/react/menu: the popup renders through
 * Menu.Portal (document.body), so it isn't clipped by the composer card's
 * overflow-hidden. Config rows with models open a nested submenu.
 *
 * Presentation: layout="chip" (default) renders the compact composer chip;
 * layout="row" (the collapsed-toolbar popup) renders a full-width settings
 * row — icon + label on the left, current value + chevron on the right — and
 * opens the menu to the RIGHT of the row (cascading) so the vertical list in
 * the popup stays visible; on phone-class viewports (no room for panel +
 * menu side by side) it opens upward instead, where the tall screen has
 * plenty of space.
 */

/** Derive the host segment of a base URL for the secondary line. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function ModelDropdown({
  layout = "chip",
}: {
  /** Presentation: composer chip ("chip") vs settings row ("row"). */
  layout?: "chip" | "row";
}) {
  const stacked = layout === "row";
  // Stacked rows cascade their menu to the RIGHT of the list; on a
  // phone-class viewport there is no horizontal room for panel + menu side
  // by side, so it opens upward instead (the phone's vertical space is
  // plentiful). Chip mode always opens upward (composer-bottom anchor).
  const cascade = stacked && !useNarrowViewport();
  const { t } = useI18n();
  // While the menu (or its nested submenu) is open the embedded browser view
  // is suppressed so the portaled popup stays visible/clickable over the
  // browser's rect in narrow/wide layouts. Same while the send-guard hint is
  // up (it's a portal too). Declared after `hint` state below — hoisted hook
  // order is stable because both states precede it on every render.
  const [open, setOpen] = useState(false);
  const model = useSessionStore((s) => s.model);
  const customModelId = useSessionStore((s) => s.customModelId);
  const customModels = useSessionStore((s) => s.customModels);
  const setCustomModel = useSessionStore((s) => s.setCustomModel);
  const setModel = useSessionStore((s) => s.setModel);
  const setSettingsOpen = useSessionStore((s) => s.setSettingsOpen);
  const providerId = useSessionStore((s) => s.providerId);
  const providers = useSessionStore((s) => s.providers);
  const piAvailableModels = useSessionStore((s) => s.piAvailableModels);

  const provider = providers.find((p) => p.id === providerId);
  const isPi = provider?.id === "pi-sdk";
  const isClaude = provider?.id === "claude-sdk";
  // Built-in aliases come from the provider's capabilities (claude: static
  // aliases Auto/Sonnet/Opus/Fable). Pi declares none — its models are dynamic
  // (user-configured in PiModelsPanel) and surfaced via the separate
  // `piAvailableModels` list below, NOT through builtinModels.
  const builtinModels = provider?.capabilities.builtinModels ?? [];
  const supportsCustomEndpoint = provider?.capabilities.supportsCustomEndpoint ?? false;
  const showCustomSection = supportsCustomEndpoint && customModels.length > 0;
  // Pi surfaces its dynamically-discovered models as a flat list (the same
  // shape as builtin aliases). Claude shows its user-defined gateway configs
  // as the "模型列表" section instead — its static aliases are intentionally
  // hidden from the menu (users pick from their configured endpoints).
  const showPiModels = isPi && piAvailableModels.length > 0;
  // Group Pi models by supplier so each model's vendor is visible (mirrors
  // Claude's config-grouped picker, whose top-level rows are the gateway
  // "suppliers"). supplier came from the projection; fall back to the id
  // prefix for safety. Order of groups = order of first appearance.
  const piGroups = useMemo(() => {
    if (!isPi) return [];
    const groups: { supplier: string; models: typeof piAvailableModels }[] = [];
    for (const b of piAvailableModels) {
      const supplier = b.supplier ?? b.id.split("/")[0] ?? b.id;
      let g = groups.find((x) => x.supplier === supplier);
      if (!g) {
        g = { supplier, models: [] };
        groups.push(g);
      }
      g.models.push(b);
    }
    return groups;
  }, [isPi, piAvailableModels]);
  const piModelCount = piAvailableModels.length;
  // "管理模型" lands on the unified model-config settings section. Both claude
  // (custom endpoints) and pi (models.json providers) now live on the same
  // "custom-models" page, distinguished by a type badge in its left list.
  const manageTarget: string | null = isPi || isClaude ? "custom-models" : null;

  // Chip label: resolve the current `model` against the ACTIVE provider's
  // model surface only. Model ids are per-provider (claude uses gateway model
  // ids like "deepseek-v4-pro"; pi uses "provider/modelId" strings), so a
  // leftover value from another provider must never leak into the label.
  //   - custom config  → only when this provider supports custom endpoints
  //   - pi model       → resolved from the dynamic piAvailableModels list
  //   - built-in alias → from the provider's capabilities.builtinModels
  //   - fallback       → "选择模型" — claude and pi have NO default model;
  //                      an unresolved id means nothing is picked, and the
  //                      send guard blocks the turn until one is chosen
  const activeCustom = supportsCustomEndpoint
    ? customModels.find((m) => m.id === customModelId)
    : undefined;
  const activeEntry = activeCustom?.models.find((e) => e.id === model);
  const builtin = builtinModels.find((b) => b.id === model);
  const piModel = isPi ? piAvailableModels.find((b) => b.id === model) : undefined;
  const unselected = !(activeCustom
    ? activeEntry
    : piModel ?? builtin);
  const chipLabel = activeCustom
    ? (activeEntry?.id ?? t("chat.model.unselected"))
    : piModel?.label ?? builtin?.label ?? t("chat.model.unselected");

  // Send-time "no model picked" guard: the store bumps `modelGuardPulse`
  // instead of firing a global toast, and the chip answers in place — a short
  // shake plus a small floating "请先选择模型" hint right above it (portal, so
  // the composer card's overflow-hidden can't clip it). The pulse is a
  // monotonic counter, so a repeat blocked send re-triggers the nudge even
  // though the value only ever grows. The chip and the guard read the same
  // model surface, so a pulse always coincides with `unselected`.
  const modelGuardPulse = useSessionStore((s) => s.modelGuardPulse);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [nudge, setNudge] = useState(false);
  const [hint, setHint] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!modelGuardPulse) return;
    const rect = triggerRef.current?.getBoundingClientRect();
    // A hidden instance (chip row folded into the narrow-mode toggle, popup
    // host not mounted) has no anchor — the visible sibling answers instead.
    if (!rect || rect.width === 0) return;
    setNudge(true);
    // Center the bubble on the chip, clamped so the text can't leave the
    // viewport edges.
    const x = Math.min(Math.max(rect.left + rect.width / 2, 80), window.innerWidth - 80);
    setHint({ x, y: rect.top });
    const stopNudge = window.setTimeout(() => setNudge(false), 420);
    const hideHint = window.setTimeout(() => setHint(null), 2400);
    return () => {
      window.clearTimeout(stopNudge);
      window.clearTimeout(hideHint);
    };
  }, [modelGuardPulse]);
  // A pick resolves the complaint — drop the nudge/bubble immediately instead
  // of letting the bubble linger out its timeout next to a now-valid label.
  useEffect(() => {
    if (!unselected) {
      setNudge(false);
      setHint(null);
    }
  }, [unselected]);
  useSuppressBrowserView(open || hint !== null);

  const pickCustomModel = (cfgId: string, modelId: string) => {
    setCustomModel(cfgId, modelId);
  };

  // Models for a config (only rows with a non-empty id).
  const modelsOf = (cfgId: string) => {
    const cfg = customModels.find((m) => m.id === cfgId);
    if (!cfg) return [];
    return cfg.models.filter((e) => e.id.trim());
  };

  return (
    <>
      <Menu.Root open={open} onOpenChange={setOpen}>
      <Menu.Trigger
        className={cn(
          stacked
            ? "flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-[13px] outline-none select-none transition-colors duration-100"
            : "composer-chip flex min-w-0 items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition-all duration-150 ease-out",
          stacked
            ? "text-content-muted hover:bg-surface-muted hover:text-content"
            : "hover:scale-105 hover:bg-accent/10 hover:text-accent active:scale-95",
          // Nothing picked yet: nudge with the accent tone so the composer
          // visibly asks for a choice instead of reading as "auto".
          unselected && !stacked && "text-accent",
          // Blocked-send pulse from the store guard (see the effect above).
          nudge && "model-chip-nudge",
        )}
        ref={triggerRef}
        title={t("chat.model.selectTitle")}
      >
        {stacked ? (
          <>
            <span className="flex min-w-0 items-center gap-2">
              <IconCpu size={14} className="shrink-0 opacity-80" />
              <span className="shrink-0 font-medium text-content">{t("chat.model.rowLabel")}</span>
            </span>
            <span className="flex min-w-0 items-center gap-1">
              <span className={cn("min-w-0 truncate text-xs", unselected ? "text-accent" : "text-content-muted")}>{chipLabel}</span>
              <IconChevronRight size={12} className="shrink-0 opacity-60" />
            </span>
          </>
        ) : (
          <>
            <span className="min-w-0 max-w-[180px] truncate">
              {chipLabel}
            </span>
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
              "z-50 min-w-[260px] rounded-lg border border-edge bg-surface py-1.5 shadow-2xl",
              cascade ? "origin-top-left" : "origin-bottom-left",
              "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
              "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
              "transition-[transform,opacity] duration-100",
            )}
          >
            {/* Built-in aliases (provider-declared). Claude and Pi both hide
                this section: Claude users pick from their configured gateway
                endpoints (the "模型列表" section below); Pi has no built-in
                aliases at all (its models are user-configured, surfaced via
                the pi "模型列表" section). Future providers that declare
                builtinModels still surface them here. */}
            {!isClaude && !isPi && builtinModels.length > 0 && (
              <div className="border-b border-edge/60 pb-1">
                <div className="px-3 py-1 text-xs uppercase tracking-wide text-content-subtle">
                  {t("chat.model.builtin")}
                </div>
                {builtinModels.map((b) => {
                  const active = !activeCustom && model === b.id;
                  return (
                    <Menu.Item
                      key={b.id}
                      className={cn(
                        "flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[13px] outline-none select-none",
                        "data-[highlighted]:bg-surface-muted",
                        active ? "text-accent" : "text-content-muted",
                      )}
                      onClick={() => setCustomModel(null, b.id)}
                    >
                      <span className="flex min-w-0 items-baseline gap-2">
                        <span className="font-medium">{b.label}</span>
                        {b.hint && <span className="truncate text-xs text-content-subtle">{b.hint}</span>}
                      </span>
                      {active && <IconCheck size={14} className="shrink-0" />}
                    </Menu.Item>
                  );
                })}
              </div>
            )}

            {/* Pi models: dynamically discovered from ~/.pi/agent/models.json
                (configured in the Pi models settings panel). Grouped by
                supplier, mirroring Claude's config-grouped picker: each
                supplier is a top-level row that opens a submenu of its models.
                Each entry maps to a "providerId/modelId" string that
                PiAgentSdkProvider resolves to a Model object at turn time. We
                use setModel (not setCustomModel) because pi has no custom-config
                concept: the picked id is a concrete model, persisted verbatim
                in the session's `model` field and consumed by the provider. */}
            {showPiModels && (
              <div className="border-b border-edge/60 pb-1">
                <div className="flex items-center justify-between px-3 py-1">
                  <span className="text-xs uppercase tracking-wide text-content-subtle">{t("chat.model.list")}</span>
                  <span className="text-xs text-content-subtle">{piModelCount}</span>
                </div>
                {piGroups.map((group) => {
                  const groupActive = group.models.some((b) => model === b.id);
                  const groupRow = (
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-medium">{group.supplier}</span>
                      {groupActive && <IconCheck size={14} className="shrink-0" />}
                    </span>
                  );
                  const groupClasses = cn(
                    "flex w-full items-center justify-between px-3 py-2 text-left text-[13px] outline-none select-none",
                    "data-[highlighted]:bg-surface-muted data-[highlighted]:text-content",
                    groupActive ? "text-accent" : "text-content-muted",
                  );
                  return (
                    <Menu.SubmenuRoot key={group.supplier}>
                      <Menu.SubmenuTrigger
                        openOnHover
                        closeDelay={120}
                        className={groupClasses}
                      >
                        {groupRow}
                        <IconChevronRight size={12} className="ml-2 shrink-0 opacity-60" />
                      </Menu.SubmenuTrigger>
                      <Menu.Portal>
                        <Menu.Positioner side="right" align="start" sideOffset={4}>
                          <Menu.Popup
                            className={cn(
                              "z-50 min-w-[220px] origin-left rounded-lg border border-edge bg-surface py-1.5 shadow-2xl",
                              "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
                              "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
                              "transition-[transform,opacity] duration-100",
                            )}
                          >
                            {group.models.map((b) => {
                              const active = model === b.id;
                              return (
                                <Menu.Item
                                  key={b.id}
                                  onClick={() => setModel(b.id)}
                                  className={cn(
                                    "flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[13px] outline-none select-none",
                                    "data-[highlighted]:bg-surface-muted",
                                    active ? "text-accent" : "text-content-muted",
                                  )}
                                >
                                  <span className="flex min-w-0 items-baseline gap-2">
                                    <span className="truncate font-medium">{b.label}</span>
                                    {b.hint && (
                                      <span className="shrink-0 rounded bg-accent/15 px-1 text-[10px] text-accent">1M</span>
                                    )}
                                  </span>
                                  {active && <IconCheck size={14} className="shrink-0" />}
                                </Menu.Item>
                              );
                            })}
                          </Menu.Popup>
                        </Menu.Positioner>
                      </Menu.Portal>
                    </Menu.SubmenuRoot>
                  );
                })}
              </div>
            )}

            {/* Custom-endpoint configs (only when the provider supports them).
                Each config exposes MULTIPLE models (one token, many models on
                the gateway) as a group with a hover-revealed submenu. */}
            {showCustomSection && (
              <div className="pt-1">
                <div className="flex items-center justify-between px-3 py-1">
                  <span className="text-xs uppercase tracking-wide text-content-subtle">{t("chat.model.list")}</span>
                  <span className="text-xs text-content-subtle">{customModels.length}</span>
                </div>
                {customModels.map((m) => {
                  const cfgActive = customModelId === m.id;
                  const hasModels = modelsOf(m.id).length > 0;
                  const rowTitle = `${m.baseUrl}\ntoken: ${m.authTokenMasked} (${m.authMode === "api_key" ? "x-api-key" : "Bearer"})`;
                  const rowContent = (
                    <>
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-medium">{m.name}</span>
                        {m.protocol === "openai" && (
                          <span className="shrink-0 rounded bg-surface-muted px-1 text-[10px] text-content-subtle">OpenAI</span>
                        )}
                        {cfgActive && <IconCheck size={14} className="shrink-0" />}
                      </span>
                      <span className="ml-2 flex shrink-0 items-center gap-1">
                        <span className="truncate text-xs text-content-subtle">{hostOf(m.baseUrl)}</span>
                        {hasModels && <IconChevronRight size={12} className="opacity-60" />}
                      </span>
                    </>
                  );
                  const rowClasses = cn(
                    "flex w-full items-center justify-between px-3 py-2 text-left text-[13px] outline-none select-none",
                    "data-[highlighted]:bg-surface-muted data-[highlighted]:text-content",
                    cfgActive ? "text-accent" : "text-content-muted",
                  );
                  return hasModels ? (
                    <Menu.SubmenuRoot key={m.id}>
                      <Menu.SubmenuTrigger
                        openOnHover
                        closeDelay={120}
                        className={rowClasses}
                        title={rowTitle}
                      >
                        {rowContent}
                      </Menu.SubmenuTrigger>
                      <Menu.Portal>
                        <Menu.Positioner side="right" align="start" sideOffset={4}>
                          <Menu.Popup
                            className={cn(
                              "z-50 min-w-[220px] origin-left rounded-lg border border-edge bg-surface py-1.5 shadow-2xl",
                              "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
                              "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
                              "transition-[transform,opacity] duration-100",
                            )}
                          >
                            {modelsOf(m.id).map((entry) => {
                              const active = cfgActive && model === entry.id;
                              return (
                                <Menu.Item
                                  key={entry.id}
                                  onClick={() => pickCustomModel(m.id, entry.id)}
                                  className={cn(
                                    "flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[13px] outline-none select-none",
                                    "data-[highlighted]:bg-surface-muted",
                                    active ? "text-accent" : "text-content-muted",
                                  )}
                                >
                                  <span className="flex min-w-0 items-baseline gap-2">
                                    <span className="truncate">{entry.id}</span>
                                    {entry.supports1m && (
                                      <span className="shrink-0 rounded bg-accent/15 px-1 text-[10px] text-accent">1M</span>
                                    )}
                                  </span>
                                  {active && <IconCheck size={14} className="shrink-0" />}
                                </Menu.Item>
                              );
                            })}
                          </Menu.Popup>
                        </Menu.Positioner>
                      </Menu.Portal>
                    </Menu.SubmenuRoot>
                  ) : (
                    <div key={m.id} className={rowClasses} title={rowTitle}>
                      {rowContent}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Empty state: no models of any kind to show. Pi with no
                configured providers still gets the "管理模型" entry below, so
                it only hits this branch when the pi SDK itself failed to load
                (piAvailableModels stays empty but manageTarget is set). */}
            {!isClaude && !isPi && builtinModels.length === 0 && !showPiModels && !showCustomSection && (
              <div className="px-3 py-2 text-[13px] text-content-subtle">
                {t("chat.model.noneAvailable")}
              </div>
            )}
            {/* Claude with no custom configs: nudge toward configuration. */}
            {isClaude && !showCustomSection && (
              <div className="px-3 py-2 text-[13px] text-content-subtle">
                {t("chat.model.notConfigured")}
              </div>
            )}
            {/* Pi with no discovered models: nudge toward the Pi models panel. */}
            {isPi && !showPiModels && (
              <div className="px-3 py-2 text-[13px] text-content-subtle">
                {t("chat.model.notConfigured")}
              </div>
            )}

            {/* Manage-models entry — shown for providers that own a model
                configuration surface (claude + pi). Both now live on the
                unified "custom-models" settings page. */}
            {manageTarget && (
              <>
                <div className="my-1 border-t border-edge" />
                <Menu.Item
                  onClick={() => setSettingsOpen(true, manageTarget)}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] outline-none select-none",
                    "text-content-muted data-[highlighted]:bg-surface-muted data-[highlighted]:text-content",
                  )}
                >
                  <IconPlus size={14} />
                  <span>{t("chat.model.manage")}</span>
                </Menu.Item>
              </>
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
      </Menu.Root>
      {hint &&
        createPortal(
          <div
            className="model-pick-hint flex items-center gap-1.5 rounded-lg border border-warning/40 bg-surface px-2.5 py-1.5 text-xs font-medium text-warning shadow-lg"
            style={{ left: hint.x, top: hint.y }}
          >
            <IconAlertTriangle size={13} className="shrink-0" />
            <span>{t("chat.model.pickHint")}</span>
          </div>,
          document.body,
        )}
    </>
  );
}
