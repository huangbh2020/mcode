/**
 * Runtime events — the normalized stream of activity emitted by a provider
 * (claude.exe via stream-json). These are the lingua franca the renderer
 * renders; the ClaudeAdapter translates raw NDJSON into these.
 */

import type { Session } from "./session.js";

/**
 * Permission modes are open strings so each provider can declare its own set
 * via `ProviderCapabilities.permissionModes`. Claude's values are kept as
 * semantic constants below for backward compatibility and for the claude-sdk
 * provider's own use. The renderer's composer reads the supported modes from
 * the active provider's capabilities, not from this union.
 *
 * Claude's 6 modes (default / acceptEdits / plan / bypassPermissions / dontAsk
 * / auto) are preserved verbatim; `dontAsk` and `auto` are not exposed in the
 * UI but round-trip safely through the contract. Other providers may declare
 * entirely different mode strings (or none at all).
 */
export type PermissionMode = string;

/** Claude's canonical permission modes, in the order the UI presents them. */
export const CLAUDE_PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
  "dontAsk",
  "auto",
] as const;

/**
 * Effort / thinking levels are open strings so each provider can declare its
 * own set via `ProviderCapabilities.thinkingLevels`. Claude's values are kept
 * as semantic constants below for backward compatibility. Pi SDK uses a
 * superset that adds "off" and "minimal".
 *
 * "default" is a universal sentinel meaning "let the provider pick / don't
 * pass the option". Higher effort ≈ more thinking/reasoning.
 */
export type EffortLevel = string;

