/**
 * OpenCode (v2) agent provider — drives the user's own `opencode` CLI (npm
 * `@opencode/cli`) through its client-server surface and implements the
 * AgentProvider contract from @contracts/provider.
 *
 * ## Architecture (vs claude/pi/codex)
 * OpenCode v2 is client-server: this provider keeps ONE private
 * `opencode serve` child alive for the whole app (opencodeServerManager),
 * shares opencode's REAL data dir with the user's terminal CLI (official
 * login is the whole point — no third-party endpoint config exists here),
 * and talks HTTP/SSE via the official `@opencode-ai/sdk` (/v2 exports).
 *
 *   - Sessions: created with `location.directory = cwd`; identity persists
 *     in opencode's own SQLite and rides Mcode's claudeSessionId slot (the
 *     SAME id space the terminal-session reconciler adopts from — see
 *     lib/opencodeSession.ts). Server restarts resume by id, lossless.
 *   - Turn lifecycle: `session.prompt` (fire-and-admit) → fine-grained
 *     `session.next.*` delta events → `session.idle` = turn end. No stdin
 *     settle gating, no per-turn process.
 *   - Approval: the injected server config makes mutating tools ASK;
 *     `permission.v2.asked` events are decided host-side (guards → mode →
 *     always-allow → approval card) and answered with once/reject — see
 *     opencodePermissionBridge. Replies never use "always" (server-side
 *     pattern whitelists would bypass the host guards).
 *   - AskUserQuestion: opencode's native `question.v2.asked` surface maps
 *     onto the host's question card (answers = per-question label arrays).
 *   - Model/effort: model ids "providerID/modelId" (pi/codex shape). Effort
 *     rides ModelRef.variant — Zen models declare reasoning-effort variants
 *     (low/medium/high/xhigh/max) that the composer's effort chip filters
 *     per-model (the store's opencode model map).
 *   - No plan mode: opencode has no injectable EnterPlanMode/ExitPlanMode
 *     tool surface, so the declared mode list is default/acceptEdits/
 *     isolated/bypassPermissions only.
 */
import { spawnSync } from "node:child_process";
import type {
  AgentProvider,
  StartTurnRequest,
  ProviderContext,
  ProviderCapabilities,
  TurnHandle,
} from "@contracts/provider";
import type { ModelRef } from "@opencode-ai/sdk/v2/types";
import { ensureOpenCodeServer, onOpenCodeEvent } from "./opencodeServerManager.js";
import { resolveOpenCodeCliPath } from "./opencodeBinaryResolve.js";
import { collectOpenCodeMcpConfig } from "./opencodeMcp.js";
import { resolveOpenCodeModelContext } from "./opencodeModels.js";
import { OpencodeMessageAdapter } from "./OpencodeMessageAdapter.js";
import {
  handleOpenCodePermissionAsked,
  handleOpenCodeQuestionAsked,
  handleOpenCodeFormCreated,
  type OpenCodeBridgeDeps,
} from "./opencodePermissionBridge.js";
import { getFileSnapshot } from "@main/lib/fileSnapshotRegistry.js";

/** Mcode's 4-mode surface minus plan (no plan-tool injection point on
 *  opencode). Semantics are enforced host-side by the permission bridge —
 *  opencode itself only ever sees "ask". */
const OPENCODE_PERMISSION_MODES = [
  { value: "default", label: "Default", icon: "shield", hint: "标准行为,工具按规则触发审批" },
  { value: "acceptEdits", label: "Edit Auto", icon: "shieldCheck", color: "text-warning", hint: "项目内的文件编辑自动放行" },
  { value: "isolated", label: "Isolated", icon: "lock", color: "text-success", hint: "项目隔离:读写与文件操作仅限当前项目目录" },
  { value: "bypassPermissions", label: "Bypass", icon: "shieldLock", color: "text-danger", hint: "跳过所有权限检查(慎用)" },
];

/** Effort surface = the reasoning-effort variants Zen models declare
 *  (verified live on 2.1.1: low/medium/high/xhigh/max). Per-model filtering
 *  happens renderer-side against the model's variant list (models without
 *  variants hide the chip); "default" = don't send a variant. */
