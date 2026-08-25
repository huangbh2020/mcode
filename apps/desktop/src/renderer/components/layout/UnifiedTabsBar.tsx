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
} from "@dnd-kit/sortable";
import { basename } from "@renderer/lib/path.js";
import { cn } from "@renderer/lib/cn.js";
import { IconClipboard, IconX } from "@renderer/lib/icons.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { TabBarChevronButton, TabBarOverflowMenu } from "./TabBarChrome.js";
import { SortableSessionTab, findSession } from "./SessionTabs.js";
import {
  PLAN_TAB_KEY,
  SortableFileTab,
  FileTabContextMenu,
  useDirtyFiles,
} from "../ide/OpenTabsBar.js";
import { useI18n } from "@renderer/lib/i18n/index.js";

/** Stable empty array so the selector never returns a fresh [] (Zustand
 *  Object.is rule — a new [] every render causes an infinite loop). */
const EMPTY_OPEN_FILES: string[] = [];

/** The unified center tab bar (`tabs` displayMode): ONE strip holding the
 *  open session tabs AND the editor's file tabs (+ the per-session plan
 *  pseudo-tab) side by side, with no visual grouping between them — session
 *  tabs render as transparent pills while file/plan tabs render as squarish
 *  chips with a resting background (plus the provider icon vs file-type
 *  icon), so the two kinds stay distinguishable at a glance. Clicking a
 *  session tab
 *  shows that session's chat full-width; clicking a file / plan tab shows
 *  the editor full-width (the `centerTabFocus` store flag — see
 *  UnifiedTabbedPane in App.tsx). This replaces the split
 *  chat-column|editor-column layout used in `single` mode and gives
 *  whichever view is active the whole center width.
 *
 *  Interaction model mirrors SessionTabs / OpenTabsBar (VS Code /
 *  browser-style): drag to reorder (within the same kind — a session can't
 *  be dropped among files and vice versa), chevrons + wheel scroll on
 *  overflow, a `⋯` overflow menu listing every tab, middle-click close.
 *  File tabs additionally keep their right-click context menu and dirty
 *  dots; session tabs keep their running spinners and unread badges. */
