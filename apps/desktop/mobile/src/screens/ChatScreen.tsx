/**
 * ChatScreen — the main mobile chat surface.
 *
 * Layout: a top bar (drawer toggle / title / new / git), the message timeline,
 * inline approval/question cards, and a lightweight composer. Phase 4 ships a
 * minimal but functional version; Phase 5 rounds out the message rendering +
 * sessions drawer + git panel.
 */
import { useEffect, useRef, useState } from "react";
import { useMobileStore, type MobileMessage, type Block } from "../stores/mobileStore.js";
import { useMobileEvents, type ConnectionState } from "../lib/useMobileEvents.js";
import { MobileComposer } from "../components/MobileComposer.js";
import { ApprovalCard } from "../components/ApprovalCard.js";
import { SessionsDrawer } from "./SessionsDrawer.js";
import { GitScreen } from "./GitScreen.js";

interface Props {
  onDisconnect: () => void;
}

export function ChatScreen({ onDisconnect }: Props) {
  const hydrated = useMobileStore((s) => s.hydrated);
  const init = useMobileStore((s) => s.init);
  const [view, setView] = useState<"chat" | "git">("chat");

  // Hydrate once after pairing (or on reload when already paired).
  useEffect(() => {
    if (!hydrated) void init();
  }, [hydrated, init]);

  // Subscribe to the SSE event stream. Always on while in the chat shell.
  const conn = useMobileEvents(true);

  if (view === "git") {
    return <GitScreen onBack={() => setView("chat")} />;
  }

  return (
    <div className="flex h-full flex-col">
      <TopBar connection={conn} onDisconnect={onDisconnect} onOpenGit={() => setView("git")} />
      <Timeline />
      <ApprovalCard />
      <MobileComposer />
    </div>
  );
}

function TopBar({ connection, onDisconnect, onOpenGit }: { connection: ConnectionState; onDisconnect: () => void; onOpenGit: () => void }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const activeSessionId = useMobileStore((s) => s.activeSessionId);
  const sessionsByProject = useMobileStore((s) => s.sessionsByProject);
  const projects = useMobileStore((s) => s.projects);

  // Derive the active session title.
  const title = useMobileStore((s) => {
    if (!s.activeSessionId) return "Mcode";
    for (const list of Object.values(s.sessionsByProject)) {
      const found = list?.find((x) => x.id === s.activeSessionId);
      if (found) return found.title;
    }
    return "Mcode";
  });

  const newSession = useMobileStore((s) => s.startSession);
  const activeProjectId = useMobileStore((s) => s.activeProjectId);

  const connColor =
    connection === "open" ? "bg-accent" : connection === "reconnecting" ? "bg-warning" : "bg-content-subtle";

  return (
    <>
      <header className="no-select flex h-12 shrink-0 items-center gap-2 border-b border-edge bg-surface px-2">
        <button
          onClick={() => setDrawerOpen(true)}
          className="rounded p-2 text-content-muted hover:bg-surface-hover"
          aria-label="会话列表"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
        <div className="min-w-0 flex-1 truncate text-sm font-medium text-content">{title}</div>
        {/* Connection indicator dot */}
        <span title={`连接：${connection}`} className={"mr-1 h-2 w-2 shrink-0 rounded-full " + connColor} />
        {/* Git panel entry */}
        <button
          onClick={onOpenGit}
          className="rounded p-2 text-content-muted hover:bg-surface-hover"
          aria-label="Git 提交"
          title="Git 提交"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="18" cy="6" r="3" />
            <circle cx="6" cy="18" r="3" />
            <path d="M6 9v3a3 3 0 0 0 3 3h6" />
          </svg>
        </button>
        <button
          onClick={() => activeProjectId && void newSession(activeProjectId)}
          className="rounded p-2 text-content-muted hover:bg-surface-hover"
          aria-label="新建会话"
          title="新建会话"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </header>
      {drawerOpen && (
        <SessionsDrawer
          projects={projects}
          sessionsByProject={sessionsByProject}
          activeSessionId={activeSessionId}
          onClose={() => setDrawerOpen(false)}
          onDisconnect={onDisconnect}
        />
      )}
    </>
  );
}

function Timeline() {
  const activeSessionId = useMobileStore((s) => s.activeSessionId);
  const messages = useMobileStore((s) => (activeSessionId ? s.messagesBySession[activeSessionId] : undefined) ?? []);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll to bottom on new content.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  if (!activeSessionId) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-content-subtle">
        从左侧选择一个会话，或点击右上角 + 新建会话。
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-content-subtle">
        开始一段新对话吧
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto overflow-x-hidden px-3 py-3">
      {messages.map((m) => (
        <MessageRow key={m.id} message={m} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}

function MessageRow({ message }: { message: MobileMessage }) {
  const isUser = message.role === "user";
  return (
    <div className={"mb-3 flex " + (isUser ? "justify-end" : "justify-start")}>
      <div
        className={
          "max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-relaxed " +
          (isUser ? "bg-userBubble/15 text-content" : "bg-surface-muted text-content")
        }
      >
        {message.blocks.map((b, i) => (
          <BlockView key={i} block={b} />
        ))}
      </div>
    </div>
  );
}

/** Minimal block renderer (Phase 4). Phase 5 will reuse the desktop Markdown
 *  renderer for richer text + code blocks. */
function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case "text":
      return <div className="whitespace-pre-wrap break-words">{block.text}</div>;
    case "thinking":
      return <details className="mb-1 text-xs text-content-subtle"><summary>思考过程</summary><div className="whitespace-pre-wrap">{block.text}</div></details>;
    case "tool_use":
      return (
        <div className="my-1 rounded border border-edge px-2 py-1 text-xs">
          <span className="font-mono">🔧 {block.toolName}</span>{" "}
          <span className={block.status === "done" ? "text-accent" : block.status === "error" ? "text-danger" : "text-content-muted"}>
            {block.status === "running" ? "…" : block.status === "error" ? "✕" : "✓"}
          </span>
        </div>
      );
    case "error":
      return <div className="text-xs text-danger">⚠ {block.message}</div>;
    case "turn-files":
      return (
        <div className="my-1 text-xs text-content-muted">
          本轮修改 {block.files.length} 个文件
        </div>
      );
    case "image":
      return <img src={`data:${block.mimeType};base64,${block.data}`} alt="screenshot" className="my-1 max-w-full rounded" />;
    default:
      return null;
  }
}
