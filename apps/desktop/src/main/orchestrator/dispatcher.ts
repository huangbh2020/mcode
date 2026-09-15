/**
 * 派发器:把一个 ready 任务变成一个正在运行的 worker。
 *
 * agent runner → 结构化子会话(kind='orch-worker',记 parentSessionId,
 *   orch_meta 列携带完成权威凭证),复用 Session 持久化/resume/usage/
 *   transcript —— 断点续跑近乎免费;跨 provider 由 providerRegistry 直接
 *   达成(profile.providerId)。worker 对编排协议零感知:完成由基础设施
 *   从结构化事件(turn.done/turn.files/token-usage)推导,worker_done
 *   不是 prose 协议而是事件推导。
 * terminal runner → 子进程命令(逃生舱,兼容任意 agent CLI),输出落盘
 *   为报告,退出码即结论。
 */
import type { AgentProfile, DispatchContext, OrchestrationRun, TaskNode } from "@contracts/orchestration";
import type { Session } from "@contracts/session";
import { ProjectRepo, SessionRepo } from "@main/store/repositories.js";
import { runtimeManager } from "@main/claude/RuntimeManager.js";
import { createOrReuseSession } from "@main/lib/sessionStart.js";
import { resolveSessionCwd } from "@main/lib/sessionCwd.js";
import { ProfileStore } from "./profiles.js";
import { decideWorktree } from "./worktreePlanner.js";
import { estimateTokens } from "./taskStore.js";
import { log } from "@main/lib/logger.js";
import { uid } from "@main/utils.js";
import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { app } from "electron";

export interface DispatchOutcome {
  ok: boolean;
  error?: string;
  workerSessionId?: string;
  dispatchId: string;
}

/** 派发上下文块 —— 简报的结构化头部(信息性;真正的权威在 orch_meta 列)。 */
function contextBlock(ctx: DispatchContext): string {
  return [
    "【派发上下文 / Dispatch Context】",
    `runId: ${ctx.runId}`,
    `taskId: ${ctx.taskId}`,
    `dispatchId: ${ctx.dispatchId}`,
    `coordinatorSessionId: ${ctx.coordinatorSessionId}`,
  ].join("\n");
}

/** worker 简报模板:目标/约束/上游产物/验收标准(blackboard 模式 —— 节点间
 *  只传任务简报 + 产物文件路径,不传完整对话,禁止节点间自由串话)。 */
