/**
 * Side chat panel — the right panel's "quick ask" tab.
 *
 * A side chat is a full hidden session (kind="side") parented to the ACTIVE
 * main session: it streams, approves tools and runs turns fully concurrent
 * with its parent (RuntimeManager keys everything by sessionId), never
 * appears in the left-bar lists, and its history survives restarts. One main
 * session can own many side chats — this panel lists them per parent and
 * hosts one at a time in a reused ChatPane.
 *
 * The list ALSO surfaces the main session's live SUBAGENTS (Task-tool
 * children) above the side-chat list: running first, finished ones kept for
 * review until the next turn. Clicking one opens a read-only transcript view
 * (no composer — the subagent is driven by the model, not the user) fed by
 * the `subagent.transcript` event channel.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@contracts/session";
import type { SubagentSnapshot, SubagentTranscriptBlock } from "@contracts/runtime";
import { cn } from "@renderer/lib/cn.js";
import { formatRelativeTime } from "@renderer/lib/time.js";
import {
  IconArrowLeft,
  IconMessages,
  IconPlus,
  IconTrash,
} from "@renderer/lib/icons.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useSessionStore, type Block } from "@renderer/stores/sessionStore.js";
import { ConfirmDialog } from "@renderer/components/ui/index.js";
import { ChatPane } from "@renderer/components/chat/ChatPane.js";
import { MessageBlocks } from "./MessageBlocks.js";
import { SUBAGENT_STATUS_META, fmtUsage } from "./ActivityPopover.js";

export function SideChatPanel() {
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const sideChats = useSessionStore((s) =>
    s.activeSessionId ? s.sideChatsByParent[s.activeSessionId] : undefined,
  );
  const activeSideChatId = useSessionStore((s) => s.activeSideChatId);
  const subagents = useSessionStore((s) =>
    s.activeSessionId ? s.subagentsBySession[s.activeSessionId] : undefined,
  );
  const hydrateSideChats = useSessionStore((s) => s.hydrateSideChats);
  const createSideChat = useSessionStore((s) => s.createSideChat);
  const selectSideChat = useSessionStore((s) => s.selectSideChat);
  const closeSideChatView = useSessionStore((s) => s.closeSideChatView);
  const openTab = useSessionStore((s) => s.openTab);
  // The subagent whose read-only transcript is open (by taskId). Local state:
  // leaving the tab or switching the parent session falls back to the list —
  // derived, so a roster rebuild that drops the id also resets the view.
  const [viewSubagentTaskId, setViewSubagentTaskId] = useState<string | null>(null);
  useEffect(() => {
    setViewSubagentTaskId(null);
  }, [activeSessionId]);
  // One-shot open request from OUTSIDE the panel (the ActivityPopover's
  // subagent row): enter the requested view when it belongs to the current
  // parent, then drain the request either way (chatFileQueue hand-off
  // pattern). The panel mounts on tab switch — its first effect run consumes
  // whatever request opened it.
  const pendingSubagentView = useSessionStore((s) => s.pendingSubagentView);
  const clearPendingSubagentView = useSessionStore((s) => s.clearPendingSubagentView);
  useEffect(() => {
    if (!pendingSubagentView) return;
    if (pendingSubagentView.sessionId === activeSessionId) {
      setViewSubagentTaskId(pendingSubagentView.taskId);
    }
    clearPendingSubagentView();
  }, [pendingSubagentView, activeSessionId, clearPendingSubagentView]);
  const viewedSubagent = viewSubagentTaskId
    ? subagents?.find((a) => a.taskId === viewSubagentTaskId)
    : undefined;

  // Parent row lookup (title + liveness) spans the active window + pinned
  // bucket — a pinned main session still owns its side chats.
  const mainSessions = useSessionStore((s) => s.sessionsByProject[s.activeProjectId ?? ""]);
  const pinnedSessions = useSessionStore((s) => s.pinnedSessions);
  const parentRow = useMemo(
    () =>
      activeSessionId
        ? mainSessions?.find((x) => x.id === activeSessionId) ??
          pinnedSessions.find((x) => x.id === activeSessionId)
        : undefined,
    [activeSessionId, mainSessions, pinnedSessions],
  );

  // Hydrate the active parent's list (covers first open + main-session
  // switches; the fetch itself is cheap and idempotent).
  useEffect(() => {
    if (activeSessionId) void hydrateSideChats(activeSessionId);
  }, [activeSessionId, hydrateSideChats]);

  if (viewedSubagent && activeSessionId) {
    return (
      <SubagentView
        agent={viewedSubagent}
        sessionId={activeSessionId}
        onBack={() => setViewSubagentTaskId(null)}
      />
    );
  }

  // The chat view only applies when the active side chat belongs to the
  // CURRENT parent — after a main-session switch the stale id falls back to
  // the list view (derived, so no reset effect is needed).
  const activeSide = activeSideChatId
    ? sideChats?.find((x) => x.id === activeSideChatId)
    : undefined;
  const view: "list" | "chat" = activeSide ? "chat" : "list";

  if (view === "chat" && activeSide) {
    return <SideChatView session={activeSide} parentRow={parentRow} />;
  }
  return (
    <SideChatListView
      hasMainSession={!!activeSessionId}
      parentTitle={parentRow?.title}
      sideChats={sideChats}
      subagents={subagents}
      onOpenSubagent={setViewSubagentTaskId}
      onCreate={() => void createSideChat()}
      onOpen={(id) => void selectSideChat(id)}
    />
  );
}

/* ── List view ── */

