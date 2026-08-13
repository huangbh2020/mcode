/**
 * Async bridge for tool-approval and user-input requests crossing the main↔renderer
 * boundary. The provider calls `requestApproval` / `requestUserInput` on
 * ProviderContext; those methods store a pending promise and emit an event to the
 * renderer. When the user responds (via the "claude:approve" IPC handler or
 * implicitly via sending an answer as the next user message), the promise resolves
 * and the provider continues.
 */
import type { RuntimeEvent, AskUserQuestionItem, PermissionMode } from "@contracts/runtime";
import type {
  ApprovalRequest,
  ProviderApprovalDecision,
  UserInputRequest,
  UserInputDecision,
  UserInputAnswers,
  PlanApprovalRequest,
  PlanApprovalDecision,
} from "@contracts/provider";

interface PendingApproval {
  resolve: (v: ProviderApprovalDecision) => void;
  reject: (e: Error) => void;
  /** Session the approval belongs to — needed so resolveApproval can
   *  record an "always allow" against the right session's tool set. */
  sessionId: string;
  /** Tool name being approved — recorded into alwaysAllowedTools when the
   *  user grants with `always: true`. */
  toolName: string;
}

interface PendingUserInput {
  resolve: (v: UserInputDecision) => void;
  reject: (e: Error) => void;
  /** Session the request belongs to — returned by resolve/dismiss so the
   *  caller can broadcast the cross-client `request.resolved` sync event. */
  sessionId: string;
}

interface PendingPlanApproval {
  resolve: (v: PlanApprovalDecision) => void;
  reject: (e: Error) => void;
  /** Session the request belongs to — see PendingUserInput. */
  sessionId: string;
}

export class ApprovalBridge {
  private pendingApprovals = new Map<string, PendingApproval>();
  private pendingUserInputs = new Map<string, PendingUserInput>();
  private pendingPlanApprovals = new Map<string, PendingPlanApproval>();
  /** Per-session set of tool names the user granted with "always allow".
   *  canUseTool checks this BEFORE asking the renderer, so a tool approved
   *  once-with-always doesn't prompt again in the same session. Cleared on
   *  dispose. */
  private alwaysAllowedTools = new Map<string, Set<string>>();
  /** Per-session current permission mode. canUseTool reads this on EVERY
   *  tool call so a mode change mid-turn (e.g. user flips to
   *  acceptEdits while a turn is running) takes effect immediately for
   *  subsequent tools — the SDK's own `permissionMode` option is fixed at
   *  query() start and can't be hot-swapped, but our host-side gate can. */
  private permissionModes = new Map<string, PermissionMode>();

  /* ── approval ── */

  /** Create an approval-request handler bound to a specific session's emit. */
  makeApprovalHandler(
    sessionId: string,
    emit: (e: RuntimeEvent) => void,
  ): (req: ApprovalRequest) => Promise<ProviderApprovalDecision> {
    return (req) =>
      new Promise<ProviderApprovalDecision>((resolve, reject) => {
        this.pendingApprovals.set(req.requestId, { resolve, reject, sessionId, toolName: req.toolName });
        emit({
          type: "approval.request",
          sessionId,
          requestId: req.requestId,
          toolCallId: req.requestId, // reuse requestId as toolCallId for tracking
          toolName: req.toolName,
          input: req.input,
          description: req.description,
        });
      });
  }

  /** Resolve an approval request (called by ipc/claude.ts CLAUDE_APPROVE handler).
   *  When the user granted with `always: true`, the tool name is recorded in
   *  the session's always-allowed set so subsequent calls skip the prompt.
   *  Returns the owning session's id on success, null when no such request is
   *  pending (already resolved by another client). */
  resolveApproval(requestId: string, decision: ProviderApprovalDecision, always?: boolean): string | null {
    const p = this.pendingApprovals.get(requestId);
    if (!p) return null;
    p.resolve(decision);
    this.pendingApprovals.delete(requestId);
    // Record "always allow" so canUseTool auto-approves this tool next time.
    if (decision.allow && always) {
      let set = this.alwaysAllowedTools.get(p.sessionId);
      if (!set) {
        set = new Set();
        this.alwaysAllowedTools.set(p.sessionId, set);
      }
      set.add(p.toolName);
    }
    return p.sessionId;
  }

  /** Has the user granted this tool with "always allow" for this session?
   *  canUseTool checks this before prompting the renderer. */
  isAlwaysAllowed(sessionId: string, toolName: string): boolean {
    return this.alwaysAllowedTools.get(sessionId)?.has(toolName) ?? false;
  }

