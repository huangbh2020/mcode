import {
  Fragment,
  useCallback,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import type { TodoItem, Block } from "@renderer/stores/sessionStore.js";
import type { SubagentSnapshot } from "@contracts/runtime";
import type { SessionBookmark } from "@contracts/session";
import { cn } from "@renderer/lib/cn.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import { extractPlanTitle } from "./StatusCapsule.js";
import type { TablerIconProps } from "@renderer/lib/icons.js";
import {
  IconBookmark,
  IconCheck,
  IconChevronDown,
  IconCircle,
  IconClipboard,
  IconListDetails,
  IconLoader2,
  IconPencil,
  IconX,
  PiRobot,
} from "@renderer/lib/icons.js";

/** A `kind: "plan"` block - the frozen per-turn plan in the message stream. */
type PlanBlock = Extract<Block, { kind: "plan" }>;

/* ── Tasks section (extracted from the old TodosPopover) ────────────── */

const STATUS_META: Record<TodoItem["status"], { icon: ComponentType<TablerIconProps>; cls: string; spin?: boolean }> = {
  pending: { icon: IconCircle, cls: "text-content-subtle" },
  in_progress: { icon: IconLoader2, cls: "text-warning", spin: true },
  completed: { icon: IconCheck, cls: "text-accent" },
};

const PRIORITY_BAR: Record<TodoItem["priority"], string> = {
  high: "border-l-red-500",
  medium: "border-l-amber-500",
  low: "border-l-zinc-600",
};

/** Status tints per subagent lifecycle state. Exported so the capsule
 *  chip (SubagentsChip) can render matching labels/colors without
 *  duplicating the map. Display labels are `labelKey`s resolved via t() at
 *  render time (module constants can't hold locale-bound strings). */
export const SUBAGENT_STATUS_META: Record<SubagentSnapshot["status"], { labelKey: MessageId; cls: string; spin?: boolean }> = {
  running: { labelKey: "chatStream.subagent.statusRunning", cls: "text-warning", spin: true },
  completed: { labelKey: "chatStream.subagent.statusCompleted", cls: "text-accent" },
  failed: { labelKey: "chatStream.subagent.statusFailed", cls: "text-danger" },
  killed: { labelKey: "chatStream.subagent.statusKilled", cls: "text-danger" },
};

/** Compact "1.2k tokens · 5 tools · 12s" string. Exported for reuse by the
 *  capsule chip's tooltip / popover. */
export function fmtUsage(snap: SubagentSnapshot): string {
  const parts: string[] = [];
  if (typeof snap.totalTokens === "number") parts.push(`${(snap.totalTokens / 1000).toFixed(1)}k tokens`);
  if (typeof snap.toolUses === "number") parts.push(`${snap.toolUses} tools`);
  if (typeof snap.durationMs === "number") parts.push(`${Math.round(snap.durationMs / 1000)}s`);
  return parts.join(" · ");
}

/* ── Section primitives ─────────────────────────────────────────────── */

/** List container class shared by every section. `scrollLists=false` removes
 *  the per-section `max-h-60` so the whole stack scrolls as one body inside
 *  the mobile bottom sheet (avoids nested scroll areas on touch). */
const sectionListCls = (scrollLists: boolean) =>
  cn("overflow-y-auto py-1", scrollLists ? "max-h-60" : "max-h-none");

/** Static left-bar tint for settled subagents (running rows use the
 * animated shimmer track instead). */
const BAR_BY_STATUS: Record<SubagentSnapshot["status"], string> = {
  running: "",
  completed: "bg-accent/50",
  failed: "bg-danger/50",
  killed: "bg-danger/50",
};

/** A horizontal section header: icon + title (left), badge/right slot.
 *  When `onToggle` is present the whole header becomes the section's
 *  collapse toggle — clickable, with a chevron that turns horizontal while
 *  collapsed. The `right` slot (counts / running pulse) stays visible in
 *  both states so a collapsed section still summarizes its content. */
function SectionHeader({
  icon,
  title,
  right,
  collapsed,
  onToggle,
}: {
  icon: ReactNode;
  title: string;
  right?: ReactNode;
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  const content = (
    <>
      <span className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-content">
        {icon}
        {title}
      </span>
      <span className="flex items-center gap-1">
        {right && <span className="text-[10px] tabular-nums text-content-subtle">{right}</span>}
        {onToggle && (
          <IconChevronDown
            size={12}
            className={cn(
              "shrink-0 text-content-subtle transition-transform duration-200",
              collapsed && "-rotate-90",
            )}
          />
        )}
      </span>
    </>
  );
  if (!onToggle) {
    return (
      <div className="flex items-center justify-between border-b border-edge/40 bg-surface-muted/50 px-3 py-1.5">
        {content}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      className="flex w-full select-none items-center justify-between border-b border-edge/40 bg-surface-muted/50 px-3 py-1.5 text-left transition-colors hover:bg-surface-muted"
    >
      {content}
    </button>
  );
}

/* ── Section collapse state ─────────────────────────────────────────── */

/** Identity of a collapsible section in the activity stack. */
export type ActivitySectionKey = "plans" | "subagents" | "tasks" | "bookmarks";

/** Shared collapse-set state for the activity sections. Each shell (desktop
 *  popover / mobile sheet) owns one via its always-mounted ancestor
 *  (StatusCapsule / the sheet itself), so the user's collapsed sections
 *  survive popover open/close cycles instead of resetting on every open. */
export function useCollapsedSections(): {
  collapsedSections: ReadonlySet<ActivitySectionKey>;
  toggleSection: (key: ActivitySectionKey) => void;
} {
  const [collapsed, setCollapsed] = useState<ReadonlySet<ActivitySectionKey>>(() => new Set());
  const toggleSection = useCallback((key: ActivitySectionKey) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  return { collapsedSections: collapsed, toggleSection };
}

/* ── Section: Plan list ────────────────────────────────────────────── */

/**
 * Plan section - a list of plan titles. The capsule pill shows only a count;
 * this popover section lists each plan's derived title as a clickable row.
 * Clicking a row calls `onPickPlan(plan)` which opens the right-side
 * PlanDrawer with that plan's full markdown content. No status badges - the
 * list is a pure index of the session's plans.
 *
 * Plans are listed newest-first (the most recent plan at the top) so the
 * user sees the current/relevant plan without scrolling.
 */
function PlanListSection({
  planBlocks,
  onPickPlan,
  scrollLists,
  collapsed,
  onToggle,
}: {
  planBlocks: PlanBlock[];
  onPickPlan: (plan: string) => void;
  scrollLists: boolean;
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  const { t } = useI18n();
  // Newest first: the last plan block in the stream is the most recent turn's.
  const ordered = [...planBlocks].reverse();
  return (
    <>
      <SectionHeader
        icon={<IconClipboard size={12} className="opacity-80" />}
        title={t("chatStream.activity.plansTitle", { n: planBlocks.length })}
        collapsed={collapsed}
        onToggle={onToggle}
      />
      {!collapsed && (
        <ul className={sectionListCls(scrollLists)}>
          {ordered.map((block, i) => {
            const title = extractPlanTitle(block.plan) || t("chatStream.activity.planFallback", { n: ordered.length - i });
            return (
              <li key={block.planId}>
                <button
                  type="button"
                  onClick={() => onPickPlan(block.plan)}
                  title={t("chatStream.activity.viewPlan")}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-surface-muted"
                >
                  <span className="shrink-0 text-[10px] tabular-nums text-content-subtle">
                    {ordered.length - i}.
                  </span>
                  <span className="truncate text-[11px] text-content">
                    {title}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

/* ── Section: Tasks ─────────────────────────────────────────────────── */

function TasksSection({
  todos,
  scrollLists,
  collapsed,
  onToggle,
}: {
  todos: TodoItem[];
  scrollLists: boolean;
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  const { t } = useI18n();
  const done = todos.filter((td) => td.status === "completed").length;
  const pct = todos.length > 0 ? Math.round((done / todos.length) * 100) : 0;
  return (
    <>
      <SectionHeader
        icon={<IconListDetails size={12} className="opacity-80" />}
        title={t("chatStream.activity.tasksTitle")}
        right={
          <span className="rounded-full bg-surface-muted px-2 py-0.5 tabular-nums">
            {done}/{todos.length} · {pct}%
          </span>
        }
        collapsed={collapsed}
        onToggle={onToggle}
      />
      {!collapsed && (
        <>
          {/* Overall completion bar — width transitions so checking a task off
              animates the fill instead of snapping. */}
          <div className="mx-3 mt-1.5 h-[3px] overflow-hidden rounded-full bg-surface-muted">
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out"
              style={{ width: `${pct}%` }}
            />
          </div>
          <ul className={sectionListCls(scrollLists)}>
            {todos.map((t, i) => {
              const meta = STATUS_META[t.status];
              const StatusIcon = meta.icon;
              return (
                <li
                  key={i}
                  className={`flex items-start gap-2 border-l-2 px-3 py-1.5 transition-colors hover:bg-surface-muted ${PRIORITY_BAR[t.priority]}`}
                >
                  <StatusIcon
                    size={11}
                    className={cn("mt-0.5 shrink-0", meta.cls, meta.spin && "animate-spin")}
                  />
                  <span
                    className={`text-xs leading-relaxed ${
                      t.status === "completed" ? "text-content-subtle line-through" : "text-content-muted"
                    }`}
                  >
                    {t.content}
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </>
  );
}

/* ── Section: Subagents ────────────────────────────────────────────── */

function SubagentsSection({
  agents,
  onPick,
  scrollLists,
  collapsed,
  onToggle,
}: {
  agents: SubagentSnapshot[];
  /** Row click — opens the subagent's read-only transcript in the right
   *  panel's sidechat tab. Absent = display-only rows. */
  onPick?: (agent: SubagentSnapshot) => void;
  scrollLists: boolean;
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  const { t } = useI18n();
  const running = agents.filter((a) => a.status === "running").length;
  return (
    <>
      <SectionHeader
        icon={<PiRobot size={12} className="opacity-80" />}
        title={t("chatStream.activity.subagentsTitle", { n: agents.length })}
        right={
          running > 0 ? (
            <span className="flex items-center gap-1 text-warning">
              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-warning" />
              {t("chatStream.activity.runningCount", { n: running })}
            </span>
          ) : null
        }
        collapsed={collapsed}
        onToggle={onToggle}
      />
      {!collapsed && (
        <ul className={sectionListCls(scrollLists)}>
          {agents.map((s) => {
            const meta = SUBAGENT_STATUS_META[s.status];
            // Stat chips (badge-ified usage) instead of the joined plain-text
            // line — each chip keeps tabular-nums so digits stay aligned.
            const usageParts: string[] = [];
            if (typeof s.totalTokens === "number")
              usageParts.push(`${(s.totalTokens / 1000).toFixed(1)}k tok`);
            if (typeof s.toolUses === "number") usageParts.push(`${s.toolUses} tools`);
            if (typeof s.durationMs === "number")
              usageParts.push(`${Math.round(s.durationMs / 1000)}s`);
            return (
              <li
                key={s.taskId}
                onClick={onPick ? () => onPick(s) : undefined}
                title={onPick ? t("chatStream.activity.viewSubagent") : undefined}
                className={cn(
                  "group relative py-1.5 pl-3.5 pr-3 transition-colors",
                  onPick && "cursor-pointer hover:bg-surface-muted",
                )}
              >
                {/* Left status bar — running rows get an animated shimmer track
                    (a light blob sweeping down); settled rows a static tint. */}
                {s.status === "running" ? (
                  <span aria-hidden className="capsule-shimmer-track" />
                ) : (
                  <span
                    aria-hidden
                    className={cn(
                      "absolute bottom-2 left-0 top-2 w-[2px] rounded-full",
                      BAR_BY_STATUS[s.status],
                    )}
                  />
                )}
                <div className="flex items-center gap-1.5">
                  {s.subagentType && (
                    <span className="rounded bg-info/20 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-info">
                      {s.subagentType}
                    </span>
                  )}
                  <span className={`flex items-center gap-1 text-[10px] ${meta.cls}`}>
                    {meta.spin && <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-warning" />}
                    {t(meta.labelKey)}
                  </span>
                </div>
                <p className="mt-0.5 truncate text-[11px] text-content" title={s.description}>
                  {s.description || t("chatStream.activity.noDescription")}
                </p>
                {(usageParts.length > 0 || s.lastToolName) && (
                  <div className="mt-1 flex flex-wrap items-center gap-1">
                    {s.lastToolName && (
                      <span className="rounded bg-surface-muted px-1.5 py-0.5 text-[9px] font-medium tabular-nums text-content-muted">
                        {s.lastToolName}
                      </span>
                    )}
                    {usageParts.map((part) => (
                      <span
                        key={part}
                        className="rounded bg-surface-muted px-1.5 py-0.5 text-[9px] tabular-nums text-content-subtle"
                      >
                        {part}
                      </span>
                    ))}
                  </div>
                )}
                {s.summary && (
                  <p className="mt-0.5 truncate text-[10px] italic text-content-subtle" title={s.summary}>
                    {s.summary}
                  </p>
                )}
                {s.error && <p className="mt-0.5 text-[10px] text-danger">{s.error}</p>}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

/* ── Section: Bookmarks ─────────────────────────────────────────────── */

/** Format a bookmark's createdAt as HH:MM (local) — compact trailing hint
 *  for the row, full HH:MM:SS lives in the title attribute. */
function fmtBookmarkClock(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Bookmarks section - a clickable list of the session's message bookmarks.
 * Each row shows the user-defined title when renamed, else the excerpt
 * captured at add time (the excerpt is also the jump's locate anchor and is
 * never rewritten; a renamed row shows it as its tooltip). Stale entries
 * (their message was truncated away by an edit-resend / compact) are greyed
 * out and disabled for jumps; renaming them is still allowed — the title is
 * user data. Hover reveals a rename (pencil) and delete (x) button; rename
 * edits inline in the row (Enter/blur commits, Esc cancels, empty = clear).
 */
function BookmarksSection({
  bookmarks,
  isStale,
  onPick,
  onRemove,
  onRename,
  scrollLists,
  collapsed,
  onToggle,
}: {
  bookmarks: SessionBookmark[];
  isStale: (b: SessionBookmark) => boolean;
  onPick: (b: SessionBookmark) => void;
  onRemove: (b: SessionBookmark) => void;
  /** Present = the rename pencil is offered (desktop). Absent (mobile
   *  sheet) = display-only rows. */
  onRename?: (b: SessionBookmark, title: string) => void;
  scrollLists: boolean;
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  const { t } = useI18n();
  // Inline-edit state for ONE row at a time (the popover is transient, so
  // component-local state survives long enough).
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // Esc must cancel WITHOUT the input's blur firing a commit — blur runs
  // when the input unmounts, after the Escape handler already flipped state.
  const cancelledRef = useRef(false);
  // Newest first — the most recent bookmark is the likeliest jump target.
  const ordered = [...bookmarks].reverse();

  const startEdit = (b: SessionBookmark) => {
    cancelledRef.current = false;
    setEditingId(b.id);
    setDraft(b.title ?? "");
  };
  const commitEdit = (b: SessionBookmark) => {
    setEditingId(null);
    onRename?.(b, draft);
  };

  return (
    <>
      <SectionHeader
        icon={<IconBookmark size={12} className="opacity-80" />}
        title={t("chatStream.bookmark.sectionTitle", { n: bookmarks.length })}
        collapsed={collapsed}
        onToggle={onToggle}
      />
      {!collapsed && (
        <ul className={sectionListCls(scrollLists)}>
          {ordered.map((b) => {
            const stale = isStale(b);
            const label = b.title ?? b.excerpt;
            return (
              <li key={b.id} className="group/row relative">
                {editingId === b.id ? (
                  <div className="flex w-full items-center px-3 py-1">
                    <input
                      autoFocus
                      value={draft}
                      maxLength={80}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitEdit(b);
                        else if (e.key === "Escape") {
                          cancelledRef.current = true;
                          setEditingId(null);
                        }
                      }}
                      onBlur={() => {
                        if (cancelledRef.current) {
                          cancelledRef.current = false;
                          return;
                        }
                        commitEdit(b);
                      }}
                      placeholder={t("chatStream.bookmark.renamePlaceholder")}
                      className="min-w-0 flex-1 rounded border border-accent/50 bg-surface-muted px-1.5 py-0.5 text-[11px] text-content outline-none"
                    />
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      disabled={stale}
                      onClick={() => onPick(b)}
                      title={
                        stale
                          ? undefined
                          : b.title
                            ? b.excerpt
                            : t("chatStream.bookmark.jumpTitle")
                      }
                      className={cn(
                        "flex w-full items-center gap-2 py-1.5 pl-3 pr-12 text-left transition-colors",
                        stale ? "cursor-default" : "hover:bg-surface-muted",
                      )}
                    >
                      <IconBookmark
                        size={11}
                        className={cn("shrink-0", stale ? "text-content-subtle" : "text-warning")}
                      />
                      <span
                        className={cn(
                          "min-w-0 flex-1 truncate text-[11px]",
                          stale ? "text-content-subtle" : "text-content",
                        )}
                      >
                        {label}
                      </span>
                      {stale ? (
                        <span className="shrink-0 rounded bg-surface-muted px-1 text-[9px] text-content-subtle">
                          {t("chatStream.bookmark.stale")}
                        </span>
                      ) : (
                        <span className="shrink-0 text-[9px] tabular-nums text-content-subtle">
                          {fmtBookmarkClock(b.createdAt)}
                        </span>
                      )}
                    </button>
                    {onRename && (
                      <button
                        type="button"
                        onClick={() => startEdit(b)}
                        title={t("chatStream.bookmark.rename")}
                        className="absolute right-7 top-1/2 hidden -translate-y-1/2 rounded p-0.5 text-content-subtle transition-colors hover:bg-surface-hover hover:text-content group-hover/row:block"
                      >
                        <IconPencil size={11} />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onRemove(b);
                      }}
                      title={t("chatStream.bookmark.remove")}
                      className="absolute right-1.5 top-1/2 hidden -translate-y-1/2 rounded p-0.5 text-content-subtle transition-colors hover:bg-surface-hover hover:text-danger group-hover/row:block"
                    >
                      <IconX size={11} />
                    </button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

/* ── Root: ActivityPopover ─────────────────────────────────────────── */

/**
 * Shared section stack for both shells of the activity capsule: the desktop
 * anchored popover and the mobile bottom sheet. Renders up to four sections
 * - Plan, Subagents, Tasks, Bookmarks - in priority order, joined by gradient
 * dividers. Each section is omitted entirely when its source state is empty
 * (no Todos -> no Tasks section), so the stack gracefully degrades to
 * whatever the active session is actually doing right now. Sections stagger
 * in on mount (capsule-section-in + index*40ms delay).
 *
 * The Plan section is a clickable title list (not the full content).
 * Clicking a plan title opens the plan viewer via `onPickPlan`.
 *
 * `scrollLists` selects where scrolling happens: the desktop popover gives
 * each section its own `max-h-60` inner scroll; the mobile sheet passes
 * `false` so the whole stack scrolls as one body.
 *
 * Sections are collapsible when `onToggleSection` is provided: each header
 * becomes a toggle (chevron affordance) and its body hides while collapsed,
 * the header row (title + counts) remaining as the collapsed summary. The
 * collapsed set lives in an always-mounted ancestor via `useCollapsedSections`.
 */
export function ActivitySections({
  todos,
  planBlocks,
  subagents,
  bookmarks,
  isBookmarkStale,
  onPickBookmark,
  onRemoveBookmark,
  onRenameBookmark,
  onPickSubagent,
  onPickPlan,
  scrollLists = true,
  collapsedSections,
  onToggleSection,
}: {
  todos: TodoItem[];
  planBlocks: PlanBlock[];
  subagents: SubagentSnapshot[];
  /** The session's bookmarks; omit/empty to hide the section. */
  bookmarks?: SessionBookmark[];
  /** Stale check (message no longer in the stream) — greys out the row. */
  isBookmarkStale?: (b: SessionBookmark) => boolean;
  onPickBookmark?: (b: SessionBookmark) => void;
  onRemoveBookmark?: (b: SessionBookmark) => void;
  /** Present = rows offer the inline rename pencil. */
  onRenameBookmark?: (b: SessionBookmark, title: string) => void;
  /** Subagent row click — opens its read-only transcript. Absent (mobile
   *  sheet) = display-only rows. */
  onPickSubagent?: (agent: SubagentSnapshot) => void;
  onPickPlan: (plan: string) => void;
  scrollLists?: boolean;
  /** Keys currently collapsed. Consulted only when `onToggleSection` is
   *  also given (that prop is what enables collapsing at all). */
  collapsedSections?: ReadonlySet<ActivitySectionKey>;
  /** Present = section headers are collapse toggles. */
  onToggleSection?: (key: ActivitySectionKey) => void;
}) {
  const showPlan = planBlocks.length > 0;
  const showSubagents = subagents.length > 0;
  const showTasks = todos.length > 0;
  const showBookmarks = (bookmarks?.length ?? 0) > 0 && !!onRemoveBookmark;

  // Const locals so narrowing survives into the closures below (a narrowed
  // parameter would reset inside the arrow functions).
  const toggleKey = onToggleSection;
  const collapsedOf = (key: ActivitySectionKey): boolean =>
    toggleKey ? (collapsedSections?.has(key) ?? false) : false;
  const toggleOf = (key: ActivitySectionKey): (() => void) | undefined => {
    if (!toggleKey) return undefined;
    return () => toggleKey(key);
  };

  // Sections in priority order, joined by gradient dividers instead of
  // per-section border-b (the fade-in/out line matches the pill's segment
  // dividers). Each section staggers in (capsule-section-in + i*40ms delay,
  // fill "both" holds the pre-state through the delay).
  const sections: { key: ActivitySectionKey; node: ReactNode }[] = [
    ...(showPlan
      ? [
          {
            key: "plans" as const,
            node: (
              <PlanListSection
                planBlocks={planBlocks}
                onPickPlan={onPickPlan}
                scrollLists={scrollLists}
                collapsed={collapsedOf("plans")}
                onToggle={toggleOf("plans")}
              />
            ),
          },
        ]
      : []),
    ...(showSubagents
      ? [
          {
            key: "subagents" as const,
            node: (
              <SubagentsSection
                agents={subagents}
                onPick={onPickSubagent}
                scrollLists={scrollLists}
                collapsed={collapsedOf("subagents")}
                onToggle={toggleOf("subagents")}
              />
            ),
          },
        ]
      : []),
    ...(showTasks
      ? [
          {
            key: "tasks" as const,
            node: (
              <TasksSection
                todos={todos}
                scrollLists={scrollLists}
                collapsed={collapsedOf("tasks")}
                onToggle={toggleOf("tasks")}
              />
            ),
          },
        ]
      : []),
    ...(showBookmarks
      ? [
          {
            key: "bookmarks" as const,
            node: (
              <BookmarksSection
                bookmarks={bookmarks!}
                isStale={isBookmarkStale ?? (() => false)}
                onPick={(b) => onPickBookmark?.(b)}
                onRemove={onRemoveBookmark!}
                onRename={onRenameBookmark}
                scrollLists={scrollLists}
                collapsed={collapsedOf("bookmarks")}
                onToggle={toggleOf("bookmarks")}
              />
            ),
          },
        ]
      : []),
  ];

  return (
    <>
      {sections.map((section, i) => (
        <Fragment key={section.key}>
          {i > 0 && (
            <div
              aria-hidden
              className="mx-3 h-px bg-gradient-to-r from-transparent via-edge/50 to-transparent"
            />
          )}
          <div
            className="animate-[capsule-section-in_200ms_ease-out_both]"
            style={{ animationDelay: `${i * 40}ms` }}
          >
            {section.node}
          </div>
        </Fragment>
      ))}
    </>
  );
}

/**
 * Desktop shell: anchored popover below the capsule pill, fixed 384px width.
 * On mobile this is replaced by the bottom sheet (see
 * components/mobile/ActivitySheet.tsx) - a 384px anchored popover would
 * overflow a ~375px phone viewport.
 */
export function ActivityPopover({
  todos,
  planBlocks,
  subagents,
  bookmarks,
  isBookmarkStale,
  onPickBookmark,
  onRemoveBookmark,
  onRenameBookmark,
  onPickSubagent,
  onPickPlan,
  collapsedSections,
  onToggleSection,
}: {
  todos: TodoItem[];
  planBlocks: PlanBlock[];
  subagents: SubagentSnapshot[];
  bookmarks?: SessionBookmark[];
  isBookmarkStale?: (b: SessionBookmark) => boolean;
  onPickBookmark?: (b: SessionBookmark) => void;
  onRemoveBookmark?: (b: SessionBookmark) => void;
  onRenameBookmark?: (b: SessionBookmark, title: string) => void;
  onPickSubagent?: (agent: SubagentSnapshot) => void;
  onPickPlan: (plan: string) => void;
  /** See `ActivitySections` — forwarded unchanged. */
  collapsedSections?: ReadonlySet<ActivitySectionKey>;
  onToggleSection?: (key: ActivitySectionKey) => void;
}) {
  return (
    <div className="absolute right-0 top-9 z-30 w-96 origin-top-right animate-[capsule-pop-in_180ms_cubic-bezier(0.2,0.8,0.3,1)] overflow-hidden rounded-2xl border border-edge bg-surface/95 shadow-[inset_0_1px_0_rgb(255_255_255/0.08),0_24px_48px_-12px_rgb(0_0_0/0.35)] backdrop-blur-xl">
      <ActivitySections
        todos={todos}
        planBlocks={planBlocks}
        subagents={subagents}
        bookmarks={bookmarks}
        isBookmarkStale={isBookmarkStale}
        onPickBookmark={onPickBookmark}
        onRemoveBookmark={onRemoveBookmark}
        onRenameBookmark={onRenameBookmark}
        onPickSubagent={onPickSubagent}
        onPickPlan={onPickPlan}
        collapsedSections={collapsedSections}
        onToggleSection={onToggleSection}
      />
    </div>
  );
}
