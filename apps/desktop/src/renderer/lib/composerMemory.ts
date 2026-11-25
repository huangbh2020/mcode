/**
 * Merge policy for the composer's per-provider remembered entry
 * (`lastModelByProvider` — the "new session" defaults, persisted under
 * `ui.composerModel`).
 *
 * The VIEW slots are not a reliable snapshot source: syncConfigFromSession
 * re-seeds them from whatever session row the user visits, and rows that were
 * created while nothing was picked (placeholder "New session", unselected
 * threads) carry `model:"default", customModelId:null`. A raw snapshot at
 * that moment would silently DESTROY the standing pick — the exact "new
 * session resets to 选择模型 / default effort / default permission" bug.
 *
 * Policy: the (model, customModelId) BINDING is upgrade-only — a non-default
 * incoming pick overwrites it as a pair; a default incoming binding keeps the
 * previous non-default binding. effort / permissionMode ALWAYS take the
 * incoming values (tweaking permission on an unselected thread is still a
 * legitimate pick worth remembering). Pure function — no store imports — so
 * the smoke can exercise it directly.
 */
import type { EffortLevel, PermissionMode } from "@contracts/runtime.js";

export interface RememberedComposerEntry {
  model: string;
  customModelId: string | null;
  /** Optional: older persisted entries carry only the model binding. */
  effort?: EffortLevel;
  permissionMode?: PermissionMode;
}

export function mergeRememberedEntry(
  prev: RememberedComposerEntry | undefined,
  incoming: {
    model: string;
    customModelId: string | null;
    effort: EffortLevel;
    permissionMode: PermissionMode;
  },
): RememberedComposerEntry {
  const upgrade = incoming.model !== "default";
  return {
    model: upgrade ? incoming.model : (prev?.model ?? incoming.model),
    customModelId: upgrade ? incoming.customModelId : (prev?.customModelId ?? incoming.customModelId),
    effort: incoming.effort,
    permissionMode: incoming.permissionMode,
  };
}
