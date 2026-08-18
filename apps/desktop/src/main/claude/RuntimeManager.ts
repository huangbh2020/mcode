/**
 * RuntimeManager — per-session turn lifecycle, now provider-agnostic.
 *
 * Replaces the old ClaudeRuntime-based implementation. Instead of `new ClaudeRuntime()`,
 * it resolves a provider from the registry and constructs a ProviderContext that bridges
 * events to the renderer and async approval/user-input requests via ApprovalBridge.
 */
import { sendToRenderer } from "@main/window.js";
import { IPC } from "@contracts/ipc";
import type { RuntimeEvent, PermissionMode, ContextSnapshot, TurnUsageRecord, TurnFileEntry, UserMessageEvent } from "@contracts/runtime";
import type { Session } from "@contracts/session";
import type { ProviderContext, TurnHandle, StartTurnRequest, UserInputAnswers, PlanApprovalDecision } from "@contracts/provider";
import { providerRegistry } from "@main/providers/registry.js";
import { SessionRepo, ProjectRepo } from "@main/store/repositories.js";
import { CustomModelStore } from "@main/lib/secretStore.js";
import { ApprovalBridge } from "./ApprovalBridge.js";
import { getFileSnapshot, dropFileSnapshot } from "@main/lib/fileSnapshotRegistry.js";
import { restoreFiles } from "@main/lib/fileSnapshot.js";
import { BridgeRegistry } from "@main/providers/bridge/bridgeRegistry.js";
import { mobileEventBus } from "@main/mobile/MobileEventBus.js";
import { broadcastRuntimeEvent } from "@main/lib/sessionSync.js";
import { invalidateUsageStats } from "@main/lib/usageStats.js";
import { log } from "@main/lib/logger.js";

interface SessionRuntime {
  /** The TurnHandle for the currently running turn, if any. */
  handle?: TurnHandle;
  /** The claude/provider session id captured from the system/init message. */
  providerSessionId: string | null;
  /** ProviderContext (long-lived for the session). */
  ctx: ProviderContext;
  /** Cwd of the most recent (or current) turn. Stashed so rewindTurn
   *  can resolve snapshot paths without having to ask the provider
   *  (the TurnHandle interface doesn't expose it). */
  lastCwd: string | null;
  /** Wall-clock ms when the current turn started (Date.now()). Used to
   *  compute `durationMs` in the per-turn usage history. */
  turnStartedAt: number;
  /** Latest context snapshot emitted by the adapter (tracked from
   *  `token-usage.updated` events). Read at `turn.done` to build the
   *  per-turn usage history entry. */
  lastContextSnapshot?: ContextSnapshot;
  /** Per-turn usage history for this session. Hydrated from the persisted
   *  session row at bind; appended at each `turn.done` and written back. */
  usageHistory: TurnUsageRecord[];
  /** 1-based turn counter, incremented at each sendTurn. Used to tag browser
   *  screenshots with a per-turn directory (`turn-<N>`). In-memory only —
   *  restarts restart the count, matching the per-session runtime lifetime. */
  turnCount: number;
  /** When the session's config uses the OpenAI protocol, this holds the
   *  customModelId whose bridge we acquired (paired with a release on
   *  dispose). Undefined for anthropic-protocol / no-custom-model sessions. */
  bridgeConfigId?: string;
  /** The bridge handle when this session has acquired an OpenAI bridge. We
   *  keep it to read its localUrl when rewriting the apiConfig each turn, and
   *  to know the bridge is alive. Released in dispose(). */
  bridgeHandle?: { localUrl: string };
}

const approvalBridge = new ApprovalBridge();

class RuntimeManager {
  private sessions = new Map<string, SessionRuntime>();
  /** Optional observer fired for every emitted RuntimeEvent (after the
   *  renderer push + persistence). Used by the NotificationManager to decide
   *  whether an OS notification is warranted. Set via {@link setObserver}. */
  private observer: ((e: RuntimeEvent) => void) | null = null;

  /** Register a global event observer. Only one at a time (the
   *  NotificationManager). Pass null to detach. */
  setObserver(fn: ((e: RuntimeEvent) => void) | null): void {
    this.observer = fn;
  }

