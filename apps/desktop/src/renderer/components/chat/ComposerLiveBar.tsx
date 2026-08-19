import { useEffect, useMemo, useState } from "react";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import { cn } from "@renderer/lib/cn.js";
import { IconArrowDown } from "@renderer/lib/icons.js";
import {
  EMPTY_MESSAGES,
  EMPTY_SUBAGENTS,
  useSessionStore,
  type ChatMessage,
} from "@renderer/stores/sessionStore.js";
import { CurrentOpTicker } from "./CurrentOpTicker.js";
import type { ToolUseBlock } from "./MessageBlocks.js";

/**
 * Live-activity strip along the top edge of the composer card.
 *
 * The composer is docked at the bottom OUTSIDE the scroll container, so it is
 * the one surface that stays visible while the user scrolls back through
 * history — while a turn runs, this strip turns it into mission control:
 *
 *   ▮▯▮ 01:23  Bash · npm test   ◈ 2 个代理运行中   ↓ 3 条新动态
 *
 *  - equalizer bars (tempo: slow while waiting for the model, brisk while a
 *    tool executes) + a ticking elapsed timer;
 *  - the current operation via the shared `CurrentOpTicker` slot machine, or
 *    a phase label ("等待模型响应…" / "思考中…" / "正在撰写回复…") when no
 *    tool is running;
 *  - a running-subagent chip;
 *  - a jump-to-latest badge showing how many new updates landed while the
 *    user is scrolled away (the ChatPane suppresses its own floating pill in
 *    favor of this one).
 *
 * Data is derived entirely from existing store state — no new events, no new
 * state. The strip collapses via the grid-rows 0fr/1fr trick when idle.
 */

/** Cosmetic phase for the label + equalizer tempo. `null` = turn finished but
 *  background subagents still running (chip-only display). */
type LivePhase = "waitingModel" | "tool" | "thinking" | "streaming";

/** Static map so the phase→key lookup stays fully typed (template-literal
 *  message ids would not typecheck against the zh-derived MessageId). */
const PHASE_LABEL_KEY: Record<Exclude<LivePhase, "tool">, MessageId> = {
  waitingModel: "chat.live.waitingModel",
  thinking: "chat.live.thinking",
  streaming: "chat.live.streaming",
};

/** mm:ss, or h:mm:ss once the hour rolls over. Tabular digits keep the timer
 *  from jittering the strip as it ticks. */
function fmtElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** Ticking "now" while `active` (same pattern as TurnFlowPanel's): no
 *  subscription cost when the session is idle. */
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

/** Trailing assistant messages of the still-open turn (turnMeta.endedAt
 *  undefined), in order. Empty array = nothing streamed yet (waiting for the
 *  model) or the turn already closed. Walks from the end and stops at the
 *  first message that isn't part of the open turn. */
function collectOpenTurn(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && m.turnMeta && m.turnMeta.endedAt === undefined) {
      out.unshift(m);
    } else {
      break;
    }
  }
  return out;
}

