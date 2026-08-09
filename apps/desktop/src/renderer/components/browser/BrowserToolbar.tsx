import { cn } from "@renderer/lib/cn.js";
import {
  IconArrowLeft,
  IconChevronLeft,
  IconChevronRight,
  IconRefresh,
  IconTarget,
  IconX,
  IconLoader2,
  IconDeviceDesktop,
  IconDeviceMobile,
  IconArrowsMaximize,
  IconArrowsMinimize,
} from "@renderer/lib/icons.js";
import type { BrowserDevicePreset } from "@contracts/ipc";
import type { BrowserMode } from "./BrowserPanel.js";

/**
 * Toolbar for the embedded browser panel. Pure presentational - all state
 * (url, loading, canGoBack/Forward, pickMode, device) is passed in as props,
 * and every action is a callback. Sits at the top of the BrowserPanel overlay;
 * the WebContentsView is positioned below it, so this bar must never be covered
 * by the view.
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
  /** Current device emulation preset (desktop / iphone / android). */
  device: BrowserDevicePreset;
  onUrlChange: (url: string) => void;
  onNavigate: (url: string) => void;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onTogglePickMode: () => void;
  /** Switch the device emulation preset. */
  onDeviceChange: (device: BrowserDevicePreset) => void;
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
  device,
  onUrlChange,
  onNavigate,
  onBack,
  onForward,
  onReload,
  onTogglePickMode,
  onDeviceChange,
  onClose,
  onSwitchMode,
  onRequestDestroy,
}: BrowserToolbarProps) {
  const devices: {
    id: BrowserDevicePreset;
    label: string;
    hint: string;
    icon: React.ReactNode;
  }[] = [
    { id: "desktop", label: "桌面端", hint: "PC 全宽", icon: <IconDeviceDesktop size={14} /> },
    { id: "iphone", label: "iPhone", hint: "390×844", icon: <IconDeviceMobile size={14} /> },
    { id: "android", label: "Android", hint: "412×915", icon: <IconDeviceMobile size={14} /> },
  ];
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

      {/* Device preset selector - inline icon toggle group rendered directly in
          the toolbar (no popover/dropdown). The toolbar strip is NOT covered by
          the OS-level WebContentsView, so these buttons are always clickable.
          Clicking a device icon switches to that preset.
          Sidebar mode hides the selector entirely: the embedded panel is
          fixed at iPhone size by design (new tabs default to iphone), so the
          only place to switch sizes is the PC-fullscreen overlay. */}
      {mode === "overlay" && (
        <div className="flex shrink-0 items-center gap-0.5 rounded-md border border-edge p-0.5">
          {devices.map((d) => (
            <button
              key={d.id}
              type="button"
              title={d.label + " " + d.hint}
              onClick={() => onDeviceChange(d.id)}
              className={cn(
                "flex h-6 w-6 items-center justify-center rounded transition-colors",
                device === d.id
                  ? "bg-accent text-white"
                  : "text-content-muted hover:bg-surface-hover hover:text-content",
              )}
            >
              {d.icon}
            </button>
          ))}
        </div>
      )}

      <div className="mx-1 h-5 w-px bg-edge" />

      <ToolButton onClick={onRequestDestroy} title="关闭浏览器">
        <IconX size={16} />
      </ToolButton>
    </div>
  );
}

