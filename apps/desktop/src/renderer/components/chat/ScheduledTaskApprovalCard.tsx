import { memo, useEffect, useMemo, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useToastStore } from "@renderer/stores/toastStore.js";
import { Button } from "@renderer/components/ui/index.js";
import {
  IconClock,
  IconCalendar,
  IconCheck,
  IconCopy,
  IconChevronDown,
  IconChevronUp,
  IconArrowRight,
  IconAlertCircle,
  IconSparkles,
} from "@renderer/lib/icons.js";
import {
  AutomationScheduleSchema,
  computeNextRun,
  type AutomationSchedule,
} from "@contracts/automation";
import {
  describeSchedule,
  formatUntil,
  fmtClock,
} from "@renderer/components/automation/automationFormat.js";

interface TaskProposalData {
  title: string;
  schedule: AutomationSchedule;
  prompt: string;
  skillNames?: string[];
}

interface ScheduledTaskApprovalCardProps {
  rawJson: string;
  className?: string;
}

/** 提取文本中的第一个合法 JSON 对象 */
function extractProposal(raw: string): TaskProposalData | null {
  const trimmed = raw.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
    const schedResult = AutomationScheduleSchema.safeParse(obj.schedule);
    if (!schedResult.success) return null;
    const title = typeof obj.title === "string" && obj.title.trim() ? obj.title.trim() : "未命名定时任务";
    const prompt = typeof obj.prompt === "string" ? obj.prompt.trim() : "";
    const skillNames = Array.isArray(obj.skillNames)
      ? obj.skillNames.filter((s): s is string => typeof s === "string")
      : undefined;
    return {
      title,
      schedule: schedResult.data,
      prompt,
      skillNames,
    };
  } catch {
    return null;
  }
}

/** FNV-1a 32-bit fingerprint of the proposal JSON — the durable key under
 *  which the confirmation decision is persisted (settings ledger). The card
 *  renders from message content, so the same message always yields the same
 *  fingerprint, across restarts and rehydration. */
