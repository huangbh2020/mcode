import { useCallback, useEffect, useRef, useState } from "react";
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
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@renderer/lib/cn.js";
import { IconX, SpinnerIcon } from "@renderer/lib/icons.js";
import { getProviderIcon } from "@renderer/lib/providerIcon.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import type { Session } from "@contracts/session";
import { TabBarChevronButton, TabBarOverflowMenu } from "./TabBarChrome.js";

/** Tab strip rendered along the top of the center pane in `tabs` display
 *  mode. Each open tab shows the session's title, a running indicator
 *  (spinner when the session has a turn in flight, static dot when idle),
 *  and a close button. Clicking the tab body activates it; the × button
 *  removes it from the strip (the session's in-flight turn is NOT
 *  cancelled — see `closeTab` in the store).
 *
 *  Interaction model (VS Code / browser-style tab bar):
 *   - Drag a tab to reorder it (via @dnd-kit; a 6px activation distance
 *     distinguishes a drag from a click).
 *   - When tabs overflow, left/right chevron buttons scroll the strip; the
 *     mouse wheel is also translated to horizontal scroll. The native
 *     scrollbar is hidden (`no-scrollbar`); edge fades hint at more content.
 *   - A `⋯` menu on the right lists every tab for quick jumping when the
 *     strip overflows.
 *   - Middle-click on a tab closes it.
 *
 *  Only renders anything when the store's `openTabs` list is non-empty.
 *  In `single` displayMode this component is never mounted (the
 *  CenterPane router in App.tsx gates it). */
export function SessionTabs() {
  const tabs = useSessionStore((s) => s.openTabs);
  const activeId = useSessionStore((s) => s.activeSessionId);
  const sessionsByProject = useSessionStore((s) => s.sessionsByProject);
  const pinnedSessions = useSessionStore((s) => s.pinnedSessions);
  const runningBySession = useSessionStore((s) => s.runningBySession);
  const unreadBySession = useSessionStore((s) => s.unreadBySession);
  const selectSession = useSessionStore((s) => s.selectSession);
  const closeTab = useSessionStore((s) => s.closeTab);
  const reorderTab = useSessionStore((s) => s.reorderTab);

  const scrollRef = useRef<HTMLDivElement>(null);
  // Maps a tab id → its DOM node, used to scrollIntoView the active tab.
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
  }, [tabs.length, recomputeScrollState]);

  // Scroll the active tab into view whenever it changes — so selecting a
  // background tab or opening a new one never leaves it hidden off-screen.
  useEffect(() => {
    if (!activeId) return;
    const node = tabNodes.current.get(activeId);
    node?.scrollIntoView({ inline: "nearest", behavior: "smooth", block: "nearest" });
    // Recompute after the smooth scroll settles.
    const t = setTimeout(recomputeScrollState, 260);
    return () => clearTimeout(t);
  }, [activeId, tabs.length, recomputeScrollState]);

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
      const from = tabs.indexOf(String(active.id));
      const to = tabs.indexOf(String(over.id));
      if (from === -1 || to === -1) return;
      reorderTab(from, to);
    },
    [tabs, reorderTab],
  );

  if (tabs.length === 0) return null;
  const overflowing = canScrollLeft || canScrollRight;

  return (
    <div className="flex shrink-0 items-center gap-0.5 border-b border-edge bg-surface/40 px-2 py-1.5">
      {/* Left chevron — only when there's content scrolled off the left edge. */}
      {canScrollLeft && (
        <TabBarChevronButton
          dir="left"
          onClick={() => scrollByPage(-1)}
          title="Scroll tabs left"
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
          className="no-scrollbar flex items-end gap-0.5 overflow-x-auto"
        >
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={onDragEnd}
          >
            <SortableContext
              items={tabs}
              strategy={horizontalListSortingStrategy}
            >
              {tabs.map((id) => {
                const sess = findSession(sessionsByProject, pinnedSessions, id);
                const isActive = id === activeId;
                const running = !!runningBySession[id];
                const unread = unreadBySession[id] ?? 0;
                return (
                  <SortableSessionTab
                    key={id}
                    session={sess}
                    sessionId={id}
                    isActive={isActive}
                    running={running}
                    unreadCount={unread}
                    registerNode={(node) => {
                      if (node) tabNodes.current.set(id, node);
                      else tabNodes.current.delete(id);
                    }}
                    onActivate={() => void selectSession(id)}
                    onClose={() => closeTab(id)}
                  />
                );
              })}
            </SortableContext>
          </DndContext>
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
          title="Scroll tabs right"
        />
      )}

      {/* Overflow menu — lists every tab for quick jumping. Only shown when
          the strip actually overflows (otherwise it's pure noise). */}
      {overflowing && (
        <TabBarOverflowMenu
          heading="Open tabs"
          items={tabs.map((id) => {
            const sess = findSession(sessionsByProject, pinnedSessions, id);
            return {
              key: id,
              label: sess?.title ?? "(unknown)",
              active: id === activeId,
              dotClass: runningBySession[id]
                ? "bg-accent animate-pulse"
                : "bg-content-subtle/50",
            };
          })}
          onSelect={(id) => void selectSession(id)}
        />
      )}
    </div>
  );
}

