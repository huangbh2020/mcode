import { useRef, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { cn } from "@renderer/lib/cn.js";
import {
  IconCheck,
  IconBolt,
  IconShield,
  IconShieldCheck,
  IconShieldHalfFilled,
  IconShieldLock,
  IconChevronRight,
} from "@renderer/lib/icons.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useSuppressBrowserView } from "@renderer/hooks/useSuppressBrowserView.js";
import { useNarrowViewport } from "@renderer/hooks/useNarrowViewport.js";
import type { PermissionModeOption, ThinkingLevelOption } from "@contracts/provider";

/**
 * Thinking-level and permission-mode pickers for the composer toolbar.
 * Each opens a block-grid popover where every option is a tappable tile
 * (label + a 2–4-word caption). Selections apply immediately and the panel
 * stays open; Esc / outside click closes.
 *
 * Both lists are NOT hardcoded — they come from the active provider's
 * `capabilities.thinkingLevels` / `capabilities.permissionModes` declarations,
 * so a third provider needs zero UI changes; a provider that declares neither
 * list hides the corresponding segment entirely (`null`).
 *
 * Tile captions resolve through the dictionary provider-qualified first
 * (`"<providerId>:<value>"` — codex's level/mode semantics are its own), then
 * the generic key, then the provider-declared hint. The tile's `title`
 * attribute carries the FULL hint (same resolution chain through the
 * EFFORT_HINT_KEYS / PERMISSION_HINT_KEYS maps) so the concise caption never
 * loses the detailed wording. Labels (Auto/Low/…) are intentionally
 * locale-neutral and stay as declared.
 *
 * Grid density adapts: >6 thinking levels switch 3→4 columns, 4+ permission
 * modes switch 3→2 columns — the panel keeps a constant width for any
 * provider (codex's 8 levels don't stretch it).
 *
 * Presentation: layout="pill" (default) renders the picker as a segment of
 * the composer's mini pill (see ComposerToolbar); layout="row" (the
 * collapsed-hosts toggle popup) renders a full-width settings row and opens
 * the panel to the RIGHT of the row (cascading like the old menus); on
 * phone-class viewports it opens upward instead. The popover renders through
 * Popover.Portal so it isn't clipped by the composer card's overflow.
 */

/** Full-hint i18n keys by level value (provider-qualified entries first) —
 *  used for the tile `title` tooltip. */
const EFFORT_HINT_KEYS: Record<string, MessageId> = {
  default: "chat.effort.hintDefault",
  off: "chat.effort.hintOff",
  minimal: "chat.effort.hintMinimal",
  low: "chat.effort.hintLow",
  medium: "chat.effort.hintMedium",
  high: "chat.effort.hintHigh",
  xhigh: "chat.effort.hintXhigh",
  max: "chat.effort.hintMax",
  "codex-sdk:default": "chat.effort.hintCodexDefault",
  "codex-sdk:minimal": "chat.effort.hintCodexMinimal",
  "codex-sdk:low": "chat.effort.hintCodexLow",
  "codex-sdk:medium": "chat.effort.hintCodexMedium",
  "codex-sdk:high": "chat.effort.hintCodexHigh",
  "codex-sdk:xhigh": "chat.effort.hintCodexXhigh",
  "codex-sdk:max": "chat.effort.hintCodexMax",
  "codex-sdk:ultra": "chat.effort.hintCodexUltra",
};

/** Short tile captions by level value (provider-qualified entries first). */
const EFFORT_TILE_KEYS: Record<string, MessageId> = {
  default: "chat.effort.tileDefault",
  off: "chat.effort.tileOff",
  minimal: "chat.effort.tileMinimal",
  low: "chat.effort.tileLow",
  medium: "chat.effort.tileMedium",
  high: "chat.effort.tileHigh",
  xhigh: "chat.effort.tileXhigh",
  max: "chat.effort.tileMax",
  "codex-sdk:default": "chat.effort.tileCodexDefault",
  "codex-sdk:minimal": "chat.effort.tileCodexMinimal",
  "codex-sdk:low": "chat.effort.tileCodexLow",
  "codex-sdk:medium": "chat.effort.tileCodexMedium",
  "codex-sdk:high": "chat.effort.tileCodexHigh",
  "codex-sdk:xhigh": "chat.effort.tileCodexXhigh",
  "codex-sdk:max": "chat.effort.tileCodexMax",
  "codex-sdk:ultra": "chat.effort.tileCodexUltra",
};

/** Full-hint i18n keys by mode value (provider-qualified entries first). */
const PERMISSION_HINT_KEYS: Record<string, MessageId> = {
  default: "chat.permission.hintDefault",
  acceptEdits: "chat.permission.hintAcceptEdits",
  plan: "chat.permission.hintPlan",
  bypassPermissions: "chat.permission.hintBypass",
  "codex-sdk:read-only": "chat.permission.hintCodexReadOnly",
  "codex-sdk:default": "chat.permission.hintCodexDefault",
  "codex-sdk:full-access": "chat.permission.hintCodexFullAccess",
};

/** Short tile captions by mode value (provider-qualified entries first). */
const PERMISSION_TILE_KEYS: Record<string, MessageId> = {
  plan: "chat.permission.tilePlan",
  default: "chat.permission.tileDefault",
  acceptEdits: "chat.permission.tileAcceptEdits",
  bypassPermissions: "chat.permission.tileBypass",
  "codex-sdk:read-only": "chat.permission.tileCodexReadOnly",
  "codex-sdk:default": "chat.permission.tileCodexDefault",
  "codex-sdk:full-access": "chat.permission.tileCodexFullAccess",
};

/** Fallback label used when the current permission value isn't in the
 *  provider's list (e.g. dontAsk/auto persisted for claude sessions). */
const FALLBACK_LABEL: Record<string, string> = {
  default: "Default",
  acceptEdits: "Edit Auto",
  plan: "Plan",
  bypassPermissions: "Bypass",
  dontAsk: "DontAsk",
  auto: "Auto",
};

/** Grid ordering for the permission blocks (low → high risk). Unknown/future
 *  values keep their declaration order after the known ones. */
const RISK_RANK: Record<string, number> = {
  plan: 0,
  "read-only": 0,
  default: 1,
  acceptEdits: 2,
  bypassPermissions: 3,
  "full-access": 3,
};

/** Icon components by declaration name; resolved at render time so the
 *  renderer's icon map stays the single source of truth — the contract only
 *  carries a string name, never a component. */
const ICON_BY_NAME: Record<string, React.ComponentType<{ size?: number }>> = {
  shield: IconShield,
  shieldCheck: IconShieldCheck,
  shieldHalf: IconShieldHalfFilled,
  shieldLock: IconShieldLock,
};

/** Resolve a permission mode's icon name to a rendered icon node. Falls back
 *  to the neutral shield for unknown icon names. */
function resolveIcon(m: PermissionModeOption, size: number): React.ReactNode {
  const Cmp = (m.icon && ICON_BY_NAME[m.icon]) || IconShield;
  return <Cmp size={size} />;
}

/** Map a mode's semantic color class ("text-warning"…) to the CSS custom
 *  property powering it ("var(--warning)"), for inline tile styling.
 *  Returns null for the neutral baseline. */
function colorVarOf(color: string | undefined): string | null {
  if (!color) return null;
  if (color.includes("info")) return "var(--info)";
  if (color.includes("warning")) return "var(--warning)";
  if (color.includes("danger")) return "var(--danger)";
  return null;
}

/** Shared popover chrome: z must live on the POSITIONER (floating-ui
 *  positions via transform, creating a stacking context — a z-50 on the
 *  popup alone is trapped inside a z-auto positioner and loses to the center
 *  pane's z-10; see ComposerToolbarToggle). */
function PanelPopup({
  popupRef,
  cascade,
  children,
}: {
  popupRef: React.Ref<HTMLDivElement>;
  cascade: boolean;
  children: React.ReactNode;
}) {
  return (
    <Popover.Portal>
      <Popover.Positioner
        side={cascade ? "right" : "top"}
        align="start"
        sideOffset={cascade ? 6 : 6}
        className="z-50"
      >
        <Popover.Popup
          ref={popupRef}
          className={cn(
            "z-50 rounded-xl border border-edge bg-surface py-1 shadow-2xl",
            cascade ? "origin-top-left" : "origin-bottom-left",
            "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
            "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
            "transition-[transform,opacity] duration-100",
          )}
        >
          {children}
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  );
}

/** Section header: dictionary section title left, current value right. */
function SectionHeader({
  title,
  value,
  valueColorVar,
  icon,
}: {
  title: string;
  value: string;
  valueColorVar?: string | null;
  icon: React.ReactNode;
}) {
  return (
    <header className="mb-2 flex items-center justify-between">
      <span className="text-[10px] font-semibold tracking-wide text-content-subtle uppercase">
        {title}
      </span>
      <span
        className={cn(
          "flex items-center gap-1 text-[11.5px] font-bold",
          !valueColorVar && "text-accent-strong",
        )}
        style={valueColorVar ? { color: `rgb(${valueColorVar})` } : undefined}
      >
        {icon}
        {value}
      </span>
    </header>
  );
}

/** Thinking-level bar indicator for the mini pill (prototypes 方案 B): one
 *  bar per level (capped at 5 — codex declares 8, and 8 bars outgrow the
 *  segment), lit up to the active level's rank. Purely decorative; the
 *  segment's title and the popover carry the real value. */
function LevelBars({ count, activeIndex }: { count: number; activeIndex: number }) {
  const barCount = Math.min(count, 5);
  const lit =
    activeIndex < 0 ? 0 : Math.max(1, Math.round(((activeIndex + 1) / count) * barCount));
  return (
    <span className="composer-lvlbars" aria-hidden>
      {Array.from({ length: barCount }, (_, i) => (
        <span key={i} className={i < lit ? "on" : undefined} style={{ height: 5 + i * 2 }} />
      ))}
    </span>
  );
}

/** Thinking-level block picker. */
export function EffortChip({
  layout = "pill",
}: {
  /** Presentation: pill segment ("pill") vs settings row ("row"). */
  layout?: "pill" | "row";
}) {
  const stacked = layout === "row";
  // Stacked rows cascade to the RIGHT; phone-class viewports have no room
  // for panel + popover side by side, so they open upward instead. Chip mode
  // always opens upward.
  const cascade = stacked && !useNarrowViewport();
  const { t } = useI18n();
  // While the popover is open the embedded browser view is suppressed — but
  // only when the portaled popup actually reaches the browser's rect (the
  // ref lets useSuppressBrowserView measure it). See useSuppressBrowserView.
  const [open, setOpen] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  useSuppressBrowserView(open, popupRef);
  const effort = useSessionStore((s) => s.effort);
  const setEffort = useSessionStore((s) => s.setEffort);
  const providerId = useSessionStore((s) => s.providerId);
  const providers = useSessionStore((s) => s.providers);

  const provider = providers.find((p) => p.id === providerId);
  const levels = provider?.capabilities.thinkingLevels;

  // Provider declares no thinking levels → hide the chip.
  if (!levels || levels.length === 0) return null;

  const activeLevel = levels.find((l) => l.value === effort);
  const effortLabel = activeLevel?.label ?? effort;
  const fullHintOf = (m: ThinkingLevelOption): string => {
    const key = EFFORT_HINT_KEYS[`${providerId}:${m.value}`] ?? EFFORT_HINT_KEYS[m.value];
    return key ? t(key, { provider: provider?.displayName ?? "" }) : (m.hint ?? "");
  };
  const tileOf = (m: ThinkingLevelOption): string => {
    const key = EFFORT_TILE_KEYS[`${providerId}:${m.value}`] ?? EFFORT_TILE_KEYS[m.value];
    return key ? t(key) : (m.hint ?? "");
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        className={cn(
          stacked
            ? "flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-[13px] outline-none select-none transition-colors duration-100 hover:bg-surface-muted text-content-muted"
            : "composer-minipill-seg text-content-muted",
          open && stacked && "bg-surface-muted",
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
              <span className="min-w-0 truncate text-xs text-content-muted">{effortLabel}</span>
              <IconChevronRight size={12} className="shrink-0 opacity-60" />
            </span>
          </>
        ) : (
          <>
            <IconBolt size={13} className="shrink-0 opacity-80" />
            <span className="composer-lblwrap">
              <span className="max-w-[72px] truncate">{effortLabel}</span>
            </span>
            <LevelBars
              count={levels.length}
              activeIndex={levels.findIndex((l) => l.value === effort)}
            />
          </>
        )}
      </Popover.Trigger>
      <PanelPopup popupRef={popupRef} cascade={cascade}>
        <div className="w-72 select-none px-3.5 pb-2.5 pt-2">
          <SectionHeader
            title={t("chat.effort.section")}
            value={effortLabel}
            icon={<IconBolt size={11} />}
          />
          {/* block grid: >6 levels switch 3→4 columns so the panel keeps a
              constant width (codex's 8 levels) */}
          <div className={cn("grid gap-1", levels.length > 6 ? "grid-cols-4" : "grid-cols-3")}>
            {levels.map((m) => {
              const active = m.value === effort;
              return (
                <button
                  key={m.value}
                  type="button"
                  onClick={() => setEffort(m.value)}
                  title={fullHintOf(m)}
                  className={cn(
                    "relative flex min-w-0 flex-col items-start gap-0.5 rounded-lg border px-2.5 py-1.5 text-left outline-none transition-colors duration-100",
                    "border-edge bg-surface hover:border-input-edge hover:bg-surface-hover/45",
                    active && "border-accent bg-accent/8",
                  )}
                >
                  <span className="max-w-full truncate text-[11.5px] leading-tight font-semibold text-content">
                    {m.label}
                  </span>
                  <span className="max-w-full truncate text-[9.5px] leading-tight text-content-subtle">
                    {tileOf(m)}
                  </span>
                  {active && (
                    <IconCheck size={11} className="absolute top-1 right-1 text-accent-strong" />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </PanelPopup>
    </Popover.Root>
  );
}

/** Permission-mode block picker. */
export function PermissionChip({
  layout = "pill",
}: {
  /** Presentation: pill segment ("pill") vs settings row ("row"). */
  layout?: "pill" | "row";
}) {
  const stacked = layout === "row";
  const cascade = stacked && !useNarrowViewport();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  useSuppressBrowserView(open, popupRef);
  const permissionMode = useSessionStore((s) => s.permissionMode);
  const setPermissionMode = useSessionStore((s) => s.setPermissionMode);
  const providerId = useSessionStore((s) => s.providerId);
  const providers = useSessionStore((s) => s.providers);

  const provider = providers.find((p) => p.id === providerId);
  const modes = provider?.capabilities.permissionModes;

  // Provider declares no permission modes → hide the chip.
  if (!modes || modes.length === 0) return null;

  // Low → high risk ordering; the selected tile keeps the mode's own
  // semantic color so the risk telegraph survives selection.
  const sortedModes = modes
    .map((m, i) => ({ m, rank: RISK_RANK[m.value] ?? 50 + i }))
    .sort((a, b) => a.rank - b.rank)
    .map((e) => e.m);
  const activeMode = modes.find((m) => m.value === permissionMode);
  const permLabel = activeMode?.label ?? FALLBACK_LABEL[permissionMode] ?? permissionMode;
  const permColorVar = colorVarOf(activeMode?.color);
  const fullHintOf = (m: PermissionModeOption): string => {
    const key = PERMISSION_HINT_KEYS[`${providerId}:${m.value}`] ?? PERMISSION_HINT_KEYS[m.value];
    return key ? t(key) : (m.hint ?? "");
  };
  const tileOf = (m: PermissionModeOption): string => {
    const key = PERMISSION_TILE_KEYS[`${providerId}:${m.value}`] ?? PERMISSION_TILE_KEYS[m.value];
    return key ? t(key) : (m.hint ?? "");
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        className={cn(
          stacked
            ? "flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-[13px] outline-none select-none transition-colors duration-100 hover:bg-surface-muted text-content-muted"
            : "composer-minipill-seg",
        )}
        // Pill segment: inline color so the semantic risk telegraph survives
        // (the segment's unlayered CSS color beats Tailwind classes).
        style={!stacked && permColorVar ? { color: `rgb(${permColorVar})` } : undefined}
        title="Permission mode for the next session"
      >
        {stacked ? (
          <>
            <span className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 opacity-90">
                {activeMode ? resolveIcon(activeMode, 14) : <IconShield size={14} />}
              </span>
              <span className="shrink-0 font-medium text-content">
                {t("chat.permission.rowLabel")}
              </span>
            </span>
            <span className="flex min-w-0 items-center gap-1">
              <span className={cn("min-w-0 truncate text-xs", activeMode?.color || "text-content-muted")}>
                {permLabel}
              </span>
              <IconChevronRight size={12} className="shrink-0 opacity-60" />
            </span>
          </>
        ) : (
          <>
            <span className="shrink-0 opacity-90">
              {activeMode ? resolveIcon(activeMode, 13) : <IconShield size={13} />}
            </span>
            <span className="composer-lblwrap">
              <span className="max-w-[84px] truncate">{permLabel}</span>
            </span>
          </>
        )}
      </Popover.Trigger>
      <PanelPopup popupRef={popupRef} cascade={cascade}>
        <div className="w-72 select-none px-3.5 pb-2.5 pt-2">
          <SectionHeader
            title={t("chat.permission.section")}
            value={permLabel}
            valueColorVar={permColorVar}
            icon={activeMode ? resolveIcon(activeMode, 11) : <IconShield size={11} />}
          />
          {/* block grid: 4+ modes → 2 columns, 3 → a single 3-wide row */}
          <div className={cn("grid gap-1", modes.length >= 4 ? "grid-cols-2" : "grid-cols-3")}>
            {sortedModes.map((m) => {
              const active = m.value === permissionMode;
              const cVar = colorVarOf(m.color);
              return (
                <button
                  key={m.value}
                  type="button"
                  onClick={() => setPermissionMode(m.value)}
                  title={fullHintOf(m)}
                  className={cn(
                    "relative flex min-w-0 flex-col items-start gap-0.5 rounded-lg border px-2.5 py-1.5 text-left outline-none transition-colors duration-100",
                    "border-edge bg-surface hover:border-input-edge hover:bg-surface-hover/45",
                    active && !cVar && "border-accent bg-accent/8",
                  )}
                  style={
                    active && cVar
                      ? { borderColor: `rgb(${cVar})`, background: `rgb(${cVar} / 0.06)` }
                      : undefined
                  }
                >
                  <span className="flex max-w-full items-center gap-1 text-[11.5px] leading-tight font-semibold text-content">
                    {resolveIcon(m, 11)}
                    <span className="truncate">{m.label}</span>
                  </span>
                  <span className="max-w-full truncate text-[9.5px] leading-tight text-content-subtle">
                    {tileOf(m)}
                  </span>
                  {active && (
                    <IconCheck
                      size={11}
                      className="absolute top-1 right-1"
                      style={{ color: cVar ? `rgb(${cVar})` : "rgb(var(--accent-strong))" }}
                    />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </PanelPopup>
    </Popover.Root>
  );
}