const OPENCODE_EFFORT_LEVELS = [
  { value: "default", label: "Default", hint: "不显式指定,由模型使用自身默认档位" },
  { value: "low", label: "Low", hint: "更快响应、较轻推理" },
  { value: "medium", label: "Medium", hint: "推理深度与时延平衡" },
  { value: "high", label: "High", hint: "更深推理" },
  { value: "xhigh", label: "XHigh", hint: "超高推理深度" },
  { value: "max", label: "Max", hint: "最大推理深度" },
];

/** Parse "providerID/modelId" (pi/codex shape). Returns null for
 *  "default"/absent — the server then picks its configured default. */
export function parseOpenCodeModelId(
  model: string | undefined,
): { providerID: string; id: string } | null {
  if (!model || model === "default") return null;
  const slash = model.indexOf("/");
  if (slash <= 0 || slash >= model.length - 1) return null;
  return { providerID: model.slice(0, slash), id: model.slice(slash + 1) };
}

export class OpencodeProvider implements AgentProvider {
  readonly id = "opencode-sdk";
  readonly displayName = "OpenCode";
  readonly capabilities: ProviderCapabilities = {
    supportsApproval: true, // permission.v2.asked bridge
    supportsResume: true, // db-backed sessions resume by id
    supportsStreaming: true, // session.next.text/reasoning.delta
    supportsMcp: true, // config injection (server fingerprint restart)
    supportsAskUserQuestion: true, // question.v2.asked bridge
    thinkingLevels: OPENCODE_EFFORT_LEVELS,
    permissionModes: OPENCODE_PERMISSION_MODES,
    builtinModels: [], // dynamic: /api/model after login (Zen free models need no login)
    supportsCustomEndpoint: false, // official login only — by design
  };

