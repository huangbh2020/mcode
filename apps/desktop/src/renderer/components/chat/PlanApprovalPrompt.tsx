import { useState } from "react";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { Button, Input } from "@renderer/components/ui/index.js";
import {
  IconRocket,
  IconPencil,
  IconX,
} from "@renderer/lib/icons.js";

/**
 * Compact plan-approval sheet shown above the composer when the model calls
 * ExitPlanMode in plan mode.
 *
 * The full plan text is shown inline in the message stream via PlanStreamBlock
 * - this sheet is intentionally minimal so it doesn't obstruct the user's view
 * of the plan or the conversation. It carries: an always-visible adjustment-
 * feedback input, edit (opens the plan in the editor column for Monaco
 * editing), reject, and approve.
 *
 * Feedback semantics (意见随按钮走): whatever the user types in the
 * adjustment-feedback input rides along with whichever decision they make -
 * 批准并执行 delivers it to the model as an adjustment instruction (execution
 * incorporates it); 拒绝 sends it as the rejection reason (the model stays in
 * plan mode and revises). An empty input behaves exactly like the legacy
 * no-feedback flows. Pressing Enter in the input approves (with feedback).
 *
 * Editing flow: "编辑计划" opens the plan tab in the editor column (handled by
 * the parent via `onEditPlan`). Edits made there are staged into
 * `planApprovalDraftBySession` by PlanViewer's save action, and this sheet
 * reads that draft back so the "已编辑" indicator + "批准(已编辑)" reflect the
 * editor's content. The user still has to press 批准 to submit - editing in
 * the editor never auto-approves.
 *
 * Positioning: rendered inside the composer's width-constrained column (see
 * ChatPane), so it inherits the same `px-[var(--chat-gutter)]` +
 * `mx-auto max-w-5xl` sizing as the input box and sits directly above the
 * textarea - mirroring ApprovalPrompt. `mb-2` lifts it off the input box.
 *
 * Styling: accent (emerald) token for the header label and approve button -
 * this is the one actionable approval surface, so the accent signals "press
 * this to proceed". Matches the composer's accent usage (send button etc.).
 */
export function PlanApprovalPrompt({
  sessionId,
  plan,
  onEditPlan,
  onApprove,
  onReject,
}: {
  sessionId: string;
  plan: string;
  /** Open the plan in the editor column (Monaco) for editing. The parent
   *  activates the plan tab; PlanViewer stages edits back into the store. */
  onEditPlan: () => void;
  /** Approve, optionally with an edited plan text and/or adjustment feedback. */
  onApprove: (editedPlan?: string, feedback?: string) => void;
  /** Reject with optional feedback — doubles as the reason shown to the model. */
  onReject: (feedback?: string) => void;
}) {
  // The edited draft is staged by PlanViewer's save action. Falls back to the
  // original plan when nothing has been edited yet.
  const draft = useSessionStore(
    (s) => s.planApprovalDraftBySession[sessionId] ?? plan,
  );
  const { t } = useI18n();
  const [feedback, setFeedback] = useState("");

  const edited = draft.trim() !== plan.trim();
  const hasFeedback = feedback.trim().length > 0;

  const handleApprove = () => {
    // Only pass the edited text if it actually changed, so an untouched
    // approve doesn't accidentally rewrite the plan. Same for feedback: an
    // empty input keeps the legacy stock-approval message.
    onApprove(edited ? draft : undefined, hasFeedback ? feedback.trim() : undefined);
  };

  const handleReject = () => {
    onReject(hasFeedback ? feedback.trim() : undefined);
  };

  const hint = edited
    ? t("chat.planApproval.hintEdited")
    : hasFeedback
      ? t("chat.planApproval.hintFeedback")
      : t("chat.planApproval.hintDefault");

  return (
    <div
      className={cn(
        "mb-2 rounded-2xl border border-edge-input bg-surface px-4 py-2.5 text-xs text-content shadow-2xl",
        "animate-[qa-sheet-in_140ms_ease-out]",
      )}
    >
      {/* Compact header - always visible */}
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <IconRocket size={14} className="shrink-0 text-accent" />
          <span className="font-semibold text-accent">{t("chat.planApproval.title")}</span>
        </div>
        <span className="shrink-0 text-[10px] text-content-subtle">{hint}</span>
      </div>

      {/* Adjustment-feedback input (always visible). The text rides along with
          whichever decision the user makes - approve delivers it to the model
          as an adjustment instruction, reject sends it as the reason. Enter
          approves (mirrors QuestionPrompt's Enter-to-submit). */}
      <Input
        type="text"
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleApprove();
          }
        }}
        placeholder={t("chat.planApproval.feedbackPlaceholder")}
        className="mb-2.5 font-sans"
      />

      {/* Action footer */}
      <div className="flex items-center justify-between gap-2 border-t border-edge pt-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={onEditPlan}
          title={t("chat.planApproval.editInEditor")}
        >
          <IconPencil size={12} />
          {edited ? t("chat.planApproval.editEdited") : t("chat.plan.editPlan")}
        </Button>
        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleReject}
            title={hasFeedback ? t("chat.planApproval.rejectFeedbackTitle") : t("chat.planApproval.rejectTitle")}
          >
            <IconX size={12} />
            {t("chat.planApproval.reject")}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={handleApprove}
            title={
              edited
                ? t("chat.planApproval.approveEditedTitle")
                : hasFeedback
                  ? t("chat.planApproval.approveFeedbackTitle")
                  : t("chat.planApproval.approveTitle")
            }
          >
            <IconRocket size={12} />
            {edited ? t("chat.planApproval.approveEdited") : t("chat.planApproval.approve")}
          </Button>
        </div>
      </div>
    </div>
  );
}
