import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  DndContext,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Menu } from "@base-ui/react/menu";
import { basename } from "@renderer/lib/path.js";
import { cn } from "@renderer/lib/cn.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import {
  IconClipboard,
  IconX,
  IconMessage,
  IconCopy,
  IconStack2,
} from "@renderer/lib/icons.js";
import { FileTypeIcon } from "@renderer/lib/fileIcon.js";
import { TabBarChevronButton, TabBarOverflowMenu } from "../layout/TabBarChrome.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useCursorAnchor } from "@renderer/hooks/useCursorAnchor.js";

/** Stable empty array so the selector never returns a fresh [] (Zustand
 *  Object.is rule — a new [] every render causes an infinite loop). */
const EMPTY_OPEN_FILES: string[] = [];

/** Synthetic key for the plan tab in the tabNodes registry. Used so the
 *  scroll-into-view logic can target the plan tab the same way it targets
 *  file tabs (which are keyed by their file path). Exported for the
 *  unified tab bar, which registers its plan tab the same way. */
export const PLAN_TAB_KEY = "__plan__";

/** Shared menu styling constants - match FileTree's context menu for visual
 *  consistency across all right-click menus in the app. */
const MENU_POPUP_CLASS = cn(
  "z-50 min-w-[180px] rounded-md border border-edge bg-surface py-1 shadow-2xl",
  "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
  "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
  "transition-[transform,opacity] duration-100",
);
const MENU_ITEM_CLASS =
  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-content-muted outline-none select-none data-[highlighted]:bg-surface-muted";

/**
 * Open-tabs bar — the horizontal strip of open files above the Monaco editor,
 * analogous to an editor's tab bar. Each tab shows the file's base name;
 * clicking activates it, the × closes it.
 *
 * Interaction model mirrors the session tabs (SessionTabs) — VS Code /
 * browser-style tab bar:
 *   - Drag a tab to reorder it (via @dnd-kit; a 6px activation distance
 *     distinguishes a drag from a click).
 *   - When tabs overflow, left/right chevron buttons scroll the strip; the
 *     mouse wheel is also translated to horizontal scroll. The native
 *     scrollbar is hidden (`no-scrollbar`); edge fades hint at more content.
 *   - A `⋯` menu on the right lists every tab for quick jumping when the
 *     strip overflows.
 *   - Middle-click on a tab closes it (except unsaved files — same rule as
 *     the × button, which is hidden while dirty).
 *
 * Dirty state (unsaved edits) is tracked inside FileEditor and surfaced here
 * via a per-file dirty map kept in a module-level store subscription. To keep
 * this simple and avoid plumbing dirty state through the global store, the
 * FileEditor reports dirty changes through a lightweight event the bar
 * subscribes to — see `ideDirtyTracker`.
 */
