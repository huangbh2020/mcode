/**
 * IPC handlers for user-defined custom-model configs (Anthropic-compatible
 * endpoints). The auth token is encrypted at rest via safeStorage and NEVER
 * sent to the renderer in cleartext — only a masked form is returned.
 *
 * - list   : return all configs (desensitized)
 * - save   : create or update (encrypts the token, returns the new list)
 * - delete : remove a config and its token
 * - test   : probe a (not-yet-saved) config by running one minimal SDK turn
 *            against that endpoint, so the user can verify before save
 */
import type { IpcMain } from "electron";
import { randomUUID } from "node:crypto";
import {
  IPC,
  SaveCustomModelSchema,
  DeleteCustomModelSchema,
  TestCustomModelSchema,
  FetchCustomModelsSchema,
  GetCustomModelTokenSchema,
  SetActiveCustomModelSchema,
  SetClaudeSyncTargetSchema,
  ImportClaudeSettingsSchema,
} from "@contracts/ipc";
import type { ApiConfig, ClaudeMenuRoleKey, FetchCustomModelsResult } from "@contracts/customModel";
import { CustomModelStore } from "@main/lib/secretStore.js";
import { sanitizeCustomHeaders } from "@main/providers/upstreamHeaders.js";
import {
  getClaudeSettingsSyncState,
  importFromClaudeSettingsFile,
  setActiveClaudeProviderId,
  setClaudeSettingsSyncTarget,
  syncClaudeSettingsFiles,
} from "@main/lib/claudeSettingsSync.js";
import { buildCustomEnv, resolveActiveModel } from "@main/providers/claude-sdk/customEnv.js";
import { runClaudeOneShot } from "@main/providers/claude-sdk/claudeOneShot.js";
import { BridgeRegistry } from "@main/providers/bridge/bridgeRegistry.js";
import { log } from "@main/lib/logger.js";

/** Probe timeout — a healthy endpoint should answer the init handshake within
 *  a few seconds. The probe is aborted after this so the UI never hangs. */
const TEST_TIMEOUT_MS = 30_000;

async function syncActiveProviderIfNeeded(
  activeId: string | null,
  preferredModel?: string,
  preferredRole?: ClaudeMenuRoleKey,
): Promise<string | undefined> {
  const { syncTarget } = getClaudeSettingsSyncState();
  if (syncTarget === "none") return undefined;
  const cfg = activeId
    ? CustomModelStore.resolveApiConfig(activeId, preferredModel, preferredRole) ?? null
    : null;
  const { warning } = await syncClaudeSettingsFiles(cfg, syncTarget);
  return warning;
}

