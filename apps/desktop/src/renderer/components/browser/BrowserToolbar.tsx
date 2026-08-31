import { useMemo, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import {
  IconArrowLeft,
  IconChevronLeft,
  IconChevronRight,
  IconRefresh,
  IconTarget,
  IconX,
  IconLoader2,
  IconDeviceMobile,
  IconArrowsMaximize,
  IconArrowsMinimize,
  IconClock,
  IconTrash,
} from "@renderer/lib/icons.js";
import type { BrowserHistoryEntry } from "@contracts/ipc";
import type { BrowserMode } from "./BrowserPanel.js";
import { useI18n } from "@renderer/lib/i18n/index.js";

/**
 * Toolbar for the embedded browser panel. Pure presentational - all state
 * (url, loading, canGoBack/Forward, pickMode, deviceToolbarOpen) is passed in
 * as props, and every action is a callback. Sits at the top of the BrowserPanel;
 * the WebContentsView is positioned below it, so this bar must never be covered
 * by the view.
 *
 * Device emulation controls live in the separate DeviceToolbar row below this
 * one (mirroring Chrome DevTools' "Toggle device toolbar"): a 📱 button here
 * toggles that row's visibility.
 */
export interface BrowserToolbarProps {
  /** Which container this toolbar lives in (drives the leading button). */
  mode: BrowserMode;
  /** Current address-bar text (controlled). */
  url: string;
  /** Whether the page is currently loading (drives the reload -> spinner swap). */
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Whether the element picker is active (accent highlight on the toggle). */
  pickMode: boolean;
  /** Whether the device toolbar row is currently shown (accent on the 📱). */
  deviceToolbarOpen: boolean;
  onUrlChange: (url: string) => void;
  onNavigate: (url: string) => void;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onTogglePickMode: () => void;
  /** Toggle the DevTools-style device toolbar row. */
  onToggleDeviceToolbar: () => void;
  /** Overlay only: return to the main workspace (hide the overlay, keep views
   *  alive). Sidebar ignores this. */
  onClose: () => void;
  /** Switch to the other container: sidebar → overlay (PC fullscreen) or
   *  overlay → sidebar (mobile column). Tabs carry over via the shared store. */
  onSwitchMode: () => void;
  /** Address-bar history (most-recent first), persisted by main. */
  history: BrowserHistoryEntry[];
  /** Remove one history entry (delegates to browser.historyRemove). */
  onRemoveHistoryEntry: (url: string) => void;
  /** Clear the whole history (delegates to browser.historyClear). */
  onClearHistory: () => void;
  /** Fired as the history dropdown opens/closes — the parent hides/shows the
   *  OS-level WebContentsView so the renderer-DOM dropdown isn't covered. */
  onHistoryMenuOpenChange: (open: boolean) => void;
  /** Request to destroy the browser entirely — the parent opens a
   *  confirmation dialog; on confirm all tabs/views are torn down. */
  onRequestDestroy: () => void;
}

/** Compact square icon button used across the toolbar. Mirrors the Titlebar's
 *  toggle-button styling (p-1.5, rounded, accent when active). */
function ToolButton({
  onClick,
  disabled,
  active,
  title,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className={cn(
        "flex h-7 w-7 shrink-0 items-center justify-center rounded transition-colors",
        active
          ? "bg-accent/20 text-accent"
          : "text-content-muted hover:bg-surface-hover hover:text-content",
        "disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-content-muted",
      )}
    >
      {children}
    </button>
  );
}

export function BrowserToolbar({
  mode,
  url,
  loading,
  canGoBack,
  canGoForward,
  pickMode,
  deviceToolbarOpen,
  onUrlChange,
  onNavigate,
  onBack,
  onForward,
  onReload,
  onTogglePickMode,
  onToggleDeviceToolbar,
  onClose,
  onSwitchMode,
  onRequestDestroy,
  history,
  onRemoveHistoryEntry,
  onClearHistory,
  onHistoryMenuOpenChange,
}: BrowserToolbarProps) {
  const { t } = useI18n();
  // Address-history dropdown state. Local because only this input drives it;
  // the parent is only told about open/close so it can hide the OS-level view.
  const [historyOpen, setHistoryOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);

  const filteredHistory = useMemo(() => {
    const q = url.trim().toLowerCase();
    if (!q) return history.slice(0, 10);
    return history
      .filter(
        (e) =>
          e.url.toLowerCase().includes(q) ||
          (e.title && e.title.toLowerCase().includes(q)),
      )
      .slice(0, 10);
  }, [history, url]);

  const setDropdownOpen = (open: boolean) => {
    setHistoryOpen(open);
    if (open) setHighlight(0);
    onHistoryMenuOpenChange(open);
  };

  const pickHistoryEntry = (entry: BrowserHistoryEntry) => {
    setDropdownOpen(false);
    onUrlChange(entry.url);
    onNavigate(entry.url);
  };
  return (
    <div className="flex h-11 shrink-0 items-center gap-1 border-b border-edge bg-surface px-2">
      {mode === "overlay" ? (
        <>
          {/* Overlay: "返回工作台" leaves the fullscreen overlay (views stay
              alive). Visually distinct (accent on hover) so the user sees how
              to exit. */}
          <ToolButton onClick={onClose} title={t("browser.backToWorkspace")}>
            <IconArrowLeft size={16} />
          </ToolButton>
          {/* Switch to the embedded sidebar (mobile column). */}
          <ToolButton onClick={onSwitchMode} title={t("browser.switchToSidebar")}>
            <IconArrowsMinimize size={16} />
          </ToolButton>
        </>
      ) : (
        /* Sidebar: "展开为 PC 全屏" swaps to the fullscreen overlay. The
           sidebar has no "close" button here — closing is via the rail icon
           toggle or the 关闭浏览器 button on the right. */
        <ToolButton onClick={onSwitchMode} title={t("browser.expandFullscreen")}>
          <IconArrowsMaximize size={16} />
        </ToolButton>
      )}

      <div className="mx-1 h-5 w-px bg-edge" />

      <ToolButton onClick={onBack} disabled={!canGoBack} title={t("browser.back")}>
        <IconChevronLeft size={18} />
      </ToolButton>
      <ToolButton onClick={onForward} disabled={!canGoForward} title={t("browser.forward")}>
        <IconChevronRight size={18} />
      </ToolButton>
      <ToolButton onClick={onReload} title={t("common.refresh")}>
        {loading ? (
          <IconLoader2 size={16} className="animate-spin" />
        ) : (
          <IconRefresh size={16} />
        )}
      </ToolButton>

      {/* Address bar - Enter navigates. Controlled by the parent so navigation
          events can update it. Focusing opens the history dropdown (the parent
          hides the OS-level view while it's open so the dropdown is visible). */}
      <div className="relative mx-1 min-w-0 flex-1">
        <input
          type="text"
          value={url}
          onChange={(e) => {
            onUrlChange(e.target.value);
            if (!historyOpen && filteredHistory.length > 0) setDropdownOpen(true);
          }}
          onFocus={() => {
            if (!historyOpen && filteredHistory.length > 0) setDropdownOpen(true);
          }}
          onBlur={() => {
            // Delay so row clicks (mousedown below) land before the close.
            setTimeout(() => setDropdownOpen(false), 150);
          }}
          onKeyDown={(e) => {
            if (historyOpen && filteredHistory.length > 0) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setHighlight((h) => Math.min(h + 1, filteredHistory.length - 1));
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setHighlight((h) => Math.max(h - 1, 0));
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setDropdownOpen(false);
                return;
              }
            }
            if (e.key === "Enter") {
              e.preventDefault();
              if (historyOpen && filteredHistory[highlight]) {
                pickHistoryEntry(filteredHistory[highlight]);
              } else {
                onNavigate(url);
              }
            }
          }}
          placeholder={t("browser.addressPlaceholder")}
          spellCheck={false}
          className={cn(
            "h-7 w-full rounded-md border border-edge bg-surface-muted px-2.5",
            "text-[13px] text-content placeholder:text-content-subtle",
            "focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/40",
          )}
        />
        {historyOpen && filteredHistory.length > 0 && (
          <div
            className={cn(
              "absolute left-0 right-0 top-full z-30 mt-1",
              "max-h-72 overflow-y-auto rounded-md border border-edge bg-surface shadow-xl",
            )}
          >
            <div className="flex items-center gap-1.5 px-2.5 py-1.5 text-[10px] font-medium uppercase tracking-wide text-content-subtle">
              <IconClock size={11} />
              {t("browser.history")}
            </div>
            {filteredHistory.map((entry, i) => (
              <div
                key={entry.url}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pickHistoryEntry(entry)}
                onMouseEnter={() => setHighlight(i)}
                className={cn(
                  "flex cursor-pointer items-center gap-2 px-2.5 py-1.5",
                  i === highlight ? "bg-surface-hover" : "bg-transparent",
                )}
              >
                <div className="min-w-0 flex-1">
                  {entry.title && (
                    <div className="truncate text-xs text-content">{entry.title}</div>
                  )}
                  <div className="truncate text-[11px] text-content-muted">{entry.url}</div>
                </div>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemoveHistoryEntry(entry.url);
                  }}
                  title={t("browser.removeHistoryEntry")}
                  className="rounded p-1 text-content-subtle hover:bg-surface-hover hover:text-danger"
                >
                  <IconTrash size={12} />
                </button>
              </div>
            ))}
            {history.length > 0 && (
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onClearHistory();
                  setDropdownOpen(false);
                }}
                className="w-full border-t border-edge px-2.5 py-1.5 text-left text-[11px] text-content-muted hover:bg-surface-hover hover:text-content"
              >
                {t("browser.clearHistory")}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Element picker toggle. Accent when active. */}
      <ToolButton onClick={onTogglePickMode} active={pickMode} title={pickMode ? t("browser.exitPick") : t("browser.pickElement")}>
        <IconTarget size={16} />
      </ToolButton>

      {/* Device-toolbar toggle — the "Toggle device toolbar" equivalent. Shows
          the DevTools-style row (device dropdown + custom dims + rotate) under
          the address bar. Accent when open. */}
      <ToolButton
        onClick={onToggleDeviceToolbar}
        active={deviceToolbarOpen}
        title={deviceToolbarOpen ? t("browser.collapseDeviceToolbar") : t("browser.deviceToolbar")}
      >
        <IconDeviceMobile size={16} />
      </ToolButton>

      <div className="mx-1 h-5 w-px bg-edge" />

      <ToolButton onClick={onRequestDestroy} title={t("browser.closeBrowser")}>
        <IconX size={16} />
      </ToolButton>
    </div>
  );
}
