import { cn } from "@renderer/lib/cn.js";
import { IconX, IconTrash, IconCode, IconArrowRight } from "@renderer/lib/icons.js";
import type { PickedElement } from "@contracts/ipc";
import { useI18n } from "@renderer/lib/i18n/index.js";

/**
 * Picked-elements bar - a Chrome-download-bar-style strip at the bottom of the
 * browser panel showing the DOM elements the user has picked in this session.
 *
 * Purpose: the browser overlay covers the composer, so without this bar the
 * user has no feedback that a clicked element was captured. The bar shows a
 * chip per picked element (selector preview), a running count, a clear-all
 * button, and an "添加" button that flushes all staged elements to the
 * composer and returns to the main workspace.
 *
 * Elements are STAGED here - they are NOT enqueued to the composer until the
 * user clicks "添加". This lets the user pick multiple elements, review them,
 * remove mistakes, and commit in one action.
 *
 * The bar auto-hides when empty (no picked items) so it doesn't waste vertical
 * space during normal browsing.
 */
export interface PickedElementsBarProps {
  items: PickedElement[];
  onRemove: (index: number) => void;
  onClear: () => void;
  /** Flush all staged elements to the composer and return to the main panel. */
  onAdd: () => void;
}

export function PickedElementsBar({ items, onRemove, onClear, onAdd }: PickedElementsBarProps) {
  const { t } = useI18n();
  if (items.length === 0) return null;
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-t border-edge bg-surface-muted px-2">
      <span className="shrink-0 text-[11px] font-medium text-content-muted">
        {t("browser.pickedCount", { n: items.length })}
      </span>
      <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
        {items.map((el, i) => (
          <span
            key={`${i}-${el.selector}`}
            className={cn(
              "inline-flex shrink-0 items-center gap-1 rounded-md border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-[11px] text-accent",
            )}
            title={el.selector}
          >
            <IconCode size={11} className="opacity-70" />
            <span className="max-w-[140px] truncate">{el.preview || el.selector}</span>
            <button
              type="button"
              aria-label={t("common.remove")}
              onClick={() => onRemove(i)}
              className="ml-0.5 inline-flex h-3.5 w-3.5 items-center justify-center rounded text-accent/70 transition-colors hover:bg-accent/30 hover:text-accent"
            >
              <IconX size={10} />
            </button>
          </span>
        ))}
      </div>
      <button
        type="button"
        onClick={onClear}
        title={t("browser.clearPickedHint")}
        className="flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-[11px] text-content-muted transition-colors hover:bg-surface-hover hover:text-content"
      >
        <IconTrash size={12} />
        {t("browser.clear")}
      </button>
      <button
        type="button"
        onClick={onAdd}
        title={t("browser.addAndReturn")}
        className={cn(
          "flex shrink-0 items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors",
          "bg-accent text-white hover:bg-accent/90",
        )}
      >
        {t("browser.add")}
        <IconArrowRight size={12} />
      </button>
    </div>
  );
}

