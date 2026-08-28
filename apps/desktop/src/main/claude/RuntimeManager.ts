/**
 * RuntimeManager — per-session turn lifecycle, now provider-agnostic.
 *
 * Replaces the old ClaudeRuntime-based implementation. Instead of `new ClaudeRuntime()`,
 * it resolves a provider from the registry and constructs a ProviderContext that bridges
 * events to the renderer and async approval/user-input requests via ApprovalBridge.
 */
import { sendToRenderer } from "@main/window.js";
import { IPC } from "@contracts/ipc";
import type { RuntimeEvent, PermissionMode, ContextSnapshot, TurnUsageRecord, TurnFileEntry, UserMessageEvent, UpstreamIssueEvent } from "@contracts/runtime";
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
  /** Set at `turn.done` with the turn's endedAt/durationMs; consumed by the
   *  next `token-usage.updated` (the turn-end context snapshot, which the
   *  adapter fires asynchronously OFF the turn's critical path, so it lands
   *  after turn.done) to append the per-turn usage-history record with the
   *  turn's final throughput/cost data. Flushed at the next sendTurn if no
   *  snapshot ever arrives (all-zero usage turn / abort before result). */
  pendingTurnEnd?: { endedAt: number; durationMs: number };
  /** Latest context snapshot emitted by the adapter (tracked from
   *  `token-usage.updated` events). Read at `turn.done` to build the
   *  per-turn usage history entry. */
  lastContextSnapshot?: ContextSnapshot;
  /** Last-known totalTokens per subagent taskId, from the REPLACE rosters in
   *  `subagent.update`. The adapter clamps gateway-noise collapses, so each
   *  agent's value is monotonic — per-turn consumption is the sum of positive
   *  deltas against this map. A background subagent that outlives its
   *  spawning turn accrues later growth to whichever turn is settling then. */
  subagentTokensByTask: Map<string, number>;
  /** Subagent token growth observed since the last usage-history record
   *  settled (i.e. during the current turn). Copied into the record as
   *  `subagentTokens` and reset by settlePendingTurnEnd. */
  turnSubagentTokens: number;
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
  /** Unsubscribe for the bridge status subscription below. The bridge is
   *  SHARED across sessions (one server per config), so its retry statuses
   *  fan out to every subscriber; we attribute them to this session as
   *  `upstream.issue` events (the renderer gates the hint on the session's
   *  running state, so a retry that belongs to another session's request is
   *  harmless noise). Paired with acquire/release above. */
  bridgeStatusUnsubscribe?: () => void;
}

const approvalBridge = new ApprovalBridge();

/** How long the turn.done handler waits before settling a stashed pending
 *  turn-end record with whatever snapshot is known. Must exceed the adapter's
 *  path-B control-channel race (CONTEXT_USAGE_PATH_B_TIMEOUT_MS = 3s) so an
 *  imminent REAL turn-end snapshot settles via the token-usage.updated branch
 *  first; the timer only backfills when no snapshot ever comes. */
