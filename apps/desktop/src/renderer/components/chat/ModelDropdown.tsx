import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Menu } from "@base-ui/react/menu";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import {
  IconAlertTriangle,
  IconCheck,
  IconChevronLeft,
  IconChevronRight,
  IconCpu,
  IconPlus,
} from "@renderer/lib/icons.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useSuppressBrowserView } from "@renderer/hooks/useSuppressBrowserView.js";
import { useNarrowViewport } from "@renderer/hooks/useNarrowViewport.js";
import { resolveEffortLevels } from "@renderer/lib/thinkingLevels.js";
import { EFFORT_HINT_KEYS } from "./EffortPermissionControl.js";
import type { ThinkingLevelOption } from "@contracts/provider";

/**
 * Merged model + thinking-level picker for the composer toolbar (one chip,
 * one popover — the model and its effort ladder share a single surface, so
 * picking either never costs a second click).
 *
 * The model surface is provider-driven, not hardcoded:
 *   - claude: the custom-endpoint configs (user-defined gateways, each with a
 *     flat model list). No built-in aliases in the menu (users pick from
 *     their configured endpoints).
 *   - pi / codex / opencode: dynamically discovered models
 *     (`piAvailableModels` / `codexAvailableModels` / `opencodeAvailableModels`)
 *     grouped by supplier.
 *   - other future providers: `capabilities.builtinModels` as a flat list.
 *
 * The popover has two views sharing one surface (drill-down replaces the old
 * hover submenus):
 *   - models view: a header row for the ACTIVE group (config name / supplier)
 *     + its flat model list + the thinking-level slider. Clicking the header
 *     drills to…
 *   - configs view: the group list (claude configs / suppliers). Picking one
 *     selects its first model and flips back to the models view.
 *   - Providers without a group concept (builtin-only) render the flat list
 *     with no header. Opening resets the view: models when a group is (or can
 *     be) implied, the config list otherwise.
 *
 * Selection state is the pair (customModelId, model):
 *   - built-in alias → customModelId=null, model=<alias id>
 *   - custom model   → customModelId=<cfg id>, model=<one of cfg.models[].id>
 *
 * The thinking ladder comes from `resolveEffortLevels` — the SAME chain the
 * old standalone effort chip used (provider capabilities, filtered by the
 * model's OpenAI-protocol thinking declaration / pi model map / opencode
 * variants). Model declares no controllable effort → the slider section is
 * absent and the chip shows the model alone. Controlled mode (定时任务编辑弹窗)
 * binds the model surface to a LOCAL draft through `onPick` and hides the
 * slider — the editor keeps its own standalone effort chip.
 *
 * Built on @base-ui/react/menu: the popup renders through Menu.Portal
 * (document.body) so it isn't clipped by the composer card's overflow-hidden.
 * Model/group picks set closeOnClick=false — the popover stays open so the
 * ladder can be adjusted in the same interaction; Esc / outside click closes.
 *
 * Presentation: layout="pill" (default) renders the picker as a segment of
 * the composer's mini pill (`model · level`), labels collapse via the pill's
 * data-compact CSS shells; layout="row" (the collapsed-hosts toggle popup)
 * renders a full-width settings row and opens the popup to the RIGHT of the
 * row (cascading); on phone-class viewports it opens upward instead.
 */

/** Derive the host segment of a base URL for the secondary line. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Deterministic avatar hue per group key — stable across renders/sessions
 *  so a config's disc doesn't repaint between opens. */
const GROUP_AVATAR_COLORS = [
  "#4f83ff",
  "#8b5cf6",
  "#0ea5e9",
  "#f59e0b",
  "#f43f5e",
  "#14b8a6",
  "#6366f1",
  "#10b981",
];

function hashKey(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return h;
}

function avatarColor(key: string): string {
  return GROUP_AVATAR_COLORS[hashKey(key) % GROUP_AVATAR_COLORS.length];
}

function initialOf(name: string): string {
  return name.trim().charAt(0).toUpperCase() || "•";
}

/** A normalized model row: the provider-specific badge quirks (pi hardcodes
 *  "1M" for hint-carrying entries, opencode adds the Free pill) resolve into
 *  one typed shape so the popup renders one list for every provider. */