/** Claude's canonical effort levels (verified on 2.1.186). */
export const CLAUDE_EFFORT_LEVELS = [
  "default",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/** Pi SDK's thinking levels (superset of Claude's, adds off/minimal). */
export const PI_THINKING_LEVELS = [
  "default",
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/** Lifecycle of a single session. */
export type SessionStatus =
  | "idle"
  | "running"
  | "approving"
  | "done"
  | "errored"
  | "interrupted";

/** A text delta (streaming token) from the assistant. */
export interface TextDeltaEvent {
  type: "text.delta";
  sessionId: string;
  messageId: string;
  text: string;
}

/** A complete assistant message boundary. */
export interface MessageCompleteEvent {
  type: "message.complete";
  sessionId: string;
  messageId: string;
}

/** A thinking/reasoning block (claude extended thinking). */
export interface ThinkingEvent {
  type: "thinking";
  sessionId: string;
  messageId: string;
  text: string;
}

/** A tool was invoked by the agent. */
export interface ToolUseEvent {
  type: "tool.use";
  sessionId: string;
  toolCallId: string;
  toolName: string;
  /** Raw tool input as JSON (e.g. { command, path, ... }). */
  input: unknown;
  /** True if this tool call requires user approval before executing. */
  requiresApproval: boolean;
  /** Optional: the assistant message this tool belongs to. Claude's tool_use
   *  blocks arrive inside the full assistant message, so the store naturally
   *  appends them to the same message as the narration text. Pi's
   *  `tool_execution_start` event, by contrast, is detached from the message
   *  stream — the adapter forwards the target messageId here so the tool
   *  block lands on the same message as its narration text (keeping the
   *  process/reply timeline intact instead of piling every tool onto the
   *  turn's opener). Provider-optional: claude omits it. */
  messageId?: string;
}

/** A tool finished and returned a result. */
export interface ToolResultEvent {
  type: "tool.result";
  sessionId: string;
  toolCallId: string;
  /** Whether the tool errored. */
  isError: boolean;
  /** Raw result content (string or structured). */
  content: unknown;
}

/** The agent is requesting permission to run a tool (awaiting user decision). */
export interface ApprovalRequestEvent {
  type: "approval.request";
  sessionId: string;
  requestId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
  /** Human-readable description of what the tool will do. */
  description?: string;
}

/** A todo/task update (claude's TodoWrite tool output). */
export interface TodoUpdateEvent {
  type: "todo.update";
  sessionId: string;
  todos: Array<{
    content: string;
    status: "pending" | "in_progress" | "completed";
    priority: "high" | "medium" | "low";
  }>;
}

/**
 * Context-window token usage, normalized by the provider adapter before
 * emission. The provider (claude-sdk adapter) extracts raw usage fields from
 * SDK messages, runs the shared math in `claudeTokenUsage.ts`, and emits this
 * event carrying an already-display-ready `ContextSnapshot`. Downstream
 * (renderer) is provider-neutral — it only stores and renders the snapshot.
 *
 * Three emission points mirror Synara's design (docs/claude-context-usage-
 * tracking.md §2): path A (per assistant response, mid-turn read) and path C
 * (turn-end merged). Path B (the Agent SDK control channel for live window
 * queries) is not exposed by the SDK's stream-json surface — `usedPercent` /
 * `warning` degrade to `usedTokens/maxTokens` (doc §7.2).
 */

/** Top-level occupancy warning level for the context ring. */
export type ContextWarning = "ok" | "near-window" | "critical";

/** Granular warning kinds (doc §5), computed each emit and folded into the
 *  snapshot. Empty when nothing is amiss. */
export type ContextWarningKind =
  | "uncached-ingestion"
  | "near-window"
  | "large-prompt";

/** A ready-to-render snapshot of context-window state. Built by the adapter
 *  from raw SDK usage fields; all math (pct / warning / clamps) is already
 *  applied. */
export interface ContextSnapshot {
  /** Tokens currently occupying the context window:
   *  `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`,
   *  clamped to `maxTokens`. Cache reads bill at a reduced rate but occupy
   *  the window at full weight (doc §3). */
  usedTokens: number;
  /** Cumulative tokens processed across this turn
   *  (`input + output + cache_read + cache_creation`). May exceed maxTokens. */
  totalProcessedTokens: number;
  /** Context-window ceiling. Prefer SDK-reported (`modelUsage[model].
   *  contextWindow`); fall back to model-name heuristic; never downgrade
   *  (doc §4). */
  maxTokens: number;
  /** Output tokens from the last completed turn. */
  outputTokens: number;
  /** Tokens read from the prompt cache (reduced billing rate). */
  cacheReadTokens?: number;
  /** Tokens used to create new cache entries (higher write rate). */
  cacheCreationTokens?: number;
  /** Estimated USD cost for this turn, if known. Includes subagent activity. */
  costUsd?: number;
  /** Active model identifier (from SDK result message). */
  model?: string;
  /** Context occupancy as a percentage [0, 100], clamped. */
  pct: number;
  /** Derived warning level (>=90 critical / >=70 near-window / else ok). */
  warning: ContextWarning;
  /** Granular doc-§5 warnings triggered this turn (uncached-ingestion /
   *  near-window / large-prompt). */
  warnings: ContextWarningKind[];
}

/** Emitted by the provider adapter whenever a new token-usage snapshot is
 *  available (per-assistant-response mid-turn and at turn end). The renderer
 *  replaces its latest snapshot with `e.snapshot`. */
export interface ContextUsageEvent {
  type: "token-usage.updated";
  sessionId: string;
  snapshot: ContextSnapshot;
}

/** One entry in the per-session turn-usage history. Appended at turn-end
 *  from the latest {@link ContextSnapshot} + timing metadata. Persisted to
 *  the sessions table so the history survives app restart. */
export interface TurnUsageRecord {
  /** Wall-clock ms when the turn finalized (turnMeta.endedAt). */
  endedAt: number;
  /** Duration of the turn in ms (endedAt - startedAt). */
  durationMs: number;
  /** Tokens processed this turn (input + output + cache). */
  totalProcessedTokens: number;
  /** Output tokens this turn. */
  outputTokens: number;
  /** Tokens read from cache this turn (0 if none). */
  cacheReadTokens: number;
  /** Tokens written to cache this turn (0 if none). */
  cacheCreationTokens: number;
  /** Estimated USD cost this turn, if known. */
  costUsd?: number;
  /** Window occupancy AFTER this turn (cumulative context size). */
  usedTokens: number;
  /** Active model for this turn, if known. */
  model?: string;
}

/** Session-level error. */
export interface ErrorEvent {
  type: "error";
  sessionId: string;
  message: string;
  /** Raw error code/string from claude, if any. */
  code?: string;
}

/** The turn has fully completed. */
export type TurnDoneReason = "end_turn" | "max_tokens" | "tool_use" | "interrupted" | "error";
export interface TurnDoneEvent {
  type: "turn.done";
  sessionId: string;
  reason: TurnDoneReason;
}

/**
 * The turn ended with a "success" result but the stream shows the model never
 * finished its work — the classic third-party-gateway failure where the model
 * channel returns an empty completion that the CLI silently accepts as a
 * normal end-of-turn. Emitted by the adapter right BEFORE turn.done so the
 * renderer can flag the turn (warning card + toast) instead of showing a
 * misleading "回合完成".
 *
 * Two shapes:
 *  - `dangling-tools` — main-agent tool_use blocks were still unanswered when
 *    the stream closed (the model was mid-tool-flow; its next response after
 *    the last tool_result came back empty).
 *  - `empty-response` — the turn produced no assistant text at all.
 *
 * NOT emitted for user interrupts (dangling tools are expected there) or
 * error-subtype results (the `error` event already surfaces those).
 */
export interface TurnIncompleteEvent {
  type: "turn.incomplete";
  sessionId: string;
  kind: "dangling-tools" | "empty-response";
  /** Main-agent tool calls that never received a tool_result
   *  (kind "dangling-tools"; empty for "empty-response"). Names are for
   *  display, ids for correlation with the chat stream's tool cards. */
  pendingToolCalls: Array<{ toolCallId: string; toolName: string }>;
}

/**
 * One file touched by a turn. Shared shape across the `turn.files` event
 * payload, the persisted `Session.turnFiles` column, and the renderer's
 * `turnFilesBySession` bucket — defined once here so the three never drift.
 *
 * - `filePath`: absolute (cwd-resolved by main).
 * - `kind`: "created" = file did not exist before the turn (rewind unlinks);
 *   "modified" = it existed (rewind writes `before` back).
 * - `adds` / `dels`: line-level change tallies computed by `FileSnapshot.freeze`
 *   (LCS over `before` vs the on-disk post-turn content). The folded card shows
 *   these directly without computing a full diff; `0` for unreadable/binary.
 * - `before`: the file's pre-turn content (the empty string for created files).
 *   Crosses IPC so the renderer can compute a full line diff on demand by
 *   reading the current on-disk content and diffing against this.
 */
export interface TurnFileEntry {
  filePath: string;
  kind: TurnFileKind;
  adds: number;
  dels: number;
  before: string;
}

/** Whether a turn-touched file existed before the turn. */
export type TurnFileKind = "modified" | "created";

/**
 * Emitted at the end of a turn listing the files Edit/Write touched in
 * that turn. Renderer uses this to render the "本轮文件" card with the
 * per-file diff and a rewind button.
 *
 * `kind: "created"` means the file did not exist before the turn —
 * rewinding will unlink it. `kind: "modified"` means it existed —
 * rewinding will write the original content back.
 */
export interface TurnFilesEvent {
  type: "turn.files";
  sessionId: string;
  files: TurnFileEntry[];
}

/** Emitted by main after a renderer-initiated rewind completes. The
 *  renderer marks the matching `turn-files` card `rewound: true` in
 *  place — the card is NEVER removed, so the conversation stream keeps
 *  a visible trace that the user rolled this turn back (mirroring SDK
 *  checkpoint semantics where file rollback never rolls back the
 *  conversation itself).
 *
 *  The renderer uses `targetFiles` to locate the card (path-set match),
 *  and clears the latest-turn bucket (`turnFilesBySession`) only when
 *  the matched card is the live one. */
export interface TurnRewoundEvent {
  type: "turn.rewound";
  sessionId: string;
  /** Paths that were successfully restored (subset of the requested
   *  files; failed paths are logged in main but not surfaced here
   *  beyond the implicit "not in this list"). */
  files: string[];
  /** The ORIGINAL set of paths the rewind targeted (before any were
   *  dropped due to failure). Always present — the renderer matches the
   *  `turn-files` block by this path set to mark it `rewound`. */
  targetFiles: string[];
}

/**
 * The agent is asking the user a question via the AskUserQuestion tool. claude
 * emits a tool_use carrying a structured question list. NOTE: this tool's
 * availability depends on model/version/config (verified absent on 2.1.218 +
 * proxy + MiniMax; present on 2.1.186). The GUI parses it defensively so the
 * UI works whenever the tool does surface. In non-interactive mode claude
 * auto-cancels the result, so the user's answer is sent as the next message.
 */
export interface AskUserQuestionOption {
  label: string;
  description?: string;
}
export interface AskUserQuestionItem {
  header: string;
  question: string;
  multiSelect: boolean;
  options: AskUserQuestionOption[];
}
export interface AskUserQuestionEvent {
  type: "question.ask";
  sessionId: string;
  /** Opaque id for correlating an answer back (used by the approval bridge).
   * Absent when the question is surfaced from sentinel-scanner fallback. */
  requestId?: string;
  questions: AskUserQuestionItem[];
}

/**
 * The session's effective permission mode changed mid-turn. Emitted when the
 * model invokes EnterPlanMode / ExitPlanMode tools (source: "model"), so the
 * UI (composer chip + status bar) can sync to what the SDK is actually doing.
 * The GUI's session.permissionMode (persisted) is the *startup* mode; this
 * event reports the *current* runtime mode, which may differ after a model
 * initiated transition into or out of plan mode.
 */
export interface ModeChangeEvent {
  type: "mode.change";
  sessionId: string;
  mode: PermissionMode;
  /** Who triggered the change. "model" = a plan-mode tool call; "user" = the
   * host flipping the composer chip (reserved for future use). */
  source: "model" | "user";
}

/**
 * The model has drafted a plan in plan mode and is calling ExitPlanMode to
 * request user approval before executing. The plan text comes from the tool's
 * `input.plan` field (the SDK forwards it through canUseTool). The user's
 * decision is returned via the `claude:respondPlanApproval` IPC channel,
 * keyed by `requestId`, which resolves the provider's pending Deferred and
 * either allows (exits plan mode) or denies (stays in plan mode) the tool.
 */
export interface PlanApprovalRequestEvent {
  type: "plan.approval_request";
  sessionId: string;
  requestId: string;
  /** The ExitPlanMode tool_use id, for correlation with the tool card. */
  toolCallId: string;
  /** The plan text the model is proposing (Markdown). */
  plan: string;
}

/**
 * Plan draft update — emitted whenever the current plan-mode draft changes.
 * Used by the activity capsule to preview the plan in real time, independent
 * of the final `plan.approval_request` event (which only fires once, at
 * ExitPlanMode time).
 *
 * Lifecycle:
 *   - `phase: "drafting"` — model is still composing the plan; `plan` holds
 *     whatever text has been written so far. Emitted on EnterPlanMode and on
 *     subsequent text deltas within plan mode (the host may refine the
 *     preview live).
 *   - `phase: "ready"` — model has called ExitPlanMode; `plan` is the final
 *     submitted plan. Capsules show a "等待批准" badge and the user can open
 *     the plan for review.
 *   - `phase: "cleared"` — plan mode has ended (approved, rejected, or
 *     interrupted). `plan` is empty. The capsule drops the Plan section.
 */
export interface PlanUpdateEvent {
  type: "plan.update";
  sessionId: string;
  plan: string;
  phase: "drafting" | "ready" | "cleared";
}

/**
 * Per-subagent status snapshot. The SDK sends `task_started`, `task_progress`,
 * `task_updated` edge events; the adapter maintains a map keyed by `taskId`
 * and emits a single consolidated `subagent.update` after each change (REPLACE
 * semantics, mirroring the SDK's own level-signal guidance). The renderer
 * renders the full array — no client-side merging required.
 */
export interface SubagentSnapshot {
  /** SDK-provided task id (string). */
  taskId: string;
  /** Originating Task tool_use id, for correlation with the chat stream. */
  toolUseId?: string;
  /** Human description (SDK task_started.description or Task tool_use input). */
  description: string;
  /** Subagent type label (e.g. "general-purpose", "code-reviewer"). */
  subagentType?: string;
  /** Lifecycle status. `running` is the steady state until task_updated. */
  status: "running" | "completed" | "failed" | "killed";
  /** Cumulative token estimate (task_progress.usage.total_tokens). */
  totalTokens?: number;
  /** Cumulative tool-call count (task_progress.usage.tool_uses). */
  toolUses?: number;
  /** Elapsed milliseconds (task_progress.usage.duration_ms). */
  durationMs?: number;
  /** Most-recent tool name the subagent invoked. */
  lastToolName?: string;
  /** SDK-supplied progress summary (task_progress.summary). */
  summary?: string;
  /** Wall-clock end time (task_updated.patch.end_time). */
  endedAt?: number;
  /** Error message (task_updated.patch.error), if status=failed. */
  error?: string;
  /** True when the SDK launched this task as backgrounded (the parent agent
   *  does NOT block on it). Set from task_started/task_updated patch's
   *  `is_backgrounded`. Backgrounded tasks outlive the parent turn's stream in
   *  the CLI; the adapter avoids force-completing them at turn end so the
   *  renderer can keep the "busy" signal alive while they remain running. */
  isBackgrounded?: boolean;
}

/**
 * Consolidated subagent roster update. Always carries the full current
 * roster — the host should replace, not merge. Empty array means "no
 * subagents active or recently completed".
 */
export interface SubagentUpdateEvent {
  type: "subagent.update";
  sessionId: string;
  agents: SubagentSnapshot[];
}

/** Emitted when a context compaction completes (manual `/compact` or auto).
 *  Carries the token counts before/after so the renderer can show a summary
 *  card in the message stream telling the user what happened. */
export interface CompactResultEvent {
  type: "compact.result";
  sessionId: string;
  /** What triggered the compaction. */
  trigger: "manual" | "auto";
  /** Token count before compaction. */
  preTokens: number;
  /** Token count after compaction (may be absent if the SDK didn't report it). */
  postTokens?: number;
  /** How long the compaction took, in ms (may be absent). */
  durationMs?: number;
}

/** An agent tool captured a screenshot (or other image) that should be shown
 *  inline in the conversation. Emitted by Pi's `browser_screenshot` tool via
 *  `ctx.emit`; Claude's in-process MCP server surfaces images through the
 *  normal tool_result content (parsed by the store). Both paths key off
 *  `toolCallId` to attach the image as a block next to the tool_use card. */
export interface BrowserImageEvent {
  type: "browser.image";
  sessionId: string;
  toolCallId: string;
  /** Base64-encoded image bytes (no data: prefix). */
  data: string;
  /** Image MIME type — always "image/png" for screenshots today. */
  mimeType: "image/png";
}

/**
 * Cross-client session-list sync. `RuntimeManager.emit` only fans out events
 * from INSIDE a turn — a session created, renamed, deleted, archived or pinned
 * from either client (desktop IPC handlers or the mobile RPC) would otherwise
 * never reach the other side, leaving the two session lists diverging until a
 * restart. These events are broadcast over the same two channels (renderer
 * `claude:event` + mobile SSE bus) so every connected client keeps its list
 * in sync.
 *
 * `session.changed` carries a SLIM row: only list-visible fields. The heavy
 * per-session payloads (`turnFiles.before` can hold whole file contents) must
 * not ride a list-sync broadcast. Receivers merge the entry onto an existing
 * row (preserving cached heavy fields) or, for a row they don't have yet,
 * materialize it with nulls for the heavy fields — a freshly-created session
 * has them null anyway.
 */
export type SessionListEntry = Omit<
  Session,
  "contextSnapshot" | "todos" | "subagents" | "planDraft" | "usageHistory" | "turnFiles" | "bookmarks"
>;

/** A session row was created or mutated (title / archive / pin / rename …).
 *  The full list-visible row is carried; receivers upsert by id. */
export interface SessionChangedEvent {
  type: "session.changed";
  sessionId: string;
  session: SessionListEntry;
}

/** A session was hard-deleted. Receivers drop the row from every list. */
export interface SessionDeletedEvent {
  type: "session.deleted";
  sessionId: string;
}

/**
 * A repo's git state changed on the host — commit / stage / unstage / push /
 * pull / discard, issued by ANY client (desktop panel or a paired phone).
 * Receivers re-run `git status` / reload the commit history for the matching
 * repoPath, so one client's commit shows up everywhere without a manual
 * refresh. Broadcast through the same two channels as
 * {@link SessionChangedEvent}; `sessionId` is "" (envelope compatibility —
 * see {@link SessionRunningSnapshotEvent}).
 */
export interface GitChangedEvent {
  type: "git.changed";
  sessionId: string;
  /** Absolute path of the repo whose state changed. */
  repoPath: string;
}

/**
 * Cross-client pending-request sync. When one client answers an approval /
 * AskUserQuestion / plan approval, the main-process Deferred resolves exactly
 * once — the OTHER clients (desktop + phones) would keep showing a dialog that
 * can no longer be answered. This event tells every client to close its copy
 * of the dialog for the given requestId. Broadcast through the same two
 * channels as {@link SessionChangedEvent} (renderer `claude:event` + mobile
 * SSE bus), ordered BEFORE the turn continues, so a subsequent request of the
 * same kind can never be confused with the resolved one.
 */
export interface RequestResolvedEvent {
  type: "request.resolved";
  sessionId: string;
  /** The pending request's id — matches the one carried by the originating
   *  approval.request / question.ask / plan.approval_request event. */
  requestId: string;
  /** Which pending-request kind was closed. */
  kind: "approval" | "question" | "plan";
}

/**
 * Authoritative snapshot of which sessions currently have a running turn.
 * Emitted ONLY on the mobile SSE channel, as the first data frame after a
 * (re)connect: the mobile event bus is unbuffered, and a phone that was
 * backgrounded while a turn ran (iOS suspends EventSource) misses the
 * terminal `turn.done` — its client-side `runningBySession` would stay
 * stuck on forever (spinner never stops, slash picker silently disabled).
 * Receiving clients replace their local running-state guesses with this set.
 */
export interface SessionRunningSnapshotEvent {
  type: "session.runningSnapshot";
  /** Not meaningful for a global snapshot; kept for envelope compatibility
   *  (every RuntimeEvent carries a sessionId and the SSE frame mirrors it). */
  sessionId: string;
  /** Every session id that currently has a running turn on the host. */
  running: string[];
}

/**
 * Cross-client echo of a user prompt. Emitted by the host when ANY client
 * (desktop renderer or a paired phone) sends a turn, so every OTHER client
 * appends the sender's bubble in real time — ahead of the first assistant
 * event of the turn. Without it, a prompt typed on the phone never showed
 * up on the PC until a restart: assistant-side events fan out, but the user
 * message itself lives only in the originator's local store until it is
 * persisted at the turn boundary, and an already-hydrated session never
 * re-fetches. The echo carries the originator's message id / createdAt /
 * display blocks; the originator itself already appended the same id
 * optimistically at send time and ignores the echo by id match. Broadcast
 * through the same two channels as {@link SessionChangedEvent} (renderer
 * `claude:event` + mobile SSE bus).
 */
export interface UserMessageEvent {
  type: "user.message";
  sessionId: string;
  /** The originator's local user-message id (`u_<ts>`). Shared by every
   *  client so the persisted row is identical regardless of which client
   *  writes it first, and so the originator can dedupe the echo. */
  messageId: string;
  /** Wall-clock ms at the originator's send — the ordering key. */
  createdAt: number;
  /** The user message's display blocks (text / image / attachment chips)
   *  exactly as the originator rendered them. Opaque to the contract — the
   *  renderer's Block union lives in the store; receivers cast on ingest,
   *  mirroring how persisted message content is trusted on reload. */
  blocks: unknown[];
  /** Set when this send is an EDIT of an earlier user message: the id of the
   *  message this new bubble replaces. Receiving clients truncate their own
   *  store (and their later persistence) at that message before appending,
   *  so a stale pre-edit tail can't survive on another device. */
  editedMessageId?: string;
}

/**
 * Transient upstream-network issue on the session's model channel. Emitted by
 * the OpenAI-protocol bridge when a request to the real upstream fails with a
 * retryable transport error (connect timeout / reset / refused …) and the
 * bridge's internal retry loop kicks in — the moment where a turn looks hung
 * with no streaming feedback — and again with kind "ok" once a retried
 * request subsequently succeeds. Purely a visibility signal: the retry
 * proceeds regardless, and final failure still reaches the user as the SDK's
 * API-error card (the bridge answers 502 / the upstream status verbatim).
 */
export interface UpstreamIssueEvent {
  type: "upstream.issue";
  sessionId: string;
  kind: "retry" | "ok";
  /** Human-readable transport cause, e.g. "UND_ERR_CONNECT_TIMEOUT: Connect
   *  Timeout Error (…)". Empty for kind "ok". */
  cause: string;
  /** 1-based retry attempt that just failed / attempt count ceiling. */
  attempt: number;
  attempts: number;
}

/** The union of all runtime events. */
export type RuntimeEvent =
  | TextDeltaEvent
  | MessageCompleteEvent
  | ThinkingEvent
  | ToolUseEvent
  | ToolResultEvent
  | ApprovalRequestEvent
  | TodoUpdateEvent
  | AskUserQuestionEvent
  | ModeChangeEvent
  | PlanApprovalRequestEvent
  | PlanUpdateEvent
  | SubagentUpdateEvent
  | ContextUsageEvent
  | ErrorEvent
  | TurnDoneEvent
  | TurnIncompleteEvent
  | TurnFilesEvent
  | TurnRewoundEvent
  | CompactResultEvent
  | BrowserImageEvent
  | SessionChangedEvent
  | SessionDeletedEvent
  | RequestResolvedEvent
  | SessionRunningSnapshotEvent
  | UserMessageEvent
  | UpstreamIssueEvent
  | GitChangedEvent;
