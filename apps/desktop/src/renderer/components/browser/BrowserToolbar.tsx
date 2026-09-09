import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import {
  IconArrowLeft,
  IconChevronLeft,
  IconChevronRight,
  IconRefresh,
  IconTarget,
  IconLoader2,
  IconDeviceMobile,
  IconArrowsMaximize,
  IconArrowsMinimize,
  IconClock,
  IconTrash,
  IconDots,
  IconStar,
  IconDownload,
  IconExternalLink,
  IconFolderOpen,
  IconShieldLock,
} from "@renderer/lib/icons.js";
import type { BrowserBookmarkEntry, BrowserHistoryEntry } from "@contracts/ipc";
import type { BrowserMode } from "./BrowserPanel.js";
import { formatBytes, type DownloadBarItem } from "./DownloadBar.js";
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
  /** Fired as the history dropdown opens/closes — the parent freezes/shows the
   *  OS-level WebContentsView so the renderer-DOM dropdown floats over a
   *  frozen snapshot instead of being covered. */
  onHistoryMenuOpenChange: (open: boolean) => void;
  /** Bookmarked pages (most-recent first), persisted by main. */
  bookmarks: BrowserBookmarkEntry[];
  /** Whether the current page is already bookmarked (drives the star action). */
  currentBookmarked: boolean;
  /** Bookmark / unbookmark the current page (parent decides by URL match). */
  onToggleBookmark: () => void;
  /** Remove one bookmark by URL. */
  onRemoveBookmark: (url: string) => void;
  /** Open a URL in the current tab (bookmark / history entries). */
  onOpenUrl: (url: string) => void;
  /** Open a URL forcing a NEW tab (bookmark rows' open-in-new-tab op; the
   *  plain onOpenUrl keeps the blank-tab reuse). */
  onOpenUrlNewTab: (url: string) => void;
  /** Session downloads — the same list the bottom DownloadBar renders. */
  downloads: DownloadBarItem[];
  /** Download actions: main resolves the path from its own registry. */
  onDownloadOpen: (downloadId: string) => void;
  onDownloadReveal: (downloadId: string) => void;
  /** Privacy rows: cache clear keeps cookies; cookie clear also wipes the
   *  persisted vault (main side). */
  onClearCache: () => void;
  onClearCookies: () => void;
  /** Fired as the "More" menu opens/closes — same freeze/show contract as the
   *  history dropdown. */
  onMoreMenuOpenChange: (open: boolean) => void;
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

/** Site letter-square for bookmark/history rows: host's first alphanumeric on
 *  a hue hashed from the host (stable per site, no network favicon fetch). */
function EntryFavicon({ url }: { url: string }) {
  const host = hostOf(url);
  const letter = (host.match(/[a-z0-9]/i)?.[0] ?? "?").toUpperCase();
  let hash = 0;
  for (let i = 0; i < host.length; i++) hash = (hash * 31 + host.charCodeAt(i)) | 0;
  return (
    <span
      aria-hidden
      className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-[9px] font-bold text-white"
      style={{ background: `hsl(${Math.abs(hash) % 360} 42% 42%)` }}
    >
      {letter}
    </span>
  );
}

/** Neutral extension badge for download rows (same square, no color hash). */
function DownloadExtBadge({ filename }: { filename: string }) {
  const ext = filename.match(/\.([a-z0-9]{1,4})$/i)?.[1]?.toUpperCase() ?? "?";
  return (
    <span
      aria-hidden
      className="flex h-4 w-4 shrink-0 items-center justify-center rounded bg-surface-muted text-[7px] font-bold text-content-muted"
    >
      {ext}
    </span>
  );
}

/** host without the www prefix; falls back to the raw string when URL parsing
 *  fails (nonstandard schemes). */
function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "") || url;
  } catch {
    return url;
  }
}

/** Hover-revealed per-row op button (open in new tab / remove / reveal). */
function RowOpButton({
  onClick,
  title,
  danger,
  children,
}: {
  onClick: () => void;
  title: string;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      title={title}
      aria-label={title}
      className={cn(
        "rounded p-1 text-content-subtle transition-colors hover:bg-surface hover:text-content",
        danger && "hover:text-danger",
      )}
    >
      {children}
    </button>
  );
}

/** One bookmark/history/download row: main click opens (or opens the file),
 *  hover reveals the trailing ops. `extra` renders inside the text column
 *  under the subtitle (download progress bar). */