export function OpenTabsBar() {
  const { t } = useI18n();
  // Open files are scoped to the active project — switching projects swaps
  // the tab bar to that project's open files.
  const pid = useSessionStore((s) => s.activeProjectId);
  const openFiles = useSessionStore((s) =>
    pid ? s.ideOpenFilesByProject[pid] ?? EMPTY_OPEN_FILES : EMPTY_OPEN_FILES,
  );
  const activeFile = useSessionStore((s) =>
    pid ? s.ideActiveFileByProject[pid] ?? null : null,
  );
  const setActive = useSessionStore((s) => s.setIdeActiveFile);
  const close = useSessionStore((s) => s.closeFileInIde);
  const closeOthers = useSessionStore((s) => s.closeOtherFilesInIde);
  const closeAll = useSessionStore((s) => s.closeAllFilesInIde);
  const reorderFile = useSessionStore((s) => s.reorderIdeFile);
  const clearIdeActiveFile = useSessionStore((s) => s.clearIdeActiveFile);
  const enqueueChatFile = useSessionStore((s) => s.enqueueChatFile);
  const dirtySet = useDirtyFiles();

  // Right-click context menu state: which file + cursor position. null =
  // menu closed. Lifted to the bar level (single Menu) rather than per-tab
  // to avoid conflicts with dnd-kit listeners on each tab.
  const [ctxMenu, setCtxMenu] = useState<{ path: string; x: number; y: number } | null>(null);

  // Plan tab: shown alongside file tabs when a plan has been opened for
  // viewing. The plan state is per-session (keyed by activeSessionId), while
  // file tabs are per-project - they coexist in the same tab bar.
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const planText = useSessionStore(
    (s) => (activeSessionId ? s.planDrawerPlanBySession[activeSessionId] ?? null : null),
  );
  const planTabActive = useSessionStore(
    (s) => (activeSessionId ? s.planTabActiveBySession[activeSessionId] ?? false : false),
  );
  const setPlanTabActive = useSessionStore((s) => s.setPlanTabActive);
  const closePlanDrawer = useSessionStore((s) => s.closePlanDrawer);
  const hasPlanTab = !!planText;

  const scrollRef = useRef<HTMLDivElement>(null);
  // Maps a tab path → its DOM node, used to scrollIntoView the active tab.
  const tabNodes = useRef<Map<string, HTMLDivElement>>(new Map());
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const recomputeScrollState = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // 1px tolerance to avoid float-rounding flakiness at the right edge.
    setCanScrollLeft(el.scrollLeft > 0);
    setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 1);
  }, []);

  // Keep scroll-boundary state fresh on mount, on tab add/remove, and on
  // container resize. (Scroll position itself is tracked by onScroll.)
  useEffect(() => {
    recomputeScrollState();
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => recomputeScrollState());
    ro.observe(el);
    return () => ro.disconnect();
  }, [openFiles.length, recomputeScrollState]);

  // Scroll the active tab FULLY into view whenever it changes - so selecting
  // a background tab or opening a new one never leaves its close button
  // clipped. Works for BOTH file tabs (keyed by path) and the plan tab (keyed
  // by PLAN_TAB_KEY). We use a double-rAF (two frames) to ensure the DOM has
  // fully settled: the first frame lets React commit the new active-state
  // classes (which change the tab width via min-w), the second frame lets the
  // browser lay out at the new width before we measure. getBoundingClientRect
  // gives viewport-accurate positions regardless of offsetParent nesting. A
  // small right-edge buffer keeps the close button clear of the fade gradient.
  const activeTabKey = planTabActive ? PLAN_TAB_KEY : activeFile;
  useEffect(() => {
    if (!activeTabKey) return;
    let raf1 = 0;
    let raf2 = 0;
    let t = 0;
    const scrollTabFullyIntoView = () => {
      const node = tabNodes.current.get(activeTabKey);
      const el = scrollRef.current;
      if (!node || !el) return;
      const nodeRect = node.getBoundingClientRect();
      const viewRect = el.getBoundingClientRect();
      const BUFFER = 10; // px - keep the close button clear of the edge fade
      if (nodeRect.left < viewRect.left + 1) {
        // Left edge clipped - scroll left to reveal the whole tab.
        el.scrollBy({ left: nodeRect.left - viewRect.left - 2, behavior: "smooth" });
      } else if (nodeRect.right > viewRect.right - BUFFER) {
        // Right edge (close button) clipped or under the fade - scroll right.
        el.scrollBy({ left: nodeRect.right - viewRect.right + BUFFER, behavior: "smooth" });
      }
    };
    const doScroll = () => {
      scrollTabFullyIntoView();
      // Re-check after the smooth scroll settles (~280ms) in case the layout
      // shifted during the animation (e.g. a sibling tab width changed).
      t = window.setTimeout(() => {
        scrollTabFullyIntoView();
        recomputeScrollState();
      }, 280);
    };
    // Double rAF: frame 1 = React commit + class application, frame 2 = layout.
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(doScroll);
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      if (t) clearTimeout(t);
    };
  }, [activeTabKey, openFiles.length, hasPlanTab, recomputeScrollState]);

  const scrollByPage = useCallback((dir: 1 | -1) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: "smooth" });
  }, []);

  const onWheel = useCallback((e: React.WheelEvent) => {
    // Translate vertical wheel into horizontal scroll so a plain mouse
    // wheel can navigate the strip. Trackpad horizontal is already deltaX.
    const el = scrollRef.current;
    if (!el) return;
    if (e.deltaY !== 0 && e.deltaX === 0) {
      el.scrollLeft += e.deltaY;
    }
  }, []);

  // ── Drag-and-drop (reorder) ──────────────────────────────────────────
  // A 6px movement activates a drag; anything less is treated as a click
  // (so tapping a tab to select it still works). Touch gets a slightly
  // longer delay so a scroll gesture isn't hijacked.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 120, tolerance: 8 },
    }),
  );

  const onDragEnd = useCallback(
    (e: DragEndEvent) => {
      const { active, over } = e;
      if (!over || active.id === over.id) return;
      const from = openFiles.indexOf(String(active.id));
      const to = openFiles.indexOf(String(over.id));
      if (from === -1 || to === -1) return;
      reorderFile(from, to);
    },
    [openFiles, reorderFile],
  );

  if (openFiles.length === 0 && !hasPlanTab) return null;
  const overflowing = canScrollLeft || canScrollRight;

  return (
    <div className="flex shrink-0 items-center gap-0.5 border-b border-edge bg-surface/40 px-2 py-1.5">
      {/* Left chevron — only when there's content scrolled off the left edge. */}
      {canScrollLeft && (
        <TabBarChevronButton
          dir="left"
          onClick={() => scrollByPage(-1)}
          title={t("ide.editor.scrollTabsLeft")}
        />
      )}

      {/* Scrollable tab track. The native scrollbar is hidden; navigation
          is via chevrons + wheel + drag. Edge fades on either side hint at
          overflow. */}
      <div className="relative min-w-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={recomputeScrollState}
          onWheel={onWheel}
          className="no-scrollbar flex items-center gap-0.5 overflow-x-auto"
        >
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={onDragEnd}
          >
            <SortableContext
              items={openFiles}
              strategy={horizontalListSortingStrategy}
            >
              {openFiles.map((path) => (
                <SortableFileTab
                  key={path}
                  path={path}
                  isActive={path === activeFile && !planTabActive}
                  dirty={dirtySet.has(path)}
                  registerNode={(node) => {
                    if (node) tabNodes.current.set(path, node);
                    else tabNodes.current.delete(path);
                  }}
                  onActivate={() => {
                    setActive(path);
                    // Deactivate the plan tab so the file tab takes focus.
                    if (activeSessionId && planTabActive) {
                      setPlanTabActive(activeSessionId, false);
                    }
                  }}
                  onClose={() => close(path)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setCtxMenu({ path, x: e.clientX, y: e.clientY });
                  }}
                />
              ))}
            </SortableContext>
          </DndContext>

          {/* Plan tab - not draggable, sits after the file tabs. Clicking
              activates the plan view (clears activeFile, sets planTabActive);
              the × closes the plan tab entirely. */}
          {hasPlanTab && (
            <div
              ref={(node) => {
                if (node) tabNodes.current.set(PLAN_TAB_KEY, node);
                else tabNodes.current.delete(PLAN_TAB_KEY);
              }}
              role="tab"
              aria-selected={planTabActive}
              title={t("ide.editor.viewPlan")}
              onClick={() => {
                if (activeSessionId) {
                  clearIdeActiveFile();
                  setPlanTabActive(activeSessionId, true);
                }
              }}
              className={cn(
                // Matches the file-tab chip look (rounded-md + resting bg) —
                // the plan view is an editor-kind tab.
                "group flex min-w-0 shrink-0 cursor-pointer select-none items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] transition-colors",
                // Same state-independent width cap as file tabs — activation
                // never changes the tab's width.
                "max-w-[160px]",
                planTabActive
                  ? "bg-accent/15 text-content ring-1 ring-inset ring-accent/40 dark:text-accent"
                  : "bg-surface-muted/60 text-content-muted hover:bg-surface-hover/70 hover:text-content",
              )}
            >
              <IconClipboard size={12} className="shrink-0 text-accent" />
              <span className="min-w-0 flex-1 truncate">{t("ide.editor.planTab")}</span>
              <button
                type="button"
                aria-label={t("ide.editor.closePlanTabAria")}
                onClick={(e) => {
                  e.stopPropagation();
                  if (activeSessionId) closePlanDrawer(activeSessionId);
                }}
                onPointerDown={(e) => e.stopPropagation()}
                className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-content-subtle opacity-0 transition-opacity hover:bg-surface-hover hover:text-content group-hover:opacity-100 data-[active=true]:opacity-100"
                data-active={planTabActive}
                title={t("common.close")}
              >
                <IconX size={10} />
              </button>
            </div>
          )}
        </div>

        {/* Edge fades — overlay only, pointer-events disabled so they never
            intercept tab clicks. Shown per-direction based on scroll state. */}
        {canScrollLeft && (
          <div className="pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r from-surface to-transparent" />
        )}
        {canScrollRight && (
          <div className="pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-surface to-transparent" />
        )}
      </div>

      {/* Right chevron — only when there's content scrolled off the right edge. */}
      {canScrollRight && (
        <TabBarChevronButton
          dir="right"
          onClick={() => scrollByPage(1)}
          title={t("ide.editor.scrollTabsRight")}
        />
      )}

      {/* Overflow menu — lists every open file for quick jumping. Only shown
          when the strip actually overflows (otherwise it's pure noise). */}
      {overflowing && (
        <TabBarOverflowMenu
          heading={t("ide.editor.openFiles")}
          items={[
            ...openFiles.map((path) => ({
              key: path,
              label: basename(path),
              title: path,
              active: path === activeFile && !planTabActive,
              dotClass: dirtySet.has(path) ? "bg-accent animate-pulse" : undefined,
            })),
            ...(hasPlanTab ? [{
              key: "__plan__",
              label: t("ide.editor.planTab"),
              title: t("ide.editor.viewPlan"),
              active: planTabActive,
              dotClass: undefined as string | undefined,
            }] : []),
          ]}
          onSelect={(key) => {
            if (key === "__plan__") {
              if (activeSessionId) {
                clearIdeActiveFile();
                setPlanTabActive(activeSessionId, true);
              }
            } else {
              setActive(key);
              if (activeSessionId && planTabActive) {
                setPlanTabActive(activeSessionId, false);
              }
            }
          }}
        />
      )}

      {/* Right-click context menu for file tabs. Controlled + cursor-anchored
          (Pattern B from LeftBar) so it opens exactly at the cursor position,
          and doesn't conflict with dnd-kit listeners on the tab. */}
      <FileTabContextMenu
        ctxMenu={ctxMenu}
        onClose={() => setCtxMenu(null)}
        actions={{
          close: (p) => close(p),
          closeOthers: (p) => closeOthers(p),
          closeAll: () => closeAll(),
          activate: (p) => setActive(p),
          addToChat: (p) => enqueueChatFile(p),
        }}
      />
    </div>
  );
}

