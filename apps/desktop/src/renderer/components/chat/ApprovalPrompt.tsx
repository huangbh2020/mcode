import { useEffect, useRef, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { toolDisplayName } from "@renderer/lib/toolNames.js";
import { formatPathWithMaxDirsText } from "@renderer/lib/path.js";
import { Button } from "@renderer/components/ui/index.js";
import {
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
 * Allow scope (issue: repeated-approval fatigue in multi-turn tasks): the
 * footer's "允许范围" select upgrades a one-shot allow into an always-allow
 * grant — "session" records the tool in this session's in-memory set (dies
 * with the app), "global" records it into the PERSISTED allowlist so every
 * session, across restarts, auto-allows the tool (plan mode still prompts;
 * host-side project-boundary guards still run first). The select is a
 * native element; the Esc-deny shortcut ignores keys targeting it so
 * closing its dropdown doesn't accidentally deny the approval.
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
  domain,
  queuePosition,
  queueTotal,
  onDecide,
}: {
  toolName: string;
  input: unknown;
  description?: string;
  /** Present on browser-navigation domain approvals: the host the agent
   *  wants to visit. Switches the card to domain wording (localized
   *  description composed here, since main stays dictionary-free) and the
   *  scope select to trust-domain labels. */
  domain?: string;
  /** 1-based index of this card in the queue. */
  queuePosition: number;
  /** Total cards in the queue; 1 means "no queue" (chip stays quiet). */
  queueTotal: number;
  /** granted=true → allow; `scope` (when granted) upgrades to an
   *  always-allow grant — "session" (this session) or "global" (persisted,
   *  every session). undefined = one-shot allow. */
  onDecide: (granted: boolean, scope?: "session" | "global") => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<"once" | "session" | "global">("once");
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
  // handles Enter natively, so this is just the Esc shortcut). Keys aimed at
  // the scope <select> pass through — Esc closes its native dropdown first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (e.target instanceof HTMLElement && e.target.tagName === "SELECT") return;
        e.preventDefault();
        e.stopPropagation();
        onDecide(false);
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onDecide]);

  const decide = (granted: boolean) => {
    onDecide(granted, granted && scope !== "once" ? scope : undefined);
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
        "mb-2 overflow-hidden rounded-2xl border border-edge bg-surface text-xs text-content shadow-2xl",
        "animate-[qa-sheet-in_140ms_ease-out]",
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2 border-b border-edge/60 px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="h-2 w-2 shrink-0 rounded-full bg-warning ring-4 ring-warning/15"
            aria-hidden
          />
          <span className="font-semibold text-content">{t("chat.approval.title")}</span>
          {queueTotal > 1 && (
            <span
              className="rounded-full bg-warning/15 px-2 py-0.5 font-mono text-[10.5px] font-semibold tabular-nums text-warning"
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
            "inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium transition-colors",
            "text-content-muted hover:bg-surface-hover hover:text-content",
          )}
          title={open ? t("chat.approval.collapseTitle") : t("chat.approval.expandTitle")}
        >
          <span>{open ? t("chat.approval.collapse") : t("chat.approval.details")}</span>
          <IconChevronDown
            size={12}
            className={cn("transition-transform", open && "rotate-180")}
          />
        </button>
      </div>

      {/* Body: Tool name + summary + optional expandable input */}
      <div className="space-y-2.5 px-4 py-3">
        <div className="rounded-xl border border-edge/70 bg-surface-card-well/80 px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <code className="rounded-md bg-warning/15 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-warning">
              {toolDisplayName(t, toolName)}
            </code>
            {summary && (
              <span className="line-clamp-2 break-all font-mono text-[12px] text-content">
                {summary}
              </span>
            )}
          </div>
          {domain ? (
            <div className="mt-1.5 text-[11.5px] text-content-subtle">
              {t("chat.approval.domainDesc", { domain })}
            </div>
          ) : (
            description && <div className="mt-1.5 text-[11.5px] text-content-subtle">{description}</div>
          )}
        </div>

        {open && (
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-content-subtle">
              Input
            </div>
            <pre className="max-h-40 overflow-auto rounded-xl border border-edge/60 bg-surface-card-well p-2.5 font-mono text-[11px] text-content-muted">
              {safeStringify(input)}
            </pre>
          </div>
        )}
      </div>

      {/* Footer: segmented allow-scope control + action buttons */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-edge/60 bg-surface-card/70 px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-[11px] text-content-subtle">
            {t("chat.approval.scopeLabel")}
          </span>
          <div
            className="inline-flex items-center gap-0.5 rounded-lg border border-edge/60 bg-surface-muted p-0.5"
            role="radiogroup"
            aria-label={t("chat.approval.scopeLabel")}
          >
            {(
              [
                {
                  id: "once" as const,
                  label: t("chat.approval.scopeOnce"),
                  title: t("chat.approval.scopeOnce"),
                },
                {
                  id: "session" as const,
                  label: domain
                    ? t("chat.approval.scopeSessionDomain", { domain })
                    : t("chat.approval.scopeSession"),
                  title: domain
                    ? t("chat.approval.scopeSessionDomain", { domain })
                    : t("chat.approval.scopeSession"),
                },
                {
                  id: "global" as const,
                  label: domain
                    ? t("chat.approval.scopeGlobalDomain", { domain })
                    : t("chat.approval.scopeGlobal"),
                  title: domain
                    ? t("chat.approval.scopeGlobalDomain", { domain })
                    : t("chat.approval.scopeGlobal"),
                },
              ]
            ).map((opt) => {
              const active = scope === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  title={opt.title}
                  onClick={() => setScope(opt.id)}
                  className={cn(
                    "max-w-[9rem] truncate rounded-md px-2 py-0.5 text-[11px] font-medium transition-all",
                    active
                      ? cn(
                          "bg-surface shadow-sm font-semibold",
                          opt.id === "once" ? "text-content" : "text-warning",
                        )
                      : "text-content-subtle hover:text-content",
                  )}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>
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
          <button
            ref={allowRef}
            type="button"
            onClick={() => decide(true)}
            title={t("chat.approval.allowTitle")}
            className={cn(
              "inline-flex h-7 items-center gap-1 rounded-lg px-2.5 text-[12px] font-medium transition-all",
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
    case "read":
    case "Write":
    case "write":
    case "Edit":
    case "edit": {
      const raw = String(obj.file_path ?? obj.path ?? obj.filePath ?? "");
      return raw ? formatPathWithMaxDirsText(raw) : "";
    }
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
