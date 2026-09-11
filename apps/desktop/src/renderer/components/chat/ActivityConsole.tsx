/**
 * ActivityConsole — the expanded panel behind the chat activity rail.
 *
 * One shell, four bodies. The shell is deliberately five fixed bands so the
 * four node kinds read as the same instrument:
 *
 *   header (identity + live summary + actions)
 *   stats  (aggregate numbers for this kind)
 *   tabs   (filter chips, each with a count)
 *   body   (kind-specific: timeline / board / index / axis)  ← the only scroll area
 *   footer (what clicking does, + the Esc hint on desktop)
 *
 * The body is where the kinds differ, and each one is shaped by its data:
 *   · subagents — a slice on the session's agent timeline (bars are real:
 *     `subagentEndpoints` derives every span from `durationMs`/`endedAt`),
 *     split into running / settled so the panel keeps the "live vs archive"
 *     separation the old popover flattened away;
 *   · tasks — a board: ring + status-coloured segment bar + groups by status,
 *     keeping each row's priority stripe;
 *   · plans — an index: number chip, title, two-line excerpt. Plan blocks carry
 *     no timestamp, so a row shows no time rather than inventing one;
 *   · bookmarks — threaded on a vertical axis, grouped today / earlier, stale
 *     entries dimmed but still listed (they are user data).
 *
 * The same component backs the desktop panel and the mobile bottom sheet: the
 * console is CONTENT ONLY (header/stats/tabs/body/footer) and each host draws
 * its own chrome — the rail supplies the rounded glass frame plus the notch
 * that points at the clicked node, the sheet supplies the bottom-sheet frame
 * plus a node-tab strip (the rail is not on screen there). That keeps the two
 * shells from drifting apart while letting each own its geometry.
 * Every user-visible string is an i18n key.
 */
import { useState, type ComponentType, type ReactNode } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useNow } from "@renderer/hooks/useNow.js";
import type { TablerIconProps } from "@renderer/lib/icons.js";
import {
  IconBookmark,
  IconCheck,
  IconCircle,
  IconClipboard,
  IconLayoutSidebarRightExpand,
  IconListDetails,
  IconLoader2,
  IconPencil,
  IconX,
  PiRobot,
} from "@renderer/lib/icons.js";
import type { SubagentSnapshot } from "@contracts/runtime";
import type { SessionBookmark } from "@contracts/session";
import type { TodoItem } from "@renderer/stores/sessionStore.js";
import {
  NODE_META,
  RAIL_NODE_ORDER,
  SUBAGENT_STATUS_META,
  extractPlanExcerpt,
  extractPlanTitle,
  formatClock,
  formatDuration,
  subagentEndpoints,
  subagentTimeline,
  type ActivityNodeKey,
  type ActivityTabs,
  type PlanBlock,
  type Translate,
} from "./activityShared.js";

/* ── Node chrome ────────────────────────────────────────────────────── */

/** Subagent status glyph — the ring around the row's status word. */
const SUBAGENT_STATUS_ICON: Record<SubagentSnapshot["status"], ComponentType<TablerIconProps>> = {
  running: IconLoader2,
  completed: IconCheck,
  failed: IconX,
  killed: IconX,
};

/** Todo status glyphs (the board's left column). */
const TODO_META: Record<
  TodoItem["status"],
  { ico: ComponentType<TablerIconProps>; cls: string; spin?: boolean }
> = {
  pending: { ico: IconCircle, cls: "text-content-subtle" },
  in_progress: { ico: IconLoader2, cls: "text-warning", spin: true },
  completed: { ico: IconCheck, cls: "text-accent" },
};

const PRIORITY_STRIPE: Record<TodoItem["priority"], string> = {
  high: "border-l-danger/60",
  medium: "border-l-warning/60",
  low: "border-l-content-subtle/40",
};

const PRIORITY_LABEL_KEY: Record<TodoItem["priority"], "chatStream.activity.priorityHigh" | "chatStream.activity.priorityMedium" | "chatStream.activity.priorityLow"> = {
  high: "chatStream.activity.priorityHigh",
  medium: "chatStream.activity.priorityMedium",
  low: "chatStream.activity.priorityLow",
};

/** Left status stripe of a settled subagent row (running rows get the shimmer
 *  utility instead). */
const SUBAGENT_BAR: Record<SubagentSnapshot["status"], string> = {
  running: "",
  completed: "bg-accent/50",
  failed: "bg-danger/50",
  killed: "bg-danger/50",
};

/* ── Small primitives ───────────────────────────────────────────────── */

/** A chip-shaped filter tab. `n` is the count badge; omitted when undefined so
 *  a tab can exist without a number. */