interface SortableTabProps {
  session: Session | undefined;
  sessionId: string;
  isActive: boolean;
  running: boolean;
  /** Unread event count for this session (0 = no badge). Rendered as a small
   *  accent-colored count badge on non-active tabs so the user can see which
   *  background tabs have new activity. */
  unreadCount: number;
  registerNode: (node: HTMLDivElement | null) => void;
  onActivate: () => void;
  onClose: () => void;
}

/** A single session tab. Exported so the unified tab bar (tabs displayMode)
 *  can render session tabs inside its own DndContext — `useSortable` binds
 *  per-item, so the same component works under any shared context. */
export function SortableSessionTab({
  session,
  sessionId,
  isActive,
  running,
  unreadCount,
  registerNode,
  onActivate,
  onClose,
}: SortableTabProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: sessionId });

  const title = session?.title ?? "(unknown)";

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
    ...(isDragging
      ? { zIndex: 10, opacity: 0.6 }
      : undefined),
  };

  const handleClose = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onClose();
    },
    [onClose],
  );

  // Middle-click closes (browser tab-bar convention).
  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button === 1) {
        e.preventDefault();
        onClose();
      }
    },
    [onClose],
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
      role="tab"
      aria-selected={isActive}
      title={title}
      className={cn(
        "group flex max-w-[200px] min-w-0 shrink-0 cursor-pointer select-none items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] transition-colors",
        isActive
          ? "bg-accent/15 text-accent"
          : "text-content-muted hover:bg-surface-muted/50 hover:text-content",
        isDragging && "shadow-lg",
      )}
    >
      {/* Provider brand mark, fixed at the leading edge of the tab. */}
      {(() => {
        const { Icon, color } = getProviderIcon(session?.providerId);
        return <Icon size={13} className={cn("shrink-0", color)} />;
      })()}
      {/* Running indicator: spinner while a turn is in flight (matches the
          app-wide loading-icon convention), static dot when idle. Lets the
          user see at a glance which background tabs are still working. */}
      {running ? (
        <SpinnerIcon size={12} className="shrink-0 animate-spin text-accent" />
      ) : (
        <span
          aria-hidden
          className={cn(
            "inline-block h-1.5 w-1.5 shrink-0 rounded-full",
            isActive ? "bg-accent/70" : "bg-content-subtle/50",
          )}
        />
      )}
      <span className="truncate">{title}</span>
      {/* Unread badge - shown on non-active tabs with pending unread events.
          Suppresses on hover so the close button has room; the badge clears
          when the tab is activated (selectSession). */}
      {!isActive && unreadCount > 0 && (
        <span
          className={cn(
            "shrink-0 rounded-full bg-accent px-1 text-center text-[9px] font-medium leading-[14px] text-white",
            "min-w-[14px] transition-opacity group-hover:opacity-0",
          )}
        >
          {unreadCount > 9 ? "9+" : unreadCount}
        </span>
      )}
      {/* Close button - explicit stopPropagation so it never starts a drag
          and never activates the tab. */}
      <button
        type="button"
        aria-label="Close tab"
        onClick={handleClose}
        onPointerDown={(e) => e.stopPropagation()}
        className="ml-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-content-subtle opacity-0 transition-opacity hover:bg-surface-hover hover:text-content group-hover:opacity-100 data-[active=true]:opacity-100"
        data-active={isActive}
      >
        <IconX size={11} />
      </button>
    </div>
  );
}

/** Find a session across the per-project cache by id, falling back to the
 *  global pinned bucket (pinned rows leave their project's list). Returns
 *  undefined if neither has it (init race / unknown id). Exported for the
 *  unified tab bar, which resolves session rows the same way. */
export function findSession(
  sessionsByProject: Record<string, Session[]>,
  pinnedSessions: Session[],
  id: string,
): Session | undefined {
  for (const list of Object.values(sessionsByProject)) {
    if (!list) continue;
    const hit = list.find((s) => s.id === id);
    if (hit) return hit;
  }
  return pinnedSessions.find((s) => s.id === id);
}