export function registerCustomModelHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.CUSTOM_MODEL_LIST, () => {
    return { models: CustomModelStore.listPublic() };
  });

  ipcMain.handle(IPC.CUSTOM_MODEL_SAVE, async (_evt, raw) => {
    const input = SaveCustomModelSchema.parse(raw);
    const models = CustomModelStore.save(input);
    const savedId = input.id ?? models[models.length - 1]?.id ?? null;
    log.info(`custom model saved: ${input.id ? `updated ${input.id}` : `new (${models.length} total)`}`);

    let syncWarning: string | undefined;
    let syncState = getClaudeSettingsSyncState();
    // Auto-activate the first created provider, or re-sync if the edited provider is currently active.
    if (!syncState.activeProviderId && savedId && !input.id) {
      syncState = setActiveClaudeProviderId(savedId);
      syncWarning = await syncActiveProviderIfNeeded(savedId);
    } else if (syncState.activeProviderId && syncState.activeProviderId === savedId) {
      syncWarning = await syncActiveProviderIfNeeded(savedId);
    }
    return {
      models,
      activeProviderId: syncState.activeProviderId,
      ...(syncWarning ? { syncWarning } : {}),
    };
  });

  ipcMain.handle(IPC.CUSTOM_MODEL_DELETE, async (_evt, raw) => {
    const input = DeleteCustomModelSchema.parse(raw);
    const models = CustomModelStore.remove(input.id);
    let syncState = getClaudeSettingsSyncState();
    if (syncState.activeProviderId === input.id) {
      syncState = setActiveClaudeProviderId(null);
      await syncActiveProviderIfNeeded(null);
    }
    log.info(`custom model deleted: ${input.id} (${models.length} remaining)`);
    return { models, activeProviderId: syncState.activeProviderId };
  });

  ipcMain.handle(IPC.CUSTOM_MODEL_GET_SYNC_STATE, () => {
    return getClaudeSettingsSyncState();
  });

  ipcMain.handle(IPC.CUSTOM_MODEL_SET_ACTIVE, async (_evt, raw) => {
    const input = SetActiveCustomModelSchema.parse(raw);
    if (input.id && !CustomModelStore.resolveApiConfig(input.id, input.model, input.role)) {
      throw new Error(`custom model not found or invalid: ${input.id}`);
    }
    const state = setActiveClaudeProviderId(input.id);
    const warning = await syncActiveProviderIfNeeded(state.activeProviderId, input.model, input.role);
    return { state, ...(warning ? { warning } : {}) };
  });

  ipcMain.handle(IPC.CUSTOM_MODEL_SET_SYNC_TARGET, async (_evt, raw) => {
    const input = SetClaudeSyncTargetSchema.parse(raw);
    const state = setClaudeSettingsSyncTarget(input.target);
    const warning = await syncActiveProviderIfNeeded(state.activeProviderId);
    return { state, ...(warning ? { warning } : {}) };
  });

  ipcMain.handle(IPC.CUSTOM_MODEL_IMPORT_SETTINGS, async (_evt, raw) => {
    const input = ImportClaudeSettingsSchema.parse(raw);
    const candidate = await importFromClaudeSettingsFile(input?.source);
    return { candidate };
  });

  ipcMain.handle(IPC.CUSTOM_MODEL_GET_TOKEN, (_evt, raw) => {
    const input = GetCustomModelTokenSchema.parse(raw);
    // resolveApiConfig already decrypts the token in main memory; we reuse it
    // rather than opening a second decryption path. The cleartext is returned
    // here ONLY because the user clicked the eye icon in the settings form.
    const cfg = CustomModelStore.resolveApiConfig(input.id);
    return { token: cfg?.authToken ?? null };
  });

  ipcMain.handle(IPC.CUSTOM_MODEL_FETCH_MODELS, async (_evt, raw) => {
    const input = FetchCustomModelsSchema.parse(raw);
    const token =
      input.authToken?.trim() ||
      (input.id ? CustomModelStore.resolveApiConfig(input.id)?.authToken : "") ||
      "";
    if (!token) {
      return { ok: false, models: [], error: "请先填写 Token / API Key" } satisfies FetchCustomModelsResult;
    }
    return fetchModelsFromEndpoint({
      baseUrl: input.baseUrl,
      authToken: token,
      authMode: input.authMode ?? "auth_token",
      protocol: input.protocol ?? "anthropic",
      customHeaders: input.customHeaders,
    });
  });

  ipcMain.handle(IPC.CUSTOM_MODEL_TEST, async (_evt, raw) => {
    const input = TestCustomModelSchema.parse(raw);
    const token =
      input.authToken?.trim() ||
      (input.id ? CustomModelStore.resolveApiConfig(input.id)?.authToken : "") ||
      "";
    if (!token) {
      return { ok: false, error: "请先填写 Token / API Key" };
    }
    const cfg: ApiConfig = {
      baseUrl: input.baseUrl,
      authToken: token,
      authMode: input.authMode ?? "auth_token",
      protocol: input.protocol ?? "anthropic",
      selectedModel: input.model,
      models: [{ id: input.model, ...(input.supports1m ? { supports1m: true } : {}) }],
      disableNonEssentialTraffic: input.disableNonEssentialTraffic ?? true,
      timeoutMs: input.timeoutMs,
      customHeaders: input.customHeaders,
    };
    if (cfg.protocol === "openai") {
      const probeId = `probe:${randomUUID()}`;
      const handle = await BridgeRegistry.acquire(probeId, cfg);
      try {
        return await probeEndpoint({ ...cfg, baseUrl: handle.localUrl });
      } finally {
        BridgeRegistry.release(probeId);
      }
    }
    return probeEndpoint(cfg);
  });
}

