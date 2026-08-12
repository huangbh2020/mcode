/**
 * mobileStore — the Zustand store backing the mobile web app.
 *
 * A focused subset of the desktop sessionStore: it shares the same contracts
 * types (Project / Session / RuntimeEvent) and the same message-assembly
 * semantics (text.delta → assistant message; tool.use → tool block;
 * turn.done → freeze), but drops everything desktop-only (layout, tabs,
 * terminal, virtualization grouping, toast/unread bookkeeping, interrupt
 * sentinels). Mobile renders one session at a time, so the reducer can stay
 * straightforward.
 *
 * Deltas are applied directly (no rAF batching) — message volumes on a phone
 * are small enough that per-delta setState is fine, and avoiding the batching
 * machinery keeps this file self-contained.
 */
import { create } from "zustand";
import type { RuntimeEvent, TurnFileEntry } from "@contracts/runtime";
import type { Project, Session, MessageRecord } from "@contracts/session";
import { mobileApi } from "../lib/mobileApi.js";

/** A content block within a message (mobile-relevant subset of the desktop Block union). */
export type Block =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_use"; toolCallId: string; toolName: string; input: unknown; status: "running" | "done" | "error"; result?: unknown }
  | { kind: "error"; message: string }
  | { kind: "turn-files"; files: TurnFileEntry[] }
  | { kind: "image"; toolCallId: string; data: string; mimeType: "image/png" };

/** A chat message rendered in the timeline. `turnMeta` marks the first
 *  assistant message of a turn (for the optional started/duration header). */
export interface MobileMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  blocks: Block[];
  createdAt: number;
  turnMeta?: { startedAt: number; endedAt?: number };
}

const EMPTY: never[] = [];

function asMessages(records: MessageRecord[] | undefined): MobileMessage[] {
  if (!records || records.length === 0) return [];
  // records carry `{ blocks, turnMeta? }` (desktop persistence shape) or a raw
  // blocks array (legacy). Normalize both.
  return records.map((r) => {
    const content = r.content as { blocks?: Block[]; turnMeta?: MobileMessage["turnMeta"] } | Block[];
    if (Array.isArray(content)) {
      return { id: r.id, sessionId: r.sessionId, role: r.role, blocks: content, createdAt: r.createdAt };
    }
    return {
      id: r.id,
      sessionId: r.sessionId,
      role: r.role,
      blocks: content.blocks ?? [],
      createdAt: r.createdAt,
      turnMeta: content.turnMeta,
    };
  });
}

interface MobileState {
  // data
  projects: Project[];
  sessionsByProject: Record<string, Session[]>;
  messagesBySession: Record<string, MobileMessage[]>;
  activeSessionId: string | null;
  activeProjectId: string | null;
  runningBySession: Record<string, boolean>;
  pendingApprovals: Extract<RuntimeEvent, { type: "approval.request" }>[];
  pendingQuestionBySession: Record<string, { requestId: string; questions: unknown[] }>;
  // lifecycle
  hydrated: boolean;
  loading: Record<string, boolean>;

  // actions
  init: () => Promise<void>;
  loadSessions: (projectId: string) => Promise<void>;
  selectProject: (projectId: string) => Promise<void>;
  selectSession: (sessionId: string) => Promise<void>;
  startSession: (projectId: string) => Promise<string | null>;
  sendPrompt: (sessionId: string, prompt: string) => Promise<void>;
  interrupt: (sessionId: string) => Promise<void>;
  approve: (requestId: string, granted: boolean) => Promise<void>;
  respondQuestion: (sessionId: string, requestId: string, answers: Record<string, string | string[] | null>) => Promise<void>;
  ingestEvent: (e: unknown) => void;
  recoverAfterReconnect: () => Promise<void>;
}

