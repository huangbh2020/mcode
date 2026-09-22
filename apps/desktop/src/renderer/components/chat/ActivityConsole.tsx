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
  IconClock,
  IconExternalLink,
  IconLayoutSidebarRightExpand,
  IconListDetails,
  IconLoader2,
  IconPencil,
  IconPlayerStop,
  IconPlus,
  IconServer,
  IconTerminal2,
  IconX,
  PiRobot,
} from "@renderer/lib/icons.js";
import type { SubagentSnapshot, BashTaskSnapshot, ServiceSnapshot } from "@contracts/runtime";
import type { SessionBookmark } from "@contracts/session";
import type { Automation } from "@contracts/automation";
import { describeSchedule, isInFlightAutomation, formatUntil, sortAutomations } from "@renderer/components/automation/automationFormat.js";
import type { TodoItem } from "@renderer/stores/sessionStore.js";
import {
  BASH_TASK_STATUS_META,
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
  pending: { ico: IconCircle, cls: "text-white/40" },
  in_progress: { ico: IconLoader2, cls: "text-warning", spin: true },
  completed: { ico: IconCheck, cls: "text-accent" },
};

const PRIORITY_STRIPE: Record<TodoItem["priority"], string> = {
  high: "border-l-danger/60",
  medium: "border-l-warning/60",
  low: "border-l-white/20",
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
        "flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[10.5px] font-semibold transition-all",
        active
          ? "border-slate-300 bg-slate-200/80 text-slate-900 shadow-sm dark:border-white/20 dark:bg-white/15 dark:text-white"
          : "border-transparent text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-white/60 dark:hover:bg-white/[0.08] dark:hover:text-white",
      )}
    >
      {label}
      {typeof n === "number" && (
        <span
          className={cn(
            "rounded-full px-1 text-[9px] tabular-nums",
            active ? "bg-accent/20 text-accent font-bold" : "bg-slate-200 text-slate-700 dark:bg-white/10 dark:text-white/60",
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
    <div className="sticky top-0 z-10 flex items-center gap-2 border-y border-slate-200 bg-white/95 px-3 py-1.5 text-[10px] font-bold tracking-wide text-slate-600 backdrop-blur-md dark:border-white/[0.06] dark:bg-[#0c0d12]/95 dark:text-white/60">
      {label}
      <span className="ml-auto tabular-nums">{n}</span>
    </div>
  );
}

/** A one-line summary stat with a hairline separator between stats. */
function Stat({ value, label }: { value: ReactNode; label?: string }) {
  return (
    <span className="whitespace-nowrap">
      <b className="font-semibold text-slate-900 dark:text-white">{value}</b>
      {label ? ` ${label}` : ""}
    </span>
  );
}

function Sep() {
  return <span aria-hidden className="h-2.5 w-px shrink-0 bg-slate-300 dark:bg-white/20" />;
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
        "group relative border-b border-slate-200 py-2.5 pl-3.5 pr-3 transition-colors last:border-b-0 dark:border-white/[0.08]",
        onPick && "cursor-pointer hover:bg-slate-100/70 dark:hover:bg-white/[0.04]",
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
          <span className="rounded-md bg-info/20 px-1.5 py-0.5 text-[9.5px] font-medium uppercase tracking-wide text-info">
            {agent.subagentType}
          </span>
        )}
        <span className={cn("flex items-center gap-1 text-[10.5px] font-semibold", meta.cls)}>
          {meta.spin && <span className="apple-live-dot bg-warning mr-0.5" />}
          <StatusIcon size={12} className={cn(meta.spin && "animate-spin")} />
          {t(meta.labelKey)}
        </span>
        <span className="ml-auto shrink-0 text-[10px] tabular-nums text-slate-500 dark:text-white/50">
          {formatClock(win.start)} → {running ? t("chatStream.activity.now") : formatClock(win.end)}
        </span>
      </div>
      <p className="mt-1 truncate text-[11.5px] font-medium text-slate-900 dark:text-white/90" title={agent.description}>
        {agent.description || t("chatStream.activity.noDescription")}
      </p>
      {agent.error ? (
        <p className="mt-0.5 text-[10px] text-danger">{agent.error}</p>
      ) : (
        agent.summary && (
          <p className="mt-0.5 truncate text-[10px] italic text-slate-500 dark:text-white/50" title={agent.summary}>
            {agent.summary}
          </p>
        )
      )}
      <div className="mt-1 flex flex-wrap items-center gap-1">
        {running && agent.lastToolName && (
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[9px] font-medium tabular-nums text-slate-700 dark:bg-white/10 dark:text-white/80">
            {agent.lastToolName}
          </span>
        )}
        {chips.map((c) => (
          <span key={c} className="rounded bg-slate-100 px-1.5 py-0.5 text-[9px] tabular-nums text-slate-600 dark:bg-white/10 dark:text-white/60">
            {c}
          </span>
        ))}
        {onPick && (
          <span className="ml-auto text-[10px] font-semibold text-accent opacity-0 transition-opacity group-hover:opacity-100">
            {t("chatStream.activity.viewSubagent")}
          </span>
        )}
      </div>
      {/* This agent's span on the session's shared agent axis. */}
      {bar && (
        <span aria-hidden className="relative mt-1.5 block h-1 overflow-hidden rounded-full bg-slate-200 dark:bg-white/10">
          <span
            className={cn("absolute inset-y-0 rounded-full", running ? "bg-warning/85" : SUBAGENT_BAR[agent.status])}
            style={{ left: `${bar.leftPct}%`, width: `${bar.widthPct}%` }}
          />
          <span className="absolute -inset-y-px right-0 w-px bg-slate-300 dark:bg-white/30" />
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
                    "flex items-start gap-2 border-l-2 px-3 py-1.5 transition-colors hover:bg-slate-100/70 dark:hover:bg-white/[0.04]",
                    PRIORITY_STRIPE[td.priority],
                  )}
                >
                  <Ico size={11} className={cn("mt-0.5 shrink-0", meta.cls, meta.spin && "animate-spin")} />
                  <span
                    className={cn(
                      "text-[11px] leading-relaxed",
                      td.status === "completed" ? "text-slate-400 line-through dark:text-white/40" : "text-slate-800 dark:text-white/90",
                    )}
                  >
                    {td.content}
                  </span>
                  {td.status === "pending" && (
                    <span className="ml-auto shrink-0 rounded bg-slate-100 px-1 py-0.5 text-[9px] text-slate-500 dark:bg-white/[0.06] dark:text-white/50">
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
          <li key={block.planId} className="border-b border-slate-200 last:border-b-0 dark:border-white/[0.08]">
            <button
              type="button"
              onClick={() => onPickPlan(block.plan)}
              title={t("chatStream.activity.viewPlan")}
              className="group flex w-full items-start gap-2 px-3 py-2 text-left transition-colors hover:bg-slate-100/70 dark:hover:bg-white/[0.04]"
            >
              <span
                className={cn(
                  "mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md text-[9.5px] font-bold tabular-nums",
                  latest ? "bg-accent/20 text-accent" : "bg-slate-100 text-slate-700 dark:bg-white/10 dark:text-white/70",
                )}
              >
                {ordinal}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-[11.5px] font-semibold text-slate-900 dark:text-white">{title}</span>
                  {latest && (
                    <span className="shrink-0 rounded bg-accent/20 px-1 py-0.5 text-[9px] font-bold text-accent">
                      {t("chatStream.activity.latestChip")}
                    </span>
                  )}
                </span>
                {excerpt && (
                  <span className="mt-1 line-clamp-2 text-[10.5px] leading-relaxed text-slate-600 dark:text-white/60">
                    {excerpt}
                  </span>
                )}
              </span>
              <span className="mt-0.5 shrink-0 text-[10px] font-semibold text-accent opacity-0 transition-opacity group-hover:opacity-100">
                {t("chatStream.activity.openPlan")}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/* ── Body: commands (agent-started bash tasks) ──────────────────────── */

const BASH_TASK_STATUS_ICON: Record<BashTaskSnapshot["status"], ComponentType<TablerIconProps>> = {
  running: IconTerminal2,
  completed: IconCheck,
  failed: IconX,
  killed: IconX,
};

function BashTaskRow({
  task,
  now,
  t,
  onStop,
}: {
  task: BashTaskSnapshot;
  now: number;
  t: Translate;
  onStop?: (task: BashTaskSnapshot) => void;
}) {
  const meta = BASH_TASK_STATUS_META[task.status];
  const StatusIcon = BASH_TASK_STATUS_ICON[task.status];
  const running = task.status === "running";
  const start = task.startedAt ?? now;
  const end = running ? now : (task.endedAt ?? now);
  return (
    <li className="group border-b border-slate-200 py-2.5 pl-3.5 pr-3 transition-colors hover:bg-slate-100/70 last:border-b-0 dark:border-white/[0.08] dark:hover:bg-white/[0.04]">
      <div className="flex items-center gap-1.5">
        <span className={cn("flex items-center gap-1 text-[10.5px] font-semibold", meta.cls)}>
          {running && <span className="apple-live-dot bg-accent mr-0.5" />}
          <StatusIcon size={12} />
          {t(meta.labelKey)}
        </span>
        {task.isBackgrounded && (
          <span className="rounded-md bg-info/20 px-1.5 py-0.5 text-[9.5px] font-medium uppercase tracking-wide text-info">
            {t("chatStream.bashTask.backgrounded")}
          </span>
        )}
        <span className="ml-auto shrink-0 text-[10px] tabular-nums text-slate-500 dark:text-white/50">
          {formatClock(start)} → {running ? t("chatStream.activity.now") : formatClock(end)}
        </span>
      </div>
      <p
        className="mt-1 truncate font-mono text-[11px] text-slate-800 dark:text-white/90"
        title={task.description}
      >
        {task.description || t("chatStream.bashTask.noCommand")}
      </p>
      {task.error ? <p className="mt-0.5 truncate text-[10px] text-danger" title={task.error}>{task.error}</p> : null}
      <div className="mt-1.5 flex items-center gap-1.5">
        <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[9.5px] font-medium tabular-nums text-slate-600 dark:bg-white/10 dark:text-white/60">
          {formatDuration(end - start)}
        </span>
        {running && onStop && (
          <button
            type="button"
            onClick={() => onStop(task)}
            title={t("chatStream.bashTask.stopTitle")}
            className="ml-auto flex items-center gap-1 rounded-lg border border-danger/30 bg-danger/10 px-2 py-0.5 text-[10.5px] font-semibold text-danger transition-all hover:bg-danger/20 active:scale-95"
          >
            <IconPlayerStop size={10} />
            {t("chatStream.bashTask.stop")}
          </button>
        )}
      </div>
    </li>
  );
}

function CommandsBody({
  tasks,
  tab,
  now,
  t,
  onStop,
}: {
  tasks: BashTaskSnapshot[];
  tab: string;
  now: number;
  t: Translate;
  onStop?: (task: BashTaskSnapshot) => void;
}) {
  const running = tasks.filter((c) => c.status === "running");
  const settled = tasks.filter((c) => c.status !== "running");
  const completed = settled.filter((c) => c.status === "completed");
  const failed = settled.filter((c) => c.status === "failed" || c.status === "killed");

  const groups: { key: string; label: string; list: BashTaskSnapshot[] }[] =
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
  // Newest first inside each group — the most recent command is the one the
  // user is most likely watching.
  return (
    <div>
      {visible.map((g) => (
        <div key={g.key}>
          <GroupHead label={g.label} n={g.list.length} />
          <ul>
            {[...g.list].reverse().map((c) => (
              <BashTaskRow key={c.taskId} task={c} now={now} t={t} onStop={onStop} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/* ── Body: services (discovered listening sockets) ──────────────────── */

function ServiceRow({
  service,
  now,
  t,
  onStop,
  onOpen,
}: {
  service: ServiceSnapshot;
  now: number;
  t: Translate;
  onStop?: (service: ServiceSnapshot) => void;
  onOpen?: (service: ServiceSnapshot) => void;
}) {
  // Every roster entry IS a live listener (dead sockets leave the roster, not
  // settle in it), so the status is always "running" — the pulse dot + ticker
  // carry the liveness.
  return (
    <li className="group border-b border-slate-200 py-2.5 pl-3.5 pr-3 transition-colors hover:bg-slate-100/70 last:border-b-0 dark:border-white/[0.08] dark:hover:bg-white/[0.04]">
      <div className="flex items-center gap-1.5">
        <span className="flex items-center gap-1 text-[10.5px] font-semibold text-success">
          <span className="apple-live-dot bg-success mr-0.5" />
          <IconServer size={12} />
          {t("chatStream.service.statusRunning")}
        </span>
        <span className="rounded-md bg-success/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold tabular-nums text-success">
          :{service.port}
        </span>
        <span className="ml-auto shrink-0 text-[10px] tabular-nums text-slate-500 dark:text-white/50">
          {formatClock(service.startedAt)} → {t("chatStream.activity.now")}
        </span>
      </div>
      <p
        className="mt-1 truncate font-mono text-[11px] text-slate-800 dark:text-white/90"
        title={service.commandLine ?? service.name}
      >
        {service.commandLine || service.name}
      </p>
      <div className="mt-1.5 flex items-center gap-1.5">
        <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[9.5px] font-medium tabular-nums text-slate-600 dark:bg-white/10 dark:text-white/60">
          {formatDuration(now - service.startedAt)}
        </span>
        {onOpen && (
          <button
            type="button"
            onClick={() => onOpen(service)}
            title={t("chatStream.service.openTitle", { port: service.port })}
            className="flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2 py-0.5 text-[10.5px] font-semibold text-slate-800 shadow-sm transition-all hover:bg-slate-50 hover:text-slate-900 active:scale-95 dark:border-white/15 dark:bg-white/10 dark:text-white/90 dark:hover:bg-white/20 dark:hover:text-white"
          >
            <IconExternalLink size={10} />
            {t("chatStream.service.open")}
          </button>
        )}
        {onStop && (
          <button
            type="button"
            onClick={() => onStop(service)}
            title={t("chatStream.service.stopTitle", { port: service.port })}
            className="ml-auto flex items-center gap-1 rounded-lg border border-danger/30 bg-danger/10 px-2 py-0.5 text-[10.5px] font-semibold text-danger transition-all hover:bg-danger/20 active:scale-95"
          >
            <IconPlayerStop size={10} />
            {t("chatStream.service.stop")}
          </button>
        )}
      </div>
    </li>
  );
}

function ServicesBody({
  services,
  now,
  t,
  onStop,
  onOpen,
}: {
  services: ServiceSnapshot[];
  now: number;
  t: Translate;
  onStop?: (service: ServiceSnapshot) => void;
  onOpen?: (service: ServiceSnapshot) => void;
}) {
  if (services.length === 0) {
    return <EmptyGroup t={t} />;
  }
  // Newest first — the most recently started server is the likeliest target.
  return (
    <div>
      <GroupHead label={t("chatStream.activity.groupRunning")} n={services.length} />
      <ul>
        {[...services].reverse().map((s) => (
          <ServiceRow key={s.key} service={s} now={now} t={t} onStop={onStop} onOpen={onOpen} />
        ))}
      </ul>
    </div>
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
            className="min-w-0 flex-1 rounded border border-slate-300 bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-900 outline-none dark:border-accent/50 dark:bg-white/10 dark:text-white"
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
              stale || !onPick ? "cursor-default" : "hover:bg-slate-100/70 dark:hover:bg-white/[0.04]",
            )}
          >
            <span className={cn("min-w-0 flex-1 truncate text-[11px]", stale ? "text-slate-400 dark:text-white/40" : "text-slate-800 dark:text-white/90")}>
              {label}
            </span>
            {stale ? (
              <span className="shrink-0 rounded bg-slate-100 px-1 text-[9px] text-slate-500 dark:bg-white/10 dark:text-white/50">
                {t("chatStream.bookmark.stale")}
              </span>
            ) : (
              <span className="shrink-0 text-[9px] tabular-nums text-slate-500 dark:text-white/50">
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
              className="absolute right-7 top-1/2 hidden -translate-y-1/2 rounded p-0.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 group-hover/row:block dark:text-white/50 dark:hover:bg-white/10 dark:hover:text-white"
            >
              <IconPencil size={11} />
            </button>
          )}
          {onRemove && (
            <button
              type="button"
              onClick={() => onRemove(bookmark)}
              title={t("chatStream.bookmark.remove")}
              className="absolute right-1.5 top-1/2 hidden -translate-y-1/2 rounded p-0.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-danger group-hover/row:block dark:text-white/50 dark:hover:bg-white/10 dark:hover:text-danger"
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
          <ul className="mx-3 mb-2 border-l border-slate-200 pl-3 dark:border-white/15">
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
    <p className="px-3 py-6 text-center text-[11px] text-slate-400 dark:text-white/40">{t("chatStream.activity.emptyGroup")}</p>
  );
}

/* ── Body: Overview (Dynamic Island Expanded Control Deck) ──────────── */

function OverviewBody({
  subagents,
  todos,
  planBlocks,
  bookmarks,
  bashTasks,
  services,
  now,
  t,
  onStopBashTask,
  onStopService,
  onOpenService,
  onPickSubagent,
  onPickPlan,
  onPickBookmark,
  onPickNode,
  automations = [],
  onOpenSchedPanel,
  onNewSched,
}: {
  subagents: SubagentSnapshot[];
  todos: TodoItem[];
  planBlocks: PlanBlock[];
  bookmarks: SessionBookmark[];
  bashTasks: BashTaskSnapshot[];
  services: ServiceSnapshot[];
  now: number;
  t: Translate;
  automations?: Automation[];
  onStopBashTask?: (task: BashTaskSnapshot) => void;
  onStopService?: (service: ServiceSnapshot) => void;
  onOpenService?: (service: ServiceSnapshot) => void;
  onPickSubagent?: (agent: SubagentSnapshot) => void;
  onPickPlan?: (plan: string) => void;
  onPickBookmark?: (b: SessionBookmark) => void;
  onPickNode?: (node: ActivityNodeKey) => void;
  onOpenSchedPanel?: () => void;
  onNewSched?: () => void;
}) {
  const runningAgents = subagents.filter((a) => a.status === "running");
  const runningCommands = bashTasks.filter((c) => c.status === "running");
  const doneTodos = todos.filter((x) => x.status === "completed").length;
  const pct = todos.length > 0 ? Math.round((doneTodos / todos.length) * 100) : 0;
  const inFlightSched = automations.filter(isInFlightAutomation);
  const hasLive = services.length > 0 || runningCommands.length > 0 || runningAgents.length > 0 || inFlightSched.length > 0;

  return (
    <div className="flex flex-col gap-3 p-3">
      {/* 1. Live Services Widget */}
      {services.length > 0 && (
        <div className="rounded-2xl border border-emerald-300/80 bg-emerald-50/70 p-3 shadow-sm dark:border-emerald-500/30 dark:bg-emerald-500/[0.06]">
          <div className="flex items-center justify-between pb-2 border-b border-emerald-200/80 dark:border-white/[0.08]">
            <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-emerald-800 dark:text-emerald-400">
              <span className="dynamic-island-wave text-emerald-600 dark:text-emerald-400">
                <span /><span /><span />
              </span>
              {t("chatStream.activity.deck.liveServices")}
            </span>
            <span className="rounded-full bg-emerald-100 border border-emerald-300 px-2 py-0.5 text-[9.5px] font-bold text-emerald-800 dark:bg-emerald-500/20 dark:border-emerald-500/30 dark:text-emerald-400">
              {services.length} {t("chatStream.subagent.statusRunning")}
            </span>
          </div>
          <div className="divide-y divide-emerald-200/50 dark:divide-white/[0.06]">
            {services.map((s) => (
              <div key={s.port} className="flex items-center justify-between py-2">
                <div className="min-w-0 flex-1 pr-2">
                  <div className="flex items-center gap-1.5">
                    <span className="rounded bg-white border border-emerald-300 px-1.5 py-0.5 font-mono text-[10px] font-bold text-emerald-900 shadow-xs dark:bg-emerald-500/25 dark:border-emerald-500/40 dark:text-emerald-400">
                      :{s.port}
                    </span>
                    <span className="truncate text-[11.5px] font-bold text-slate-900 dark:text-white" title={s.commandLine ?? s.name}>
                      {s.name || s.commandLine}
                    </span>
                  </div>
                  <span className="text-[9.5px] font-mono text-slate-600 dark:text-white/50">{formatDuration(now - s.startedAt)}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  {onOpenService && (
                    <button
                      type="button"
                      onClick={() => onOpenService(s)}
                      className="flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2 py-1 text-[10px] font-bold text-slate-800 shadow-xs transition-all hover:bg-slate-50 active:scale-95 dark:border-white/10 dark:bg-white/10 dark:text-white dark:hover:bg-white/20"
                    >
                      <IconExternalLink size={10} />
                      {t("chatStream.service.open")}
                    </button>
                  )}
                  {onStopService && (
                    <button
                      type="button"
                      onClick={() => onStopService(s)}
                      className="flex items-center gap-1 rounded-lg border border-red-200 bg-red-50 px-2 py-1 text-[10px] font-bold text-red-700 transition-all hover:bg-red-100 active:scale-95 dark:border-danger/30 dark:bg-danger/20 dark:text-danger dark:hover:bg-danger/30"
                    >
                      <IconPlayerStop size={10} />
                      {t("chatStream.service.stop")}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 2. Active Processes & Subagents Widget */}
      {(runningCommands.length > 0 || runningAgents.length > 0) && (
        <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-3 shadow-sm dark:border-white/10 dark:bg-white/[0.04]">
          <div className="flex items-center justify-between pb-2 border-b border-slate-200 dark:border-white/[0.08]">
            <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-900 dark:text-accent">
              <span className="apple-live-dot bg-accent" />
              {t("chatStream.activity.deck.commandsAndAgents")}
            </span>
            <span className="rounded-full bg-slate-200/80 border border-slate-300 px-2 py-0.5 text-[9.5px] font-bold text-slate-800 dark:bg-accent/20 dark:border-transparent dark:text-accent">
              {runningCommands.length + runningAgents.length} 活跃
            </span>
          </div>
          <div className="divide-y divide-slate-200/60 dark:divide-white/[0.06]">
            {runningCommands.map((c) => (
              <div key={c.taskId} className="flex items-center justify-between py-2">
                <div className="min-w-0 flex-1 pr-2">
                  <div className="truncate font-mono text-[11px] font-bold text-slate-800 dark:text-white" title={c.description}>
                    {c.description}
                  </div>
                  <span className="text-[9.5px] font-mono text-slate-500 dark:text-white/50">{formatDuration(now - (c.startedAt ?? now))}</span>
                </div>
                {onStopBashTask && (
                  <button
                    type="button"
                    onClick={() => onStopBashTask(c)}
                    className="flex items-center gap-1 rounded-lg border border-red-200 bg-red-50 px-2 py-1 text-[10px] font-bold text-red-700 transition-all hover:bg-red-100 active:scale-95 dark:border-danger/30 dark:bg-danger/20 dark:text-danger dark:hover:bg-danger/30"
                  >
                    <IconPlayerStop size={10} />
                    {t("chatStream.bashTask.stop")}
                  </button>
                )}
              </div>
            ))}
            {runningAgents.map((a) => (
              <div
                key={a.toolUseId}
                onClick={onPickSubagent ? () => onPickSubagent(a) : undefined}
                className={cn(
                  "flex items-center justify-between py-2 transition-colors",
                  onPickSubagent && "cursor-pointer hover:bg-slate-100/80 dark:hover:bg-white/[0.03]",
                )}
              >
                <div className="min-w-0 flex-1 pr-2">
                  <div className="truncate text-[11px] font-bold text-slate-900 dark:text-white" title={a.description}>
                    {a.description}
                  </div>
                  <div className="flex items-center gap-1.5 text-[9.5px] text-slate-500 dark:text-white/50">
                    <span className="text-amber-600 dark:text-warning font-bold">运行中</span>
                    {a.lastToolName && <span>· {a.lastToolName}</span>}
                  </div>
                </div>
                <span className="text-[10px] font-bold text-indigo-600 dark:text-white/40">详情 →</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 3. Task Progress Widget */}
      {todos.length > 0 && (
        <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-3 shadow-sm dark:border-white/10 dark:bg-white/[0.04]">
          <div className="flex items-center justify-between pb-1.5">
            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-900 dark:text-white/80">
              {t("chatStream.activity.deck.todos")}
            </span>
            <span className="font-mono text-[11px] font-bold text-emerald-700 dark:text-white">
              {doneTodos}/{todos.length} ({pct}%)
            </span>
          </div>
          {/* Progress bar */}
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-white/10 my-1.5">
            <div
              className="h-full rounded-full bg-gradient-to-r from-accent to-emerald-500 transition-all duration-500"
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="mt-2 space-y-1.5">
            {todos.slice(0, 3).map((item, idx) => (
              <div
                key={`${item.content}:${idx}`}
                className={cn(
                  "flex items-center gap-2 text-[11px] p-1.5 rounded-lg transition-colors",
                  item.status === "in_progress"
                    ? "bg-amber-50 border border-amber-200 dark:bg-amber-500/10 dark:border-amber-500/30"
                    : "hover:bg-slate-100/60 dark:hover:bg-white/[0.02]",
                )}
              >
                <span
                  className={cn(
                    "grid h-3.5 w-3.5 place-items-center rounded-sm text-[9px] font-bold",
                    item.status === "completed"
                      ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-400"
                      : item.status === "in_progress"
                        ? "text-amber-600 dark:text-amber-400"
                        : "border border-slate-300 text-slate-400 dark:border-white/20 dark:text-white/40",
                  )}
                >
                  {item.status === "completed" ? "✓" : item.status === "in_progress" ? "●" : ""}
                </span>
                <span
                  className={cn(
                    "truncate flex-1 font-medium",
                    item.status === "completed"
                      ? "line-through text-slate-400 dark:text-white/40"
                      : "text-slate-900 dark:text-white/90",
                  )}
                >
                  {item.content}
                </span>
              </div>
            ))}
          </div>
          {todos.length > 3 && onPickNode && (
            <button
              type="button"
              onClick={() => onPickNode("tasks")}
              className="mt-2 text-[10px] font-bold text-accent hover:underline block"
            >
              {t("chatStream.activity.deck.viewFull")} (+{todos.length - 3}) →
            </button>
          )}
        </div>
      )}

      {/* 4. Scheduled Tasks Widget (定时任务) */}
      <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-3 shadow-sm dark:border-white/10 dark:bg-white/[0.04]">
        <div className="flex items-center justify-between pb-2 border-b border-slate-200 dark:border-white/[0.08]">
          <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-sky-600 dark:text-sky-400">
            {inFlightSched.length > 0 ? (
              <span className="apple-live-dot bg-sky-500 dark:bg-sky-400" />
            ) : (
              <IconClock size={12} className="text-sky-600 dark:text-sky-400" />
            )}
            {t("chatStream.activity.deck.sched")}
          </span>
          <div className="flex items-center gap-1.5">
            {inFlightSched.length > 0 && (
              <span className="rounded-full bg-sky-100 border border-sky-200 px-2 py-0.5 text-[9.5px] font-bold text-sky-800 dark:bg-sky-500/20 dark:border-transparent dark:text-sky-400">
                {t("chatStream.activity.deck.schedInFlight", { n: inFlightSched.length })}
              </span>
            )}
            {onNewSched && (
              <button
                type="button"
                onClick={onNewSched}
                className="flex items-center gap-0.5 rounded-lg border border-slate-300 bg-white px-2 py-0.5 text-[10px] font-bold text-slate-800 hover:bg-slate-50 active:scale-95 transition-all shadow-xs dark:border-white/10 dark:bg-white/10 dark:text-white/90 dark:hover:bg-white/20"
              >
                <IconPlus size={10} />
                {t("chatStream.activity.deck.newSched")}
              </button>
            )}
            {onOpenSchedPanel && (
              <button
                type="button"
                onClick={onOpenSchedPanel}
                className="rounded-lg border border-sky-300 bg-sky-50 px-2 py-0.5 text-[10px] font-bold text-sky-800 hover:bg-sky-100 active:scale-95 transition-all dark:border-sky-500/30 dark:bg-sky-500/15 dark:text-sky-400 dark:hover:bg-sky-500/25"
              >
                {t("chatStream.activity.deck.openSched")} →
              </button>
            )}
          </div>
        </div>

        {automations.length === 0 ? (
          <div className="py-2.5 text-center text-[11px] text-slate-500 dark:text-white/40">
            {t("chatStream.activity.deck.schedEmpty")}
          </div>
        ) : (
          <div className="divide-y divide-slate-200/60 dark:divide-white/[0.06]">
            {automations.slice(0, 3).map((task) => {
              const inFlight = isInFlightAutomation(task);
              const nextLine = task.nextRunAt ? formatUntil(task.nextRunAt) : null;
              return (
                <div
                  key={task.id}
                  onClick={onOpenSchedPanel}
                  className={cn(
                    "flex items-center justify-between py-2 transition-colors",
                    onOpenSchedPanel && "cursor-pointer hover:bg-slate-100/60 dark:hover:bg-white/[0.03]",
                  )}
                >
                  <div className="min-w-0 flex-1 pr-2">
                    <div className="flex items-center gap-1.5">
                      <span
                        className={cn(
                          "h-1.5 w-1.5 shrink-0 rounded-full",
                          inFlight
                            ? "bg-sky-500 animate-pulse"
                            : task.enabled
                              ? "bg-emerald-500"
                              : "bg-slate-300 dark:bg-white/30",
                        )}
                      />
                      <span className="truncate text-[11.5px] font-bold text-slate-900 dark:text-white" title={task.title || task.prompt}>
                        {task.title || task.prompt}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-[9.5px] text-slate-500 dark:text-white/50">
                      <span>{describeSchedule(task.schedule)}</span>
                      {nextLine && <span>· {t("chatStream.activity.deck.schedNext", { time: nextLine })}</span>}
                    </div>
                  </div>
                  <span className="text-[10px] font-bold text-slate-400 dark:text-white/40">→</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 5. Session Assets (Plans & Bookmarks) */}
      {(planBlocks.length > 0 || bookmarks.length > 0) && (
        <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-3 shadow-sm dark:border-white/10 dark:bg-white/[0.04]">
          <div className="pb-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-900 dark:text-white/80">
            {t("chatStream.activity.deck.assets")}
          </div>
          <div className="space-y-1.5 mt-1">
            {planBlocks.length > 0 && (
              <div
                onClick={() => (onPickPlan ? onPickPlan(planBlocks[planBlocks.length - 1]?.plan ?? "") : onPickNode?.("plans"))}
                className="flex items-center justify-between rounded-xl bg-white border border-slate-200 px-2.5 py-1.5 cursor-pointer hover:bg-slate-100/80 transition-colors shadow-xs dark:bg-white/[0.03] dark:border-transparent dark:hover:bg-white/[0.07]"
              >
                <div className="flex items-center gap-2">
                  <IconClipboard size={12} className="text-indigo-600 dark:text-info" />
                  <span className="text-[11.5px] font-bold text-slate-900 dark:text-white">会话计划历史</span>
                </div>
                <span className="rounded bg-slate-100 border border-slate-200 px-1.5 py-0.5 text-[10px] font-bold text-slate-700 dark:bg-white/10 dark:border-transparent dark:text-white/80">
                  {planBlocks.length} 份
                </span>
              </div>
            )}
            {bookmarks.length > 0 && (
              <div
                onClick={() => (onPickBookmark ? onPickBookmark(bookmarks[bookmarks.length - 1]!) : onPickNode?.("bookmarks"))}
                className="flex items-center justify-between rounded-xl bg-white border border-slate-200 px-2.5 py-1.5 cursor-pointer hover:bg-slate-100/80 transition-colors shadow-xs dark:bg-white/[0.03] dark:border-transparent dark:hover:bg-white/[0.07]"
              >
                <div className="flex items-center gap-2">
                  <IconBookmark size={12} className="text-amber-600 dark:text-warning" />
                  <span className="text-[11.5px] font-bold text-slate-900 dark:text-white">高亮书签</span>
                </div>
                <span className="rounded bg-slate-100 border border-slate-200 px-1.5 py-0.5 text-[10px] font-bold text-slate-700 dark:bg-white/10 dark:border-transparent dark:text-white/80">
                  {bookmarks.length} 条
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 6. All Settled Empty State */}
      {!hasLive && todos.length === 0 && planBlocks.length === 0 && bookmarks.length === 0 && automations.length === 0 && (
        <div className="py-8 text-center text-slate-500 dark:text-white/50 text-[11.5px] font-medium">
          {t("chatStream.activity.deck.allSettled")}
        </div>
      )}
    </div>
  );
}

/* ── Body: Scheduled Tasks (定时任务) ────────────────────────────────── */

function SchedBody({
  automations,
  t,
  onOpenSchedPanel,
  onNewSched,
}: {
  automations: Automation[];
  t: Translate;
  onOpenSchedPanel?: () => void;
  onNewSched?: () => void;
}) {
  const sorted = sortAutomations(automations);
  if (sorted.length === 0) {
    return (
      <div className="p-6 text-center">
        <IconClock size={28} className="mx-auto mb-2 text-slate-300 dark:text-white/20" />
        <p className="text-[12px] text-slate-500 dark:text-white/50">{t("chatStream.activity.deck.schedEmpty")}</p>
        {onNewSched && (
          <button
            type="button"
            onClick={onNewSched}
            className="mt-3 inline-flex items-center gap-1 rounded-xl bg-slate-200 px-3 py-1.5 text-[11px] font-semibold text-slate-800 transition-all hover:bg-slate-300 dark:bg-white/10 dark:text-white dark:hover:bg-white/20"
          >
            <IconPlus size={12} />
            {t("chatStream.activity.deck.newSched")}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2 p-3">
      <div className="flex items-center justify-between pb-1">
        <span className="text-[10.5px] font-semibold text-slate-500 dark:text-white/60">
          {t("chatStream.activity.deck.schedSubtitleIdle", { n: sorted.length })}
        </span>
        <div className="flex items-center gap-2">
          {onNewSched && (
            <button
              type="button"
              onClick={onNewSched}
              className="flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2 py-0.5 text-[10px] font-semibold text-slate-800 shadow-sm transition-all hover:bg-slate-50 hover:text-slate-900 dark:border-white/10 dark:bg-white/10 dark:text-white/90 dark:hover:bg-white/20"
            >
              <IconPlus size={10} />
              {t("chatStream.activity.deck.newSched")}
            </button>
          )}
          {onOpenSchedPanel && (
            <button
              type="button"
              onClick={onOpenSchedPanel}
              className="rounded-lg border border-sky-500/30 bg-sky-500/15 px-2 py-0.5 text-[10px] font-semibold text-sky-600 transition-all hover:bg-sky-500/25 dark:text-sky-400"
            >
              {t("chatStream.activity.deck.openSched")} →
            </button>
          )}
        </div>
      </div>
      <ul className="divide-y divide-slate-200 rounded-2xl border border-slate-200 bg-white/80 dark:divide-white/[0.06] dark:border-white/10 dark:bg-white/[0.03]">
        {sorted.map((task) => {
          const inFlight = isInFlightAutomation(task);
          const nextLine = task.nextRunAt ? formatUntil(task.nextRunAt) : null;
          return (
            <li
              key={task.id}
              onClick={onOpenSchedPanel}
              className="flex cursor-pointer items-center justify-between p-2.5 transition-colors hover:bg-slate-100/70 dark:hover:bg-white/[0.04]"
            >
              <div className="min-w-0 flex-1 pr-2">
                <div className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      "h-1.5 w-1.5 shrink-0 rounded-full",
                      inFlight
                        ? "animate-pulse bg-sky-400"
                        : task.enabled
                          ? "bg-emerald-400"
                          : "bg-slate-300 dark:bg-white/30",
                    )}
                  />
                  <span className="truncate text-[12px] font-medium text-slate-900 dark:text-white" title={task.title || task.prompt}>
                    {task.title || task.prompt}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-2 text-[10px] text-slate-500 dark:text-white/50">
                  <span className="rounded bg-slate-100 px-1 py-0.2 text-[9px] text-slate-700 dark:bg-white/10 dark:text-white/80">
                    {describeSchedule(task.schedule)}
                  </span>
                  {nextLine && <span>{t("chatStream.activity.deck.schedNext", { time: nextLine })}</span>}
                </div>
              </div>
              <span className="text-[11px] font-medium text-slate-400 dark:text-white/40">→</span>
            </li>
          );
        })}
      </ul>
    </div>
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
  /** Bash commands the agent started (the「运行命令」node). Optional so
   *  older callers degrade to an empty roster. */
  bashTasks?: BashTaskSnapshot[];
  /** Services the agent started, discovered by the host's port scan (the
   *  「服务」node). Optional — callers without scanner wiring degrade to an
   *  empty roster. */
  services?: ServiceSnapshot[];
  isBookmarkStale?: (b: SessionBookmark) => boolean;
  /** Active filter tab per node + setter (owned by the rail so it survives
   *  open/close cycles). */
  tabs: ActivityTabs;
  onTabChange: (node: ActivityNodeKey, tab: string) => void;
  onClose: () => void;
  onPickPlan: (plan: string) => void;
  onPickSubagent?: (agent: SubagentSnapshot) => void;
  /** Stop ONE running agent command (SDK stop_task; desktop + mobile). */
  onStopBashTask?: (task: BashTaskSnapshot) => void;
  /** Kill the process tree behind ONE discovered service (desktop + mobile). */
  onStopService?: (service: ServiceSnapshot) => void;
  /** Open a service's http://localhost:<port> in the in-app browser. */
  onOpenService?: (service: ServiceSnapshot) => void;
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
  automations?: Automation[];
  onOpenSchedPanel?: () => void;
  onNewSched?: () => void;
}
export function ActivityConsole({
  node,
  subagents,
  todos,
  planBlocks,
  bookmarks,
  bashTasks,
  services,
  automations = [],
  isBookmarkStale,
  tabs,
  onTabChange,
  onClose,
  onPickPlan,
  onPickSubagent,
  onStopBashTask,
  onStopService,
  onOpenService,
  onPickBookmark,
  onRemoveBookmark,
  onRenameBookmark,
  nodeTabs = false,
  onPickNode,
  showKeyHint = false,
  onOpenSchedPanel,
  onNewSched,
}: ActivityConsoleProps) {
  const { t } = useI18n();
  const now = useNow();
  const meta = NODE_META[node];
  const Ico = meta.ico;
  const stale = isBookmarkStale ?? (() => false);
  const tab = tabs[node] ?? "all";
  const commands = bashTasks ?? [];
  const serviceList = services ?? [];

  const runningAgents = subagents.filter((a) => a.status === "running");
  const settledAgents = subagents.filter((a) => a.status !== "running");
  const doneTodos = todos.filter((x) => x.status === "completed");
  const todoPct = todos.length > 0 ? Math.round((doneTodos.length / todos.length) * 100) : 0;
  const runningCommands = commands.filter((c) => c.status === "running");
  const bmGroups = bookmarkGroups(bookmarks, now, stale);
  const bmCount = (key: "today" | "earlier" | "stale") => bmGroups.find((g) => g.key === key)?.list.length ?? 0;

  /* Header subtitle, aggregate stats, filter tabs and footer per kind — kept
     in one place so a kind's numbers agree across all bands. */
  let subtitle = "";
  let stats: ReactNode = null;
  let filters: { key: string; label: string; n?: number }[] = [];
  let footer = "";
  let rightAction: { label: string; run: () => void } | null = null;

  if (node === "overview") {
    const inFlightSched = automations.filter(isInFlightAutomation);
    const liveCount = runningAgents.length + runningCommands.length + serviceList.length + inFlightSched.length;
    subtitle = liveCount > 0
      ? t("chatStream.activity.deck.title")
      : t("chatStream.activity.deck.allSettled");
    stats = (
      <>
        <Stat value={serviceList.length} label={t("chatStream.service.unitServices")} />
        <Sep />
        <Stat value={runningAgents.length + runningCommands.length + inFlightSched.length} label={t("chatStream.activity.labelRunning")} />
        <Sep />
        <Stat value={`${todoPct}%`} label={t("chatStream.activity.node.tasks")} />
        <Sep />
        <Stat value={automations.length} label={t("chatStream.activity.node.sched")} />
      </>
    );
    filters = [];
    footer = t("chatStream.activity.deck.allSettled");
  } else if (node === "subagents") {
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
          style={{ background: `conic-gradient(rgb(var(--accent)) ${todoPct}%, rgba(255, 255, 255, 0.12) 0)` }}
        >
          <span className="absolute inset-[4px] rounded-full bg-[#0c0d12]" />
          <span className="relative text-[9.5px] font-bold tabular-nums text-white">{todoPct}%</span>
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-1 text-[11px] text-white/70">
            <b className="text-[12px] tabular-nums text-white">
              {doneTodos.length} / {todos.length}
            </b>
            {t("chatStream.activity.tasksDoneSuffix")}
            <span className="ml-auto text-[10px] text-white/50">
              {t("chatStream.activity.tasksRest", { n: todos.length - doneTodos.length })}
            </span>
          </span>
          <span aria-hidden className="mt-1 flex h-1.5 gap-0.5">
            {todos.map((x, i) => (
              <span
                key={i}
                className={cn(
                  "flex-1 rounded-[2px]",
                  x.status === "completed" ? "bg-accent" : x.status === "in_progress" ? "bg-warning" : "bg-white/10",
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
  } else if (node === "commands") {
    const failed = commands.filter((c) => c.status === "failed" || c.status === "killed").length;
    subtitle = runningCommands.length
      ? t("chatStream.bashTask.subRunning", { running: runningCommands.length, total: commands.length })
      : t("chatStream.bashTask.subIdle", { n: commands.length });
    stats = (
      <>
        <Stat value={commands.length} label={t("chatStream.bashTask.unitCommands")} />
        <Sep />
        <Stat value={runningCommands.length} label={t("chatStream.activity.labelRunning")} />
        <Sep />
        <Stat value={commands.length - failed} label={t("chatStream.activity.groupCompleted")} />
        {failed > 0 && (
          <>
            <Sep />
            <span className="text-danger">
              <Stat value={failed} label={t("chatStream.activity.groupFailed")} />
            </span>
          </>
        )}
      </>
    );
    filters = [
      { key: "all", label: t("chatStream.activity.tabAll"), n: commands.length },
      { key: "running", label: t("chatStream.activity.groupRunning"), n: runningCommands.length },
      { key: "completed", label: t("chatStream.activity.groupCompleted"), n: commands.length - failed },
      { key: "failed", label: t("chatStream.activity.groupFailed"), n: failed },
    ];
    footer = t("chatStream.bashTask.footer");
  } else if (node === "services") {
    subtitle = t("chatStream.service.subRunning", { n: serviceList.length });
    stats = (
      <>
        <Stat value={serviceList.length} label={t("chatStream.service.unitServices")} />
        <Sep />
        <Stat
          value={serviceList.map((s) => s.port).join(" ") || "—"}
          label={t("chatStream.service.unitPorts")}
        />
        <Sep />
        <Stat value={serviceList.length} label={t("chatStream.activity.labelRunning")} />
      </>
    );
    filters = [{ key: "all", label: t("chatStream.activity.tabAll"), n: serviceList.length }];
    footer = t("chatStream.service.footer");
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
  } else if (node === "sched") {
    const inFlightSched = automations.filter(isInFlightAutomation);
    subtitle = inFlightSched.length > 0
      ? t("chatStream.activity.deck.schedSubtitle", { total: automations.length, running: inFlightSched.length })
      : t("chatStream.activity.deck.schedSubtitleIdle", { n: automations.length });
    stats = (
      <>
        <Stat value={automations.length} label={t("chatStream.activity.node.sched")} />
        <Sep />
        <Stat value={inFlightSched.length} label={t("chatStream.activity.labelRunning")} />
        <Sep />
        <Stat value={automations.filter((a) => a.enabled).length} label={t("chatStream.activity.groupCompleted")} />
      </>
    );
    filters = [
      { key: "all", label: t("chatStream.activity.tabAll"), n: automations.length },
      { key: "running", label: t("chatStream.activity.groupRunning"), n: inFlightSched.length },
    ];
    footer = t("chatStream.activity.deck.sched");
    if (onOpenSchedPanel) {
      rightAction = { label: t("chatStream.activity.deck.openSched"), run: onOpenSchedPanel };
    }
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
    node === "overview" ? (
      <OverviewBody
        services={serviceList}
        subagents={subagents}
        todos={todos}
        bashTasks={commands}
        bookmarks={bookmarks}
        planBlocks={planBlocks}
        automations={automations}
        onOpenSchedPanel={onOpenSchedPanel}
        onNewSched={onNewSched}
        now={now}
        t={t}
        onPickNode={onPickNode}
        onOpenService={onOpenService}
        onStopService={onStopService}
        onStopBashTask={onStopBashTask}
        onPickSubagent={onPickSubagent}
        onPickPlan={onPickPlan}
        onPickBookmark={onPickBookmark}
      />
    ) : node === "subagents" ? (
      <SubagentsBody agents={subagents} tab={tab} now={now} t={t} onPick={onPickSubagent} />
    ) : node === "tasks" ? (
      <TasksBody todos={todos} tab={tab} t={t} />
    ) : node === "commands" ? (
      <CommandsBody tasks={commands} tab={tab} now={now} t={t} onStop={onStopBashTask} />
    ) : node === "services" ? (
      <ServicesBody services={serviceList} now={now} t={t} onStop={onStopService} onOpen={onOpenService} />
    ) : node === "sched" ? (
      <SchedBody
        automations={automations}
        t={t}
        onOpenSchedPanel={onOpenSchedPanel}
        onNewSched={onNewSched}
      />
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
    <div className="flex min-h-0 flex-auto flex-col text-slate-900 dark:text-white">
      {/* Apple-style Segmented Control for node switching (Dynamic Island Style) */}
      {nodeTabs && onPickNode && (
        <div className="shrink-0 border-b border-slate-200 px-3 py-2.5 dark:border-white/[0.08]">
          <div className="flex gap-1 overflow-x-auto rounded-full border border-slate-300 bg-slate-100 p-1 no-scrollbar dark:border-white/[0.1] dark:bg-black/40">
            {RAIL_NODE_ORDER.filter(
              (k) =>
                k === node ||
                hasNodeData(k, subagents, todos, planBlocks, bookmarks, commands, serviceList),
            ).map((k) => {
              const m = NODE_META[k];
              const K = m.ico;
              const active = k === node;
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => onPickNode(k)}
                  className={cn(
                    "flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-semibold transition-all duration-200",
                    active
                      ? "bg-slate-900 text-white shadow-sm dark:bg-white dark:text-[#090b0e] dark:shadow-[0_2px_8px_rgba(0,0,0,0.3)]"
                      : "text-slate-600 hover:text-slate-900 dark:text-white/70 dark:hover:text-white",
                  )}
                >
                  <K size={12} className={cn(active ? "text-white dark:text-[#090b0e]" : "text-slate-500 dark:text-white/70")} />
                  {t(m.labelKey)}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Header: identity + what this kind is doing right now + actions. */}
      <div className="flex shrink-0 items-center gap-2.5 px-3.5 py-2.5 bg-slate-50/50 dark:bg-white/[0.02]">
        <span className={cn("grid h-7 w-7 shrink-0 place-items-center rounded-[10px] shadow-sm", meta.icoCls)}>
          <Ico size={15} />
        </span>
        <span className="min-w-0 flex-1">
          <b className="block truncate text-[13px] font-bold tracking-tight text-slate-900 dark:text-white">{t(meta.labelKey)}</b>
          <span className="block truncate text-[10.5px] text-slate-500 dark:text-white/60">{subtitle}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {rightAction && (
            <button
              type="button"
              onClick={rightAction.run}
              title={rightAction.label}
              className="grid h-6 w-6 place-items-center rounded-lg border border-slate-300 bg-white text-slate-700 shadow-sm transition-all hover:bg-slate-50 hover:text-slate-900 active:scale-95 dark:border-white/[0.12] dark:bg-white/[0.08] dark:text-white/80 dark:hover:bg-white/[0.18] dark:hover:text-white"
            >
              <IconLayoutSidebarRightExpand size={13} />
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            title={t("chatStream.activity.close")}
            className="grid h-6 w-6 place-items-center rounded-lg border border-slate-300 bg-white text-slate-700 shadow-sm transition-all hover:bg-slate-50 hover:text-slate-900 active:scale-95 dark:border-white/[0.12] dark:bg-white/[0.08] dark:text-white/80 dark:hover:bg-white/[0.18] dark:hover:text-white"
          >
            <IconX size={13} />
          </button>
        </span>
      </div>

      {/* Aggregate numbers for this kind. */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-y border-slate-200 bg-slate-50/80 px-3.5 py-1.5 text-[10.5px] tabular-nums text-slate-700 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-white/75">
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

      <div className="flex shrink-0 items-center gap-1.5 border-t border-slate-200 bg-slate-50 px-3 py-2 text-[10px] text-slate-500 dark:border-white/[0.08] dark:bg-white/[0.02] dark:text-white/60">
        {footer}
        {showKeyHint && (
          <span className="ml-auto flex shrink-0 items-center gap-1">
            <kbd className="rounded border border-slate-300 bg-slate-200 px-1 text-[9px] text-slate-700 dark:border-white/20 dark:bg-white/10 dark:text-white/80">Esc</kbd>
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
  bashTasks: BashTaskSnapshot[] = [],
  services: ServiceSnapshot[] = [],
  automations: Automation[] = [],
): boolean {
  if (node === "overview") return true;
  if (node === "subagents") return subagents.length > 0;
  if (node === "tasks") return todos.length > 0;
  if (node === "commands") return bashTasks.length > 0;
  if (node === "services") return services.length > 0;
  if (node === "sched") return automations.length > 0;
  if (node === "plans") return planBlocks.length > 0;
  return bookmarks.length > 0;
}
