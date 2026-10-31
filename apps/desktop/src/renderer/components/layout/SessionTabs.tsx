import { useCallback } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@renderer/lib/cn.js";
import { IconX, SpinnerIcon } from "@renderer/lib/icons.js";
import { getProviderIcon } from "@renderer/lib/providerIcon.js";
import { projectDisplayColor } from "@renderer/lib/projectAvatar.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import type { Session } from "@contracts/session";
import { ProjectAvatar } from "./ProjectAvatar.js";
import { useI18n } from "@renderer/lib/i18n/index.js";

/** Session tab chip, rendered inside the titlebar's unified tab strip
 *  (UnifiedTabsBar). The strip itself lives in the titlebar since the
 *  2026-10-31 single-row merge — the old standalone SessionTabs strip below
 *  the titlebar was retired then (its session-only wide-mode variant
 *  included); only this chip and `findSession` remain exported.
 *
 *  Each chip shows the session's title, a running indicator (spinner while
 *  the session has a turn in flight) and a close button. Clicking the chip
 *  body activates it; the × removes it from the strip (the session's
 *  in-flight turn is NOT cancelled — see `closeTab` in the store).
 *  Middle-click closes (browser tab-bar convention). The chip opts out of
 *  the titlebar's window-drag region so dnd-kit reorder drags work. */

interface SortableTabProps {
  session: Session | undefined;
  sessionId: string;
  isActive: boolean;
  running: boolean;
  /** Unread event count for this session (0 = no badge). Rendered as a small
   *  accent-colored count badge on non-active tabs so the user can see which
   *  background tabs have new activity. */
  unreadCount: number;
  /** Split-pane count for the tab's per-tab group (undefined/≤1 = no
   *  badge). Rendered as a small neutral count pill whenever the tab hosts
   *  ≥ 2 sessions — "this tab is a grid of N". */
  sessionCount?: number;
  registerNode: (node: HTMLDivElement | null) => void;
  onActivate: () => void;
  onClose: () => void;
  /** Right-click: opens the session tab context menu at the cursor
   *  (close / close others / close right / close all / open in split). */
  onContextMenu?: (e: React.MouseEvent) => void;
}

/** A single session tab. Exported so the unified tab bar can render session
 *  tabs inside its own DndContext — `useSortable` binds per-item, so the
 *  same component works under any shared context. */
