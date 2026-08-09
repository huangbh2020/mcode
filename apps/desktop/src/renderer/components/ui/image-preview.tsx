/**
 * ImageWithPreview — a thumbnail that opens a fullscreen lightbox on click.
 *
 * Renders a small, bounded image inline (so it doesn't dominate the chat
 * stream); clicking it opens a Dialog-based preview with a dark backdrop where
 * the image is shown at its full size (object-contain within the viewport).
 * Built on the project's Dialog primitive (base-ui) for consistent modal
 * behavior: Esc to close, click backdrop to close, focus trap.
 *
 * When `gallery` is provided (the full image list this thumbnail is part of),
 * the lightbox shows ◀ ▶ nav buttons to step through the gallery, plus a
 * position counter. Navigation is pushed up via `onNavigate` so the caller
 * (e.g. ImageGallery) can keep its own index in sync; `index` is the current
 * position, used to initialize the lightbox view.
 */
import { useEffect, useState } from "react";
import { Dialog } from "./dialog.js";
import { cn } from "@renderer/lib/cn.js";
import {
  IconArrowsMaximize,
  IconChevronLeft,
  IconChevronRight,
  IconDownload,
  IconX,
} from "@renderer/lib/icons.js";

/** Trigger a browser download of a `data:` URL (base64 image). Creates a
 *  temporary <a download> and clicks it. The filename is derived from a
 *  timestamp so repeated downloads don't collide. */
function downloadDataUrl(dataUrl: string, baseName: string): void {
  try {
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = baseName;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch {
    // Downloads can be blocked in exotic embedded contexts; ignore silently.
  }
}

export interface ImageWithPreviewProps {
  /** Raw image source — a full `data:` URL or a regular URL. */
  src: string;
  /** Alt text for accessibility. */
  alt?: string;
  /** Extra classes on the thumbnail wrapper. */
  className?: string;
  /** Max thumbnail height in px (default 240 — small enough to stay compact in
   *  the message stream, large enough to be recognizable). */
  maxThumbnailHeight?: number;
  /** Full image list this thumbnail belongs to. When provided (length > 1),
   *  the lightbox gains ◀ ▶ navigation + a position counter. */
  gallery?: string[];
  /** Current index within `gallery`. Seeds the lightbox view and follows
   *  external index changes (e.g. the caller's own thumbnail arrows). */
  index?: number;
  /** Fired when the user navigates inside the lightbox, so the caller can sync
   *  its own index (and thus which thumbnail is shown). */
  onNavigate?: (index: number) => void;
}

export function ImageWithPreview({
  src,
  alt = "",
  className,
  maxThumbnailHeight = 240,
  gallery,
  index = 0,
  onNavigate,
}: ImageWithPreviewProps) {
  const [open, setOpen] = useState(false);
  const gallerySrcs = gallery && gallery.length > 0 ? gallery : [src];
  const count = gallerySrcs.length;
  // Local lightbox index. Seeded from `index` on open, and re-synced whenever
  // the external `index` moves (the caller's thumbnail arrows / our own nav).
  const [viewIdx, setViewIdx] = useState(index);
  useEffect(() => {
    setViewIdx(Math.max(0, Math.min(count - 1, index)));
  }, [index, count]);
  // Opening the lightbox starts at the currently-selected thumbnail.
  useEffect(() => {
    if (open) setViewIdx(Math.max(0, Math.min(count - 1, index)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const curSrc = gallerySrcs[Math.min(viewIdx, count - 1)] ?? src;
  const curAlt = count > 1 ? `${alt} ${Math.min(viewIdx, count - 1) + 1}/${count}` : alt;
  const go = (delta: number) => {
    const next = Math.max(0, Math.min(count - 1, viewIdx + delta));
    if (next === viewIdx) return;
    setViewIdx(next);
    onNavigate?.(next);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="点击查看大图"
        className={cn(
          "group relative block overflow-hidden rounded-md border border-edge bg-surface/40 transition-colors hover:border-accent/50",
          className,
        )}
      >
        <img
          src={src}
          alt={alt}
          loading="lazy"
          style={{ maxHeight: maxThumbnailHeight }}
          className="block w-full object-contain"
        />
        {/* Hover affordance: a small maximize badge that appears on hover. */}
        <span className="pointer-events-none absolute right-1.5 top-1.5 flex items-center gap-1 rounded bg-black/55 px-1.5 py-0.5 text-[10px] font-medium text-white opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100">
          <IconArrowsMaximize size={12} />
          查看
        </span>
      </button>
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Backdrop
            // Override the default top-10 + bg-black/60 for a true fullscreen
            // dark lightbox: cover from the very top, darker tint. Clicking the
            // backdrop closes (base-ui Dialog propagates onOpenChange).
            className="fixed inset-0 top-0 z-50 bg-black/85"
          />
          <Dialog.Popup
            // Transparent, borderless, full-viewport container — the image sits
            // centered inside. No rounded panel chrome (this is a lightbox, not
            // a form dialog). The default -translate centering is kept.
            className="left-1/2 top-1/2 max-h-[92vh] max-w-[94vw] -translate-x-1/2 -translate-y-1/2 rounded-none border-0 bg-transparent p-0 shadow-none"
          >
            {/* Visually-hidden title for a11y (Dialog expects a Title). */}
            <Dialog.Title className="sr-only">{curAlt || "图片预览"}</Dialog.Title>
            <img
              src={curSrc}
              alt={curAlt}
              className="block max-h-[92vh] max-w-[94vw] object-contain"
            />
            {/* Lightbox prev/next nav — only when this image is part of a
                multi-image gallery. */}
            {count > 1 && (
              <>
                <button
                  type="button"
                  onClick={() => go(-1)}
                  disabled={viewIdx <= 0}
                  title="上一张"
                  className="fixed left-4 top-1/2 -translate-y-1/2 rounded-full bg-black/60 p-2.5 text-white/90 backdrop-blur-sm transition-colors enabled:hover:bg-black/80 enabled:hover:text-white disabled:opacity-30"
                >
                  <IconChevronLeft size={24} />
                </button>
                <button
                  type="button"
                  onClick={() => go(1)}
                  disabled={viewIdx >= count - 1}
                  title="下一张"
                  className="fixed right-4 top-1/2 -translate-y-1/2 rounded-full bg-black/60 p-2.5 text-white/90 backdrop-blur-sm transition-colors enabled:hover:bg-black/80 enabled:hover:text-white disabled:opacity-30"
                >
                  <IconChevronRight size={24} />
                </button>
                {/* Position counter, top-center. */}
                <span className="fixed left-1/2 top-4 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1 text-xs font-medium text-white/90 backdrop-blur-sm">
                  {Math.min(viewIdx, count - 1) + 1} / {count}
                </span>
              </>
            )}
            {/* Download button — saves the current image (data: URL or remote)
                as a PNG file. Sits left of the close button. */}
            <button
              type="button"
              onClick={() => {
                const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
                downloadDataUrl(curSrc, `截图-${stamp}.png`);
              }}
              title="下载图片"
              className="fixed right-16 top-4 rounded-full bg-black/60 p-2 text-white/90 backdrop-blur-sm transition-colors hover:bg-black/80 hover:text-white"
            >
              <IconDownload size={20} />
            </button>
            <Dialog.Close
              className="fixed right-4 top-4 rounded-full bg-black/60 p-2 text-white/90 backdrop-blur-sm transition-colors hover:bg-black/80 hover:text-white"
              aria-label="关闭预览"
            >
              <IconX size={20} />
            </Dialog.Close>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