/** Build candidate `/v1/models` URLs from a provider Base URL (stripping
 *  Anthropic/OpenAI compatible subpaths when needed). */
function buildModelListUrls(baseUrl: string): string[] {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) return [];
  const root = trimmed
    .replace(/\/anthropic$/i, "")
    .replace(/\/v1\/messages$/i, "")
    .replace(/\/messages$/i, "")
    .replace(/\/chat\/completions$/i, "")
    .replace(/\/+$/, "");

  const candidates = [
    /\/v1$/i.test(trimmed) ? `${trimmed}/models` : `${trimmed}/v1/models`,
    /\/v1$/i.test(root) ? `${root}/models` : `${root}/v1/models`,
    `${root}/models`,
    `${trimmed}/models`,
  ];
  return Array.from(new Set(candidates));
}

function extractModelIdsFromPayload(payload: unknown): string[] | null {
  if (!payload || typeof payload !== "object") return null;
  const doc = payload as Record<string, unknown>;
  const rawList = Array.isArray(doc.data)
    ? doc.data
    : Array.isArray(doc.models)
      ? doc.models
      : null;
  if (!rawList) return null;

  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of rawList) {
    if (typeof item === "string") {
      const id = item.trim();
      if (id && !seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
      continue;
    }
    if (item && typeof item === "object") {
      const rec = item as Record<string, unknown>;
      const rawId =
        typeof rec.id === "string"
          ? rec.id
          : typeof rec.slug === "string"
            ? rec.slug
            : "";
      const id = rawId.trim();
      if (id && !seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
  }
  return out;
}

async function fetchModelsFromEndpoint(opts: {
  baseUrl: string;
  authToken: string;
  authMode: "auth_token" | "api_key";
  protocol: "anthropic" | "openai";
  customHeaders?: Record<string, string>;
}): Promise<FetchCustomModelsResult> {
  const urls = buildModelListUrls(opts.baseUrl);
  if (urls.length === 0) {
    return { ok: false, models: [], error: "Base URL 不能为空" };
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(opts.customHeaders ? sanitizeCustomHeaders(opts.customHeaders) : {}),
  };
  if (opts.authMode === "api_key") {
    headers["x-api-key"] = opts.authToken;
  } else {
    headers.Authorization = `Bearer ${opts.authToken}`;
  }
  if (opts.protocol === "anthropic" && !headers["anthropic-version"]) {
    headers["anthropic-version"] = "2023-06-01";
  }

  let lastError = "未能从该端点获取到模型列表";
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          models: [],
          error: `认证失败 (${res.status})：请检查 Token / 认证方式是否正确`,
        };
      }
      if (!res.ok) {
        lastError = `HTTP ${res.status} (${url})`;
        continue;
      }
      const json: unknown = await res.json();
      const ids = extractModelIdsFromPayload(json);
      if (ids && ids.length > 0) {
        return { ok: true, models: ids };
      }
      if (ids && ids.length === 0) {
        lastError = `接口返回空模型列表 (${url})`;
      } else {
        lastError = `响应格式不支持 (${url})`;
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  return { ok: false, models: [], error: lastError };
}

/**
 * Verify a custom endpoint by starting a minimal Claude CLI session against
 * it and waiting for the first system/init message (proves: the CLI boots
 * with this config's env, DNS reachable, and — for OpenAI configs — the
 * bridge translation is in the path). Aborts after {@link TEST_TIMEOUT_MS}.
 *
 * Uses the SAME env-builder and SAME model resolver as a live turn, so a
 * passing test means the saved config launches end-to-end. OpenAI-format
 * callers pass a cfg whose baseUrl has already been rewritten to a live
 * bridge's local URL (exactly the rewrite RuntimeManager.sendTurn applies),
 * so the probe is the live chain verbatim. The probe resolves the model id
 * via {@link resolveActiveModel} and loads only the project + local settings
 * files: the CLI re-reads settings.json after spawn and lets its `env` block
 * override what we pass, so loading the user-level file would test whatever
 * cc switch currently points at, not the config the user just typed in (the
 * original "test passes, live turn fails" bug). `CLAUDE_CONFIG_DIR` already
 * points sessions at ~/.mcode, where that file is Mcode's own.
 */
async function probeEndpoint(
  cfg: ApiConfig,
): Promise<{
  ok: boolean;
  detail?: string;
  error?: string;
}> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TEST_TIMEOUT_MS);

  try {
    // The probe mirrors a live turn: resolveActiveModel yields the exact model
    // string (with the lowercase `[1m]` suffix when supports1m) that
    // buildCustomEnv also places on ANTHROPIC_MODEL for a live turn — so the
    // probe exercises the same model id a real turn sends. The probe passes it
    // via `--model` (it doesn't set ANTHROPIC_MODEL because its cfg binds only
    // one role); the CLI accepts either channel.
    // betas is intentionally NOT set — 1M is declared via the suffix, not via
    // the anthropic-beta header. Where the suffix ends up depends on protocol:
    // anthropic gateways parse it themselves (DeepSeek convention); for openai
    // configs the bridge strips it before the upstream sees the request (the
    // OpenAI wire has no such convention) — mirroring a live turn either way.
    const probedModel = resolveActiveModel(cfg);
    const { init, assistantSeen } = await runClaudeOneShot({
      prompt: "hi",
      model: probedModel,
      env: buildCustomEnv(cfg),
      settingSources: ["project", "local"],
      // The probe only needs the session to boot; a tool ask has nobody to
      // answer it here (a one-shot has no approval bridge) and is refused.
      tools: "default",
      abortController: ac,
      stopAtInit: true,
    });

    // The system/init message is the CLI's first session frame once it has
    // booted and authenticated. Seeing it means the endpoint is live.
    if (init) {
      const ver = init.claude_code_version;
      return { ok: true, detail: ver ? `connected (CLI v${ver})` : "connected" };
    }
    // If the model already answered (some non-Anthropic backends skip the
    // init handshake), treat that as success too.
    if (assistantSeen) {
      return { ok: true, detail: "model responded" };
    }
    return { ok: false, error: "endpoint did not send an init message" };
  } catch (err) {
    const msg = (err as Error).message || String(err);
    // Translate the most common failure modes into friendlier text, keeping a
    // short excerpt of the raw cause — bridge-relayed upstream errors embed
    // the gateway's own words (e.g. one-api's "无可用渠道"), which is often
    // the actual reason a 401/503 fired (token↔model binding, not bad auth).
    const excerpt = `;上游返回: ${msg.replace(/\s+/g, " ").slice(0, 160)}`;
    if (/401|unauthorized|invalid.*key|invalid_api_key|invalid.*token/i.test(msg)) {
      return { ok: false, error: `认证失败:Token/Key 被拒绝 (401) — 检查认证方式是否选对 (Bearer vs x-api-key)${excerpt}` };
    }
    if (/403|forbidden/i.test(msg)) {
      return { ok: false, error: `无权访问 (403) — 该 Token 无此模型权限${excerpt}` };
    }
    if (/503|no available channel|无可用渠道/i.test(msg)) {
      return { ok: false, error: `网关无此模型渠道 (503):确认「模型名」与「别名映射」是否匹配该网关${excerpt}` };
    }
    if (ac.signal.aborted || /abort/i.test(msg)) {
      return { ok: false, error: `连接超时(${TEST_TIMEOUT_MS / 1000}s),请检查 Base URL 或网络` };
    }
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}