export function UnifiedTabsBar() {
  const { t } = useI18n();
  // ── Session tabs ──
  const tabs = useSessionStore((s) => s.openTabs);
  const activeId = useSessionStore((s) => s.activeSessionId);
  const sessionsByProject = useSessionStore((s) => s.sessionsByProject);
  const pinnedSessions = useSessionStore((s) => s.pinnedSessions);
  const runningBySession = useSessionStore((s) => s.runningBySession);
  const unreadBySession = useSessionStore((s) => s.unreadBySession);
  const selectSession = useSessionStore((s) => s.selectSession);
  const closeTab = useSessionStore((s) => s.closeTab);
  const reorderTab = useSessionStore((s) => s.reorderTab);

  // ── File tabs (scoped to the active project) ──
  const pid = useSessionStore((s) => s.activeProjectId);
  const openFiles = useSessionStore((s) =>
    pid ? s.ideOpenFilesByProject[pid] ?? EMPTY_OPEN_FILES : EMPTY_OPEN_FILES,
  );
  const activeFile = useSessionStore((s) =>
    pid ? s.ideActiveFileByProject[pid] ?? null : null,
  );
  const setActiveFile = useSessionStore((s) => s.setIdeActiveFile);
  const closeFile = useSessionStore((s) => s.closeFileInIde);
  const closeOthers = useSessionStore((s) => s.closeOtherFilesInIde);
  const closeAllFiles = useSessionStore((s) => s.closeAllFilesInIde);
  const reorderIdeFile = useSessionStore((s) => s.reorderIdeFile);
  const clearIdeActiveFile = useSessionStore((s) => s.clearIdeActiveFile);
  const enqueueChatFile = useSessionStore((s) => s.enqueueChatFile);
  const dirtySet = useDirtyFiles();

  // ── Editor focus + plan pseudo-tab (scoped to the active session) ──
  const centerTabFocus = useSessionStore((s) => s.centerTabFocus);
  const planText = useSessionStore(
    (s) => (activeId ? s.planDrawerPlanBySession[activeId] ?? null : null),
  );
  const planTabActive = useSessionStore(
    (s) => (activeId ? s.planTabActiveBySession[activeId] ?? false : false),
  );
  const setPlanTabActive = useSessionStore((s) => s.setPlanTabActive);
  const closePlanDrawer = useSessionStore((s) => s.closePlanDrawer);
  const hasPlanTab = !!planText;

  // The editor owns the content area only while focused AND it has content
  // (an active file or an active plan tab) — matches UnifiedTabbedPane's
  // visibility gate so the bar's active highlighting never disagrees with
  // what's on screen.
  const editorFocused = centerTabFocus === "editor" && (!!activeFile || planTabActive);

  // Right-click context menu state for file tabs (lifted to the bar level,
  // same pattern as OpenTabsBar).
  const [ctxMenu, setCtxMenu] = useState<{ path: string; x: number; y: number } | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  // Maps a tab key (session id | file path | PLAN_TAB_KEY) → its DOM node,
  // used to scroll the active tab fully into view.
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

  // Keep scroll-boundary state fresh on mount, on any tab add/remove, and on
  // container resize. (Scroll position itself is tracked by onScroll.)
  useEffect(() => {
    recomputeScrollState();
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => recomputeScrollState());
    ro.observe(el);
    return () => ro.disconnect();
  }, [tabs.length, openFiles.length, hasPlanTab, recomputeScrollState]);

  // Scroll the active tab FULLY into view whenever it changes — works for
  // all three tab kinds. Double-rAF so React's commit + the browser's layout
  // both settle before measuring (the active-state classes change tab
  // widths). See OpenTabsBar for the full rationale.
  const activeTabKey = editorFocused ? (planTabActive ? PLAN_TAB_KEY : activeFile) : activeId;
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
        el.scrollBy({ left: nodeRect.left - viewRect.left - 2, behavior: "smooth" });
      } else if (nodeRect.right > viewRect.right - BUFFER) {
        el.scrollBy({ left: nodeRect.right - viewRect.right + BUFFER, behavior: "smooth" });
      }
    };
    const doScroll = () => {
      scrollTabFullyIntoView();
      // Re-check after the smooth scroll settles in case the layout shifted.
      t = window.setTimeout(() => {
        scrollTabFullyIntoView();
        recomputeScrollState();
      }, 280);
    };
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(doScroll);
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      if (t) clearTimeout(t);
    };
  }, [activeTabKey, tabs.length, openFiles.length, hasPlanTab, recomputeScrollState]);

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

  // ── Drag-and-drop (reorder, within the same tab kind) ─────────────────
  // A 6px movement activates a drag; anything less is treated as a click.
  // Both kinds live under ONE DndContext; onDragEnd dispatches by which
  // list both ids belong to — cross-kind drops (session onto file or vice
  // versa) are ignored since the two orders live in separate store lists.
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
      const activeIdStr = String(active.id);
      const overIdStr = String(over.id);
      const sFrom = tabs.indexOf(activeIdStr);
      const sTo = tabs.indexOf(overIdStr);
      if (sFrom !== -1 && sTo !== -1) {
        reorderTab(sFrom, sTo);
        return;
      }
      const fFrom = openFiles.indexOf(activeIdStr);
      const fTo = openFiles.indexOf(overIdStr);
      if (fFrom !== -1 && fTo !== -1) reorderIdeFile(fFrom, fTo);
    },
    [tabs, openFiles, reorderTab, reorderIdeFile],
  );

  if (tabs.length === 0 && openFiles.length === 0 && !hasPlanTab) return null;
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

      {/* Scrollable tab track: sessions, then files, then the plan tab — one
          seamless strip, no grouping divider. */}
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
            <SortableContext items={tabs} strategy={horizontalListSortingStrategy}>
              {tabs.map((id) => {
                const sess = findSession(sessionsByProject, pinnedSessions, id);
                return (
                  <SortableSessionTab
                    key={id}
                    session={sess}
                    sessionId={id}
                    isActive={id === activeId && !editorFocused}
                    running={!!runningBySession[id]}
                    unreadCount={unreadBySession[id] ?? 0}
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
            <SortableContext items={openFiles} strategy={horizontalListSortingStrategy}>
              {openFiles.map((path) => (
                <SortableFileTab
                  key={path}
                  path={path}
                  isActive={path === activeFile && editorFocused && !planTabActive}
                  dirty={dirtySet.has(path)}
                  registerNode={(node) => {
                    if (node) tabNodes.current.set(path, node);
                    else tabNodes.current.delete(path);
                  }}
                  onActivate={() => {
                    setActiveFile(path);
                    // Deactivate the plan tab so the file tab takes focus.
                    if (activeId && planTabActive) {
                      setPlanTabActive(activeId, false);
                    }
                  }}
                  onClose={() => closeFile(path)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setCtxMenu({ path, x: e.clientX, y: e.clientY });
                  }}
                />
              ))}
            </SortableContext>
          </DndContext>

          {/* Plan tab - not draggable, sits after the file tabs. Clicking
              activates the plan view (clears activeFile, sets planTabActive,
              which flips the unified focus to the editor); the × closes the
              plan tab entirely. */}
          {hasPlanTab && (
            <div
              ref={(node) => {
                if (node) tabNodes.current.set(PLAN_TAB_KEY, node);
                else tabNodes.current.delete(PLAN_TAB_KEY);
              }}
              role="tab"
              aria-selected={planTabActive && editorFocused}
              title={t("ide.editor.viewPlan")}
              onClick={() => {
                if (activeId) {
                  clearIdeActiveFile();
                  setPlanTabActive(activeId, true);
                }
              }}
              className={cn(
                // Matches the file-tab chip look (rounded-md + resting bg) —
                // the plan view is an editor-kind tab, distinct from the
                // pill-shaped session tabs in this strip.
                "group flex min-w-0 shrink-0 cursor-pointer select-none items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] transition-colors",
                // Match the file-tab width rules: active plan tab gets a
                // min-width so its label + close button are fully visible.
                planTabActive && editorFocused ? "min-w-[100px] max-w-[200px]" : "max-w-[160px]",
                planTabActive && editorFocused
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
                  if (activeId) closePlanDrawer(activeId);
                }}
                onPointerDown={(e) => e.stopPropagation()}
                className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-content-subtle opacity-0 transition-opacity hover:bg-surface-hover hover:text-content group-hover:opacity-100 data-[active=true]:opacity-100"
                data-active={planTabActive && editorFocused}
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

      {/* Overflow menu — lists every tab (sessions first, then files, then
          the plan tab) for quick jumping. Only shown when the strip actually
          overflows. */}
      {overflowing && (
        <TabBarOverflowMenu
          heading={t("ide.editor.openTabs")}
          items={[
            ...tabs.map((id) => {
              const sess = findSession(sessionsByProject, pinnedSessions, id);
              return {
                key: id,
                label: sess?.title ?? "(unknown)",
                active: id === activeId && !editorFocused,
                dotClass: runningBySession[id]
                  ? "bg-accent animate-pulse"
                  : "bg-content-subtle/50",
              };
            }),
            ...openFiles.map((path) => ({
              key: path,
              label: basename(path),
              title: path,
              active: path === activeFile && editorFocused && !planTabActive,
              dotClass: dirtySet.has(path) ? "bg-accent animate-pulse" : undefined,
            })),
            ...(hasPlanTab
              ? [{
                  key: PLAN_TAB_KEY,
                  label: t("ide.editor.planTab"),
                  title: t("ide.editor.viewPlan"),
                  active: planTabActive && editorFocused,
                  dotClass: undefined as string | undefined,
                }]
              : []),
          ]}
          onSelect={(key) => {
            if (key === PLAN_TAB_KEY) {
              if (activeId) {
                clearIdeActiveFile();
                setPlanTabActive(activeId, true);
              }
              return;
            }
            if (tabs.includes(key)) {
              void selectSession(key);
              return;
            }
            setActiveFile(key);
            if (activeId && planTabActive) {
              setPlanTabActive(activeId, false);
            }
          }}
        />
      )}

      {/* Right-click context menu for file tabs (same menu as OpenTabsBar). */}
      <FileTabContextMenu
        ctxMenu={ctxMenu}
        onClose={() => setCtxMenu(null)}
        actions={{
          close: (p) => closeFile(p),
          closeOthers: (p) => closeOthers(p),
          closeAll: () => closeAllFiles(),
          activate: (p) => setActiveFile(p),
          addToChat: (p) => enqueueChatFile(p),
        }}
      />
    </div>
  );
}
