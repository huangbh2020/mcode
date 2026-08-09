import { useState, useEffect, useRef } from "react";
import { cn } from "@renderer/lib/cn.js";
import { Button, Input } from "@renderer/components/ui/index.js";
import {
  IconCheck,
  IconX,
  IconQuestionMark,
  IconSend2,
  IconChevronLeft,
  IconChevronRight,
} from "@renderer/lib/icons.js";
import type { AskUserQuestionItem } from "@contracts/runtime";
import type { UserInputAnswers } from "@contracts/provider";

/**
 * Prompt card shown when claude invokes the AskUserQuestion tool.
 *
 * Rendered in-flow inside the composer's width-constrained column (see
 * ChatPane), directly above the input box - mirroring PlanApprovalPrompt.
 * Because it participates in the ChatPane's vertical flex layout (rather
 * than overlaying it absolutely), the card pushes the message stream up to
 * make room instead of covering the streaming data. The composer stays
 * visible below but is locked (`textareaLocked`) while a question is
 * pending, so the user can't type a competing prompt.
 *
 * Layout: a single rounded, bordered, elevated card with three stacked
 * regions — a fixed header (title + step indicator + dismiss), a body that
 * renders ONE question at a time, and a fixed footer (progress + stepper
 * navigation + submit). Instead of stacking every question at once, the card
 * walks through them one-by-one:
 *   - answering a SINGLE-select question auto-advances to the next (option
 *     click on a choice question; Enter / 下一题 for a typed answer);
 *     multi-select questions do NOT auto-advance — the first pick is by
 *     definition partial, so the card stays until the user moves on;
 *   - 上一题 / 下一题 navigate freely — answers already given are kept, so
 *     the user can jump back and revise before submitting;
 *   - the last question shows 提交回答, enabled once every question is
 *     answered. Submit returns the answers as a `UserInputAnswers` map keyed
 *     by question text (matches the SDK's convention); the caller forwards
 *     it to `claude:respondQuestion`, which resolves the provider's pending
 *     user-input Deferred — the SAME turn then continues.
 *
 * Styling uses the `accent` (emerald) token for all interactive/emphasis
 * states — selected options, the header accent, focus — plus neutral
 * surface/edge tokens for the card frame. This matches the composer's own
 * `focus-within:border-accent` treatment and works in both light and dark
 * themes. No violet/purple is used.
 */
