/**
 * Codex usage → provider-neutral ContextSnapshot.
 *
 * The app-server's ThreadTokenUsage carries camelCase TokenUsageBreakdown
 * (`{inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens,
 * totalTokens}`) plus `modelContextWindow` — the model's real context window
 * when known (falls back to a model-family heuristic here).
 */
import type { ContextSnapshot } from "@contracts/runtime";

/** Raw usage counters as reported by app-server (TokenUsageBreakdown). */
export interface CodexUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens?: number;
}

/** Heuristic context window by model id (best-effort; unknown → 128k). */
function contextWindowForModel(modelId: string | undefined): number {
  if (modelId && /^(gpt-5|gpt-6|codex)/i.test(modelId)) return 272_000;
  return 128_000;
}

/** Build the display-ready snapshot, or undefined when nothing has been
 *  reported yet (skip-emit semantics mirror the Pi adapter). */
export function buildCodexTokenSnapshot(
  usage: CodexUsage | null,
  modelContextWindow?: number,
): ContextSnapshot | undefined {
  if (!usage) return undefined;
  const inputTokens = Math.max(0, usage.inputTokens ?? 0);
  const outputTokens = Math.max(0, usage.outputTokens ?? 0);
  const cacheRead = Math.max(0, usage.cachedInputTokens ?? 0);
  // Codex counts reasoning output inside output_tokens; occupancy = the
  // final request's input (what the model had in context).
  const totalProcessed = inputTokens + cacheRead + outputTokens;
  if (totalProcessed === 0) return undefined;

  const maxTokens = modelContextWindow && modelContextWindow > 0 ? modelContextWindow : 272_000;
  const usedTokens = Math.min(inputTokens, maxTokens);
  const pct = Math.min(100, Math.max(0, Math.round((usedTokens / maxTokens) * 100)));
  const warnings: ContextSnapshot["warnings"] = [];
  let warning: ContextSnapshot["warning"] = "ok";
  if (pct >= 90) {
    warning = "critical";
    warnings.push("near-window");
  } else if (pct >= 70) {
    warning = "near-window";
    warnings.push("near-window");
  }

  return {
    usedTokens,
    totalProcessedTokens: totalProcessed,
    maxTokens,
    outputTokens,
    cacheReadTokens: cacheRead,
    pct,
    warning,
    warnings,
  };
}
