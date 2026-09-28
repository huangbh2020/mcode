/**
 * User-defined agent prompt — read once per turn by every provider and appended
 * AFTER all built-in prompt fragments.
 *
 * Rationale: the Codex provider owns `CODEX_HOME/AGENTS.md` and rewrites it on
 * every turn (`ensureCodexHomeIdentity`), so hand-edits to that file are lost.
 * The user's text lives in the generic `settings` key/value table instead
 * (edited in the settings panel, key {@link AGENT_CUSTOM_PROMPT_SETTING_KEY}),
 * and each provider reads it here at turn start. Empty/whitespace-only = never
 * configured → callers inject nothing.
 */
import { AGENT_CUSTOM_PROMPT_SETTING_KEY } from "@contracts/ipc";
import { awaitDb } from "@main/store/db.js";
import { SettingRepo } from "@main/store/repositories.js";

/** The persisted custom prompt, trimmed, or null when unset/blank. */
export async function getCustomPromptSetting(): Promise<string | null> {
  await awaitDb();
  return SettingRepo.get(AGENT_CUSTOM_PROMPT_SETTING_KEY)?.trim() || null;
}
