import { cn } from "@renderer/lib/cn.js";
import { IconX, IconPlus, IconLoader2, IconWorld } from "@renderer/lib/icons.js";
import { useI18n } from "@renderer/lib/i18n/index.js";

/** A single browser tab's display state (mirrors the BrowserTab in BrowserPanel
 *  minus browserId, which the tab strip doesn't need). */
export interface BrowserTabDisplay {
  id: string;
  title: string;
  url: string;
  loading: boolean;
}

/**
 * Tab strip for the embedded browser panel. Mirrors the SessionTabs visual
 * pattern (rounded-t, border-b-2 accent on active, close-on-hover) but
 * simplified: fixed order (no drag-reorder), horizontal scroll on overflow
 * (no chevrons/overflow menu), and a trailing "+" new-tab button.
 *
 * Middle-click on a tab closes it (browser convention).
 */
export interface BrowserTabsProps {
  tabs: BrowserTabDisplay[];
  activeTabId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
}

export function BrowserTabs({ tabs, activeTabId, onSelect, onClose, onNew }: BrowserTabsProps) {
  const { t } = useI18n();
  if (tabs.length === 0) return null;
  return (
    <div className="flex h-9 shrink-0 items-end gap-0.5 border-b border-edge bg-surface/40 px-2 pt-1.5">
      <div className="no-scrollbar flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto">
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          // Derive a short tab title: prefer the page title, fall back to the
          // URL's hostname, then the "new tab" placeholder for about:blank/empty.
          const host = (() => {
            try {
              if (tab.url && tab.url !== "about:blank") return new URL(tab.url).hostname;
            } catch {
              /* not a valid URL */
            }
            return null;
          })();
          const label = tab.title || host || (tab.url && tab.url !== "about:blank" ? tab.url : t("browser.newTab"));
          return (
            <div
              key={tab.id}
              role="tab"
              aria-selected={isActive}
              onClick={() => onSelect(tab.id)}
              onMouseDown={(e) => {
                // Middle-click closes the tab (browser convention).
                if (e.button === 1) {
                  e.preventDefault();
                  onClose(tab.id);
                }
              }}
              className={cn(
                "group flex max-w-[180px] min-w-0 shrink-0 cursor-pointer select-none items-center gap-1.5 rounded-t-md border-b-2 px-2.5 py-1.5 text-[11px] transition-colors",
                isActive
                  ? "border-accent bg-surface text-content"
                  : "border-transparent text-content-muted hover:bg-surface-muted/50 hover:text-content",
              )}
              title={label}
            >
              {tab.loading ? (
                <IconLoader2 size={12} className="shrink-0 animate-spin text-accent" />
              ) : (
                <IconWorld size={12} className="shrink-0 text-content-subtle" />
              )}
              <span className="min-w-0 truncate">{label}</span>
              <button
                type="button"
                aria-label={t("browser.closeTabAria")}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(tab.id);
                }}
                onPointerDown={(e) => e.stopPropagation()}
                className={cn(
                  "ml-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-content-subtle transition-opacity hover:bg-surface-hover hover:text-content",
                  isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                )}
              >
                <IconX size={11} />
              </button>
            </div>
          );
        })}
      </div>
      {/* New-tab button. */}
      <button
        type="button"
        onClick={onNew}
        title={t("browser.createTab")}
        aria-label={t("browser.createTab")}
        className="mb-0.5 ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded text-content-muted transition-colors hover:bg-surface-muted hover:text-content"
      >
        <IconPlus size={14} />
      </button>
    </div>
  );
}