export function SortableSessionTab({
  session,
  sessionId,
  isActive,
  running,
  unreadCount,
  sessionCount,
  registerNode,
  onActivate,
  onClose,
  onContextMenu,
}: SortableTabProps) {
  const { t } = useI18n();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: sessionId });

  const title = session?.title ?? t("layout.tabUnknownSession");

  // Project identity for the tab: resolved from the store here (not passed
  // down) so the unified tab bar gets the avatar without touching its prop
  // plumbing. Unknown project (worker rows / init race) renders no avatar.
  const projects = useSessionStore((s) => s.projects);
  const projectColors = useSessionStore((s) => s.projectColors);
  const project = session
    ? projects.find((p) => p.id === session.projectId)
    : undefined;

  // Provider identity — which agent drives this session (Claude / Pi /
  // Codex / terminal). Migrated from the old titlebar ActiveThreadTitle in
  // the single-row merge so the chip still says what kind of session it is.
  const { Icon: ProviderIcon, color: providerColor } = getProviderIcon(session?.providerId);

  // Merge the dnd-kit node ref with our registry ref.
  const setRefs = useCallback(
    (node: HTMLDivElement | null) => {
      setNodeRef(node);
      registerNode(node);
    },
    [setNodeRef, registerNode],
  );

  // The sortable transform reorders visually during a drag; while dragging
  // the source tab is dimmed and lifted slightly. no-drag: the chip sits in
  // the titlebar's window-drag region, and dnd reorder must win over window
  // dragging on the chip itself.
  const style: React.CSSProperties = {
    WebkitAppRegion: "no-drag",
    transform: CSS.Transform.toString(transform),
    transition,
    ...(isDragging
      ? { zIndex: 10, opacity: 0.6 }
      : undefined),
  } as React.CSSProperties;

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
      onContextMenu={onContextMenu}
      role="tab"
      aria-selected={isActive}
      title={title}
      className={cn(
        // Apple-style Compact Integrated Card Tab (方案 1)
        "group flex h-[27px] max-w-[200px] cursor-pointer select-none items-center gap-1.5 rounded-lg px-2.5 text-[11px] transition-all duration-150 min-w-0 shrink-0",
        isActive
          ? "bg-surface text-content font-medium shadow-xs border border-edge/60 dark:bg-surface-hover dark:border-white/10 dark:shadow-[0_1px_3px_rgba(0,0,0,0.35)]"
          : "text-content-muted hover:text-content hover:bg-surface-hover/50 border border-transparent",
        isDragging && "shadow-lg opacity-80 z-20",
      )}
    >
      {/* Project identity leads the tab: the owning project's colored
          initial, so tabs from different projects read apart at a glance
          (same mark as the sidebars' project rows). */}
      {project && (
        <ProjectAvatar
          name={project.name}
          color={projectDisplayColor(project, projectColors)}
        />
      )}
      {/* Provider icon — which agent drives the session. */}
      <ProviderIcon size={12} className={cn("shrink-0", providerColor)} />
      {/* Running spinner — the only in-flight indicator on the tab. */}
      {running && (
        <SpinnerIcon size={12} className="shrink-0 animate-spin text-accent" />
      )}
      {/* Title fills every free pixel of the chip (flex-1) — on inactive
          tabs the close button leaves the layout entirely until hover, so
          the title owns the full tab width. */}
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {/* Split-pane count — the tab hosts N sessions (per-tab split grid).
          Always visible (unlike the unread badge); ≤1 renders nothing. */}
      {sessionCount != null && sessionCount >= 2 && (
        <span className="shrink-0 rounded-full bg-surface-hover px-1.5 text-center text-[9px] font-medium leading-[14px] tabular-nums text-content-subtle">
          {sessionCount}
        </span>
      )}
      {/* Unread badge - shown on non-active tabs with pending unread events.
          Leaves the layout on hover so the appearing close button gets the
          room (the badge clears when the tab is activated — selectSession). */}
      {!isActive && unreadCount > 0 && (
        <span
          className={cn(
            "shrink-0 rounded-full bg-accent px-1 text-center text-[9px] font-medium leading-[14px] text-white",
            "min-w-[14px] group-hover:hidden",
          )}
        >
          {unreadCount > 9 ? "9+" : unreadCount}
        </span>
      )}
      {/* Close button - ALWAYS in flow (opacity swap, never display swap):
          a hover-appearing button shifts the title on every hover — the
          "hover jump" the chip used to have. The slot is reserved on every
          tab and the glyph fades in on hover (always visible on the active
          tab). The invisible state also opts out of clicks so it can't
          swallow a tap meant for the tab body. Explicit stopPropagation so
          it never starts a drag and never activates the tab. */}
      <button
        type="button"
        aria-label={t("layout.closeTab")}
        onClick={handleClose}
        onPointerDown={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.stopPropagation()}
        className={cn(
          "ml-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-content-subtle transition-all hover:bg-black/10 dark:hover:bg-white/15 hover:text-content",
          isActive
            ? "opacity-100"
            : "opacity-0 pointer-events-none group-hover:pointer-events-auto group-hover:opacity-100",
        )}
      >
        <IconX size={11} />
      </button>
    </div>
  );
}

/** Find a session across the per-project cache by id, falling back to the
 *  global pinned bucket (pinned rows leave their project's list) and the
 *  stream sidebar's cross-project aggregate (a `session.listAll` page-2+
 *  row exists ONLY there — without the fallback its tab renders
 *  "(unknown)"). The optional workersById map (orch-worker sub-sessions,
 *  fetched on demand by the orchestration panel's "open worker" action) is
 *  the final fallback — worker rows live in no list cache by design.
 *  Returns undefined if none has it (init race / unknown id).
 *  Exported for the unified tab bar, which resolves session rows the same
 *  way. */
export function findSession(
  sessionsByProject: Record<string, Session[]>,
  pinnedSessions: Session[],
  streamSessions: Session[],
  id: string,
  workersById?: Record<string, Session>,
): Session | undefined {
  for (const list of Object.values(sessionsByProject)) {
    if (!list) continue;
    const hit = list.find((s) => s.id === id);
    if (hit) return hit;
  }
  const pinnedHit = pinnedSessions.find((s) => s.id === id);
  if (pinnedHit) return pinnedHit;
  const streamHit = streamSessions.find((s) => s.id === id);
  if (streamHit) return streamHit;
  return workersById?.[id];
}
