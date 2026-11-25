/**
 * Antigravity ACP provider — drives the user's local `agy` CLI (`agy acp`)
 * over JSON-RPC 2.0 stdio and implements the AgentProvider contract.
 *
 * Architecture:
 *   - Discovers `agy` via `antigravityExecutable.ts` (`which` → `%LOCALAPPDATA%\agy\bin`)
 *     and enforces `MIN_ANTIGRAVITY_CLI_VERSION` (`1.5.5`).
 *   - Keeps one `AcpTransport` alive per GUI session when `cwd` and
 *     `bypassPermissions` match, falling back to `session/resume` / `session/new`
 *     if the child restarts or settings change.
 *   - Translates ACP notifications & incoming requests (`session/request_permission`,
 *     `elicitation/create`) into Mcode's `RuntimeEvent`s via `AntigravityMessageAdapter`.
 */
import type {
  AgentProvider,
  ProviderCapabilities,
  ProviderContext,
  StartTurnRequest,
  TurnHandle,
} from "@contracts/provider";
import type { TurnDoneReason } from "@contracts/runtime";
import {
  AntigravityCliUnavailableError,
  assertAntigravityCliUsable,
  probeAntigravityCliVersion,
  resolveAntigravityExecutable,
} from "@main/lib/antigravityExecutable.js";
import { getCustomPromptSetting } from "@main/lib/customPrompt.js";
import { getFileSnapshot } from "@main/lib/fileSnapshotRegistry.js";
import { killProcessTree } from "@main/lib/procTree.js";
import {
  ACP_PROTOCOL_VERSION,
  AcpAbortedError,
  AcpAuthRequiredError,
  AcpInitializeResponseSchema,
  AcpPromptResponseSchema,
  AcpRpcError,
  AcpSessionResponseSchema,
  extractAcpErrorText,
  type AcpInitializeResponse,
  type AcpPromptContentBlock,
} from "./acpProtocol.js";
import { AcpTransport } from "./acpTransport.js";
import { AntigravityMessageAdapter } from "./AntigravityMessageAdapter.js";
import {
  getCachedAntigravityCatalog,
  resolveAntigravityWireModel,
} from "./antigravityModels.js";

export const ANTIGRAVITY_PROVIDER_ID = "antigravity-acp";

const ANTIGRAVITY_PERMISSION_MODES = [
  { value: "default", label: "Default", icon: "shield", hint: "标准行为，工具按规则触发审批" },
  { value: "acceptEdits", label: "Edit Auto", icon: "shieldCheck", color: "text-warning", hint: "项目内的文件编辑自动放行" },
  { value: "isolated", label: "Isolated", icon: "lock", color: "text-success", hint: "项目隔离：读写与文件操作仅限当前项目目录" },
  { value: "bypassPermissions", label: "Bypass", icon: "shieldLock", color: "text-danger", hint: "跳过所有工具审批（慎用）" },
];

const ANTIGRAVITY_EFFORT_LEVELS = [
  { value: "default", label: "Default", hint: "由模型使用默认推理档位" },
  { value: "minimal", label: "Minimal", hint: "极速响应" },
  { value: "low", label: "Low", hint: "更快响应、较轻推理" },
  { value: "medium", label: "Medium", hint: "推理深度与时延平衡" },
  { value: "high", label: "High", hint: "更深推理" },
  { value: "xhigh", label: "XHigh", hint: "超高推理深度" },
  { value: "max", label: "Max", hint: "最大推理深度" },
];

interface LiveAcpHost {
  transport: AcpTransport;
  fingerprint: string;
  initialized: AcpInitializeResponse;
  acpSessionId: string;
  currentModel?: string;
  activeAdapter: AntigravityMessageAdapter | null;
}

function buildErrorTurn(
  ctx: ProviderContext,
  sessionId: string,
  code: string,
  message: string,
): TurnHandle {
  ctx.log.error(`antigravity-acp: ${message}`);
  ctx.emit({ type: "error", sessionId, message, code });
  ctx.emit({ type: "turn.done", sessionId, reason: "error" });
  return { done: Promise.resolve(), interrupt: () => {}, isRunning: () => false };
}

