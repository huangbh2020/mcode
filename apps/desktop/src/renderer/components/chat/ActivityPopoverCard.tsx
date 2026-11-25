/**
 * ActivityPopoverCard — 方案 B 桌面端输入框上方各类型的专属轻量弹出卡片。
 *
 * 与旧版大而全的 ActivityConsole（固定 440px、4 层冗余头尾、硬编码深色）不同：
 *   - 统一主题变量（bg-surface / border-edge / text-content）
 *   - 按类型自适应宽度（340px ~ 420px）与精简 1 行头部
 *   - 仅「会话资产 (overview)」保留资产分类 Tab，其余直奔主题内容
 */
import { useMemo, useState, type ReactNode } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useNow } from "@renderer/hooks/useNow.js";
import type { BashTaskSnapshot, ServiceSnapshot, SubagentSnapshot } from "@contracts/runtime";
import type { Session, SessionBookmark } from "@contracts/session";
import type { Automation } from "@contracts/automation";
import type { TodoItem } from "@renderer/stores/sessionStore.js";
import {
  describeSchedule,
  formatUntil,
  isInFlightAutomation,
  sortAutomations,
} from "@renderer/components/automation/automationFormat.js";
import {
  IconCheck,
  IconChevronDown,
  IconClock,
  IconExternalLink,
  IconPencil,
  IconPlayerStop,
  IconPlus,
  IconX,
} from "@renderer/lib/icons.js";
import {
  BASH_TASK_STATUS_META,
  SUBAGENT_STATUS_META,
  extractPlanExcerpt,
  extractPlanTitle,
  formatDuration,
  subagentEndpoints,
  type ActivityNodeKey,
  type PlanBlock,
  type Translate,
} from "./activityShared.js";

export interface ActivityPopoverCardProps {
  node: ActivityNodeKey;
  subagents: SubagentSnapshot[];
  todos: TodoItem[];
  planBlocks: PlanBlock[];
  bookmarks: SessionBookmark[];
  bashTasks: BashTaskSnapshot[];
  services: ServiceSnapshot[];
  sideChats: Session[];
  sideChatRunningIds?: ReadonlySet<string>;
  automations: Automation[];
  isBookmarkStale?: (b: SessionBookmark) => boolean;
  onClose: () => void;
  onPickPlan: (plan: string) => void;
  onPickSubagent?: (agent: SubagentSnapshot) => void;
  onStopBashTask?: (task: BashTaskSnapshot) => void;
  onStopService?: (service: ServiceSnapshot) => void;
  onOpenService?: (service: ServiceSnapshot) => void;
  onPickBookmark?: (b: SessionBookmark) => void;
  onRemoveBookmark?: (b: SessionBookmark) => void;
  onRenameBookmark?: (b: SessionBookmark, title: string) => void;
  onOpenSideChat?: (s: Session) => void;
  onOpenSchedPanel?: () => void;
  onNewSched?: () => void;
}

const WIDTH_BY_NODE: Partial<Record<ActivityNodeKey, string>> = {
  services: "w-[340px]",
  tasks: "w-[360px]",
  commands: "w-[380px]",
  subagents: "w-[420px]",
  overview: "w-[400px]",
  plans: "w-[400px]",
  bookmarks: "w-[400px]",
  sched: "w-[380px]",
  sidechats: "w-[380px]",
};

function PopoverHeader({
  title,
  subtitle,
  right,
  onClose,
  t,
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
  onClose: () => void;
  t: Translate;
}) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-2 border-b border-edge px-3.5 py-2.5">
      <div className="min-w-0">
        <div className="truncate text-[12.5px] font-semibold text-content">{title}</div>
        {subtitle && <div className="truncate text-[11px] text-content-muted">{subtitle}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {right}
        <button
          type="button"
          onClick={onClose}
          title={t("chatStream.activity.close")}
          className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] text-content-muted transition-colors hover:bg-surface-muted hover:text-content"
        >
          <span className="text-[10px] opacity-70">Esc</span>
          <IconX size={12} />
        </button>
      </div>
    </div>
  );
}

