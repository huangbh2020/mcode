/**
 * Stream-json message shapes the Claude Code CLI writes on stdout in headless
 * mode (`--output-format stream-json --input-format stream-json`).
 *
 * These replace the message types Mcode used to import from the Agent SDK
 * package. They describe the SAME wire data — the SDK's types were themselves
 * a typed view of this stream — so SdkMessageAdapter keeps reading the same
 * fields off the same frames. Only what Mcode actually reads is spelled out;
 * the CLI adds fields and message kinds between versions, and every type here
 * tolerates that (unknown members flow through, unknown types are ignored by
 * the adapter's dispatch).
 *
 * Field names are the CLI's own. Authority for what each frame means:
 * docs/claude-stream-json.md plus the CLI's own output.
 *
 * Pure types + no runtime code, so this file is free to import anywhere.
 */

/* ─── Anthropic Messages API shapes, as forwarded by the CLI ─────────── */

export type ClaudeKnownBlockType = "text" | "thinking" | "redacted_thinking" | "tool_use" | "tool_result" | "image";

export interface ClaudeTextBlock {
  type: "text";
  text: string;
}

export interface ClaudeThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
}

export interface ClaudeRedactedThinkingBlock {
  type: "redacted_thinking";
  data: string;
}

export interface ClaudeToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface ClaudeToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  /** String, or an array of text/image/... blocks (MCP tools return blocks). */
  content?: unknown;
  is_error?: boolean;
}

export interface ClaudeImageBlock {
  type: "image";
  source: {
    type: string;
    media_type?: string;
    data?: string;
    url?: string;
  };
}

/** Any other block kind (document, server_tool_use, web_search_tool_result…).
 *  The discriminant excludes the kinds above so `block.type === "text"` and
 *  friends keep narrowing the union. */
export interface ClaudeOtherBlock {
  type: Exclude<string, ClaudeKnownBlockType>;
  [k: string]: unknown;
}

export type ClaudeContentBlock =
  | ClaudeTextBlock
  | ClaudeThinkingBlock
  | ClaudeRedactedThinkingBlock
  | ClaudeToolUseBlock
  | ClaudeToolResultBlock
  | ClaudeImageBlock
  | ClaudeOtherBlock;

export type ClaudeMessageContent = string | ClaudeContentBlock[];

/** Token usage as the API reports it on a message. */
export interface ClaudeApiUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
  server_tool_use?: { web_search_requests?: number; web_fetch_requests?: number };
  service_tier?: string;
  [k: string]: unknown;
}

/** One Messages API message object (`role` + `content` blocks + usage). */
export interface ClaudeApiMessage {
  id?: string;
  type?: string;
  role: "assistant" | "user";
  content: ClaudeMessageContent;
  model?: string;
  stop_reason?: string | null;
  stop_sequence?: string | null;
  usage?: ClaudeApiUsage;
  [k: string]: unknown;
}

/* ─── Raw streaming events (`stream_event.event`) ───────────────────── */

export type ClaudeStreamDelta =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "input_json_delta"; partial_json: string }
  | { type: "signature_delta"; signature: string }
  | { type: Exclude<string, "text_delta" | "thinking_delta" | "input_json_delta" | "signature_delta">; [k: string]: unknown };

export interface ClaudeMessageStartEvent {
  type: "message_start";
  message: ClaudeApiMessage;
}

export interface ClaudeContentBlockStartEvent {
  type: "content_block_start";
  index: number;
  content_block: ClaudeContentBlock;
}

export interface ClaudeContentBlockDeltaEvent {
  type: "content_block_delta";
  index: number;
  delta: ClaudeStreamDelta;
}

export interface ClaudeContentBlockStopEvent {
  type: "content_block_stop";
  index: number;
}

export interface ClaudeMessageDeltaEvent {
  type: "message_delta";
  delta: { stop_reason?: string | null; stop_sequence?: string | null; [k: string]: unknown };
  usage?: ClaudeApiUsage;
}

export interface ClaudeMessageStopEvent {
  type: "message_stop";
}

export type ClaudeStreamEvent =
  | ClaudeMessageStartEvent
  | ClaudeContentBlockStartEvent
  | ClaudeContentBlockDeltaEvent
  | ClaudeContentBlockStopEvent
  | ClaudeMessageDeltaEvent
  | ClaudeMessageStopEvent;

/* ─── Top-level stream-json messages ────────────────────────────────── */

/** Session metadata, emitted once per CLI process start (and re-emitted when
 *  the session changes): session id, model, tools, MCP servers, permission
 *  mode, and the protocol capability list for feature detection. */
