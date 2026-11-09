/**
 * ImageWithPreview — a thumbnail that opens a modern fullscreen lightbox on click.
 *
 * Renders a small, bounded image inline (so it doesn't dominate the chat
 * stream); clicking it opens a full-featured MediaLightbox with pan, zoom,
 * rotate, and navigation capabilities.
 */
import { useEffect, useMemo, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { IconArrowsMaximize } from "@renderer/lib/icons.js";
import { MediaLightbox, type MediaItem } from "./media-lightbox.js";

export interface ImageWithPreviewProps {
  /** Raw image source — a full `data:` URL or a regular URL. */
  src: string;
  /** Alt text for accessibility. */
  alt?: string;
  /** Extra classes on the thumbnail wrapper. */
  className?: string;
  /** Max thumbnail height in px (default 160). Combined with `maxThumbnailWidth`
   *  this caps the inline preview so a screenshot sits politely in the message
   *  stream instead of dominating it — click opens the full-size lightbox. */
  maxThumbnailHeight?: number;
  /** Max thumbnail width in px (default 280). */
  maxThumbnailWidth?: number;
  /** When true, render the thumbnail inside a fixed frame of
   *  maxThumbnailWidth × maxThumbnailHeight (image is object-contain'd inside).
   *  Switching between differently-sized screenshots then keeps the card a
   *  stable size instead of resizing around each image. */
  fixedFrame?: boolean;
  /** Full image list this thumbnail belongs to. When provided (length > 1),
   *  the lightbox gains prev/next navigation + a position counter. */
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
  maxThumbnailHeight = 160,
  maxThumbnailWidth = 280,
  fixedFrame = false,
  gallery,
  index = 0,
  onNavigate,
}: ImageWithPreviewProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  const gallerySrcs = gallery && gallery.length > 0 ? gallery : [src];
  const count = gallerySrcs.length;

  const [viewIdx, setViewIdx] = useState(index);

  useEffect(() => {
    setViewIdx(Math.max(0, Math.min(count - 1, index)));
  }, [index, count]);

  useEffect(() => {
    if (open) {
      setViewIdx(Math.max(0, Math.min(count - 1, index)));
    }
  }, [open, index, count]);

  const items: MediaItem[] = useMemo(() => {
    return gallerySrcs.map((imgSrc, i) => ({
      kind: "image" as const,
      src: imgSrc,
      alt: count > 1 ? `${alt} ${i + 1}/${count}` : alt,
    }));
  }, [gallerySrcs, alt, count]);

  const handleNavigate = (nextIdx: number) => {
    setViewIdx(nextIdx);
    onNavigate?.(nextIdx);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={t("layout.image.clickToView")}
        className={cn(
          "group relative block w-fit overflow-hidden rounded-lg border border-edge bg-surface-muted/60 shadow-sm transition-all hover:border-accent/60 hover:shadow-md",
          className,
        )}
      >
        <img
          src={src}
          alt={alt}
          loading="lazy"
          draggable={false}
          style={
            fixedFrame
              ? { width: maxThumbnailWidth, height: maxThumbnailHeight }
              : { maxHeight: maxThumbnailHeight, maxWidth: maxThumbnailWidth }
          }
          className="block object-contain transition-transform duration-200 group-hover:scale-[1.03]"
        />
        {/* Hover affordance: a small maximize badge that appears on hover. */}
        <span className="pointer-events-none absolute right-1.5 top-1.5 flex items-center gap-1 rounded bg-black/55 px-1.5 py-0.5 text-[10px] font-medium text-white opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100">
          <IconArrowsMaximize size={12} />
          {t("layout.image.view")}
        </span>
      </button>

      {open && (
        <MediaLightbox
          items={items}
          index={viewIdx}
          open={open}
          onNavigate={handleNavigate}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
