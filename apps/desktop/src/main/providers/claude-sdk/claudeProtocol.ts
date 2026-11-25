/**
 * Wire types and frame helpers for the Claude Code CLI's control protocol.
 *
 * The CLI speaks this protocol over its stdio whenever it runs headless with
 * `--input-format stream-json` — the same transport the Agent SDK package used
 * to drive for Mcode (see cliTransport.ts for the process side). Control frames
 * share the stream with the session messages: both directions, one JSON object
 * per line.
 *
 *   host → CLI   {type:"control_request",  request_id, request:{subtype, …}}
 *                {type:"control_response", response:{subtype:"success"|"error", request_id, …}}
 *                {type:"control_cancel_request", request_id}
 *   CLI → host   the same three envelope shapes
 *
 * Every field keeps the CLI's own name (snake_case); nothing here renames or
 * reshapes it. The protocol is additive across CLI versions — an unknown
 * subtype or field must be ignored, never rejected — so request types list the
 * members Mcode actually reads and leave the rest open.
 *
 * This module is pure (no node, no electron) so the smoke scripts can bundle it.
 */

/** One permission-rule change the host may return with an allow decision so
 *  the user is not prompted again ("always allow"). Same shape as the CLI's. */
export interface PermissionUpdate {
  type: "addRules" | "replaceRules" | "removeRules" | "setMode" | "addDirectories" | "removeDirectories";
  rules?: { toolName: string; ruleContent?: string }[];
  behavior?: "allow" | "deny" | "ask";
  mode?: string;
  directories?: string[];
  destination: "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg";
}

/** What the host answers a `can_use_tool` request with. `updatedInput` replaces
 *  the tool's input before it runs (path normalization rides on it). */
export type PermissionResult =
  | {
      behavior: "allow";
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: PermissionUpdate[];
      interrupt?: boolean;
    }
  | {
      behavior: "deny";
      message: string;
      interrupt?: boolean;
    };

/** CLI → host: the model wants to run a tool and the permission rules did not
 *  settle it, so the host (the user, through the approval card) must. */
export interface CanUseToolRequest {
  subtype: "can_use_tool";
  tool_name: string;
  input: Record<string, unknown>;
  tool_use_id: string;
  /** For `mcp__*` tools: the server serving the tool and where its definition
   *  came from. Untrusted text — never key a trust decision on the name. */
  mcp_server?: { name: string; source: string };
  permission_suggestions?: PermissionUpdate[];
  blocked_path?: string;
  decision_reason?: string;
  decision_reason_type?: string;
  /** Display copy rendered by the CLI's own prompt (may carry ANSI escapes). */
  title?: string;
  display_name?: string;
  description?: string;
  default_to_no?: boolean;
  suppress_always_allow_rule?: boolean;
  requires_user_interaction?: boolean;
  agent_id?: string;
  [k: string]: unknown;
}

/** CLI → host: a tool needs a blocking dialog the host must render (plan
 *  approval is `permission_exit_plan_mode_v2`). The CLI only sends a kind the
 *  host declared in `initialize.supportedDialogKinds`; the payload shape is
 *  defined per kind and transported opaquely. */
export interface RequestUserDialogRequest {
  subtype: "request_user_dialog";
  dialog_kind: string;
  payload: Record<string, unknown>;
  tool_use_id?: string;
}

/** Answer to a `request_user_dialog`. `completed` settles the dialog with the
 *  kind-specific result; `cancelled` is a real settlement too (the user
 *  dismissed it) and makes the CLI apply the dialog's default behavior. */
export type UserDialogResult =
  | { behavior: "completed"; result: Record<string, unknown> }
  | { behavior: "cancelled" };

/** CLI → host: an MCP server asked the user for input (form / URL auth). */
export interface ElicitationRequest {
  subtype: "elicitation";
  mcp_server_name: string;
  message: string;
  mode?: "form" | "url";
  url?: string;
  elicitation_id?: string;
  requested_schema?: Record<string, unknown>;
}

/** Context the host gets with one `can_use_tool` request — the request's own
 *  fields under the names the provider reads, plus the abort signal the
 *  transport fires when the CLI withdraws the request. */
export interface CanUseToolCallContext {
  signal: AbortSignal;
  /** Rules that would spare the user this prompt next time. */
  suggestions?: PermissionUpdate[];
  blockedPath?: string;
  mcpServer?: { name: string; source: string };
  decisionReason?: string;
  decisionReasonType?: string;
  requestId: string;
  toolUseID: string;
  agentID?: string;
  title?: string;
  displayName?: string;
  description?: string;
  defaultToNo?: boolean;
  suppressAlwaysAllowRule?: boolean;
}

/** Host-side permission callback: decides whether a tool call may run. Return
 *  `null` ONLY when the response was already sent another way — the tool then
 *  stays blocked until the transport is torn down. */
export type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: CanUseToolCallContext,
) => Promise<PermissionResult | null>;

