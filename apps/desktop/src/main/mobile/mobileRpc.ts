/**
 * mobileRpc — the security whitelist + dispatch for mobile→main RPC calls.
 *
 * The mobile app POSTs `{ method, input }` to `/api/rpc`. Each whitelisted
 * method has a handler here that reuses the exact same lower-level calls the
 * desktop IPC handlers use (repos, runtimeManager, providerRegistry) — so the
 * behavior is identical, only the transport differs (HTTP vs ipcMain).
 *
 * ## Security
 * The whitelist is explicit and minimal. Anything NOT in {@link HANDLERS}
 * returns a 404 — there is no fallthrough. Dangerous operations (file write/
 * delete, terminal, settings mutation, project/session deletion) are simply
 * absent. The per-request {@link DeviceContext} is available to handlers for
 * future audit logging, but authorization is "any paired device may call any
 * whitelisted method" — same trust level as the desktop renderer.
 *
 * Git operations are wired in `mobileGitRpc.ts` (Phase 2) and merged in here.
 */
import {
  StartSessionSchema,
  SendTurnSchema,
  InterruptSchema,
  ApproveSchema,
  RespondQuestionSchema,
  RespondPlanApprovalSchema,
  ProjectSessionsSchema,
  SessionSearchSchema,
  SessionMessagesSchema,
  DEFAULT_PROVIDER_ID,
} from "@contracts/ipc";
import type { PairedDevice, MobileRpcRequest } from "@contracts/mobile";
import { uid } from "@main/utils.js";
import { SessionRepo, ProjectRepo, MessageRepo } from "@main/store/repositories.js";
import { providerRegistry } from "@main/providers/registry.js";
import { runtimeManager } from "@main/claude/RuntimeManager.js";
import type { Session } from "@contracts/session";
import { log } from "@main/lib/logger.js";

/** Identity of the calling device, made available to every handler. */
export interface DeviceContext {
  device: PairedDevice;
}

/** A whitelisted RPC handler. Mirrors the shape of an ipcMain.handle callback
 *  minus the Electron event: validate input, do the work, return JSON-able. */
export type RpcHandler = (input: unknown, ctx: DeviceContext) => unknown | Promise<unknown>;

/** Error thrown to produce a non-200 response with a specific status. */
export class RpcError extends Error {
  constructor(
    message: string,
    /** HTTP-ish status (400 / 403 / 404 / 409 / 500). */
    readonly status: number,
  ) {
    super(message);
  }
}