function TreeEntryRow({
  title,
  subtitle,
  extra,
  favicon,
  ops,
  openTitle,
  onOpen,
}: {
  title: string;
  subtitle?: string;
  extra?: React.ReactNode;
  favicon: React.ReactNode;
  ops?: React.ReactNode;
  openTitle?: string;
  onOpen: () => void;
}) {
  return (
    <div
      onClick={onOpen}
      title={openTitle}
      className="group flex cursor-pointer items-center gap-2 py-1 pl-[26px] pr-2.5 transition-colors hover:bg-surface-hover"
    >
      {favicon}
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs text-content">{title}</div>
        {subtitle && <div className="truncate text-[11px] text-content-subtle">{subtitle}</div>}
        {extra}
      </div>
      {ops && <div className="hidden shrink-0 items-center gap-0.5 group-hover:flex">{ops}</div>}
    </div>
  );
}

/** Collapsible tree node: chevron + icon + label header, body only when open.
 *  Multi-open — toggling a sibling never collapses this one. */
function MenuTreeNode({
  icon,
  label,
  trailing,
  open,
  onToggle,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  trailing?: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b border-edge last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-surface-hover"
      >
        <IconChevronRight
          size={12}
          className={cn(
            "shrink-0 text-content-subtle transition-transform",
            open && "rotate-90",
          )}
        />
        <span className="shrink-0 text-content-muted">{icon}</span>
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-content">{label}</span>
        {trailing}
      </button>
      {open && <div className="pb-1">{children}</div>}
    </div>
  );
}

/** Flat action row (top-level actions + the privacy node's entries). */
function MenuActionRow({
  icon,
  label,
  onClick,
  accent,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  accent?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-surface-hover",
        accent ? "text-accent" : "text-content",
      )}
    >
      <span className={cn("shrink-0", accent ? "text-accent" : "text-content-muted")}>{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}