function FilterChip({
  label,
  n,
  active,
  onClick,
}: {
  label: string;
  n?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-semibold transition-colors",
        active
          ? "border-edge bg-surface-muted text-content"
          : "border-transparent text-content-subtle hover:bg-surface-muted/70 hover:text-content",
      )}
    >
      {label}
      {typeof n === "number" && (
        <span
          className={cn(
            "rounded-full px-1 text-[9px] tabular-nums",
            active ? "bg-accent/15 text-accent-strong" : "bg-surface-muted text-content-muted",
          )}
        >
          {n}
        </span>
      )}
    </button>
  );
}

/** Sticky group header inside the body ("运行中 · 3"). */
function GroupHead({ label, n }: { label: string; n: number }) {
  return (
    <div className="sticky top-0 z-10 flex items-center gap-2 bg-surface/95 px-3 py-1.5 text-[10px] font-bold tracking-wide text-content-subtle backdrop-blur-sm">
      {label}
      <span className="ml-auto tabular-nums">{n}</span>
    </div>
  );
}

/** A one-line summary stat with a hairline separator between stats. */
function Stat({ value, label }: { value: ReactNode; label?: string }) {
  return (
    <span className="whitespace-nowrap">
      <b className="font-semibold text-content">{value}</b>
      {label ? ` ${label}` : ""}
    </span>
  );
}

function Sep() {
  return <span aria-hidden className="h-2.5 w-px shrink-0 bg-edge" />;
}

/** Local-midnight boundary — bookmarks group by "today" vs "earlier" rather
 *  than by absolute timestamps. */
