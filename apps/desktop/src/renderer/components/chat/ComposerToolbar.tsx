import { useSessionStore, EMPTY_USAGE } from "@renderer/stores/sessionStore.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { IconChartBar } from "@renderer/lib/icons.js";
import { ModelDropdown } from "./ModelDropdown.js";
import { EffortChip, PermissionChip } from "./EffortPermissionControl.js";
import { ContextRing } from "./ContextRing.js";
import { AttachMenuButton } from "./AttachMenuButton.js";

/**
 * In-composer session-config controls — the mini pill (prototypes/
 * composer-redesign.html 方案 B, single-pill revision). One implementation,
 * two presentations:
 *
 * - layout="pill" (default): the ONLY inline presentation, rendered at every
 *   composer width. One bordered container whose segments are, in order:
 *   attach "+" → model → effort → permission → context ring. Every segment
 *   is its own trigger opening the very same menus/popovers as before, so
 *   "which model / level / permission" stays readable AND directly clickable
 *   no matter how narrow the card gets; the + and the ring persist through
 *   every tier (the user-facing requirement). `compact` (tier 1, see
 *   useComposerRowFit) collapses the segment labels through animatable grid
 *   shells (`.composer-lblwrap`) — icons + effort level bars + permission
 *   color remain; the ring's % number collapses the same way, the ring
 *   itself stays.
 *
 * - layout="row": the vertical settings list hosted inside the collapsed
 *   hosts' toggle popup ({@link ComposerToolbarToggle} — side-chat panel /
 *   phone shell). Each control becomes a full-width labelled row — field
 *   name on the left, current value on the right — so the whole next-turn
 *   config is scannable at a glance without opening any dropdown, and hit
 *   targets span the panel width. The dropdown menus fly out to the RIGHT of
 *   their row (cascading, like a context menu) so the list itself stays
 *   visible while choosing; on phone-class viewports — where panel + menu
 *   can't sit side by side — they open upward instead (see
 *   useNarrowViewport). The ContextRing closes the list as a read-only
 *   status row behind a top border — it indicates, it doesn't select.
 *
 * NOTE: the SDK picker ({@link ProviderDropdown}) is deliberately NOT part
 * of the pill — it lives directly to the left of the send button in
 * ChatPane, so it stays visible (and locked per-session) regardless of the
 * pill's compactness.
 */
export function ComposerToolbar({
  sessionId,
  layout = "pill",
  compact = false,
  attachDisabled = false,
  onPickFiles,
  onPickImages,
  onSlashCommand,
}: {
  sessionId: string;
  /** Presentation: inline mini pill ("pill") vs vertical settings list
   *  ("row"). */
  layout?: "pill" | "row";
  /** Pill only: collapse segment labels to icons (tier 1). */
  compact?: boolean;
  /** Pill only: forwarded to the attach segment's disabled state (input is
   *  blocked while an approval / question prompt owns the composer). */
  attachDisabled?: boolean;
  /** Pill only: attach-segment actions (same callbacks the standalone
   *  AttachMenuButton took in ChatPane). */
  onPickFiles?: () => void;
  onPickImages?: () => void;
  onSlashCommand?: () => void;
}) {
  const { t } = useI18n();
  // Context-window snapshot for THIS pane's session. Drives the ring segment
  // (pill) / status row (row layout). Undefined until the first
  // token-usage.updated event arrives (or a persisted snapshot is hydrated
  // from the session row). Reading the pane's own sessionId (not the global
  // activeSessionId) means a backgrounded tab's toolbar no longer
  // re-renders when the foreground tab changes — each toolbar tracks its own
  // session.
  const contextSnapshot = useSessionStore((s) => s.contextSnapshotBySession[sessionId]);
  // Per-session finalized-turn usage records, feeding the ring's history view.
  // `?? EMPTY_USAGE` keeps the selector's return stable across renders (a
  // bare `?? []` would create a new array each time and trip re-renders).
  const usageHistory = useSessionStore((s) => s.usageHistoryBySession[sessionId] ?? EMPTY_USAGE);
  // Pill only: which segments render (a provider may declare no thinking
  // levels or no permission modes — dividers must not dangle around an
  // absent segment).
  const providerId = useSessionStore((s) => s.providerId);
  const providers = useSessionStore((s) => s.providers);
  const caps = providers.find((p) => p.id === providerId)?.capabilities;
  const hasEffort = (caps?.thinkingLevels?.length ?? 0) > 0;
  const hasPerm = (caps?.permissionModes?.length ?? 0) > 0;

  if (layout === "row") {
    return (
      <div className="flex w-72 flex-col items-stretch gap-0.5">
        <ModelDropdown layout="row" />
        <EffortChip layout="row" />
        <PermissionChip layout="row" />
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

  // The mini pill: attach → model → effort → permission → ring, each a
  // separately-clickable segment behind a hairline divider. The attach and
  // ring segments never collapse (the + and the ring must stay visible at
  // every width); labels collapse under `compact` via CSS grid shells keyed
  // off data-compact.
  const hasAttach = !!onPickFiles && !!onPickImages && !!onSlashCommand;
  return (
    <div className="composer-minipill" data-compact={compact ? "1" : "0"}>
      {hasAttach && (
        <>
          <AttachMenuButton
            segment
            disabled={attachDisabled}
            onPickFiles={onPickFiles}
            onPickImages={onPickImages}
            onSlashCommand={onSlashCommand}
          />
          <span className="composer-minipill-mid" aria-hidden />
        </>
      )}
      <ModelDropdown layout="pill" />
      {hasEffort && (
        <>
          <span className="composer-minipill-mid" aria-hidden />
          <EffortChip layout="pill" />
        </>
      )}
      {hasPerm && (
        <>
          <span className="composer-minipill-mid" aria-hidden />
          <PermissionChip layout="pill" />
        </>
      )}
      {contextSnapshot && (
        <>
          <span className="composer-minipill-mid" aria-hidden />
          <span className="composer-minipill-ringseg">
            <ContextRing snapshot={contextSnapshot} history={usageHistory} />
          </span>
        </>
      )}
    </div>
  );
}
