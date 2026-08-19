import { useEffect, useMemo, useRef, useState } from "react";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import type { Block, ChatMessage } from "@renderer/stores/sessionStore.js";
import type { SubagentSnapshot, TurnUsageRecord } from "@contracts/runtime";
import { cn } from "@renderer/lib/cn.js";
import { fmtTokens } from "@renderer/lib/contextWindow.js";
import { ToolIcon, toolSummary } from "@renderer/components/chat/MessageBlocks.js";
import { SUBAGENT_STATUS_META } from "@renderer/components/chat/ActivityPopover.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import {
  IconAlertTriangle,
  IconArrowsMinimize,
  IconBrain,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconClipboard,
  IconFileCode,
  IconListDetails,
  IconLoader2,
  IconMessage,
  IconPaperclip,
  IconPhoto,
  IconUser,
  IconX,
} from "@renderer/lib/icons.js";
import {
  buildTurnGroups,
  countActions,
  fmtClockTime,
  fmtDuration,
  imageCountsByToolCall,
  matchUsageRecords,
  SUBAGENT_TOOLS,
  toolCategory,
  TOOL_BADGE_CLS,
  turnFilesTotals,
  usageInputTokens,
  userMessagePreview,
  type TurnGroup,
} from "./turnFlowModel.js";

/* Module-level stable defaults — zustand selectors must never build fresh
 * array/object references per render (re-render loop hazard). */
const EMPTY_MESSAGES: ChatMessage[] = [];
const EMPTY_USAGE: TurnUsageRecord[] = [];
const EMPTY_SUBAGENTS: SubagentSnapshot[] = [];

/**
 * Turn Flow panel — the right-panel "turns" tab body.
 *
 * A vertical, timeline-style visualization of how the model worked through
 * each turn of the active session: the user prompt it received, every action
 * it took while processing (thinking, tool calls, subagent delegations,
 * questions back to the user, plans, touched files), its reply, and what the
 * turn cost in tokens / USD / wall time.
 *
 * Everything is derived from store state that already exists — the message
 * stream (turn grouping via the implicit user-message boundary + `turnMeta`)
 * and the per-session usage history. No new IPC, no main-process changes.
 * Older turns beyond the loaded message page appear via a "load older"
 * affordance that reuses the chat's paged loader.
 */
