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
 * Custom endpoints are a Claude-provider feature (`supportsCustomEndpoint`), so
 * a non-null `customModelId` always names one of the store's custom configs —
 * Pi/Codex model picks never enter this branch.
 */
import type { CustomModelPublic } from "@contracts/customModel";
import { effortLevelValuesForModel } from "@contracts/customModel";
import type { ThinkingLevelOption } from "@contracts/provider";

/** Label for a raw level value: capitalized value ("low" → "Low"); "default"
 *  shows as "Auto", matching the short labels the providers declare for their
 *  own lists. */
function levelLabel(value: string): string {
  return value === "default" ? "Auto" : value.charAt(0).toUpperCase() + value.slice(1);
}

/** Build the option list for a model row's level VALUES (contracts'
 *  `effortLevelValuesForModel`). Hints stay empty — the chip's i18n maps
 *  (EFFORT_HINT_KEYS) resolve them by value at render time. */
export function levelsFromValues(values: string[]): ThinkingLevelOption[] {
  return values.map((value) => ({ value, label: levelLabel(value) }));
}

/** The thinking-level options the effort UI should offer for the CURRENT
 *  provider + model binding:
 *
 *  - provider declares none → `undefined` (hide the chip — unchanged behavior);
 *  - OpenAI-protocol custom model → the model's declared/inferred levels
 *    (`[]` = hide; thinking isn't controllable on that model);
 *  - everything else (official Claude, Anthropic-protocol endpoints, Pi,
 *    Codex) → the provider's own list, exactly as before.
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
}): ThinkingLevelOption[] | undefined {
  const { providerLevels, customModels, customModelId, model } = args;
  if (!providerLevels || providerLevels.length === 0) return undefined;

  // Model-level thinking declarations only exist on OpenAI-protocol custom
  // endpoints; everything else keeps the provider's own list.
  if (customModelId) {
    const cfg = customModels.find((m) => m.id === customModelId);
    if (cfg && cfg.protocol === "openai") {
      const entry = cfg.models.find((m) => m.id === model) ?? cfg.models[0];
      return levelsFromValues(effortLevelValuesForModel(entry, cfg.baseUrl));
    }
  }
  return providerLevels;
}
