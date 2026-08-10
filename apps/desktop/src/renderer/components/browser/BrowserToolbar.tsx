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
} from "@renderer/lib/icons.js";
import type { BrowserMode } from "./BrowserPanel.js";

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
}: BrowserToolbarProps) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-1 border-b border-edge bg-surface px-2">
      {mode === "overlay" ? (
        <>
          {/* Overlay: "返回工作台" leaves the fullscreen overlay (views stay
              alive). Visually distinct (accent on hover) so the user sees how
              to exit. */}
          <ToolButton onClick={onClose} title="返回工作台">
            <IconArrowLeft size={16} />
          </ToolButton>
          {/* Switch to the embedded sidebar (mobile column). */}
          <ToolButton onClick={onSwitchMode} title="切换到侧边栏">
            <IconArrowsMinimize size={16} />
          </ToolButton>
        </>
      ) : (
        /* Sidebar: "展开为 PC 全屏" swaps to the fullscreen overlay. The
           sidebar has no "close" button here — closing is via the rail icon
           toggle or the 关闭浏览器 button on the right. */
        <ToolButton onClick={onSwitchMode} title="展开为 PC 全屏">
          <IconArrowsMaximize size={16} />
        </ToolButton>
      )}

      <div className="mx-1 h-5 w-px bg-edge" />

      <ToolButton onClick={onBack} disabled={!canGoBack} title="后退">
        <IconChevronLeft size={18} />
      </ToolButton>
      <ToolButton onClick={onForward} disabled={!canGoForward} title="前进">
        <IconChevronRight size={18} />
      </ToolButton>
      <ToolButton onClick={onReload} title="刷新">
        {loading ? (
          <IconLoader2 size={16} className="animate-spin" />
        ) : (
          <IconRefresh size={16} />
        )}
      </ToolButton>

      {/* Address bar - Enter navigates. Controlled by the parent so navigation
          events can update it. */}
      <input
        type="text"
        value={url}
        onChange={(e) => onUrlChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onNavigate(url);
          }
        }}
        placeholder="输入网址或搜索…"
        spellCheck={false}
        className={cn(
          "mx-1 h-7 min-w-0 flex-1 rounded-md border border-edge bg-surface-muted px-2.5",
          "text-[13px] text-content placeholder:text-content-subtle",
          "focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/40",
        )}
      />

      {/* Element picker toggle. Accent when active. */}
      <ToolButton onClick={onTogglePickMode} active={pickMode} title={pickMode ? "退出元素选择" : "选择页面元素"}>
        <IconTarget size={16} />
      </ToolButton>

      {/* Device-toolbar toggle — the "Toggle device toolbar" equivalent. Shows
          the DevTools-style row (device dropdown + custom dims + rotate) under
          the address bar. Accent when open. */}
      <ToolButton
        onClick={onToggleDeviceToolbar}
        active={deviceToolbarOpen}
        title={deviceToolbarOpen ? "收起设备工具栏" : "设备工具栏 (切换尺寸)"}
      >
        <IconDeviceMobile size={16} />
      </ToolButton>

      <div className="mx-1 h-5 w-px bg-edge" />

      <ToolButton onClick={onRequestDestroy} title="关闭浏览器">
        <IconX size={16} />
      </ToolButton>
    </div>
  );
}
