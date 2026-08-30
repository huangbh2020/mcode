import { useSessionStore, EMPTY_USAGE } from "@renderer/stores/sessionStore.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { IconChartBar } from "@renderer/lib/icons.js";
import { ModelDropdown } from "./ModelDropdown.js";
import { EffortDropdown } from "./EffortDropdown.js";
import { PermissionModeDropdown } from "./PermissionModeDropdown.js";
import { ContextRing } from "./ContextRing.js";

/**
 * In-composer session-config controls. One implementation, two presentations:
 *
 * - layout="chip" (default): the Codex-style option chips rendered as a row
 *   meant to sit at the *bottom* of the composer box, left-aligned, sharing a
 *   line with the send button. Compact + muted so the textarea stays the
 *   focal point.
 *   - Model: dropdown (built-in + custom configs).
 *   - Effort: dropdown (Auto → Max), same base-ui Menu style as Permission.
 *   - Permission mode: dropdown showing the 4 user-facing modes. Kept as its
 *     own chip (not folded into a shared menu): the semantic color telegraphs
 *     risky modes (Edit Auto amber / Plan blue / Bypass red) at a glance, and
 *     each setting is directly reachable with one click.
 *   - Context ring: occupancy indicator for the active session, pinned at the
 *     right end of the chip row (after Permission).
 *
 * - layout="row": the vertical settings list hosted inside the narrow-mode
 *   toggle's popup ({@link ComposerToolbarToggle}). Each control becomes a
 *   full-width labelled row — field name on the left, current value on the
 *   right — so the whole next-turn config is scannable at a glance without
 *   opening any dropdown, and hit targets span the panel width (the popup is
 *   narrow precisely because space ran out; a horizontal chip strip there
 *   fought that constraint). The dropdown menus fly out to the RIGHT of
 *   their row (cascading, like a context menu) so the list itself stays
 *   visible while choosing; on phone-class viewports — where panel + menu
 *   can't sit side by side — they open upward instead (see
 *   useNarrowViewport). The ContextRing closes the list as a read-only
 *   status row behind a top border — it indicates, it doesn't select.
 *
 * NOTE: the SDK picker ({@link ProviderDropdown}) is deliberately NOT part of
 * this row — it lives directly to the left of the send button in ChatPane, so
 * it stays visible (and locked per-session) regardless of chip-row collapse.
 */
export function ComposerToolbar({
  sessionId,
  layout = "chip",
}: {
  sessionId: string;
  /** Presentation: inline chip row ("chip") vs vertical settings list ("row"). */
  layout?: "chip" | "row";
}) {
  const { t } = useI18n();
  // Context-window snapshot for THIS pane's session. Drives the ring at the
  // end of the chip row. Undefined until the first token-usage.updated event
  // arrives (or a persisted snapshot is hydrated from the session row).
  // Reading the pane's own sessionId (not the global activeSessionId) means a
  // backgrounded tab's toolbar no longer re-renders when the foreground tab
  // changes — each toolbar tracks its own session.
  const contextSnapshot = useSessionStore((s) => s.contextSnapshotBySession[sessionId]);
  // Per-session finalized-turn usage records, feeding the ring's history view.
  // `?? EMPTY_USAGE` keeps the selector's return stable across renders (a
  // bare `?? []` would create a new array each time and trip re-renders).
  const usageHistory = useSessionStore((s) => s.usageHistoryBySession[sessionId] ?? EMPTY_USAGE);

  if (layout === "row") {
    return (
      <div className="flex w-72 flex-col items-stretch gap-0.5">
        <ModelDropdown layout="row" />
        <EffortDropdown layout="row" />
        <PermissionModeDropdown layout="row" />
        {contextSnapshot && (
          <div className="mt-1 flex items-center justify-between gap-2 border-t border-edge/60 px-2.5 pt-2">
            <span className="flex items-center gap-2 text-[13px] font-medium text-content-muted">
              <IconChartBar size={14} className="shrink-0 opacity-80" />
              {t("chat.context.rowLabel")}
            </span>
            <ContextRing snapshot={contextSnapshot} history={usageHistory} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="composer-chips composer-chips-root flex min-w-0 items-center gap-1">
      <ModelDropdown />
      <EffortDropdown />
      <PermissionModeDropdown />
      {contextSnapshot && (
        <span className="ml-1 inline-flex shrink-0 items-center border-l border-edge/60 pl-2">
          <ContextRing snapshot={contextSnapshot} history={usageHistory} />
        </span>
      )}
    </div>
  );
}
