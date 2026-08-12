import { forwardRef } from "react";
import { cn } from "@renderer/lib/cn.js";
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
  const isFile = tag.kind === "file";
  const isElement = tag.kind === "element";
  return (
    <span
      ref={ref}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] transition-colors",
        open
          ? "border-accent bg-accent/20 text-accent"
          : "border-accent/40 bg-accent/10 text-accent hover:border-accent/70 hover:bg-accent/20",
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        title={isFile ? (tag.filePath ?? tag.preview) : isElement ? (open ? "收起预览" : "查看元素内容") : open ? "收起预览" : "查看内容"}
        className="flex items-center gap-1"
      >
        {isFile ? (
          isImageFile(tag) ? (
            <IconPhoto size={12} className="opacity-80" />
          ) : (
            <IconFile size={12} className="opacity-80" />
          )
        ) : isElement ? (
          <IconCode size={12} className="opacity-80" />
        ) : (
          <IconClipboard size={12} className="opacity-80" />
        )}
        <span className="max-w-[160px] truncate font-normal">{tag.preview}</span>
      </button>
      <button
        type="button"
        onClick={onRemove}
        title="删除此附件"
        aria-label="删除此附件"
        className="ml-0.5 flex h-4 w-4 items-center justify-center rounded text-accent/70 transition-colors hover:bg-accent/30 hover:text-accent"
      >
        <IconX size={11} />
      </button>
    </span>
  );
});