function FilterTabs({
  items,
  active,
  onChange,
}: {
  items: { key: string; label: string; count?: number }[];
  active: string;
  onChange: (key: string) => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-edge/70 px-3 py-1.5 no-scrollbar">
      {items.map((item) => {
        const isOn = active === item.key;
        return (
          <button
            key={item.key}
            type="button"
            onClick={() => onChange(item.key)}
            className={cn(
              "inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] transition-colors",
              isOn
                ? "bg-accent/15 font-medium text-accent"
                : "text-content-muted hover:bg-surface-muted hover:text-content",
            )}
          >
            <span>{item.label}</span>
            {typeof item.count === "number" && (
              <span className="tabular-nums opacity-75">{item.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/* ── 1. 服务 ────────────────────────────────────────────────────────── */
function ServicesCard({
  services,
  now,
  t,
  onOpen,
  onStop,
  onClose,
}: {
  services: ServiceSnapshot[];
  now: number;
  t: Translate;
  onOpen?: (s: ServiceSnapshot) => void;
  onStop?: (s: ServiceSnapshot) => void;
  onClose: () => void;
}) {
  return (
    <>
      <PopoverHeader
        title={t("chatStream.activity.node.services")}
        subtitle={t("chatStream.service.subRunning", { n: services.length })}
        onClose={onClose}
        t={t}
      />
      <div className="max-h-[260px] space-y-2 overflow-y-auto p-2.5">
        {[...services].reverse().map((s) => (
          <div
            key={s.key}
            className="flex items-center justify-between gap-2.5 rounded-xl border border-edge bg-surface-muted/40 p-2.5"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="apple-live-dot bg-success" />
                <span className="font-mono text-xs font-semibold text-success">:{s.port}</span>
                <span className="text-[11px] tabular-nums text-content-subtle">
                  {formatDuration(now - s.startedAt)}
                </span>
              </div>
              <div
                className="mt-0.5 truncate font-mono text-[11px] text-content-muted"
                title={s.commandLine ?? s.name}
              >
                {s.commandLine || s.name}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {onOpen && (
                <button
                  type="button"
                  onClick={() => onOpen(s)}
                  title={t("chatStream.service.openTitle", { port: s.port })}
                  className="inline-flex items-center gap-1 rounded-lg border border-edge bg-surface px-2 py-1 text-[11px] font-medium text-content transition-colors hover:bg-surface-hover"
                >
                  <IconExternalLink size={11} />
                  {t("chatStream.service.open")}
                </button>
              )}
              {onStop && (
                <button
                  type="button"
                  onClick={() => onStop(s)}
                  title={t("chatStream.service.stopTitle", { port: s.port })}
                  className="inline-flex items-center gap-1 rounded-lg border border-danger/30 bg-danger/10 px-2 py-1 text-[11px] font-medium text-danger transition-colors hover:bg-danger/20"
                >
                  <IconPlayerStop size={11} />
                  {t("chatStream.service.stop")}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/* ── 2. 后台命令 ────────────────────────────────────────────────────── */
function CommandRow({
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
  const [showOutput, setShowOutput] = useState(false);
  const running = task.status === "running";
  const start = task.startedAt ?? now;
  const end = running ? now : (task.endedAt ?? now);
  const meta = BASH_TASK_STATUS_META[task.status];

  return (
    <div className="rounded-xl border border-edge bg-surface-muted/35 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-[11.5px] font-medium text-content" title={task.description}>
            {task.description || t("chatStream.bashTask.noCommand")}
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-[11px]">
            <span className={cn("inline-flex items-center gap-1 font-medium", meta.cls)}>
              {running && <span className="apple-live-dot bg-accent" />}
              {t(meta.labelKey)}
            </span>
            <span className="tabular-nums text-content-subtle">{formatDuration(end - start)}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {task.output && (
            <button
              type="button"
              onClick={() => setShowOutput((v) => !v)}
              title={t("chatStream.bashTask.outputTitle")}
              className={cn(
                "inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-medium transition-colors",
                showOutput
                  ? "border-accent/40 bg-accent/10 text-accent"
                  : "border-edge bg-surface text-content-muted hover:text-content",
              )}
            >
              <IconChevronDown size={11} className={cn("transition-transform", showOutput && "rotate-180")} />
              {t("chatStream.bashTask.output")}
            </button>
          )}
          {running && onStop && (
            <button
              type="button"
              onClick={() => onStop(task)}
              title={t("chatStream.bashTask.stopTitle")}
              className="inline-flex items-center gap-1 rounded-lg border border-danger/30 bg-danger/10 px-2 py-1 text-[11px] font-medium text-danger transition-colors hover:bg-danger/20"
            >
              <IconPlayerStop size={11} />
              {t("chatStream.bashTask.stop")}
            </button>
          )}
        </div>
      </div>
      {task.error && <div className="mt-1 truncate text-[11px] text-danger">{task.error}</div>}
      {task.output && showOutput && (
        <pre className="mt-2 max-h-40 overflow-auto rounded-lg border border-edge bg-surface p-2 font-mono text-[10.5px] leading-relaxed break-all whitespace-pre-wrap text-content-muted">
          {task.output}
        </pre>
      )}
    </div>
  );
}

function CommandsCard({
  tasks,
  now,
  t,
  onStop,
  onClose,
}: {
  tasks: BashTaskSnapshot[];
  now: number;
  t: Translate;
  onStop?: (task: BashTaskSnapshot) => void;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState("all");
  const runningCount = tasks.filter((c) => c.status === "running").length;
  const failedCount = tasks.filter((c) => c.status === "failed" || c.status === "killed").length;
  const completedCount = tasks.length - runningCount - failedCount;

  const filtered = tasks.filter((c) => {
    if (filter === "running") return c.status === "running";
    if (filter === "completed") return c.status === "completed";
    if (filter === "failed") return c.status === "failed" || c.status === "killed";
    return true;
  });

  return (
    <>
      <PopoverHeader
        title={t("chatStream.activity.node.commands")}
        subtitle={
          runningCount > 0
            ? t("chatStream.bashTask.subRunning", { running: runningCount, total: tasks.length })
            : t("chatStream.bashTask.subIdle", { n: tasks.length })
        }
        onClose={onClose}
        t={t}
      />
      <FilterTabs
        active={filter}
        onChange={setFilter}
        items={[
          { key: "all", label: t("chatStream.activity.tabAll"), count: tasks.length },
          { key: "running", label: t("chatStream.activity.groupRunning"), count: runningCount },
          { key: "completed", label: t("chatStream.activity.groupCompleted"), count: completedCount },
          { key: "failed", label: t("chatStream.activity.groupFailed"), count: failedCount },
        ]}
      />
      <div className="max-h-[260px] space-y-1.5 overflow-y-auto p-2.5">
        {filtered.length === 0 ? (
          <div className="py-6 text-center text-xs text-content-subtle">{t("chatStream.activity.emptyGroup")}</div>
        ) : (
          filtered.map((task) => <CommandRow key={task.taskId} task={task} now={now} t={t} onStop={onStop} />)
        )}
      </div>
    </>
  );
}

/* ── 3. 子代理 ──────────────────────────────────────────────────────── */
function SubagentsCard({
  agents,
  now,
  t,
  onPick,
  onClose,
}: {
  agents: SubagentSnapshot[];
  now: number;
  t: Translate;
  onPick?: (agent: SubagentSnapshot) => void;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState("all");
  const runningCount = agents.filter((a) => a.status === "running").length;
  const failedCount = agents.filter((a) => a.status === "failed").length;
  const completedCount = agents.filter((a) => a.status === "completed").length;

  const filtered = agents.filter((a) => filter === "all" || a.status === filter);

  return (
    <>
      <PopoverHeader
        title={t("chatStream.activity.node.subagents")}
        subtitle={
          runningCount > 0
            ? t("chatStream.activity.subagentsSubRunning", { running: runningCount, ended: agents.length - runningCount })
            : t("chatStream.activity.subagentsSubIdle", { n: agents.length })
        }
        onClose={onClose}
        t={t}
      />
      <FilterTabs
        active={filter}
        onChange={setFilter}
        items={[
          { key: "all", label: t("chatStream.activity.tabAll"), count: agents.length },
          { key: "running", label: t("chatStream.activity.groupRunning"), count: runningCount },
          { key: "completed", label: t("chatStream.activity.groupCompleted"), count: completedCount },
          { key: "failed", label: t("chatStream.activity.groupFailed"), count: failedCount },
        ]}
      />
      <div className="max-h-[270px] divide-y divide-edge/70 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="py-6 text-center text-xs text-content-subtle">{t("chatStream.activity.emptyGroup")}</div>
        ) : (
          filtered.map((a) => {
            const meta = SUBAGENT_STATUS_META[a.status];
            const win = subagentEndpoints(a, now);
            const running = a.status === "running";
            const barCls =
              a.status === "running" ? "bg-warning" : a.status === "failed" ? "bg-danger" : "bg-success";

            return (
              <div
                key={a.taskId}
                onClick={onPick ? () => onPick(a) : undefined}
                title={onPick ? t("chatStream.activity.viewSubagent") : undefined}
                className={cn(
                  "relative py-2.5 pl-4 pr-3.5 transition-colors",
                  onPick && "cursor-pointer hover:bg-surface-muted/60",
                )}
              >
                <span aria-hidden className={cn("absolute bottom-2.5 left-1.5 top-2.5 w-0.5 rounded-full", barCls)} />
                <div className="flex items-center justify-between gap-2 text-[11px]">
                  <div className="flex items-center gap-1.5">
                    {a.subagentType && (
                      <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium uppercase text-accent">
                        {a.subagentType}
                      </span>
                    )}
                    <span className={cn("inline-flex items-center gap-1 font-medium", meta.cls)}>
                      {running && <span className="apple-live-dot bg-warning" />}
                      {t(meta.labelKey)}
                    </span>
                  </div>
                  <span className="tabular-nums text-content-subtle">
                    {typeof a.totalTokens === "number" ? `${(a.totalTokens / 1000).toFixed(1)}k tok · ` : ""}
                    {formatDuration(win.end - win.start)}
                  </span>
                </div>
                <div className="mt-1 truncate text-xs font-medium text-content">
                  {a.description || t("chatStream.activity.noDescription")}
                </div>
                {running && a.lastToolName && (
                  <div className="mt-0.5 truncate font-mono text-[11px] text-content-muted">
                    {a.lastToolName}
                  </div>
                )}
                {a.error ? (
                  <div className="mt-0.5 truncate text-[11px] text-danger">{a.error}</div>
                ) : a.summary ? (
                  <div className="mt-0.5 truncate text-[11px] text-content-muted">{a.summary}</div>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </>
  );
}

/* ── 4. 任务进度 ────────────────────────────────────────────────────── */
function TasksCard({
  todos,
  t,
  onClose,
}: {
  todos: TodoItem[];
  t: Translate;
  onClose: () => void;
}) {
  const done = todos.filter((x) => x.status === "completed").length;
  const pct = todos.length > 0 ? Math.round((done / todos.length) * 100) : 0;

  return (
    <>
      <PopoverHeader
        title={t("chatStream.activity.node.tasks")}
        subtitle={t("chatStream.activity.tasksSubtitle", {
          done,
          total: todos.length,
          rest: todos.length - done,
        })}
        right={<span className="font-mono text-xs font-semibold text-accent">{pct}%</span>}
        onClose={onClose}
        t={t}
      />
      <div className="px-3.5 pt-2.5">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-muted">
          <div className="h-full rounded-full bg-accent transition-all duration-300" style={{ width: `${pct}%` }} />
        </div>
      </div>
      <div className="max-h-[260px] space-y-1 overflow-y-auto p-3">
        {todos.map((item, idx) => {
          const isDone = item.status === "completed";
          const isProg = item.status === "in_progress";
          return (
            <div
              key={idx}
              className={cn(
                "flex items-start gap-2 rounded-lg px-2 py-1.5 text-xs",
                isProg && "border border-warning/25 bg-warning/10",
              )}
            >
              {isDone ? (
                <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full bg-success/20 text-success">
                  <IconCheck size={10} strokeWidth={2.6} />
                </span>
              ) : isProg ? (
                <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full bg-warning/20">
                  <span className="apple-live-dot bg-warning" />
                </span>
              ) : (
                <span className="mt-0.5 h-4 w-4 shrink-0 rounded-full border border-edge" />
              )}
              <span
                className={cn(
                  "leading-relaxed",
                  isDone ? "text-content-subtle line-through" : isProg ? "font-medium text-content" : "text-content",
                )}
              >
                {item.content}
              </span>
            </div>
          );
        })}
      </div>
    </>
  );
}

/* ── 5. 会话资产（仅此卡保留分类 Tab）────────────────────────────────── */
type AssetKind = "plans" | "bookmarks" | "sched" | "sidechats";

function BookmarkItem({
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
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const label = bookmark.title ?? bookmark.excerpt;

  const commit = () => {
    setEditing(false);
    onRename?.(bookmark, draft);
  };

  if (editing) {
    return (
      <div className="rounded-xl border border-accent/50 bg-surface p-2">
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
          className="w-full bg-transparent text-xs text-content outline-none"
        />
      </div>
    );
  }

  return (
    <div className="group flex items-center justify-between gap-2 rounded-xl border border-edge bg-surface-muted/30 px-2.5 py-2 transition-colors hover:border-accent/40">
      <button
        type="button"
        disabled={stale || !onPick}
        onClick={() => onPick?.(bookmark)}
        className={cn("min-w-0 flex-1 text-left", stale || !onPick ? "cursor-default" : "cursor-pointer")}
      >
        <div className={cn("truncate text-xs font-medium", stale ? "text-content-subtle" : "text-content")}>
          {label}
        </div>
        {bookmark.title && (
          <div className="mt-0.5 truncate text-[11px] text-content-muted">{bookmark.excerpt}</div>
        )}
      </button>
      <div className="flex shrink-0 items-center gap-1">
        {stale && (
          <span className="rounded bg-surface-muted px-1.5 py-0.5 text-[10px] text-content-subtle">
            {t("chatStream.bookmark.stale")}
          </span>
        )}
        {onRename && (
          <button
            type="button"
            onClick={() => {
              setDraft(bookmark.title ?? "");
              setEditing(true);
            }}
            title={t("chatStream.bookmark.rename")}
            className="hidden rounded p-1 text-content-muted hover:bg-surface-hover hover:text-content group-hover:block"
          >
            <IconPencil size={12} />
          </button>
        )}
        {onRemove && (
          <button
            type="button"
            onClick={() => onRemove(bookmark)}
            title={t("chatStream.bookmark.remove")}
            className="hidden rounded p-1 text-content-muted hover:bg-danger/10 hover:text-danger group-hover:block"
          >
            <IconX size={12} />
          </button>
        )}
      </div>
    </div>
  );
}

function AssetsCard({
  initialTab,
  planBlocks,
  bookmarks,
  automations,
  sideChats,
  sideChatRunningIds,
  isBookmarkStale,
  t,
  onPickPlan,
  onPickBookmark,
  onRemoveBookmark,
  onRenameBookmark,
  onOpenSideChat,
  onOpenSchedPanel,
  onNewSched,
  onClose,
}: {
  initialTab?: AssetKind;
  planBlocks: PlanBlock[];
  bookmarks: SessionBookmark[];
  automations: Automation[];
  sideChats: Session[];
  sideChatRunningIds?: ReadonlySet<string>;
  isBookmarkStale?: (b: SessionBookmark) => boolean;
  t: Translate;
  onPickPlan: (plan: string) => void;
  onPickBookmark?: (b: SessionBookmark) => void;
  onRemoveBookmark?: (b: SessionBookmark) => void;
  onRenameBookmark?: (b: SessionBookmark, title: string) => void;
  onOpenSideChat?: (s: Session) => void;
  onOpenSchedPanel?: () => void;
  onNewSched?: () => void;
  onClose: () => void;
}) {
  const tabs = useMemo(() => {
    const list: { key: AssetKind; label: string; count: number }[] = [];
    if (planBlocks.length > 0) list.push({ key: "plans", label: t("chatStream.activity.node.plans"), count: planBlocks.length });
    if (bookmarks.length > 0) list.push({ key: "bookmarks", label: t("chatStream.activity.node.bookmarks"), count: bookmarks.length });
    if (automations.length > 0) list.push({ key: "sched", label: t("chatStream.activity.node.sched"), count: automations.length });
    if (sideChats.length > 0) list.push({ key: "sidechats", label: t("chatStream.activity.node.sidechats"), count: sideChats.length });
    return list;
  }, [planBlocks.length, bookmarks.length, automations.length, sideChats.length, t]);

  const [tab, setTab] = useState<AssetKind>(() => {
    if (initialTab && tabs.some((x) => x.key === initialTab)) return initialTab;
    return tabs[0]?.key ?? "plans";
  });

  const activeTab: AssetKind = tabs.some((x) => x.key === tab) ? tab : (tabs[0]?.key ?? "plans");
  const staleCheck = isBookmarkStale ?? (() => false);

  return (
    <>
      <PopoverHeader
        title={t("chatStream.activity.deck.assets")}
        onClose={onClose}
        t={t}
      />
      {tabs.length > 1 && (
        <FilterTabs
          active={activeTab}
          onChange={(k) => setTab(k as AssetKind)}
          items={tabs}
        />
      )}
      <div className="max-h-[260px] space-y-2 overflow-y-auto p-2.5">
        {activeTab === "plans" &&
          [...planBlocks].reverse().map((block, i) => {
            const ordinal = planBlocks.length - i;
            const title = extractPlanTitle(block.plan) || t("chatStream.activity.planFallback", { n: ordinal });
            const excerpt = extractPlanExcerpt(block.plan);
            return (
              <button
                key={block.planId}
                type="button"
                onClick={() => onPickPlan(block.plan)}
                className="flex w-full items-start justify-between gap-2 rounded-xl border border-edge bg-surface-muted/30 p-2.5 text-left transition-colors hover:border-accent/50"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-xs font-medium text-content">{title}</span>
                    {i === 0 && (
                      <span className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                        {t("chatStream.activity.latestChip")}
                      </span>
                    )}
                  </div>
                  {excerpt && <div className="mt-1 line-clamp-2 text-[11px] text-content-muted">{excerpt}</div>}
                </div>
                <span className="shrink-0 text-[11px] font-medium text-accent">{t("chatStream.activity.openPlan")}</span>
              </button>
            );
          })}

        {activeTab === "bookmarks" &&
          bookmarks.map((b) => (
            <BookmarkItem
              key={b.id}
              bookmark={b}
              stale={staleCheck(b)}
              t={t}
              onPick={onPickBookmark}
              onRemove={onRemoveBookmark}
              onRename={onRenameBookmark}
            />
          ))}

        {activeTab === "sched" && (
          <div className="space-y-2">
            {(onNewSched || onOpenSchedPanel) && (
              <div className="flex items-center justify-end gap-1.5">
                {onNewSched && (
                  <button
                    type="button"
                    onClick={onNewSched}
                    className="inline-flex items-center gap-1 rounded-lg border border-edge bg-surface px-2 py-1 text-[11px] font-medium text-content hover:bg-surface-hover"
                  >
                    <IconPlus size={11} />
                    {t("chatStream.activity.deck.newSched")}
                  </button>
                )}
                {onOpenSchedPanel && (
                  <button
                    type="button"
                    onClick={onOpenSchedPanel}
                    className="rounded-lg border border-accent/30 bg-accent/10 px-2 py-1 text-[11px] font-medium text-accent hover:bg-accent/20"
                  >
                    {t("chatStream.activity.deck.openSched")} →
                  </button>
                )}
              </div>
            )}
            {sortAutomations(automations).map((task) => {
              const inFlight = isInFlightAutomation(task);
              const nextLine = task.nextRunAt ? formatUntil(task.nextRunAt) : null;
              return (
                <div
                  key={task.id}
                  onClick={onOpenSchedPanel}
                  className={cn(
                    "flex items-center justify-between gap-2 rounded-xl border border-edge bg-surface-muted/30 p-2.5",
                    onOpenSchedPanel && "cursor-pointer transition-colors hover:border-accent/50",
                  )}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      {inFlight ? (
                        <span className="apple-live-dot bg-sky-400" />
                      ) : (
                        <IconClock size={12} className="shrink-0 text-content-muted" />
                      )}
                      <span className="truncate text-xs font-medium text-content">
                        {task.title || task.prompt}
                      </span>
                    </div>
                    <div className="mt-0.5 truncate text-[11px] text-content-muted">
                      {describeSchedule(task.schedule)}
                      {nextLine ? ` · ${t("chatStream.activity.deck.schedNext", { time: nextLine })}` : ""}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {activeTab === "sidechats" &&
          sideChats.map((sc) => {
            const running = !!sideChatRunningIds?.has(sc.id);
            return (
              <button
                key={sc.id}
                type="button"
                onClick={() => onOpenSideChat?.(sc)}
                className="flex w-full items-center justify-between gap-2 rounded-xl border border-edge bg-surface-muted/30 p-2.5 text-left transition-colors hover:border-accent/50"
              >
                <div className="flex min-w-0 items-center gap-1.5">
                  {running && <span className="apple-live-dot bg-indigo-500 dark:bg-indigo-400" />}
                  <span className="truncate text-xs font-medium text-content">
                    {sc.title || t("chatStream.activity.node.sidechats")}
                  </span>
                </div>
                <span className="shrink-0 text-[11px] font-medium text-accent">
                  {t("chatStream.activity.openSideChat")}
                </span>
              </button>
            );
          })}
      </div>
    </>
  );
}

export function ActivityPopoverCard({
  node,
  subagents,
  todos,
  planBlocks,
  bookmarks,
  bashTasks,
  services,
  sideChats,
  sideChatRunningIds,
  automations,
  isBookmarkStale,
  onClose,
  onPickPlan,
  onPickSubagent,
  onStopBashTask,
  onStopService,
  onOpenService,
  onPickBookmark,
  onRemoveBookmark,
  onRenameBookmark,
  onOpenSideChat,
  onOpenSchedPanel,
  onNewSched,
}: ActivityPopoverCardProps) {
  const { t } = useI18n();
  const now = useNow();
  const widthCls = WIDTH_BY_NODE[node] ?? "w-[380px]";

  const isAssetNode =
    node === "overview" || node === "plans" || node === "bookmarks" || node === "sched" || node === "sidechats";

  return (
    <div
      className={cn(
        "flex max-h-[65dvh] max-w-[calc(100vw-40px)] flex-col overflow-hidden rounded-2xl border border-edge bg-surface text-content shadow-xl",
        widthCls,
      )}
    >
      {node === "services" ? (
        <ServicesCard
          services={services}
          now={now}
          t={t}
          onOpen={onOpenService}
          onStop={onStopService}
          onClose={onClose}
        />
      ) : node === "commands" ? (
        <CommandsCard
          tasks={bashTasks}
          now={now}
          t={t}
          onStop={onStopBashTask}
          onClose={onClose}
        />
      ) : node === "subagents" ? (
        <SubagentsCard
          agents={subagents}
          now={now}
          t={t}
          onPick={onPickSubagent}
          onClose={onClose}
        />
      ) : node === "tasks" ? (
        <TasksCard todos={todos} t={t} onClose={onClose} />
      ) : isAssetNode ? (
        <AssetsCard
          initialTab={node === "overview" ? undefined : (node as AssetKind)}
          planBlocks={planBlocks}
          bookmarks={bookmarks}
          automations={automations}
          sideChats={sideChats}
          sideChatRunningIds={sideChatRunningIds}
          isBookmarkStale={isBookmarkStale}
          t={t}
          onPickPlan={onPickPlan}
          onPickBookmark={onPickBookmark}
          onRemoveBookmark={onRemoveBookmark}
          onRenameBookmark={onRenameBookmark}
          onOpenSideChat={onOpenSideChat}
          onOpenSchedPanel={onOpenSchedPanel}
          onNewSched={onNewSched}
          onClose={onClose}
        />
      ) : null}
    </div>
  );
}
