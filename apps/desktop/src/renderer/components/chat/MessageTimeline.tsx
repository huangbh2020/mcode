/**
 * Left-edge timeline in the chat stream: one small dash per USER message,
 * plus a gold dash PER BOOKMARK (assistant replies included — that is where
 * the key conclusions live). Dashes are stacked vertically in a fixed
 * cluster on the left edge, ordered by the stream's render order. The
 * cluster does NOT move with content — it stays anchored to the left edge's
 * vertical middle.
 *
 * The rule is color-only: gold dash = bookmark (any message type), gray
 * dash = plain user message. Bookmark dashes are a touch thicker so they
 * hold their own next to the gray ones; several bookmarks on one message
 * sit as adjacent gold dashes.
 *
 * Virtual-list mode (default):
 *   - `userItemIndices` and `onJumpToIndex` are provided by the parent
 *     (ChatPane) which owns the LegendList ref.
 *   - The active dash is decided by the parent: ChatPane reads the virtual
 *     list's real per-item positions (getState().positionAtIndex) on scroll
 *     and passes the resulting `activeId` down. An earlier in-component
 *     estimate (scrollTop / 80px) saturated after ~two screens of scroll in
 *     tall sessions — the highlight then sat on the LAST user dash no matter
 *     where the viewport was, which read as bookmarks sitting "above the
 *     current position" right after jumping to one.
 *
 * Feature set:
 *   - Active dash highlight (the user message at/above the viewport top —
 *     computed by ChatPane from the list's real positions, passed as
 *     `activeId`).
 *   - Hover card with timestamp + text body (bookmark dashes show the
 *     bookmark's excerpt instead of the full message text).
 *   - Click to scroll to that message (via onJumpItem).
 */
import { useState, useMemo } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import { IconBookmark } from "@renderer/lib/icons.js";
import type { Block, ChatMessage } from "@renderer/stores/sessionStore.js";

/** Translator signature matching the `t` returned by {@link useI18n}, so
 *  module-level helpers can localize without hook access. */
type Translate = (key: MessageId, params?: Record<string, string | number>) => string;

/** Map of messageId → render-item index (from the virtual list's data array). */
export type UserItemIndexMap = Map<string, number>;

/** A live bookmark resolved against the current stream: the message it
 *  anchors to plus its LegendList item index and display excerpt. One entry
 *  PER BOOKMARK — several bookmarks on the same message each get their own
 *  gold dot. Stale bookmarks (message truncated away) are filtered out by
 *  the caller. */
export interface TimelineBookmarkItem {
  bookmarkId: string;
  message: ChatMessage;
  index: number;
  excerpt: string;
  /** User-defined display name (rename); null = not renamed. */
  title?: string | null;
}

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
  /** The user message currently at/above the viewport top (computed by the
   *  parent from the virtual list's real positions). Rendered as the accent
   *  "you are here" dash. Null when no user messages exist. */
  activeId?: string | null;
  /** Map of user-message id → its index in the LegendList data array. */
  userItemIndices?: UserItemIndexMap;
  /** Live bookmarks for gold dashes (user + assistant messages alike). */
  bookmarkedItems?: TimelineBookmarkItem[];
  /** Called when a dash is clicked, with the dash's message id (the exact
   *  row to center on — NOT just the item index, which is too coarse for
   *  turnGroups), its render index, and the bookmark excerpt when the dash
   *  carries one (keyword fallback for the jump). Provided by ChatPane. */
  onJumpItem?: (messageId: string, index: number, excerpt?: string) => void;
}

/** One rendered dash in the merged, index-ordered stack. */
interface DashEntry {
  key: string;
  message: ChatMessage;
  index: number;
  /** Carries a bookmark → gold, slightly thicker dash. */
  bookmarked: boolean;
  /** Bookmark excerpt for the hover card (bookmark dashes only). */
  excerpt?: string;
  /** Renamed bookmark's display title (hover card headline). */
  title?: string | null;
}

