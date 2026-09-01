import type { IpcMain } from "electron";
import {
  IPC,
  StartSessionSchema,
  ListSideChatsSchema,
  SendTurnSchema,
  InterruptSchema,
  ApproveSchema,
  RespondQuestionSchema,
  RespondPlanApprovalSchema,
  RewindTurnSchema,
  UpdateSessionSettingsSchema,
  SessionMessagesSchema,
  SaveMessagesSchema,
  UpsertMessagesSchema,
  TruncateAndInsertMessagesSchema,
  GetSettingSchema,
  SetSettingSchema,
  GetManySettingsSchema,
} from "@contracts/ipc";
import type {
  SaveMessagesInput,
  UpsertMessagesInput,
  TruncateAndInsertMessagesInput,
} from "@contracts/ipc";
import type { UserInputAnswers } from "@contracts/provider";
import { SessionRepo, ProjectRepo, MessageRepo, SettingRepo } from "@main/store/repositories.js";
import { runtimeManager } from "@main/claude/RuntimeManager.js";
import { providerRegistry } from "@main/providers/registry.js";
import { log } from "@main/lib/logger.js";
import { broadcastSessionChanged } from "@main/lib/sessionSync.js";
import { createOrReuseSession } from "@main/lib/sessionStart.js";
import { generateSessionTitle } from "@main/ipc/titleGen.js";
import { createDetachedWorktree, nextWorktreeDir } from "@main/lib/worktreeOps.js";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Project, Session } from "@contracts/session";

/** Resolve the working directory a session's turn must run in.
 *
 *  - local session → the project root (unchanged historical behavior);
 *  - worktree session, not yet materialized → create the detached worktree
 *    NOW (intent-first, materialize-on-first-turn), persist its path BEFORE
 *    the turn is dispatched (a crash between creation and turn-start still
 *    leaves the session pointing at its worktree), and return it;
 *  - materialized worktree session → its recorded path (restart-safe),
 *    with a friendly error when the directory has since disappeared.
 *
 *  Every downstream mechanism (write guard, bash guard, MCP injection,
 *  file snapshot) keys off this cwd, so isolation between parallel worktree
 *  sessions — and from the local checkout — rides on this single value. */
async function resolveSessionCwd(session: Session, project: Project): Promise<string> {
  if (session.envMode !== "worktree") return project.path;

  if (!session.worktreePath) {
    // Materialize. The project root itself must be a git repo (the base is
    // HEAD as seen from the user's checkout).
    const hasGit = await stat(join(project.path, ".git"))
      .then(() => true)
      .catch(() => false);
    if (!hasGit) {
      throw new Error("当前项目根目录不是 Git 仓库,无法创建工作树会话");
    }
    const target = await nextWorktreeDir(project.path, session.id);
    const res = await createDetachedWorktree(project.path, target);
    if (!res.ok) {
      throw new Error(`创建隔离工作树失败:${res.error}`);
    }
    SessionRepo.updateWorktreePath(session.id, target);
    // Re-read so the broadcast + the returned session snapshot both carry
    // the materialized path (renderer flips its badge off this).
    const updatedRow = SessionRepo.get(session.id) ?? session;
    broadcastSessionChanged(updatedRow);
    log.info(`worktree session materialized: ${session.id} -> ${target}`);
    return target;
  }

  // Already materialized: verify the directory still exists.
  const exists = await stat(session.worktreePath).then(() => true).catch(() => false);
  if (!exists) {
    throw new Error(
      `会话的工作树目录已不存在:${session.worktreePath}(可能被手动删除)。请在 Git 面板清理后新建会话。`,
    );
  }
  return session.worktreePath;
}