/** Small neutral count pill for tree-node headers. */
function CountPill({ n }: { n: number }) {
  return (
    <span className="shrink-0 rounded-full bg-surface-muted px-1.5 text-[10px] leading-4 text-content-subtle">
      {n}
    </span>
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
  history,
  bookmarks,
  currentBookmarked,
  onToggleBookmark,
  onRemoveBookmark,
  onOpenUrl,
  onOpenUrlNewTab,
  downloads,
  onDownloadOpen,
  onDownloadReveal,
  onClearCache,
  onClearCookies,
  onRemoveHistoryEntry,
  onClearHistory,
  onHistoryMenuOpenChange,
  onMoreMenuOpenChange,
}: BrowserToolbarProps) {
  const { t } = useI18n();
  // Address-history dropdown state. Local because only this input drives it;
  // the parent is only told about open/close so it can freeze the OS-level view.
  const [historyOpen, setHistoryOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  // "More" menu open state. Same freeze contract as above: the parent parks
  // the OS-level view while this is open so the menu floats over the snapshot.
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement | null>(null);

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

  const setMoreMenuOpen = (open: boolean) => {
    setMoreOpen(open);
    onMoreMenuOpenChange(open);
  };

  // Outside pointerdown / Escape closes the More menu (the history dropdown
  // relies on input blur instead — the More trigger isn't focus-coupled).
  useEffect(() => {
    if (!moreOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) {
        setMoreMenuOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMoreMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moreOpen]);

  const pickHistoryEntry = (entry: BrowserHistoryEntry) => {
    setDropdownOpen(false);
    onUrlChange(entry.url);
    onNavigate(entry.url);
  };
  const pickMenuUrl = (entryUrl: string) => {
    setMoreMenuOpen(false);
    onOpenUrl(entryUrl);
  };
  const pickMenuUrlNewTab = (entryUrl: string) => {
    setMoreMenuOpen(false);
    onOpenUrlNewTab(entryUrl);
  };

  // ── More menu (tree) ──
  // Expand/collapse state persists across menu open/close (the toolbar holds
  // it; only the menu body unmounts). Defaults: bookmarks + history open.
  const [openNodes, setOpenNodes] = useState<ReadonlySet<string>>(
    () => new Set(["bookmarks", "history"]),
  );
  const toggleNode = useCallback((id: string) => {
    setOpenNodes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /** History bucketed into 今天 / 昨天 / 更早 by local calendar day (entries
   *  arrive most-recent first; empty buckets dropped). */
  const historyGroups = useMemo(() => {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const todayMs = startOfToday.getTime();
    const buckets: {
      key: "browser.today" | "browser.yesterday" | "browser.earlier";
      entries: BrowserHistoryEntry[];
    }[] = [
      { key: "browser.today", entries: [] },
      { key: "browser.yesterday", entries: [] },
      { key: "browser.earlier", entries: [] },
    ];
    for (const entry of history) {
      if (entry.at >= todayMs) buckets[0].entries.push(entry);
      else if (entry.at >= todayMs - 86_400_000) buckets[1].entries.push(entry);
      else buckets[2].entries.push(entry);
    }
    return buckets.filter((b) => b.entries.length > 0);
  }, [history]);

  const historyTimeLabel = (at: number): string => {
    const d = new Date(at);
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    if (at >= startOfToday.getTime()) {
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    if (at >= startOfToday.getTime() - 86_400_000) return t("browser.yesterday");
    return d.toLocaleDateString([], { month: "numeric", day: "numeric" });
  };

  const activeDownloadCount = downloads.filter((d) => d.state === "progressing").length;
  const downloadStateLabels: Record<DownloadBarItem["state"], string> = {
    progressing: t("browser.downloadStateProgressing"),
    completed: t("browser.downloadStateCompleted"),
    cancelled: t("browser.downloadStateCancelled"),
    interrupted: t("browser.downloadStateInterrupted"),
  };
  return (
    <div className="flex h-11 shrink-0 items-center gap-1 border-b border-edge bg-surface px-2">
      {mode === "overlay" && (
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
          <div className="mx-1 h-5 w-px bg-edge" />
        </>
      )}
      {/* Sidebar: the fullscreen expand moved into the More menu (top item). */}

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

      {/* "More" menu, restructured as a tree: top-level actions + multi-open
          collapsible nodes (bookmarks / history-by-day / downloads / privacy).
          Anchored under the button, right-aligned; floats over the frozen page
          snapshot while open. */}
      <div className="relative" ref={moreRef}>
        <ToolButton
          onClick={() => setMoreMenuOpen(!moreOpen)}
          active={moreOpen}
          title={t("browser.moreMenu")}
        >
          <IconDots size={16} />
        </ToolButton>
        {moreOpen && (
          <div
            className={cn(
              "absolute right-0 top-full z-30 mt-1 flex max-h-[500px] w-[302px] flex-col overflow-hidden",
              "rounded-md border border-edge bg-surface shadow-xl",
            )}
          >
            {/* ── Top-level actions: the bookmark toggle and (sidebar only)
                the fullscreen expand stay one click from the root. ── */}
            <div className="shrink-0 border-b border-edge py-1">
              <MenuActionRow
                accent={currentBookmarked}
                icon={
                  <IconStar size={14} fill={currentBookmarked ? "currentColor" : "none"} />
                }
                label={
                  currentBookmarked
                    ? t("browser.unbookmarkPage")
                    : t("browser.bookmarkPage")
                }
                onClick={onToggleBookmark}
              />
              {mode === "sidebar" && (
                <MenuActionRow
                  icon={<IconArrowsMaximize size={14} />}
                  label={t("browser.expandFullscreen")}
                  onClick={() => {
                    setMoreMenuOpen(false);
                    onSwitchMode();
                  }}
                />
              )}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {/* ── Bookmarks ── */}
              <MenuTreeNode
                open={openNodes.has("bookmarks")}
                onToggle={() => toggleNode("bookmarks")}
                icon={<IconStar size={14} />}
                label={t("browser.bookmarks")}
                trailing={<CountPill n={bookmarks.length} />}
              >
                {bookmarks.length === 0 ? (
                  <div className="py-1.5 pl-[26px] pr-2.5 text-[11px] text-content-subtle">
                    {t("browser.bookmarkEmpty")}
                  </div>
                ) : (
                  bookmarks.map((b) => (
                    <TreeEntryRow
                      key={b.url}
                      favicon={<EntryFavicon url={b.url} />}
                      title={b.title || hostOf(b.url)}
                      subtitle={hostOf(b.url)}
                      openTitle={b.url}
                      onOpen={() => pickMenuUrl(b.url)}
                      ops={
                        <>
                          <RowOpButton
                            title={t("browser.openInNewTab")}
                            onClick={() => pickMenuUrlNewTab(b.url)}
                          >
                            <IconExternalLink size={12} />
                          </RowOpButton>
                          <RowOpButton
                            danger
                            title={t("browser.removeBookmark")}
                            onClick={() => onRemoveBookmark(b.url)}
                          >
                            <IconTrash size={12} />
                          </RowOpButton>
                        </>
                      }
                    />
                  ))
                )}
              </MenuTreeNode>

              {/* ── History, grouped by local calendar day ── */}
              <MenuTreeNode
                open={openNodes.has("history")}
                onToggle={() => toggleNode("history")}
                icon={<IconClock size={14} />}
                label={t("browser.history")}
                trailing={<CountPill n={history.length} />}
              >
                {history.length === 0 ? (
                  <div className="py-1.5 pl-[26px] pr-2.5 text-[11px] text-content-subtle">
                    {t("browser.historyEmpty")}
                  </div>
                ) : (
                  <>
                    {historyGroups.map((group) => (
                      <div key={group.key}>
                        <div className="pb-0.5 pl-[26px] pr-2.5 pt-1 text-[10px] uppercase tracking-wide text-content-subtle">
                          {t(group.key)}
                        </div>
                        {group.entries.map((entry) => (
                          <TreeEntryRow
                            key={entry.url}
                            favicon={<EntryFavicon url={entry.url} />}
                            title={entry.title || hostOf(entry.url)}
                            subtitle={`${hostOf(entry.url)} · ${historyTimeLabel(entry.at)}`}
                            openTitle={entry.url}
                            onOpen={() => pickMenuUrl(entry.url)}
                            ops={
                              <RowOpButton
                                danger
                                title={t("browser.removeHistoryEntry")}
                                onClick={() => onRemoveHistoryEntry(entry.url)}
                              >
                                <IconTrash size={12} />
                              </RowOpButton>
                            }
                          />
                        ))}
                      </div>
                    ))}
                    <div className="pl-[26px] pr-2.5 pt-0.5">
                      <button
                        type="button"
                        onClick={onClearHistory}
                        className="rounded px-1.5 py-0.5 text-[11px] text-content-muted transition-colors hover:bg-surface-hover hover:text-danger"
                      >
                        {t("browser.clearHistory")}
                      </button>
                    </div>
                  </>
                )}
              </MenuTreeNode>

              {/* ── Downloads — only while the session has tracked downloads
                  (same ephemeral list as the bottom bar) ── */}
              {downloads.length > 0 && (
                <MenuTreeNode
                  open={openNodes.has("downloads")}
                  onToggle={() => toggleNode("downloads")}
                  icon={<IconDownload size={14} />}
                  label={t("browser.downloads")}
                  trailing={
                    activeDownloadCount > 0 ? (
                      <span className="flex shrink-0 items-center gap-1 text-[10px] text-amber-500">
                        <IconLoader2 size={10} className="animate-spin" />
                        {t("browser.downloadActive", { n: activeDownloadCount })}
                      </span>
                    ) : (
                      <CountPill n={downloads.length} />
                    )
                  }
                >
                  {downloads.map((d) => {
                    const hasTotal = d.totalBytes > 0;
                    const pct = hasTotal
                      ? Math.min(100, Math.round((d.receivedBytes / d.totalBytes) * 100))
                      : 100;
                    const subtitle =
                      d.state === "progressing"
                        ? `${downloadStateLabels[d.state]} · ${formatBytes(d.receivedBytes)}${
                            hasTotal ? ` / ${formatBytes(d.totalBytes)}` : ""
                          }`
                        : `${downloadStateLabels[d.state]}${
                            d.receivedBytes > 0 ? ` · ${formatBytes(d.receivedBytes)}` : ""
                          }`;
                    return (
                      <TreeEntryRow
                        key={d.downloadId}
                        favicon={<DownloadExtBadge filename={d.filename} />}
                        title={d.filename}
                        subtitle={subtitle}
                        openTitle={d.path}
                        onOpen={() => {
                          if (d.state !== "completed") return;
                          setMoreMenuOpen(false);
                          onDownloadOpen(d.downloadId);
                        }}
                        extra={
                          d.state === "progressing" ? (
                            <div className="mt-1 h-0.5 overflow-hidden rounded-full bg-surface-muted">
                              <div
                                className={cn(
                                  "h-full rounded-full bg-amber-500",
                                  !hasTotal && "animate-pulse",
                                )}
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                          ) : undefined
                        }
                        ops={
                          d.state === "completed" ? (
                            <RowOpButton
                              title={t("browser.downloadRevealFolder")}
                              onClick={() => onDownloadReveal(d.downloadId)}
                            >
                              <IconFolderOpen size={12} />
                            </RowOpButton>
                          ) : undefined
                        }
                      />
                    );
                  })}
                </MenuTreeNode>
              )}

              {/* ── Privacy & cache ── */}
              <MenuTreeNode
                open={openNodes.has("privacy")}
                onToggle={() => toggleNode("privacy")}
                icon={<IconShieldLock size={14} />}
                label={t("browser.privacy")}
              >
                <div className="pl-[14px]">
                  <MenuActionRow
                    icon={<IconTrash size={13} />}
                    label={t("browser.clearCache")}
                    onClick={() => {
                      setMoreMenuOpen(false);
                      onClearCache();
                    }}
                  />
                  <MenuActionRow
                    icon={<IconShieldLock size={13} />}
                    label={t("browser.clearCookies")}
                    onClick={() => {
                      if (!window.confirm(t("browser.clearCookiesConfirm"))) return;
                      setMoreMenuOpen(false);
                      onClearCookies();
                    }}
                  />
                </div>
              </MenuTreeNode>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