  /** Set the session's current permission mode. canUseTool reads this on
   *  every call so a mid-turn mode change takes effect immediately. */
  setPermissionMode(sessionId: string, mode: PermissionMode): void {
    this.permissionModes.set(sessionId, mode);
  }

  /** Get the session's current permission mode (latest, even mid-turn). */
  getPermissionMode(sessionId: string): PermissionMode | undefined {
    return this.permissionModes.get(sessionId);
  }

  /* ── user input (AskUserQuestion) ── */

  /** Create a user-input-request handler for a session. */
  makeUserInputHandler(
    sessionId: string,
    emit: (e: RuntimeEvent) => void,
  ): (req: UserInputRequest) => Promise<UserInputDecision> {
    return (req) =>
      new Promise<UserInputDecision>((resolve, reject) => {
        this.pendingUserInputs.set(req.requestId, { resolve, reject, sessionId });
        emit({
          type: "question.ask",
          sessionId,
          questions: req.questions,
          requestId: req.requestId,
        } as RuntimeEvent & { requestId: string });
      });
  }

  /** Resolve a user-input request (called when the user submits answers).
   *  Returns the owning session's id on success, null when already resolved. */
  resolveUserInput(requestId: string, answers: UserInputAnswers): string | null {
    const p = this.pendingUserInputs.get(requestId);
    if (!p) return null;
    p.resolve({ answers });
    this.pendingUserInputs.delete(requestId);
    return p.sessionId;
  }

  /** Resolve a user-input request as DISMISSED (the user closed the question
   *  card without answering). The provider's canUseTool / tool execute turns
   *  `dismissed` into a deny / tool error so the model sees the question was
   *  skipped and the SAME turn continues — without this the Deferred would
   *  never resolve and the model would block forever. Returns the owning
   *  session's id on success, null when already resolved. */
  dismissUserInput(requestId: string): string | null {
    const p = this.pendingUserInputs.get(requestId);
    if (!p) return null;
    p.resolve({ answers: {}, dismissed: true });
    this.pendingUserInputs.delete(requestId);
    return p.sessionId;
  }

  /* ── plan approval (ExitPlanMode) ── */

  /** Create a plan-approval-request handler for a session. Mirrors
   * makeUserInputHandler: stores a pending promise and emits
   * plan.approval_request to the renderer. The promise resolves when the user
   * approves/rejects via the claude:respondPlanApproval IPC handler. */
  makePlanApprovalHandler(
    sessionId: string,
    emit: (e: RuntimeEvent) => void,
  ): (req: PlanApprovalRequest) => Promise<PlanApprovalDecision> {
    return (req) =>
      new Promise<PlanApprovalDecision>((resolve, reject) => {
        this.pendingPlanApprovals.set(req.requestId, { resolve, reject, sessionId });
        emit({
          type: "plan.approval_request",
          sessionId,
          requestId: req.requestId,
          toolCallId: req.toolUseId ?? req.requestId,
          plan: req.plan,
        });
      });
  }

  /** Resolve a plan-approval request (called by ipc/claude.ts
   * CLAUDE_RESPOND_PLAN_APPROVAL handler). Returns the owning session's id on
   * success, null when already resolved. */
  resolvePlanApproval(requestId: string, decision: PlanApprovalDecision): string | null {
    const p = this.pendingPlanApprovals.get(requestId);
    if (!p) return null;
    p.resolve(decision);
    this.pendingPlanApprovals.delete(requestId);
    return p.sessionId;
  }

  /* ── cleanup ── */

  /** Reject all pending requests for a session (called on interrupt / dispose). */
  rejectAll(sessionId: string): void {
    // We don't actually have sessionId-keyed lookups (requests are keyed by requestId).
    // But we can reject everything still pending — the provider should handle the
    // rejection gracefully (return deny to canUseTool).
    for (const [id, p] of this.pendingApprovals) {
      p.reject(new Error("Session cancelled"));
    }
    for (const [id, p] of this.pendingUserInputs) {
      p.reject(new Error("Session cancelled"));
    }
    for (const [id, p] of this.pendingPlanApprovals) {
      p.reject(new Error("Session cancelled"));
    }
    this.pendingApprovals.clear();
    this.pendingUserInputs.clear();
    this.pendingPlanApprovals.clear();
    // Drop per-session always-allow + mode state so a reused session id
    // (shouldn't happen, but defensive) starts clean.
    this.alwaysAllowedTools.delete(sessionId);
    this.permissionModes.delete(sessionId);
  }
}
