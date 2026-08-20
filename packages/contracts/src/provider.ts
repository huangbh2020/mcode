/**
 * Provider abstraction — the adapter contract between a host (Electron main)
 * and any AI-agent backend (Claude Agent SDK, Codex CLI, Gemini CLI, …).
 *
 * ## Design goals
 * 1. The renderer and IPC layer only see `RuntimeEvent` — they never know which
 *    provider produced it. `AgentProvider.startTurn` takes a prompt + cwd and
 *    yields `RuntimeEvent`s via `ProviderContext.emit`.
 * 2. Capability negotiation: the host reads `AgentProvider.capabilities` to
 *    decide what UI/flow to present (e.g. show an approval bar vs. not).
 * 3. Inversion of control: provider *calls back* into the host for user decisions
 *    (`requestApproval`, `requestUserInput`). The host (RuntimeManager) bridges
 *    those async callbacks to the renderer via IPC, so the provider never touches
 *    Electron directly — it's testable without Electron.
 * 4. Adding a new provider should need only (a) implement `AgentProvider`,
 *    (b) `registry.register()` one line, (c) expose it in `provider.list`.
 *    No changes to RuntimeManager, IPC RpcMap, frontend store, or persistence.
 */
import type { RuntimeEvent, PermissionMode, EffortLevel, AskUserQuestionItem } from "./runtime.js";
import type { ApiConfig } from "./customModel.js";
import type { SessionTodoItem } from "./session.js";

/** What a provider can do — used by the UI to enable/disable features. */
export interface ProviderCapabilities {
  /** Can this provider intercept tool calls before execution? */
  supportsApproval: boolean;
  /** Can turns be resumed across app restarts (session continuity)? */
  supportsResume: boolean;
  /** Does it emit token-level stream_event deltas? */
  supportsStreaming: boolean;
  /** Does it support MCP server config? */
  supportsMcp: boolean;
  /** Does it have native AskUserQuestion tool support? */
  supportsAskUserQuestion: boolean;

  // ── Declarative capability descriptors (UI renders from these) ──
  /** Thinking / effort levels this provider supports. Empty/undefined = hide
   *  the effort chip entirely. Each provider declares its own set so the UI
   *  never hardcodes provider-specific values. */
  thinkingLevels?: ThinkingLevelOption[];
  /** Permission modes this provider supports. Empty/undefined = hide the
   *  permission chip. Claude and Pi both declare the same 4 user-facing modes
   *  (default/acceptEdits/plan/bypassPermissions); Pi interprets them at
   *  runtime via its inline extension's tool_call handler. */
  permissionModes?: PermissionModeOption[];
  /** Built-in model aliases (non-custom-endpoint). Empty/undefined = the
   *  provider only works via custom endpoint configs or dynamic model list. */
  builtinModels?: BuiltinModelOption[];
  /** Whether the provider supports custom-endpoint configuration (the
   *  "添加/管理模型" entry in ModelDropdown). When false, the custom-model
   *  panel and its dropdown entry are hidden for this provider. */
  supportsCustomEndpoint?: boolean;
}

/** A selectable option for a provider's thinking-level / effort picker. */
export interface ThinkingLevelOption {
  value: string;
  label: string;
  hint?: string;
}

/** A selectable option for a provider's permission-mode picker. */
export interface PermissionModeOption {
  value: string;
  label: string;
  /** Icon name resolved by the renderer's icon map. */
  icon?: string;
  /** Semantic color token (e.g. "text-warning", "text-danger"). */
  color?: string;
  hint?: string;
}

/** A built-in model entry a provider exposes without custom-endpoint config. */
export interface BuiltinModelOption {
  id: string;
  label: string;
  hint?: string;
  /** Supplier/provider this model belongs to (pi: the models.json provider
   *  name). Lets a model picker group models by vendor instead of dumping
   *  the raw `provider/modelId` id in front of the user. */
  supplier?: string;
}

/** Request to start one turn/conversation. Provider-neutral equivalent of the
 * old TurnRequest (which was coupled to claude CLI flags). */