const TURN_END_SETTLE_GRACE_MS = 4_000;

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
        // Track the latest snapshot; if a turn just ended, its deferred
        // usage-history record settles now (the adapter fires the turn-end
        // snapshot asynchronously, AFTER turn.done — see pendingTurnEnd).
        const rt = this.sessions.get(session.id);
        if (rt) {
          rt.lastContextSnapshot = e.snapshot;
          this.settlePendingTurnEnd(session.id, rt);
        }
      } else if (e.type === "turn.done") {
        // Persist the per-turn token/cost history. The turn's FINAL snapshot
        // (throughput/cost from result.usage) is published asynchronously by
        // the adapter after turn.done — it must never delay turn.done, as
        // slow gateway control channels used to stall it for tens of seconds.
        // So: stash the timings here, append the record when the turn-end
        // snapshot lands (settlePendingTurnEnd above), and let the next
        // sendTurn flush it with the last-known snapshot if none ever does.
        const rt = this.sessions.get(session.id);
        if (rt && rt.turnStartedAt > 0) {
          rt.pendingTurnEnd = {
            endedAt: Date.now(),
            durationMs: Math.max(0, Date.now() - rt.turnStartedAt),
          };
          // Ordering, as observed in production (usage history silently lost on
          // single-turn sessions): the adapter emits the turn-end snapshot from
          // handleResult BEFORE flushFinal's turn.done, so this stash used to
          // sit forever — the earlier token-usage.updated found nothing pending,
          // and single-turn sessions (side chats) had no next sendTurn to
          // backfill. Two settle paths now cover both orders:
          //  - the snapshot already landed → settle on a short grace timer
          //    (path C publishes synchronously; only a slow path-B control
          //    request lands later, ≤ its 3s race). Waiting the grace out lets
          //    an imminent REAL snapshot win via the branch below instead of
          //    freezing a stale mid-turn path-A value into the record.
          //  - the snapshot truly never arrives → the same timer backfills with
          //    the last-known snapshot rather than dropping the turn entirely.
          setTimeout(() => {
            try {
              this.settlePendingTurnEnd(session.id, rt);
            } catch {
              /* settle already logs its own persistence errors */
            }
          }, TURN_END_SETTLE_GRACE_MS).unref();
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
        // Attribute each agent's token growth to the turn that is currently
        // settling (see subagentTokensByTask). Values are monotonic per agent
        // (adapter-clamped), so positive deltas are the agent's real burn;
        // a decrease never arrives but is defensively ignored anyway.
        const rt = this.sessions.get(session.id);
        if (rt) {
          for (const a of e.agents) {
            const tok = typeof a.totalTokens === "number" && a.totalTokens > 0 ? a.totalTokens : 0;
            const prev = rt.subagentTokensByTask.get(a.taskId) ?? 0;
            if (tok > prev) {
              rt.turnSubagentTokens += tok - prev;
              rt.subagentTokensByTask.set(a.taskId, tok);
            }
          }
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
      subagentTokensByTask: new Map(),
      turnSubagentTokens: 0,
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

  /** Append the deferred per-turn usage-history record (stashed by the
   *  turn.done handler in `pendingTurnEnd`) using the latest context
   *  snapshot. No-op when nothing is pending; skips silently when no
   *  snapshot ever arrived (nothing meaningful to record). */
  private settlePendingTurnEnd(sessionId: string, rt: SessionRuntime): void {
    const pending = rt.pendingTurnEnd;
    if (!pending) return;
    rt.pendingTurnEnd = undefined;
    const snap = rt.lastContextSnapshot;
    // Consume this turn's subagent token growth no matter which settle path
    // fired (snapshot arrival / grace timer / next-turn flush) — even when no
    // snapshot means no record is written, the turn is over and the next
    // turn's growth must start from zero.
    const subagentTokens = rt.turnSubagentTokens;
    rt.turnSubagentTokens = 0;
    if (!snap) return;
    try {
      const record: TurnUsageRecord = {
        endedAt: pending.endedAt,
        durationMs: pending.durationMs,
        totalProcessedTokens: snap.totalProcessedTokens,
        outputTokens: snap.outputTokens,
        cacheReadTokens: snap.cacheReadTokens ?? 0,
        cacheCreationTokens: snap.cacheCreationTokens ?? 0,
        costUsd: snap.costUsd,
        subagentTokens: subagentTokens > 0 ? subagentTokens : undefined,
        usedTokens: snap.usedTokens,
        model: snap.model,
      };
      rt.usageHistory = [...rt.usageHistory, record];
      SessionRepo.updateUsageHistory(sessionId, rt.usageHistory);
      invalidateUsageStats();
    } catch (err) {
      log.error(`failed to persist usage history: ${(err as Error).message}`);
    }
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
       *  at send). Absent for callers that predate the field — no echo.
       *  `editedMessageId`, when set, marks this as an EDIT and lets the other
       *  clients truncate their own stale tail at that message. */
      userMessage?: {
        id: string;
        createdAt: number;
        blocks: unknown[];
        editedMessageId?: string;
      };
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

    // A previous turn that ended without any turn-end snapshot (all-zero
    // usage / abort before result) left its usage-history record pending —
    // flush it with the last-known snapshot before this turn starts.
    this.settlePendingTurnEnd(session.id, rt);

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
    // the selected model id (e.g. "deepseek-v4-pro"); resolveApiConfig
    // validates it against the config's model list (falling back to the first
    // entry if it's been removed). Cleartext lives only in this request
    // object for the duration of the turn.
    let apiConfig: StartTurnRequest["apiConfig"];
    // The model id to pass to the SDK `model` option. For a custom config we
    // deliberately leave this undefined: buildCustomEnv pins
    // ANTHROPIC_MODEL from the selected model (with the `[1m]` suffix when it
    // declares 1M context). The binary reads ANTHROPIC_MODEL as its native
    // model-override channel, so passing --model too would just risk
    // disagreeing with the env var.
    // For the built-in path it's the session's model unless "default".
    let modelForReq: string | undefined = session.model !== "default" ? session.model : undefined;
    if (session.customModelId) {
      const cfg = CustomModelStore.resolveApiConfig(session.customModelId, session.model);
      if (!cfg) {
        log.warn(`sendTurn: custom model ${session.customModelId} not found, token undecryptable, or no model configured; falling back to default endpoint`);
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
            rt.bridgeStatusUnsubscribe?.();
            rt.bridgeStatusUnsubscribe = undefined;
            BridgeRegistry.release(rt.bridgeConfigId);
            rt.bridgeConfigId = undefined;
            rt.bridgeHandle = undefined;
          }
          if (!rt.bridgeConfigId) {
            const handle = await BridgeRegistry.acquire(session.customModelId, cfg);
            rt.bridgeConfigId = session.customModelId;
            rt.bridgeHandle = { localUrl: handle.localUrl };
            // Surface transient upstream-transport retries (connect timeout /
            // reset / refused) to this session's UI. Without it, a 10s+ retry
            // loop mid-turn looks like an unexplained hang — the final failure
            // does reach the user (502 → API-error card), but the WAITING
            // doesn't. kind:"ok" after a successful retry clears the hint.
            rt.bridgeStatusUnsubscribe = handle.onStatus((s) => {
              rt.ctx.emit({
                type: "upstream.issue",
                sessionId: session.id,
                kind: s.kind,
                cause: s.cause,
                attempt: s.attempt,
                attempts: s.attempts,
              } satisfies UpstreamIssueEvent);
            });
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
        // Edit marker: receiving clients truncate their stale tail at this
        // message before appending (see store ingestEvent).
        editedMessageId: input.userMessage.editedMessageId,
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
      rt.bridgeStatusUnsubscribe?.();
      rt.bridgeStatusUnsubscribe = undefined;
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