export const useMobileStore = create<MobileState>((set, get) => ({
  projects: [],
  sessionsByProject: {},
  messagesBySession: {},
  activeSessionId: null,
  activeProjectId: null,
  runningBySession: {},
  pendingApprovals: [],
  pendingQuestionBySession: {},
  hydrated: false,
  loading: {},

  async init() {
    try {
      const { projects } = await mobileApi.project.list();
      set({ projects: projects as Project[], hydrated: true });
      // Auto-select the first project + its first session so the chat opens
      // immediately after pairing.
      if ((projects as Project[]).length > 0) {
        await get().selectProject((projects as Project[])[0].id);
      }
    } catch (err) {
      console.error("mobile init failed", err);
      set({ hydrated: true });
    }
  },

  async loadSessions(projectId) {
    set((s) => ({ loading: { ...s.loading, [`p:${projectId}`]: true } }));
    try {
      const { sessions } = await mobileApi.project.sessions({ projectId, limit: 30, offset: 0 });
      set((s) => ({ sessionsByProject: { ...s.sessionsByProject, [projectId]: sessions as Session[] } }));
    } finally {
      set((s) => ({ loading: { ...s.loading, [`p:${projectId}`]: false } }));
    }
  },

  async selectProject(projectId) {
    set({ activeProjectId: projectId });
    if (!get().sessionsByProject[projectId]) {
      await get().loadSessions(projectId);
    }
    // Auto-pick the first (most recent) session in the project.
    const sessions = get().sessionsByProject[projectId] ?? [];
    if (sessions.length > 0 && !get().messagesBySession[sessions[0].id]) {
      await get().selectSession(sessions[0].id);
    }
  },

  async selectSession(sessionId) {
    set({ activeSessionId: sessionId });
    if (!get().messagesBySession[sessionId]) {
      try {
        const { messages } = await mobileApi.session.messages({ sessionId });
        set((s) => ({ messagesBySession: { ...s.messagesBySession, [sessionId]: asMessages(messages as MessageRecord[]) } }));
      } catch (err) {
        console.error("load messages failed", err);
      }
    }
  },

  async startSession(projectId) {
    try {
      const { session } = (await mobileApi.claude.startSession({ projectId })) as { session: Session };
      set((s) => ({
        sessionsByProject: {
          ...s.sessionsByProject,
          [projectId]: [session, ...(s.sessionsByProject[projectId] ?? [])],
        },
        activeSessionId: session.id,
        messagesBySession: { ...s.messagesBySession, [session.id]: [] },
      }));
      return session.id;
    } catch (err) {
      console.error("startSession failed", err);
      return null;
    }
  },

  async sendPrompt(sessionId, prompt) {
    // Optimistically append the user message so the timeline reacts instantly.
    const userMsg: MobileMessage = {
      id: `u_${Date.now()}`,
      sessionId,
      role: "user",
      blocks: [{ kind: "text", text: prompt }],
      createdAt: Date.now(),
    };
    set((s) => ({
      messagesBySession: { ...s.messagesBySession, [sessionId]: [...(s.messagesBySession[sessionId] ?? []), userMsg] },
      runningBySession: { ...s.runningBySession, [sessionId]: true },
    }));
    try {
      await mobileApi.claude.sendTurn({ sessionId, prompt });
    } catch (err) {
      console.error("sendTurn failed", err);
      set((s) => ({ runningBySession: { ...s.runningBySession, [sessionId]: false } }));
    }
  },

  async interrupt(sessionId) {
    try {
      await mobileApi.claude.interrupt({ sessionId });
    } catch (err) {
      console.error("interrupt failed", err);
    }
    set((s) => ({ runningBySession: { ...s.runningBySession, [sessionId]: false } }));
  },

  async approve(requestId, granted) {
    // Optimistically remove so the card disappears.
    set((s) => ({ pendingApprovals: s.pendingApprovals.filter((p) => p.requestId !== requestId) }));
    try {
      await mobileApi.claude.approve({ requestId, granted });
    } catch (err) {
      console.error("approve failed", err);
    }
  },

  async respondQuestion(sessionId, requestId, answers) {
    set((s) => {
      const next = { ...s.pendingQuestionBySession };
      delete next[sessionId];
      return { pendingQuestionBySession: next };
    });
    try {
      await mobileApi.claude.respondQuestion({ sessionId, requestId, answers });
    } catch (err) {
      console.error("respondQuestion failed", err);
    }
  },

  ingestEvent(raw) {
    const e = raw as RuntimeEvent;
    if (!e || typeof e !== "object" || typeof (e as { sessionId?: unknown }).sessionId !== "string") return;
    const sid = (e as { sessionId: string }).sessionId;
    const list = get().messagesBySession[sid] ?? [];

    // Side-channel events (not message-assembly):
    switch (e.type) {
      case "approval.request": {
        set((s) => ({
          pendingApprovals: [...s.pendingApprovals.filter((p) => p.requestId !== e.requestId), e],
        }));
        return;
      }
      case "question.ask": {
        const requestId = e.requestId;
        if (!requestId) return;
        set((s) => ({
          pendingQuestionBySession: { ...s.pendingQuestionBySession, [sid]: { requestId, questions: e.questions as unknown[] } },
        }));
        return;
      }
      case "token-usage.updated":
      case "todo.update":
      case "subagent.update":
      case "mode.change":
        // Tracked on desktop; mobile renders a minimal UI and ignores these
        // for now (a future phase can surface a context-usage chip).
        return;
      case "plan.update":
      case "plan.approval_request":
        // Plan rendering is desktop-rich; mobile shows a simple text summary
        // by appending it as an assistant text block once ready.
        if (e.type === "plan.update" && e.phase === "ready" && e.plan) {
          appendAssistantText(set, get, sid, e.plan);
        }
        return;
      default:
        break;
    }

    // Message-assembly events:
    let next = list;
    switch (e.type) {
      case "text.delta": {
        next = appendDelta(list, e.messageId, sid, { text: e.text, thinking: "" });
        break;
      }
      case "thinking": {
        next = appendDelta(list, e.messageId, sid, { text: "", thinking: e.text });
        break;
      }
      case "tool.use": {
        const block: Block = { kind: "tool_use", toolCallId: e.toolCallId, toolName: e.toolName, input: e.input, status: "running" };
        next = appendBlock(list, e.messageId, sid, block, get);
        break;
      }
      case "tool.result": {
        next = list.map((m) => {
          const has = m.blocks.some((b) => b.kind === "tool_use" && b.toolCallId === e.toolCallId);
          if (!has) return m;
          const blocks = m.blocks.map((b) =>
            b.kind === "tool_use" && b.toolCallId === e.toolCallId
              ? { ...b, status: (e.isError ? "error" : "done") as "done" | "error", result: e.content }
              : b,
          );
          return { ...m, blocks };
        });
        break;
      }
      case "turn.files": {
        const block: Block = { kind: "turn-files", files: e.files };
        // Append to the trailing assistant message of the active turn.
        next = appendToTrailingAssistant(list, sid, block);
        break;
      }
      case "browser.image": {
        next = list.map((m) => {
          const idx = m.blocks.findIndex((b) => b.kind === "tool_use" && b.toolCallId === e.toolCallId);
          if (idx < 0) return m;
          if (m.blocks.some((b) => b.kind === "image" && b.toolCallId === e.toolCallId)) return m;
          const blocks = [...m.blocks];
          blocks.splice(idx + 1, 0, { kind: "image", toolCallId: e.toolCallId, data: e.data, mimeType: e.mimeType });
          return { ...m, blocks };
        });
        break;
      }
      case "error": {
        next = [...list, { id: `err_${Date.now()}`, sessionId: sid, role: "assistant" as const, blocks: [{ kind: "error", message: e.message }], createdAt: Date.now() }];
        next = stampTurnEnd(next, Date.now());
        set((s) => ({ runningBySession: { ...s.runningBySession, [sid]: false }, pendingApprovals: s.pendingApprovals.filter((p) => p.sessionId !== sid) }));
        break;
      }
      case "turn.done": {
        // Close any still-running tool_use (plan mode / interrupted).
        next = next.map((m) => ({
          ...m,
          blocks: m.blocks.map((b) =>
            b.kind === "tool_use" && b.status === "running"
              ? { ...b, status: "done" as const, result: b.result ?? "(no result — turn ended)" }
              : b,
          ),
        }));
        next = stampTurnEnd(next, Date.now());
        set((s) => ({ runningBySession: { ...s.runningBySession, [sid]: false } }));
        break;
      }
      default:
        return;
    }

    set((s) => ({ messagesBySession: { ...s.messagesBySession, [sid]: next } }));
  },

  async recoverAfterReconnect() {
    // Re-fetch the active session's messages so deltas missed while the SSE
    // link was down are recovered as aggregated state.
    const sid = get().activeSessionId;
    if (!sid) return;
    try {
      const { messages } = await mobileApi.session.messages({ sessionId: sid });
      set((s) => ({ messagesBySession: { ...s.messagesBySession, [sid]: asMessages(messages as MessageRecord[]) } }));
    } catch {
      // ignore — the live stream will keep flowing
    }
  },
}));