export interface StartTurnRequest {
  /** GUI session id — the provider embeds this in every emitted RuntimeEvent. */
  sessionId: string;
  prompt: string;
  /** Working directory (project root). */
  cwd: string;
  model?: string;
  effort?: EffortLevel;
  permissionMode?: PermissionMode;
  /** Provider's own conversation id, used to resume a prior conversation.
   * null = first turn of a new conversation. */
  resumeProviderSessionId?: string | null;
  /** When set, the provider injects the custom endpoint's env vars
   *  (ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY /
   *  alias mappings / etc.) into the SDK subprocess so the turn runs against
   *  the user's endpoint instead of the default credential discovery.
   *  Main-process only — never crosses the IPC boundary (the cleartext token
   *  is decrypted in main right before the turn starts). */
  apiConfig?: ApiConfig;
  /** Skill names the user picked in the composer (without the leading "/").
   *  When non-empty the provider passes them as the SDK `Options.skills`
   *  allowlist so the model's `Skill` tool can actually reach them. This is
   *  required because `query()` runs the bundled binary in stream-json input
   *  mode, where the CLI does NOT re-parse `/name` slash commands from the
   *  prompt text — so the `/name` literals the composer inlines are display-
   *  only and never trigger the Skill tool on their own. Omitted/empty falls
   *  back to `skills: "all"` (let the model self-discover). */
  skills?: string[];
  /** Persisted todos from the previous turn(s). The provider seeds its
   *  in-memory task list with these so that incremental TaskUpdate calls
   *  (which reference a 1-based taskId from earlier turns) still resolve
   *  correctly instead of being silently dropped on a fresh adapter that
   *  starts with an empty task list. */
  initialTodos?: SessionTodoItem[];
  /** 1-based turn number for this session (incremented per user message by
   *  RuntimeManager). Used by the browser tools to organize per-turn
   *  screenshot directories. Optional — providers that don't need it ignore
   *  it. */
  turnNumber?: number;
  /** User-attached images to send inline with the prompt (base64, no data:
   *  prefix). Provider-neutral: Claude maps mimeType → ImageBlockParam.
   *  media_type (Anthropic allowlist), Pi passes it straight through as
   *  ImageContent.mimeType. Empty/absent = text-only turn (the prompt string
   *  may still be empty for an image-only send). */
  images?: { data: string; mimeType: string }[];
}

/** Approval request passed from provider → host (for canUseTool-style callbacks). */
export interface ApprovalRequest {
  requestId: string;
  toolName: string;
  input: unknown;
  description?: string;
}

/** The host's answer to an approval request. */
export interface ProviderApprovalDecision {
  allow: boolean;
  /** Optionally modify the tool input before passing it to the tool. */
  updatedInput?: unknown;
  /** If denied, a message the model will see. */
  reason?: string;
}

/** User-input request (AskUserQuestion) passed from provider → host. */
export interface UserInputRequest {
  requestId: string;
  questions: AskUserQuestionItem[];
  /** The SDK's toolUseID for the AskUserQuestion tool call, when available.
   * Used by the provider to correlate the answer back to the SDK's
   * canUseTool/updatedInput round-trip. Absent in sentinel fallback mode. */
  toolUseId?: string;
}

/**
 * Per-question answers keyed by question text (matches the SDK's convention:
 * the answers map's keys are the `question` field of each AskUserQuestion
 * item). Values:
 *  - string   → single-select or free-text answer (the option label, or the
 *               user's custom text)
 *  - string[] → multi-select answers (option labels)
 *  - null     → question skipped / cancelled
 *
 * The provider maps this into the SDK's `updatedInput.answers` shape, which
 * uses the question text as key and the option label (or comma-joined labels)
 * as value.
 */
export type UserInputAnswers = Record<string, string | string[] | null>;

/** The host's answer to a user-input request. */
export interface UserInputDecision {
  answers: UserInputAnswers;
  /** True when the user CLOSED the question card without answering. The
   *  provider turns this into a deny / tool error so the model sees the
   *  question was skipped and the SAME turn continues — without it the
   *  pending Deferred would never resolve and the model would block forever. */
  dismissed?: boolean;
}

