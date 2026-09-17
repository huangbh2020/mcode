/**
 * 编排待处理卡(主面板,composer 上方提示槽)。
 *
 * 把「等你处理」的编排事项聚到主面板,与普通审批卡同位呈现:
 *  ① 本会话 run 的 open 决策门(escalation/budget/review_pick)→ orchResolveGate;
 *  ② 本会话 run 派生的 worker 会话的 AskUserQuestion → submitQuestion(显式
 *     传 workerSessionId,从协调者视角回答无障碍);
 *  ③ 同源 worker 会话的工具审批 → decideApproval(按 requestId 全局路由)。
 *
 * 优先级:本会话自己的审批/提问(ApprovalPrompt / QuestionPrompt)永远占先
 * —— ChatPane 只在三者都不在场时才挂载本卡。卡片可收起为一条琥珀横幅;
 * 待处理数量增加时自动展开一次(收起状态不吞新事项的感知)。
 * 跨会话的 worker 待办不在此聚合,到各 worker 会话自己的聊天面板处理。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { isElectron } from "@renderer/lib/platform.js";
import type { Gate, TaskNode } from "@contracts/orchestration";
import { QuestionPrompt } from "@renderer/components/chat/QuestionPrompt.js";
import { IconAlertTriangle, IconChevronDown, IconChevronUp } from "@renderer/lib/icons.js";

export function OrchAttentionCard({ sessionId }: { sessionId: string }) {
  const { t } = useI18n();
  const runs = useSessionStore((s) => (sessionId ? s.orchRunsBySession[sessionId] : undefined));
  const pendingQuestionBySession = useSessionStore((s) => s.pendingQuestionBySession);
  const pendingApprovals = useSessionStore((s) => s.pendingApprovals);
  const orchResolveGate = useSessionStore((s) => s.orchResolveGate);
  const submitQuestion = useSessionStore((s) => s.submitQuestion);
  const dismissQuestion = useSessionStore((s) => s.dismissQuestionFor);
  const decideApproval = useSessionStore((s) => s.decideApproval);

  const openGates = useMemo(() => {
    const out: { runId: string; runTitle: string; gate: Gate; tasks: TaskNode[] }[] = [];
    for (const run of runs ?? []) {
      for (const gate of run.gates) {
        if (gate.status === "open") out.push({ runId: run.id, runTitle: run.title, gate, tasks: run.tasks });
      }
    }
    return out;
  }, [runs]);

  // worker 会话集合:只收「本会话 run」派生的 worker(跨会话的不在此聚合)。
  const workerIds = useMemo(() => {
    const ids = new Set<string>();
    for (const run of runs ?? []) {
      for (const task of run.tasks) {
        for (const d of task.dispatches) {
          if (d.workerSessionId) ids.add(d.workerSessionId);
        }
      }
    }
    return ids;
  }, [runs]);

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

  const total = openGates.length + workerQuestions.length + workerApprovals.length;

  // 数量增加 → 自动展开一次;用户手动收起后,再来新事项仍会再次展开。
  const [open, setOpen] = useState(false);
  const prevTotal = useRef(0);
  useEffect(() => {
    if (total > prevTotal.current) setOpen(true);
    prevTotal.current = total;
  }, [total]);

  if (!isElectron || total === 0) return null;

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mb-1.5 flex w-full items-center gap-2 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2 text-left text-[12.5px] text-warning transition-colors hover:bg-warning/15"
      >
        <IconAlertTriangle size={14} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">{t("orch.attend.banner", { n: total })}</span>
        <IconChevronUp size={14} className="shrink-0" />
      </button>
    );
  }

  return (
    <div className="mb-1.5 space-y-2 rounded-xl border border-warning/40 bg-warning/5 p-2.5">
      <div className="flex items-center gap-1.5 text-[12px] font-medium text-warning">
        <IconAlertTriangle size={13} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">{t("orch.attend.banner", { n: total })}</span>
        <button
          onClick={() => setOpen(false)}
          className="rounded p-0.5 text-content-subtle hover:bg-surface-hover hover:text-content"
          title={t("orch.attend.collapse")}
        >
          <IconChevronDown size={14} />
        </button>
      </div>

      {/* ① 决策门 */}
      {openGates.map(({ runId, runTitle, gate, tasks }) => (
        <div key={gate.id} className="rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-2">
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-warning">
            <span>{t(`orch.gate.${gate.kind}`)}</span>
            <span className="truncate text-content-subtle">· {runTitle}</span>
          </div>
          <div className="mt-1 whitespace-pre-wrap text-[11.5px] text-content-muted">{gate.question}</div>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {gate.options.map((opt) => {
              const task = tasks.find((x) => x.id === opt);
              return (
                <button
                  key={opt}
                  onClick={() => void orchResolveGate(runId, gate.id, opt)}
                  className="rounded-full border border-edge bg-surface px-2 py-0.5 text-[10.5px] hover:border-accent hover:text-accent"
                >
                  {task ? `${opt} · ${task.spec.slice(0, 36)}…` : opt}
                </button>
              );
            })}
          </div>
        </div>
      ))}

      {/* ② worker 提问 */}
      {workerQuestions.map((q) => (
        <div key={q.sessionId} className="rounded-lg border border-edge bg-surface px-2.5 py-2">
          <div className="mb-1 truncate font-mono text-[10px] text-content-subtle">
            {t("orch.inbox.questions")} · {q.sessionId.slice(0, 18)}…
          </div>
          <QuestionPrompt
            questions={q.questions}
            onSubmit={(answers) => void submitQuestion(answers, q.sessionId)}
            onDismiss={() => dismissQuestion(q.sessionId)}
          />
        </div>
      ))}

      {/* ③ worker 工具审批 */}
      {workerApprovals.map((p) => (
        <div key={p.requestId} className="rounded-lg border border-edge bg-surface px-2.5 py-2">
          <div className="text-[11px] font-medium">{p.toolName}</div>
          <div className="mt-0.5 truncate font-mono text-[10px] text-content-subtle">
            {t("orch.inbox.approvals")} · {p.sessionId.slice(0, 18)}…
          </div>
          <div className="mt-1.5 flex gap-1.5">
            <button
              onClick={() => void decideApproval(p.requestId, true)}
              className="rounded border border-success/50 px-2 py-0.5 text-[10.5px] text-success hover:bg-success/10"
            >
              ✓
            </button>
            <button
              onClick={() => void decideApproval(p.requestId, false)}
              className="rounded border border-danger/50 px-2 py-0.5 text-[10.5px] text-danger hover:bg-danger/10"
            >
              ✕
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