  async startTurn(req: StartTurnRequest, ctx: ProviderContext): Promise<TurnHandle> {
    const ac = new AbortController();

    /* ── 1. Server (respawns if dead; fails the turn when no CLI) ── */
    const cliPath = resolveOpenCodeCliPath();
    if (!cliPath) {
      return failTurn(
        ctx,
        req.sessionId,
        "OPENCODE_CLI_MISSING",
        "未找到 OpenCode CLI:请先安装 v2(npm install -g @opencode/cli),或到 设置 → 模型配置 → OpenCode 查看引导。",
      );
    }
    let server;
    try {
      // MCP bridge: Mcode's MCP config rides OPENCODE_CONFIG_CONTENT (part of
      // the server fingerprint — settings edits restart the server cleanly).
      const mcp = await collectOpenCodeMcpConfig(req.cwd);
      server = await ensureOpenCodeServer(mcp);
    } catch (err) {
      return failTurn(ctx, req.sessionId, "OPENCODE_SERVER_START", `OpenCode server 启动失败:${(err as Error).message}`);
    }
    const client = server.client;

    /* ── 2. Session identity: resume the persisted id or create ── */
    let opencodeSessionId = req.resumeProviderSessionId ?? null;
    let existingSession: Record<string, unknown> | null = null;
    if (opencodeSessionId) {
      try {
        const getRes = await client.v2.session.get({ sessionID: opencodeSessionId });
        const record = getRes as { data?: unknown };
        existingSession = (record?.data && typeof record.data === "object" ? record.data : getRes) as Record<string, unknown>;
        if (existingSession && typeof existingSession["data"] === "object") {
          existingSession = existingSession["data"] as Record<string, unknown>;
        }
      } catch {
        ctx.log.warn(`opencode: session ${opencodeSessionId} not found, starting a new one`);
        opencodeSessionId = null;
      }
    }
    const modelRef = this.resolveModelRef(req);
    if (!opencodeSessionId) {
      try {
        const created = await client.v2.session.create({
          ...(modelRef ? { model: modelRef } : {}),
          location: { directory: req.cwd },
        });
        // v2 wraps payloads in a {data: …} envelope (hey-api's `.data` is
        // the envelope body — see unwrapV2Envelope in opencodeModels).
        opencodeSessionId =
          ((created as { data?: { data?: { id?: string }; id?: string } }).data?.data ??
            (created as { data?: { id?: string } }).data)?.id ?? null;
      } catch (err) {
        return failTurn(ctx, req.sessionId, "OPENCODE_SESSION_CREATE", `OpenCode 会话创建失败:${(err as Error).message}`);
      }
    } else if (modelRef) {
      // Session resumed, but model or variant might have changed in Mcode's composer!
      // Synchronize the new model selection to the OpenCode session so subsequent prompt turns
      // execute against the user's chosen model rather than remaining stuck on the initial one.
      const cur = existingSession?.["model"] as ModelRef | undefined;
      const modelChanged =
        !cur ||
        cur.id !== modelRef.id ||
        cur.providerID !== modelRef.providerID ||
        (cur.variant ?? "default") !== (modelRef.variant ?? "default");

      if (modelChanged) {
        try {
          ctx.log.info(
            `opencode: switching session ${opencodeSessionId} model from ${cur?.providerID}/${cur?.id}@${cur?.variant ?? "default"} to ${modelRef.providerID}/${modelRef.id}@${modelRef.variant ?? "default"}`
          );
          const switchRes = await server.fetch(`/api/session/${opencodeSessionId}/model`, {
            method: "POST",
            body: JSON.stringify({ model: modelRef }),
          });
          if (!switchRes.ok && switchRes.status !== 204) {
            ctx.log.warn(`opencode: switchModel HTTP ${switchRes.status}: ${(await switchRes.text()).slice(0, 200)}`);
          }
        } catch (err) {
          ctx.log.warn(`opencode: switchModel failed: ${(err as Error).message}`);
        }
      }
    }
    if (!opencodeSessionId) {
      return failTurn(ctx, req.sessionId, "OPENCODE_SESSION_CREATE", "OpenCode 会话创建未返回 id");
    }
    ctx.onProviderSessionId?.(opencodeSessionId);

    /* ── 3. Adapter + bridges on the global event bus ── */
    const contextWindow = await resolveOpenCodeModelContext(req.model, req.cwd);
    const adapter = new OpencodeMessageAdapter({
      ctx,
      sessionId: req.sessionId,
      opencodeSessionId,
      cwd: req.cwd,
      contextWindow,
      model: req.model && req.model !== "default" ? req.model : undefined,
      snapshot: getFileSnapshot(req.sessionId),
      abortSignal: ac.signal,
    });
    const bridgeDeps: OpenCodeBridgeDeps = {
      ctx,
      sessionId: req.sessionId,
      cwd: req.cwd,
      fetchRaw: server.fetch,
      getToolCall: (callID) => adapter.getToolCall(callID),
      noteToolName: (callID, toolName) => adapter.noteToolName(callID, toolName),
    };
    const offEvents = onOpenCodeEvent((ev) => {
      const type = (ev as { type?: unknown }).type as string | undefined;
      switch (type) {
        // CLI 2.1.1 says "permission.asked" (verified live); the SDK type
        // still names it permission.v2.asked — accept both spellings.
        case "permission.asked":
        case "permission.v2.asked":
          if (adapter.hasTurnEnded) return;
          void handleOpenCodePermissionAsked(
            ev as unknown as Parameters<typeof handleOpenCodePermissionAsked>[0],
            bridgeDeps,
          );
          return;
        case "question.asked":
        case "question.v2.asked":
          if (adapter.hasTurnEnded) return;
          void handleOpenCodeQuestionAsked(
            ev as unknown as Parameters<typeof handleOpenCodeQuestionAsked>[0],
            bridgeDeps,
          );
          return;
        case "form.created":
          if (adapter.hasTurnEnded) return;
          void handleOpenCodeFormCreated(
            ev as unknown as Parameters<typeof handleOpenCodeFormCreated>[0],
            bridgeDeps,
          );
          return;
        default:
          adapter.dispatch(ev);
          return;
      }
    });

    let finished = false;
    const done = (async () => {
      try {
        /* ── 4. Prompt (fire-and-admit; the event bus drives the turn).
         *  RAW FETCH, not the SDK method: CLI 2.1.1 takes a FLAT body
         *  ({text, files?…}) — SDK 1.19.3 still sends {prompt:{text}} which
         *  the server rejects with 400 "Missing key at [\"text\"]" (verified
         *  live; this was the original infinite-loading cause #2). */
        const promptBody: Record<string, unknown> = {
          text: req.prompt,
          ...(req.images?.length
            ? {
                files: req.images.map((img, i) => ({
                  uri: `data:${img.mimeType};base64,${img.data}`,
                  name: `image-${i + 1}`,
                })),
              }
            : {}),
        };
        const promptRes = await server.fetch(`/api/session/${opencodeSessionId}/prompt`, {
          method: "POST",
          body: JSON.stringify(promptBody),
        });
        if (!promptRes.ok && promptRes.status !== 204) {
          throw new Error(`prompt ${promptRes.status}: ${(await promptRes.text()).slice(0, 200)}`);
        }

        const abortedPromise = new Promise<"interrupted">((resolve) => {
          if (ac.signal.aborted) resolve("interrupted");
          else ac.signal.addEventListener("abort", () => resolve("interrupted"), { once: true });
        });
        const reason = await Promise.race([adapter.waitTurnDone(), abortedPromise]);

        if (reason === "interrupted") {
          try {
            await client.v2.session.interrupt({ sessionID: opencodeSessionId! });
          } catch {
            /* session may have completed concurrently */
          }
          // Grace for the terminal idle to arrive on its own.
          await Promise.race([
            adapter.waitTurnDone(),
            new Promise((r) => setTimeout(r, 2000)),
          ]);
          if (!adapter.hasTurnEnded) adapter.finalizeAborted();
        }
        await adapter.flushFinal();
      } catch (err) {
        if (ac.signal.aborted) {
          if (!adapter.hasTurnEnded) adapter.finalizeAborted();
          await adapter.flushFinal();
        } else {
          ctx.log.error(`opencode turn failed: ${(err as Error).message}`);
          if (!adapter.hasTurnEnded) adapter.finalizeError((err as Error).message);
          await adapter.flushFinal();
        }
      } finally {
        offEvents();
        finished = true;
      }
    })();

    return {
      done,
      interrupt: () => {
        ac.abort();
      },
      isRunning: () => !finished && !ac.signal.aborted,
    };
  }