export interface UserDialogCall {
  dialogKind: string;
  payload: Record<string, unknown>;
  toolUseID?: string;
}

export interface UserDialogCallContext {
  signal: AbortSignal;
  requestId: string;
}

/** Host-side dialog callback. `null` leaves the dialog unanswered. */
export type OnUserDialog = (
  request: UserDialogCall,
  options: UserDialogCallContext,
) => Promise<UserDialogResult | null>;

/** Map a raw `can_use_tool` request onto the callback's context. */
export function canUseToolContext(
  request: CanUseToolRequest,
  ctx: { signal: AbortSignal; requestId: string },
): CanUseToolCallContext {
  const context: CanUseToolCallContext = {
    signal: ctx.signal,
    requestId: ctx.requestId,
    toolUseID: request.tool_use_id,
  };
  if (request.permission_suggestions) context.suggestions = request.permission_suggestions;
  if (request.blocked_path) context.blockedPath = request.blocked_path;
  if (request.mcp_server) context.mcpServer = { name: request.mcp_server.name, source: request.mcp_server.source };
  if (request.decision_reason) context.decisionReason = request.decision_reason;
  if (request.decision_reason_type) context.decisionReasonType = request.decision_reason_type;
  if (request.agent_id) context.agentID = request.agent_id;
  if (request.title) context.title = request.title;
  if (request.display_name) context.displayName = request.display_name;
  if (request.description) context.description = request.description;
  if (request.default_to_no) context.defaultToNo = true;
  if (request.suppress_always_allow_rule) context.suppressAlwaysAllowRule = true;
  return context;
}

/** Any control request, either direction. `subtype` is the discriminant. */
export interface ControlRequest {
  subtype: string;
  [k: string]: unknown;
}

export interface ControlRequestFrame {
  type: "control_request";
  request_id: string;
  request: ControlRequest;
}

export interface ControlSuccessFrame {
  type: "control_response";
  response: {
    subtype: "success";
    request_id: string;
    /** The kind-specific payload; absent for requests that are merely
     *  acknowledged. */
    response?: Record<string, unknown>;
  };
}

export interface ControlErrorFrame {
  type: "control_response";
  response: {
    subtype: "error";
    request_id: string;
    error: string;
    error_code?: string;
  };
}

export type ControlResponseFrame = ControlSuccessFrame | ControlErrorFrame;

/** Either side withdrawing one of its own in-flight requests (e.g. a pending
 *  approval after an interrupt). There is no reply to the cancel itself. */
export interface ControlCancelFrame {
  type: "control_cancel_request";
  request_id: string;
}

/** True for any of the three control envelope shapes. */
export function isControlFrame(msg: unknown): msg is ControlRequestFrame | ControlResponseFrame | ControlCancelFrame {
  if (!msg || typeof msg !== "object") return false;
  const type = (msg as { type?: unknown }).type;
  return type === "control_request" || type === "control_response" || type === "control_cancel_request";
}

export function isControlRequestFrame(msg: unknown): msg is ControlRequestFrame {
  return (
    !!msg &&
    typeof msg === "object" &&
    (msg as { type?: unknown }).type === "control_request" &&
    typeof (msg as { request_id?: unknown }).request_id === "string" &&
    !!(msg as { request?: unknown }).request &&
    typeof (msg as { request?: unknown }).request === "object"
  );
}

export function isControlResponseFrame(msg: unknown): msg is ControlResponseFrame {
  if (!msg || typeof msg !== "object") return false;
  if ((msg as { type?: unknown }).type !== "control_response") return false;
  const response = (msg as { response?: unknown }).response;
  return (
    !!response &&
    typeof response === "object" &&
    typeof (response as { request_id?: unknown }).request_id === "string" &&
    ((response as { subtype?: unknown }).subtype === "success" ||
      (response as { subtype?: unknown }).subtype === "error")
  );
}

export function controlSuccess(
  requestId: string,
  response: Record<string, unknown>,
): ControlSuccessFrame {
  return { type: "control_response", response: { subtype: "success", request_id: requestId, response } };
}

export function controlError(
  requestId: string,
  error: string,
  errorCode?: string,
): ControlErrorFrame {
  return {
    type: "control_response",
    response: { subtype: "error", request_id: requestId, error, ...(errorCode ? { error_code: errorCode } : {}) },
  };
}

/** A host-side handler failure that should reach the CLI as a specific
 *  `error_code` (mirrors the CLI's own `unsupported_request` convention). */
export class ControlHandlerError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "ControlHandlerError";
  }
}

/** Error the transport throws / rejects with once its process is gone. */
export class CliClosedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliClosedError";
  }
}

/** Error the transport throws when the user stopped the turn (the transport's
 *  abort signal fired). The provider keys its flush path on the signal, and
 *  `isRetryableTransportError` excludes "abort" messages — keep the word. */
export class CliAbortedError extends Error {
  constructor(message = "Claude Code process aborted by user") {
    super(message);
    this.name = "AbortError";
  }
}
