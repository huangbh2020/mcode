import { useSessionStore, EMPTY_USAGE } from "@renderer/stores/sessionStore.js";
import { ModelDropdown } from "./ModelDropdown.js";
import { EffortDropdown } from "./EffortDropdown.js";
import { PermissionModeDropdown } from "./PermissionModeDropdown.js";
import { ContextRing } from "./ContextRing.js";

/**
 * In-composer option chips (Codex-style). Renders as a row meant to sit at the
 * *bottom* of the composer box, left-aligned, sharing a line with the send
 * button. Compact + muted so the textarea stays the focal point.
 *
 * - Model: dropdown (built-in + custom configs).
 * - Effort: dropdown (Auto → Max), same base-ui Menu style as Permission.
 * - Permission mode: dropdown showing the 4 user-facing modes.
 * - Context ring: occupancy indicator for the active session, pinned at the
 *   right end of the chip row (after Permission). Sits inline rather than
 *   overlapping the textarea, so it never covers typed text. Click it to open
 *   the context-stats popover (live breakdown + per-turn history).
 *
 * NOTE: the SDK picker ({@link ProviderDropdown}) is deliberately NOT part of
 * this row — it lives directly to the left of the send button in ChatPane, so
 * it stays visible (and locked per-session) regardless of chip-row collapse.
 */
export function ComposerToolbar({ sessionId }: { sessionId: string }) {
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