  /** Create or reuse the runtime state for a GUI session. Idempotent. */
  bindSession(session: Session): void {
    if (this.sessions.has(session.id)) return;

    const emit = (e: RuntimeEvent) => {
      sendToRenderer(IPC.CLAUDE_EVENT, { channel: IPC.CLAUDE_EVENT, sessionId: e.sessionId, event: e });
      // Fan out to mobile clients over SSE. Same fire-and-forget contract — a
      // thrown subscriber is swallowed inside broadcast(). No subscribers ⇒
      // cheap no-op, so this is safe even when the mobile feature is unused.
      try {
        mobileEventBus.broadcast(e);
      } catch (err) {
        log.error(`mobile event bus error: ${(err as Error).message}`);
      }
      // Persist capsule state so the top-right status pill reloads on
      // session reopen. Each event type → one Repo call, fire-and-forget.
      // contextSnapshot / todos / subagents / planDraft are all JSON blobs.
      if (e.type === "token-usage.updated") {
        try {
          SessionRepo.updateSnapshot(session.id, e.snapshot);
        } catch (err) {
          log.error(`failed to persist context snapshot: ${(err as Error).message}`);
        }
        // Track the latest snapshot so turn.done can persist the usage history.
        const rt = this.sessions.get(session.id);
        if (rt) rt.lastContextSnapshot = e.snapshot;
      } else if (e.type === "turn.done") {
        // Persist the per-turn token/cost history. The final snapshot for the
        // turn is `lastContextSnapshot` (captured from the last token-usage.updated).
        // durationMs is derived from turnStartedAt (set in sendTurn).
        try {
          const rt = this.sessions.get(session.id);
          const snap = rt?.lastContextSnapshot;
          if (rt && snap && rt.turnStartedAt > 0) {
            const record: TurnUsageRecord = {
              endedAt: Date.now(),
              durationMs: Math.max(0, Date.now() - rt.turnStartedAt),
              totalProcessedTokens: snap.totalProcessedTokens,
              outputTokens: snap.outputTokens,
              cacheReadTokens: snap.cacheReadTokens ?? 0,
              cacheCreationTokens: snap.cacheCreationTokens ?? 0,
              costUsd: snap.costUsd,
              usedTokens: snap.usedTokens,
              model: snap.model,
            };
            rt.usageHistory = [...rt.usageHistory, record];
            SessionRepo.updateUsageHistory(session.id, rt.usageHistory);
            invalidateUsageStats();
          }
        } catch (err) {
          log.error(`failed to persist usage history: ${(err as Error).message}`);
        }
      } else if (e.type === "todo.update") {
        try {
          SessionRepo.updateTodos(session.id, e.todos);
        } catch (err) {
          log.error(`failed to persist todos: ${(err as Error).message}`);
        }
      } else if (e.type === "subagent.update") {
        try {
          SessionRepo.updateSubagents(session.id, e.agents);
        } catch (err) {
          log.error(`failed to persist subagents: ${(err as Error).message}`);
        }
      } else if (e.type === "plan.update") {
        try {
          SessionRepo.updatePlanDraft(session.id, { plan: e.plan, phase: e.phase });
        } catch (err) {
          log.error(`failed to persist plan draft: ${(err as Error).message}`);
        }
      } else if (e.type === "turn.files") {
        // Persist the per-turn modified-files snapshot so the "本轮修改" card
        // survives a session reopen. The payload already carries adds/dels/before
        // (computed in FileSnapshot.freeze), so we store it verbatim.
        try {
          SessionRepo.updateTurnFiles(session.id, e.files);
        } catch (err) {
          log.error(`failed to persist turn files: ${(err as Error).message}`);
        }
      } else if (e.type === "turn.rewound") {
        // A rewind voids the rewound turn's edits. Clear the persisted
        // latest-turn snapshot ONLY when the rewound card IS the latest
        // turn (its path set matches the persisted turn_files) — otherwise
        // (historical rewind) the latest turn's data must stay intact, or
        // it would vanish from a session reopen after a historical rewind.
        try {
          const persisted = SessionRepo.get(session.id)?.turnFiles ?? null;
          const matchesLatest =
            persisted !== null &&
            persisted.length === e.targetFiles.length &&
            new Set(e.targetFiles).size === e.targetFiles.length &&
            persisted.every((f) => e.targetFiles.includes(f.filePath));
          if (matchesLatest) {
            SessionRepo.updateTurnFiles(session.id, null);
          }
        } catch (err) {
          log.error(`failed to clear turn files after rewind: ${(err as Error).message}`);
        }
      }
      // Notify the global observer (NotificationManager) after the renderer
      // push + persistence. Fire-and-forget; errors in the observer must not
      // disrupt the event stream.
      try {
        this.observer?.(e);
      } catch (err) {
        log.error(`notification observer error: ${(err as Error).message}`);
      }
    };

    const onProviderSessionId = (id: string) => {
      const rt = this.sessions.get(session.id);
      if (!rt) return;
      if (rt.providerSessionId === id) return;
      rt.providerSessionId = id;
      try {
        SessionRepo.updateClaudeSessionId(session.id, id);
      } catch (err) {
        log.error(`failed to persist provider session id: ${(err as Error).message}`);
      }
    };

    const ctx: ProviderContext = {
      emit,
      onProviderSessionId,
      log,
      requestApproval: approvalBridge.makeApprovalHandler(session.id, emit),
      requestUserInput: approvalBridge.makeUserInputHandler(session.id, emit),
      requestPlanApproval: approvalBridge.makePlanApprovalHandler(session.id, emit),
      // Expose the per-session always-allow set + current permission mode so
      // the provider's canUseTool can short-circuit without prompting the
      // renderer. Both read the live bridge state, so a mid-turn mode flip
      // (setPermissionMode) is visible to the next tool call immediately.
      isToolAlwaysAllowed: (toolName: string) => approvalBridge.isAlwaysAllowed(session.id, toolName),
      getPermissionMode: () => approvalBridge.getPermissionMode(session.id),
    };
    // Seed the session's permission mode so canUseTool sees the right value
    // from the first tool call (subsequent flips via setPermissionMode update it).
    approvalBridge.setPermissionMode(session.id, session.permissionMode);

    this.sessions.set(session.id, {
      providerSessionId: session.claudeSessionId,
      ctx,
      lastCwd: null,
      turnStartedAt: 0,
      usageHistory: session.usageHistory ?? [],
      turnCount: 0,
    });
  }