function SideChatListView({
  hasMainSession,
  parentTitle,
  sideChats,
  subagents,
  onOpenSubagent,
  onCreate,
  onOpen,
}: {
  hasMainSession: boolean;
  parentTitle?: string;
  sideChats: ReadonlyArray<Session> | undefined;
  subagents: ReadonlyArray<SubagentSnapshot> | undefined;
  onOpenSubagent: (taskId: string) => void;
  onCreate: () => void;
  onOpen: (id: string) => void;
}) {
  const { t } = useI18n();
  const deleteSession = useSessionStore((s) => s.deleteSession);
  // Row awaiting delete confirmation — held so the dialog can show the
  // row's display title (placeholder resolved) while it's open.
  const [pendingDelete, setPendingDelete] = useState<Session | null>(null);
  // Running first (stable sort keeps arrival order within each group) — the
  // live ones are what the user wants to check; finished ones stay reviewable
  // below until the next turn clears the roster.
  const orderedSubagents = useMemo(
    () =>
      subagents
        ? [...subagents].sort(
            (a, b) =>
              (a.status === "running" ? 0 : 1) - (b.status === "running" ? 0 : 1),
          )
        : undefined,
    [subagents],
  );
  return (
    <div className="flex h-full flex-col">
      {/* Header: owning main session + the create button. */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-edge bg-surface px-2.5">
        <IconMessages size={14} className="shrink-0 text-accent" />
        <div className="min-w-0 flex-1 truncate text-xs text-content-muted">
          {hasMainSession ? (parentTitle ?? "") : t("sideChat.noMainSession")}
        </div>
        <button
          type="button"
          disabled={!hasMainSession}
          onClick={onCreate}
          title={t("sideChat.newChat")}
          className={cn(
            "flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors",
            hasMainSession
              ? "bg-accent/15 text-accent hover:bg-accent/25"
              : "cursor-not-allowed bg-accent/5 text-content-subtle opacity-50",
          )}
        >
          <IconPlus size={14} />
        </button>
      </div>

      {/* List body. */}
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {/* Live subagents (model-initiated Task children) — read-only
            transcripts behind each row. */}
        {orderedSubagents && orderedSubagents.length > 0 && (
          <div className="mb-2">
            <div className="px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wide text-content-subtle">
              {t("sideChat.subagentsSection")}
            </div>
            <ul className="space-y-0.5">
              {orderedSubagents.map((a) => (
                <SubagentRow key={a.taskId} agent={a} onOpen={() => onOpenSubagent(a.taskId)} />
              ))}
            </ul>
          </div>
        )}
        {sideChats === undefined ? (
          <p className="px-2 py-4 text-xs text-content-subtle">{t("sideChat.loading")}</p>
        ) : sideChats.length === 0 && !(orderedSubagents && orderedSubagents.length > 0) ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <IconMessages size={22} className="text-content-subtle" />
            <p className="text-xs font-medium text-content-muted">{t("sideChat.emptyTitle")}</p>
            <p className="text-[11px] leading-relaxed text-content-subtle">{t("sideChat.emptyHint")}</p>
          </div>
        ) : (
          <ul className="space-y-0.5">
            {sideChats.map((s) => (
              <SideChatRow key={s.id} session={s} onOpen={onOpen} onDelete={setPendingDelete} />
            ))}
          </ul>
        )}
      </div>

      {/* Delete confirmation — hard-deletes the side chat (messages cascade
          in the DB); the row leaves the list via applySessionDeletedState. */}
      <ConfirmDialog
        open={pendingDelete != null}
        danger
        title={t("sideChat.deleteChat")}
        description={t("sideChat.deleteChatDesc", {
          title: pendingDelete ? displayTitle(pendingDelete, t("sideChat.titlePlaceholder")) : "",
        })}
        confirmText={t("common.delete")}
        onOpenChange={(open) => { if (!open) setPendingDelete(null); }}
        onConfirm={() => {
          if (pendingDelete) void deleteSession(pendingDelete.id);
        }}
      />
    </div>
  );
}