export function registerClaudeHandlers(ipcMain: IpcMain): void {
  // ── health check: is the default provider's binary functional? ──
  ipcMain.handle("claude:healthCheck", async () => {
    const provider = providerRegistry.default;
    if (provider.healthCheck) {
      const result = await provider.healthCheck();
      return {
        installed: result.ok,
        source: result.ok ? `Agent SDK v${result.version ?? "?"}` : null,
        command: result.error ?? null,
      };
    }
    return { installed: true, source: "Agent SDK", command: null };
  });

  ipcMain.handle(IPC.CLAUDE_START_SESSION, (_evt, raw) => {
    const input = StartSessionSchema.parse(raw);
    // Reuses the project's still-fresh "New session" row when one exists —
    // only creates a new row otherwise (see createOrReuseSession).
    const { session } = createOrReuseSession(input, "desktop");
    return { session };
  });

  // Hydrate the right-panel ask tab's list view: a main session's side
  // chats, newest first. Read-only, no schema beyond the parent id.
  ipcMain.handle(IPC.CLAUDE_LIST_SIDE_CHATS, (_evt, raw) => {
    const input = ListSideChatsSchema.parse(raw);
    return { sessions: SessionRepo.listSideByParent(input.parentSessionId) };
  });

  ipcMain.handle(IPC.CLAUDE_SEND_TURN, async (_evt, raw) => {
    const input = SendTurnSchema.parse(raw);
    const session = SessionRepo.get(input.sessionId);
    if (!session) throw new Error(`session not found: ${input.sessionId}`);
    const project = ProjectRepo.get(session.projectId);
    if (!project) throw new Error(`project not found for session ${input.sessionId}`);

	    // Auto-title from the first user message, if the title is still the default.
	    // Side chats rewrite their own "Quick ask" placeholder (same 40-char
	    // truncation) but DON'T broadcast the change — they're invisible to the
	    // left-bar/mobile lists by design; the ask tab patches its own list
	    // from this handler's return value instead.
	    let updated = session;
	    const titlePlaceholder = session.kind === "side" ? "Quick ask" : "New session";
	    const isFirstMessage = session.title === titlePlaceholder && input.prompt.trim().length > 0;
	    if (isFirstMessage) {
      const title = input.prompt.trim().slice(0, 40) + (input.prompt.trim().length > 40 ? "…" : "");
      SessionRepo.updateTitle(session.id, title);
      updated = { ...session, title };
      if (session.kind !== "side") {
	      // Keep connected mobile clients' session lists in sync.
	      broadcastSessionChanged(updated);
      }
	    }
	    // Apply per-turn overrides from the renderer's current UI state. The
	    // renderer persists model/effort/permissionMode/customModelId to the
	    // session row via fire-and-forget `updateSettings` calls, so the row
	    // may be stale by the time sendTurn reads it. Patching the in-memory
	    // session with the explicit overrides eliminates this race: if the UI
	    // sends a value, it wins over whatever the DB happens to hold.
	    if (input.model !== undefined) {
	      updated = { ...updated, model: input.model };
	    }
	    if (input.effort !== undefined) {
	      updated = { ...updated, effort: input.effort };
	    }
	    if (input.permissionMode !== undefined) {
	      updated = { ...updated, permissionMode: input.permissionMode };
	    }
    if (input.customModelId !== undefined) {
      updated = { ...updated, customModelId: input.customModelId };
    }
    if (input.providerId !== undefined) {
      // Per-turn provider override. Does NOT persist to the DB — the
      // session's authoritative providerId stays as-is so the per-session
      // "lock after first message" rule still holds. We only patch the
      // in-memory snapshot RuntimeManager uses to resolve the backend.
      updated = { ...updated, providerId: input.providerId };
    }

    SessionRepo.updateStatus(session.id, "running");
    // Resolve the turn's cwd (worktree materialization happens here — before
    // bindSession so the runtime sees the final environment). Throws surface
    // as an IPC rejection the renderer toasts; re-sending retries cleanly
    // (the path is id-derived, so a retry never creates a second worktree).
    const cwd = await resolveSessionCwd(updated, project);
    // Materialization may have backfilled worktreePath — refresh the
    // snapshot so the returned session (and the renderer's badge) carries it.
    if (updated.envMode === "worktree" && !updated.worktreePath) {
      updated = SessionRepo.get(session.id) ?? updated;
    }
    runtimeManager.bindSession(updated);
    await runtimeManager.sendTurn(updated, {
      prompt: input.prompt,
      cwd,
      skills: input.skills,
      images: input.images,
      // User-message echo payload from the renderer (cross-client bubble).
      userMessage: input.userMessage,
    });
    // Background auto-title generation: on the first user message, fire a
    // one-shot LLM call to produce a short Chinese title and overwrite the
    // placeholder. Fire-and-forget - never blocks the turn, and if the feature
    // is disabled (or fails) the placeholder title above already covers the
    // UI. See titleGen.ts for the full rationale.
    // Background auto-title generation: on the first user message, fire a
    // one-shot LLM call to produce a short Chinese title and overwrite the
    // placeholder. Runs for main sessions AND side chats (both rewrite their
    // own placeholder above; the truncated text is the fallback when the
    // feature is off or fails). Fire-and-forget - never blocks the turn. See
    // titleGen.ts for the full rationale.
    if (isFirstMessage) {
      void generateSessionTitle(updated, input.prompt).catch((err) =>
        log.warn(`title generation failed for ${session.id}: ${(err as Error).message}`),
      );
    }
    // Return the in-memory `updated` snapshot (it already carries every
    // per-turn override above — including providerId). Re-reading from the DB
    // here would hand back a stale providerId (the per-turn provider override
    // is intentionally NOT persisted), which the renderer then uses to
    // replace its cached session row and flip the thread icon to the wrong
    // SDK. updated has title/model/effort/permissionMode/customModelId/
    // providerId patched in; the DB-only `status` flip is surfaced via the
    // event stream, so it doesn't need to ride this return value.
    return { session: updated };
  });

  ipcMain.handle(IPC.CLAUDE_INTERRUPT, async (_evt, raw) => {
    const input = InterruptSchema.parse(raw);
    runtimeManager.interrupt(input.sessionId);
    SessionRepo.updateStatus(input.sessionId, "interrupted");
  });

  ipcMain.handle(IPC.CLAUDE_APPROVE, async (_evt, raw) => {
    const input = ApproveSchema.parse(raw);
    const resolved = runtimeManager.resolveApproval(
      input.requestId,
      input.granted,
      input.granted ? undefined : "Denied by user",
      input.always,
    );
    if (!resolved) {
      log.warn(`approval: no pending request for id ${input.requestId}`);
    }
  });

  // ── AskUserQuestion answer: resolve the provider's pending user-input
  //    Deferred. The provider's canUseTool await resumes and the turn
  //    continues in the SAME query() — this is what makes the conversation
  //    proceed after the user submits answers.
  //    For `sentinel_`-prefixed ids (fallback path when the native tool is
  //    unavailable), there's no Deferred to resolve — the turn already ended
  //    when the model finished emitting. We compose the answers into a prompt
  //    and start a new turn, prepended with a hint so the model recognizes it
  //    as the answer to its prior question.
  ipcMain.handle(IPC.CLAUDE_RESPOND_QUESTION, async (_evt, raw) => {
    const input = RespondQuestionSchema.parse(raw);

    // Dismissed: the user closed the question card. Sentinel requests have no
    // Deferred (the turn already ended) — nothing to resume; still broadcast
    // the cross-client close so other clients drop their copy of the card.
    if (input.dismissed) {
      if (input.requestId.startsWith("sentinel_")) {
        runtimeManager.notifyRequestResolved(input.sessionId, input.requestId, "question");
        return;
      }
      const resolved = runtimeManager.dismissUserInput(input.requestId);
      if (!resolved) {
        log.warn(`respondQuestion(dismiss): no pending request for id ${input.requestId}`);
      }
      return;
    }

    if (input.requestId.startsWith("sentinel_")) {
      // No Deferred exists — tell every other client to close their copy of
      // the question card (this answer was accepted from one client only).
      runtimeManager.notifyRequestResolved(input.sessionId, input.requestId, "question");
      const session = SessionRepo.get(input.sessionId);
      if (!session) {
        log.warn(`respondQuestion(sentinel): session not found ${input.sessionId}`);
        return;
      }
      const project = ProjectRepo.get(session.projectId);
      if (!project) {
        log.warn(`respondQuestion(sentinel): project not found for session ${input.sessionId}`);
        return;
      }
      const prompt = composeSentinelAnswerPrompt(input.answers);
      SessionRepo.updateStatus(session.id, "running");
      runtimeManager.bindSession(session);
      // Worktree sessions are always materialized by the time a sentinel
      // follow-up exists (the first turn created it) — route the cwd the
      // same way sendTurn does so the answer lands in the right checkout.
      await runtimeManager.sendTurn(session, {
        prompt,
        cwd: session.worktreePath ?? project.path,
      });
      return;
    }

    const resolved = runtimeManager.resolveUserInput(input.requestId, input.answers);
    if (!resolved) {
      log.warn(`respondQuestion: no pending request for id ${input.requestId}`);
    }
  });

  // ── ExitPlanMode plan-approval decision: resolve the provider's pending
  //    plan-approval Deferred. The provider's canUseTool await resumes and
  //    returns allow (exit plan mode) or deny (stay in plan mode) to the SDK,
  //    continuing the SAME query() turn.
  ipcMain.handle(IPC.CLAUDE_RESPOND_PLAN_APPROVAL, async (_evt, raw) => {
    const input = RespondPlanApprovalSchema.parse(raw);
    const resolved = runtimeManager.resolvePlanApproval(input.requestId, {
      approved: input.approved,
      editedPlan: input.editedPlan,
      reason: input.reason,
      feedback: input.feedback,
    });
    if (!resolved) {
      log.warn(`respondPlanApproval: no pending request for id ${input.requestId}`);
    }
  });

  // ── Rewind a turn: restore the given files to their pre-turn state.
  //    The renderer passes the explicit entries (the card's own frozen
  //    list), so this works for the latest turn, any historical turn,
  //    and a session reopened after restart alike. Returns the list of
  //    paths that were actually restored so the renderer can show a
  //    "N 个文件已恢复" breadcrumb. ──
  ipcMain.handle(IPC.CLAUDE_REWIND_TURN, async (_evt, raw) => {
    const input = RewindTurnSchema.parse(raw);
    const restored = await runtimeManager.rewindTurn(
      input.sessionId,
      input.files,
      input.targetFiles,
    );
    return { restored };
  });

  // ── Provider listing ──
  ipcMain.handle(IPC.PROVIDER_LIST, () => {
    const providers = providerRegistry.list().map((p) => ({
      id: p.id,
      displayName: p.displayName,
      capabilities: p.capabilities,
    }));
    return { providers };
  });

  // ── P2: message persistence ──
  ipcMain.handle(IPC.SESSION_SAVE_MESSAGES, (_evt, raw) => {
    const input = SaveMessagesSchema.parse(raw) as SaveMessagesInput;
    MessageRepo.replaceAll(input.sessionId, input.messages);
  });

  ipcMain.handle(IPC.SESSION_UPSERT_MESSAGES, (_evt, raw) => {
    const input = UpsertMessagesSchema.parse(raw) as UpsertMessagesInput;
    MessageRepo.upsertMany(input.messages);
  });

  ipcMain.handle(IPC.SESSION_TRUNCATE_AND_INSERT_MESSAGES, (_evt, raw) => {
    const input = TruncateAndInsertMessagesSchema.parse(raw) as TruncateAndInsertMessagesInput;
    MessageRepo.truncateFromAndInsert(
      input.sessionId,
      { createdAt: input.cursorCreatedAt, id: input.cursorId },
      input.messages,
    );
  });

  ipcMain.handle(IPC.SESSION_MESSAGES, (_evt, raw) => {
    const input = SessionMessagesSchema.parse(raw);
    const res = MessageRepo.listBySession(input.sessionId, {
      limit: input.limit,
      beforeCreatedAt: input.beforeCreatedAt,
      beforeId: input.beforeId,
    });
    return { messages: res.messages, hasMore: res.hasMore };
  });

  // ── Settings ──
  ipcMain.handle(IPC.SETTING_GET, (_evt, raw) => {
    const input = GetSettingSchema.parse(raw);
    return { value: SettingRepo.get(input.key) };
  });

  ipcMain.handle(IPC.SETTING_SET, (_evt, raw) => {
    const input = SetSettingSchema.parse(raw);
    SettingRepo.set(input.key, input.value);
  });

  ipcMain.handle(IPC.SETTING_GET_MANY, (_evt, raw) => {
    const input = GetManySettingsSchema.parse(raw);
    return SettingRepo.getMany(input.keys);
  });

  // ── Per-session settings (model / effort / permissionMode / customModelId) ──
  // Persist to DB AND, when permissionMode is present, sync the live value
  // into the ApprovalBridge so a mid-turn mode flip takes effect for the
  // next tool call (canUseTool reads the bridge's current value).
  ipcMain.handle(IPC.SESSION_UPDATE_SETTINGS, (_evt, raw) => {
    const input = UpdateSessionSettingsSchema.parse(raw);
    SessionRepo.updateSettings(input.sessionId, {
      model: input.model,
      effort: input.effort,
      permissionMode: input.permissionMode,
      customModelId: input.customModelId,
      providerId: input.providerId,
      envMode: input.envMode,
    });
    if (input.permissionMode) {
      runtimeManager.setPermissionMode(input.sessionId, input.permissionMode);
    }
    // Broadcast the fresh row so every other client (phones) re-syncs its
    // session list AND its composer chips for this thread.
    const updated = SessionRepo.get(input.sessionId);
    if (updated) broadcastSessionChanged(updated);
  });
}

/**
 * Compose the user's answers (from sentinel-fallback AskUserQuestion) into a
 * prompt for the next turn. The sentinel path can't block the SDK turn, so we
 * send answers as a new user message prefixed with a hint so the model knows
 * these are answers to its prior question, not a fresh instruction.
 */
function composeSentinelAnswerPrompt(answers: UserInputAnswers): string {
  const lines: string[] = ["(Answers to your previous question:)"];
  for (const [question, answer] of Object.entries(answers)) {
    if (answer == null) continue;
    const value = Array.isArray(answer) ? answer.join(", ") : answer;
    lines.push(`${question}\n→ ${value}`);
  }
  return lines.join("\n\n");
}