export function TurnFlowPanel() {
  const { t } = useI18n();
  const sessionId = useSessionStore((s) => s.activeSessionId);
  const messages = useSessionStore((s) =>
    sessionId ? (s.messagesBySession[sessionId] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES,
  );
  const usageHistory = useSessionStore((s) =>
    sessionId ? (s.usageHistoryBySession[sessionId] ?? EMPTY_USAGE) : EMPTY_USAGE,
  );
  const subagents = useSessionStore((s) =>
    sessionId ? (s.subagentsBySession[sessionId] ?? EMPTY_SUBAGENTS) : EMPTY_SUBAGENTS,
  );
  const hasMore = useSessionStore((s) =>
    sessionId ? (s.hasMoreMessagesBySession[sessionId] ?? false) : false,
  );
  const loadingOlder = useSessionStore((s) =>
    sessionId ? (s.loadingOlderBySession[sessionId] ?? false) : false,
  );
  const sessionRunning = useSessionStore((s) =>
    sessionId ? (s.runningBySession[sessionId] ?? false) : false,
  );
  const loadOlder = useSessionStore((s) => s.loadOlderMessages);

  const groups = useMemo(() => buildTurnGroups(messages), [messages]);
  const usageByTurn = useMemo(
    () => matchUsageRecords(groups, usageHistory),
    [groups, usageHistory],
  );

  /* Expansion state (turn index → open). The latest turn auto-expands; older
   * ones render collapsed (their headers already summarize the actions). A
   * NEW latest turn (keyed by its user message id, so loading an older page
   * doesn't re-trigger) re-opens itself and folds the previous one.
   *
   * Declared BEFORE the latest-turn effect: on mount / session switch the
   * reset must run first, or it would wipe the expansion the latest-turn
   * effect just seeded (effects run in declaration order). */
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const seenLatestRef = useRef<string | null>(null);
  useEffect(() => {
    seenLatestRef.current = null;
    setExpanded(new Set());
  }, [sessionId]);
  const latestKey = groups.length
    ? (groups[groups.length - 1].userMessage?.id ?? groups[groups.length - 1].assistantMessages[0]?.id ?? "")
    : "";
  useEffect(() => {
    if (!latestKey) {
      seenLatestRef.current = null;
      return;
    }
    if (seenLatestRef.current === latestKey) return;
    seenLatestRef.current = latestKey;
    setExpanded(new Set([groups[groups.length - 1].index]));
    // groups only matters for the last index; latestKey captures the change.
  }, [latestKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (index: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  /* Auto-follow: keep the list pinned to the bottom while a turn streams,
   * unless the user scrolled up to inspect history (re-pin by scrolling back
   * near the bottom). Re-arms on session switch. */
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = true;
    el.scrollTop = el.scrollHeight;
  }, [sessionId]);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !pinnedRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, expanded]);

  const totals = useMemo(
    () =>
      usageHistory.reduce(
        (acc, r) => {
          acc.tokens += r.totalProcessedTokens;
          acc.cost += r.costUsd ?? 0;
          return acc;
        },
        { tokens: 0, cost: 0 },
      ),
    [usageHistory],
  );

  /* ── empty states ── */
  if (!sessionId) {
    return (
      <PanelEmptyState
        icon={<IconListDetails size={22} className="opacity-60" />}
        title={t("ide.turns.noSessionTitle")}
        desc={t("ide.turns.noSessionDesc")}
      />
    );
  }
  if (groups.length === 0) {
    return (
      <PanelEmptyState
        icon={<IconListDetails size={22} className="opacity-60" />}
        title={t("ide.turns.emptyTitle")}
        desc={t("ide.turns.emptyDesc")}
      />
    );
  }

  return (
    <div
      ref={scrollRef}
      onScroll={() => {
        const el = scrollRef.current;
        if (!el) return;
        pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
      className="h-full overflow-y-auto"
      style={{ fontSize: "var(--right-panel-font-size)" }}
    >
      {/* Summary header: turn count + session-wide token/cost totals. */}
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-edge bg-surface px-3 py-2">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold text-content">
          <IconListDetails size={12} className="opacity-80" />
          {t("ide.turns.title")}
        </span>
        <span className="ml-auto flex items-center gap-1.5 text-[10px] tabular-nums text-content-subtle">
          <span>{t("ide.turns.summaryTurns", { n: groups.length })}</span>
          {totals.tokens > 0 && <span>· {fmtTokens(totals.tokens)} tokens</span>}
          {totals.cost > 0 && <span>· ${totals.cost.toFixed(2)}</span>}
        </span>
      </div>

      {hasMore && (
        <div className="px-3 py-1.5">
          <button
            type="button"
            disabled={loadingOlder}
            onClick={() => sessionId && loadOlder(sessionId)}
            className="flex w-full items-center justify-center gap-1.5 rounded-md border border-edge px-2 py-1 text-[11px] text-content-muted transition-colors hover:bg-surface-hover hover:text-content disabled:opacity-60"
          >
            {loadingOlder && <IconLoader2 size={11} className="animate-spin" />}
            {loadingOlder ? t("ide.turns.loading") : t("ide.turns.loadOlder")}
          </button>
        </div>
      )}

      <div className="space-y-2 px-2 py-2 pb-4">
        {groups.map((g) => (
          <TurnSection
            key={g.userMessage?.id ?? `headless-${g.index}`}
            group={g}
            usage={usageByTurn.get(g.index)}
            subagents={subagents}
            waitingModel={
              g.index === groups.length &&
              sessionRunning &&
              g.assistantMessages.length === 0
            }
            expanded={expanded.has(g.index)}
            onToggle={() => toggle(g.index)}
          />
        ))}
      </div>
    </div>
  );
}

/* ─────────────── empty state ─────────────── */

function PanelEmptyState({
  icon,
  title,
  desc,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
}) {
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center"
      style={{ fontSize: "var(--right-panel-font-size)" }}
    >
      <div className="text-content-subtle">{icon}</div>
      <div className="text-[12px] font-medium text-content-muted">{title}</div>
      <div className="max-w-[220px] text-[11px] leading-relaxed text-content-subtle">{desc}</div>
    </div>
  );
}

/* ─────────────── per-turn card ─────────────── */

/** Ticking "now" while `active` — drives the live duration counter of a
 * running turn (1s resolution matches the chat stream's stat row). */
function useNowWhile(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

function TurnSection({
  group,
  usage,
  subagents,
  waitingModel,
  expanded,
  onToggle,
}: {
  group: TurnGroup;
  usage?: TurnUsageRecord;
  subagents: SubagentSnapshot[];
  waitingModel: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  const allBlocks = useMemo(
    () => group.assistantMessages.flatMap((m) => m.blocks),
    [group.assistantMessages],
  );
  const counts = useMemo(() => countActions(allBlocks), [allBlocks]);
  const imageCounts = useMemo(() => imageCountsByToolCall(allBlocks), [allBlocks]);
  const live = group.running || waitingModel;
  const now = useNowWhile(live);

  const hasError = allBlocks.some((b) => b.kind === "error");
  const startedAt = group.turnMeta?.startedAt ?? group.userMessage?.createdAt;
  const endedAt = group.turnMeta?.endedAt;
  const durationMs =
    typeof startedAt === "number" ? Math.max(0, (endedAt ?? now) - startedAt) : null;

  const collapsedChips: string[] = [];
  if (counts.tools) collapsedChips.push(t("ide.turns.countTools", { n: counts.tools }));
  if (counts.subagents) collapsedChips.push(t("ide.turns.countSubagents", { n: counts.subagents }));
  if (counts.questions) collapsedChips.push(t("ide.turns.countQuestions", { n: counts.questions }));
  if (counts.thinking) collapsedChips.push(t("ide.turns.countThinking", { n: counts.thinking }));

  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border bg-surface transition-colors",
        live ? "border-warning/50" : "border-edge",
      )}
    >
      {/* Header — click to fold/unfold. Shows identity + status + timing and,
          when collapsed, an action-count digest (the expanded body below has
          the full step list). */}
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-1.5 px-2.5 py-2 text-left transition-colors hover:bg-surface-hover"
      >
        {expanded ? (
          <IconChevronDown size={12} className="shrink-0 text-content-subtle" />
        ) : (
          <IconChevronRight size={12} className="shrink-0 text-content-subtle" />
        )}
        <span className="shrink-0 text-[11px] font-semibold tabular-nums text-content">
          #{group.index}
        </span>
        {live ? (
          <span className="flex shrink-0 items-center gap-1 text-[10px] font-medium text-warning">
            <IconLoader2 size={10} className="animate-spin" />
            {waitingModel ? t("ide.turns.waitingModel") : t("ide.turns.statusRunning")}
          </span>
        ) : hasError ? (
          <span className="shrink-0 text-[10px] font-medium text-danger">
            {t("ide.turns.statusError")}
          </span>
        ) : (
          <span className="flex shrink-0 items-center gap-0.5 text-[10px] font-medium text-accent">
            <IconCheck size={10} />
            {t("ide.turns.statusDone")}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[10px] tabular-nums text-content-subtle">
          {typeof startedAt === "number" && <span>{fmtClockTime(startedAt)}</span>}
          {durationMs !== null && <span>· {fmtDuration(durationMs)}</span>}
        </span>
      </button>

      {!expanded && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-edge/50 px-2.5 py-1.5 text-[10px] text-content-subtle">
          {collapsedChips.length > 0 ? (
            collapsedChips.map((c) => (
              <span key={c} className="rounded-full bg-surface-muted px-1.5 py-0.5">
                {c}
              </span>
            ))
          ) : (
            <span className="rounded-full bg-surface-muted px-1.5 py-0.5">
              {waitingModel ? t("ide.turns.waitingModel") : t("ide.turns.noActions")}
            </span>
          )}
          {usage && (
            <span className="ml-auto rounded-full bg-surface-muted px-1.5 py-0.5 tabular-nums">
              {fmtTokens(usage.totalProcessedTokens)} tok
              {usage.costUsd != null && usage.costUsd > 0 ? ` · $${usage.costUsd.toFixed(2)}` : ""}
            </span>
          )}
        </div>
      )}

      {expanded && (
        <div className="border-t border-edge/50 px-2.5 py-2">
          {/* Step list with a continuous spine. Every node pads left past the
              spine; its glyph (badge w/ icon) sits ON the line. */}
          <div className="relative">
            <div className="absolute bottom-3 left-[9px] top-3 w-px bg-edge" />
            <div className="space-y-1">
              {group.userMessage && <UserStep message={group.userMessage} />}
              {waitingModel && <WaitingStep />}
              {allBlocks.map((b, i) => (
                <BlockStep
                  key={`${b.kind}-${i}`}
                  block={b}
                  subagents={subagents}
                  imageCounts={imageCounts}
                />
              ))}
            </div>
          </div>
          {usage ? (
            <UsageBar record={usage} />
          ) : (
            !live && (
              <div className="pt-2 text-center text-[10px] text-content-subtle">
                {t("ide.turns.noUsage")}
              </div>
            )
          )}
        </div>
      )}
    </div>
  );
}

/* ─────────────── timeline steps ─────────────── */

/** Shared glyph slot: a 18px rounded badge centered on the timeline spine. */
function StepGlyph({
  className,
  children,
}: {
  className: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "z-10 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** The user-prompt node: what the model received this turn. */
function UserStep({ message }: { message: ChatMessage }) {
  const { t } = useI18n();
  const { text, attachments } = userMessagePreview(message);
  return (
    <div className="relative flex items-start gap-2 py-1 pl-0.5">
      <StepGlyph className="bg-accent/15 text-accent">
        <IconUser size={11} />
      </StepGlyph>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-semibold text-accent">{t("ide.turns.userNode")}</span>
          {attachments > 0 && (
            <span className="flex items-center gap-0.5 text-[10px] text-content-subtle">
              <IconPaperclip size={9} />
              {attachments}
            </span>
          )}
        </div>
        {text && (
          <p className="mt-0.5 line-clamp-2 whitespace-pre-wrap break-words text-[11px] leading-snug text-content-muted">
            {text}
          </p>
        )}
      </div>
    </div>
  );
}

/** Shown when the prompt went out but no assistant output has arrived yet. */
function WaitingStep() {
  const { t } = useI18n();
  return (
    <div className="relative flex items-center gap-2 py-1 pl-0.5">
      <StepGlyph className="bg-warning/15 text-warning">
        <IconLoader2 size={11} className="animate-spin" />
      </StepGlyph>
      <span className="text-[11px] text-content-subtle">{t("ide.turns.waitingModel")}</span>
    </div>
  );
}

/** One model-action node, dispatched on the block kind. Tool-use blocks get
 * the category-tinted badge + ToolIcon mapping shared with the chat stream,
 * so every tool reads with the same glyph it has in the conversation. */
function BlockStep({
  block,
  subagents,
  imageCounts,
}: {
  block: Block;
  subagents: SubagentSnapshot[];
  imageCounts: Map<string, number>;
}) {
  const { t } = useI18n();
  const imageCount =
    block.kind === "tool_use" ? (imageCounts.get(block.toolCallId) ?? 0) : 0;

  if (block.kind === "text") {
    if (!block.text.trim()) return null;
    return (
      <div className="relative flex items-start gap-2 py-1 pl-0.5">
        <StepGlyph className="bg-emerald-500/15 text-emerald-500">
          <IconMessage size={11} />
        </StepGlyph>
        <div className="min-w-0 flex-1">
          <span className="text-[10px] font-semibold text-emerald-500">
            {t("ide.turns.replyNode")}
          </span>
          <p className="mt-0.5 line-clamp-2 whitespace-pre-wrap break-words text-[11px] leading-snug text-content-muted">
            {block.text.trim()}
          </p>
        </div>
      </div>
    );
  }

  if (block.kind === "thinking") {
    if (!block.text.trim()) return null;
    return (
      <div className="relative flex items-start gap-2 py-1 pl-0.5">
        <StepGlyph className="bg-violet-400/15 text-violet-400">
          <IconBrain size={11} />
        </StepGlyph>
        <div className="min-w-0 flex-1">
          <span className="text-[10px] font-semibold text-violet-400">
            {t("ide.turns.thinkingNode")}
          </span>
          <p className="mt-0.5 line-clamp-1 whitespace-pre-wrap break-words text-[11px] leading-snug text-content-subtle">
            {block.text.trim()}
          </p>
        </div>
      </div>
    );
  }

  if (block.kind === "tool_use") {
    const cat = toolCategory(block.toolName);
    const summary = toolSummary(block.toolName, block.input);
    const snap = SUBAGENT_TOOLS.has(block.toolName)
      ? subagents.find(
          (a) => a.toolUseId === block.toolCallId || a.toolUseId === `synthetic:${block.toolCallId}`,
        )
      : undefined;
    return (
      <div className="relative flex items-start gap-2 py-0.5 pl-0.5">
        <StepGlyph className={TOOL_BADGE_CLS[cat]}>
          <ToolIcon name={block.toolName} className="!size-[11px]" />
        </StepGlyph>
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[11px] font-medium text-content">
              {block.toolName}
            </span>
            {block.status === "running" ? (
              <IconLoader2 size={10} className="shrink-0 animate-spin text-warning" />
            ) : block.status === "error" ? (
              <IconX size={10} className="shrink-0 text-danger" />
            ) : (
              <IconCheck size={10} className="shrink-0 text-accent" />
            )}
            {imageCount > 0 && (
              <span className="flex shrink-0 items-center gap-0.5 text-[10px] text-content-subtle">
                <IconPhoto size={9} />
                {imageCount}
              </span>
            )}
          </div>
          {summary && (
            <p className="truncate text-[10px] leading-snug text-content-subtle" title={summary}>
              {summary}
            </p>
          )}
          {snap && (
            <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[10px] text-content-subtle">
              <span
                className={cn(
                  "flex items-center gap-0.5",
                  SUBAGENT_STATUS_META[snap.status].cls,
                )}
              >
                {SUBAGENT_STATUS_META[snap.status].spin && (
                  <IconLoader2 size={9} className="animate-spin" />
                )}
                {t(SUBAGENT_STATUS_META[snap.status].labelKey)}
              </span>
              {(snap.totalTokens != null || snap.toolUses != null || snap.durationMs != null) && (
                <span className="tabular-nums">
                  {t("ide.turns.subagentDetail", {
                    tokens: snap.totalTokens != null ? fmtTokens(snap.totalTokens) : "—",
                    tools: snap.toolUses ?? "—",
                    dur: snap.durationMs != null ? fmtDuration(snap.durationMs) : "—",
                  })}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (block.kind === "plan") {
    const phaseKey =
      block.hasApproval && block.phase === "ready"
        ? "ide.turns.planApproval"
        : block.phase === "ready"
          ? "ide.turns.planReady"
          : "ide.turns.planDrafting";
    return (
      <div className="relative flex items-center gap-2 py-0.5 pl-0.5">
        <StepGlyph className="bg-indigo-400/15 text-indigo-400">
          <IconClipboard size={11} />
        </StepGlyph>
        <span className="text-[11px] font-medium text-content">{t("ide.turns.planNode")}</span>
        <span className="rounded-full bg-indigo-400/15 px-1.5 py-0.5 text-[10px] text-indigo-400">
          {t(phaseKey)}
        </span>
      </div>
    );
  }

  if (block.kind === "turn-files") {
    const totals = turnFilesTotals([block]);
    return (
      <div className="relative flex items-center gap-2 py-0.5 pl-0.5">
        <StepGlyph className="bg-warning/15 text-warning">
          <IconFileCode size={11} />
        </StepGlyph>
        <span className="text-[11px] font-medium text-content">{t("ide.turns.filesNode")}</span>
        <span className="text-[10px] text-content-subtle">
          {t("ide.turns.filesCount", { n: totals.files })}
        </span>
        <span className="text-[10px] tabular-nums text-accent">+{totals.adds}</span>
        <span className="text-[10px] tabular-nums text-danger">−{totals.dels}</span>
      </div>
    );
  }

  if (block.kind === "compact-summary") {
    return (
      <div className="relative flex items-center gap-2 py-0.5 pl-0.5">
        <StepGlyph className="bg-surface-muted text-content-muted">
          <IconArrowsMinimize size={11} />
        </StepGlyph>
        <span className="text-[11px] font-medium text-content">
          {t("ide.turns.compactNode")}
        </span>
        <span className="text-[10px] tabular-nums text-content-subtle">
          {fmtTokens(block.preTokens)} → {block.postTokens != null ? fmtTokens(block.postTokens) : "—"}
        </span>
      </div>
    );
  }

  if (block.kind === "error") {
    return (
      <div className="relative flex items-start gap-2 py-0.5 pl-0.5">
        <StepGlyph className="bg-danger/15 text-danger">
          <IconAlertTriangle size={11} />
        </StepGlyph>
        <div className="min-w-0 flex-1">
          <span className="text-[11px] font-medium text-danger">{t("ide.turns.errorNode")}</span>
          <p className="line-clamp-2 break-words text-[10px] leading-snug text-content-subtle">
            {block.message}
          </p>
        </div>
      </div>
    );
  }

  // attachment / image blocks have no standalone node here — attachments are
  // counted on the user step and images render as chips on their tool node.
  return null;
}

/* ─────────────── usage bar ─────────────── */

/** Per-turn token cost: a stacked, four-segment bar (input / output / cache
 * read / cache write — same palette as the action categories) plus a legend
 * with the absolute numbers and the turn's cost / model / duration. */
function UsageBar({ record }: { record: TurnUsageRecord }) {
  const { t } = useI18n();
  const input = usageInputTokens(record);
  const parts = [
    { label: t("ide.turns.legendInput"), value: input, cls: "bg-accent" },
    { label: t("ide.turns.legendOutput"), value: record.outputTokens, cls: "bg-emerald-500" },
    { label: t("ide.turns.legendCacheRead"), value: record.cacheReadTokens, cls: "bg-violet-400" },
    {
      label: t("ide.turns.legendCacheWrite"),
      value: record.cacheCreationTokens,
      cls: "bg-amber-400",
    },
  ];
  const total = parts.reduce((s, p) => s + p.value, 0);
  return (
    <div className="mt-2 border-t border-edge/50 pt-2">
      <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-surface-muted">
        {total > 0 &&
          parts.map((p) => (
            <div
              key={p.label}
              className={p.cls}
              style={{ width: `${(p.value / total) * 100}%` }}
              title={`${p.label} ${fmtTokens(p.value)}`}
            />
          ))}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-content-subtle">
        {parts.map((p) => (
          <span key={p.label} className="flex items-center gap-1 tabular-nums">
            <span className={cn("h-1.5 w-1.5 rounded-full", p.cls)} />
            {p.label} {fmtTokens(p.value)}
          </span>
        ))}
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[10px] tabular-nums text-content-subtle">
        <span className="font-medium text-content-muted">
          {t("ide.turns.usageTotal", { n: fmtTokens(record.totalProcessedTokens) })}
        </span>
        {record.costUsd != null && record.costUsd > 0 && <span>${record.costUsd.toFixed(3)}</span>}
        <span>{fmtDuration(record.durationMs)}</span>
        {record.model && <span className="truncate">{record.model}</span>}
      </div>
    </div>
  );
}
