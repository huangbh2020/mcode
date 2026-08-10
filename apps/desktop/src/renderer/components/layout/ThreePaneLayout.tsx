import { type ReactNode } from "react";
import { cn } from "@renderer/lib/cn.js";
import { Divider } from "./Divider.js";

interface Props {
  left: ReactNode;
  center: ReactNode;
  right: ReactNode;
  leftOpen: boolean;
  rightOpen: boolean;
  /** Bottom-bar terminal node (keep-alive: always mounted). */
  bottomTerminal?: ReactNode;
  /** Whether the bottom terminal bar is expanded. When false the bar collapses
   *  to height 0 but stays mounted so PTYs survive — see App.tsx. */
  bottomTerminalOpen?: boolean;
  /** Draggable pane sizes (px) + incremental resize callbacks. Widths come
   *  from the store so they persist; the Divider reports a signed px delta on
   *  each mousemove and the store action clamps + debounces the DB write.
   *  Optional — SettingsPage reuses this shell without drag handles. */
  leftWidth?: number;
  rightWidth?: number;
  bottomTerminalHeight?: number;
  onResizeLeft?: (deltaPx: number) => void;
  onResizeRight?: (deltaPx: number) => void;
  onResizeBottomTerminal?: (deltaPx: number) => void;
  onResetLeft?: () => void;
  onResetRight?: () => void;
  onResetBottomTerminal?: () => void;
}

/** Resizable three-pane shell: left | center | right, with a collapsible
 * bottom terminal bar inside the center pane.
 *
 * Each side pane and the bottom bar have a draggable Divider handle. The
 * widths/height are driven by store state (persisted); the Divider reports
 * an incremental px delta that the store action applies + clamps.
 *
 * Side panes unmount when closed (conditional render), so their dividers
 * render only when the pane is open. The bottom terminal uses keep-alive
 * (always mounted, height collapses to 0) — its divider renders only while
 * expanded.
 *
 * overflow-hidden is preserved on xterm ancestors (FitAddon breaks under a
 * scrolling ancestor) — do not change those to overflow-y-auto. */
export function ThreePaneLayout({
  left,
  center,
  right,
  leftOpen,
  rightOpen,
  bottomTerminal,
  bottomTerminalOpen = false,
  leftWidth,
  rightWidth,
  bottomTerminalHeight,
  onResizeLeft,
  onResizeRight,
  onResizeBottomTerminal,
  onResetLeft,
  onResetRight,
  onResetBottomTerminal,
}: Props) {
  return (
    <>
      {/* Left sidebar — plain rectangle (no corner rounding). The right
         divider lives on the inner scroll container so it spans the panel.
         bg-surface-muted matches the titlebar's left strip (Titlebar.tsx) and
         the row track, so the sidebar reads as one continuous block running
         to the top of the window. Its hover/active states use the
         surface-hover family (see LeftBar.tsx), which is clearly visible on
         this muted base. */}
      {leftOpen && (
        <aside
          className="flex h-full shrink-0 flex-col rounded-r-lg bg-surface-muted"
          style={{ width: leftWidth }}
        >
          <div className="min-h-0 flex-1 overflow-y-auto">{left}</div>
        </aside>
      )}
      {leftOpen && onResizeLeft && (
        <Divider
          orientation="vertical"
          onResize={onResizeLeft}
          onDoubleClick={onResetLeft}
          // The divider is a 1px line flush at x=leftWidth, naturally aligned
          // with the titlebar's border-r above (also at x=leftWidth).
        />
      )}

      {/* Center pane — rounded bottom-left corner creates a soft arc where it
         meets the left sidebar at the bottom edge, echoing the titlebar's
         top-left radius. Visible because the track (bg-surface-muted) shows
         through the notch against the pane's bg-surface.
         `relative z-10` + --panel-shadow make the pane read as an elevated
         surface floating over the muted track (the shadow would otherwise be
         painted over by the later right sidebar).
         Stacks the center content above an optional bottom terminal bar. */}
      <main className="relative z-10 flex min-w-0 flex-1 flex-col rounded-bl-lg border-t border-edge bg-surface shadow-[var(--panel-shadow)]">
        <div className="min-h-0 flex-1 overflow-hidden">{center}</div>
        {/* Bottom terminal bar — keep-alive: always rendered, height collapses
            to 0 when closed so PTYs/scrollback survive. overflow-hidden clips
            the xterm host at height 0 (xterm FitAddon breaks under a scrolling
            ancestor, but a fixed-height non-scrolling box is fine). */}
        {bottomTerminal && (
          <>
            {bottomTerminalOpen && onResizeBottomTerminal && (
              <Divider
                orientation="horizontal"
                onResize={onResizeBottomTerminal}
                onDoubleClick={onResetBottomTerminal}
              />
            )}
            <div
              className={cn(
                "shrink-0 overflow-hidden border-edge transition-[height] duration-150 ease-out",
                bottomTerminalOpen ? "border-t" : "h-0",
              )}
              style={bottomTerminalOpen ? { height: bottomTerminalHeight } : undefined}
            >
              {bottomTerminal}
            </div>
          </>
        )}
      </main>

      {rightOpen && onResizeRight && (
        <Divider
          orientation="vertical"
          onResize={onResizeRight}
          onDoubleClick={onResetRight}
        />
      )}
      {/* Right sidebar — plain rectangle (no corner rounding). Uses
         bg-surface (same as center pane) so it reads as a continuation of the
         chat area; the border-l below is the divider. overflow-hidden (not
         overflow-y-auto): Files/Git scroll internally, and xterm FitAddon
         breaks under a scrolling ancestor. */}
      {rightOpen && (
        <aside
          className="flex h-full shrink-0 flex-col border-t border-edge bg-surface"
          style={{ width: rightWidth }}
        >
          <div className="min-h-0 flex-1 overflow-hidden border-l border-edge/60">{right}</div>
        </aside>
      )}
    </>
  );
}
