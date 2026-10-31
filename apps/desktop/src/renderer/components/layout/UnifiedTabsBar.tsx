import { useCallback, useEffect, useLayoutEffect, useRef, useState , useMemo } from "react";
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
import {
  IconChevronRight,
  IconClipboard,
  IconLayoutColumns,
  IconLayoutSidebarRight,
  IconStack2,
  IconX,
} from "@renderer/lib/icons.js";
import { Menu } from "@base-ui/react/menu";
import { useCursorAnchor } from "@renderer/hooks/useCursorAnchor.js";
import { useSessionStore, orchRunningAnchors } from "@renderer/stores/sessionStore.js";
import { TabBarChevronButton, TabBarOverflowMenu } from "./TabBarChrome.js";
import { SortableSessionTab, findSession } from "./SessionTabs.js";
import {
  MENU_ITEM_CLASS,
  MENU_POPUP_CLASS,
  PLAN_TAB_KEY,
  SortableFileTab,
  FileTabContextMenu,
  useDirtyFiles,
  useIdeCloseGuard,
} from "../ide/OpenTabsBar.js";
import { useI18n } from "@renderer/lib/i18n/index.js";

/** Stable empty array so the selector never returns a fresh [] (Zustand
 *  Object.is rule — a new [] every render causes an infinite loop). */
const EMPTY_OPEN_FILES: string[] = [];

/** The unified tab strip: ONE row holding the open session tabs AND the
 *  editor's file tabs (+ the per-session plan pseudo-tab) side by side. Both
 *  kinds share the same chip style; a vertical divider separates the session
 *  group from the editor group (plus the provider icon vs file-type icon as
 *  a secondary cue). Clicking a session tab shows that session's chat
 *  full-width; clicking a file / plan tab shows the editor full-width (the
 *  `centerTabFocus` store flag — see UnifiedTabbedPane in App.tsx).
 *
 *  EMBEDDED IN THE TITLEBAR (2026-10-31): this is no longer a standalone
 *  strip below the titlebar — it renders as the flexible middle region of
 *  the single-row titlebar (Titlebar.tsx), so the bar is 40px total and the
 *  session title appears exactly once (on its tab). Consequences:
 *   - No strip chrome of its own (no bg/border — the titlebar provides it).
 *   - Single-row ONLY: the 40px titlebar cannot grow for the multi-row wrap
 *     (the native overlay controls would misalign), so `tabBarMultiRow` is
 *     ignored here — the right panel's OpenTabsBar still honors it.
 *   - Interactive children opt out of the window-drag region individually
 *     (`WebkitAppRegion: "no-drag"`); empty track space stays draggable,
 *     like a browser tab strip.
 *   - Wide-panel mode hides the file/plan tabs and the placement toggle
 *     (the editor has no surface there — same contract as the old
 *     SessionTabs swap in UnifiedTabbedPane).
 *
 *  Interaction model mirrors OpenTabsBar (VS Code / browser-style): drag to
 *  reorder (within the same kind — a session can't be dropped among files
 *  and vice versa), chevrons + wheel scroll on overflow, a `⋯` overflow menu
 *  listing every tab, middle-click close. File tabs additionally keep their
 *  right-click context menu and dirty dots; session tabs keep their running
 *  spinners and unread badges. */
