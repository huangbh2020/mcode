/**
 * Effective thinking-level list for the composer's effort chip.
 *
 * `ProviderCapabilities.thinkingLevels` is a PROVIDER-level declaration, but on
 * the Claude provider the levels only apply natively to Anthropic-protocol
 * turns. A session bound to an OpenAI-protocol custom endpoint must instead
 * show the levels that endpoint's selected MODEL accepts (`reasoning_effort`
 * ladder / `enable_thinking` toggle / nothing) — those are the only values the
 * bridge can actually deliver upstream (see `@contracts/customModel` and
 * `applyThinkingControl` in the bridge). Resolving them here, in ONE place,
 * keeps the composer chip, the coercion in sessionStore, the automation editor
 * and the orchestrator panel from drifting apart.
 *
 * Custom endpoints are a Claude-provider feature (`supportsCustomEndpoint`).
 * A non-null `customModelId` names one of the store's custom configs ONLY on
 * claude-sdk — the custom branch is provider-gated because a binding left over
 * from a Claude pick can survive a switch to pi/codex (pi model picks run
 * through `setModel`, which never touches the slot).
 */
import type { CustomModelPublic } from "@contracts/customModel";
import { effortLevelValuesForModel } from "@contracts/customModel";
import type { PiThinkingLevelMap } from "@contracts/piModel";
import type { ThinkingLevelOption } from "@contracts/provider";

/** Label for a raw level value: capitalized value ("low" → "Low"); "default"
 *  shows as "Auto", matching the short labels the providers declare for their
 *  own lists. */
function levelLabel(value: string): string {
  return value === "default" ? "Auto" : value.charAt(0).toUpperCase() + value.slice(1);
}

/** Build the option list for a model row's level VALUES (contracts'
 *  `effortLevelValuesForModel`). Hints stay empty — the chip's i18n maps
 *  resolve them by value at render time. */
export function levelsFromValues(values: string[]): ThinkingLevelOption[] {
  return values.map((value) => ({ value, label: levelLabel(value) }));
}

/** Snap an effort slot value onto a level list. The fallback chain mirrors
 *  how the underlying SDK picks a level when none is given:
 *
 *  1. value already in the list → keep it;
 *  2. list declares an explicit neutral slot ("default"/Auto — Claude, Codex)
 *     → snap there, exactly as before;
 *  3. list mirrors an SDK's raw ladder without a neutral slot (Pi: off..max)
 *     → snap to "medium", the Pi SDK's DEFAULT_THINKING_LEVEL — the concrete
 *     level Pi actually uses when nothing is passed. Never "off": that
 *     DISABLES thinking rather than deferring the choice.
 *  4. neither exists → keep the raw value (renders as-is, the historical
 *     out-of-list behavior).
 *
 *  Lists absent/empty return the input untouched (chip is hidden anyway). */
export function coerceEffortValue(
  value: string,
  levels: ThinkingLevelOption[] | undefined | null,
): string {
  if (!levels || levels.length === 0) return value;
  if (levels.some((l) => l.value === value)) return value;
  if (levels.some((l) => l.value === "default")) return "default";
  if (levels.some((l) => l.value === "medium")) return "medium";
  return value;
}

/** The thinking-level options the effort UI should offer for the CURRENT
 *  provider + model binding:
 *
 *  - provider declares none → `undefined` (hide the chip — unchanged behavior);
 *  - OpenAI-protocol custom model → the model's declared/inferred levels
 *    (`[]` = hide; thinking isn't controllable on that model);
 *  - pi model with a settings-panel thinkingLevelMap → the provider's list
 *    MINUS the levels the model maps to `null` (不支持 = "UI 隐藏该档", the
 *    mapping editor's documented contract; string/absent entries keep the
 *    level — absent = provider default, string = remapped wire value);
 *  - everything else (official Claude, Anthropic-protocol endpoints, Pi
 *    without a map, Codex) → the provider's own list, exactly as before.
 *
 *  `model` is the session's selected model id within the custom config; falls
 *  back to the config's first entry like the env builder does. */
export function resolveEffortLevels(args: {
  /** The provider's capability list (from the store's `providers`). */
  providerLevels: ThinkingLevelOption[] | undefined;
  /** All custom-model configs (from the store). */
  customModels: CustomModelPublic[];
  /** The session/model binding currently in effect. */
  customModelId: string | null;
  model: string;
  /** Active provider id — gates the pi model-map branch (only pi sessions
   *  carry `<provider>/<modelId>` refs backed by models.json; codex uses the
   *  same ref shape but must never consult pi's maps). */
  providerId?: string;
  /** Per-model thinkingLevelMap from ~/.pi/agent/models.json, keyed by
   *  `<provider>/<modelId>` (the pi session.model shape). */
  piModelMaps?: Record<string, PiThinkingLevelMap>;
}): ThinkingLevelOption[] | undefined {
  const { providerLevels, customModels, customModelId, model, providerId, piModelMaps } = args;
  if (!providerLevels || providerLevels.length === 0) return undefined;

  // Model-level thinking declarations only exist on OpenAI-protocol custom
  // endpoints — a Claude-provider concept. Gate on the provider, not just the
  // binding: a stale customModelId left over from a Claude custom pick can
  // survive a switch to pi/codex (pi picks run through setModel, which never
  // touches the slot), and without this gate the custom branch would render
  // Claude's ladder for a pi session. Callers without a provider id keep the
  // old binding-only behavior.
  if (customModelId && (!providerId || providerId === "claude-sdk")) {
    const cfg = customModels.find((m) => m.id === customModelId);
    if (cfg && cfg.protocol === "openai") {
      const entry = cfg.models.find((m) => m.id === model) ?? cfg.models[0];
      return levelsFromValues(effortLevelValuesForModel(entry, cfg.baseUrl));
    }
  }

  // Pi: the model's mapping (settings panel → models.json) hides levels it
  // declares unsupported. Unknown model refs (builtin catalog, no map) show
  // the full ladder.
  if (providerId === "pi-sdk" && piModelMaps) {
    const map = piModelMaps[model];
    if (map) {
      return providerLevels.filter((l) => map[l.value as keyof PiThinkingLevelMap] !== null);
    }
  }

  return providerLevels;
}