// ── reducer helpers ────────────────────────────────────────────────────────

/** Append a text/thinking delta to the assistant message with the given id,
 *  creating it (as a fresh turn) when missing. */
function appendDelta(
  list: MobileMessage[],
  messageId: string,
  sessionId: string,
  delta: { text: string; thinking: string },
): MobileMessage[] {
  const idx = list.findIndex((m) => m.id === messageId);
  if (idx >= 0) {
    const m = list[idx];
    const blocks = applyDeltaToBlocks(m.blocks, delta);
    return list.map((mm, i) => (i === idx ? { ...m, blocks } : mm));
  }
  // New assistant message — start a turn.
  const startedAt = Date.now();
  const created: MobileMessage = {
    id: messageId,
    sessionId,
    role: "assistant",
    blocks: applyDeltaToBlocks([], delta),
    createdAt: startedAt,
    turnMeta: { startedAt },
  };
  return [...list, created];
}

function applyDeltaToBlocks(blocks: Block[], delta: { text: string; thinking: string }): Block[] {
  let next = blocks;
  if (delta.text) {
    const last = next[next.length - 1];
    if (last && last.kind === "text") {
      next = [...next.slice(0, -1), { ...last, text: last.text + delta.text }];
    } else {
      next = [...next, { kind: "text", text: delta.text }];
    }
  }
  if (delta.thinking) {
    const last = next[next.length - 1];
    if (last && last.kind === "thinking") {
      next = [...next.slice(0, -1), { ...last, text: last.text + delta.thinking }];
    } else {
      next = [...next, { kind: "thinking", text: delta.thinking }];
    }
  }
  return next;
}