export function UnifiedTabsBar() {
  const { t } = useI18n();
  // ── Session tabs ──
  const tabs = useSessionStore((s) => s.openTabs);
  const activeId = useSessionStore((s) => s.activeSessionId);
  const sessionsByProject = useSessionStore((s) => s.sessionsByProject);
  const pinnedSessions = useSessionStore((s) => s.pinnedSessions);
  const streamSessions = useSessionStore((s) => s.streamSessions);
  const orchWorkersById = useSessionStore((s) => s.orchWorkersById);
  const runningBySession = useSessionStore((s) => s.runningBySession);
  const orchRunsBySession = useSessionStore((s) => s.orchRunsBySession);
  const orchAnchors = useMemo(() => orchRunningAnchors(orchRunsBySession), [orchRunsBySession]);
  const unreadBySession = useSessionStore((s) => s.unreadBySession);
  const selectSession = useSessionStore((s) => s.selectSession);
  const closeTab = useSessionStore((s) => s.closeTab);
  const reorderTab = useSessionStore((s) => s.reorderTab);
  // Per-tab split groups: the focused session may be a non-tab MEMBER pane
  // of some tab's grid — that tab is the active one (its group owns the
  // center). Member panes never appear as tabs.
  const splitGroupsBySession = useSessionStore((s) => s.splitGroupsBySession);
  const isTabActive = useCallback(
    (id: string) => {
      if (id === activeId) return true;
      const members = splitGroupsBySession[id];
      return !!activeId && !!members?.includes(activeId);
    },
    [activeId, splitGroupsBySession],
  );
  // Chip display follows the FOCUSED session when the focus sits on one of
  // a tab's group's member panes (name + icon + markers); identity stays
  // the root id (sessionId prop → close/dnd/registry). Same contract as
  // SessionTabs.
  const displayedIdFor = useCallback(
    (id: string) => {
      if (activeId && splitGroupsBySession[id]?.includes(activeId)) return activeId;
      return id;
    },
    [activeId, splitGroupsBySession],
  );
  // Multi-row wrapping is a right-panel OpenTabsBar feature only — the 40px
  // titlebar cannot grow for wrapped rows (native overlay misalignment), so
  // this strip is always single-row regardless of the store flag.

  // ── File tabs (scoped to the active project) ──
  // Hidden in wide-panel mode: the editor has no surface there (file tabs
  // would be dead controls) — same contract as the old SessionTabs swap.
  const widePanelOpen = useSessionStore((s) => s.widePanelOpen);
  const tabsFilePreviewPlacement = useSessionStore((s) => s.tabsFilePreviewPlacement);
  const toggleTabsFilePreviewPlacement = useSessionStore((s) => s.toggleTabsFilePreviewPlacement);
  const pid = useSessionStore((s) => s.activeProjectId);
  const openFiles = useSessionStore((s) => {
    if (s.tabsFilePreviewPlacement === "sidebar" || s.widePanelOpen) return EMPTY_OPEN_FILES;
    const p = s.activeProjectId;
    return p ? s.ideOpenFilesByProject[p] ?? EMPTY_OPEN_FILES : EMPTY_OPEN_FILES;
  });
  const activeFile = useSessionStore((s) =>
    pid ? s.ideActiveFileByProject[pid] ?? null : null,
  );
  const setActiveFile = useSessionStore((s) => s.setIdeActiveFile);
  const reorderIdeFile = useSessionStore((s) => s.reorderIdeFile);
  const clearIdeActiveFile = useSessionStore((s) => s.clearIdeActiveFile);
  const enqueueChatFile = useSessionStore((s) => s.enqueueChatFile);
  const dirtySet = useDirtyFiles();
  // File-tab close entries funnel through the same unsaved-changes guard as
  // the sidebar tab bar (save & close / discard / cancel on dirty files).
  const closeGuard = useIdeCloseGuard();

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
  // what's on screen. Never in wide mode: the editor has no surface there,
  // so a stale editor focus must not gray out every session tab.
  const editorFocused =
    !widePanelOpen &&
    centerTabFocus === "editor" &&
    ((!!activeFile && tabsFilePreviewPlacement !== "sidebar") || planTabActive);

  // Right-click context menu state for file tabs (lifted to the bar level,
  // same pattern as OpenTabsBar).
  const [ctxMenu, setCtxMenu] = useState<{ path: string; x: number; y: number } | null>(null);
  // Right-click context menu state for SESSION tabs (close family + split).
  const [sessionCtx, setSessionCtx] = useState<{ id: string; x: number; y: number } | null>(null);

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

  // Layout-effect recompute on ANY tab-list mutation (identity, not just
  // count): a renamed tab / different title lengths change the track's
  // scrollWidth without changing counts, and the arrows must appear in the
  // same commit the overflow appears — a post-paint useEffect would show one
  // frame where the strip overflows with no arrows.
  useLayoutEffect(() => {
    recomputeScrollState();
  }, [tabs, openFiles, recomputeScrollState]);

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

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      // Translate vertical wheel into horizontal scroll so a plain mouse
      // wheel can navigate the strip. Trackpad horizontal is already deltaX.
      const el = scrollRef.current;
      if (!el) return;
      if (e.deltaY !== 0 && e.deltaX === 0) {
        el.scrollLeft += e.deltaY;
      }
    },
    [],
  );

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

  // ── Session tab context-menu actions (browser-style close family).
  // closeTab intentionally does NOT cancel an in-flight turn, so the bulk
  // closes are safe against running sessions — they leave the tab strip,
  // the session keeps living (sidebar, badges). ──
  const closeSessionTabs = useCallback(
    (ids: readonly string[]) => {
      for (const id of ids) void closeTab(id);
    },
    [closeTab],
  );
  const sessionCtxActions = useMemo<SessionTabContextMenuActions>(
    () => ({
      close: (id) => void closeTab(id),
      closeOthers: (id) => closeSessionTabs(tabs.filter((x) => x !== id)),
      closeRight: (id) => closeSessionTabs(tabs.slice(tabs.indexOf(id) + 1)),
      closeAll: () => closeSessionTabs([...tabs]),
      openInSplit: (id) => void useSessionStore.getState().addToSplit(id),
    }),
    [tabs, closeTab, closeSessionTabs],
  );

  // Plan tab surface: hidden in wide-panel mode (the WidePlanDialog overlay
  // owns the plan there — same contract as the old SessionTabs swap).
  const showPlanTab = hasPlanTab && !widePanelOpen;

  if (tabs.length === 0 && openFiles.length === 0 && !showPlanTab) return null;
  const showOverflowMenu = canScrollLeft || canScrollRight;

  return (
    <div
      role="tablist"
      aria-label={t("layout.tabStripAria")}
      // overflow-hidden: hard containment — every level of the flex chain is
      // min-w-0 and the track scrolls, but if the strip is ever squeezed
      // below its own chrome (shrink-0 chevrons/⋯), clipping HERE beats
      // spilling over the git pill and workbench toggles to its right.
      className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden"
    >
      {/* Left chevron — only when there's content scrolled off the left edge. */}
      {canScrollLeft && (
        <TabBarChevronButton
          dir="left"
          onClick={() => scrollByPage(-1)}
          title={t("ide.editor.scrollTabsLeft")}
        />
      )}

      {/* Scrollable tab track: sessions, then files, then the plan tab — one
          seamless strip, no grouping divider. The track itself stays inside
          the titlebar's drag region: dragging empty track space moves the
          window (browser convention); every interactive child opts out
          individually with WebkitAppRegion: "no-drag". */}
      <div className="relative min-w-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={recomputeScrollState}
          onWheel={onWheel}
          className="no-scrollbar flex items-center gap-1 overflow-x-auto"
        >
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={onDragEnd}
          >
            <SortableContext items={tabs} strategy={horizontalListSortingStrategy}>
              {tabs.map((id) => {
                const displayId = displayedIdFor(id);
                const sess = findSession(sessionsByProject, pinnedSessions, streamSessions, displayId, orchWorkersById);
                return (
                  <SortableSessionTab
                    key={id}
                    session={sess}
                    sessionId={id}
                    isActive={isTabActive(id) && !editorFocused}
                    running={!!runningBySession[displayId] || orchAnchors[displayId] != null}
                    unreadCount={unreadBySession[displayId] ?? 0}
                    sessionCount={splitGroupsBySession[id]?.length}
                    registerNode={(node) => {
                      if (node) tabNodes.current.set(id, node);
                      else tabNodes.current.delete(id);
                    }}
                    onActivate={() => void selectSession(id)}
                    onClose={() => closeTab(id)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setSessionCtx({ id, x: e.clientX, y: e.clientY });
                    }}
                  />
                );
              })}
            </SortableContext>

            {/* Group divider: session tabs on the left, editor tabs (files +
                the plan pseudo-tab) on the right. Only rendered when both
                groups have content. */}
            {tabs.length > 0 && (openFiles.length > 0 || showPlanTab) && (
              <div aria-hidden className="mx-1 h-3.5 w-px shrink-0 self-center bg-edge/70" />
            )}

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
                  onClose={() => closeGuard.requestClose({ kind: "one", path })}
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
          {showPlanTab && (
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
              style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
              className={cn(
                // Apple-style Compact Integrated Card Plan Tab (方案 1)
                "group flex h-[27px] max-w-[160px] cursor-pointer select-none items-center gap-1.5 rounded-lg px-2.5 text-[11px] transition-all duration-150 min-w-0 shrink-0",
                planTabActive && editorFocused
                  ? "bg-surface text-content font-medium shadow-xs border border-edge/60 dark:bg-surface-hover dark:border-white/10 dark:shadow-[0_1px_3px_rgba(0,0,0,0.35)]"
                  : "text-content-muted hover:text-content hover:bg-surface-hover/50 border border-transparent",
              )}
            >
              <IconClipboard size={12} className="shrink-0 text-emerald-500" />
              <span className="min-w-0 flex-1 truncate">{t("ide.editor.planTab")}</span>
              {/* Close button leaves the layout on inactive tabs (title fills
                  the chip); appears on hover, always visible while active. */}
              <button
                type="button"
                aria-label={t("ide.editor.closePlanTabAria")}
                onClick={(e) => {
                  e.stopPropagation();
                  if (activeId) closePlanDrawer(activeId);
                }}
                onPointerDown={(e) => e.stopPropagation()}
                className={cn(
                  // Always in flow (opacity swap) — same hover-jump fix as
                  // the session/file chips.
                  "ml-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-content-subtle transition-all hover:bg-black/10 dark:hover:bg-white/15 hover:text-content",
                  planTabActive && editorFocused
                    ? "opacity-100"
                    : "opacity-0 pointer-events-none group-hover:pointer-events-auto group-hover:opacity-100",
                )}
                title={t("common.close")}
              >
                <IconX size={10} />
              </button>
            </div>
          )}
        </div>

        {/* Edge fades — overlay only, pointer-events disabled so they never
          intercept tab clicks. Shown per-direction based on scroll state.
          Fade from the titlebar's own bg so the fade blends into the bar. */}
        {canScrollLeft && (
          <div className="pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r from-surface-muted to-transparent" />
        )}
        {canScrollRight && (
          <div className="pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-surface-muted to-transparent" />
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

      {/* Placement toggle: switch between center tabs and sidebar preview.
          Neutral active state — green is reserved for attention signals
          (running spinner / worktree merge-back / unread), not layout
          toggles. Hidden in wide-panel mode (no editor surface). */}
      {!widePanelOpen && (
        <button
          type="button"
          onClick={toggleTabsFilePreviewPlacement}
          title={
            tabsFilePreviewPlacement === "center"
              ? t("ide.files.placementCenterHint")
              : t("ide.files.placementSidebarHint")
          }
          aria-label={
            tabsFilePreviewPlacement === "center"
              ? t("ide.files.placementCenterHint")
              : t("ide.files.placementSidebarHint")
          }
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          className={cn(
            "flex h-7 w-7 shrink-0 items-center justify-center rounded text-content-subtle transition-colors hover:bg-surface-hover hover:text-content",
            tabsFilePreviewPlacement === "sidebar" && "bg-surface-hover text-content",
          )}
        >
          <IconLayoutSidebarRight size={14} />
        </button>
      )}

      {/* Overflow menu — lists every tab (sessions first, then files, then
          the plan tab) for quick jumping. Shown when the strip overflows. */}
      {showOverflowMenu && (
        <TabBarOverflowMenu
          heading={t("ide.editor.openTabs")}
          items={[
            ...tabs.map((id) => {
              const displayId = displayedIdFor(id);
              const sess = findSession(sessionsByProject, pinnedSessions, streamSessions, displayId, orchWorkersById);
              return {
                key: id,
                label: sess?.title ?? t("layout.tabUnknownSession"),
                active: isTabActive(id) && !editorFocused,
                dotClass: runningBySession[displayId] || orchAnchors[displayId] != null
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
            ...(showPlanTab
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
          close: (p) => closeGuard.requestClose({ kind: "one", path: p }),
          closeOthers: (p) => closeGuard.requestClose({ kind: "others", keep: p }),
          closeAll: () => closeGuard.requestClose({ kind: "all" }),
          activate: (p) => setActiveFile(p),
          addToChat: (p) => enqueueChatFile(p),
        }}
      />

      {/* Right-click context menu for session tabs (browser-style close
          family + the split-view opener). */}
      <SessionTabContextMenu
        ctxMenu={sessionCtx}
        onClose={() => setSessionCtx(null)}
        actions={sessionCtxActions}
        total={tabs.length}
        isLast={sessionCtx != null && tabs.indexOf(sessionCtx.id) === tabs.length - 1}
      />

      {/* Unsaved-changes confirm for close requests that touch dirty files. */}
      {closeGuard.dialog}
    </div>
  );
}

/* ───────────────────────── session tab context menu ───────────────────────── */

/** Actions available from the session-tab context menu. Passed in from the
 *  strip so the menu component stays presentational. */
export interface SessionTabContextMenuActions {
  close: (id: string) => void;
  closeOthers: (id: string) => void;
  closeRight: (id: string) => void;
  closeAll: () => void;
  openInSplit: (id: string) => void;
}

/** Cursor-anchored right-click menu for session tabs — the browser tab-bar
 *  family (close / close others / close to the right / close all) plus the
 *  split-view opener: the split gesture otherwise has NO menu entry anywhere
 *  (drag or sidebar context menu only), so this is also its discoverability
 *  fix. Presentational, same form as FileTabContextMenu; the strip owns
 *  state and actions. Bulk closes are safe against running sessions —
 *  closeTab never cancels an in-flight turn. */
export function SessionTabContextMenu({
  ctxMenu,
  onClose,
  actions,
  total,
  isLast,
}: {
  ctxMenu: { id: string; x: number; y: number } | null;
  onClose: () => void;
  actions: SessionTabContextMenuActions;
  /** Open session-tab count — gates 关闭其他 (meaningless with ≤1 tab). */
  total: number;
  /** Whether the right-clicked tab is the strip's last — gates 关闭右侧. */
  isLast: boolean;
}) {
  const { t } = useI18n();
  const anchor = useCursorAnchor(ctxMenu);
  const id = ctxMenu?.id;

  return (
    <Menu.Root open={!!ctxMenu} onOpenChange={(open) => { if (!open) onClose(); }}>
      <Menu.Portal>
        <Menu.Positioner anchor={anchor} side="bottom" align="start" sideOffset={4}>
          <Menu.Popup className={MENU_POPUP_CLASS}>
            <Menu.Item
              onClick={() => { if (id) actions.close(id); }}
              className={MENU_ITEM_CLASS}
            >
              <IconX size={14} className="shrink-0" />
              <span>{t("common.close")}</span>
            </Menu.Item>
            <Menu.Item
              disabled={total <= 1}
              onClick={() => { if (id) actions.closeOthers(id); }}
              className={MENU_ITEM_CLASS}
            >
              <IconX size={14} className="shrink-0 opacity-50" />
              <span>{t("ide.editor.closeOthers")}</span>
            </Menu.Item>
            <Menu.Item
              disabled={isLast}
              onClick={() => { if (id) actions.closeRight(id); }}
              className={MENU_ITEM_CLASS}
            >
              <IconChevronRight size={14} className="shrink-0 opacity-50" />
              <span>{t("ide.editor.closeRight")}</span>
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
              onClick={() => { if (id) actions.openInSplit(id); }}
              className={MENU_ITEM_CLASS}
            >
              <IconLayoutColumns size={14} className="shrink-0" />
              <span>{t("layout.openInSplitView")}</span>
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
