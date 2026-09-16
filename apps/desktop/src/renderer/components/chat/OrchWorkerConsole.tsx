/**
 * 画布内联 worker 实时输出控制台(自动编排「过程输出」的执行段)。
 *
 * run 运行中,每个 dispatched/running 的 agent 任务在画布 DAG 下方挂一条
 * 控制台:头部是任务标题 + 运行时长 + 折叠钮,展开体实时流 worker 会话的
 * assistant 块(与右栏「运行输出」的 WorkerTranscript 同源 —— worker 会话
 * 的 RuntimeEvent 经 ingestEvent 天然入桶,这里只是多一个消费面)。任务
 * 进入终态即从画布上撤下(节点打 ✓/✗,完整输出仍在右栏节点详情)。
 *
 * 数据面零新契约:workerSessionId 来自 task.dispatches 末条,消息桶经
 * prefetchSessionMessages 水合一次,实时增量由既有事件流续上。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import type { TaskNode } from "@contracts/orchestration";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { MessageBlocks } from "./MessageBlocks.js";
import { IconChevronDown, IconChevronUp } from "@renderer/lib/icons.js";

/** 节点展示标题 = spec 首行(与 worker 简报、结果整理的口径一致)。 */
export function orchTaskTitle(task: TaskNode): string {
  const line = task.spec.split("\n")[0].trim();
  return (line.length > 34 ? `${line.slice(0, 34)}…` : line) || task.id;
}

export function orchFormatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

export function OrchWorkerConsole({ task }: { task: TaskNode }) {
  const { t } = useI18n();
  const messagesBySession = useSessionStore((s) => s.messagesBySession);
  const dispatch = task.dispatches[task.dispatches.length - 1];
  const workerSessionId = task.runner === "agent" ? dispatch?.workerSessionId || undefined : undefined;
  const [open, setOpen] = useState(true);

  // worker 会话历史水合(一次性;实时事件由 ingestEvent 持续入桶)。
  useEffect(() => {
    if (!workerSessionId) return;
    void useSessionStore.getState().prefetchSessionMessages(workerSessionId);
  }, [workerSessionId]);

  const workerMessages = workerSessionId ? messagesBySession[workerSessionId] : undefined;
  const blocks = useMemo(
    () => (workerMessages ?? []).filter((m) => m.role === "assistant").flatMap((m) => m.blocks),
    [workerMessages],
  );

  // 展开时跟随尾部:新块到达即滚到底(与 WorkerTranscript 同款意图)。
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [blocks, open]);

  // 用时从派发时间戳推导(运行中取 now);父组件(画布)运行中有秒级心跳,
  // 重渲染时此处重算即同步走表,无需自备定时器。
  const elapsed = dispatch
    ? orchFormatDuration((task.status === "running" || task.status === "dispatched" ? Date.now() : (dispatch.endedAt ?? Date.now())) - dispatch.injectedAt)
    : null;

  return (
    <div className={cn("oc-console", !open && "closed")} data-orch-console-task={task.id}>
      <button type="button" className="oc-console-head" onClick={() => setOpen((o) => !o)}>
        {task.status === "running" || task.status === "dispatched" ? (
          <span className="oc-spin" aria-hidden />
        ) : (
          <span className="oc-console-dot" aria-hidden />
        )}
        <span className="oc-console-title" title={task.spec}>
          {orchTaskTitle(task)}
        </span>
        <span className="oc-console-meta">
          {elapsed ?? t("orch.status.dispatched")}
          {" · "}
          {t(`orch.status.${task.status}`)}
        </span>
        {open ? <IconChevronUp size={13} /> : <IconChevronDown size={13} />}
      </button>
      {open && (
        <div ref={scrollRef} className="oc-console-body">
          {blocks.length === 0 ? (
            <div className="flex items-center gap-2 px-2 py-3 text-[0.686em] text-content-subtle">
              {t("orch.console.waiting")}
              <span className="chat-caret" aria-hidden />
            </div>
          ) : (
            <MessageBlocks blocks={blocks} />
          )}
        </div>
      )}
    </div>
  );
}
