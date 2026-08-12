import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { api } from "@renderer/lib/api.js";
import {
  IconCopy,
  IconCheck,
  IconX,
  IconArrowsMaximize,
  IconLoader2,
  IconPhotoOff,
} from "@renderer/lib/icons.js";
import { isImageFile, type ContentTag } from "@renderer/lib/contentTag.js";

/**
 * Floating preview for a single content-tag chip. Shows the full pasted
 * content in a scrollable box with a Copy button.
 *
 * Anchored to the chip that opened it: positioned at the chip's TOP-RIGHT,
 * rising above the chip when there's room, or dropping below it when the
 * chip sits too close to the top of the viewport. Right-aligned to the
 * chip's right edge so the popover reads as growing out of the chip.
 *
 * Dismiss:
 *   - Click outside (mousedown on document)
 *   - ESC key
 *   - Clicking the chip body again (handled by parent — sets openTagId=null)
 *
 * The Copy button uses `navigator.clipboard.writeText` and shows a brief
 * "已复制" state on success. Falls back to selecting the text if the
 * clipboard API is unavailable (rare in Electron, but defensive).
 */
export function TagPopover({
  tag,
  anchorRect,
  onClose,
  onExpand,
}: {
  tag: ContentTag;
  /** Bounding box of the chip that opened this popover, in viewport
   *  coordinates (getBoundingClientRect). Drives the fixed positioning. */
  anchorRect: DOMRect;
  onClose: () => void;
  /** Expand the tag's content back into the composer as inline text, removing
   *  the chip. Only provided for paste tags — file/element tags are path
   *  references whose "content" is an @path string, not user text. */
  onExpand?: () => void;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  // Whether the popover has room to sit ABOVE the chip; falls back to below.
  // Computed after first measure so we can read the popover's own height.
  const [placeAbove, setPlaceAbove] = useState(true);

  // Image preview state (file tags whose path is a previewable image). null =
  // loading, "" = error/unreadable, non-empty = valid data URL.
  const isImage = isImageFile(tag);
  const [natural, setNatural] = useState(false);
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  // Lazily load the image bytes as a data URL when the popover opens for an
  // image tag. Reuses the same IPC the IDE's image preview uses
  // (api.file.readBinary), which allows both project files and paste-temp
  // paths (the latter is explicitly whitelisted in main's readBinary handler).
  useEffect(() => {
    if (!isImage || !tag.filePath) return;
    let cancelled = false;
    setDataUrl(null);
    setNatural(false);
    api.file
      .readBinary({ filePath: tag.filePath })
      .then(({ dataUrl: url }) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setDataUrl("");
      });
    return () => {
      cancelled = true;
    };
  }, [isImage, tag.filePath]);

  // Measure once mounted and decide above/below. Also re-check on resize so
  // a window shrink doesn't leave the popover overflowing the top edge. For
  // image tags, re-measure when the data URL arrives so placement accounts
  // for the real image height (not the small loading spinner).
  useLayoutEffect(() => {
    const recompute = () => {
      const el = popoverRef.current;
      if (!el) return;
      const h = el.offsetHeight;
      // 8px gap between popover and chip.
      setPlaceAbove(anchorRect.top - 8 - h >= 0);
    };
    recompute();
    window.addEventListener("resize", recompute);
    return () => window.removeEventListener("resize", recompute);
  }, [anchorRect.top, dataUrl]);

  // Outside-click + ESC close. Mirrors ModelDropdown's pattern.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      // The chip that opened us is OUTSIDE the popover; allow clicks on
      // chips to fall through to the parent's toggle handler instead of
      // swallowing them. We treat anything not inside the popover as
      // "outside" and close — the chip's own onClick will reopen.
      if (popoverRef.current && !popoverRef.current.contains(t)) {
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // Reset the "copied" pill after a moment so it doesn't linger.
  useEffect(() => {
    if (copyState === "idle") return;
    const t = setTimeout(() => setCopyState("idle"), 1200);
    return () => clearTimeout(t);
  }, [copyState]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(tag.content);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  // Fixed positioning relative to the viewport. Right-align to the chip's
  // right edge; clamp the left so a wide popover never overflows the left
  // edge of the viewport. Vertically: sit just above (or below) the chip
  // with an 8px gap.
  const right = window.innerWidth - anchorRect.right;
  const minLeft = 8;
  const style: React.CSSProperties = {
    position: "fixed",
    right: Math.max(right, minLeft - 0) + 0,
    // When right-clamped (popover wider than available space on the right),
    // switch to a left anchor so it stays on screen.
    ...(right < minLeft ? { left: minLeft, right: "auto" as const } : {}),
    ...(placeAbove
      ? { bottom: window.innerHeight - anchorRect.top + 8 }
      : { top: anchorRect.bottom + 8 }),
  };

  // Image tags: pop up the bare image with no frame — no header bar, border,
  // or backdrop. Just the floating image anchored near the chip, plus a small
  // unobtrusive status pill while loading / on error. Closes on outside-click
  // / ESC (handled above); click the image to toggle zoom-to-fit / enlarged.
  if (isImage) {
    return (
      <div ref={popoverRef} style={style} className="z-30">
        {dataUrl === null ? (
          <div className="flex items-center gap-1.5 rounded-md bg-surface/95 px-2.5 py-1.5 text-[11px] text-content-subtle shadow-lg">
            <IconLoader2 size={12} className="animate-spin" /> 读取图片…
          </div>
        ) : !dataUrl ? (
          <div className="flex flex-col items-center gap-1.5 rounded-md bg-surface/95 px-4 py-3 text-center text-content-subtle shadow-lg">
            <IconPhotoOff size={24} className="opacity-70" />
            <p className="text-[11px]">图片加载失败</p>
          </div>
        ) : (
          <img
            src={dataUrl}
            alt={tag.preview}
            onClick={() => setNatural((n) => !n)}
            title={natural ? "点击缩小" : "点击放大"}
            className={cn(
              "rounded-md shadow-2xl",
              natural ? "cursor-zoom-out" : "cursor-zoom-in",
            )}
            style={
              natural
                ? { maxWidth: "calc(100vw - 16px)", maxHeight: "90vh" }
                : { maxWidth: "min(32rem, calc(100vw - 16px))", maxHeight: "70vh" }
            }
          />
        )}
      </div>
    );
  }

  // Paste / element tags: framed popover with header (char count + copy/close).
  return (
    <div
      ref={popoverRef}
      style={style}
      className="z-30 flex max-h-60 w-[min(28rem,calc(100vw-16px))] flex-col overflow-hidden rounded-md border border-edge bg-surface shadow-2xl"
    >
      {/* Header: char count + copy/close */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-edge bg-surface-muted px-2 py-1">
        <span className="text-[10px] text-content-muted">
          {tag.content.length.toLocaleString()} 字符 · ESC 或点击外部关闭
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={handleCopy}
            className="flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] text-content-muted transition-colors hover:bg-surface-hover hover:text-content"
            title="复制完整内容"
          >
            {copyState === "copied" ? (
              <>
                <IconCheck size={11} /> 已复制
              </>
            ) : copyState === "failed" ? (
              "复制失败"
            ) : (
              <>
                <IconCopy size={11} /> Copy
              </>
            )}
          </button>
          {onExpand && (
            <button
              type="button"
              onClick={() => {
                onExpand();
                onClose();
              }}
              className="flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] text-content-muted transition-colors hover:bg-surface-hover hover:text-content"
              title="拆开卡片，内容粘贴到输入框"
            >
              <IconArrowsMaximize size={11} /> 拆开
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="flex h-4 w-4 items-center justify-center rounded text-content-muted transition-colors hover:bg-surface-hover hover:text-content"
            title="关闭"
            aria-label="关闭预览"
          >
            <IconX size={11} />
          </button>
        </div>
      </div>
      {/* Content: scrollable, preserves whitespace, monospace so code/log
          pastes keep their original column alignment. */}
      <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono [font-size:var(--chat-fs-xs)] leading-relaxed text-content">
        {tag.content}
      </pre>
    </div>
  );
}
