/**
 * 编排收件箱(右栏「收件箱」tab)。
 *
 * 聚合三类"等你处理"的事项:
 *  ① 编排决策门(escalation/budget/择优)——来自所有 run 的 open gates;
 *  ② worker 的 AskUserQuestion(question.ask 事件已进
 *     pendingQuestionBySession,worker 会话不在前台也能存),复用
 *     QuestionPrompt 的交互提交;
 *  ③ worker 的工具审批(pendingApprovals 里 sessionId ∈ worker 集合的条目)。
 *
 * worker 会话 id 集合从所有已知 run 的 dispatches 派生 —— 不需要任何新契约。
 */
import { useMemo } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { QuestionPrompt } from "@renderer/components/chat/QuestionPrompt.js";
import { IconInbox } from "@renderer/lib/icons.js";

export function InboxPanel() {
  const { t } = useI18n();
  const runsBySession = useSessionStore((s) => s.orchRunsBySession);
  const pendingQuestionBySession = useSessionStore((s) => s.pendingQuestionBySession);
  const pendingApprovals = useSessionStore((s) => s.pendingApprovals);
  const decideApproval = useSessionStore((s) => s.decideApproval);
  const submitQuestion = useSessionStore((s) => s.submitQuestion);
  const dismissQuestion = useSessionStore((s) => s.dismissQuestionFor);
  const orchResolveGate = useSessionStore((s) => s.orchResolveGate);

  const workerIds = useMemo(() => {
    const ids = new Set<string>();
    for (const runs of Object.values(runsBySession)) {
      for (const run of runs) {
        for (const task of run.tasks) {
          for (const d of task.dispatches) {
            if (d.workerSessionId) ids.add(d.workerSessionId);
          }
        }
      }
    }
    return ids;
  }, [runsBySession]);

  const openGates = useMemo(() => {
    const out: { runId: string; title: string; gate: import("@contracts/orchestration").Gate; tasks: import("@contracts/orchestration").TaskNode[] }[] = [];
    for (const runs of Object.values(runsBySession)) {
      for (const run of runs) {
        for (const gate of run.gates) {
          if (gate.status === "open") out.push({ runId: run.id, title: run.title, gate, tasks: run.tasks });
        }
      }
    }
    return out;
  }, [runsBySession]);

  const workerQuestions = useMemo(
    () =>
      Object.entries(pendingQuestionBySession)
        .filter(([sid]) => workerIds.has(sid))
        .map(([sid, q]) => ({ sessionId: sid, ...q })),
    [pendingQuestionBySession, workerIds],
  );

  const workerApprovals = useMemo(
    () => pendingApprovals.filter((p) => workerIds.has(p.sessionId)),
    [pendingApprovals, workerIds],
  );

  if (openGates.length === 0 && workerQuestions.length === 0 && workerApprovals.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center" style={{ fontSize: "var(--right-panel-font-size)" }}>
        <IconInbox size={22} className="text-content-subtle" />
        <div className="text-xs font-medium text-content-muted">{t("orch.inbox.empty")}</div>
        <div className="text-[0.7143em] text-content-subtle">{t("orch.inbox.emptyDesc")}</div>
      </div>
    );
  }

  return (
    <div className="h-full space-y-4 overflow-y-auto px-3 py-3" style={{ fontSize: "var(--right-panel-font-size)" }}>
      {/* ① 决策门 */}
      {openGates.length > 0 && (
        <Section title={t("orch.inbox.gates")}>
          {openGates.map(({ runId, title, gate, tasks }) => (
            <div key={gate.id} className="rounded-md border border-warning/40 bg-warning/10 px-2.5 py-2">
              <div className="flex items-center gap-1.5 text-[0.7143em] font-medium text-warning">
                <span>{t(`orch.gate.${gate.kind}`)}</span>
                <span className="truncate text-content-subtle">· {title}</span>
              </div>
              <div className="mt-1 whitespace-pre-wrap text-[0.7143em] text-content-muted">{gate.question}</div>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {gate.options.map((opt) => {
                  const task = tasks.find((x) => x.id === opt);
                  return (
                    <button
                      key={opt}
                      onClick={() => void orchResolveGate(runId, gate.id, opt)}
                      className="rounded-full border border-edge px-2 py-0.5 text-[0.686em] hover:border-accent hover:text-accent"
                    >
                      {task ? `${opt} · ${task.spec.slice(0, 36)}…` : opt}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </Section>
      )}

      {/* ② worker 提问 */}
      {workerQuestions.length > 0 && (
        <Section title={t("orch.inbox.questions")}>
          {workerQuestions.map((q) => (
            <div key={q.sessionId} className="rounded-md border border-edge bg-surface px-2.5 py-2">
              <div className="mb-1 truncate text-[0.686em] text-content-subtle">
                {t("orch.inbox.unknownSession")} · {q.sessionId.slice(0, 18)}…
              </div>
              <QuestionPrompt
                questions={q.questions}
                onSubmit={(answers) => void submitQuestion(answers, q.sessionId)}
                onDismiss={() => dismissQuestion(q.sessionId)}
              />
            </div>
          ))}
        </Section>
      )}

      {/* ③ worker 工具审批 */}
      {workerApprovals.length > 0 && (
        <Section title={t("orch.inbox.approvals")}>
          {workerApprovals.map((p) => (
            <div key={p.requestId} className="rounded-md border border-edge bg-surface px-2.5 py-2">
              <div className="text-[0.7143em] font-medium">{p.toolName}</div>
              <div className="mt-0.5 truncate font-mono text-[0.686em] text-content-subtle">
                {t("orch.inbox.unknownSession")} · {p.sessionId.slice(0, 18)}…
              </div>
              <div className="mt-1.5 flex gap-1.5">
                <button
                  onClick={() => void decideApproval(p.requestId, true)}
                  className="rounded border border-success/50 px-2 py-0.5 text-[0.686em] text-success hover:bg-success/10"
                >
                  ✓
                </button>
                <button
                  onClick={() => void decideApproval(p.requestId, false)}
                  className="rounded border border-danger/50 px-2 py-0.5 text-[0.686em] text-danger hover:bg-danger/10"
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
        </Section>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-[0.7143em] font-medium uppercase tracking-wide text-content-subtle">{title}</div>
      <div className={cn("space-y-2")}>{children}</div>
    </div>
  );
}
