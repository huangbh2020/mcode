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
      {/* Left sidebar — only used by the settings page since the workspace
         moved its full-height sidebar up to App.tsx. Square corners (no
         arcs). bg-surface-muted matches the settings overlay backdrop so the
         nav reads as one continuous block. Its hover/active states use the
         surface-hover family (see LeftBar.tsx), which is clearly visible on
         this muted base. */}
      {leftOpen && (
        <aside
          className="flex h-full shrink-0 flex-col bg-surface-muted"
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
        />
      )}

      {/* Center pane — 3xl arcs on the LEFT edge only (top-left at the
         toolbar/sidebar junction, bottom-left at the track below): the muted
         frame shows through both notches against the pane's bg-surface, so
         the arcs read cleanly. overflow-hidden clips the CONTENT to the same
         rounded rect — without it, square children painted into the notches
         (e.g. the session-tabs strip's translucent bg-surface/40 + its
         border-b, or the bottom-terminal bar) read as a faint square corner
         behind the arc. Non-scrolling overflow-hidden is xterm-safe (see the
         note on the right sidebar).
         Stacks the center content above an optional bottom terminal bar. */}
      <main className="relative z-10 flex min-w-0 flex-1 flex-col overflow-hidden rounded-tl-3xl rounded-bl-3xl border-t border-edge bg-surface">
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
      {/* Right sidebar — square corners (no arcs; the seam with the center
         pane stays a straight edge). Uses bg-surface (same as center pane) so
         it reads as a continuation of the chat area; the border-l below is
         the divider. overflow-hidden (not overflow-y-auto): Files/Git scroll
         internally, and xterm FitAddon breaks under a scrolling ancestor. */}
      {rightOpen && (
        <aside
          className="flex h-full shrink-0 flex-col overflow-hidden border-t border-edge bg-surface"
          style={{ width: rightWidth }}
        >
          <div className="min-h-0 flex-1 overflow-hidden border-l border-edge/60">{right}</div>
        </aside>
      )}
    </>
  );
}
