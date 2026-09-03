/**
 * Divider - a draggable splitter handle between two layout panes.
 *
 * Used in ThreePaneLayout (left|center, center|right, center|bottom-terminal)
 * and CenterPane (chat|editor). Hand-rolled with mousedown -> document
 * mousemove/mouseup listeners, matching the codebase's no-library style.
 *
 * Visuals: the visible line is a 1px hairline (`bg-edge-panel` — the lighter
 * structural-divider token; these lines run full window height and read as
 * heavy rules at the darker card-border value) that lights up
 * (`bg-accent/50`) on hover or while dragging - it reads like a border, not a
 * thick bar. The *draggable* hit area, however, is wider: an invisible
 * absolutely-positioned layer extends symmetrically (±5px) beyond the 1px
 * layout slot, so the divider is easy to grab without making the line thicker.
 * The 1px line uses `pointer-events-none` so pointer events pass straight
 * through to the hit area beneath. During a drag, a global `select-none` +
 * fixed cursor is applied to <body> so text selection and cursor flicker
 * don't interfere.
 *
 * The caller owns the sizing math: `onResize(deltaPx)` is called on every
 * mousemove with the signed pixel delta *since the last event* (an incremental
 * delta, not cumulative). The sign convention is screen-space (positive =
 * right / down); the caller decides whether that delta grows or shrinks the
 * pane it controls - e.g. the left-bar divider grows the bar with a positive
 * delta, while the right-bar divider shrinks it. The caller adds the delta
 * to the current store value inside its setter, so it never needs to track a
 * drag-start baseline.
 *
 * For the chat|editor split the delta is reported in px too; the caller
 * converts to a percentage using the container's measured width.
 */
import { useCallback, useRef } from "react";
import { cn } from "@renderer/lib/cn.js";
import { COL_RESIZE_CURSOR, ROW_RESIZE_CURSOR } from "@renderer/lib/cursors.js";

export interface DividerProps {
  /** `vertical` = a tall thin bar between side-by-side panes (cursor:
   *  col-resize). `horizontal` = a wide thin bar between stacked panes
   *  (cursor: row-resize). The naming follows the divider's own shape, not
   *  the drag axis. */
  orientation: "vertical" | "horizontal";
  /** Called on every mousemove during a drag with the signed *incremental*
   *  pixel delta since the last move (positive = rightward / downward).
   *  The caller adds it to the current pane size and clamps. */
  onResize: (deltaPx: number) => void;
  /** Optional double-click handler (e.g. reset to default width). */
  onDoubleClick?: () => void;
  /** Kept for API compatibility but a no-op (the visible 1px line is centered
   *  in the symmetric hit area, so there is nowhere to align within). */
  lineAlign?: "start" | "center" | "end";
  /** Omit the visible 1px hairline while keeping the draggable hit area.
   *  Used where two panes share the same background and a hairline would cut
   *  through a continuous surface (e.g. the workspace's muted frame: sidebar
   *  | toolbar) — resizing stays possible, discovered via the resize cursor. */
  hideLine?: boolean;
  className?: string;
}

export function Divider({
  orientation,
  onResize,
  onDoubleClick,
  hideLine = false,
  className,
}: DividerProps) {
  const dragging = useRef(false);

  const isVertical = orientation === "vertical";

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Only respond to primary button; let right-click through.
      if (e.button !== 0) return;
      e.preventDefault();
      let prev = isVertical ? e.clientX : e.clientY;
      dragging.current = true;

      // Lock the whole document while dragging: fixed cursor, no text
      // selection, no iframe pointer capture issues. Removed on mouseup.
      const prevCursor = document.body.style.cursor;
      const prevSelect = document.body.style.userSelect;
      document.body.style.cursor = isVertical ? COL_RESIZE_CURSOR : ROW_RESIZE_CURSOR;
      document.body.style.userSelect = "none";

      const onMove = (ev: MouseEvent) => {
        if (!dragging.current) return;
        const current = isVertical ? ev.clientX : ev.clientY;
        const delta = current - prev;
        prev = current;
        if (delta !== 0) onResize(delta);
      };
      const onUp = () => {
        dragging.current = false;
        document.body.style.cursor = prevCursor;
        document.body.style.userSelect = prevSelect;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [isVertical, onResize],
  );

  // Two-layer structure:
  //  - Outer slot: still occupies a 1px layout gutter (w-px / h-px) so it
  //    doesn't shift pane sizes. It is `relative` so the inner layers can be
  //    absolutely positioned relative to it.
  //  - Hit area: an invisible layer expanding symmetrically (±5px) beyond the
  //    1px slot, providing a wide grab target. It carries the mouse handlers
  //    and the cursor. `z-0` keeps it beneath the line but still clickable
  //    (the line is pointer-events-none).
  //  - Line: the 1px visible hairline, centered over the slot and stretching
  //    across the full length. pointer-events-none so it never steals the
  //    grab from the hit area; it only lights up via group-hover/active.
  return (
    <div
      role="separator"
      aria-orientation={isVertical ? "vertical" : "horizontal"}
      className={cn(
        "group/divider relative z-10 shrink-0",
        isVertical ? "w-px" : "h-px",
        className,
      )}
    >
      {/* Draggable hit area - wider than the visible line. Cursor uses the
          explicit SVG resize cursors (lib/cursors.ts), NOT `cursor-col-resize`:
          Chromium may swap in a white variant of the system cursor when the
          window is flagged dark, which vanishes on the light theme. */}
      <div
        onMouseDown={handleMouseDown}
        onDoubleClick={onDoubleClick}
        style={{ cursor: isVertical ? COL_RESIZE_CURSOR : ROW_RESIZE_CURSOR }}
        className={cn(
          "absolute z-0",
          isVertical
            ? "inset-y-0 -left-[5px] -right-[5px]"
            : "inset-x-0 -top-[5px] -bottom-[5px]",
        )}
      />
      {/* Visible 1px hairline - pointer-events-none so the hit area stays the
          grab target. Lights up on hover/active via group-hover/active.
          Skipped entirely when `hideLine` is set (invisible splitter). */}
      {!hideLine && (
        <div
          className={cn(
            "pointer-events-none absolute inset-0 bg-edge-panel transition-colors group-hover/divider:bg-accent/50 group-active/divider:bg-accent/70",
            isVertical ? "w-px left-0" : "h-px top-0",
          )}
        />
      )}
    </div>
  );
}
