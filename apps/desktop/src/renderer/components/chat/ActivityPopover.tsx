import type { TodoItem, Block } from "@renderer/stores/sessionStore.js";
import type { SubagentSnapshot } from "@contracts/runtime";
import { cn } from "@renderer/lib/cn.js";
import { extractPlanTitle } from "./StatusCapsule.js";

/** A `kind: "plan"` block - the frozen per-turn plan in the message stream. */
type PlanBlock = Extract<Block, { kind: "plan" }>;

/* ── Tasks section (extracted from the old TodosPopover) ────────────── */

const STATUS_META: Record<TodoItem["status"], { icon: string; cls: string }> = {
  pending: { icon: "○", cls: "text-content-subtle" },
  in_progress: { icon: "◐", cls: "text-warning" },
  completed: { icon: "✓", cls: "text-accent" },
};

const PRIORITY_BAR: Record<TodoItem["priority"], string> = {
  high: "border-l-red-500",
  medium: "border-l-amber-500",
  low: "border-l-zinc-600",
};

/** Status tints per subagent lifecycle state. Exported so the capsule
 *  chip (SubagentsChip) can render matching labels/colors without
 *  duplicating the map. */
export const SUBAGENT_STATUS_META: Record<SubagentSnapshot["status"], { label: string; cls: string; spin?: boolean }> = {
  running: { label: "运行中", cls: "text-warning", spin: true },
  completed: { label: "已完成", cls: "text-accent" },
  failed: { label: "失败", cls: "text-danger" },
  killed: { label: "已终止", cls: "text-danger" },
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

/** A horizontal section header: icon + title (left), badge/right slot. */
function SectionHeader({
  icon,
  title,
  right,
}: {
  icon: string;
  title: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between border-b border-white/5 px-3 py-1.5">
      <span className="text-[11px] font-semibold text-content-muted">
        <span className="mr-1 opacity-80">{icon}</span>
        {title}
      </span>
      {right && <span className="text-[10px] text-content-subtle">{right}</span>}
    </div>
  );
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
}: {
  planBlocks: PlanBlock[];
  onPickPlan: (plan: string) => void;
  scrollLists: boolean;
}) {
  // Newest first: the last plan block in the stream is the most recent turn's.
  const ordered = [...planBlocks].reverse();
  return (
    <>
      <SectionHeader
        icon="📋"
        title={`计划 · ${planBlocks.length} 个`}
      />
      <ul className={sectionListCls(scrollLists)}>
        {ordered.map((block, i) => {
          const title = extractPlanTitle(block.plan) || `(计划 ${ordered.length - i})`;
          return (
            <li key={block.planId}>
              <button
                type="button"
                onClick={() => onPickPlan(block.plan)}
                title="点击查看完整计划内容"
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
    </>
  );
}

/* ── Section: Tasks ─────────────────────────────────────────────────── */

function TasksSection({ todos, scrollLists }: { todos: TodoItem[]; scrollLists: boolean }) {
  const done = todos.filter((t) => t.status === "completed").length;
  const pct = todos.length > 0 ? Math.round((done / todos.length) * 100) : 0;
  return (
    <>
      <SectionHeader
        icon="✓"
        title="Tasks"
        right={
          <span className="rounded-full bg-surface-muted px-2 py-0.5 tabular-nums">
            {done}/{todos.length} · {pct}%
          </span>
        }
      />
      <ul className={sectionListCls(scrollLists)}>
        {todos.map((t, i) => {
          const meta = STATUS_META[t.status];
          return (
            <li
              key={i}
              className={`flex items-start gap-2 border-l-2 px-3 py-1.5 ${PRIORITY_BAR[t.priority]}`}
            >
              <span className={`mt-0.5 shrink-0 text-xs ${meta.cls}`}>{meta.icon}</span>
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
  );
}

/* ── Section: Subagents ────────────────────────────────────────────── */

function SubagentsSection({ agents, scrollLists }: { agents: SubagentSnapshot[]; scrollLists: boolean }) {
  const running = agents.filter((a) => a.status === "running").length;
  return (
    <>
      <SectionHeader
        icon="🤖"
        title={`子代理 · ${agents.length} 个`}
        right={
          running > 0 ? (
            <span className="flex items-center gap-1 text-warning">
              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-warning" />
              {running} 运行中
            </span>
          ) : null
        }
      />
      <ul className={sectionListCls(scrollLists)}>
        {agents.map((s) => {
          const meta = SUBAGENT_STATUS_META[s.status];
          const usage = fmtUsage(s);
          return (
            <li key={s.taskId} className="border-l-2 border-l-info/60 px-3 py-1.5">
              <div className="flex items-center gap-1.5">
                {s.subagentType && (
                  <span className="rounded bg-info/20 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-info">
                    {s.subagentType}
                  </span>
                )}
                <span className={`flex items-center gap-1 text-[10px] ${meta.cls}`}>
                  {meta.spin && <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-warning" />}
                  {meta.label}
                </span>
              </div>
              <p className="mt-0.5 truncate text-[11px] text-content" title={s.description}>
                {s.description || "(无描述)"}
              </p>
              {(usage || s.lastToolName) && (
                <p className="mt-0.5 text-[10px] text-content-subtle">
                  {[s.lastToolName, usage].filter(Boolean).join(" · ")}
                </p>
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
    </>
  );
}

/* ── Root: ActivityPopover ─────────────────────────────────────────── */

/**
 * Shared section stack for both shells of the activity capsule: the desktop
 * anchored popover and the mobile bottom sheet. Renders up to three sections
 * - Plan, Subagents, Tasks - in priority order. Each section is omitted
 * entirely when its source state is empty (no Todos -> no Tasks section), so
 * the stack gracefully degrades to whatever the active session is actually
 * doing right now.
 *
 * The Plan section is a clickable title list (not the full content).
 * Clicking a plan title opens the plan viewer via `onPickPlan`.
 *
 * `scrollLists` selects where scrolling happens: the desktop popover gives
 * each section its own `max-h-60` inner scroll; the mobile sheet passes
 * `false` so the whole stack scrolls as one body.
 */
export function ActivitySections({
  todos,
  planBlocks,
  subagents,
  onPickPlan,
  scrollLists = true,
}: {
  todos: TodoItem[];
  planBlocks: PlanBlock[];
  subagents: SubagentSnapshot[];
  onPickPlan: (plan: string) => void;
  scrollLists?: boolean;
}) {
  const showPlan = planBlocks.length > 0;
  const showSubagents = subagents.length > 0;
  const showTasks = todos.length > 0;

  return (
    <>
      {showPlan && (
        <div className="border-b border-white/5">
          <PlanListSection planBlocks={planBlocks} onPickPlan={onPickPlan} scrollLists={scrollLists} />
        </div>
      )}
      {showSubagents && (
        <div className="border-b border-white/5">
          <SubagentsSection agents={subagents} scrollLists={scrollLists} />
        </div>
      )}
      {showTasks && (
        <div className="border-b border-white/5">
          <TasksSection todos={todos} scrollLists={scrollLists} />
        </div>
      )}
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
  onPickPlan,
}: {
  todos: TodoItem[];
  planBlocks: PlanBlock[];
  subagents: SubagentSnapshot[];
  onPickPlan: (plan: string) => void;
}) {
  return (
    <div className="absolute right-0 top-9 z-30 w-96 overflow-hidden rounded-xl border border-white/10 bg-surface shadow-2xl">
      <ActivitySections todos={todos} planBlocks={planBlocks} subagents={subagents} onPickPlan={onPickPlan} />
    </div>
  );
}