export function buildWorkerPrompt(
  run: OrchestrationRun,
  task: TaskNode,
  profile: AgentProfile | undefined,
  upstreamArtifacts: string[],
): string {
  const sections: string[] = [];
  sections.push(profile?.systemPrompt?.trim() || "你是 Mcode 编排系统的一个 worker agent。");
  sections.push(
    [
      "【总体目标】",
      run.goal || "(未填写)",
      "",
      "【你的任务简报】",
      task.spec,
    ].join("\n"),
  );
  if (upstreamArtifacts.length > 0) {
    sections.push(["【上游产物(blackboard)】", ...upstreamArtifacts.map((a) => `- ${a}`)].join("\n"));
  }
  if (task.reviewOf) {
    const target = run.tasks.find((t) => t.id === task.reviewOf);
    if (target) {
      sections.push(
        [
          "【审查目标】",
          `你在审查任务 ${target.id} 的产出。`,
          target.worktreePath ? `实现发生在 worktree:${target.worktreePath}(与主检出比对差异)` : "",
          target.result?.filesModified?.length
            ? `改动文件:\n${target.result.filesModified.map((f) => `- ${f}`).join("\n")}`
            : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }
  }
  sections.push(
    [
      "【工作纪律】",
      "- 只做简报内的事;产物写到简报指定的路径。",
      "- 遇到阻塞才提问(AskUserQuestion);能自己查证的不要问。",
      task.reviewOf
        ? "- 你是审查者:只读不改。最后一行输出 `VERDICT: pass` 或 `VERDICT: changes_requested`。"
        : "- 结束时输出一段简短总结:做了什么、改了/产出哪些文件、如何验证。",
    ].join("\n"),
  );
  return sections.filter(Boolean).join("\n\n");
}

/** 上游产物的 blackboard 收集:直接依赖的 completed 任务产物路径 + 修改文件。 */
export function collectUpstreamArtifacts(run: OrchestrationRun, task: TaskNode): string[] {
  const byId = new Map(run.tasks.map((t) => [t.id, t]));
  const out: string[] = [];
  for (const d of task.deps) {
    const dep = byId.get(d);
    if (!dep || dep.status !== "completed") continue;
    out.push(...dep.artifacts);
    out.push(...(dep.result?.filesModified ?? []));
  }
  return [...new Set(out)];
}

/** 派发一个 agent 任务:创建 worker 子会话并发送首轮简报。 */
export async function dispatchAgentTask(
  run: OrchestrationRun,
  task: TaskNode,
): Promise<DispatchOutcome> {
  const dispatchId = uid("disp_");
  const profile = task.profileId ? ProfileStore.get(task.profileId) : undefined;
  if (task.profileId && !profile) {
    return { ok: false, dispatchId, error: `agent profile not found: ${task.profileId}` };
  }
  const project = ProjectRepo.get(run.projectId);
  if (!project) return { ok: false, dispatchId, error: `project not found: ${run.projectId}` };

  const wt = decideWorktree(run, task, profile);
  const ctx: DispatchContext = {
    runId: run.id,
    taskId: task.id,
    dispatchId,
    coordinatorSessionId: run.parentSessionId,
  };
  const prompt = buildWorkerPrompt(run, task, profile, collectUpstreamArtifacts(run, task));

  const { session } = createOrReuseSession(
    {
      projectId: run.projectId,
      // 显式标题 → 永远建新行(防复用逻辑把 worker 塞进用户会话)。
      title: `${task.spec.slice(0, 30)}${task.spec.length > 30 ? "…" : ""}`.replace(/\s+/g, " "),
      providerId: profile?.providerId,
      model: profile?.model,
      effort: profile?.effort ?? "default",
      permissionMode: profile?.permissionMode ?? "default",
      kind: "orch-worker",
      parentSessionId: run.parentSessionId,
      orchMeta: ctx,
      // 既有 worktree(打回重做)→ BIND 到同一检出;否则按决策表声明意图。
      ...(task.worktreePath
        ? { envMode: "worktree" as const, worktreePath: task.worktreePath }
        : wt.envMode === "worktree"
          ? { envMode: "worktree" as const, wtStyle: wt.wtStyle }
          : {}),
    },
    "desktop",
  );

  try {
    SessionRepo.updateStatus(session.id, "running");
    const cwd = await resolveSessionCwd(session, project);
    // 物化可能回填了 worktreePath —— 刷新快照并把路径记到任务上
    // (审查节点与 merge-back 都读它)。
    const fresh = SessionRepo.get(session.id) ?? session;
    task.worktreePath = fresh.worktreePath ?? null;
    runtimeManager.bindSession(fresh);
    await runtimeManager.sendTurn(fresh, { prompt, cwd });
    log.info(`orch dispatch: run ${run.id} task ${task.id} -> worker ${fresh.id} (${dispatchId})`);
    return { ok: true, dispatchId, workerSessionId: fresh.id };
  } catch (err) {
    const message = (err as Error).message;
    log.warn(`orch dispatch failed: run ${run.id} task ${task.id}: ${message}`);
    return { ok: false, dispatchId, error: message };
  }
}

/* ── terminal runner(逃生舱)── */

export interface TerminalDispatch {
  dispatchId: string;
  reportPath: string;
  promise: Promise<{ ok: boolean; exitCode: number; error?: string }>;
}

function orchDir(): string {
  return join(app.getPath("userData"), "orch");
}

/** 派发一个终端任务:直接跑命令(默认 bash -lc,win32 回落 cmd /c),
 *  stdout/stderr 落盘为报告。不建会话行 —— 任务面板直接读报告。 */
export function dispatchTerminalTask(run: OrchestrationRun, task: TaskNode): TerminalDispatch {
  const dispatchId = uid("disp_");
  const dir = join(orchDir(), run.id);
  const reportPath = join(dir, `${task.id}.log`);
  const project = ProjectRepo.get(run.projectId);
  const cwd = project?.path ?? process.cwd();
  const command = task.terminalCommand ?? "";

  const promise = (async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(reportPath, `$ ${command}\n`, { flag: "w" }).catch(() => {});
    if (!command) return { ok: false, exitCode: -1, error: "terminal task has no command" };
    return await new Promise<{ ok: boolean; exitCode: number; error?: string }>((resolve) => {
      const isWin = process.platform === "win32";
      const child = isWin
        ? spawn("cmd.exe", ["/c", command], { cwd })
        : spawn("/bin/bash", ["-lc", command], { cwd });
      let tail = "";
      const onData = (buf: Buffer) => {
        const text = buf.toString();
        tail = (tail + text).slice(-4000);
        void writeFile(reportPath, text, { flag: "a" }).catch(() => {});
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.on("error", (err) => resolve({ ok: false, exitCode: -1, error: err.message }));
      child.on("close", (code) => {
        void writeFile(reportPath, `\n[exit ${code ?? "signal"}]\n`, { flag: "a" }).catch(() => {});
        resolve({ ok: code === 0, exitCode: code ?? -1, error: code === 0 ? undefined : `exit code ${code}` });
      });
    });
  })();
  return { dispatchId, reportPath, promise };
}

/** 读取终端 worker 报告尾部(节点详情展示)。 */
export async function readTerminalReport(path: string, maxBytes = 8192): Promise<string> {
  try {
    const buf = await readFile(path);
    return buf.subarray(Math.max(0, buf.length - maxBytes)).toString("utf8");
  } catch {
    return "";
  }
}

export { estimateTokens };