export interface ClaudeSystemInitMessage {
  type: "system";
  subtype: "init";
  session_id: string;
  uuid?: string;
  claude_code_version: string;
  cwd: string;
  tools: string[];
  mcp_servers: { name: string; status: string; source?: string }[];
  model: string;
  permissionMode: string;
  slash_commands: string[];
  output_style: string;
  skills: string[];
  apiKeySource?: string;
  agents?: string[];
  betas?: string[];
  plugins?: { name: string; path: string; version?: string }[];
  plugin_errors?: { plugin: string; type: string; message: string; path?: string }[];
  /** Open set — feature-detect, never version-sniff. Absent on older CLIs. */
  capabilities?: string[];
  [k: string]: unknown;
}

/** Every other `system` frame (task_started / task_progress / task_updated /
 *  task_notification / compact_boundary / background_tasks_changed /
 *  api_retry / status / …). The adapter narrows per subtype by casting. */
export interface ClaudeSystemOtherMessage {
  type: "system";
  subtype: Exclude<string, "init">;
  session_id?: string;
  uuid?: string;
  [k: string]: unknown;
}

export type ClaudeSystemMessage = ClaudeSystemInitMessage | ClaudeSystemOtherMessage;

/** A complete assistant message. While a response streams the CLI emits one
 *  per finished content block (several may share `message.id`); only the
 *  last carries the final stop_reason and usage. `parent_tool_use_id` is
 *  non-null for messages produced inside a subagent. */
export interface ClaudeAssistantMessage {
  type: "assistant";
  message: ClaudeApiMessage;
  parent_tool_use_id: string | null;
  uuid?: string;
  session_id?: string;
  error?: string;
  aborted?: boolean;
  agent_id?: string;
  subagent_type?: string;
  task_description?: string;
  [k: string]: unknown;
}

/** A user-role frame: tool results, subagent text forwarded under a
 *  `parent_tool_use_id`, or the CLI's synthetic prompts. */
export interface ClaudeUserMessage {
  type: "user";
  message: ClaudeApiMessage;
  parent_tool_use_id: string | null;
  isSynthetic?: boolean;
  isMeta?: boolean;
  tool_use_result?: unknown;
  uuid?: string;
  session_id?: string;
  [k: string]: unknown;
}

/** Turn outcome — the CLI emits exactly one per turn. `subtype:"success"`
 *  carries the final assistant text in `result`; the `error_*` subtypes say
 *  why the turn stopped early. */
export interface ClaudeResultMessage {
  type: "result";
  subtype: string;
  duration_ms: number;
  duration_api_ms: number;
  is_error: boolean;
  num_turns: number;
  stop_reason?: string | null;
  result?: string;
  total_cost_usd: number;
  usage?: ClaudeApiUsage;
  modelUsage?: Record<string, unknown>;
  permission_denials?: { tool_name: string; tool_use_id: string; tool_input: Record<string, unknown> }[];
  errors?: string[];
  queued_turn_count?: number;
  session_id: string;
  uuid?: string;
  [k: string]: unknown;
}

/** One raw API streaming event (`--include-partial-messages`). */
export interface ClaudePartialAssistantMessage {
  type: "stream_event";
  event: ClaudeStreamEvent;
  parent_tool_use_id: string | null;
  uuid?: string;
  session_id?: string;
}

/** Message kinds Mcode does not handle (auth_status, conversation_reset,
 *  keep_alive, …) — passed over by dispatch, listed so the union stays open. */
export interface ClaudeOtherMessage {
  type: Exclude<string, "system" | "stream_event" | "assistant" | "user" | "result">;
  [k: string]: unknown;
}

export type ClaudeMessage =
  | ClaudeSystemMessage
  | ClaudePartialAssistantMessage
  | ClaudeAssistantMessage
  | ClaudeUserMessage
  | ClaudeResultMessage
  | ClaudeOtherMessage;

/* ─── Input: what the host writes to the CLI's stdin ────────────────── */

/** A user turn pushed onto the CLI's stdin (one JSON object per line). Text
 *  plus optional inline base64 images; `parent_tool_use_id` is null for a
 *  top-level turn. */
export interface ClaudeUserInputMessage {
  type: "user";
  message: { role: "user"; content: ClaudeMessageContent };
  parent_tool_use_id: null;
  session_id?: string;
  uuid?: string;
}

/* ─── Control channel ───────────────────────────────────────────────── */

/** Reply to the `get_context_usage` control request: the structured twin of
 *  the CLI's `/context` report. Only the members Mcode reads are typed. */
export interface ClaudeContextUsageResponse {
  categories?: {
    id?: string;
    name: string;
    tokens: number;
    color?: string;
    isDeferred?: boolean;
    kind?: string;
  }[];
  totalTokens: number;
  maxTokens: number;
  rawMaxTokens?: number;
  percentage: number;
  model: string;
  isAutoCompactEnabled?: boolean;
  autoCompactThreshold?: number;
  [k: string]: unknown;
}

/** The slice of the live CLI control channel SdkMessageAdapter needs: the
 *  authoritative context-window occupancy, asked while the process lives. */
export interface ClaudeControlChannel {
  getContextUsage(): Promise<ClaudeContextUsageResponse>;
}