export function MessageTimeline({
  messages,
  activeId = null,
  userItemIndices,
  bookmarkedItems,
  onJumpItem,
}: MessageTimelineProps) {
  const userMessages = useMemo(
    () => messages.filter((m) => m.role === "user"),
    [messages],
  );

  // Bookmarks grouped by their anchor message — one entry PER BOOKMARK, so
  // several bookmarks on the same message each survive (the capsule counts
  // them individually and the timeline shows one dot each).
  const bookmarkGroups = useMemo(() => {
    const m = new Map<string, TimelineBookmarkItem[]>();
    for (const item of bookmarkedItems ?? []) {
      const list = m.get(item.message.id);
      if (list) list.push(item);
      else m.set(item.message.id, [item]);
    }
    return m;
  }, [bookmarkedItems]);

  // Merged dash stack: every user message (gold when bookmarked) plus one
  // gold dash PER non-user bookmark, sorted by render index so the stack
  // mirrors the stream's vertical order. Bookmarks on the same message sit
  // adjacent; each hover card shows that bookmark's own excerpt.
  const dashes = useMemo<DashEntry[]>(() => {
    const out: DashEntry[] = [];
    for (const m of userMessages) {
      const group = bookmarkGroups.get(m.id);
      out.push({
        key: m.id,
        message: m,
        index: userItemIndices?.get(m.id) ?? group?.[0]?.index ?? -1,
        bookmarked: !!group,
        // A single bookmark's excerpt is a useful hover summary; with
        // several, the full message text reads better than an arbitrary one.
        excerpt: group?.length === 1 ? group[0].excerpt : undefined,
        title: group?.length === 1 ? group[0].title : undefined,
      });
    }
    for (const items of bookmarkGroups.values()) {
      if (items[0].message.role === "user") continue; // already a dash above
      for (const item of items) {
        out.push({
          key: `bm-${item.bookmarkId}`,
          message: item.message,
          index: item.index,
          bookmarked: true,
          excerpt: item.excerpt,
          title: item.title,
        });
      }
    }
    out.sort((a, b) => a.index - b.index);
    return out;
  }, [userMessages, bookmarkGroups, userItemIndices]);

  if (dashes.length === 0) return null;

  return (
    <div
      className="pointer-events-none absolute left-0 top-1/2 z-10 -translate-y-1/2"
      aria-hidden
    >
      <div className="pointer-events-auto flex max-h-[70vh] flex-col items-center justify-center gap-1.5 py-1">
        {dashes.map((d) => (
          <TimelineDash
            key={d.key}
            message={d.message}
            active={d.message.id === activeId}
            bookmarked={d.bookmarked}
            excerpt={d.excerpt}
            title={d.title}
            onJump={() => {
              if (d.index >= 0 && onJumpItem) onJumpItem(d.message.id, d.index, d.excerpt);
            }}
          />
        ))}
      </div>
    </div>
  );
}

/** A single timeline dash with its hover-revealed detail card. */
function TimelineDash({
  message,
  active,
  bookmarked,
  excerpt,
  title,
  onJump,
}: {
  message: ChatMessage;
  active: boolean;
  /** Carries a bookmark → gold, slightly thicker dash. */
  bookmarked: boolean;
  /** Bookmark excerpt shown in the hover card instead of the full text. */
  excerpt?: string;
  /** Renamed bookmark's display title (hover card headline). */
  title?: string | null;
  onJump: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const { t } = useI18n();
  const text = excerpt ?? blocksToText(message.blocks, t);

  return (
    <div
      className="relative flex h-5 w-5 cursor-pointer items-center justify-center"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onJump}
    >
      {bookmarked ? (
        // Bookmark: gold, a touch thicker than the gray user dashes so the
        // color-only rule ("gold = bookmark") also reads by weight.
        <span
          className={cn(
            "block h-[3px] rounded-full bg-warning transition-all",
            hovered ? "w-4" : "w-3.5",
          )}
        />
      ) : (
        <span
          className={cn(
            "block h-0.5 rounded-full transition-all",
            active ? "w-4 bg-accent" : hovered ? "w-4 bg-info" : "w-3 bg-content-subtle/60",
          )}
        />
      )}
      {hovered && (
        <div
          className={cn(
            "absolute left-full top-1/2 z-40 ml-2 w-72 -translate-y-1/2",
            "rounded-lg border border-edge bg-surface p-3 shadow-2xl",
          )}
        >
          <div className="mb-1.5 flex items-center gap-1.5 border-b border-edge pb-1.5">
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                bookmarked ? "bg-warning" : active ? "bg-accent" : "bg-info",
              )}
            />
            <span className="text-[11px] tabular-nums text-content-muted">
              {fmtClock(message.createdAt)}
            </span>
            {active && !bookmarked && (
              <span className="ml-auto rounded bg-accent/15 px-1 text-[9px] text-accent">{t("chatStream.timeline.current")}</span>
            )}
          </div>
          {title && (
            <div className="mb-1 flex items-center gap-1">
              <IconBookmark size={10} className="shrink-0 text-warning" />
              <span className="truncate text-[11px] font-medium text-warning">{title}</span>
            </div>
          )}
          <div className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-[13px] leading-relaxed text-content">
            {text || <span className="text-content-subtle">{t("chatStream.timeline.noText")}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
