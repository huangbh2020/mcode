/**
 * Side chat panel — the right panel's "quick ask" tab.
 *
 * A side chat is a full hidden session (kind="side") parented to the ACTIVE
 * main session: it streams, approves tools and runs turns fully concurrent
 * with its parent (RuntimeManager keys everything by sessionId), never
 * appears in the left-bar lists, and its history survives restarts. One main
 * session can own many side chats — this panel lists them per parent and
 * hosts one at a time in a reused ChatPane.
 */
import { useEffect, useMemo } from "react";
import type { Session } from "@contracts/session";
import { cn } from "@renderer/lib/cn.js";
import { formatRelativeTime } from "@renderer/lib/time.js";
import {
  IconArrowLeft,
  IconMessageChatbot,
  IconPlus,
} from "@renderer/lib/icons.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { ChatPane } from "@renderer/components/chat/ChatPane.js";

export function SideChatPanel() {
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const sideChats = useSessionStore((s) =>
    s.activeSessionId ? s.sideChatsByParent[s.activeSessionId] : undefined,
  );
  const activeSideChatId = useSessionStore((s) => s.activeSideChatId);
  const hydrateSideChats = useSessionStore((s) => s.hydrateSideChats);
  const createSideChat = useSessionStore((s) => s.createSideChat);
  const selectSideChat = useSessionStore((s) => s.selectSideChat);
  const closeSideChatView = useSessionStore((s) => s.closeSideChatView);
  const openTab = useSessionStore((s) => s.openTab);
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
  onCreate,
  onOpen,
}: {
  hasMainSession: boolean;
  parentTitle?: string;
  sideChats: ReadonlyArray<Session> | undefined;
  onCreate: () => void;
  onOpen: (id: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex h-full flex-col">
      {/* Header: owning main session + the create button. */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-edge bg-surface px-2.5">
        <IconMessageChatbot size={14} className="shrink-0 text-accent" />
        <div className="min-w-0 flex-1 truncate text-xs text-content-muted">
          {hasMainSession ? (
            <>
              <span className="text-content-subtle">{t("sideChat.parentPrefix")} · </span>
              {parentTitle ?? ""}
            </>
          ) : (
            t("sideChat.noMainSession")
          )}
        </div>
        <button
          type="button"
          disabled={!hasMainSession}
          onClick={onCreate}
          title={t("sideChat.newChat")}
          className={cn(
            "flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-[11px] font-medium transition-colors",
            hasMainSession
              ? "bg-accent/15 text-accent hover:bg-accent/25"
              : "cursor-not-allowed bg-surface-muted text-content-subtle opacity-50",
          )}
        >
          <IconPlus size={12} />
          {t("sideChat.newChat")}
        </button>
      </div>

      {/* List body. */}
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {sideChats === undefined ? (
          <p className="px-2 py-4 text-xs text-content-subtle">{t("sideChat.loading")}</p>
        ) : sideChats.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <IconMessageChatbot size={22} className="text-content-subtle" />
            <p className="text-xs font-medium text-content-muted">{t("sideChat.emptyTitle")}</p>
            <p className="text-[11px] leading-relaxed text-content-subtle">{t("sideChat.emptyHint")}</p>
          </div>
        ) : (
          <ul className="space-y-0.5">
            {sideChats.map((s) => (
              <SideChatRow key={s.id} session={s} onOpen={onOpen} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function SideChatRow({ session, onOpen }: { session: Session; onOpen: (id: string) => void }) {
  const { t } = useI18n();
  const running = useSessionStore((s) => !!s.runningBySession[session.id]);
  const isPlaceholder = session.title === "Quick ask";
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(session.id)}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
          "hover:bg-surface-hover",
        )}
      >
        <span
          className={cn(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            running ? "animate-pulse bg-accent" : "bg-content-subtle/40",
          )}
          title={session.title}
        />
        <span className="min-w-0 flex-1 truncate text-xs text-content">
          {isPlaceholder ? t("sideChat.titlePlaceholder") : session.title}
        </span>
        <span className="shrink-0 text-[10px] text-content-subtle">
          {formatRelativeTime(session.createdAt)}
        </span>
      </button>
    </li>
  );
}

/* ── Chat view ── */

function SideChatView({ session, parentRow }: { session: Session; parentRow?: Session }) {
  const { t } = useI18n();
  const closeSideChatView = useSessionStore((s) => s.closeSideChatView);
  const openTab = useSessionStore((s) => s.openTab);
  const parentGone = !!session.parentSessionId && !parentRow;
  const isPlaceholder = session.title === "Quick ask";

  return (
    <div className="flex h-full flex-col">
      {/* Header: back + side chat title + parent jump. */}
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
            {isPlaceholder ? t("sideChat.titlePlaceholder") : session.title}
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
      </div>

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
