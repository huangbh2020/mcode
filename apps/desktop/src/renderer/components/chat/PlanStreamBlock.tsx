import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { IconRocket } from "@renderer/lib/icons.js";
import { Markdown } from "./Markdown.js";
import { extractPlanTitle } from "./StatusCapsule.js";
import type { PlanUpdateEvent } from "@contracts/runtime";

/** Max characters of plan text to preview inline before truncating. The full
 *  content lives in the PlanDrawer - this is just a glimpse so the user can
 *  tell what the plan is about without opening it. */
const PLAN_PREVIEW_CHARS = 200;

/** Truncate a string to N characters with an ellipsis. */
function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n).trimEnd() + "…";
}

/**
 * Read-only inline plan card rendered in the message stream (at the turn's
 * output tail, before the TurnFilesCard).
 *
 * Visually distinct from other cards: uses an accent-tinted border + surface
 * so it stands out as a plan, not just another tool card. The card is
 * expanded by default showing a truncated preview of the plan markdown, with
 * a prominent "查看计划" action at the bottom. Clicking the card (or the
 * action) opens the right-side PlanDrawer with the full plan content.
 *
 * Lifecycle badge:
 *   - drafting: "草拟中" (the model is still composing)
 *   - hasApproval: "待审阅" (ExitPlanMode is pending the user's decision)
 *   - ready: no badge (the plan is frozen history)
 *
 * Editing / approve / reject actions live in the PlanApprovalPrompt sheet above
 * the composer - this component is purely the reading entry point.
 */
export function PlanStreamBlock({
  plan,
  phase,
  hasApproval,
  onOpenPlan,
  projectPath,
}: {
  plan: string;
  phase: PlanUpdateEvent["phase"];
  /** True when an ExitPlanMode approval is pending (the compact
   *  PlanApprovalPrompt sheet is shown above the composer). Drives the badge
   *  label on this card so the user knows an action is awaiting them. */
  hasApproval?: boolean;
  /** Called when the user clicks the card - opens the right-side PlanDrawer
   *  with this plan's full markdown content. */
  onOpenPlan?: (plan: string) => void;
  /** Project root for resolving file paths mentioned in the plan preview. */
  projectPath?: string | null;
}) {
  const { t } = useI18n();
  const isDrafting = phase === "drafting";
  const label = hasApproval ? t("chat.plan.pendingReview") : isDrafting ? t("chat.plan.drafting") : null;
  const title = extractPlanTitle(plan) || t("chat.plan.fallbackTitle");
  const preview = truncate(plan, PLAN_PREVIEW_CHARS);

  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border bg-surface-muted/40 backdrop-blur transition-colors",
        // Accent-tinted border so the plan card is visually distinct from
        // ordinary tool/text cards in the stream.
        hasApproval
          ? "border-accent/40"
          : "border-edge hover:border-edge-input",
      )}
    >
      {/* Header - icon + title + status badge. Accent icon signals "plan". */}
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-1.5">
        <IconRocket size={15} className="shrink-0 text-accent" />
        <span className="truncate text-xs font-semibold text-content">{title}</span>
        {label && (
          <span
            className={cn(
              "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium",
              hasApproval
                ? "bg-accent/15 text-accent"
                : "bg-surface-hover text-content-subtle",
            )}
          >
            {label}
          </span>
        )}
      </div>

      {/* Content preview - truncated plan markdown. Read-only glimpse so the
          user can tell what the plan is about without opening the drawer. */}
      {preview && (
        <div className="px-3 pb-2">
          <div className="prose-plan max-h-32 overflow-hidden text-[11px] leading-relaxed text-content-muted">
            <Markdown projectPath={projectPath}>{preview}</Markdown>
          </div>
        </div>
      )}

      {/* Action footer - prominent "查看计划" button. Large font so it reads
          as the primary call-to-action; clicking opens the PlanDrawer. */}
      <button
        type="button"
        onClick={() => onOpenPlan?.(plan)}
        title={t("chat.plan.viewFullTitle")}
        className={cn(
          "flex w-full items-center justify-center gap-1.5 border-t px-3 py-2 text-sm font-medium transition-colors",
          hasApproval
            ? "border-accent/20 bg-accent/5 text-accent hover:bg-accent/10"
            : "border-edge bg-surface-hover/50 text-content hover:bg-surface-hover",
        )}
      >
        <IconRocket size={15} />
        {t("chat.plan.view")}
      </button>
    </div>
  );
}