/** Plan-approval request (ExitPlanMode tool) passed from provider → host. */
export interface PlanApprovalRequest {
  requestId: string;
  /** The plan text the model proposed (from ExitPlanMode's input.plan). */
  plan: string;
  /** The SDK's toolUseID for the ExitPlanMode call, for correlation. */
  toolUseId?: string;
}

/** The host's answer to a plan-approval request.
 *  - approved=true  → provider returns `{behavior:"allow"}` with the (possibly
 *    edited) plan in updatedInput; the SDK exits plan mode for this turn.
 *  - approved=false → provider returns `{behavior:"deny", message: reason}`;
 *    the SDK stays in plan mode and the model can revise and re-request.
 */
export interface PlanApprovalDecision {
  approved: boolean;
  /** User-edited plan text; only meaningful when approved. When provided,
   * replaces input.plan in the updatedInput sent back to the SDK. */
  editedPlan?: string;
  /** Feedback message sent to the model when denied. */
  reason?: string;
  /** User's plan-adjustment feedback typed into the approval sheet. On
   * approve it's passed to the model alongside the approval so execution
   * incorporates the adjustments; on reject it doubles as the reason. */
  feedback?: string;
}

/**
 * Host services injected into every provider. The provider calls these instead
 * of touching IPC / Electron / SQLite directly.
 */
export interface ProviderContext {
  /** Emit a normalized runtime event to the renderer. */
  emit(e: RuntimeEvent): void;

  /** Request user approval before a tool runs. The provider awaits the promise;
   * the host bridges it to the renderer (approval.request event → user clicks
   * allow/deny → result returned here). Only called when capabilities say
   * supportsApproval. */
  requestApproval?(req: ApprovalRequest): Promise<ProviderApprovalDecision>;

  /** Ask the user a structured question (AskUserQuestion tool). Same
   * async-bridge pattern as requestApproval. */
  requestUserInput?(req: UserInputRequest): Promise<UserInputDecision>;

  /** Ask the user to approve a plan (ExitPlanMode tool in plan mode). Same
   *  async-bridge pattern as requestApproval/requestUserInput: the provider
   *  awaits the promise; the host bridges it to the renderer
   *  (plan.approval_request event → user approves/rejects → result returned). */
  requestPlanApproval?(req: PlanApprovalRequest): Promise<PlanApprovalDecision>;

  /** Has the user granted this tool with "always allow" for this session?
   *  The provider's canUseTool checks this BEFORE calling requestApproval,
   *  so a once-always-approved tool doesn't prompt again. */
  isToolAlwaysAllowed?(toolName: string): boolean;

  /** The session's current permission mode (latest value, even if changed
   *  mid-turn). The provider's canUseTool reads this on every call so a
   *  mode flip (e.g. user switches to acceptEdits while a turn runs) takes
   *  effect immediately for subsequent tools — the SDK's own
   *  `permissionMode` option is fixed at query() start. */
  getPermissionMode?(): PermissionMode | undefined;

  /** The provider calls this once per conversation with its own session id,
   * so the host can persist it and the next turn can resume. */
  onProviderSessionId?(id: string): void;

  /** Logger (writes to file + stderr). */
  log: {
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
  };
}

/** Control handle for a running turn. */
export interface TurnHandle {
  /** Resolves when the turn is done (success / error / interrupted). */
  done: Promise<void>;
  /** Ask the provider to stop gracefully (SIGINT / abort). */
  interrupt(): void;
  /** Whether the turn is still active. */
  isRunning(): boolean;
}

/** Every AI backend implements this interface. */
export interface AgentProvider {
  /** Unique id, e.g. "claude-sdk". Persisted in SQLite, used as registry key. */
  readonly id: string;
  /** Human-readable name for UI. */
  readonly displayName: string;
  /** What this provider can do. */
  readonly capabilities: ProviderCapabilities;

  /** Start a turn. Returns a handle immediately; events stream via ctx.emit.
   * The returned TurnHandle.done resolves when the turn finishes. */
  startTurn(req: StartTurnRequest, ctx: ProviderContext): Promise<TurnHandle>;

  /** Optional: quick health / version probe for settings UI. */
  healthCheck?(): Promise<{ ok: boolean; version?: string; error?: string }>;
}
