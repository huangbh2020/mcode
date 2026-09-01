import { useMemo, useRef } from "react";

/** VirtualElement anchor for base-ui's `Menu.Positioner`, pinned to the
 * cursor coords where the user right-clicked (base-ui's ContextMenu.Trigger
 * anchors to the element edge, not the cursor).
 *
 * Keeps the last non-null coordinates while the menu state is cleared: the
 * closing popup stays mounted through its exit transition and re-measures
 * against this anchor — collapsing to (0,0) would make it flash at the
 * top-left corner before unmounting. */
export function useCursorAnchor(ctxMenu: { x: number; y: number } | null) {
  const lastPosRef = useRef({ x: 0, y: 0 });
  if (ctxMenu) {
    lastPosRef.current = { x: ctxMenu.x, y: ctxMenu.y };
  }
  const { x, y } = ctxMenu ?? lastPosRef.current;
  return useMemo(
    () => ({
      getBoundingClientRect: () => ({
        x,
        y,
        top: y,
        left: x,
        bottom: y,
        right: x,
        width: 0,
        height: 0,
        toJSON: () => ({}),
      }),
    }),
    [x, y],
  );
}
