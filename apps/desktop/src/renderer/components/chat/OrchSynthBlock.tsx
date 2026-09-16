import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { isElectron } from "@renderer/lib/platform.js";
import type { TaskNode } from "@contracts/orchestration";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { IconExternalLink, IconSparkles } from "@renderer/lib/icons.js";

/**
 * 结果整理卡 —— 画布流第⑤步:run 全部完成后由 store 的 ingestOrchEvent
 * 自动追加进聊天流(块只锚定 runId/goal),各任务产出/产物/统计实时读
 * `orchRunsBySession`;run 不在内存时经 `ensureOrchRun` 按 id 拉取,超出
 * 本地保留上限则降级为「已归档」占位。main 侧的结果整理回合(模型汇总)
 * 紧随本卡之后流入,作为详细结论。
 *
 * 「回到画布」按 runId 锚点(`data-orch-canvas-run`)滚动定位画布卡并闪
 * 光提示;画布不在 DOM(归档/其他会话)则退回打开运行总览。
 */

/** 节点展示标题 = spec 首行(与画布节点卡、面板详情同一口径)。 */
function titleOf(task: TaskNode): string {
  const line = task.spec.split("\n")[0].trim();
  return (line.length > 40 ? `${line.slice(0, 40)}…` : line) || task.id;
}

function fmtDur(ms: number): string {
  if (ms < 0) ms = 0;
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

export function OrchSynthBlock({ runId, goal }: { synthId: string; runId: string; goal: string }) {
  const { t } = useI18n();
  const runsMap = useSessionStore((s) => s.orchRunsBySession);
  const agents = useSessionStore((s) => s.orchAgents);
  const customModels = useSessionStore((s) => s.customModels);
  const ensureOrchRun = useSessionStore((s) => s.ensureOrchRun);
  const selectOrchNode = useSessionStore((s) => s.selectOrchNode);

  const run = useMemo(() => {
    for (const list of Object.values(runsMap)) {
      const hit = list.find((r) => r.id === runId);
      if (hit) return hit;
    }
    return undefined;
  }, [runsMap, runId]);

  // 会话重开:卡在消息里但 run 不在内存 → 按 id 拉一次。
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    if (hydrated || run || !isElectron) return;
    setHydrated(true);
    void ensureOrchRun(runId);
  }, [hydrated, run, runId, ensureOrchRun]);

  if (!run) {
    return (
      <div className="oc-archived" data-archived="1">
        <div className="oc-archived-title">{t("orch.canvas.archived")}</div>
        <div className="oc-archived-desc">{goal}</div>
        <div className="oc-archived-desc">{t("orch.canvas.archivedDesc")}</div>
      </div>
    );
  }

  const doneCount = run.tasks.filter((x) => x.status === "completed").length;
  // 总耗时 = 最早派发 → 最晚收尾(跨任务并行的墙钟口径)。
  let startedAt = Infinity;
  let endedAt = 0;
  let tokens = 0;
  for (const task of run.tasks) {
    for (const d of task.dispatches) {
      startedAt = Math.min(startedAt, d.injectedAt);
      endedAt = Math.max(endedAt, d.endedAt ?? d.injectedAt);
    }
    if (task.result?.usage) {
      tokens += (task.result.usage.inputTokens ?? 0) + (task.result.usage.outputTokens ?? 0);
    }
  }
  const duration = Number.isFinite(startedAt) ? fmtDur(endedAt - startedAt) : null;
  const files = Array.from(
    new Set(run.tasks.flatMap((x) => [...(x.result?.filesModified ?? []), ...x.artifacts])),
  );

  const profileOf = (task: TaskNode) => (task.profileId ? agents.find((a) => a.id === task.profileId) : undefined);
  const modelLabelOf = (task: TaskNode): string | null => {
    if (task.customModelId) {
      const cfg = customModels.find((c) => c.id === task.customModelId);
      if (cfg) return cfg.name;
    }
    const p = profileOf(task);
    if (p) return p.model === "default" ? null : p.model;
    return null;
  };

  const backToCanvas = () => {
    const el = document.querySelector(`[data-orch-canvas-run="${runId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("oc-flash");
      setTimeout(() => el.classList.remove("oc-flash"), 900);
    } else {
      selectOrchNode(runId, null);
    }
  };

  return (
    <div className="oc-synth" data-orch-synth-run={runId}>
      {/* 头部:标识 + 汇总统计 chip */}
      <div className="oc-synth-head">
        <IconSparkles size={14} className="shrink-0" />
        <span className="oc-synth-title">{t("orch.canvas.synthDone")}</span>
        <span className="oc-synth-chip">
          {[
            `${doneCount}/${run.tasks.length}`,
            duration ?? "",
            `$${run.spentUsd.toFixed(2)}`,
            tokens > 0 ? `${tokens.toLocaleString()} tk` : "",
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </div>
      <div className="oc-synth-body">
        <div className="oc-synth-sec">
          <div className="oc-synth-h">{t("orch.synth.goal")}</div>
          <div className="oc-synth-goal">{goal}</div>
        </div>
        <div className="oc-synth-sec">
          <div className="oc-synth-h">{t("orch.synth.tasks")}</div>
          <ul className="oc-synth-list">
            {run.tasks.map((task) => {
              const p = profileOf(task);
              const m = modelLabelOf(task);
              return (
                <li key={task.id}>
                  <span className="oc-synth-task">
                    <b>
                      {task.id} {titleOf(task)}
                    </b>
                    <span className="oc-synth-task-meta">
                      ({[p ? `${p.icon} ${p.name}` : null, m].filter(Boolean).join(" · ")})
                    </span>
                  </span>
                  <span className="oc-synth-task-result">
                    {task.result?.summary?.trim() || t("orch.synth.noSummary")}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
        {files.length > 0 && (
          <div className="oc-synth-sec">
            <div className="oc-synth-h">{t("orch.synth.files")}</div>
            <div className="oc-synth-files">
              {files.map((f) => (
                <span key={f} title={f}>
                  {f}
                </span>
              ))}
            </div>
          </div>
        )}
        <div className="oc-synth-foot">
          <button className="oc-btn" onClick={() => selectOrchNode(runId, null)}>
            <IconExternalLink size={12} />
            {t("orch.canvas.openDetail")}
          </button>
          <button className="oc-btn" onClick={backToCanvas}>
            {t("orch.canvas.backToCanvas")}
          </button>
        </div>
      </div>
    </div>
  );
}