const HANDLERS: Record<string, RpcHandler> = {
  // ── Reads ───────────────────────────────────────────────────────────────
  "project:list": () => ({ projects: ProjectRepo.list() }),

  "project:sessions": (raw) => {
    const input = ProjectSessionsSchema.parse(raw);
    const archived = input.archived;
    const limit = input.limit ?? (archived ? undefined : 20);
    const offset = input.offset ?? 0;
    const sessions = SessionRepo.listByProject(input.projectId, { limit, offset, archived });
    const total = SessionRepo.countByProject(input.projectId, archived);
    const hasMore = limit !== undefined ? offset + sessions.length < total : false;
    return { sessions, hasMore, total };
  },

  "session:search": (raw) => {
    const input = SessionSearchSchema.parse(raw);
    const sessions = SessionRepo.searchByTitle(input.query, { limit: input.limit });
    return { sessions };
  },

  "session:messages": (raw) => {
    const input = SessionMessagesSchema.parse(raw);
    const res = MessageRepo.listBySession(input.sessionId, {
      limit: input.limit,
      beforeCreatedAt: input.beforeCreatedAt,
      beforeId: input.beforeId,
    });
    return { messages: res.messages, hasMore: res.hasMore };
  },

  "provider:list": () => ({
    providers: providerRegistry.list().map((p) => ({
      id: p.id,
      displayName: p.displayName,
      capabilities: p.capabilities,
    })),
  }),

  "claude:healthCheck": async () => {
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
  },

  // ── Session lifecycle / turns ───────────────────────────────────────────
  "claude:startSession": (raw) => {
    const input = StartSessionSchema.parse(raw);
    const now = Date.now();
    const session: Session = {
      id: uid("sess_"),
      projectId: input.projectId,
      providerId: input.providerId ?? DEFAULT_PROVIDER_ID,
      claudeSessionId: null,
      title: input.title ?? "New session",
      status: "idle",
      model: input.model ?? "default",
      effort: input.effort,
      permissionMode: input.permissionMode,
      customModelId: input.customModelId ?? null,
      archived: false,
      pinnedAt: null,
      contextSnapshot: null,
      todos: null,
      subagents: null,
      planDraft: null,
      turnFiles: null,
      usageHistory: null,
      createdAt: now,
      updatedAt: now,
    };
    SessionRepo.create(session);
    runtimeManager.bindSession(session);
    log.info(`mobile: session started (${session.id}) by ${input.providerId ?? DEFAULT_PROVIDER_ID}`);
    return { session };
  },

  "claude:sendTurn": async (raw, ctx) => {
    const input = SendTurnSchema.parse(raw);
    const session = SessionRepo.get(input.sessionId);
    if (!session) throw new RpcError(`session not found: ${input.sessionId}`, 404);
    const project = ProjectRepo.get(session.projectId);
    if (!project) throw new RpcError(`project not found for session ${input.sessionId}`, 500);

    let updated = session;
    const isFirstMessage = session.title === "New session" && input.prompt.trim().length > 0;
    if (isFirstMessage) {
      const trimmed = input.prompt.trim();
      const title = trimmed.slice(0, 40) + (trimmed.length > 40 ? "…" : "");
      SessionRepo.updateTitle(session.id, title);
      updated = { ...session, title };
    }
    // Apply per-turn overrides (mirrors the desktop IPC handler).
    if (input.model !== undefined) updated = { ...updated, model: input.model };
    if (input.effort !== undefined) updated = { ...updated, effort: input.effort };
    if (input.permissionMode !== undefined) updated = { ...updated, permissionMode: input.permissionMode };
    if (input.customModelId !== undefined) updated = { ...updated, customModelId: input.customModelId };
    if (input.providerId !== undefined) updated = { ...updated, providerId: input.providerId };

    SessionRepo.updateStatus(session.id, "running");
    runtimeManager.bindSession(updated);
    await runtimeManager.sendTurn(updated, {
      prompt: input.prompt,
      cwd: project.path,
      skills: input.skills,
    });
    log.info(`mobile: turn sent (${session.id}) by ${ctx.device.name}`);
    return { session: updated };
  },

  "claude:interrupt": (raw) => {
    const input = InterruptSchema.parse(raw);
    runtimeManager.interrupt(input.sessionId);
    SessionRepo.updateStatus(input.sessionId, "interrupted");
    return { ok: true };
  },

  // ── Async approvals / questions / plan approvals ───────────────────────
  // requestId is the universal coupling key — same Deferred resolves whether
  // the answer comes from the desktop renderer or the phone.
  "claude:approve": (raw) => {
    const input = ApproveSchema.parse(raw);
    const resolved = runtimeManager.resolveApproval(
      input.requestId,
      input.granted,
      input.granted ? undefined : "Denied by user",
      input.always,
    );
    if (!resolved) throw new RpcError(`no pending approval for ${input.requestId}`, 409);
    return { ok: true };
  },

  "claude:respondQuestion": async (raw) => {
    const input = RespondQuestionSchema.parse(raw);
    // Dismissed: user closed the card. Sentinel requests have no Deferred.
    if (input.dismissed) {
      if (input.requestId.startsWith("sentinel_")) return { ok: true };
      runtimeManager.dismissUserInput(input.requestId);
      return { ok: true };
    }
    // Sentinel requestIds (legacy fallback) have no Deferred — answer is
    // injected as a new turn. Mirrors the desktop handler.
    if (input.requestId.startsWith("sentinel_")) {
      const session = SessionRepo.get(input.sessionId);
      if (!session) throw new RpcError(`session not found: ${input.sessionId}`, 404);
      const project = ProjectRepo.get(session.projectId);
      if (!project) throw new RpcError(`project not found for session ${input.sessionId}`, 500);
      const prompt = composeSentinelAnswerPrompt(input.answers);
      if (prompt) {
        SessionRepo.updateStatus(session.id, "running");
        runtimeManager.bindSession(session);
        await runtimeManager.sendTurn(session, { prompt, cwd: project.path });
      }
      return { ok: true };
    }
    const resolved = runtimeManager.resolveUserInput(input.requestId, input.answers);
    if (!resolved) throw new RpcError(`no pending question for ${input.requestId}`, 409);
    return { ok: true };
  },

  "claude:respondPlanApproval": (raw) => {
    const input = RespondPlanApprovalSchema.parse(raw);
    const resolved = runtimeManager.resolvePlanApproval(input.requestId, {
      approved: input.approved,
      editedPlan: input.editedPlan,
      reason: input.reason,
      feedback: input.feedback,
    });
    if (!resolved) throw new RpcError(`no pending plan approval for ${input.requestId}`, 409);
    return { ok: true };
  },
};

/** Register additional handlers (used by Phase 2 git module). */
export function registerMobileRpcHandlers(extra: Record<string, RpcHandler>): void {
  for (const [k, v] of Object.entries(extra)) {
    if (HANDLERS[k]) log.warn(`mobile: duplicate RPC handler override for "${k}"`);
    HANDLERS[k] = v;
  }
}

/** Dispatch a mobile RPC request. Validates the method is whitelisted, runs the
 *  handler, and returns its JSON-able result. Throws {@link RpcError} for
 *  handled failures (not-found, validation, conflict) — the HTTP layer maps
 *  those to status codes. */
export async function dispatchMobileRpc(
  req: MobileRpcRequest,
  ctx: DeviceContext,
): Promise<unknown> {
  const handler = HANDLERS[req.method];
  if (!handler) throw new RpcError(`unknown method: ${req.method}`, 404);
  return handler(req.input, ctx);
}

/** Compose the sentinel-fallback prompt from an AskUserQuestion answer map.
 *  Mirrors the desktop handler's `composeSentinelAnswerPrompt`: the answer
 *  keys already carry the question text, so we just render them as a reply. */
function composeSentinelAnswerPrompt(answers: Record<string, string | string[] | null>): string {
  const lines: string[] = ["(Answers to your previous question:)"];
  for (const [question, answer] of Object.entries(answers)) {
    if (answer == null) continue;
    const value = Array.isArray(answer) ? answer.join(", ") : answer;
    lines.push(`${question}\n→ ${value}`);
  }
  return lines.join("\n\n");
}
