/**
 * Left-edge timeline of USER messages in the chat stream.
 *
 * Renders one small horizontal dash per user message, stacked vertically in
 * a fixed cluster on the left edge. The cluster does NOT move with content —
 * it stays anchored to the left edge's vertical middle.
 *
 * Virtual-list mode (default):
 *   - `scrollTop`, `userItemIndices`, and `onJumpToIndex` are provided by
 *     the parent (ChatPane) which owns the LegendList ref.
 *   - The active dash is computed from the current scroll position and item
 *     order rather than DOM offsetTop.
 *
 * Legacy DOM mode (deprecated):
 *   - `rowRefs` and `scrollRef` can be passed for non-virtualised lists.
 *
 * Feature set:
 *   - Active dash highlight (the last user message scrolled past).
 *   - Hover card with timestamp + text body.
 *   - Click to scroll to that message (via onJumpToIndex).
 */
import { useEffect, useRef, useState, useMemo } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import type { Block, ChatMessage } from "@renderer/stores/sessionStore.js";

/** Translator signature matching the `t` returned by {@link useI18n}, so
 *  module-level helpers can localize without hook access. */
type Translate = (key: MessageId, params?: Record<string, string | number>) => string;

/** Map of messageId → render-item index (from the virtual list's data array). */
export type UserItemIndexMap = Map<string, number>;

/** Format a wall-clock ms timestamp as HH:MM:SS (local time). */
function fmtClock(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Flatten a message's blocks into plain text for the tooltip body. Takes the
 *  locale-bound translator so the attachment line localizes. */
function blocksToText(blocks: Block[], t: Translate): string {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.kind === "text") {
      out.push(b.text);
    } else if (b.kind === "thinking") {
      const thinking = b.text.trim();
      if (thinking) out.push(`> ${thinking.replace(/\n/g, "\n> ")}`);
    } else if (b.kind === "attachment") {
      out.push(t("chatStream.timeline.attachmentLine", { text: b.preview }));
    }
  }
  return out.join("\n\n").trim();
}

interface MessageTimelineProps {
  messages: ChatMessage[];
  /** Current scroll offset of the virtual list's viewport. Used to compute
   *  which user message is active. Zero when no user messages exist. */
  scrollTop?: number;
  /** Map of user-message id → its index in the LegendList data array. Used
   *  to translate a dash click into a scrollToIndex call. */
  userItemIndices?: UserItemIndexMap;
  /** Called when a dash is clicked; the argument is the LegendList item index
   *  to scroll to. Provided by ChatPane. */
  onJumpToIndex?: (index: number) => void;
}

export function MessageTimeline({
  messages,
  scrollTop = 0,
  userItemIndices,
  onJumpToIndex,
}: MessageTimelineProps) {
  const userMessages = useMemo(
    () => messages.filter((m) => m.role === "user"),
    [messages],
  );

  // Compute active user-message id from scroll position + item ordering.
  // The "active" one is the LAST user message whose LegendList item index
  // is estimated to be at or above the viewport top. Since we don't have
  // exact pixel positions for each item, we approximate by walking items in
  // order and picking the last one we've "scrolled past" based on a simple
  // linear estimate.
  const activeId = useMemo<string | null>(() => {
    if (userMessages.length === 0 || !userItemIndices || userItemIndices.size === 0) {
      return null;
    }
    // Build an ordered list of (messageId, renderIndex) sorted by renderIndex.
    const indexed = userMessages
      .map((m) => ({
        id: m.id,
        idx: userItemIndices.get(m.id) ?? -1,
      }))
      .filter((x) => x.idx >= 0)
      .sort((a, b) => a.idx - b.idx);

    if (indexed.length === 0) return null;

    // With virtual lists we don't have exact pixel positions per item.
    // We use a heuristic based on scrollTop and relative item indices:
    // the active user message is the last one that is "likely" above the
    // viewport top.
    //
    // Since @legendapp/list renders items sequentially, items with lower
    // indices appear before (above) items with higher indices. We estimate
    // that roughly `scrollTop / 80` items have been scrolled past (80px is
    // our estimatedItemSize). The active one is the closest to that boundary.
    const estimatedIdx = scrollTop > 0 ? Math.floor(scrollTop / 80) : 0;

    let active: string | null = null;
    for (const x of indexed) {
      if (x.idx <= estimatedIdx + 2) active = x.id;
    }
    return active;
  }, [userMessages, scrollTop, userItemIndices]);

  if (userMessages.length === 0) return null;

  return (
    <div
      className="pointer-events-none absolute left-0 top-1/2 z-10 -translate-y-1/2"
      aria-hidden
    >
      <div className="pointer-events-auto flex max-h-[70vh] flex-col items-center justify-center gap-1.5 py-1">
        {userMessages.map((m) => {
          const idx = userItemIndices?.get(m.id) ?? -1;
          return (
            <TimelineDash
              key={m.id}
              message={m}
              active={m.id === activeId}
              onJump={() => {
                if (idx >= 0 && onJumpToIndex) onJumpToIndex(idx);
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

/** A single timeline dash with its hover-revealed detail card. */
function TimelineDash({
  message,
  active,
  onJump,
}: {
  message: ChatMessage;
  active: boolean;
  onJump: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const { t } = useI18n();
  const text = blocksToText(message.blocks, t);
  const accent = active || hovered;

  return (
    <div
      className="relative flex h-5 w-5 cursor-pointer items-center justify-center"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onJump}
    >
      <span
        className={cn(
          "block h-0.5 rounded-full transition-all",
          active ? "w-4 bg-accent" : hovered ? "w-4 bg-info" : "w-3 bg-content-subtle/60",
        )}
      />
      {hovered && (
        <div
          className={cn(
            "absolute left-full top-1/2 z-40 ml-2 w-72 -translate-y-1/2",
            "rounded-lg border border-edge bg-surface p-3 shadow-2xl",
          )}
        >
          <div className="mb-1.5 flex items-center gap-1.5 border-b border-edge pb-1.5">
            <span className={cn("h-1.5 w-1.5 rounded-full", active ? "bg-accent" : "bg-info")} />
            <span className="text-[11px] tabular-nums text-content-muted">
              {fmtClock(message.createdAt)}
            </span>
            {active && (
              <span className="ml-auto rounded bg-accent/15 px-1 text-[9px] text-accent">{t("chatStream.timeline.current")}</span>
            )}
          </div>
          <div className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-[13px] leading-relaxed text-content">
            {text || <span className="text-content-subtle">{t("chatStream.timeline.noText")}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