function supportsSystemPromptAppend(init: AcpInitializeResponse): boolean {
  const meta = init.agentCapabilities?._meta;
  if (!meta || typeof meta !== "object") return false;
  const agy = (meta as Record<string, unknown>)["antigravity"];
  if (!agy || typeof agy !== "object") return false;
  const sp = (agy as Record<string, unknown>)["systemPrompt"];
  return Boolean(sp && typeof sp === "object" && (sp as Record<string, unknown>)["append"] === true);
}

function isSessionLostError(err: unknown, acpSessionId: string): boolean {
  if (!(err instanceof AcpRpcError)) return false;
  const detail = extractAcpErrorText(err.data) ?? err.message;
  return (
    detail === `Session not found: ${acpSessionId}` ||
    detail.includes("Session not found") ||
    detail.includes("Failed to rebuild agent:")
  );
}

function formatAcpTurnError(err: unknown): string {
  if (err instanceof AcpAuthRequiredError) {
    return "Antigravity 尚未登录或凭据已失效。请在终端运行 `agy acp --login` 完成 Google 登录后重试。";
  }
  if (err instanceof AcpRpcError) {
    const detail = extractAcpErrorText(err.data);
    if (detail) {
      const prefix = /^Cloud Code Assist API error \(\d{3}\):\s*/.exec(detail);
      if (prefix) {
        try {
          const parsed = JSON.parse(detail.slice(prefix[0].length)) as { error?: { message?: string } };
          if (parsed.error?.message) return parsed.error.message;
        } catch {
          /* fall through */
        }
      }
      return detail;
    }
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

export class AntigravityAcpProvider implements AgentProvider {
  readonly id = ANTIGRAVITY_PROVIDER_ID;
  readonly displayName = "Antigravity";
  readonly capabilities: ProviderCapabilities = {
    supportsApproval: true,
    supportsResume: true,
    supportsStreaming: true,
    supportsMcp: false,
    supportsAskUserQuestion: true,
    thinkingLevels: ANTIGRAVITY_EFFORT_LEVELS,
    permissionModes: ANTIGRAVITY_PERMISSION_MODES,
    builtinModels: [],
    supportsCustomEndpoint: false,
    supportsConversationRevision: false,
  };

  private readonly hosts = new Map<string, LiveAcpHost>();

  disposeSession(sessionId: string): void {
    const host = this.hosts.get(sessionId);
    if (!host) return;
    this.hosts.delete(sessionId);
    host.activeAdapter = null;
    host.transport.close();
  }

  async startTurn(req: StartTurnRequest, ctx: ProviderContext): Promise<TurnHandle> {
    let exePath: string;
    try {
      const checked = await assertAntigravityCliUsable();
      exePath = checked.path;
    } catch (err) {
      const code =
        err instanceof AntigravityCliUnavailableError && err.reason === "too-old"
          ? "AGY_CLI_TOO_OLD"
          : "AGY_CLI_MISSING";
      return buildErrorTurn(ctx, req.sessionId, code, (err as Error).message);
    }

    const bypass = req.permissionMode === "bypassPermissions";
    const customPrompt = (await getCustomPromptSetting())?.trim() || "";
    const fingerprint = `${req.cwd}\0${bypass ? "1" : "0"}\0${customPrompt}`;

    const ac = new AbortController();
    let finished = false;
    let host = this.hosts.get(req.sessionId);

    if (host && (host.transport.isClosed || host.fingerprint !== fingerprint)) {
      this.disposeSession(req.sessionId);
      host = undefined;
    }

    const done = (async () => {
      let adapter: AntigravityMessageAdapter | null = null;
      let reason: TurnDoneReason = "end_turn";

      try {
        const liveHost = host ?? (await this.openHost(exePath, req, ctx, bypass, customPrompt, fingerprint, ac.signal));
        host = liveHost;

        // Sync model + effort if the user selected one in the composer.
        const catalog = await getCachedAntigravityCatalog();
        const wireModel = resolveAntigravityWireModel(req.model, req.effort, catalog);
        if (wireModel && wireModel !== liveHost.currentModel) {
          try {
            await liveHost.transport.request(
              "session/set_model",
              { sessionId: liveHost.acpSessionId, modelId: wireModel },
              { timeoutMs: 15_000, signal: ac.signal },
            );
            liveHost.currentModel = wireModel;
          } catch (err) {
            ctx.log.warn(`antigravity-acp: session/set_model(${wireModel}) failed: ${(err as Error).message}`);
          }
        }

        const liveCtx: ProviderContext = {
          ...ctx,
          // Always consult latest permission mode mid-turn
          getPermissionMode: () => ctx.getPermissionMode?.() ?? req.permissionMode,
        };

        adapter = new AntigravityMessageAdapter({
          sessionId: req.sessionId,
          acpSessionId: liveHost.acpSessionId,
          cwd: req.cwd,
          model: req.model && req.model !== "default" ? req.model : liveHost.currentModel,
          permissionMode: req.permissionMode,
          ctx: liveCtx,
          snapshot: getFileSnapshot(req.sessionId),
          abortSignal: ac.signal,
        });
        liveHost.activeAdapter = adapter;

        const promptBlocks: AcpPromptContentBlock[] = [];
        if (req.prompt.length > 0 || !req.images?.length) {
          promptBlocks.push({ type: "text", text: req.prompt });
        }
        for (const img of req.images ?? []) {
          promptBlocks.push({ type: "image", data: img.data, mimeType: img.mimeType });
        }

        const rawRes = await liveHost.transport.request(
          "session/prompt",
          { sessionId: liveHost.acpSessionId, prompt: promptBlocks },
          { timeoutMs: null, signal: ac.signal },
        );

        const parsedRes = AcpPromptResponseSchema.safeParse(rawRes);
        const stopReason = parsedRes.success ? parsedRes.data.stopReason : undefined;

        if (ac.signal.aborted || stopReason === "cancelled") {
          reason = "interrupted";
        } else if (stopReason === "max_tokens") {
          reason = "max_tokens";
        } else if (adapter.lastFailureMessage) {
          reason = "error";
        } else {
          reason = "end_turn";
        }

        if (adapter.hasSessionLostNotice) {
          this.disposeSession(req.sessionId);
        }
      } catch (err) {
        if (ac.signal.aborted || err instanceof AcpAbortedError) {
          reason = "interrupted";
          if (host && !host.transport.isClosed) {
            void host.transport
              .notify("session/cancel", { sessionId: host.acpSessionId })
              .catch(() => {});
          }
        } else {
          reason = "error";
          const msg = formatAcpTurnError(err);
          ctx.log.error(`antigravity-acp turn failed: ${msg}`);
          ctx.emit({ type: "error", sessionId: req.sessionId, message: msg });
          // If the host connection broke or the session was lost, drop cached host so next turn recovers cleanly.
          if (!host || host.transport.isClosed || isSessionLostError(err, host.acpSessionId)) {
            this.disposeSession(req.sessionId);
          }
        }
      } finally {
        if (host && host.activeAdapter === adapter) {
          host.activeAdapter = null;
        }
        if (adapter) {
          await adapter.finalize(reason);
        } else {
          ctx.emit({ type: "turn.done", sessionId: req.sessionId, reason });
        }
        finished = true;
      }
    })();

    return {
      done,
      interrupt: () => {
        if (finished || ac.signal.aborted) return;
        ac.abort();
        const live = this.hosts.get(req.sessionId);
        if (live && !live.transport.isClosed) {
          void live.transport.notify("session/cancel", { sessionId: live.acpSessionId }).catch(() => {});
        }
      },
      isRunning: () => !finished && !ac.signal.aborted,
    };
  }

  private async openHost(
    exePath: string,
    req: StartTurnRequest,
    ctx: ProviderContext,
    bypass: boolean,
    customPrompt: string,
    fingerprint: string,
    signal: AbortSignal,
  ): Promise<LiveAcpHost> {
    const args = ["acp", ...(bypass ? ["--dangerously-skip-permissions"] : [])];
    const hostRef: { current?: LiveAcpHost } = {};

    const transport = new AcpTransport({
      command: exePath,
      args,
      cwd: req.cwd,
      env: { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: "true" },
      hardKill: (child) => {
        if (child.pid) void killProcessTree(child.pid);
      },
      onNotification: (method, params) => {
        if (method === "session/update") {
          hostRef.current?.activeAdapter?.handleSessionNotification(params);
        }
      },
      onRequest: async (method, params, reqCtx) => {
        const active = hostRef.current?.activeAdapter;
        if (!active) {
          throw new AcpRpcError(-32000, "No active turn to handle ACP request");
        }
        if (method === "session/request_permission") {
          return active.handlePermissionRequest(params, reqCtx.signal);
        }
        if (method === "elicitation/create") {
          return active.handleElicitationRequest(params, reqCtx.signal);
        }
        throw new AcpRpcError(-32601, `Unsupported ACP client method: ${method}`);
      },
      onClose: () => {
        const current = this.hosts.get(req.sessionId);
        if (current && current.transport === transport) {
          this.hosts.delete(req.sessionId);
        }
      },
      log: ctx.log,
    });

    try {
      const rawInit = await transport.request(
        "initialize",
        {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
            elicitation: { form: {} },
          },
          clientInfo: { name: "mcode", version: "0.1.0" },
        },
        { timeoutMs: 20_000, signal },
      );

      const initialized = AcpInitializeResponseSchema.parse(rawInit);
      if (initialized.protocolVersion !== ACP_PROTOCOL_VERSION) {
        throw new AcpRpcError(
          -32602,
          `不支持的 ACP 协议版本: ${initialized.protocolVersion}`,
        );
      }

      const meta =
        customPrompt && supportsSystemPromptAppend(initialized)
          ? { antigravity: { systemPrompt: { append: customPrompt } } }
          : undefined;

      let sessionRes: ReturnType<typeof AcpSessionResponseSchema.parse> | null = null;
      const resumeId = req.resumeProviderSessionId;

      if (resumeId) {
        const canResume = initialized.agentCapabilities?.sessionCapabilities?.resume != null;
        const canLoad = initialized.agentCapabilities?.loadSession === true;
        if (canResume) {
          try {
            const raw = await transport.request(
              "session/resume",
              { sessionId: resumeId, cwd: req.cwd, mcpServers: [], ...(meta ? { _meta: meta } : {}) },
              { timeoutMs: 20_000, signal },
            );
            sessionRes = AcpSessionResponseSchema.parse(raw);
          } catch (err) {
            if (!isSessionLostError(err, resumeId) && !canLoad) throw err;
            ctx.log.warn(`antigravity-acp: session/resume(${resumeId}) failed: ${(err as Error).message}`);
          }
        }
        if (!sessionRes && canLoad) {
          try {
            const raw = await transport.request(
              "session/load",
              { sessionId: resumeId, cwd: req.cwd, mcpServers: [], ...(meta ? { _meta: meta } : {}) },
              { timeoutMs: 25_000, signal },
            );
            sessionRes = AcpSessionResponseSchema.parse(raw);
          } catch (err) {
            if (!isSessionLostError(err, resumeId)) throw err;
            ctx.log.warn(`antigravity-acp: session/load(${resumeId}) failed: ${(err as Error).message}`);
          }
        }
      }

      if (!sessionRes) {
        const raw = await transport.request(
          "session/new",
          { cwd: req.cwd, mcpServers: [], ...(meta ? { _meta: meta } : {}) },
          { timeoutMs: 25_000, signal },
        );
        sessionRes = AcpSessionResponseSchema.parse(raw);
      }

      ctx.onProviderSessionId?.(sessionRes.sessionId);

      const liveHost: LiveAcpHost = {
        transport,
        fingerprint,
        initialized,
        acpSessionId: sessionRes.sessionId,
        currentModel: sessionRes.models?.currentModelId,
        activeAdapter: null,
      };
      hostRef.current = liveHost;
      this.hosts.set(req.sessionId, liveHost);
      return liveHost;
    } catch (err) {
      transport.close();
      throw err;
    }
  }

  async healthCheck(): Promise<{ ok: boolean; version?: string; error?: string }> {
    const exePath = resolveAntigravityExecutable();
    if (!exePath) {
      return { ok: false, error: "未找到 Antigravity CLI (agy)" };
    }
    const version = await probeAntigravityCliVersion(exePath, 8_000, true);
    if (!version) {
      return { ok: false, error: "无法读取 agy 版本" };
    }
    return { ok: true, version };
  }
}