type NormBadge = { text: string; tone: "accent" | "neutral" | "success" };
type NormModel = { id: string; label: string; badges: NormBadge[] };

/** A normalized group: claude → a custom-endpoint config; pi/codex/opencode
 *  → a supplier bucket of the dynamic model list. */
type NormGroup = {
  key: string;
  name: string;
  host?: string;
  rowTitle?: string;
  models: NormModel[];
};

const BADGE_TONE: Record<NormBadge["tone"], string> = {
  accent: "bg-accent/15 text-accent",
  neutral: "bg-surface-muted text-content-subtle",
  success: "bg-success/15 text-success",
};

/** Discrete thinking-level slider: an accent fill to the active stop, a
 *  white knob, and one small stop button per level (the keyboard/AT path —
 *  pointer users drag anywhere on the strip and it snaps to the nearest
 *  level). Same ladder values and persistence as the old block-grid chip;
 *  only the interaction surface changed. */
function EffortSlider({
  levels,
  value,
  onChange,
  hintOf,
}: {
  levels: ThinkingLevelOption[];
  value: string;
  onChange: (v: string) => void;
  hintOf: (m: ThinkingLevelOption) => string;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  const n = levels.length;
  const idx = levels.findIndex((l) => l.value === value);
  const pct = idx < 0 ? 0 : n > 1 ? (idx / (n - 1)) * 100 : 100;
  const snapFromClientX = (clientX: number) => {
    const track = trackRef.current;
    if (!track) return;
    const r = track.getBoundingClientRect();
    const t = Math.min(1, Math.max(0, (clientX - r.left) / Math.max(1, r.width)));
    const next = levels[Math.round(t * (n - 1))];
    if (next && next.value !== value) onChange(next.value);
  };
  const endDrag = () => {
    draggingRef.current = false;
    setDragging(false);
  };
  return (
    <div
      className={cn("model-effort-slider", dragging && "dragging")}
      role="presentation"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        draggingRef.current = true;
        setDragging(true);
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // Capture is a drag-quality nicety; taps already work without it.
        }
        snapFromClientX(e.clientX);
      }}
      onPointerMove={(e) => {
        if (draggingRef.current) snapFromClientX(e.clientX);
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <div className="model-effort-track" ref={trackRef}>
        {idx >= 0 && <div className="model-effort-fill" style={{ width: `${pct}%` }} />}
        {levels.map((m, i) => {
          const p = n > 1 ? (i / (n - 1)) * 100 : 50;
          return (
            <Fragment key={m.value}>
              <span className="model-effort-dot" style={{ left: `${p}%` }} />
              <button
                type="button"
                className="model-effort-stop"
                style={{ left: `${p}%` }}
                title={hintOf(m)}
                aria-label={m.label}
                aria-pressed={m.value === value}
                onClick={() => onChange(m.value)}
              />
            </Fragment>
          );
        })}
        {idx >= 0 && <div className="model-effort-knob" style={{ left: `${pct}%` }} />}
      </div>
    </div>
  );
}

