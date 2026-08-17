import { useEffect, useRef, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { Button } from "@renderer/components/ui/index.js";
import {
  IconAlertTriangle,
  IconChevronDown,
  IconCheck,
  IconX,
} from "@renderer/lib/icons.js";

/**
 * Composer-area tool-approval card.
 *
 * Rendered in-flow inside the composer's width-constrained column (see
 * ChatPane), directly above the input box - mirroring PlanApprovalPrompt.
 * Because it participates in the ChatPane's vertical flex layout (rather
 * than overlaying it absolutely), the card pushes the message stream up to
 * make room instead of covering the streaming data. The composer stays
 * visible below but is locked (`textareaLocked`) while a decision is
 * pending, so the user can't type a competing prompt.
 *
 * Styling mirrors QuestionPrompt: a single rounded, bordered, elevated
 * card on neutral surface tokens, with the `warning` (amber) token used
 * sparingly for the accent/attention elements (header label, tool-name
 * code, the "允许" primary button). Amber remains the semantic signal for
 * "needs your permission", but the frame is otherwise neutral so the card
 * reads cleanly in both light and dark themes. No violet/purple is used.
 *
 * Queuing: when several approval.request events arrive in quick succession
 * (e.g. the model wants to run three Bash commands in one turn), the store
 * keeps them in a queue and the head — index 0 — is what this card renders.
 * The header shows "n / total" only when total > 1 so a single approval
 * stays visually quiet.
 *
 * Keyboard: Enter allows the head, Esc denies. The "允许" button auto-focuses
 * on mount so Enter works without an extra click. This is one-shot — when
 * the queue shifts, this card unmounts and the next one auto-focuses its
 * own button via the same effect.
 */
export function ApprovalPrompt({
  toolName,
  input,
  description,
  queuePosition,
  queueTotal,
  onDecide,
}: {
  toolName: string;
  input: unknown;
  description?: string;
  /** 1-based index of this card in the queue. */
  queuePosition: number;
  /** Total cards in the queue; 1 means "no queue" (chip stays quiet). */
  queueTotal: number;
  /** granted=true → allow (with `always` if checked); granted=false → deny. */
  onDecide: (granted: boolean, always?: boolean) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [always, setAlways] = useState(false);
  const allowRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  // One-line hint mirroring MessageBlocks.toolSummary so the user sees what
  // the tool is about without expanding.
  const summary = summarizeTool(toolName, input);

  // Auto-focus the "允许" button on mount (and on every queue head shift),
  // so Enter confirms without an extra click. Also bring the whole card
  // into view in case the queue scrolled it out.
  useEffect(() => {
    allowRef.current?.focus();
    cardRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [toolName, queuePosition]);

  // Local keyboard: Esc denies, Enter allows (the focused button already
  // handles Enter natively, so this is just the Esc shortcut).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onDecide(false);
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onDecide]);

  const decide = (granted: boolean) => {
    onDecide(granted, granted ? always : undefined);
  };

  // Rendered in-flow above the composer (see ChatPane). `mb-2` lifts the card
  // off the input box below so the rounded corners + shadow read as a floating
  // card, mirroring PlanApprovalPrompt.
  return (
    <div
      ref={cardRef}
      role="alertdialog"
      aria-label={t("chat.approval.aria")}
      className={cn(
        "mb-2 rounded-2xl border border-edge-input bg-surface px-4 py-3 text-xs text-content shadow-2xl",
        "animate-[qa-sheet-in_140ms_ease-out]",
      )}
    >
      {/* Header */}
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <IconAlertTriangle size={14} className="shrink-0 text-warning" />
          <span className="font-semibold text-warning">{t("chat.approval.title")}</span>
          {queueTotal > 1 && (
            <span
              className="rounded-full border border-warning/60 bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-warning"
              title={t("chat.approval.queueTitle", { n: queueTotal - queuePosition })}
            >
              {queuePosition} / {queueTotal}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={cn(
            "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium transition-colors",
            "text-content-muted hover:bg-surface-hover hover:text-content",
          )}
          title={open ? t("chat.approval.collapseTitle") : t("chat.approval.expandTitle")}
        >
          <IconChevronDown
            size={12}
            className={cn("transition-transform", open && "rotate-180")}
          />
          {open ? t("chat.approval.collapse") : t("chat.approval.details")}
        </button>
      </div>

      {/* Tool name + summary */}
      <div className="mb-2.5 rounded-lg border border-edge bg-surface-muted/40 px-3 py-2">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <code className="rounded bg-warning/15 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-warning">
            {toolName}
          </code>
          {summary && (
            <span className="line-clamp-2 break-all text-content-muted">{summary}</span>
          )}
        </div>
        {description && <div className="mt-1 text-[11px] text-content-muted">{description}</div>}
      </div>

      {/* Expandable input */}
      {open && (
        <div className="mb-2.5">
          <div className="mb-0.5 text-[10px] uppercase tracking-wide text-content-subtle">Input</div>
          <pre className="max-h-40 overflow-auto rounded-lg bg-surface-muted/60 p-2 text-[11px] text-content-muted">
            {safeStringify(input)}
          </pre>
        </div>
      )}

      {/* Footer: always-allow checkbox + buttons. Stays on a single row at
          the bottom of the card. */}
      <div className="flex items-center justify-between gap-2 border-t border-edge pt-2.5">
        <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-content-muted">
          <input
            type="checkbox"
            checked={always}
            onChange={(e) => setAlways(e.target.checked)}
            className="h-3 w-3 cursor-pointer accent-warning"
          />
          {t("chat.approval.alwaysAllow", { tool: toolName })}
        </label>
        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => decide(false)}
            title={t("chat.approval.denyTitle")}
          >
            <IconX size={12} />
            {t("chat.approval.deny")}
          </Button>
          {/* Primary confirm action uses the warning token (amber) to keep the
              "permission grant" semantic distinct from QuestionPrompt's green
              submit — the Button component has no warning variant, so this is
              a single purpose-built button rather than <Button variant>. */}
          <button
            ref={allowRef}
            type="button"
            onClick={() => decide(true)}
            title={t("chat.approval.allowTitle")}
            className={cn(
              "inline-flex h-6 items-center gap-1 rounded px-2 text-[11px] font-medium transition-colors",
              "bg-warning text-surface hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-warning/50",
            )}
          >
            <IconCheck size={12} />
            {t("chat.approval.allow")}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ──────────────────────────── helpers ──────────────────────────── */

/** One-line hint for common tools. Mirrors MessageBlocks.toolSummary but kept
 * local to avoid a cross-module import for a pure display helper. */
function summarizeTool(name: string, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  switch (name) {
    case "Read":
    case "Write":
    case "Edit":
      return String(obj.file_path ?? "");
    case "Bash":
    case "PowerShell":
      return String(obj.command ?? obj.description ?? "");
    case "Glob":
      return String(obj.pattern ?? "");
    case "Grep":
      return String(obj.pattern ?? "");
    case "TodoWrite":
      return "todos";
    default:
      return Object.values(obj).slice(0, 1).map(String).join("").slice(0, 60);
  }
}

function safeStringify(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