function proposalFingerprint(raw: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export const ScheduledTaskApprovalCard = memo(function ScheduledTaskApprovalCard({
  rawJson,
  className,
}: ScheduledTaskApprovalCardProps) {
  const { t } = useI18n();
  const proposal = useMemo(() => extractProposal(rawJson), [rawJson]);
  const [expandedPrompt, setExpandedPrompt] = useState(false);
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  /** Click-time feedback only — the durable「已创建」state is the persisted
   *  confirmation LEDGER below (survives restarts; deleting the task never
   *  re-opens the proposal). */
  const [justCreatedTaskId, setJustCreatedTaskId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const fingerprint = useMemo(() => proposalFingerprint(rawJson.trim()), [rawJson]);
  const confirmedProposalFps = useSessionStore((s) => s.confirmedProposalFps);
  const confirmedProposalFpsLoaded = useSessionStore((s) => s.confirmedProposalFpsLoaded);
  const loadConfirmedProposals = useSessionStore((s) => s.loadConfirmedProposals);
  const confirmProposal = useSessionStore((s) => s.confirmProposal);
  useEffect(() => {
    void loadConfirmedProposals();
  }, [loadConfirmedProposals]);

  /* Secondary signal: a LIVE task row with the proposal's exact
   * title+prompt fingerprint (createScheduledTask stores both verbatim).
   * Marks the card confirmed even if the ledger entry is missing (e.g.
   * confirmed before the ledger existed). */
  const automations = useSessionStore((s) => s.automations);
  const matchedTask = useMemo(() => {
    if (!proposal) return null;
    return (
      automations.find(
        (a) => a.deletedAt == null && a.title === proposal.title && a.prompt === proposal.prompt,
      ) ?? null
    );
  }, [automations, proposal]);

  const persistedConfirmed = confirmedProposalFps.includes(fingerprint);
  const confirmed = justCreatedTaskId != null || persistedConfirmed || matchedTask != null;
  const createdTaskId = justCreatedTaskId ?? matchedTask?.id ?? null;

  // 下次预计运行时间预览
  const nextRunPreview = useMemo(() => {
    if (!proposal?.schedule) return null;
    const nextAt = computeNextRun(proposal.schedule, new Date());
    if (!nextAt) return null;
    return `${fmtClock(nextAt)} (${formatUntil(nextAt)})`;
  }, [proposal?.schedule]);

  if (!proposal) {
    return (
      <div className={cn("my-2 rounded-xl border border-edge/60 bg-surface-muted/60 p-3.5 text-xs text-content-muted", className)}>
        <div className="flex items-center gap-2 text-warning font-medium mb-1">
          <IconAlertCircle size={15} />
          <span>{t("automation.card.parseError")}</span>
        </div>
        <pre className="font-mono text-[11px] overflow-x-auto text-content-subtle bg-surface p-2 rounded border border-edge/40">
          {rawJson}
        </pre>
      </div>
    );
  }

  const handleCopyPrompt = async () => {
    if (!proposal.prompt) return;
    try {
      await navigator.clipboard.writeText(proposal.prompt);
      setCopiedPrompt(true);
      setTimeout(() => setCopiedPrompt(false), 2000);
    } catch {
      // ignore
    }
  };

  const handleConfirmCreate = async () => {
    if (isCreating || createdTaskId) return;
    setIsCreating(true);
    try {
      const st = useSessionStore.getState();
      const currentSessionId = st.activeSessionId;
      const currentSession = currentSessionId ? st.getSessionById(currentSessionId) : null;
      if (!currentSession) {
        useToastStore.getState().push({ kind: "error", title: t("automation.needSession") });
        return;
      }

      const created = await st.createScheduledTask({
        projectId: currentSession.projectId,
        parentSessionId: currentSession.id,
        title: proposal.title,
        prompt: proposal.prompt,
        skillNames: proposal.skillNames ?? [],
        filePaths: [],
        providerId: currentSession.providerId,
        model: currentSession.model,
        customModelId: currentSession.customModelId,
        effort: currentSession.effort,
        permissionMode: currentSession.permissionMode,
        schedule: proposal.schedule,
        enabled: true,
        keepRuns: 20,
      });

      if (created) {
        setJustCreatedTaskId(created.id);
        // Durable confirmation: the ledger entry (not the task row) is what
        // keeps this card 「已创建」 across restarts and task deletion.
        void confirmProposal(fingerprint);
        useToastStore.getState().push({
          kind: "info",
          title: t("automation.card.approved"),
          body: created.title,
        });
      }
    } catch (err) {
      useToastStore.getState().push({
        kind: "error",
        title: (err as Error).message,
      });
    } finally {
      setIsCreating(false);
    }
  };

  const handleGoToTaskSession = () => {
    if (!createdTaskId) return;
    const st = useSessionStore.getState();
    // Open the right-panel 定时任务 tab aimed at the task: select the row so
    // the panel's overview + run instances land on it, and scope the panel
    // to the task's owning session (its parent) so the row is in scope even
    // if the card is clicked from a different session later.
    const parent = st.automations.find((a) => a.id === createdTaskId)?.parentSessionId ?? null;
    st.setSchedSelected(createdTaskId);
    st.openSchedPanel(parent);
  };

  return (
    <div
      className={cn(
        "my-2.5 w-full max-w-2xl rounded-2xl border border-edge-panel bg-surface shadow-xs transition-all",
        !confirmed && "hover:border-accent/35",
        className,
      )}
    >
      {/* 顶部标题与状态 */}
      <div className="flex items-center justify-between gap-3 border-b border-edge-panel/60 p-3.5 pb-3">
        <div className="flex items-center gap-3 min-w-0">
          <div
            className={cn(
              "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-colors",
              confirmed
                ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : "bg-accent/10 text-accent",
            )}
          >
            {confirmed ? <IconCheck size={18} /> : <IconClock size={18} />}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-medium tracking-wide text-content-subtle">
                {t("automation.card.proposalTitle")}
              </span>
              {/* 技能徽标紧跟在分类后 */}
              {proposal.skillNames && proposal.skillNames.length > 0 && (
                <div className="flex items-center gap-1">
                  {proposal.skillNames.map((s) => (
                    <span
                      key={s}
                      className="inline-flex items-center gap-1 rounded-md bg-surface-muted px-1.5 py-0.5 font-mono text-[10px] text-content-muted border border-edge/40"
                    >
                      <IconSparkles size={9} className="text-accent" />
                      /{s}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <h4 className="truncate text-sm font-semibold text-content mt-0.5 tracking-tight">
              {proposal.title}
            </h4>
          </div>
        </div>

        {/* 状态徽标 */}
        <div className="shrink-0">
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[10.5px] font-medium",
              confirmed
                ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20"
                : "bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20",
            )}
          >
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                confirmed ? "bg-emerald-500" : "bg-amber-500",
              )}
            />
            {confirmed ? t("automation.card.approved") : t("automation.card.pendingApproval")}
          </span>
        </div>
      </div>

      {/* 核心配置信息 */}
      <div className="p-3.5 space-y-2.5">
        {/* 定时调度条 */}
        <div className="flex items-center justify-between gap-2 rounded-xl bg-surface-muted/40 border border-edge/40 px-3 py-2 text-xs">
          <div className="flex items-center gap-2 min-w-0">
            <IconCalendar size={14} className="shrink-0 text-content-subtle" />
            <span className="font-semibold text-content truncate">
              {describeSchedule(proposal.schedule)}
            </span>
            {nextRunPreview && (
              <span className="hidden sm:inline text-[11px] text-content-subtle truncate">
                · {t("automation.nextRunIn", { time: nextRunPreview })}
              </span>
            )}
          </div>
          {nextRunPreview && (
            <span className="sm:hidden text-[10px] text-content-subtle shrink-0">
              {nextRunPreview}
            </span>
          )}
        </div>

        {/* 执行提示词独立卡片 */}
        {proposal.prompt && (
          <div className="rounded-xl border border-edge/40 bg-surface-muted/30 overflow-hidden">
            <div className="flex items-center justify-between border-b border-edge/30 bg-surface-muted/50 px-3 py-1.5">
              <span className="text-[10.5px] font-medium text-content-subtle uppercase tracking-wider font-mono">
                {t("automation.card.taskPrompt")}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setExpandedPrompt(!expandedPrompt)}
                  className="flex items-center gap-0.5 text-[11px] text-content-subtle hover:text-content transition-colors"
                >
                  <span>
                    {expandedPrompt
                      ? t("automation.card.collapsePrompt")
                      : t("automation.card.expandPrompt")}
                  </span>
                  {expandedPrompt ? <IconChevronUp size={12} /> : <IconChevronDown size={12} />}
                </button>
                <div className="h-3 w-px bg-edge/50" />
                <button
                  type="button"
                  onClick={handleCopyPrompt}
                  title="Copy Prompt"
                  className="flex items-center gap-1 rounded px-1 py-0.5 text-[11px] text-content-subtle hover:bg-surface-hover hover:text-content transition-colors"
                >
                  {copiedPrompt ? (
                    <>
                      <IconCheck size={12} className="text-emerald-500" />
                      <span className="text-[10px] text-emerald-500">已复制</span>
                    </>
                  ) : (
                    <IconCopy size={12} />
                  )}
                </button>
              </div>
            </div>
            <div
              className={cn(
                "p-3 font-mono text-[11.5px] leading-relaxed text-content select-text whitespace-pre-wrap break-words",
                !expandedPrompt && "line-clamp-3",
              )}
            >
              {proposal.prompt}
            </div>
          </div>
        )}
      </div>

      {/* 底部操作与提示 */}
      <div className="border-t border-edge-panel/50 px-3.5 py-2.5 flex items-center justify-between gap-3">
        <div className="text-xs text-content-subtle flex items-center gap-1.5 min-w-0">
          {confirmed ? (
            <span className="inline-flex items-center gap-1.5 text-content-muted truncate text-[11.5px]">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0" />
              任务已就绪并在后台待命运行
            </span>
          ) : (
            <span className="truncate text-[11.5px] text-content-subtle">
              {t("automation.card.feedbackHint")}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {!confirmed ? (
            <Button
              variant="primary"
              size="sm"
              disabled={isCreating}
              className="gap-1.5 text-xs font-medium px-3 h-7.5 shadow-xs"
              onClick={handleConfirmCreate}
            >
              <IconCheck size={14} />
              <span>{isCreating ? t("automation.card.creating") : t("automation.card.confirmCreate")}</span>
            </Button>
          ) : createdTaskId ? (
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 text-xs text-content-muted hover:text-content px-3 h-7.5"
              onClick={handleGoToTaskSession}
            >
              <span>{t("automation.card.viewTaskSession")}</span>
              <IconArrowRight size={13} />
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
});