function SubagentRow({
  agent,
  onOpen,
}: {
  agent: SubagentSnapshot;
  onOpen: () => void;
}) {
  const { t } = useI18n();
  const running = agent.status === "running";
  const usage = fmtUsage(agent);
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        title={agent.description}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-hover"
      >
        <span
          className={cn(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            running
              ? "animate-pulse bg-accent"
              : agent.status === "completed"
                ? "bg-accent/50"
                : agent.status === "failed" || agent.status === "killed"
                  ? "bg-danger/70"
                  : "bg-content-subtle/40",
          )}
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            {agent.subagentType && (
              <span className="shrink-0 rounded bg-info/20 px-1 text-[9px] font-medium uppercase tracking-wide text-info">
                {agent.subagentType}
              </span>
            )}
            <span className="min-w-0 flex-1 truncate text-xs text-content">
              {agent.description || t("sideChat.titlePlaceholder")}
            </span>
          </span>
          {(agent.lastToolName || usage) && (
            <span className="mt-0.5 block truncate text-[10px] text-content-subtle">
              {[agent.lastToolName, usage].filter(Boolean).join(" · ")}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}

/** Row/view title with the "Quick ask" placeholder resolved to the locale
 *  label — the raw placeholder (the DB-side sentinel for "never used") must
 *  never reach the UI. */
function displayTitle(session: Session, placeholder: string): string {
  return session.title === "Quick ask" ? placeholder : session.title;
}

function SideChatRow({
  session,
  onOpen,
  onDelete,
}: {
  session: Session;
  onOpen: (id: string) => void;
  onDelete: (session: Session) => void;
}) {
  const { t } = useI18n();
  const running = useSessionStore((s) => !!s.runningBySession[session.id]);
  return (
    // The li is the hover surface; the open action and the delete action are
    // sibling buttons (a button inside a button is invalid HTML). The delete
    // affordance appears on hover, LeftBar row style, and is gated while the
    // chat's turn is running — deleting mid-stream would orphan the runtime.
    <li className="group flex items-center rounded-md pr-0.5 transition-colors hover:bg-surface-hover">
      <button
        type="button"
        onClick={() => onOpen(session.id)}
        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left"
      >
        <span
          className={cn(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            running ? "animate-pulse bg-accent" : "bg-content-subtle/40",
          )}
          title={session.title}
        />
        <span className="min-w-0 flex-1 truncate text-xs text-content">
          {displayTitle(session, t("sideChat.titlePlaceholder"))}
        </span>
        <span className="shrink-0 text-[10px] text-content-subtle">
          {formatRelativeTime(session.createdAt)}
        </span>
      </button>
      <button
        type="button"
        disabled={running}
        onClick={() => onDelete(session)}
        title={running ? undefined : t("sideChat.deleteChat")}
        className={cn(
          "flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-content-subtle transition-all",
          "hover:bg-surface-hover hover:text-danger focus-visible:opacity-100",
          "opacity-0 group-hover:opacity-100",
          running && "pointer-events-none opacity-0",
        )}
      >
        <IconTrash size={13} />
      </button>
    </li>
  );
}

/* ── Subagent read-only transcript view ── */

/** SubagentTranscriptBlock → renderer Block. The contracts type mirrors the
 *  renderer's Block members field-for-field — the explicit mapping (rather
 *  than a cast) keeps the drift surface visible and the strict style. */
function mapTranscriptBlock(b: SubagentTranscriptBlock): Block {
  if (b.kind === "text") return { kind: "text", text: b.text };
  if (b.kind === "thinking") return { kind: "thinking", text: b.text };
  return {
    kind: "tool_use",
    toolCallId: b.toolCallId,
    toolName: b.toolName,
    input: b.input,
    status: b.status,
    ...(b.result !== undefined ? { result: b.result } : {}),
  };
}

function SubagentView({
  agent,
  sessionId,
  onBack,
}: {
  agent: SubagentSnapshot;
  sessionId: string;
  onBack: () => void;
}) {
  const { t } = useI18n();
  const scrollRef = useRef<HTMLDivElement>(null);
  const rawBlocks = useSessionStore(
    (s) => s.subagentTranscriptsBySession[sessionId]?.[agent.toolUseId ?? ""],
  );
  const blocks = useMemo(
    () => (rawBlocks ?? []).map(mapTranscriptBlock),
    [rawBlocks],
  );
  const running = agent.status === "running";
  const usage = fmtUsage(agent);
  const meta = SUBAGENT_STATUS_META[agent.status];

  // Follow the tail while the subagent is live — new blocks scroll the view
  // to the bottom (same auto-follow intent as the main stream).
  useEffect(() => {
    if (running) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [blocks, running]);

  return (
    <div className="flex h-full flex-col">
      {/* Header: back + subagent description + status/usage. */}
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-edge bg-surface px-2">
        <button
          type="button"
          onClick={onBack}
          title={t("sideChat.backToList")}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-content-muted transition-colors hover:bg-surface-hover hover:text-content"
        >
          <IconArrowLeft size={15} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {agent.subagentType && (
              <span className="shrink-0 rounded bg-info/20 px-1 text-[9px] font-medium uppercase tracking-wide text-info">
                {agent.subagentType}
              </span>
            )}
            <span className="truncate text-xs font-medium text-content">
              {agent.description || t("sideChat.titlePlaceholder")}
            </span>
          </div>
          <div className="flex items-center gap-1 text-[10px] text-content-subtle">
            <span className={cn("flex items-center gap-1", meta.cls)}>
              {running && (
                <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-warning" />
              )}
              {t(meta.labelKey)}
            </span>
            {usage && <span className="truncate">· {usage}</span>}
          </div>
        </div>
      </div>

      {/* Read-only transcript — MessageBlocks is a pure presentational
          component (no composer, no send path, no per-session store buckets);
          the subagent is model-driven, the user only watches. */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-2.5 py-2">
        {blocks.length === 0 ? (
          <p className="px-2 py-4 text-xs text-content-subtle">
            {t("sideChat.subagentWaiting")}
          </p>
        ) : (
          <MessageBlocks blocks={blocks} />
        )}
      </div>
    </div>
  );
}

/* ── Chat view ── */

function SideChatView({ session, parentRow }: { session: Session; parentRow?: Session }) {
  const { t } = useI18n();
  const closeSideChatView = useSessionStore((s) => s.closeSideChatView);
  const deleteSession = useSessionStore((s) => s.deleteSession);
  const openTab = useSessionStore((s) => s.openTab);
  const running = useSessionStore((s) => !!s.runningBySession[session.id]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const parentGone = !!session.parentSessionId && !parentRow;

  return (
    <div className="flex h-full flex-col">
      {/* Header: back + side chat title + parent jump + delete. */}
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-edge bg-surface px-2">
        <button
          type="button"
          onClick={closeSideChatView}
          title={t("sideChat.backToList")}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-content-muted transition-colors hover:bg-surface-hover hover:text-content"
        >
          <IconArrowLeft size={15} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-content">
            {displayTitle(session, t("sideChat.titlePlaceholder"))}
          </div>
          {session.parentSessionId ? (
            <button
              type="button"
              disabled={parentGone}
              onClick={() => void openTab(session.parentSessionId as string)}
              title={parentGone ? t("sideChat.parentDeleted") : t("sideChat.goToParent")}
              className={cn(
                "block max-w-full truncate text-left text-[10px]",
                parentGone
                  ? "cursor-default text-content-subtle"
                  : "text-accent hover:underline",
              )}
            >
              <span className="text-content-subtle">{t("sideChat.parentPrefix")} · </span>
              {parentGone ? t("sideChat.parentDeleted") : (parentRow?.title ?? "")}
            </button>
          ) : (
            <span className="block truncate text-[10px] text-content-subtle">
              {t("sideChat.parentDeleted")}
            </span>
          )}
        </div>
        <button
          type="button"
          disabled={running}
          onClick={() => setConfirmDelete(true)}
          title={running ? undefined : t("sideChat.deleteChat")}
          className={cn(
            "flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-content-muted transition-colors",
            "hover:bg-surface-hover hover:text-danger",
            running && "pointer-events-none opacity-40",
          )}
        >
          <IconTrash size={14} />
        </button>
      </div>

      {/* Delete confirmation — same hard-delete path as the list rows; the
          cleared activeSideChatId drops the view back to the list. */}
      <ConfirmDialog
        open={confirmDelete}
        danger
        title={t("sideChat.deleteChat")}
        description={t("sideChat.deleteChatDesc", {
          title: displayTitle(session, t("sideChat.titlePlaceholder")),
        })}
        confirmText={t("common.delete")}
        onOpenChange={(open) => { if (!open) setConfirmDelete(false); }}
        onConfirm={() => { void deleteSession(session.id); }}
      />

      {/* The chat itself — ChatPane is fully sessionId-parameterized on the
          read side; sends carry the explicit sessionId (see handleSend).
          chipsMode="collapsed": the narrow panel always shows the single-icon
          chip toggle (model / effort / permission behind one icon) instead of
          measuring whether the full chip row fits. */}
      <div className="min-h-0 flex-1">
        <ChatPane sessionId={session.id} isActive chipsMode="collapsed" />
      </div>
    </div>
  );
}