export function ModelDropdown({
  layout = "pill",
  controller,
}: {
  /** Presentation: pill segment ("pill") vs settings row ("row"). */
  layout?: "pill" | "row";
  /** Controlled override (定时任务编辑弹窗): bind the picker to a LOCAL draft
   *  instead of the global composer slots — same popup, model values
   *  round-trip through `onPick` (customModelId, modelId). The effort slider
   *  is hidden here (the editor keeps its own standalone effort chip). */
  controller?: {
    providerId: string;
    model: string;
    customModelId: string | null;
    onPick: (customModelId: string | null, modelId: string) => void;
  };
} = {}) {
  const stacked = layout === "row";
  // Stacked rows cascade their popup to the RIGHT of the list; on a
  // phone-class viewport there is no horizontal room for panel + popup side
  // by side, so it opens upward instead (the phone's vertical space is
  // plentiful). Chip mode always opens upward (composer-bottom anchor).
  const cascade = stacked && !useNarrowViewport();
  const { t } = useI18n();
  // While the popup (or the send-guard hint) is open the embedded browser
  // view is suppressed so the portaled popup stays visible/clickable over
  // the browser's rect in narrow/wide layouts. Declared after the state it
  // reads — hoisted hook order is stable because both states precede it on
  // every render.
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"models" | "configs">("models");
  const storeModel = useSessionStore((s) => s.model);
  const storeCustomModelId = useSessionStore((s) => s.customModelId);
  const customModels = useSessionStore((s) => s.customModels);
  const storeSetCustomModel = useSessionStore((s) => s.setCustomModel);
  const storeSetModel = useSessionStore((s) => s.setModel);
  const setSettingsOpen = useSessionStore((s) => s.setSettingsOpen);
  const storeProviderId = useSessionStore((s) => s.providerId);
  const providers = useSessionStore((s) => s.providers);
  const piAvailableModels = useSessionStore((s) => s.piAvailableModels);
  const codexAvailableModels = useSessionStore((s) => s.codexAvailableModels);
  const opencodeAvailableModels = useSessionStore((s) => s.opencodeAvailableModels);
  const piModelMaps = useSessionStore((s) => s.piModelMaps);
  const opencodeModelVariants = useSessionStore((s) => s.opencodeModelVariants);
  const storeEffort = useSessionStore((s) => s.effort);
  const storeSetEffort = useSessionStore((s) => s.setEffort);
  // Controlled override wins over the global slots; the pick callbacks route
  // back through onPick instead of mutating the session config.
  const model = controller ? controller.model : storeModel;
  const customModelId = controller ? controller.customModelId : storeCustomModelId;
  const providerId = controller ? controller.providerId : storeProviderId;
  const setCustomModel = (cfgId: string | null, modelId: string): void => {
    if (controller) controller.onPick(cfgId, modelId);
    else storeSetCustomModel(cfgId, modelId);
  };
  const setModel = (modelId: string): void => {
    if (controller) controller.onPick(null, modelId);
    else storeSetModel(modelId);
  };

  const provider = providers.find((p) => p.id === providerId);
  const isPi = provider?.id === "pi-sdk";
  const isCodex = provider?.id === "codex-sdk";
  const isOpencode = provider?.id === "opencode-sdk";
  const isClaude = provider?.id === "claude-sdk";
  // Group-bearing providers drill between the group list and a group's model
  // list; builtin-only providers render a flat list with no header.
  const hasGroups = isClaude || isPi || isCodex || isOpencode;
  const builtinModels = provider?.capabilities.builtinModels ?? [];
  const supportsCustomEndpoint = provider?.capabilities.supportsCustomEndpoint ?? false;

  // The provider's model surface normalized into groups (see NormGroup).
  // Claude maps one group per custom config; pi/codex/opencode bucket their
  // dynamic lists by supplier, order of first appearance.
  const groups: NormGroup[] = useMemo(() => {
    if (isClaude) {
      if (!supportsCustomEndpoint) return [];
      return customModels.map((m) => ({
        key: m.id,
        name: m.name,
        host: hostOf(m.baseUrl),
        rowTitle: `${m.baseUrl}\ntoken: ${m.authTokenMasked} (${m.authMode === "api_key" ? "x-api-key" : "Bearer"})`,
        models: m.models
          .filter((e) => e.id.trim())
          .map((e) => ({
            id: e.id,
            label: e.id,
            badges: e.supports1m ? ([{ text: "1M", tone: "accent" }] as NormBadge[]) : [],
          })),
      }));
    }
    const list = isPi
      ? piAvailableModels
      : isCodex
        ? codexAvailableModels
        : isOpencode
          ? opencodeAvailableModels
          : [];
    const out: NormGroup[] = [];
    for (const b of list) {
      const supplier = b.supplier ?? b.id.split("/")[0] ?? b.id;
      let g = out.find((x) => x.key === supplier);
      if (!g) {
        g = { key: supplier, name: supplier, models: [] };
        out.push(g);
      }
      const badges: NormBadge[] = [];
      // OpenCode-only affordance; `in` narrows the BuiltinModelOption union
      // member (only OpenCodeModelOption carries `free`).
      if (isOpencode && "free" in b && b.free) badges.push({ text: t("chat.model.free"), tone: "success" });
      // pi's projection marks context-window entries with a hint; the old
      // submenu rendered it as the "1M" pill verbatim.
      if (b.hint) badges.push({ text: isPi ? "1M" : b.hint, tone: "accent" });
      g.models.push({ id: b.id, label: b.label, badges });
    }
    return out;
  }, [
    isClaude,
    isPi,
    isCodex,
    isOpencode,
    supportsCustomEndpoint,
    customModels,
    piAvailableModels,
    codexAvailableModels,
    opencodeAvailableModels,
    t,
  ]);

  // The group the current selection belongs to. claude: the bound config
  // (stale bindings — config deleted — resolve to nothing, like the chip
  // label). pi/codex/opencode: the supplier of the selected model ref.
  const activeGroup = useMemo((): NormGroup | undefined => {
    if (isClaude) {
      return customModelId ? groups.find((g) => g.key === customModelId) : undefined;
    }
    if (isPi || isCodex || isOpencode) {
      const list = isPi
        ? piAvailableModels
        : isCodex
          ? codexAvailableModels
          : opencodeAvailableModels;
      const entry = list.find((b) => b.id === model);
      if (!entry) return undefined;
      const supplier = entry.supplier ?? entry.id.split("/")[0] ?? entry.id;
      return groups.find((g) => g.key === supplier);
    }
    return undefined;
  }, [
    isClaude,
    isPi,
    isCodex,
    isOpencode,
    customModelId,
    model,
    groups,
    piAvailableModels,
    codexAvailableModels,
    opencodeAvailableModels,
  ]);

  // The group whose model list the models view renders: the active one, or —
  // when nothing is picked yet but exactly one group exists (the common
  // single-endpoint setup) — that one, so first-time users see models
  // directly instead of a single-row config list.
  const listGroup = activeGroup ?? (groups.length === 1 ? groups[0] : undefined);
  // Opening resets the view: straight to models when a group is (or can be)
  // implied, the config list first otherwise. Builtin-only providers (no
  // group concept) always land on the flat models view.
  const handleOpenChange = (o: boolean): void => {
    setOpen(o);
    if (o) setView(!hasGroups || listGroup ? "models" : "configs");
  };

  // Thinking ladder for the CURRENT binding — the exact chain the standalone
  // effort chip resolves (provider capabilities filtered by the model's
  // thinking declaration / pi map / opencode variants). Controlled mode has
  // no effort binding → no ladder, no slider.
  const levels = controller
    ? undefined
    : resolveEffortLevels({
        providerLevels: provider?.capabilities.thinkingLevels,
        customModels,
        customModelId,
        model,
        providerId,
        piModelMaps,
        opencodeModelVariants,
      });
  const setEffort = controller ? undefined : storeSetEffort;
  const effort = controller ? "" : storeEffort;

  // Chip label: resolve the current `model` against the ACTIVE provider's
  // model surface only. Model ids are per-provider (claude uses gateway model
  // ids like "deepseek-v4-pro"; pi uses "provider/modelId" strings), so a
  // leftover value from another provider must never leak into the label.
  //   - custom config  → only when this provider supports custom endpoints
  //   - dynamic lists  → resolved from pi/codex/opencode available models
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
  const codexModel = isCodex ? codexAvailableModels.find((b) => b.id === model) : undefined;
  const opencodeModel = isOpencode ? opencodeAvailableModels.find((b) => b.id === model) : undefined;
  const unselected = !(activeCustom
    ? activeEntry
    : piModel ?? codexModel ?? opencodeModel ?? builtin);
  const chipLabel = activeCustom
    ? (activeEntry?.id ?? t("chat.model.unselected"))
    : piModel?.label ?? codexModel?.label ?? opencodeModel?.label ?? builtin?.label ?? t("chat.model.unselected");

  const activeLevel = levels?.find((l) => l.value === effort);
  const effortLabel = activeLevel?.label ?? effort;
  const fullHintOf = (m: ThinkingLevelOption): string => {
    const key = EFFORT_HINT_KEYS[`${providerId}:${m.value}`] ?? EFFORT_HINT_KEYS[m.value];
    return key ? t(key, { provider: provider?.displayName ?? "" }) : (m.hint ?? "");
  };
  // The slider needs at least two stops to be meaningful; a single-option
  // ladder just shows its (fixed) label on the chip. The effort suffix needs
  // a picked model — an unselected chip would read "选择模型 · High".
  const sliderLevels = levels && levels.length >= 2 ? levels : undefined;
  const showEffort = !controller && !!levels?.length && !unselected;

  // Send-time "no model picked" guard: the store bumps `modelGuardPulse`
  // instead of firing a global toast, and the chip answers in place — a short
  // shake plus a small floating "请先选择模型" hint right above it (portal, so
  // the composer card's overflow-hidden can't clip it). The pulse is a
  // monotonic counter, so a repeat blocked send re-triggers the nudge even
  // though the value only ever grows. The chip and the guard read the same
  // model surface, so a pulse always coincides with `unselected`.
  // (Controlled mode — the task editor — never nudges: an unrelated chat
  // send's guard must not shake the dialog's chip.)
  const storeGuardPulse = useSessionStore((s) => s.modelGuardPulse);
  const modelGuardPulse = controller ? 0 : storeGuardPulse;
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [nudge, setNudge] = useState(false);
  const [hint, setHint] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!modelGuardPulse) return;
    const rect = triggerRef.current?.getBoundingClientRect();
    // A hidden instance (popup host not mounted — the row layout only
    // exists while the toggle popup is open) has no anchor.
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
  // Suppression covers the popup AND the hint bubble (both portal above the
  // DOM) — but only when one of them actually reaches the browser's rect;
  // unmounted popups' refs measure null and are skipped (see
  // useSuppressBrowserView). One popup now: the drill-down swaps content in
  // place, there are no nested submenus to suppress.
  const popupRef = useRef<HTMLDivElement>(null);
  const hintRef = useRef<HTMLDivElement>(null);
  useSuppressBrowserView(open || hint !== null, [popupRef, hintRef]);

  // Group / model picks. Group pick = select the group's first model (the
  // models view opens on it immediately, one click re-picks if wanted).
  // Both keep the popup open — choosing a model and its effort is one
  // interaction now.
  const pickGroup = (g: NormGroup): void => {
    const first = g.models[0];
    if (!first) return;
    if (isClaude) setCustomModel(g.key, first.id);
    else setModel(first.id);
    setView("models");
  };
  const pickModel = (g: NormGroup, m: NormModel): void => {
    if (isClaude) setCustomModel(g.key, m.id);
    else setModel(m.id);
  };

  // "管理模型" lands on the unified model-config settings section. claude
  // (custom endpoints), pi (models.json providers), codex (Responses-API
  // providers) and opencode live on the same "custom-models" page,
  // distinguished by a type badge in its left list.
  const manageTarget: string | null =
    isPi || isClaude || isCodex || isOpencode ? "custom-models" : null;

  const rowCls = (active: boolean) =>
    cn(
      "flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[13px] outline-none select-none",
      "data-[highlighted]:bg-surface-muted",
      active ? "text-accent" : "text-content-muted",
    );

  return (
    <>
      <Menu.Root open={open} onOpenChange={handleOpenChange}>
        <Menu.Trigger
          className={cn(
            stacked
              ? "flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-[13px] outline-none select-none transition-colors duration-100 text-content-muted hover:bg-surface-muted hover:text-content"
              : "composer-minipill-seg",
            // Nothing picked yet: nudge with the accent tone so the composer
            // visibly asks for a choice instead of reading as "auto". Inline
            // on the pill segment — its unlayered CSS color beats Tailwind.
            unselected && !stacked && "text-accent",
            // Blocked-send pulse from the store guard (see the effect above).
            nudge && "model-chip-nudge",
          )}
          style={!stacked && unselected ? { color: "rgb(var(--accent))" } : undefined}
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
                <span className={cn("min-w-0 truncate text-xs", unselected ? "text-accent" : "text-content-muted")}>
                  {showEffort ? `${chipLabel} · ${effortLabel}` : chipLabel}
                </span>
                <IconChevronRight size={12} className="shrink-0 opacity-60" />
              </span>
            </>
          ) : (
            <>
              <IconCpu size={13} className="shrink-0 opacity-80" />
              <span className="composer-lblwrap">
                <span className="flex min-w-0 max-w-[160px] items-center gap-1">
                  <span className="truncate">{chipLabel}</span>
                  {showEffort && (
                    <>
                      <span className="shrink-0 text-content-subtle">·</span>
                      <span className="shrink-0 font-semibold">{effortLabel}</span>
                    </>
                  )}
                </span>
              </span>
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
              ref={popupRef}
              className={cn(
                "z-50 w-72 rounded-lg border border-edge bg-surface py-1.5 shadow-2xl",
                cascade ? "origin-top-left" : "origin-bottom-left",
                "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
                "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
                "transition-[transform,opacity] duration-100",
              )}
            >
              {/* ── models view: group header + flat model list + effort ── */}
              {view === "models" && (
                <>
                  {/* Built-in aliases (provider-declared, no group concept).
                      Claude/Pi/Codex/OpenCode all use the grouped surface
                      instead; future providers that declare builtinModels
                      surface them here. */}
                  {!hasGroups && builtinModels.length > 0 && (
                    <div className="border-b border-edge/60 pb-1">
                      <div className="px-3 py-1 text-xs uppercase tracking-wide text-content-subtle">
                        {t("chat.model.builtin")}
                      </div>
                      {builtinModels.map((b) => {
                        const active = !activeCustom && model === b.id;
                        return (
                          <Menu.Item
                            key={b.id}
                            closeOnClick={false}
                            onClick={() => setCustomModel(null, b.id)}
                            className={rowCls(active)}
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

                  {/* Group header: avatar + config/supplier name; click
                      drills to the config list. Hidden for builtin-only
                      providers (nothing to drill into). */}
                  {hasGroups && listGroup && (
                    <>
                      <div className="px-1 pt-0.5">
                        <button
                          type="button"
                          onClick={() => setView("configs")}
                          title={listGroup.rowTitle ?? listGroup.name}
                          className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left outline-none select-none transition-colors duration-100 hover:bg-surface-muted data-[focus-visible]:outline data-[focus-visible]:outline-2 data-[focus-visible]:outline-accent/60"
                        >
                          <span
                            className="model-group-avatar"
                            style={{ background: avatarColor(listGroup.key) }}
                            aria-hidden
                          >
                            {initialOf(listGroup.name)}
                          </span>
                          <span className="truncate text-[13px] font-semibold text-content">
                            {listGroup.name}
                          </span>
                          {listGroup.host && (
                            <span className="min-w-0 truncate text-[11px] text-content-subtle">
                              {listGroup.host}
                            </span>
                          )}
                          <IconChevronRight size={13} className="ml-auto shrink-0 opacity-60" />
                        </button>
                      </div>
                      <div className="my-1 border-t border-edge/60" />
                      <div className="flex items-center justify-between px-3 py-1">
                        <span className="text-xs uppercase tracking-wide text-content-subtle">
                          {t("chat.model.list")}
                        </span>
                        <span className="text-xs text-content-subtle">{listGroup.models.length}</span>
                      </div>
                      {listGroup.models.map((m) => {
                        const active = isClaude
                          ? customModelId === listGroup.key && model === m.id
                          : model === m.id;
                        return (
                          <Menu.Item
                            key={m.id}
                            closeOnClick={false}
                            onClick={() => pickModel(listGroup, m)}
                            className={rowCls(active)}
                          >
                            <span className="flex min-w-0 items-center gap-2">
                              <span className="truncate">{m.label}</span>
                              {m.badges.map((b) => (
                                <span
                                  key={b.text}
                                  className={cn("shrink-0 rounded px-1 text-[10px]", BADGE_TONE[b.tone])}
                                >
                                  {b.text}
                                </span>
                              ))}
                            </span>
                            {active && <IconCheck size={14} className="shrink-0" />}
                          </Menu.Item>
                        );
                      })}
                      {listGroup.models.length === 0 && (
                        <div className="px-3 py-2 text-[13px] text-content-subtle">
                          {t("chat.model.noneAvailable")}
                        </div>
                      )}

                      {/* Thinking ladder for the current binding — hidden
                          entirely when the model declares no controllable
                          effort (resolveEffortLevels → [] / undefined) or a
                          single fixed stop. */}
                      {sliderLevels && setEffort && (
                        <>
                          <div className="my-1 border-t border-edge/60" />
                          <div className="model-effort">
                            <div className="flex items-center justify-between px-3 pb-0.5">
                              <span className="text-xs uppercase tracking-wide text-content-subtle">
                                {t("chat.effort.section")}
                              </span>
                              <span className="text-[11.5px] font-bold text-accent-strong">
                                {effortLabel}
                              </span>
                            </div>
                            <EffortSlider
                              levels={sliderLevels}
                              value={effort}
                              onChange={(v) => setEffort(v)}
                              hintOf={fullHintOf}
                            />
                          </div>
                        </>
                      )}
                    </>
                  )}

                  {/* Empty states. Claude with no configs nudges toward
                      configuration; pi/codex toward their panels; opencode
                      and group-less providers fall back to "none available"
                      (the historical behavior). */}
                  {hasGroups && !listGroup && (
                    <div className="px-3 py-2 text-[13px] text-content-subtle">
                      {isClaude || isPi || isCodex
                        ? t("chat.model.notConfigured")
                        : t("chat.model.noneAvailable")}
                    </div>
                  )}
                  {!hasGroups && builtinModels.length === 0 && (
                    <div className="px-3 py-2 text-[13px] text-content-subtle">
                      {t("chat.model.noneAvailable")}
                    </div>
                  )}
                </>
              )}

              {/* ── configs view: the group list (drill-down target) ── */}
              {view === "configs" && (
                <>
                  <div className="px-1 pt-0.5">
                    <Menu.Item
                      closeOnClick={false}
                      onClick={() => setView("models")}
                      className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[12.5px] font-semibold text-content outline-none select-none transition-colors duration-100 data-[highlighted]:bg-surface-muted"
                    >
                      <IconChevronLeft size={14} className="shrink-0 opacity-70" />
                      {t("chat.model.configsTitle")}
                    </Menu.Item>
                  </div>
                  <div className="my-1 border-t border-edge/60" />
                  {groups.map((g) => {
                    const isActive = activeGroup?.key === g.key;
                    const pickable = g.models.length > 0;
                    const rowContent = (
                      <>
                        <span className="flex min-w-0 items-center gap-2">
                          <span
                            className="model-group-avatar"
                            style={{ background: avatarColor(g.key) }}
                            aria-hidden
                          >
                            {initialOf(g.name)}
                          </span>
                          <span className="truncate font-medium">{g.name}</span>
                        </span>
                        <span className="ml-2 flex shrink-0 items-center gap-1.5">
                          {g.host && (
                            <span className="min-w-0 truncate text-[11px] text-content-subtle">
                              {g.host}
                            </span>
                          )}
                          {!isClaude && (
                            <span className="shrink-0 text-xs text-content-subtle">{g.models.length}</span>
                          )}
                          {isActive && <IconCheck size={14} className="shrink-0" />}
                        </span>
                      </>
                    );
                    return pickable ? (
                      <Menu.Item
                        key={g.key}
                        closeOnClick={false}
                        onClick={() => pickGroup(g)}
                        title={g.rowTitle}
                        className={rowCls(false)}
                      >
                        {rowContent}
                      </Menu.Item>
                    ) : (
                      <div key={g.key} className={rowCls(false)} title={g.rowTitle}>
                        {rowContent}
                      </div>
                    );
                  })}
                </>
              )}

              {/* Manage-models entry — shown for providers that own a model
                  configuration surface (claude + pi + codex + opencode). All
                  live on the unified "custom-models" settings page,
                  distinguished by a type badge in its left list. (Hidden in
                  controlled mode — a settings detour out of the task editor
                  dialog reads as a dead end.) This one DOES close: it
                  navigates away. */}
              {manageTarget && !controller && (
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
            ref={hintRef}
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
