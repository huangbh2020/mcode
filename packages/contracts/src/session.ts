/**
 * Session domain types — projects, sessions, and messages persisted in SQLite.
 */
import type {
  PermissionMode,
  SessionStatus,
  EffortLevel,
  ContextSnapshot,
  SubagentSnapshot,
  SubagentTranscriptBlock,
  PlanUpdateEvent,
  TurnFileEntry,
  TurnUsageRecord,
} from "./runtime.js";

/** A single todo item (mirrors the renderer's TodoItem; kept here so the
 *  persisted Session row is typed on both sides of the IPC boundary). */
export interface SessionTodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority: "high" | "medium" | "low";
}

/** Plan-mode draft snapshot persisted with the session. Same shape as
 *  PlanDraft in the renderer store and PlanUpdateEvent's payload. */
export interface SessionPlanDraft {
  plan: string;
  phase: PlanUpdateEvent["phase"];
}

/** A user-placed bookmark on a chat message (message-level anchor). The
 *  excerpt is the text the user had selected when adding the bookmark —
 *  display-only, used to recognize the entry in lists; jump targeting goes
 *  through `messageId` alone. Bookmarks whose message was later removed
 *  (edit-resend truncation / compact) are kept and shown as stale until the
 *  user deletes them. */
export interface SessionBookmark {
  id: string;
  messageId: string;
  excerpt: string;
  /** User-defined display name (rename). null/empty = lists show the
   *  excerpt instead. `excerpt` itself is NEVER rewritten by a rename — it
   *  stays the whitespace-normalized anchor the jump uses to re-find the
   *  selected text in the rendered DOM for the precise highlight. */
  title: string | null;
  role: "user" | "assistant";
  createdAt: number;
}

export interface Project {
  id: string;
  name: string;
  /** Absolute filesystem path that claude will use as cwd. */
  path: string;
  /** Soft-delete flag: archived projects are hidden from the main tree and
   *  live in the "archived" section; they can be restored or hard-deleted. */
  archived: boolean;
  /** Optional user-assigned group name. Projects sharing the same non-null
   *  group are clustered under a collapsible group header in the left bar's
   *  "grouped" view. null/undefined in the flat view or when ungrouped. */
  group?: string | null;
  /** User-reorderable position within the left bar. Lower sorts first;
   *  created_at is the tiebreaker for projects with equal sort_order (e.g.
   *  pre-migration rows, which all default to 0). New projects are appended
   *  with MAX(sort_order)+1 so they land at the end. */
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export interface Session {
  id: string;
  projectId: string;
  /** The provider powering this session. Defaults to "claude-sdk". */
  providerId: string;
  /** claude's own session id, used for `--resume`. Null until first turn. */
  claudeSessionId: string | null;
  /** Session role: "chat" = a normal session shown in the left-bar list;
   *  "side" = a side-chat Q&A session (right-panel ask tab). Side sessions
   *  are excluded from every list/search/reuse query and are managed only by
   *  the side-chat panel, keyed by their parent session. */
  kind: "chat" | "side";
  /** For side sessions (kind="side"): the id of the main session this Q&A
   *  thread was opened from, for traceability. Null for main sessions; set
   *  back to null when the parent is deleted (the side chat itself is kept). */
  parentSessionId: string | null;
  title: string;
  status: SessionStatus;
  /** Model alias or full name ("default" = let claude pick). → --model. */
  model: string;
  /** Reasoning effort ("default" = don't pass --effort). → --effort. */
  effort: EffortLevel;
  permissionMode: PermissionMode;
  /** Id of the user's custom-model config bound to this session (null = use
   *  built-in credential discovery). Set when the user picks a custom model
   *  in the composer; persisted so a resumed session keeps its endpoint. */
  customModelId: string | null;
  /** Soft-delete flag: archived sessions are hidden from the main tree and
   *  live in the "archived" section; they can be restored or hard-deleted. */
  archived: boolean;
  /** Pin timestamp (ms epoch) when the user pinned this session to the top of
   *  its project's session list; null = not pinned. Pinned sessions sort above
   *  unpinned ones (most recent pin first) within their project only. */
  pinnedAt: number | null;
  /** Normalized ContextSnapshot from the most recent token-usage.updated
   *  event, serialized as JSON. Null for sessions that never saw a turn. */
  contextSnapshot: ContextSnapshot | null;
  /** Capsule state persisted so the top-right status pill reloads on
   *  session reopen. Each is null for sessions that never produced the
   *  corresponding activity. JSON-serialized in the DB. */
  todos: SessionTodoItem[] | null;
  subagents: SubagentSnapshot[] | null;
  planDraft: SessionPlanDraft | null;
  /** Per-turn token/cost breakdown, appended at each turn-end. Survives
   *  restart so the context-stats history popover shows all turns. */
  usageHistory: TurnUsageRecord[] | null;
  /** Files touched by the most recent turn (persisted so the "本轮修改" card
   *  survives a session reopen). Null for sessions that never saw a file edit.
   *  Cleared (set to null) after a rewind. JSON-serialized in the DB. */
  turnFiles: TurnFileEntry[] | null;
  /** User-placed message bookmarks (persisted so the capsule + timeline
   *  markers survive a session reopen). Null for sessions with no bookmarks.
   *  JSON-serialized in the DB. */
  bookmarks: SessionBookmark[] | null;
  /** Final subagent transcripts of the most recent turn, keyed by the
   *  spawning Task tool_use id (same keys as SubagentSnapshot.toolUseId).
   *  Persisted so the side-panel subagent viewer still works after a session
   *  reopen; cleared when a new turn starts (mirrors the roster cycle).
   *  Null for sessions that never ran subagents. JSON-serialized in the DB. */
  subagentTranscripts: Record<string, SubagentTranscriptBlock[]> | null;
  createdAt: number;
  updatedAt: number;
}

export interface MessageRecord {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  /** Content stored as JSON: text blocks, tool_use, tool_result, etc. */
  content: unknown;
  createdAt: number;
}

/** Input to start a new session turn. */
export interface TurnInput {
  sessionId: string;
  prompt: string;
  /** File paths attached via @file references. */
  attachments?: string[];
}

/** A user's decision on an approval request. */
export interface ApprovalDecision {
  sessionId: string;
  requestId: string;
  granted: boolean;
  /** If true, remember the decision for this tool type this session. */
  always?: boolean;
}
