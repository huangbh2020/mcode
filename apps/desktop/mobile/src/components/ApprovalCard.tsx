/**
 * ApprovalCard — inline UI for pending tool-approval + AskUserQuestion prompts.
 *
 * Mirrors the desktop's ApprovalPrompt / QuestionPrompt but mobile-simplified.
 * Renders above the composer for the active session only. The requestId is the
 * universal coupling key — approving/denying here resolves the same Deferred on
 * the PC regardless of which device responds first (first-resolver-wins).
 */
import { useState } from "react";
import { useMobileStore } from "../stores/mobileStore.js";

export function ApprovalCard() {
  const activeSessionId = useMobileStore((s) => s.activeSessionId);
  // Approvals are a flat list; show the ones for the active session.
  const approvals = useMobileStore((s) =>
    activeSessionId ? s.pendingApprovals.filter((p) => p.sessionId === activeSessionId) : [],
  );
  const question = useMobileStore((s) => (activeSessionId ? s.pendingQuestionBySession[activeSessionId] : undefined));

  if (approvals.length === 0 && !question) return null;

  return (
    <div className="shrink-0 space-y-2 border-t border-edge bg-surface-muted px-3 py-2">
      {approvals.map((a) => (
        <ApprovalRow key={a.requestId} requestId={a.requestId} toolName={a.toolName} />
      ))}
      {question && <QuestionRow sessionId={activeSessionId!} requestId={question.requestId} questions={question.questions} />}
    </div>
  );
}

function ApprovalRow({ requestId, toolName }: { requestId: string; toolName: string }) {
  const approve = useMobileStore((s) => s.approve);
  const [busy, setBusy] = useState(false);
  const decide = (granted: boolean) => {
    setBusy(true);
    void approve(requestId, granted).finally(() => setBusy(false));
  };
  return (
    <div className="rounded-lg border border-edge bg-surface p-2">
      <div className="mb-1 text-xs text-content-muted">需要审批工具调用</div>
      <div className="mb-2 font-mono text-sm text-content">🔧 {toolName}</div>
      <div className="flex gap-2">
        <button
          onClick={() => decide(false)}
          disabled={busy}
          className="flex-1 rounded border border-edge px-3 py-2 text-xs font-medium text-content-muted disabled:opacity-50"
        >
          拒绝
        </button>
        <button
          onClick={() => decide(true)}
          disabled={busy}
          className="flex-1 rounded bg-accent px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
        >
          允许
        </button>
      </div>
    </div>
  );
}

function QuestionRow({
  sessionId,
  requestId,
  questions,
}: {
  sessionId: string;
  requestId: string;
  questions: unknown[];
}) {
  const respondQuestion = useMobileStore((s) => s.respondQuestion);
  // Each question: { question, options?, multiSelect? }. Mobile renders the
  // first question's options as a single-select list (covers the common case).
  const q = (questions[0] ?? {}) as { question?: string; options?: Array<{ label?: string; value?: string }> };
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const answer = () => {
    if (!selected) return;
    setBusy(true);
    void respondQuestion(sessionId, requestId, { [q.question ?? "answer"]: selected }).finally(() => setBusy(false));
  };

  return (
    <div className="rounded-lg border border-edge bg-surface p-2">
      <div className="mb-1 text-xs text-content-muted">Agent 有问题</div>
      <div className="mb-2 text-sm text-content">{q.question}</div>
      {q.options && q.options.length > 0 && (
        <div className="mb-2 space-y-1">
          {q.options.map((opt, i) => (
            <button
              key={i}
              onClick={() => setSelected(opt.value ?? opt.label ?? String(i))}
              className={
                "block w-full rounded border px-3 py-2 text-left text-xs " +
                (selected === (opt.value ?? opt.label ?? String(i))
                  ? "border-accent bg-accent/10 text-content"
                  : "border-edge text-content-muted")
              }
            >
              {opt.label ?? opt.value}
            </button>
          ))}
        </div>
      )}
      <button
        onClick={answer}
        disabled={busy || !selected}
        className="w-full rounded bg-accent px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
      >
        回答
      </button>
    </div>
  );
}
