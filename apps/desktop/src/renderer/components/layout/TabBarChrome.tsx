import { Menu } from "@base-ui/react/menu";
import { cn } from "@renderer/lib/cn.js";
import { IconCheck, IconChevronLeft, IconChevronRight, IconDotsVertical } from "@renderer/lib/icons.js";
import { useI18n } from "@renderer/lib/i18n/index.js";

/**
 * Shared tab-bar chrome for the center pane's two tab strips:
 *  - SessionTabs  — session tabs (tabs display mode)
 *  - OpenTabsBar  — open-file tabs above the Monaco editor
 *
 * Both strips scroll horizontally when tabs overflow; these primitives provide
 * the paging chevrons and the "⋯" overflow menu so the two bars stay visually
 * and behaviorally consistent (see SessionTabs for the full interaction model).
 */

/* ───────────────────────── chevron buttons ───────────────────────── */

interface ChevronButtonProps {
  dir: "left" | "right";
  onClick: () => void;
  title: string;
}

/** Paging arrow that scrolls the tab track by ~80% of its width. Rendered
 *  only on the side(s) where content is scrolled out of view. */
export function TabBarChevronButton({ dir, onClick, title }: ChevronButtonProps) {
  const Icon = dir === "left" ? IconChevronLeft : IconChevronRight;
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className="mb-0.5 flex h-6 w-5 shrink-0 items-center justify-center rounded text-content-subtle transition-colors hover:bg-surface-muted hover:text-content"
    >
      <Icon size={14} />
    </button>
  );
}

/* ───────────────────────── overflow menu ───────────────────────── */

export interface TabBarOverflowItem {
  key: string;
  label: string;
  /** Full title (tooltip) — e.g. the full file path for file tabs. */
  title?: string;
  active: boolean;
  /** Tailwind class for the leading status dot (running / dirty pulse etc.).
   *  Omit to render no dot. */
  dotClass?: string;
}

interface OverflowMenuProps {
  items: TabBarOverflowItem[];
  /** Small uppercase heading shown above the list, e.g. "Open tabs". */
  heading: string;
  onSelect: (key: string) => void;
  /** Current multi-row wrapping state + toggle callback. When the callback
   *  is provided, the menu renders a pinned checkbox item under the heading
   *  ("multi-row tabs") so the toggle stays reachable even when the tab list
   *  is long. The popup stays OPEN on toggle (`closeOnClick={false}`) so the
   *  re-wrapping bar is visible live behind it and the choice is trivially
   *  reversible. */
  multiRow?: boolean;
  onToggleMultiRow?: (on: boolean) => void;
}

/** "⋯" menu listing every tab for quick jumping — only shown when the strip
 *  actually overflows (otherwise it's pure noise). Generic over `items` so the
 *  session strip (running dot) and the file strip (dirty dot) share it.
 *  Optionally carries the shared multi-row display toggle. */
export function TabBarOverflowMenu({
  items,
  heading,
  onSelect,
  multiRow,
  onToggleMultiRow,
}: OverflowMenuProps) {
  const { t } = useI18n();
  return (
    <Menu.Root>
      <Menu.Trigger
        className="mb-0.5 flex h-6 w-5 shrink-0 items-center justify-center rounded text-content-subtle transition-colors hover:bg-surface-muted hover:text-content"
        title="Show all tabs"
        aria-label="Show all tabs"
      >
        <IconDotsVertical size={14} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="top" align="end">
          <Menu.Popup
            className={cn(
              "z-50 min-w-[200px] origin-bottom-right rounded-md border border-edge bg-surface py-1 shadow-2xl",
              "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
              "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
              "transition-[transform,opacity] duration-100",
            )}
          >
            <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-content-subtle">
              {heading}
            </div>
            {/* Pinned display options — stay visible above the scrolling
                tab list no matter how many tabs are open. */}
            {onToggleMultiRow && (
              <>
                <Menu.CheckboxItem
                  checked={multiRow ?? false}
                  onCheckedChange={onToggleMultiRow}
                  closeOnClick={false}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] outline-none select-none",
                    "data-[highlighted]:bg-surface-muted",
                    multiRow ? "text-content dark:text-accent" : "text-content-muted",
                  )}
                >
                  <span className="min-w-0 flex-1">{t("ide.editor.multiRowTabs")}</span>
                  <Menu.CheckboxItemIndicator className="shrink-0 text-accent">
                    <IconCheck size={12} />
                  </Menu.CheckboxItemIndicator>
                </Menu.CheckboxItem>
                <Menu.Separator className="my-1 h-px bg-edge" />
              </>
            )}
            <div className="max-h-[min(60vh,320px)] overflow-y-auto">
              {items.map((item) => (
                <Menu.Item
                  key={item.key}
                  onClick={() => onSelect(item.key)}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] outline-none select-none",
                    "data-[highlighted]:bg-surface-muted",
                    item.active ? "text-content dark:text-accent" : "text-content-muted",
                  )}
                >
                  {item.dotClass && (
                    <span aria-hidden className={cn("inline-block h-1.5 w-1.5 shrink-0 rounded-full", item.dotClass)} />
                  )}
                  <span className="truncate" title={item.title}>
                    {item.label}
                  </span>
                </Menu.Item>
              ))}
            </div>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
