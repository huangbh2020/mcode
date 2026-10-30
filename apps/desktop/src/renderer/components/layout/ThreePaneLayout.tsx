import { useState, type ReactNode } from "react";
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
  /** Right panel is maximized to fill the workspace below titlebar. */
  rightMaximized?: boolean;
  /** Wide-panel mode: the right panel's share as a percentage of the layout
   *  row. When set it overrides rightWidth — wide mode keeps the SAME
   *  RightPanel instance in this aside (no unmount/remount) and only
   *  re-shapes it; the onResize/onReset callbacks switch to the wide split's
   *  percentage-based handlers. */
  rightWidthPct?: number;
  /** Right-panel hover-peek drawer mode (mirror of the left aside's in
   *  App.tsx): when true and rightOpen=false, the aside renders as a fixed
   *  overlay parked at translate-x-full instead of display:none — still
   *  mounted (TerminalPanel keep-alive), summoned from the window's right
   *  edge. Left unset/false (settings page) keeps the classic hidden behavior. */
  rightPeekDrawer?: boolean;
  /** Whether the drawer's transform transition is armed (two frames after
   *  entering drawer mode — see the leftDrawerArmed effect in App.tsx; the
   *  same park-then-arm dance). */
  rightPeekArmed?: boolean;
  /** Whether the drawer is currently slid in over the workspace. */
  rightPeekOpen?: boolean;
  /** Grace-close wiring for the peeked drawer: re-entering cancels the
   *  pending dismissal, leaving schedules it (usePeekAutoClose in App.tsx). */
  onRightPeekMouseEnter?: () => void;
  onRightPeekMouseLeave?: () => void;
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
  rightMaximized = false,
  rightWidthPct,
  rightPeekDrawer = false,
  rightPeekArmed,
  rightPeekOpen,
  onRightPeekMouseEnter,
  onRightPeekMouseLeave,
  bottomTerminalHeight,
  onResizeLeft,
  onResizeRight,
  onResizeBottomTerminal,
  onResetLeft,
  onResetRight,
  onResetBottomTerminal,
}: Props) {
  const [isDraggingRight, setIsDraggingRight] = useState(false);

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

      {/* Center pane — 2xl arcs on the LEFT edge only (top-left at the
         toolbar/sidebar junction, bottom-left at the track below): the muted
         frame shows through both notches against the pane's bg-surface, so
         the arcs read cleanly. overflow-hidden clips the CONTENT to the same
         rounded rect — without it, square children painted into the notches
         (e.g. the session-tabs strip's translucent bg-surface/40 + its
         border-b, or the bottom-terminal bar) read as a faint square corner
         behind the arc. Non-scrolling overflow-hidden is xterm-safe (see the
         note on the right sidebar).
         Stacks the center content above an optional bottom terminal bar. */}
      <main
        className={cn(
          "relative z-10 flex min-w-[600px] shrink-0 flex-1 flex-col overflow-hidden rounded-tl-2xl rounded-bl-2xl border-t border-edge-panel bg-surface",
          rightMaximized && "hidden",
        )}
      >

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
                "shrink-0 overflow-hidden border-edge-panel transition-[height] duration-150 ease-out",
                bottomTerminalOpen ? "border-t" : "h-0",
              )}
              style={bottomTerminalOpen ? { height: bottomTerminalHeight } : undefined}
            >
              {bottomTerminal}
            </div>
          </>
        )}
      </main>

      {rightOpen && !rightMaximized && onResizeRight && (
        <Divider
          orientation="vertical"
          onResize={onResizeRight}
          onDoubleClick={onResetRight}
          onDragStart={() => setIsDraggingRight(true)}
          onDragEnd={() => setIsDraggingRight(false)}
        />
      )}
      {/* Right sidebar — square corners (no arcs; the seam with the center
         pane stays a straight edge). Uses bg-surface (same as center pane) so
         it reads as a continuation of the chat area; the border-l below is
         the divider. overflow-hidden (not overflow-y-auto): Files/Git scroll
         internally, and xterm FitAddon breaks under a scrolling ancestor.
         Kept mounted via CSS `hidden` when closed so stateful children like
         TerminalPanel (PTYs and scrollback) survive toggling the sidebar.

         Drawer mode (rightPeekDrawer, workspace only): the same element
         re-parents to a fixed overlay parked at translate-x-full — the right
         mirror of App.tsx's left drawer. Opening the peek glides it in over
         the workspace with a left-cast shadow while the scrim below dims the
         content. The inner border-l is dropped here: the drawer's own
         border-l replaces it (two stacked hairlines would read 2px). */}
      {right && (
        <aside
          onMouseEnter={rightPeekDrawer && rightPeekOpen ? onRightPeekMouseEnter : undefined}
          // Explicit no-arg call: React passes the MouseEvent as the first
          // argument, and schedule's optional ms-override parameter would
          // swallow it as a grace duration.
          onMouseLeave={
            rightPeekDrawer && rightPeekOpen ? () => onRightPeekMouseLeave?.() : undefined
          }
          className={cn(
            "flex h-full min-w-0 shrink flex-col overflow-hidden bg-surface",
            rightPeekDrawer
              ? cn(
                  // Drawer mode: fixed overlay parked off-canvas; the peek
                  // slides it in over the workspace (z-[45], under the z-50
                  // dialogs). Unlike the left drawer it stops below the
                  // titlebar (its home region): the panel's top rail has
                  // interactive controls at its far right, and on Windows
                  // the native min/max/close overlay that zone — a
                  // full-height drawer would park them under the OS buttons.
                  // h-full (base) → h-auto: top/bottom insets stretch it.
                  "fixed right-0 top-10 bottom-0 z-[45] h-auto shrink-0 rounded-l-2xl border-l border-edge-panel/60",
                  rightPeekArmed &&
                    "transition-[transform,opacity,box-shadow] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]",
                  rightPeekOpen
                    ? "pointer-events-auto translate-x-0 opacity-100 shadow-[-12px_0_48px_-12px_rgba(0,0,0,0.45)]"
                    : "pointer-events-none translate-x-full opacity-0",
                )
              : cn(
                  "border-t border-edge-panel",
                  !rightOpen && "hidden",
                  rightMaximized && "w-full flex-1",
                  !isDraggingRight && "transition-[width] duration-200 ease-out",
                ),
          )}
          style={{
            width: rightMaximized
              ? "100%"
              : rightWidthPct !== undefined
                ? `${rightWidthPct}%`
                : rightWidth,
          }}
        >
          <div
            className={cn(
              "min-h-0 flex-1 overflow-hidden",
              !rightPeekDrawer && !rightMaximized && "border-l border-edge-panel",
            )}
          >
            {right}
          </div>
        </aside>
      )}
    </>
  );
}