  /** IDs of every session with a currently running turn. Used by the mobile
   *  SSE endpoint to publish a running-state snapshot on (re)connect, so a
   *  phone that missed `turn.done` while backgrounded can self-correct its
   *  client-side running state. */
  runningSessionIds(): string[] {
    const ids: string[] = [];
    for (const [id, rt] of this.sessions) {
      if (rt.handle?.isRunning()) ids.push(id);
    }
    return ids;
  }

  /** Send a user message to the provider and stream events back. */
  async sendTurn(
    session: Session,
    input: {
      prompt: string;
      cwd: string;
      skills?: string[];
      images?: { data: string; mimeType: string }[];
      /** The originating client's user message (id / createdAt / display
       *  blocks). Echoed to every client as a `user.message` RuntimeEvent so
       *  a prompt typed on one device (phone ⇄ PC) renders on the others in
       *  real time; the originator dedupes by id (it appended optimistically
       *  at send). Absent for callers that predate the field — no echo. */
      userMessage?: { id: string; createdAt: number; blocks: unknown[] };
    },
  ): Promise<void> {
    const rt = this.sessions.get(session.id);
    if (!rt) {
      log.warn(`sendTurn: no runtime bound for session ${session.id}`);
      return;
    }
    if (rt.handle?.isRunning()) {
      log.warn(`sendTurn: session ${session.id} already running, ignoring`);
      return;
    }

    const provider = providerRegistry.resolve(session.providerId);

    // Record turn start time for per-turn usage history persistence.
    rt.turnStartedAt = Date.now();
    // 1-based turn counter for per-turn artifacts (browser screenshot dirs).
    rt.turnCount++;

    // Reset the per-turn file snapshot before the new turn. This is
    // what makes "rewind last turn" work correctly across consecutive
    // turns: turn N's snapshot is taken from the state at the *start*
    // of turn N (i.e. end of turn N-1), which is what the user
    // expects when clicking 撤销本轮. Without the clear, turn N-1's
    // files would still be in the snapshot and rewind would partially
    // undo turn N-1 instead of fully undoing turn N.
    getFileSnapshot(session.id).clear();

    // If the session is bound to a custom-model config, decrypt its
    // credentials (main-process only) and pass them through to the provider
    // so the turn runs against the user's endpoint. `session.model` carries
    // the selected role key (e.g. "sonnet" / "fable"); resolveApiConfig
    // validates it against the config's bound roles (falling back to the
    // first bound role if it's been cleared). Cleartext lives only in this
    // request object for the duration of the turn.
    let apiConfig: StartTurnRequest["apiConfig"];
    // The model id to pass to the SDK `model` option. For a custom config we
    // deliberately leave this undefined: `session.model` is a ROLE KEY (not a
    // model id), and buildCustomEnv pins ANTHROPIC_MODEL from the selected
    // role's requestModel (with the `[1m]` suffix when supports1m). The
    // binary reads ANTHROPIC_MODEL as its native model-override channel, so
    // passing --model too would just risk disagreeing with the env var.
    // For the built-in path it's the session's model unless "default".
    let modelForReq: string | undefined = session.model !== "default" ? session.model : undefined;
    if (session.customModelId) {
      const cfg = CustomModelStore.resolveApiConfig(session.customModelId, session.model);
      if (!cfg) {
        log.warn(`sendTurn: custom model ${session.customModelId} not found, token undecryptable, or no role bound; falling back to default endpoint`);
      } else {
        // OpenAI-protocol endpoints need an in-process bridge that impersonates
        // Anthropic /v1/messages. We rewrite the apiConfig to point at the
        // local bridge, so the rest of the pipeline (buildCustomEnv, the binary)
        // is completely unaware anything special is happening — it just sees an
        // Anthropic-compatible endpoint on localhost. The bridge is shared
        // across sessions via the registry (keyed by config id, ref-counted).
        if (cfg.protocol === "openai") {
          // Release any bridge we're holding for a DIFFERENT config (the user
          // may have switched custom models mid-session), then acquire for the
          // current one. We hold exactly one bridge per session; same-config
          // repeats across turns reuse the existing handle without bumping the
          // ref count again.
          if (rt.bridgeConfigId && rt.bridgeConfigId !== session.customModelId) {
            BridgeRegistry.release(rt.bridgeConfigId);
            rt.bridgeConfigId = undefined;
            rt.bridgeHandle = undefined;
          }
          if (!rt.bridgeConfigId) {
            const handle = await BridgeRegistry.acquire(session.customModelId, cfg);
            rt.bridgeConfigId = session.customModelId;
            rt.bridgeHandle = { localUrl: handle.localUrl };
          }
          // rt.bridgeHandle is now guaranteed set (we just ensured it above);
          // bind to a local so TS keeps it narrowed through the rewrite below.
          const localUrl = rt.bridgeHandle?.localUrl;
          // Rewrite the apiConfig to point at the local bridge so the rest of
          // the pipeline (buildCustomEnv, the binary) is completely unaware —
          // it just sees an Anthropic-compatible endpoint on localhost.
          apiConfig = { ...cfg, baseUrl: localUrl ?? cfg.baseUrl };
        } else {
          apiConfig = cfg;
        }
        modelForReq = undefined; // env pins ANTHROPIC_MODEL via buildCustomEnv
      }
    }

    // Cross-client user-message echo — emitted BEFORE the provider turn
    // starts so the bubble lands on other clients ahead of the first
    // assistant event. The originator ignores it by id match (see
    // UserMessageEvent); every other client appends it verbatim.
    if (input.userMessage) {
      rt.ctx.emit({
        type: "user.message",
        sessionId: session.id,
        messageId: input.userMessage.id,
        createdAt: input.userMessage.createdAt,
        blocks: input.userMessage.blocks,
      } satisfies UserMessageEvent);
    }

    const req: StartTurnRequest = {
      sessionId: session.id,
      prompt: input.prompt,
      cwd: input.cwd,
      model: modelForReq,
      effort: session.effort !== "default" ? session.effort : undefined,
      permissionMode: session.permissionMode !== "default" ? session.permissionMode : undefined,
      resumeProviderSessionId: rt.providerSessionId,
      apiConfig,
      skills: input.skills,
      // User-attached images (base64 content blocks) — forwarded verbatim to
      // the provider; each adapter maps them onto its SDK's image shape.
      images: input.images,
      // Seed the adapter with the persisted todo list so that incremental
      // TaskUpdate(taskId=N) calls in this turn can resolve against tasks
      // created in earlier turns (the adapter is recreated fresh each turn).
      initialTodos: session.todos ?? undefined,
      // Tag the turn for per-turn artifacts (browser screenshot dirs).
      turnNumber: rt.turnCount,
    };

    const handle = await provider.startTurn(req, rt.ctx);
    rt.handle = handle;
    // Remember the cwd for the rewind path (see rewindTurn below).
    rt.lastCwd = input.cwd;

    // Run in background; errors are caught inside the provider's done loop.
    handle.done.catch((err) => {
      log.error(`turn failed: ${(err as Error).message}`);
    });
  }