interface SortableFileTabProps {
  path: string;
  isActive: boolean;
  dirty: boolean;
  registerNode: (node: HTMLDivElement | null) => void;
  onActivate: () => void;
  onClose: () => void;
  /** Right-click handler: opens the context menu at the cursor. */
  onContextMenu: (e: React.MouseEvent) => void;
}

/** A single file tab. Exported so the unified tab bar (tabs displayMode)
 *  can render file tabs inside its own DndContext — `useSortable` binds
 *  per-item, so the same component works under any shared context. */
export function SortableFileTab({
  path,
  isActive,
  dirty,
  registerNode,
  onActivate,
  onClose,
  onContextMenu,
}: SortableFileTabProps) {
  const { t } = useI18n();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: path });

  // Merge the dnd-kit node ref with our registry ref.
  const setRefs = useCallback(
    (node: HTMLDivElement | null) => {
      setNodeRef(node);
      registerNode(node);
    },
    [setNodeRef, registerNode],
  );

  // The sortable transform reorders visually during a drag; while dragging
  // the source tab is dimmed and lifted slightly.
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    ...(isDragging ? { zIndex: 10, opacity: 0.6 } : undefined),
  };

  const handleClose = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onClose();
    },
    [onClose],
  );

  // Middle-click closes (browser tab-bar convention) — except unsaved files,
  // mirroring the × button which is hidden while dirty.
  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button === 1 && !dirty) {
        e.preventDefault();
        onClose();
      }
    },
    [dirty, onClose],
  );

  return (
    <div
      ref={setRefs}
      style={style}
      {...attributes}
      {...listeners}
      onClick={() => {
        // A real drag is captured away by dnd-kit and never lands here; this
        // fires only for an actual tap, which we treat as tab activation.
        onActivate();
      }}
      onMouseDown={onMouseDown}
      onContextMenu={onContextMenu}
      role="tab"
      aria-selected={isActive}
      title={path}
      className={cn(
        // Editor file tabs share the same chip style as session tabs
        // (rounded-md + resting bg); in the unified strip a vertical divider
        // separates the two groups.
        "group flex min-w-0 shrink-0 cursor-pointer select-none items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] transition-colors",
        // Width caps are identical in both states so activating a tab never
        // stretches it or shifts the strip layout; the always-visible close
        // button on the active tab just truncates the name a bit harder.
        "max-w-[160px]",
        isActive
          ? "bg-accent/15 text-content ring-1 ring-inset ring-accent/40 dark:text-accent"
          : "bg-surface-muted/60 text-content-muted hover:bg-surface-hover/70 hover:text-content",
        isDragging && "shadow-lg",
      )}
    >
      {/* File-type icon + file name. The icon is shrink-0 so it survives
          truncation; the name flex-1 + min-w-0 truncates with ellipsis when
          space is tight. The tab's own max-w governs the overall cap. */}
      <FileTypeIcon path={path} size={13} className="shrink-0 text-content-subtle" />
      <span className="min-w-0 flex-1 truncate font-mono">{basename(path)}</span>
      {/* Dirty dot (unsaved) OR close button on hover - same rule as before:
          an unsaved file can't be closed from the bar (would lose edits).
          The close button is always visible on the active tab (data-active)
          so the user can close it without hovering; background tabs show it
          on hover. shrink-0 ensures it's never squeezed out by the name. */}
      {dirty ? (
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent animate-pulse"
          title={t("ide.editor.unsaved")}
        />
      ) : (
        <button
          type="button"
          aria-label={t("ide.editor.closeTabAria")}
          onClick={handleClose}
          onPointerDown={(e) => e.stopPropagation()}
          className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-content-subtle opacity-0 transition-opacity hover:bg-surface-hover hover:text-content group-hover:opacity-100 data-[active=true]:opacity-100"
          data-active={isActive}
          title={t("common.close")}
        >
          <IconX size={10} />
        </button>
      )}
    </div>
  );
}

