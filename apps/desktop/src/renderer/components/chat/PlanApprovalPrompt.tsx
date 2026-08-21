import { useState } from "react";
import { useSessionStore, type PlanHandoffTarget } from "@renderer/stores/sessionStore.js";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { Button, Input, Select } from "@renderer/components/ui/index.js";
import { useSuppressBrowserView } from "@renderer/hooks/useSuppressBrowserView.js";
import {
  IconRocket,
  IconEye,
  IconX,
} from "@renderer/lib/icons.js";

/** Execution-mode choice in the approval sheet's 执行方式 row. */
type ExecMode = "current" | "remodel" | "newSession";

/** One selectable model on a handoff surface. The pair (model,
 *  customModelId) is exactly what startSession / updateSettings persist. */
type HandoffModelOption = {
  key: string;
  model: string;
  customModelId: string | null;
  label: string;
};

/**
 * Compact plan-approval sheet shown above the composer when the model calls
 * ExitPlanMode in plan mode.
 *
 * The full plan text is shown inline in the message stream via PlanStreamBlock
 * - this sheet is intentionally minimal so it doesn't obstruct the user's view
 * of the plan or the conversation. It carries: an always-visible adjustment-
 * feedback input, view (opens the plan tab in the editor column - the same
 * entry as the capsule / plan cards), reject, and approve.
 *
 * 执行方式 (execution picker): besides approving in place ("current"), the
 * user can hand the plan to a different executor:
 *   - remodel     — end the blocked turn, rebind THIS session's model, fire
 *     the plan as a fresh turn in the same thread (full transcript context
 *     carries via resume);
 *   - newSession  — end the blocked turn and create a new session (SDK +
 *     model pickable) seeded with the plan as its first prompt; context
 *     rebuilds from the plan document.
 * Both alternatives interrupt the turn WITHOUT answering the ExitPlanMode
 * dialog (see `handoffPlanApproval` in the store). The primary button's label
 * follows the mode; Enter in the feedback input triggers it.
 *
 * Feedback semantics (意见随按钮走): whatever the user types in the
 * adjustment-feedback input rides along with whichever decision they make -
 * 批准并执行 delivers it to the model as an adjustment instruction (execution
 * incorporates it); 拒绝 sends it as the rejection reason (the model stays in
 * plan mode and revises); a handoff appends it to the kickoff prompt as an
 * execution note. An empty input behaves exactly like the legacy no-feedback
 * flows. Pressing Enter in the input fires the primary action.
 *
 * Viewing / editing flow: "查看计划" opens the plan tab in the editor column
 * (handled by the parent via `onViewPlan`), seeded with the staged draft if
 * prior edits exist. Editing happens inside PlanViewer (its header 编辑
 * button); saves are staged into `planApprovalDraftBySession`, and this sheet
 * reads that draft back so the "已编辑" indicator + "批准(已编辑)" reflect the
 * editor's content. The user still has to press the primary button to submit -
 * editing in the editor never auto-approves.
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
  onViewPlan,
  onApprove,
  onReject,
  onHandoff,
}: {
  sessionId: string;
  plan: string;
  /** Open the plan tab in the editor column (PlanViewer read view). The parent
   *  activates the plan tab; PlanViewer stages edits back into the store. */
  onViewPlan: () => void;
  /** Approve, optionally with an edited plan text and/or adjustment feedback. */
  onApprove: (editedPlan?: string, feedback?: string) => void;
  /** Reject with optional feedback — doubles as the reason shown to the model. */
  onReject: (feedback?: string) => void;
  /** Execute the plan elsewhere (different model here, or a new session)
   *  instead of approving in place. Feedback rides into the kickoff prompt. */
  onHandoff: (target: PlanHandoffTarget, feedback?: string) => void;
}) {
  // The edited draft is staged by PlanViewer's save action. Falls back to the
  // original plan when nothing has been edited yet.
  const draft = useSessionStore(
    (s) => s.planApprovalDraftBySession[sessionId] ?? plan,
  );
  const { t } = useI18n();
  const [feedback, setFeedback] = useState("");

  // ── Execution picker state ──
  const providers = useSessionStore((s) => s.providers);
  const customModels = useSessionStore((s) => s.customModels);
  const piAvailableModels = useSessionStore((s) => s.piAvailableModels);
  // Foreground config slots (synced from the session that owns this sheet).
  const sessionProviderId = useSessionStore((s) => s.providerId);
  const sessionModel = useSessionStore((s) => s.model);
  const sessionCustomModelId = useSessionStore((s) => s.customModelId);

  const [exec, setExec] = useState<ExecMode>("current");
  const [handoffProviderId, setHandoffProviderId] = useState(sessionProviderId);
  const [remodelKey, setRemodelKey] = useState<string | null>(null);
  const [newSessionKey, setNewSessionKey] = useState<string | null>(null);
  // While any select popup is open the embedded browser view is suppressed so
  // the portaled popup stays clickable over the browser's rect.
  const [menuOpen, setMenuOpen] = useState(false);
  useSuppressBrowserView(menuOpen);

  // Selectable models for a provider, mirroring the ModelDropdown surface:
  // pi → dynamic piAvailableModels; custom-endpoint providers → their gateway
  // configs flattened (config · model); everyone → built-in aliases (kept
  // here even for claude, whose composer dropdown hides them — a handoff
  // executor pick is an explicit choice, and claude users without gateway
  // configs would otherwise have nothing to switch to).
  const optionsFor = (providerId: string): HandoffModelOption[] => {
    const provider = providers.find((p) => p.id === providerId);
    if (!provider) return [];
    const out: HandoffModelOption[] = [];
    if (provider.id === "pi-sdk") {
      for (const b of piAvailableModels) {
        out.push({
          key: `pi:${b.id}`,
          model: b.id,
          customModelId: null,
          label: b.supplier ? `${b.supplier} · ${b.label}` : b.label,
        });
      }
      return out;
    }
    if (provider.capabilities.supportsCustomEndpoint) {
      for (const cfg of customModels) {
        for (const m of cfg.models) {
          if (!m.id.trim()) continue;
          out.push({
            key: `cfg:${cfg.id}:${m.id}`,
            model: m.id,
            customModelId: cfg.id,
            label: `${cfg.name} · ${m.id}`,
          });
        }
      }
    }
    for (const b of provider.capabilities.builtinModels ?? []) {
      if (b.id === "default") continue;
      out.push({
        key: `builtin:${b.id}`,
        model: b.id,
        customModelId: null,
        label: t("chat.planApproval.builtinModelLabel", { label: b.label }),
      });
    }
    return out;
  };
  const remodelOptions = optionsFor(sessionProviderId);
  const newSessionOptions = optionsFor(handoffProviderId);
  // "换模型" is pointless without an alternative to switch to.
  const canRemodel = remodelOptions.length > 1;

  // Default pick: the session's current model when it's on the surface (a
  // no-op default the user is explicitly overriding), else the first entry.
  // An explicit pick (key state) always wins over the default.
  const defaultOption = (opts: HandoffModelOption[]): HandoffModelOption | null =>
    opts.find((o) => o.model === sessionModel && o.customModelId === sessionCustomModelId)
    ?? opts[0]
    ?? null;
  const remodelSelected =
    remodelOptions.find((o) => o.key === remodelKey) ?? defaultOption(remodelOptions);
  const newSessionSelected =
    newSessionOptions.find((o) => o.key === newSessionKey) ?? defaultOption(newSessionOptions);

  const edited = draft.trim() !== plan.trim();
  const hasFeedback = feedback.trim().length > 0;

  const handleApprove = () => {
    // Only pass the edited text if it actually changed, so an untouched
    // approve doesn't accidentally rewrite the plan. Same for feedback: an
    // empty input keeps the legacy stock-approval message.
    onApprove(edited ? draft : undefined, hasFeedback ? feedback.trim() : undefined);
  };

  const handlePrimary = () => {
    if (exec === "current") {
      handleApprove();
      return;
    }
    const sel = exec === "remodel" ? remodelSelected : newSessionSelected;
    if (!sel) return;
    const target: PlanHandoffTarget =
      exec === "remodel"
        ? { kind: "remodel", model: sel.model, customModelId: sel.customModelId }
        : {
            kind: "newSession",
            providerId: handoffProviderId,
            model: sel.model,
            customModelId: sel.customModelId,
          };
    onHandoff(target, hasFeedback ? feedback.trim() : undefined);
  };

  const handleReject = () => {
    onReject(hasFeedback ? feedback.trim() : undefined);
  };

  const hint = edited
    ? t("chat.planApproval.hintEdited")
    : hasFeedback
      ? t("chat.planApproval.hintFeedback")
      : t("chat.planApproval.hintDefault");

  const primaryLabel =
    hasFeedback
      ? t("chat.planApproval.approveConfirm")
      : exec === "newSession"
        ? t("chat.planApproval.handoffNewSession")
        : exec === "remodel"
          ? t("chat.planApproval.handoffRemodel")
          : edited
            ? t("chat.planApproval.approveEdited")
            : t("chat.planApproval.approve");
  const primaryTitle =
    exec === "newSession"
      ? t("chat.planApproval.handoffNewSessionTitle")
      : exec === "remodel"
        ? t("chat.planApproval.handoffRemodelTitle")
        : edited
          ? t("chat.planApproval.approveEditedTitle")
          : hasFeedback
            ? t("chat.planApproval.approveFeedbackTitle")
            : t("chat.planApproval.approveTitle");
  const primaryDisabled = exec !== "current" && !(exec === "remodel" ? remodelSelected : newSessionSelected);

  const segButton = (mode: ExecMode, label: string, title: string) => (
    <button
      key={mode}
      type="button"
      title={title}
      onClick={() => setExec(mode)}
      className={cn(
        "rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors",
        exec === mode
          ? "bg-surface text-accent shadow-sm"
          : "text-content-muted hover:text-content",
      )}
    >
      {label}
    </button>
  );

  const renderModelSelect = (
    selected: HandoffModelOption | null,
    options: HandoffModelOption[],
    onPick: (key: string) => void,
  ) => (
    <Select.Root
      value={selected?.key ?? null}
      onValueChange={(v) => {
        if (typeof v === "string") onPick(v);
      }}
      onOpenChange={(o) => setMenuOpen(o)}
    >
      <Select.Trigger className="h-6 max-w-[220px] gap-1 px-2 py-0 text-[11px]">
        <Select.Value placeholder={t("chat.planApproval.pickModel")}>
          {(val: string) => options.find((o) => o.key === val)?.label ?? t("chat.planApproval.pickModel")}
        </Select.Value>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner align="start">
          <Select.Popup className="max-h-60 overflow-y-auto">
            <Select.List>
              {options.map((o) => (
                <Select.Item key={o.key} value={o.key}>
                  <span className="min-w-0 truncate">{o.label}</span>
                </Select.Item>
              ))}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );

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

      {/* Execution picker - where the approved plan runs. Default: this
          thread, in place. The alternatives end the blocked turn and re-fire
          the plan with a different executor (see component docs). */}
      <div className="mb-2.5 flex flex-wrap items-center gap-2">
        <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-content-subtle">
          {t("chat.planApproval.execLabel")}
        </span>
        <div className="flex items-center gap-0.5 rounded-lg bg-surface-muted p-0.5">
          {segButton("current", t("chat.planApproval.execCurrent"), t("chat.planApproval.execCurrentTitle"))}
          {canRemodel && segButton("remodel", t("chat.planApproval.execRemodel"), t("chat.planApproval.execRemodelTitle"))}
          {segButton("newSession", t("chat.planApproval.execNewSession"), t("chat.planApproval.execNewSessionTitle"))}
        </div>
        {exec === "remodel" && renderModelSelect(remodelSelected, remodelOptions, setRemodelKey)}
        {exec === "newSession" && (
          <>
            {providers.length > 1 && (
              <Select.Root
                value={handoffProviderId}
                onValueChange={(v) => {
                  const id = v as string;
                  setHandoffProviderId(id);
                  // The model surface is per-provider — drop the stale pick so
                  // the default re-resolves against the new provider's list.
                  setNewSessionKey(null);
                }}
                onOpenChange={(o) => setMenuOpen(o)}
              >
                <Select.Trigger className="h-6 gap-1 px-2 py-0 text-[11px]">
                  <Select.Value placeholder={t("chat.planApproval.pickProvider")}>
                    {(val: string) => providers.find((p) => p.id === val)?.displayName ?? val}
                  </Select.Value>
                </Select.Trigger>
                <Select.Portal>
                  <Select.Positioner align="start">
                    <Select.Popup>
                      <Select.List>
                        {providers.map((p) => (
                          <Select.Item key={p.id} value={p.id}>
                            <span className="min-w-0 truncate">{p.displayName}</span>
                          </Select.Item>
                        ))}
                      </Select.List>
                    </Select.Popup>
                  </Select.Positioner>
                </Select.Portal>
              </Select.Root>
            )}
            {renderModelSelect(newSessionSelected, newSessionOptions, setNewSessionKey)}
          </>
        )}
      </div>

      {/* Adjustment-feedback input (always visible). The text rides along with
          whichever decision the user makes - approve delivers it to the model
          as an adjustment instruction, reject sends it as the reason, a
          handoff appends it to the kickoff prompt. Enter fires the primary
          action (mirrors QuestionPrompt's Enter-to-submit). */}
      <Input
        type="text"
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handlePrimary();
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
          onClick={onViewPlan}
          title={t("chat.planApproval.viewInEditor")}
        >
          <IconEye size={12} />
          {edited ? t("chat.planApproval.viewEdited") : t("chat.plan.view")}
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
            onClick={handlePrimary}
            disabled={primaryDisabled}
            title={primaryTitle}
          >
            <IconRocket size={12} />
            {primaryLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