  interrupt(sessionId: string): void {
    const rt = this.sessions.get(sessionId);
    if (!rt?.handle) return;
    rt.handle.interrupt();
  }

  dispose(sessionId: string): void {
    const rt = this.sessions.get(sessionId);
    if (!rt) return;
    try {
      rt.handle?.interrupt();
    } catch {
      /* ignore */
    }
    approvalBridge.rejectAll(sessionId);
    // Release any OpenAI bridge this session was holding, so the ref count
    // drops and the shared server can shut down when no session needs it.
    if (rt.bridgeConfigId) {
      BridgeRegistry.release(rt.bridgeConfigId);
      rt.bridgeConfigId = undefined;
      rt.bridgeHandle = undefined;
    }
    // Drop the snapshot too — keep memory bounded as sessions come
    // and go. The registry holds onto the per-session FileSnapshot
    // for the lifetime of the app otherwise.
    dropFileSnapshot(sessionId);
    this.sessions.delete(sessionId);
  }

  /** Rewind a turn for a session: restore the given `files` to their
   *  pre-turn state, then emit a `turn.rewound` event so the renderer
   *  can update its "本轮文件" card. Returns the list of paths actually
   *  restored (failed paths are logged in main but not surfaced).
   *
   *  The caller passes the explicit entries to restore — this works for
   *  the latest turn (entries from the live snapshot), ANY historical
   *  turn (entries persisted on the message), and a session reopened
   *  after restart (entries rehydrated from the DB). None of these
   *  cases depend on the in-memory FileSnapshot being present.
   *
   *  `targetFiles` (the requested path set) is forwarded on the event so
   *  the renderer can locate the exact card and mark it `rewound: true`
   *  in place — for BOTH latest-turn and historical rewinds. The card is
   *  never removed: it stays in the stream as a visible trace that the
   *  user rolled this turn back. */
  async rewindTurn(sessionId: string, files: TurnFileEntry[], targetFiles: string[]): Promise<string[]> {
    const rt = this.sessions.get(sessionId);
    // Resolve the cwd: prefer the live runtime's lastCwd (set on the first
    // sendTurn). When that's missing - the common case for the "会话重开后
    // 仍可撤回" feature, where the user reopens a session and immediately
    // clicks 撤销本轮 WITHOUT sending a new turn first - fall back to the
    // session row's project path. This is what makes the DB-driven rewind
    // path actually work: restoreFiles only needs cwd + entries, never the
    // in-memory FileSnapshot.
    const cwd =
      rt?.lastCwd ??
      (() => {
        const session = SessionRepo.get(sessionId);
        const project = session ? ProjectRepo.get(session.projectId) : undefined;
        return project?.path ?? null;
      })();
    if (!cwd) {
      log.warn(`rewindTurn: cwd not available for session ${sessionId} (no runtime, no project?)`);
      return [];
    }
    const restored = await restoreFiles(cwd, files);
    // After a successful restore, drop the in-memory snapshot ONLY when
    // the rewind targeted exactly its contents (i.e. the latest live
    // turn). `hasPaths` is the authoritative check: the live snapshot
    // holds exactly the LATEST turn's files, so a path-set match means
    // this was the live rewind; anything else is a historical/DB-driven
    // rewind and the snapshot must be left untouched (the next sendTurn
    // clears it anyway). When `rt` is absent (reopened session) the
    // snapshot is empty, so hasPaths can't match.
    const snapshot = getFileSnapshot(sessionId);
    if (rt && restored.length > 0 && snapshot.hasPaths(files.map((f) => f.filePath))) {
      snapshot.clear();
    }
    // Notify the renderer (and any other listeners) so the UI can mark
    // the matching "本轮文件" card as rewound. `targetFiles` (the
    // requested path set, before any failure dropped entries) is ALWAYS
    // forwarded so the renderer can locate the exact card to mark in
    // place — the card stays in the stream as the rewind trace.
    sendToRenderer(IPC.CLAUDE_EVENT, {
      channel: IPC.CLAUDE_EVENT,
      sessionId,
      event: {
        type: "turn.rewound",
        sessionId,
        files: restored,
        targetFiles,
      } satisfies RuntimeEvent,
    });
    return restored;
  }

