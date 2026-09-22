import { forwardRef } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { IconClipboard, IconFile, IconCode, IconPhoto, IconX } from "@renderer/lib/icons.js";
import { isImageFile, type ContentTag } from "@renderer/lib/contentTag.js";

/**
 * A single content-tag chip rendered above the textarea in the composer.
 * Click the body to toggle its popover preview; click the × to remove.
 *
 * Uses the theme accent color so "interactive composer addition" reads as
 * part of the app's brand surface. Visually distinct from tool-approval
 * cards (amber) and plan-approval cards (violet), each of which represents
 * a *blocking* decision; a tag is just a piece of draft content the user
 * is composing with.
 *
 * Forwards its ref so the parent can measure the chip's bounding box and
 * anchor the preview popover to the chip's top-right corner.
 */
export const ContentTagChip = forwardRef<
  HTMLSpanElement,
  {
    tag: ContentTag;
    /** Whether this chip's popover is currently shown. Affects the
     *  visual emphasis (active chip gets a stronger border). */
    open: boolean;
    onToggle: () => void;
    onRemove: () => void;
  }
>(function ContentTagChip({ tag, open, onToggle, onRemove }, ref) {
  const { t } = useI18n();
  const isFile = tag.kind === "file";
  const isElement = tag.kind === "element";
  return (
    <span
      ref={ref}
      className={cn(
        // composer-tag-in: spring entrance when the chip mounts (paste
        // promotion, file drop, @-mention pick) — see styles.css.
        "composer-tag-in inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] transition-colors",
        open
          ? "border-accent/60 bg-accent/10 text-content ring-1 ring-accent/30 shadow-xs"
          : "border-edge/70 bg-surface-muted/70 text-content hover:bg-surface-hover/80 hover:border-edge shadow-2xs",
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        title={
          isFile
            ? (tag.filePath ?? tag.preview)
            : isElement
              ? (open ? t("chat.tag.hidePreview") : t("chat.tag.viewElement"))
              : open ? t("chat.tag.hidePreview") : t("chat.tag.viewContent")
        }
        className="flex items-center gap-1.5"
      >
        {isFile ? (
          isImageFile(tag) ? (
            <IconPhoto size={12} className="shrink-0 text-violet-500 opacity-90" />
          ) : (
            <IconFile size={12} className="shrink-0 text-blue-500 opacity-90" />
          )
        ) : isElement ? (
          <IconCode size={12} className="shrink-0 text-amber-500 opacity-90" />
        ) : (
          <IconClipboard size={12} className="shrink-0 text-emerald-500 opacity-90" />
        )}
        <span className="max-w-[160px] truncate font-normal text-content">{tag.preview}</span>
      </button>
      <button
        type="button"
        onClick={onRemove}
        title={t("chat.tag.removeTitle")}
        aria-label={t("chat.tag.removeTitle")}
        className="ml-0.5 flex h-4 w-4 items-center justify-center rounded text-content-muted transition-colors hover:bg-surface-hover hover:text-content"
      >
        <IconX size={11} />
      </button>
    </span>
  );
});
