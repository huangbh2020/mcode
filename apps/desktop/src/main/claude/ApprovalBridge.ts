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
import { GLOBAL_ALLOWED_TOOLS_SETTING_KEY } from "@contracts/ipc";
import { log } from "@main/lib/logger.js";
import { SettingRepo } from "@main/store/repositories.js";

/** Where an "always allow" grant lives. */
export type AlwaysAllowScope = "session" | "global";

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
  /** Persisted global "always allow" list (settings key
   *  GLOBAL_ALLOWED_TOOLS_SETTING_KEY). Grants recorded here survive app
   *  restarts and apply to EVERY session in every permission mode except
   *  plan mode (plan = review-everything by definition). Lazily hydrated on
   *  first use — the bridge is constructed at module scope, long before the
   *  DB is ready. */
  private globalAllowedTools = new Set<string>();
  private globalAllowedToolsLoaded = false;
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
   *  When the user granted with `always: true`, the tool name is recorded —
   *  into the session's in-memory always-allowed set for `scope: "session"`
   *  (default, pre-existing behavior), or into the PERSISTED global allowlist
   *  for `scope: "global"` (every session, across restarts). Subsequent calls
   *  skip the prompt either way. Returns the owning session's id on success,
   *  null when no such request is pending (already resolved by another client). */
  resolveApproval(
    requestId: string,
    decision: ProviderApprovalDecision,
    always?: boolean,
    scope?: AlwaysAllowScope,
  ): string | null {
    const p = this.pendingApprovals.get(requestId);
    if (!p) return null;
    // Surface the "always allow" intent on the decision itself so providers
    // with a server-side session grant (codex acceptForSession) can scope
    // their grant accordingly (one-shot "accept" vs session-wide).
    p.resolve(decision.allow && always ? { ...decision, persist: true } : decision);
    this.pendingApprovals.delete(requestId);
    // Record "always allow" so canUseTool auto-approves this tool next time.
    // A GLOBAL grant deliberately does NOT also land in the session set: the
    // global set already covers this session in every non-plan mode, and the
    // session set is exempt from the plan-mode gate — recording it there would
    // let a global grant made while in plan mode keep auto-allowing the tool
    // in that plan session, defeating the exemption.
    if (decision.allow && always) {
      if (scope === "global") {
        this.ensureGlobalAllowedToolsLoaded();
        if (!this.globalAllowedTools.has(p.toolName)) {
          this.globalAllowedTools.add(p.toolName);
          this.persistGlobalAllowedTools();
        }
      } else {
        let set = this.alwaysAllowedTools.get(p.sessionId);
        if (!set) {
          set = new Set();
          this.alwaysAllowedTools.set(p.sessionId, set);
        }
        set.add(p.toolName);
      }
    }
    return p.sessionId;
  }

  /** Has the user granted this tool with "always allow" for this session?
   *  canUseTool checks this before prompting the renderer. Two sources:
   *  the session-scoped in-memory set, and the persisted GLOBAL allowlist —
   *  the global one is skipped while the session runs in plan mode (plan
   *  mode reviews everything by definition), while the session grant keeps
   *  its pre-existing apply-everywhere semantics. */
  isAlwaysAllowed(sessionId: string, toolName: string): boolean {
    if (this.alwaysAllowedTools.get(sessionId)?.has(toolName)) return true;
    if (!this.globalAllowedTools.has(toolName)) return false;
    return this.permissionModes.get(sessionId) !== "plan";
  }

  /** Current persisted global always-allow list (sorted). Loads from the
   *  settings table on first call. */
  getGlobalAllowedTools(): string[] {
    this.ensureGlobalAllowedToolsLoaded();
    return [...this.globalAllowedTools].sort();
  }

  /** Replace the persisted global always-allow list (settings editor is the
   *  whole-list writer; approval-card "global" grants add one entry on top).
   *  Takes effect immediately for every session — even mid-turn, because
   *  canUseTool consults this set on every tool call. */
  setGlobalAllowedTools(tools: string[]): void {
    this.globalAllowedTools = new Set(tools);
    this.globalAllowedToolsLoaded = true;
    this.persistGlobalAllowedTools();
  }

  /** Hydrate the global allowlist from the settings table. Idempotent; any
   *  read/parse failure degrades to an empty list (never throws into the
   *  approval path) and stays unloaded=false so a later call can retry once
   *  the DB is actually available. */
  private ensureGlobalAllowedToolsLoaded(): void {
    if (this.globalAllowedToolsLoaded) return;
    try {
      const raw = SettingRepo.get(GLOBAL_ALLOWED_TOOLS_SETTING_KEY);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this.globalAllowedTools = new Set(
            parsed.filter((t): t is string => typeof t === "string" && t.length > 0),
          );
        }
      }
      this.globalAllowedToolsLoaded = true;
    } catch (err) {
      // getDb() throws before initDb() resolves — retry on the next consult
      // (turns can't run that early, so in practice the first consult always
      // happens with the DB ready).
      log.warn(`approval: failed to load global allowed tools: ${(err as Error).message}`);
    }
  }

  /** Best-effort persist of the global allowlist. A failed write keeps the
   *  in-memory grant alive for this run (same policy as the renderer's
   *  fire-and-forget setting writes). */
  private persistGlobalAllowedTools(): void {
    try {
      SettingRepo.set(
        GLOBAL_ALLOWED_TOOLS_SETTING_KEY,
        JSON.stringify([...this.globalAllowedTools].sort()),
      );
    } catch (err) {
      log.error(`approval: failed to persist global allowed tools: ${(err as Error).message}`);
    }
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

  /** Reject all pending requests for a session (called on interrupt / dispose).
   *  Scoped to the given session — with concurrent sessions (e.g. a side chat
   *  running next to its parent) a blanket clear would kill the OTHER
   *  session's pending prompts. */
  rejectAll(sessionId: string): void {
    for (const [id, p] of this.pendingApprovals) {
      if (p.sessionId !== sessionId) continue;
      p.reject(new Error("Session cancelled"));
      this.pendingApprovals.delete(id);
    }
    for (const [id, p] of this.pendingUserInputs) {
      if (p.sessionId !== sessionId) continue;
      p.reject(new Error("Session cancelled"));
      this.pendingUserInputs.delete(id);
    }
    for (const [id, p] of this.pendingPlanApprovals) {
      if (p.sessionId !== sessionId) continue;
      p.reject(new Error("Session cancelled"));
      this.pendingPlanApprovals.delete(id);
    }
    // Drop per-session always-allow + mode state so a reused session id
    // (shouldn't happen, but defensive) starts clean.
    this.alwaysAllowedTools.delete(sessionId);
    this.permissionModes.delete(sessionId);
  }
}
