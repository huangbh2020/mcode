/**
 * High-visibility resize cursors for panel splitters.
 *
 * Why not plain `cursor: col-resize` / `row-resize`: Chromium on Windows swaps
 * in a WHITE variant of the system resize cursors when it considers the window
 * dark (OS dark mode, or a stale dark flag after the startup theme flip). On a
 * light-themed UI the white arrows blend into the background and the cursor
 * becomes invisible (upstream: issues.chromium.org/40239916, VS Code #204103).
 *
 * The fix: explicit SVG cursors — black arrows with a white outline — that read
 * on ANY background, in both themes, regardless of which variant Chromium
 * would have picked. Hotspot (16,16) = the arrow pair's midpoint, matching
 * where the OS cursor points. Fallback keyword keeps native behavior if the
 * data URI ever fails to load. 32x32 = the logical size of Windows system
 * cursors, so the scale matches what users expect.
 */

/** Double-headed horizontal arrow — `col-resize` replacement. */
export const COL_RESIZE_CURSOR = `url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32' viewBox='0 0 32 32'><g fill='%23000' stroke='%23fff' stroke-width='2' stroke-linejoin='round'><path d='M4 16 L14 10 L14 22 Z'/><path d='M28 16 L18 10 L18 22 Z'/></g></svg>") 16 16, col-resize`;

/** Double-headed vertical arrow — `row-resize` replacement. */
export const ROW_RESIZE_CURSOR = `url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32' viewBox='0 0 32 32'><g fill='%23000' stroke='%23fff' stroke-width='2' stroke-linejoin='round'><path d='M16 4 L10 14 L22 14 Z'/><path d='M16 28 L10 18 L22 18 Z'/></g></svg>") 16 16, row-resize`;