  /** Resolve an approval request from the renderer. On success, broadcast the
   *  cross-client `request.resolved` sync event so every OTHER client closes
   *  its copy of the approval dialog (the Deferred resolves exactly once). */
  resolveApproval(requestId: string, allow: boolean, reason?: string, always?: boolean): boolean {
    const sessionId = approvalBridge.resolveApproval(requestId, { allow, reason }, always);
    if (!sessionId) return false;
    this.notifyRequestResolved(sessionId, requestId, "approval");
    return true;
  }

  /** Update a session's permission mode mid-turn. The bridge records it and
   *  canUseTool reads the live value on every subsequent tool call, so the
   *  change takes effect immediately for approvals (the SDK's own
   *  `permissionMode` option can't be hot-swapped, but our host-side gate can). */
  setPermissionMode(sessionId: string, mode: PermissionMode): void {
    approvalBridge.setPermissionMode(sessionId, mode);
  }

  /** Resolve a user-input request (AskUserQuestion answer). On success,
   *  broadcasts `request.resolved{kind:"question"}` so other clients close
   *  their copy of the question card. */
  resolveUserInput(requestId: string, answers: UserInputAnswers): boolean {
    const sessionId = approvalBridge.resolveUserInput(requestId, answers);
    if (!sessionId) return false;
    this.notifyRequestResolved(sessionId, requestId, "question");
    return true;
  }