  /** Model + effort (variant) resolution for session.create. Effort values
   *  ARE variant ids on Zen models; the renderer only offers variants the
   *  selected model declares, so a straight pass-through is safe — an
   *  off-list value (stale persisted slot) is dropped, never sent. */
  private resolveModelRef(req: StartTurnRequest): ModelRef | null {
    const parsed = parseOpenCodeModelId(req.model);
    if (!parsed) return null;
    const variant =
      req.effort && req.effort !== "default" && req.effort !== "auto" ? req.effort : undefined;
    return { providerID: parsed.providerID, id: parsed.id, ...(variant ? { variant } : {}) };
  }

  /** Version probe for the settings UI (same shape as codex's). */
  async healthCheck(): Promise<{ ok: boolean; version?: string; error?: string }> {
    try {
      const p = resolveOpenCodeCliPath();
      if (!p) return { ok: false, error: "未找到 OpenCode CLI(可经 npm 安装 @opencode/cli)" };
      const r = spawnSync(p, ["--version"], { timeout: 10_000, encoding: "utf-8" });
      if (r.error) return { ok: false, error: r.error.message };
      const version = (r.stdout ?? "").trim().split("\n")[0] || undefined;
      return { ok: r.status === 0 || Boolean(version), version };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
}

/** Emit an error + error-reason turn.done and return a dead handle. */
function failTurn(
  ctx: ProviderContext,
  sessionId: string,
  code: string,
  message: string,
): TurnHandle {
  ctx.log.error(`opencode: ${message}`);
  ctx.emit({ type: "error", sessionId, message, code });
  ctx.emit({ type: "turn.done", sessionId, reason: "error" });
  return { done: Promise.resolve(), interrupt: () => {}, isRunning: () => false };
}

export const OPENCODE_PROVIDER_ID = "opencode-sdk";
