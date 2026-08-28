/**
 * Floating mini toolbar shown when the user selects text inside a chat
 * message: [copy] [add bookmark]. Copy stays first-class here — selecting
 * text in a chat is usually about copying, so the bookmark affordance rides
 * along instead of replacing it.
 *
 * Anchored above the selection rect with `position: fixed` + a portal to
 * document.body — the chat list is a LegendList whose items carry
 * `contain: paint`, which would clip an in-place absolutely-positioned
 * toolbar (the same reason TagPopover portals from MessageBlocks).
 *
 * Closing: outside mousedown / ESC / selection collapse (selectionchange) /
 * any scroll. The rect is a mouseup snapshot, so once anything scrolls the
 * anchor is stale — closing is simpler and calmer than tracking it live.
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { IconBookmark, IconCheck, IconCopy, IconMessages } from "@renderer/lib/icons.js";

/** What the owning ChatPane captured at mouseup: a viewport-space snapshot of
 *  the selection plus the message it belongs to (resolved from
 *  `[data-message-id]` on the selection's anchor node). Plain numbers, not a
 *  live DOMRect — the DOM moves on, the toolbar only needs the snapshot. */
export interface SelectionToolbarState {
  rect: { top: number; bottom: number; left: number; right: number };
  text: string;
  messageId: string;
  role: "user" | "assistant";
}

export function SelectionToolbar({
  state,
  onAddBookmark,
  onAskSideChat,
  onClose,
}: {
  state: SelectionToolbarState;
  /** Called with the captured state; the owner persists the bookmark, clears
   *  the selection and closes the toolbar (which the selectionchange close
   *  would do anyway once the selection is gone). */
  onAddBookmark: (s: SelectionToolbarState) => void;
  /** Send the selection to the side chat (opens the ask tab and seeds its
   *  composer with the text). */
  onAskSideChat: (s: SelectionToolbarState) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const barRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onSelectionChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.toString().trim().length === 0) onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    document.addEventListener("selectionchange", onSelectionChange);
    // Capture phase: the chat scrolls inside the LegendList container, which
    // doesn't bubble a scroll event to document.
    document.addEventListener("scroll", onClose, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("scroll", onClose, true);
    };
  }, [onClose]);

  // Reset the copy check feedback after a moment so it doesn't linger.
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(timer);
  }, [copied]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(state.text);
      setCopied(true);
    } catch {
      // Clipboard denied (permissions / non-secure context) — leave idle.
    }
  };

  const centerX = (state.rect.left + state.rect.right) / 2;
  const clampedX = Math.min(Math.max(centerX, 64), window.innerWidth - 64);
  const above = state.rect.top > 44;
  const style: React.CSSProperties = {
    position: "fixed",
    left: clampedX,
    transform: "translateX(-50%)",
    ...(above
      ? { top: Math.max(state.rect.top - 36, 6) }
      : { top: state.rect.bottom + 8 }),
  };

  return createPortal(
    <div
      ref={barRef}
      style={style}
      // preventDefault on mousedown keeps the text selected while the user
      // reaches for a button — without it the click collapses the selection
      // and the selectionchange close above fires before the click lands.
      onMouseDown={(e) => e.preventDefault()}
      className="animate-[bookmark-bar-in_120ms_ease-out] z-50 flex items-center gap-0.5 rounded-lg border border-edge bg-surface px-1 py-0.5 shadow-xl"
    >
      <button
        type="button"
        onClick={() => void handleCopy()}
        title={copied ? t("chatStream.bookmark.copied") : undefined}
        className={cn(
          "flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] transition-colors",
          "text-content-subtle hover:bg-surface-hover hover:text-content-muted",
          copied && "text-accent",
        )}
      >
        {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
      </button>
      <span className="h-3 w-px bg-edge/60" />
      <button
        type="button"
        onClick={() => onAddBookmark(state)}
        title={t("chatStream.bookmark.add")}
        className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] text-content-subtle transition-colors hover:bg-surface-hover hover:text-warning"
      >
        <IconBookmark size={12} />
      </button>
      <span className="h-3 w-px bg-edge/60" />
      <button
        type="button"
        onClick={() => onAskSideChat(state)}
        title={t("chatStream.bookmark.askSideChat")}
        className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] text-content-subtle transition-colors hover:bg-surface-hover hover:text-accent"
      >
        <IconMessages size={12} />
      </button>
    </div>,
    document.body,
  );
}