function startOfToday(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/* ── Body: subagents ────────────────────────────────────────────────── */

function SubagentRow({
  agent,
  bar,
  now,
  t,
  onPick,
}: {
  agent: SubagentSnapshot;
  bar?: { leftPct: number; widthPct: number };
  now: number;
  t: Translate;
  onPick?: (agent: SubagentSnapshot) => void;
}) {
  const meta = SUBAGENT_STATUS_META[agent.status];
  const StatusIcon = SUBAGENT_STATUS_ICON[agent.status];
  const win = subagentEndpoints(agent, now);
  const running = agent.status === "running";
  const chips: string[] = [];
  if (typeof agent.totalTokens === "number") chips.push(`${(agent.totalTokens / 1000).toFixed(1)}k tok`);
  if (typeof agent.toolUses === "number") chips.push(`${agent.toolUses} tools`);
  chips.push(formatDuration(win.end - win.start));

  return (
    <li
      onClick={onPick ? () => onPick(agent) : undefined}
      title={onPick ? t("chatStream.activity.viewSubagent") : undefined}
      className={cn(
        "group relative border-b border-edge/35 py-2 pl-3.5 pr-3 last:border-b-0",
        onPick && "cursor-pointer hover:bg-surface-muted/60",
      )}
    >
      {/* Left stripe: a sweeping shimmer while the agent is alive, a static
          tint once it settles. */}
      {running ? (
        <span aria-hidden className="capsule-shimmer-track" />
      ) : (
        <span
          aria-hidden
          className={cn("absolute bottom-2 left-0 top-2 w-[2px] rounded-full", SUBAGENT_BAR[agent.status])}
        />
      )}
      <div className="flex items-center gap-1.5">
        {agent.subagentType && (
          <span className="rounded bg-info/20 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-info">
            {agent.subagentType}
          </span>
        )}
        <span className={cn("flex items-center gap-1 text-[10px] font-semibold", meta.cls)}>
          {meta.spin && <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-warning" />}
          <StatusIcon size={11} className={cn(meta.spin && "animate-spin")} />
          {t(meta.labelKey)}
        </span>
        <span className="ml-auto shrink-0 text-[9.5px] tabular-nums text-content-subtle">
          {formatClock(win.start)} → {running ? t("chatStream.activity.now") : formatClock(win.end)}
        </span>
      </div>
      <p className="mt-1 truncate text-[11.5px] text-content" title={agent.description}>
        {agent.description || t("chatStream.activity.noDescription")}
      </p>
      {agent.error ? (
        <p className="mt-0.5 text-[10px] text-danger">{agent.error}</p>
      ) : (
        agent.summary && (
          <p className="mt-0.5 truncate text-[10px] italic text-content-subtle" title={agent.summary}>
            {agent.summary}
          </p>
        )
      )}
      <div className="mt-1 flex flex-wrap items-center gap-1">
        {running && agent.lastToolName && (
          <span className="rounded bg-surface-muted px-1.5 py-0.5 text-[9px] font-medium tabular-nums text-content-muted">
            {agent.lastToolName}
          </span>
        )}
        {chips.map((c) => (
          <span key={c} className="rounded bg-surface-muted px-1.5 py-0.5 text-[9px] tabular-nums text-content-subtle">
            {c}
          </span>
        ))}
        {onPick && (
          <span className="ml-auto text-[10px] font-semibold text-accent-strong opacity-0 transition-opacity group-hover:opacity-100">
            {t("chatStream.activity.viewSubagent")}
          </span>
        )}
      </div>
      {/* This agent's span on the session's shared agent axis. */}
      {bar && (
        <span aria-hidden className="relative mt-1.5 block h-1 overflow-hidden rounded-full bg-surface-muted">
          <span
            className={cn("absolute inset-y-0 rounded-full", running ? "bg-warning/85" : SUBAGENT_BAR[agent.status])}
            style={{ left: `${bar.leftPct}%`, width: `${bar.widthPct}%` }}
          />
          <span className="absolute -inset-y-px right-0 w-px bg-content-subtle/55" />
        </span>
      )}
    </li>
  );
}

function SubagentsBody({
  agents,
  tab,
  now,
  t,
  onPick,
}: {
  agents: SubagentSnapshot[];
  tab: string;
  now: number;
  t: Translate;
  onPick?: (agent: SubagentSnapshot) => void;
}) {
  const bars = subagentTimeline(agents, now).bars;
  const running = agents.filter((a) => a.status === "running");
  const settled = agents.filter((a) => a.status !== "running");
  const completed = settled.filter((a) => a.status === "completed");
  const failed = settled.filter((a) => a.status === "failed");

  const groups: { key: string; label: string; list: SubagentSnapshot[] }[] =
    tab === "running"
      ? [{ key: "running", label: t("chatStream.activity.groupRunning"), list: running }]
      : tab === "completed"
        ? [{ key: "completed", label: t("chatStream.activity.groupCompleted"), list: completed }]
        : tab === "failed"
          ? [{ key: "failed", label: t("chatStream.activity.groupFailed"), list: failed }]
          : [
              { key: "running", label: t("chatStream.activity.groupRunning"), list: running },
              { key: "settled", label: t("chatStream.activity.groupSettled"), list: settled },
            ];

  const visible = groups.filter((g) => g.list.length > 0);
  if (visible.length === 0) {
    return <EmptyGroup t={t} />;
  }

  return (
    <div>
      {visible.map((g) => (
        <div key={g.key}>
          <GroupHead label={g.label} n={g.list.length} />
          <ul>
            {g.list.map((a) => (
              <SubagentRow key={a.taskId} agent={a} bar={bars.get(a.taskId)} now={now} t={t} onPick={onPick} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/* ── Body: tasks ────────────────────────────────────────────────────── */

function TasksBody({ todos, tab, t }: { todos: TodoItem[]; tab: string; t: Translate }) {
  const inProgress = todos.filter((x) => x.status === "in_progress");
  const pending = todos.filter((x) => x.status === "pending");
  const completed = todos.filter((x) => x.status === "completed");

  const groups: { key: string; label: string; list: TodoItem[] }[] =
    tab === "in_progress"
      ? [{ key: "in_progress", label: t("chatStream.activity.groupInProgress"), list: inProgress }]
      : tab === "pending"
        ? [{ key: "pending", label: t("chatStream.activity.groupPending"), list: pending }]
        : tab === "completed"
          ? [{ key: "completed", label: t("chatStream.activity.groupCompleted"), list: completed }]
          : [
              { key: "in_progress", label: t("chatStream.activity.groupInProgress"), list: inProgress },
              { key: "pending", label: t("chatStream.activity.groupPending"), list: pending },
              { key: "completed", label: t("chatStream.activity.groupCompleted"), list: completed },
            ];

  const visible = groups.filter((g) => g.list.length > 0);
  if (visible.length === 0) {
    return <EmptyGroup t={t} />;
  }

  return (
    <div>
      {visible.map((g) => (
        <div key={g.key}>
          <GroupHead label={g.label} n={g.list.length} />
          <ul>
            {g.list.map((td, i) => {
              const meta = TODO_META[td.status];
              const Ico = meta.ico;
              return (
                <li
                  key={`${g.key}:${i}`}
                  className={cn(
                    "flex items-start gap-2 border-l-2 px-3 py-1.5 transition-colors hover:bg-surface-muted/60",
                    PRIORITY_STRIPE[td.priority],
                  )}
                >
                  <Ico size={11} className={cn("mt-0.5 shrink-0", meta.cls, meta.spin && "animate-spin")} />
                  <span
                    className={cn(
                      "text-[11px] leading-relaxed",
                      td.status === "completed" ? "text-content-subtle line-through" : "text-content-muted",
                    )}
                  >
                    {td.content}
                  </span>
                  {td.status === "pending" && (
                    <span className="ml-auto shrink-0 rounded px-1 py-0.5 text-[9px] text-content-subtle">
                      {t(PRIORITY_LABEL_KEY[td.priority])}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

/* ── Body: plans ────────────────────────────────────────────────────── */

function PlansBody({
  planBlocks,
  tab,
  t,
  onPickPlan,
}: {
  planBlocks: PlanBlock[];
  tab: string;
  t: Translate;
  onPickPlan: (plan: string) => void;
}) {
  // Newest first: the last block in the stream is the most recent plan. The
  // ordinal stays chronological ("第 3 份") so the numbering is stable when a
  // new plan arrives.
  const ordered = [...planBlocks].reverse().map((block, i) => ({ block, ordinal: planBlocks.length - i }));
  const list = tab === "latest" ? ordered.slice(0, 1) : ordered;
  return (
    <ul>
      {list.map(({ block, ordinal }, i) => {
        const title = extractPlanTitle(block.plan) || t("chatStream.activity.planFallback", { n: ordinal });
        const excerpt = extractPlanExcerpt(block.plan);
        const latest = i === 0;
        return (
          <li key={block.planId} className="border-b border-edge/35 last:border-b-0">
            <button
              type="button"
              onClick={() => onPickPlan(block.plan)}
              title={t("chatStream.activity.viewPlan")}
              className="group flex w-full items-start gap-2 px-3 py-2 text-left transition-colors hover:bg-surface-muted/60"
            >
              <span
                className={cn(
                  "mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md text-[9.5px] font-bold tabular-nums",
                  latest ? "bg-accent/15 text-accent-strong" : "bg-surface-muted text-content-muted",
                )}
              >
                {ordinal}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-[11.5px] font-semibold text-content">{title}</span>
                  {latest && (
                    <span className="shrink-0 rounded bg-accent/15 px-1 py-0.5 text-[9px] font-bold text-accent-strong">
                      {t("chatStream.activity.latestChip")}
                    </span>
                  )}
                </span>
                {excerpt && (
                  <span className="mt-1 line-clamp-2 text-[10.5px] leading-relaxed text-content-subtle">
                    {excerpt}
                  </span>
                )}
              </span>
              <span className="mt-0.5 shrink-0 text-[10px] font-semibold text-accent-strong opacity-0 transition-opacity group-hover:opacity-100">
                {t("chatStream.activity.openPlan")}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/* ── Body: bookmarks ────────────────────────────────────────────────── */

function BookmarkRow({
  bookmark,
  stale,
  t,
  onPick,
  onRemove,
  onRename,
}: {
  bookmark: SessionBookmark;
  stale: boolean;
  t: Translate;
  onPick?: (b: SessionBookmark) => void;
  onRemove?: (b: SessionBookmark) => void;
  onRename?: (b: SessionBookmark, title: string) => void;
}) {
  // Inline-edit state for ONE row at a time (the panel is transient).
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const label = bookmark.title ?? bookmark.excerpt;

  const commit = () => {
    setEditing(false);
    onRename?.(bookmark, draft);
  };

  return (
    <li className="group/row relative">
      {/* Dot on the shared vertical axis (drawn by the group's <ul>). */}
      <span
        aria-hidden
        className={cn(
          "absolute -left-[15px] top-1/2 h-2 w-2 -translate-y-1/2 rounded-full",
          stale ? "bg-content-subtle" : "bg-warning",
        )}
      />
      {editing ? (
        <div className="flex items-center py-1 pr-2">
          <input
            autoFocus
            value={draft}
            maxLength={80}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              else if (e.key === "Escape") setEditing(false);
            }}
            onBlur={commit}
            placeholder={t("chatStream.bookmark.renamePlaceholder")}
            className="min-w-0 flex-1 rounded border border-accent/50 bg-surface-muted px-1.5 py-0.5 text-[11px] text-content outline-none"
          />
        </div>
      ) : (
        <>
          <button
            type="button"
            disabled={stale || !onPick}
            onClick={() => onPick?.(bookmark)}
            title={stale ? undefined : bookmark.title ? bookmark.excerpt : t("chatStream.bookmark.jumpTitle")}
            className={cn(
              "flex w-full items-center gap-2 py-1.5 pr-12 text-left transition-colors",
              stale || !onPick ? "cursor-default" : "hover:bg-surface-muted/60",
            )}
          >
            <span className={cn("min-w-0 flex-1 truncate text-[11px]", stale ? "text-content-subtle" : "text-content")}>
              {label}
            </span>
            {stale ? (
              <span className="shrink-0 rounded bg-surface-muted px-1 text-[9px] text-content-subtle">
                {t("chatStream.bookmark.stale")}
              </span>
            ) : (
              <span className="shrink-0 text-[9px] tabular-nums text-content-subtle">
                {formatClock(bookmark.createdAt).slice(0, 5)}
              </span>
            )}
          </button>
          {onRename && (
            <button
              type="button"
              onClick={() => {
                setDraft(bookmark.title ?? "");
                setEditing(true);
              }}
              title={t("chatStream.bookmark.rename")}
              className="absolute right-7 top-1/2 hidden -translate-y-1/2 rounded p-0.5 text-content-subtle transition-colors hover:bg-surface-hover hover:text-content group-hover/row:block"
            >
              <IconPencil size={11} />
            </button>
          )}
          {onRemove && (
            <button
              type="button"
              onClick={() => onRemove(bookmark)}
              title={t("chatStream.bookmark.remove")}
              className="absolute right-1.5 top-1/2 hidden -translate-y-1/2 rounded p-0.5 text-content-subtle transition-colors hover:bg-surface-hover hover:text-danger group-hover/row:block"
            >
              <IconX size={11} />
            </button>
          )}
        </>
      )}
    </li>
  );
}

function BookmarksBody({
  bookmarks,
  tab,
  now,
  isStale,
  t,
  onPick,
  onRemove,
  onRename,
}: {
  bookmarks: SessionBookmark[];
  tab: string;
  now: number;
  isStale: (b: SessionBookmark) => boolean;
  t: Translate;
  onPick?: (b: SessionBookmark) => void;
  onRemove?: (b: SessionBookmark) => void;
  onRename?: (b: SessionBookmark, title: string) => void;
}) {
  const groups = bookmarkGroups(bookmarks, now, isStale);
  const selected =
    tab === "today"
      ? groups.filter((g) => g.key === "today")
      : tab === "earlier"
        ? groups.filter((g) => g.key === "earlier")
        : tab === "stale"
          ? groups.filter((g) => g.key === "stale")
          : groups;

  const visible = selected.filter((g) => g.list.length > 0);
  if (visible.length === 0) {
    return <EmptyGroup t={t} />;
  }

  return (
    <div>
      {visible.map((g) => (
        <div key={g.key}>
          <GroupHead label={t(BOOKMARK_GROUP_LABEL[g.key])} n={g.list.length} />
          <ul className="mx-3 mb-2 border-l border-edge pl-3">
            {g.list.map((b) => (
              <BookmarkRow
                key={b.id}
                bookmark={b}
                stale={isStale(b)}
                t={t}
                onPick={onPick}
                onRemove={onRemove}
                onRename={onRename}
              />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** Bucket headers for the bookmark axis. `bookmarkGroups` returns bare keys so
 *  the shell can count buckets without a translator; the body resolves the
 *  label here. */
const BOOKMARK_GROUP_LABEL: Record<"today" | "earlier" | "stale", "chatStream.activity.groupToday" | "chatStream.activity.groupEarlier" | "chatStream.activity.groupStale"> = {
  today: "chatStream.activity.groupToday",
  earlier: "chatStream.activity.groupEarlier",
  stale: "chatStream.activity.groupStale",
};

/** Bookmarks split into today / earlier / stale buckets, newest first — the
 *  most recent bookmark is the likeliest jump target. Shared by the body and
 *  the shell's stats/tab counts so the numbers cannot disagree. */
function bookmarkGroups(
  bookmarks: SessionBookmark[],
  now: number,
  isStale: (b: SessionBookmark) => boolean,
): { key: "today" | "earlier" | "stale"; list: SessionBookmark[] }[] {
  const midnight = startOfToday(now);
  const ordered = [...bookmarks].reverse();
  const stale = ordered.filter(isStale);
  const fresh = ordered.filter((b) => !isStale(b));
  return [
    { key: "today", list: fresh.filter((b) => b.createdAt >= midnight) },
    { key: "earlier", list: fresh.filter((b) => b.createdAt < midnight) },
    { key: "stale", list: stale },
  ];
}

function EmptyGroup({ t }: { t: Translate }) {
  return (
    <p className="px-3 py-6 text-center text-[11px] text-content-subtle">{t("chatStream.activity.emptyGroup")}</p>
  );
}

/* ── Shell ──────────────────────────────────────────────────────────── */

export interface ActivityConsoleProps {
  /** Which node's body to show. */
  node: ActivityNodeKey;
  subagents: SubagentSnapshot[];
  todos: TodoItem[];
  planBlocks: PlanBlock[];
  bookmarks: SessionBookmark[];
  isBookmarkStale?: (b: SessionBookmark) => boolean;
  /** Active filter tab per node + setter (owned by the rail so it survives
   *  open/close cycles). */
  tabs: ActivityTabs;
  onTabChange: (node: ActivityNodeKey, tab: string) => void;
  onClose: () => void;
  onPickPlan: (plan: string) => void;
  onPickSubagent?: (agent: SubagentSnapshot) => void;
  onPickBookmark?: (b: SessionBookmark) => void;
  onRemoveBookmark?: (b: SessionBookmark) => void;
  onRenameBookmark?: (b: SessionBookmark, title: string) => void;
  /** Show the node-kind tab strip above the header. The rail is the switcher
   *  on desktop, so only the mobile sheet turns this on. */
  nodeTabs?: boolean;
  /** Sheet-only: switch node kind (paired with `nodeTabs`). */
  onPickNode?: (node: ActivityNodeKey) => void;
  /** Show the "Esc 关闭" hint in the footer. Desktop panel only — the mobile
   *  sheet has no Escape key. */
  showKeyHint?: boolean;
}
export function ActivityConsole({
  node,
  subagents,
  todos,
  planBlocks,
  bookmarks,
  isBookmarkStale,
  tabs,
  onTabChange,
  onClose,
  onPickPlan,
  onPickSubagent,
  onPickBookmark,
  onRemoveBookmark,
  onRenameBookmark,
  nodeTabs = false,
  onPickNode,
  showKeyHint = false,
}: ActivityConsoleProps) {
  const { t } = useI18n();
  const now = useNow();
  const meta = NODE_META[node];
  const Ico = meta.ico;
  const stale = isBookmarkStale ?? (() => false);
  const tab = tabs[node] ?? "all";

  const runningAgents = subagents.filter((a) => a.status === "running");
  const settledAgents = subagents.filter((a) => a.status !== "running");
  const doneTodos = todos.filter((x) => x.status === "completed");
  const todoPct = todos.length > 0 ? Math.round((doneTodos.length / todos.length) * 100) : 0;
  const bmGroups = bookmarkGroups(bookmarks, now, stale);
  const bmCount = (key: "today" | "earlier" | "stale") => bmGroups.find((g) => g.key === key)?.list.length ?? 0;

  /* Header subtitle, aggregate stats, filter tabs and footer per kind — kept
     in one place so a kind's numbers agree across all bands. */
  let subtitle = "";
  let stats: ReactNode = null;
  let filters: { key: string; label: string; n?: number }[] = [];
  let footer = "";
  let rightAction: { label: string; run: () => void } | null = null;

  if (node === "subagents") {
    const failed = settledAgents.filter((a) => a.status === "failed").length;
    subtitle = runningAgents.length
      ? t("chatStream.activity.subagentsSubRunning", { running: runningAgents.length, ended: settledAgents.length })
      : t("chatStream.activity.subagentsSubIdle", { n: subagents.length });
    stats = (
      <>
        <Stat value={subagents.length} label={t("chatStream.activity.unitAgents")} />
        <Sep />
        <Stat value={runningAgents.length} label={t("chatStream.activity.labelRunning")} />
        <Sep />
        <Stat value={`${(subagents.reduce((a, s) => a + (s.totalTokens ?? 0), 0) / 1000).toFixed(1)}k`} label="tok" />
        <Sep />
        <Stat value={subagents.reduce((a, s) => a + (s.toolUses ?? 0), 0)} label="tools" />
        <Sep />
        <Stat
          value={formatDuration(subagents.reduce((a, s) => a + (s.durationMs ?? 0), 0))}
          label={t("chatStream.activity.labelCumulative")}
        />
      </>
    );
    filters = [
      { key: "all", label: t("chatStream.activity.tabAll"), n: subagents.length },
      { key: "running", label: t("chatStream.activity.groupRunning"), n: runningAgents.length },
      { key: "completed", label: t("chatStream.activity.groupCompleted"), n: settledAgents.length - failed },
      { key: "failed", label: t("chatStream.activity.groupFailed"), n: failed },
    ];
    footer = t("chatStream.activity.subagentsFooter");
    const target = runningAgents[0] ?? subagents[0];
    if (onPickSubagent && target) {
      rightAction = { label: t("chatStream.activity.viewSubagent"), run: () => onPickSubagent(target) };
    }
  } else if (node === "tasks") {
    subtitle = t("chatStream.activity.tasksSubtitle", {
      done: doneTodos.length,
      total: todos.length,
      rest: todos.length - doneTodos.length,
    });
    stats = (
      <span className="flex w-full items-center gap-2.5">
        <span
          aria-hidden
          className="relative grid h-[34px] w-[34px] shrink-0 place-items-center rounded-full"
          style={{ background: `conic-gradient(rgb(var(--accent)) ${todoPct}%, rgb(var(--surface-hover)) 0)` }}
        >
          <span className="absolute inset-[4px] rounded-full bg-surface" />
          <span className="relative text-[9.5px] font-bold tabular-nums">{todoPct}%</span>
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-1 text-[11px] text-content-muted">
            <b className="text-[12px] tabular-nums text-content">
              {doneTodos.length} / {todos.length}
            </b>
            {t("chatStream.activity.tasksDoneSuffix")}
            <span className="ml-auto text-[10px] text-content-subtle">
              {t("chatStream.activity.tasksRest", { n: todos.length - doneTodos.length })}
            </span>
          </span>
          <span aria-hidden className="mt-1 flex h-1.5 gap-0.5">
            {todos.map((x, i) => (
              <span
                key={i}
                className={cn(
                  "flex-1 rounded-[2px]",
                  x.status === "completed" ? "bg-accent" : x.status === "in_progress" ? "bg-warning" : "bg-surface-hover",
                )}
              />
            ))}
          </span>
        </span>
      </span>
    );
    filters = [
      { key: "all", label: t("chatStream.activity.tabAll"), n: todos.length },
      {
        key: "in_progress",
        label: t("chatStream.activity.groupInProgress"),
        n: todos.filter((x) => x.status === "in_progress").length,
      },
      { key: "pending", label: t("chatStream.activity.groupPending"), n: todos.filter((x) => x.status === "pending").length },
      { key: "completed", label: t("chatStream.activity.groupCompleted"), n: doneTodos.length },
    ];
    footer = t("chatStream.activity.tasksFooter");
  } else if (node === "plans") {
    subtitle = t("chatStream.activity.plansSubtitle", { n: planBlocks.length });
    stats = (
      <>
        <Stat value={planBlocks.length} label={t("chatStream.activity.unitPlans")} />
        <Sep />
        <Stat value={t("chatStream.activity.latestChip")} />
      </>
    );
    filters = [
      { key: "all", label: t("chatStream.activity.tabAll"), n: planBlocks.length },
      { key: "latest", label: t("chatStream.activity.latestChip"), n: 1 },
    ];
    footer = t("chatStream.activity.plansFooter");
    const newest = planBlocks[planBlocks.length - 1];
    if (newest) rightAction = { label: t("chatStream.activity.openPlan"), run: () => onPickPlan(newest.plan) };
  } else {
    subtitle = bmCount("stale")
      ? t("chatStream.activity.bookmarksSubStale", { n: bookmarks.length, stale: bmCount("stale") })
      : t("chatStream.activity.bookmarksSub", { n: bookmarks.length });
    stats = (
      <>
        <Stat value={bookmarks.length} label={t("chatStream.activity.unitBookmarks")} />
        <Sep />
        <Stat value={bmCount("today")} label={t("chatStream.activity.groupToday")} />
        <Sep />
        <Stat value={bmCount("earlier")} label={t("chatStream.activity.groupEarlier")} />
        {bmCount("stale") > 0 && (
          <>
            <Sep />
            <span className="text-danger">
              <Stat value={bmCount("stale")} label={t("chatStream.activity.groupStale")} />
            </span>
          </>
        )}
      </>
    );
    filters = [
      { key: "all", label: t("chatStream.activity.tabAll"), n: bookmarks.length },
      { key: "today", label: t("chatStream.activity.groupToday"), n: bmCount("today") },
      { key: "earlier", label: t("chatStream.activity.groupEarlier"), n: bmCount("earlier") },
      { key: "stale", label: t("chatStream.activity.groupStale"), n: bmCount("stale") },
    ];
    footer = t("chatStream.activity.bookmarksFooter");
  }

  // A filter that would show nothing is dropped (a session with no failed
  // agents does not need a "失败 0" chip); "all" always stays.
  const shownFilters = filters.filter((f) => f.key === "all" || (f.n ?? 0) > 0);

  const body =
    node === "subagents" ? (
      <SubagentsBody agents={subagents} tab={tab} now={now} t={t} onPick={onPickSubagent} />
    ) : node === "tasks" ? (
      <TasksBody todos={todos} tab={tab} t={t} />
    ) : node === "plans" ? (
      <PlansBody planBlocks={planBlocks} tab={tab} t={t} onPickPlan={onPickPlan} />
    ) : (
      <BookmarksBody
        bookmarks={bookmarks}
        tab={tab}
        now={now}
        isStale={stale}
        t={t}
        onPick={onPickBookmark}
        onRemove={onRemoveBookmark}
        onRename={onRenameBookmark}
      />
    );

  return (
    // flex-auto (basis auto) rather than flex-1: the host frame has an
    // auto height, and a `flex-basis: 0` child contributes no height to it —
    // the console would collapse to 0. Content-based basis keeps the frame
    // sized to the console while `min-h-0` still lets it shrink under the
    // frame's max-height (which is what makes the body scroll).
    <div className="flex min-h-0 flex-auto flex-col text-content">
      {/* Sheet-only node switcher: the rail is not on screen there, so the
          panel needs its own way to move between kinds. */}
      {nodeTabs && onPickNode && (
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-edge/60 px-2 py-2">
          {RAIL_NODE_ORDER.filter((k) => k === node || hasNodeData(k, subagents, todos, planBlocks, bookmarks)).map((k) => {
            const m = NODE_META[k];
            const K = m.ico;
            const active = k === node;
            return (
              <button
                key={k}
                type="button"
                onClick={() => onPickNode(k)}
                className={cn(
                  "flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors",
                  active ? "border-edge bg-surface-muted text-content" : "border-transparent text-content-subtle",
                )}
              >
                <K size={13} />
                {t(m.labelKey)}
              </button>
            );
          })}
        </div>
      )}

      {/* Header: identity + what this kind is doing right now + actions. */}
      <div className="flex shrink-0 items-center gap-2 px-3 py-2.5">
        <span className={cn("grid h-7 w-7 shrink-0 place-items-center rounded-[9px]", meta.icoCls)}>
          <Ico size={15} />
        </span>
        <span className="min-w-0 flex-1">
          <b className="block truncate text-[12.5px] font-bold tracking-tight">{t(meta.labelKey)}</b>
          <span className="block truncate text-[10.5px] text-content-subtle">{subtitle}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {rightAction && (
            <button
              type="button"
              onClick={rightAction.run}
              title={rightAction.label}
              className="grid h-6 w-6 place-items-center rounded-[7px] border border-edge bg-surface-muted/60 text-content-muted transition-colors hover:bg-surface-hover hover:text-content"
            >
              <IconLayoutSidebarRightExpand size={13} />
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            title={t("chatStream.activity.close")}
            className="grid h-6 w-6 place-items-center rounded-[7px] border border-edge bg-surface-muted/60 text-content-muted transition-colors hover:bg-surface-hover hover:text-content"
          >
            <IconX size={13} />
          </button>
        </span>
      </div>

      {/* Aggregate numbers for this kind. */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-y border-edge/50 bg-surface-muted/40 px-3 py-2 text-[10.5px] tabular-nums text-content-subtle">
        {stats}
      </div>

      {/* Filter chips. */}
      {shownFilters.length > 1 && (
        <div className="flex shrink-0 flex-wrap gap-1 px-2.5 pb-1 pt-2">
          {shownFilters.map((f) => (
            <FilterChip
              key={f.key}
              label={f.label}
              n={f.n}
              active={tab === f.key}
              onClick={() => onTabChange(node, f.key)}
            />
          ))}
        </div>
      )}

      {/* Body — the panel's only scroll area. */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{body}</div>

      <div className="flex shrink-0 items-center gap-1.5 border-t border-edge/50 bg-surface-muted/30 px-3 py-2 text-[10px] text-content-subtle">
        {footer}
        {showKeyHint && (
          <span className="ml-auto flex shrink-0 items-center gap-1">
            <kbd className="rounded border border-edge bg-surface px-1 text-[9px]">Esc</kbd>
            {t("chatStream.activity.close")}
          </span>
        )}
      </div>
    </div>
  );
}

/** Which nodes carry data in this session — drives the sheet's node tabs and
 *  the rail's node list from ONE rule, so the two can't disagree about what
 *  "has activity" means. */
export function hasNodeData(
  node: ActivityNodeKey,
  subagents: SubagentSnapshot[],
  todos: TodoItem[],
  planBlocks: PlanBlock[],
  bookmarks: SessionBookmark[],
): boolean {
  if (node === "subagents") return subagents.length > 0;
  if (node === "tasks") return todos.length > 0;
  if (node === "plans") return planBlocks.length > 0;
  return bookmarks.length > 0;
}