export function QuestionPrompt({
  questions,
  onSubmit,
  onDismiss,
}: {
  questions: AskUserQuestionItem[];
  onSubmit: (answers: UserInputAnswers) => void;
  onDismiss: () => void;
}) {
  // answers[i] holds: selected option labels + optional free text.
  const [answers, setAnswers] = useState<Array<{ selected: string[]; text: string }>>(
    questions.map(() => ({ selected: [], text: "" })),
  );
  // Stepper position — one question shown at a time.
  const [step, setStep] = useState(0);

  const isAnswered = (i: number) =>
    answers[i].selected.length > 0 || answers[i].text.trim().length > 0;
  const answeredCount = questions.filter((_, i) => isAnswered(i)).length;
  const allAnswered = answeredCount === questions.length;
  const isLast = step === questions.length - 1;

  /** Toggle an option on question `qi`. Single-select replaces the pick
   *  (toggling the active option clears it); multi-select adds/removes.
   *  Auto-advances to the next question ONLY for single-select questions —
   *  a multi-select pick is by definition partial (the user usually wants
   *  more than one option), so it stays on the question until the user
   *  moves on via 上一题/下一题. */
  const toggle = (qi: number, label: string) => {
    const wasAnswered = isAnswered(qi);
    setAnswers((prev) =>
      prev.map((item, i) => {
        if (i !== qi) return item;
        const q = questions[i];
        if (q.multiSelect) {
          const has = item.selected.includes(label);
          return {
            ...item,
            selected: has ? item.selected.filter((s) => s !== label) : [...item.selected, label],
          };
        }
        return { ...item, selected: item.selected[0] === label ? [] : [label] };
      }),
    );
    if (!wasAnswered && qi === step && !isLast && !questions[qi].multiSelect) {
      setStep((s) => s + 1);
    }
  };

  const setFreeText = (qi: number, text: string) => {
    setAnswers((prev) => prev.map((item, i) => (i === qi ? { ...item, text } : item)));
  };

  const submit = () => {
    // Compose the SDK-shaped answers map: keyed by question text, value is
    // the joined labels (multi-select), the single label (single-select),
    // or the free text. Unanswered questions are omitted.
    const out: UserInputAnswers = {};
    questions.forEach((qq, i) => {
      const aa = answers[i];
      const bits = [...aa.selected];
      if (aa.text.trim()) bits.push(aa.text.trim());
      if (bits.length === 0) return;
      out[qq.question] = qq.multiSelect ? bits : bits.join(", ");
    });
    if (Object.keys(out).length === 0) return;
    onSubmit(out);
  };

  // Esc dismisses. Enter in the free-text input advances to the next question
  // (non-last) or submits on the last one once everything is answered.
  // Shift+Enter is left alone (never used here — single-line Input).
  const submittingRef = useRef(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onDismiss();
      } else if (e.key === "Enter" && !e.shiftKey && !submittingRef.current) {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag !== "TEXTAREA" && tag !== "INPUT") return;
        if (isLast) {
          if (allAnswered) {
            e.preventDefault();
            submittingRef.current = true;
            submit();
          }
        } else {
          e.preventDefault();
          setStep((s) => Math.min(s + 1, questions.length - 1));
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allAnswered, answers, isLast, onDismiss]);

  const q = questions[step];
  const a = answers[step];

  return (
    // Rendered in-flow above the composer (see ChatPane). `mb-2` lifts the card
    // off the input box below so the rounded corners + shadow read as a floating
    // card, mirroring PlanApprovalPrompt. The card participates in the ChatPane
    // flex column so the message stream shrinks to make room (instead of being
    // overlaid). `max-h-[60vh]` caps growth so the body scrolls internally rather
    // than pushing the stream entirely out of view (vh is used because the
    // in-flow parent has no explicit height, so % wouldn't resolve).
    <div
      role="dialog"
      aria-modal="false"
      aria-label="Claude 正在提问"
      className={cn(
        "mb-2 flex max-h-[60vh] flex-col overflow-hidden rounded-2xl",
        "border border-edge-input bg-surface text-xs text-content shadow-2xl",
        "animate-[qa-sheet-in_140ms_ease-out]",
      )}
    >
        {/* Header — fixed at top */}
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-edge px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <IconQuestionMark size={14} className="shrink-0 text-accent" />
            <span className="truncate font-semibold text-accent">
              {questions.length === 1 ? "Claude 有一个问题需要回答" : `Claude 有 ${questions.length} 个问题需要回答`}
            </span>
            {questions.length > 1 && (
              <span className="shrink-0 rounded bg-surface-muted px-1.5 py-0.5 text-[10px] tabular-nums text-content-muted">
                第 {step + 1}/{questions.length} 题
              </span>
            )}
          </div>
          {/* Step dots: answered (dim) / current (accent) / upcoming (edge). */}
          {questions.length > 1 && (
            <div className="flex shrink-0 items-center gap-1" aria-hidden>
              {questions.map((_, i) => (
                <span
                  key={i}
                  className={cn(
                    "h-1.5 w-1.5 rounded-full transition-colors",
                    i === step ? "bg-accent" : isAnswered(i) ? "bg-accent/40" : "bg-edge",
                  )}
                />
              ))}
            </div>
          )}
          <button
            type="button"
            onClick={onDismiss}
            title="忽略这次提问"
            aria-label="忽略这次提问"
            className="shrink-0 rounded p-0.5 text-content-muted transition-colors hover:bg-surface-hover hover:text-content"
          >
            <IconX size={14} />
          </button>
        </div>

        {/* Body — only the current question renders; the rest is reached via
            the footer stepper (or auto-advance on answering). */}
        <div className="overflow-y-auto">
          <div className="px-4 py-3">
            {/* Question header + text */}
            <div className="mb-2 leading-relaxed text-content">
              <span className="mr-1 font-semibold text-accent">{q.header}:</span>
              {q.question}
              {q.multiSelect && (
                <span className="ml-1.5 rounded bg-surface-muted px-1.5 py-0.5 text-[10px] text-content-muted">
                  可多选
                </span>
              )}
            </div>

            {/* Options */}
            <div className="space-y-1.5">
              {q.options.map((opt, oi) => {
                const selected = a.selected.includes(opt.label);
                return (
                  <button
                    key={oi}
                    type="button"
                    onClick={() => toggle(step, opt.label)}
                    className={cn(
                      "flex w-full items-start gap-2.5 rounded-lg border px-2.5 py-1.5 text-left transition-colors",
                      selected
                        ? "border-accent bg-accent/10"
                        : "border-edge bg-surface hover:border-accent/60 hover:bg-accent/5",
                    )}
                    title={opt.description}
                  >
                    <span
                      className={cn(
                        "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border transition-colors",
                        q.multiSelect ? "rounded-sm" : "rounded-full",
                        selected
                          ? "border-accent bg-accent text-surface"
                          : "border-edge text-transparent",
                      )}
                    >
                      <IconCheck size={10} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-medium text-content">
                        {opt.label}
                      </span>
                      {opt.description && (
                        <span className="mt-0.5 block text-[10px] leading-snug text-content-subtle">
                          {opt.description}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Free-text input */}
            <Input
              type="text"
              value={a.text}
              onChange={(e) => setFreeText(step, e.target.value)}
              placeholder="或输入自定义回答…"
              className="mt-2 font-sans"
            />
          </div>
        </div>

        {/* Footer — fixed at bottom: progress + stepper nav / submit */}
        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-edge bg-surface-muted/40 px-4 py-2.5">
          <span className="text-[10px] tabular-nums text-content-subtle">
            {answeredCount} / {questions.length} 已回答
          </span>
          <div className="flex items-center gap-1.5">
            {questions.length > 1 ? (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setStep((s) => Math.max(0, s - 1))}
                  disabled={step === 0}
                  title="上一题，可修改答案"
                >
                  <IconChevronLeft size={12} />
                  上一题
                </Button>
                {isLast ? (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={submit}
                    disabled={!allAnswered}
                    title={allAnswered ? "提交回答 (Enter)" : "请先回答所有问题"}
                  >
                    <IconSend2 size={12} />
                    提交回答
                  </Button>
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setStep((s) => Math.min(questions.length - 1, s + 1))}
                    title="下一题"
                  >
                    下一题
                    <IconChevronRight size={12} />
                  </Button>
                )}
              </>
            ) : (
              <Button
                variant="primary"
                size="sm"
                onClick={submit}
                disabled={!allAnswered}
                title={allAnswered ? "提交回答 (Enter)" : "请先回答所有问题"}
              >
                <IconSend2 size={12} />
                提交回答
              </Button>
            )}
          </div>
        </div>
      </div>
  );
}
