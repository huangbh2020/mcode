import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  IconArrowsSplit,
  IconBrain,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconClipboard,
  IconFileCode,
  IconGitFork,
  IconGitMerge,
  IconListDetails,
  IconLoader2,
  IconMessage,
  IconPaperclip,
  IconPhoto,
  IconUser,
  IconX,
} from "@renderer/lib/icons.js";
import {
  buildFlowRows,
  buildTurnGroups,
  cacheHitRate,
  countActions,
  findSubagentSnapshot,
  fmtClockTime,
  fmtDuration,
  imageCountsByToolCall,
  matchUsageRecords,
  stepAccent,
  SUBAGENT_TOOLS,
  toolCategory,
  TOOL_BADGE_CLS,
  turnFilesTotals,
  usageInputTokens,
  userMessagePreview,
  type FlowRow,
  type FlowStep,
  type StepAccent,
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
 * A session MAP, not a replay: the chat stream is the reading surface, this
 * panel shows the structure the linear chat cannot — the per-turn timeline
 * with parallel tool batches bracketed (same-message tool_use calls execute
 * concurrently), subagent delegations as indented fork/join lanes running
 * beside the main spine, and per-turn token / wall-time cost. Every step is
 * click-to-jump: it locates its carrying message in the chat stream (via the
 * bookmark-jump channel ChatPane already consumes), so the map doubles as a
 * navigation index into the conversation.
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
  const displayMode = useSessionStore((s) => s.displayMode);
  const setPendingBookmarkJump = useSessionStore((s) => s.setPendingBookmarkJump);
  const setCenterTabFocus = useSessionStore((s) => s.setCenterTabFocus);
  const openSubagentTranscript = useSessionStore((s) => s.openSubagentTranscript);

  /* Step click → locate the carrying message in the chat stream. Rides the
   * existing bookmark-jump channel (ChatPane consumes it: virtual-list
   * aiming with retries + center + flash). In tabs mode an editor-focused
   * center pane must flip back to chat first — otherwise the target pane
   * stays display:none and its list never measures. */
  const jumpToChat = useCallback(
    (messageId: string) => {
      if (!sessionId) return;
      setPendingBookmarkJump({ sessionId, messageId });
      if (displayMode === "tabs") setCenterTabFocus("chat");
    },
    [sessionId, displayMode, setPendingBookmarkJump, setCenterTabFocus],
  );
  const openSubagent = useCallback(
    (taskId: string) => {
      if (sessionId) openSubagentTranscript(sessionId, taskId);
    },
    [sessionId, openSubagentTranscript],
  );

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
          acc.cacheRead += r.cacheReadTokens;
          acc.inputSide += r.totalProcessedTokens - r.outputTokens;
          return acc;
        },
        { tokens: 0, cacheRead: 0, inputSide: 0 },
      ),
    [usageHistory],
  );
  const cacheHitPct =
    totals.inputSide > 0 ? ((totals.cacheRead / totals.inputSide) * 100).toFixed(1) : null;

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
      {/* Summary header: turn count + session-wide token totals. */}
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-edge bg-surface px-3 py-2">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold text-content">
          <IconListDetails size={12} className="opacity-80" />
          {t("ide.turns.title")}
        </span>
        <span className="ml-auto flex items-center gap-1.5 text-[10px] tabular-nums text-content-subtle">
          <span>{t("ide.turns.summaryTurns", { n: groups.length })}</span>
          {totals.tokens > 0 && <span>· {fmtTokens(totals.tokens)} tokens</span>}
          {cacheHitPct != null && (
            <span>· {t("ide.turns.cacheHit", { n: cacheHitPct })}</span>
          )}
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
            onJump={jumpToChat}
            onOpenSubagent={openSubagent}
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
  onJump,
  onOpenSubagent,
}: {
  group: TurnGroup;
  usage?: TurnUsageRecord;
  subagents: SubagentSnapshot[];
  waitingModel: boolean;
  expanded: boolean;
  onToggle: () => void;
  onJump: (messageId: string) => void;
  onOpenSubagent: (taskId: string) => void;
}) {
  const { t } = useI18n();
  const allBlocks = useMemo(
    () => group.assistantMessages.flatMap((m) => m.blocks),
    [group.assistantMessages],
  );
  const counts = useMemo(() => countActions(allBlocks), [allBlocks]);
  const imageCounts = useMemo(() => imageCountsByToolCall(allBlocks), [allBlocks]);
  const rows = useMemo(() => buildFlowRows(group.assistantMessages), [group.assistantMessages]);
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
              {group.userMessage && <UserStep message={group.userMessage} onJump={onJump} />}
              {waitingModel && <WaitingStep />}
              {rows.map((row) =>
                row.parallel ? (
                  <ParallelBatchRow
                    key={row.key}
                    row={row}
                    subagents={subagents}
                    imageCounts={imageCounts}
                    onJump={onJump}
                    onOpenSubagent={onOpenSubagent}
                  />
                ) : (
                  <BlockStep
                    key={row.key}
                    step={row.steps[0]}
                    subagents={subagents}
                    imageCounts={imageCounts}
                    onJump={onJump}
                    onOpenSubagent={onOpenSubagent}
                  />
                ),
              )}
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

/** The user-prompt node: what the model received this turn. Clicking jumps
 * to the message in the chat stream. */
function UserStep({ message, onJump }: { message: ChatMessage; onJump: (messageId: string) => void }) {
  const { t } = useI18n();
  const { text, attachments } = userMessagePreview(message);
  return (
    <div
      onClick={() => onJump(message.id)}
      title={t("ide.turns.jumpToChat")}
      className="relative flex cursor-pointer items-start gap-2 rounded-md py-1 pl-0.5 pr-1.5 transition-colors hover:bg-surface-hover"
    >
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
 *  the category-tinted badge + ToolIcon mapping shared with the chat stream,
 *  so every tool reads with the same glyph it has in the conversation.
 *
 *  Every row is click-to-jump: it locates the message carrying the block in
 *  the chat stream. Error rows and human-gate rows (questions, plan
 *  submissions) carry a left accent bar so they stand out while scanning.
 *  Task delegations grow a fork/join lane below the node (SubagentLane). */
function BlockStep({
  step,
  subagents,
  imageCounts,
  onJump,
  onOpenSubagent,
}: {
  step: FlowStep;
  subagents: SubagentSnapshot[];
  imageCounts: Map<string, number>;
  onJump: (messageId: string) => void;
  onOpenSubagent: (taskId: string) => void;
}) {
  const { t } = useI18n();
  const block = step.block;
  const imageCount =
    block.kind === "tool_use" ? (imageCounts.get(block.toolCallId) ?? 0) : 0;
  const accent = stepAccent(block);
  const lane =
    block.kind === "tool_use" && SUBAGENT_TOOLS.has(block.toolName) ? (
      <SubagentLane
        block={block}
        snapshot={findSubagentSnapshot(subagents, block)}
        onOpenSubagent={onOpenSubagent}
      />
    ) : null;
  const jumpTitle = t("ide.turns.jumpToChat");
  const jump = () => onJump(step.messageId);

  if (block.kind === "text") {
    if (!block.text.trim()) return null;
    return (
      <StepRow accent={accent} title={jumpTitle} onClick={jump} lane={lane}>
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
      </StepRow>
    );
  }

  if (block.kind === "thinking") {
    if (!block.text.trim()) return null;
    return (
      <StepRow accent={accent} title={jumpTitle} onClick={jump} lane={lane}>
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
      </StepRow>
    );
  }

  if (block.kind === "tool_use") {
    const cat = toolCategory(block.toolName);
    const summary = toolSummary(block.toolName, block.input);
    return (
      <StepRow accent={accent} title={jumpTitle} onClick={jump} lane={lane}>
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
          {summary && !lane && (
            <p className="truncate text-[10px] leading-snug text-content-subtle" title={summary}>
              {summary}
            </p>
          )}
        </div>
      </StepRow>
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
      <StepRow accent={accent} title={jumpTitle} onClick={jump} lane={lane}>
        <StepGlyph className="bg-indigo-400/15 text-indigo-400">
          <IconClipboard size={11} />
        </StepGlyph>
        <span className="text-[11px] font-medium text-content">{t("ide.turns.planNode")}</span>
        <span className="rounded-full bg-indigo-400/15 px-1.5 py-0.5 text-[10px] text-indigo-400">
          {t(phaseKey)}
        </span>
      </StepRow>
    );
  }

  if (block.kind === "turn-files") {
    const totals = turnFilesTotals([block]);
    return (
      <StepRow accent={accent} title={jumpTitle} onClick={jump} lane={lane}>
        <StepGlyph className="bg-warning/15 text-warning">
          <IconFileCode size={11} />
        </StepGlyph>
        <span className="text-[11px] font-medium text-content">{t("ide.turns.filesNode")}</span>
        <span className="text-[10px] text-content-subtle">
          {t("ide.turns.filesCount", { n: totals.files })}
        </span>
        <span className="text-[10px] tabular-nums text-accent">+{totals.adds}</span>
        <span className="text-[10px] tabular-nums text-danger">−{totals.dels}</span>
      </StepRow>
    );
  }

  if (block.kind === "compact-summary") {
    return (
      <StepRow accent={accent} title={jumpTitle} onClick={jump} lane={lane}>
        <StepGlyph className="bg-surface-muted text-content-muted">
          <IconArrowsMinimize size={11} />
        </StepGlyph>
        <span className="text-[11px] font-medium text-content">
          {t("ide.turns.compactNode")}
        </span>
        <span className="text-[10px] tabular-nums text-content-subtle">
          {fmtTokens(block.preTokens)} → {block.postTokens != null ? fmtTokens(block.postTokens) : "—"}
        </span>
      </StepRow>
    );
  }

  if (block.kind === "error") {
    return (
      <StepRow accent={accent} title={jumpTitle} onClick={jump} lane={lane}>
        <StepGlyph className="bg-danger/15 text-danger">
          <IconAlertTriangle size={11} />
        </StepGlyph>
        <div className="min-w-0 flex-1">
          <span className="text-[11px] font-medium text-danger">{t("ide.turns.errorNode")}</span>
          <p className="line-clamp-2 break-words text-[10px] leading-snug text-content-subtle">
            {block.message}
          </p>
        </div>
      </StepRow>
    );
  }

  // attachment / image blocks have no standalone node here — attachments are
  // counted on the user step and images render as chips on their tool node.
  return null;
}

/** Click shell shared by every step row: jump-to-chat on click, hover state,
 *  and the left accent bar + soft tint for error / human-gate steps. The
 *  optional lane (Task delegations) hangs below the shell inside the same
 *  relative wrapper, so parallel-batch nesting keeps working. */
function StepRow({
  accent,
  title,
  onClick,
  lane,
  children,
}: {
  accent: StepAccent;
  title: string;
  onClick: () => void;
  lane?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="relative">
      <div
        onClick={onClick}
        title={title}
        className={cn(
          "relative flex cursor-pointer items-start gap-2 rounded-md py-1 pl-0.5 pr-1.5 transition-colors hover:bg-surface-hover",
          accent === "danger" && "bg-danger/5 hover:bg-danger/10",
          accent === "attention" && "bg-amber-400/5 hover:bg-amber-400/10",
        )}
      >
        {accent && (
          <span
            className={cn(
              "absolute bottom-1 left-0 top-1 w-[2px] rounded-full",
              accent === "danger" ? "bg-danger" : "bg-amber-400",
            )}
          />
        )}
        {children}
      </div>
      {lane}
    </div>
  );
}

/** Indented lane under a Task node — the delegation's own life beside the
 *  main spine. The dashed rail reads as a parallel branch: forked at the
 *  spawn node, running its own steps (last tool + live usage), joining back
 *  with an end time once done. Chat's linear stream cannot express this
 *  overlap; here it is the point of the view.
 *
 *  Live snapshots come from the subagent roster; rehydrated historical turns
 *  have no roster, so the lane degrades to status derived from the tool_use
 *  block plus the Task input's description. Header click opens the
 *  subagent's transcript in the side chat (live snapshots only). */
function SubagentLane({
  block,
  snapshot,
  onOpenSubagent,
}: {
  block: Extract<Block, { kind: "tool_use" }>;
  snapshot?: SubagentSnapshot;
  onOpenSubagent: (taskId: string) => void;
}) {
  const { t } = useI18n();
  const status: SubagentSnapshot["status"] =
    snapshot?.status ??
    (block.status === "error" ? "failed" : block.status === "running" ? "running" : "completed");
  const meta = SUBAGENT_STATUS_META[status];
  const inputDesc =
    block.input && typeof block.input === "object" && "description" in block.input
      ? (block.input as { description?: unknown }).description
      : undefined;
  const description = snapshot?.description ?? (typeof inputDesc === "string" ? inputDesc : "");
  const joinCls =
    status === "completed"
      ? "text-accent"
      : status === "running"
        ? "text-warning"
        : "text-danger";

  return (
    <div className="relative my-0.5 ml-[18px] rounded-r-md border-l border-dashed border-edge pl-2 pr-1">
      <div
        onClick={snapshot ? () => onOpenSubagent(snapshot.taskId) : undefined}
        title={snapshot ? t("ide.turns.openTranscript") : undefined}
        className={cn(
          "flex items-center gap-1.5 rounded-md px-1 py-0.5",
          snapshot && "cursor-pointer transition-colors hover:bg-surface-hover",
        )}
      >
        <IconGitFork size={10} className="shrink-0 text-content-subtle" />
        {description && (
          <span className="truncate text-[10px] font-medium text-content-muted" title={description}>
            {description}
          </span>
        )}
        {snapshot?.subagentType && (
          <span className="shrink-0 rounded-full bg-fuchsia-400/15 px-1.5 py-0.5 text-[9px] text-fuchsia-400">
            {snapshot.subagentType}
          </span>
        )}
        {snapshot?.isBackgrounded && (
          <span className="shrink-0 rounded-full bg-surface-muted px-1.5 py-0.5 text-[9px] text-content-subtle">
            {t("ide.turns.backgroundTag")}
          </span>
        )}
        <span
          className={cn(
            "ml-auto flex shrink-0 items-center gap-0.5 text-[10px] font-medium",
            meta.cls,
          )}
        >
          {meta.spin && <IconLoader2 size={9} className="animate-spin" />}
          {t(meta.labelKey)}
        </span>
      </div>
      {snapshot?.lastToolName && (
        <div className="truncate px-1 text-[10px] leading-snug text-content-subtle">
          {t("ide.turns.subagentLast", { tool: snapshot.lastToolName })}
        </div>
      )}
      {snapshot?.summary && (
        <div
          className="truncate px-1 text-[10px] leading-snug text-content-subtle"
          title={snapshot.summary}
        >
          {snapshot.summary}
        </div>
      )}
      {(snapshot?.totalTokens != null || snapshot?.toolUses != null || snapshot?.durationMs != null) && (
        <div className="px-1 text-[10px] tabular-nums leading-snug text-content-subtle">
          {t("ide.turns.subagentDetail", {
            tokens: snapshot?.totalTokens != null ? fmtTokens(snapshot.totalTokens) : "—",
            tools: snapshot?.toolUses ?? "—",
            dur: snapshot?.durationMs != null ? fmtDuration(snapshot.durationMs) : "—",
          })}
        </div>
      )}
      {status !== "running" && (
        <div className={cn("flex items-center gap-1 px-1 py-0.5 text-[9px]", joinCls)}>
          <IconGitMerge size={9} className="shrink-0" />
          {snapshot?.endedAt != null
            ? t("ide.turns.joinAt", { time: fmtClockTime(snapshot.endedAt) })
            : t("ide.turns.joinLabel")}
        </div>
      )}
    </div>
  );
}

/** Bracketed cluster of the tool calls that arrived in ONE assistant
 *  message — the SDK executes them concurrently, so they render as a group
 *  hanging off the main spine rather than as fake-sequential rows. The
 *  label pill straddles the top border like a code bracket. */
function ParallelBatchRow({
  row,
  subagents,
  imageCounts,
  onJump,
  onOpenSubagent,
}: {
  row: FlowRow;
  subagents: SubagentSnapshot[];
  imageCounts: Map<string, number>;
  onJump: (messageId: string) => void;
  onOpenSubagent: (taskId: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="relative my-1 ml-3 rounded-md border border-edge/70 bg-surface-muted/40 pb-0.5 pl-1 pr-1 pt-2">
      <span className="absolute -top-[7px] left-2 z-10 flex items-center gap-0.5 rounded-full border border-edge bg-surface px-1 text-[9px] font-medium text-content-subtle">
        <IconArrowsSplit size={9} />
        {t("ide.turns.parallelBatch", { n: row.steps.length })}
      </span>
      <div className="space-y-0.5">
        {row.steps.map((s) => (
          <BlockStep
            key={s.key}
            step={s}
            subagents={subagents}
            imageCounts={imageCounts}
            onJump={onJump}
            onOpenSubagent={onOpenSubagent}
          />
        ))}
      </div>
    </div>
  );
}

/* ─────────────── usage bar ─────────────── */

/** Per-turn token cost: a stacked, three-segment bar (input / output / cache
 * read — same palette as the action categories) plus a legend with the
 * absolute numbers and the turn's cache hit rate / duration / model. */
function UsageBar({ record }: { record: TurnUsageRecord }) {
  const { t } = useI18n();
  const input = usageInputTokens(record);
  const hit = cacheHitRate(record);
  const parts = [
    { label: t("ide.turns.legendInput"), value: input, cls: "bg-accent" },
    { label: t("ide.turns.legendOutput"), value: record.outputTokens, cls: "bg-emerald-500" },
    { label: t("ide.turns.legendCacheRead"), value: record.cacheReadTokens, cls: "bg-violet-400" },
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
        {hit != null && <span>{t("ide.turns.cacheHit", { n: (hit * 100).toFixed(1) })}</span>}
        <span>{fmtDuration(record.durationMs)}</span>
        {record.model && <span className="truncate">{record.model}</span>}
      </div>
    </div>
  );
}