/** Append a non-text block (tool_use / turn-files) to the message with the
 *  given id, or to the open turn's trailing assistant message. */
function appendBlock(
  list: MobileMessage[],
  messageId: string | undefined,
  sessionId: string,
  block: Block,
  get: () => MobileState,
): MobileMessage[] {
  if (messageId) {
    const idx = list.findIndex((m) => m.id === messageId);
    if (idx >= 0) {
      const m = list[idx];
      return list.map((mm, i) => (i === idx ? { ...m, blocks: [...m.blocks, block] } : mm));
    }
  }
  return appendToTrailingAssistant(list, sessionId, block, get);
}

/** Append a block to the trailing assistant message of the open turn; create
 *  one if none exists. */
function appendToTrailingAssistant(list: MobileMessage[], sessionId: string, block: Block, _get?: () => MobileState): MobileMessage[] {
  // Find the last assistant message whose turn hasn't ended.
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m.role === "assistant" && m.turnMeta && m.turnMeta.endedAt === undefined) {
      const updated = { ...m, blocks: [...m.blocks, block] };
      return list.map((mm, idx) => (idx === i ? updated : mm));
    }
  }
  // No open turn — start one.
  const startedAt = Date.now();
  const created: MobileMessage = {
    id: `a_${startedAt}`,
    sessionId,
    role: "assistant",
    blocks: [block],
    createdAt: startedAt,
    turnMeta: { startedAt },
  };
  return [...list, created];
}

/** Stamp the turn's end time on its first (open) assistant message. */
function stampTurnEnd(list: MobileMessage[], endedAt: number): MobileMessage[] {
  return list.map((m) =>
    m.turnMeta && m.turnMeta.endedAt === undefined ? { ...m, turnMeta: { ...m.turnMeta, endedAt } } : m,
  );
}

/** Append a plain text line as an assistant message (used for plan-ready). */
function appendAssistantText(
  set: (fn: (s: MobileState) => Partial<MobileState>) => void,
  _get: () => MobileState,
  sid: string,
  text: string,
): void {
  const startedAt = Date.now();
  const msg: MobileMessage = {
    id: `plan_${startedAt}`,
    sessionId: sid,
    role: "assistant",
    blocks: [{ kind: "text", text }],
    createdAt: startedAt,
  };
  set((s) => ({ messagesBySession: { ...s.messagesBySession, [sid]: [...(s.messagesBySession[sid] ?? []), msg] } }));
}

export { EMPTY };