  /** Resolve a pending AskUserQuestion Deferred as DISMISSED (user closed the
   *  question card) so the model's turn continues instead of blocking. Also
   *  broadcasts the cross-client close event. */
  dismissUserInput(requestId: string): boolean {
    const sessionId = approvalBridge.dismissUserInput(requestId);
    if (!sessionId) return false;
    this.notifyRequestResolved(sessionId, requestId, "question");
    return true;
  }

  /** Resolve a plan-approval request (ExitPlanMode approve/reject). On
   *  success, broadcasts `request.resolved{kind:"plan"}` so other clients
   *  close their copy of the plan-approval sheet. */
  resolvePlanApproval(requestId: string, decision: PlanApprovalDecision): boolean {
    const sessionId = approvalBridge.resolvePlanApproval(requestId, decision);
    if (!sessionId) return false;
    this.notifyRequestResolved(sessionId, requestId, "plan");
    return true;
  }

  /** Broadcast a pending-request resolution to every client. Public so the
   *  legacy sentinel question path (which has no Deferred to resolve) can
   *  still tell other clients to close their question cards. */
  notifyRequestResolved(
    sessionId: string,
    requestId: string,
    kind: "approval" | "question" | "plan",
  ): void {
    broadcastRuntimeEvent({ type: "request.resolved", sessionId, requestId, kind });
  }
}

export const runtimeManager = new RuntimeManager();
