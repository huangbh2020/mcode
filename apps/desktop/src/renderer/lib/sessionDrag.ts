/** Custom DataTransfer MIME type for the sidebar-session → center split-view
 *  drag. Using a custom type (instead of text/plain) ensures only OUR
 *  session rows trigger a split drop — external text drags and the file-tree
 *  drag (FILE_DRAG_MIME) are ignored by the split drop targets. Mirrors the
 *  file-tree drag's pattern in lib/contentTag.ts; deliberately native HTML5
 *  DnD (not dnd-kit) because the drop targets live outside every
 *  DndContext. */
export const SESSION_DRAG_MIME = "application/x-session-id";

/** Cheap dragover guard: only drags carrying our MIME are ours. */
export function isSessionDrag(types: readonly string[]): boolean {
  return types.includes(SESSION_DRAG_MIME);
}

/** Read a session drag payload; null for drags that aren't ours. */
export function getSessionDragPayload(dt: DataTransfer): string | null {
  const raw = dt.getData(SESSION_DRAG_MIME);
  return raw || null;
}

/** Begin a session row drag: registers the payload AND swaps the browser's
 *  default ghost (a translucent snapshot of the whole row, hover buttons
 *  included) for a compact themed pill — title + provider dot — that follows
 *  the cursor. The ghost element must be in the document when the snapshot
 *  is taken; it parks offscreen and removes itself on drag end (dragend
 *  fires on the SOURCE element, hence the document-level once listeners —
 *  drop is the fallback for drags ending outside the window).
 *
 *  Styling reads the app's CSS variables (space-separated RGB triplets on
 *  :root, overridden per theme) so the snapshot matches light/dark/sketch
 *  whatever the current theme is. */
export function beginSessionDrag(
  e: { dataTransfer: DataTransfer },
  session: { id: string; title: string },
  providerDot?: string,
): void {
  e.dataTransfer.setData(SESSION_DRAG_MIME, session.id);
  e.dataTransfer.effectAllowed = "copy";

  const ghost = document.createElement("div");
  ghost.style.cssText = [
    "position: fixed",
    "top: -1000px",
    "left: -1000px",
    "display: flex",
    "align-items: center",
    "gap: 6px",
    "max-width: 280px",
    "padding: 5px 12px",
    "font-size: 12px",
    "line-height: 18px",
    "font-family: inherit",
    "color: rgb(var(--content))",
    "background: rgb(var(--surface))",
    "border: 1px solid rgb(var(--edge))",
    "border-radius: 9px",
    "box-shadow: 0 1px 2px rgb(0 0 0 / 0.18), 0 8px 24px rgb(0 0 0 / 0.28)",
    "white-space: nowrap",
    "overflow: hidden",
  ].join(";");
  if (providerDot) {
    const dot = document.createElement("span");
    dot.style.cssText = [
      "flex: none",
      "width: 7px",
      "height: 7px",
      "border-radius: 9999px",
      `background: ${providerDot}`,
    ].join(";");
    ghost.appendChild(dot);
  }
  const label = document.createElement("span");
  label.textContent = session.title;
  label.style.cssText = "overflow: hidden; text-overflow: ellipsis;";
  ghost.appendChild(label);
  document.body.appendChild(ghost);

  // Grab the pill slightly above-left of the cursor so it doesn't sit
  // under it; (14, -8) keeps the title readable past the pointer.
  try {
    e.dataTransfer.setDragImage(ghost, 14, 8);
  } catch {
    /* setDragImage can throw on exotic platforms; the default row snapshot
       is an acceptable fallback. */
  }

  const cleanup = () => {
    ghost.remove();
    document.removeEventListener("dragend", cleanup);
    document.removeEventListener("drop", cleanup);
  };
  document.addEventListener("dragend", cleanup);
  document.addEventListener("drop", cleanup);
}