/* ───────────────────────── context menu ───────────────────────── */

/** Actions available from the file-tab context menu. Passed in from
 *  OpenTabsBar (or the unified tab bar) so the menu component stays
 *  presentational. */
export interface FileTabContextMenuActions {
  close: (path: string) => void;
  closeOthers: (keepPath: string) => void;
  closeAll: () => void;
  activate: (path: string) => void;
  addToChat: (path: string) => void;
}

/** Cursor-anchored right-click menu for editor file tabs. Renders a single
 *  controlled `Menu.Root` (open iff ctxMenu is non-null) with a virtual anchor
 *  positioned at the cursor coordinates. Items: close, close others, close
 *  all, copy path, add to chat. Closes after any action. Exported for the
 *  unified tab bar. */
export function FileTabContextMenu({
  ctxMenu,
  onClose,
  actions,
}: {
  ctxMenu: { path: string; x: number; y: number } | null;
  onClose: () => void;
  actions: FileTabContextMenuActions;
}) {
  const { t } = useI18n();
  // Virtual anchor at the cursor position so the menu opens exactly where the
  // user right-clicked (base-ui's ContextMenu.Trigger anchors to the element
  // edge, not the cursor); frozen at the last coords during the exit
  // transition so the closing popup doesn't flash at the top-left corner.
  const anchor = useCursorAnchor(ctxMenu);

  const path = ctxMenu?.path;

  const handleCopyPath = () => {
    if (path) navigator.clipboard.writeText(path).catch(() => {});
  };

  return (
    <Menu.Root open={!!ctxMenu} onOpenChange={(open) => { if (!open) onClose(); }}>
      <Menu.Portal>
        <Menu.Positioner anchor={anchor} side="bottom" align="start" sideOffset={4}>
          <Menu.Popup className={MENU_POPUP_CLASS}>
            <Menu.Item
              onClick={() => { if (path) actions.close(path); }}
              className={MENU_ITEM_CLASS}
            >
              <IconX size={14} className="shrink-0" />
              <span>{t("common.close")}</span>
            </Menu.Item>
            <Menu.Item
              onClick={() => { if (path) actions.closeOthers(path); }}
              className={MENU_ITEM_CLASS}
            >
              <IconX size={14} className="shrink-0 opacity-50" />
              <span>{t("ide.editor.closeOthers")}</span>
            </Menu.Item>
            <Menu.Item
              onClick={() => actions.closeAll()}
              className={MENU_ITEM_CLASS}
            >
              <IconStack2 size={14} className="shrink-0" />
              <span>{t("ide.editor.closeAll")}</span>
            </Menu.Item>
            <Menu.Separator className="my-1 h-px bg-edge" />
            <Menu.Item
              onClick={() => { if (path) actions.addToChat(path); }}
              className={MENU_ITEM_CLASS}
            >
              <IconMessage size={14} className="shrink-0" />
              <span>{t("ide.editor.addToChat")}</span>
            </Menu.Item>
            <Menu.Item
              onClick={handleCopyPath}
              className={MENU_ITEM_CLASS}
            >
              <IconCopy size={14} className="shrink-0" />
              <span>{t("ide.editor.copyPath")}</span>
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/* ───────────────────────── dirty tracking ─────────────────────────
 *
 * FileEditor instances report their dirty state (content diverges from the
 * last-saved content) through this tiny pub/sub. It avoids putting transient
 * per-file dirty flags into the global store (which would churn selectors on
 * every keystroke). The bar subscribes and re-renders only when the set of
 * dirty files changes.
 *
 * The tracker is module-scoped and resets on full app reload — acceptable
 * since dirty state is inherently ephemeral (unsaved edits don't survive a
 * restart anyway). */

const dirtyFiles = new Set<string>();
const listeners = new Set<() => void>();

export const ideDirtyTracker = {
  set(filePath: string, dirty: boolean) {
    const had = dirtyFiles.has(filePath);
    if (dirty && !had) dirtyFiles.add(filePath);
    else if (!dirty && had) dirtyFiles.delete(filePath);
    else return; // no change
    listeners.forEach((fn) => fn());
  },
  has(filePath: string) {
    return dirtyFiles.has(filePath);
  },
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

/** Hook returning the current set of dirty file paths. Re-renders the caller
 *  when the set changes. Exported for the unified tab bar, which shows the
 *  same dirty dots on its file tabs. */
export function useDirtyFiles(): Set<string> {
  // We use useSyncExternalStore for correctness (tears-free under concurrent
  // React). The snapshot is the Set itself; since we never mutate it in place
  // without notifying, identity is stable between notifications.
  return useSyncExternalStore(
    ideDirtyTracker.subscribe,
    () => dirtyFiles,
    () => dirtyFiles,
  );
}