export function ComposerLiveBar({
  sessionId,
  scrolledAway,
  newCount,
  onJumpToLatest,
}: {
  sessionId: string;
  /** Whether the message list is currently scrolled away from the bottom. */
  scrolledAway: boolean;
  /** Render items produced since the user left the bottom (0 = just left). */
  newCount: number;
  onJumpToLatest: () => void;
}) {
  const { t } = useI18n();
  const isRunning = useSessionStore((s) => !!s.runningBySession[sessionId]);
  const messages = useSessionStore(
    (s) => s.messagesBySession[sessionId] ?? EMPTY_MESSAGES,
  );
  const subagents = useSessionStore(
    (s) => s.subagentsBySession[sessionId] ?? EMPTY_SUBAGENTS,
  );
  const runningTurnStartedAt = useSessionStore(
    (s) => s.runningTurnStartedAt[sessionId],
  );

  const runningSubagentCount = useMemo(
    () => subagents.filter((a) => a.status === "running").length,
    [subagents],
  );
  const active = isRunning || runningSubagentCount > 0;

  const openTurn = useMemo(() => collectOpenTurn(messages), [messages]);

  // Newest tool currently executing in the open turn — reverse scan mirrors
  // TurnPanel's runningTool derivation.
  const runningTool = useMemo<ToolUseBlock | null>(() => {
    for (let i = openTurn.length - 1; i >= 0; i--) {
      const blocks = openTurn[i].blocks;
      for (let j = blocks.length - 1; j >= 0; j--) {
        const b = blocks[j];
        if (b.kind === "tool_use" && b.status === "running") return b;
      }
    }
    return null;
  }, [openTurn]);

  const phase = useMemo<LivePhase | null>(() => {
    if (!isRunning) return null;
    if (openTurn.length === 0) return "waitingModel";
    if (runningTool) return "tool";
    const lastBlocks = openTurn[openTurn.length - 1].blocks;
    if (lastBlocks[lastBlocks.length - 1]?.kind === "thinking") return "thinking";
    return "streaming";
  }, [isRunning, openTurn, runningTool]);

  const now = useNowWhile(active);
  // Prefer the send-time anchor (stamped the instant the prompt goes out);
  // fall back to the open turn's own startedAt (e.g. after a store rehydrate).
  const startedAt = runningTurnStartedAt ?? openTurn[0]?.turnMeta?.startedAt;
  const elapsed = typeof startedAt === "number" ? now - startedAt : null;

  return (
    // Collapse container: same grid-rows 0fr→1fr trick as TurnPanel, so the
    // strip slides open when the turn starts and folds away when it ends.
    <div
      className={cn(
        "grid transition-[grid-template-rows] duration-200 ease-out",
        active ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
      )}
    >
      <div className="overflow-hidden">
        <div
          className={cn(
            "flex h-7 items-center gap-2 border-b border-edge px-2.5",
            "[font-size:var(--chat-fs-sm)]",
          )}
        >
          {/* Equalizer — accent, tempo keyed to the phase. */}
          <span
            className="live-eq shrink-0"
            data-tempo={phase === null || phase === "waitingModel" ? "slow" : undefined}
            aria-hidden
          >
            <span />
            <span />
            <span />
          </span>
          {elapsed !== null && (
            <span className="shrink-0 font-medium tabular-nums text-content-muted">
              {fmtElapsed(elapsed)}
            </span>
          )}
          {/* Phase label and/or current-op ticker. The ticker self-clears when
              the turn ends; between two tools it keeps the last op dimmed,
              which reads nicely next to the "正在撰写回复…" label. */}
          <span className="flex min-w-0 flex-1 items-center">
            {phase !== null && phase !== "tool" && (
              <span className="truncate text-content-muted">
                {t(PHASE_LABEL_KEY[phase])}
              </span>
            )}
            {isRunning && <CurrentOpTicker op={runningTool} turnActive={isRunning} />}
          </span>
          {runningSubagentCount > 0 && (
            <span className="flex shrink-0 items-center gap-1 text-content-muted">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-warning" />
              {t("chat.live.subagentsRunning", { n: runningSubagentCount })}
            </span>
          )}
          {/* Jump badge — takes over from the suppressed floating pill while
              the session is busy. Solid accent once updates landed, quiet
              otherwise. */}
          {scrolledAway && (
            <button
              type="button"
              onClick={onJumpToLatest}
              title={t("chat.live.jumpLatest")}
              className={cn(
                "flex shrink-0 animate-[live-badge-in_220ms_ease-out] items-center gap-1",
                "rounded-full px-2 py-0.5 font-medium transition-all",
                newCount > 0
                  ? "bg-accent text-surface hover:brightness-95 dark:hover:brightness-110"
                  : "text-content-muted hover:bg-surface-hover hover:text-content",
              )}
            >
              <IconArrowDown size={11} />
              {newCount > 0 ? t("chat.live.newActivity", { n: newCount }) : t("chat.live.jumpLatest")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
