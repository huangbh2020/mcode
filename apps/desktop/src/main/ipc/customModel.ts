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
  GetCustomModelTokenSchema,
} from "@contracts/ipc";
import type { ApiConfig } from "@contracts/customModel";
import { CustomModelStore } from "@main/lib/secretStore.js";
import { buildCustomEnv, resolveActiveModel } from "@main/providers/claude-sdk/customEnv.js";
import { BridgeRegistry } from "@main/providers/bridge/bridgeRegistry.js";
import { resolveSdkBinaryPath } from "@main/providers/claude-sdk/sdkBinaryPath.js";
import { log } from "@main/lib/logger.js";

/** Probe timeout — a healthy endpoint should answer the init handshake within
 *  a few seconds. We abort the SDK query after this to avoid hanging the UI. */
const TEST_TIMEOUT_MS = 30_000;

export function registerCustomModelHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.CUSTOM_MODEL_LIST, () => {
    return { models: CustomModelStore.listPublic() };
  });

  ipcMain.handle(IPC.CUSTOM_MODEL_SAVE, (_evt, raw) => {
    const input = SaveCustomModelSchema.parse(raw);
    const models = CustomModelStore.save(input);
    log.info(`custom model saved: ${input.id ? `updated ${input.id}` : `new (${models.length} total)`}`);
    return { models };
  });

  ipcMain.handle(IPC.CUSTOM_MODEL_DELETE, (_evt, raw) => {
    const input = DeleteCustomModelSchema.parse(raw);
    const models = CustomModelStore.remove(input.id);
    log.info(`custom model deleted: ${input.id} (${models.length} remaining)`);
    return { models };
  });

  ipcMain.handle(IPC.CUSTOM_MODEL_GET_TOKEN, (_evt, raw) => {
    const input = GetCustomModelTokenSchema.parse(raw);
    // resolveApiConfig already decrypts the token in main memory; we reuse it
    // rather than opening a second decryption path. The cleartext is returned
    // here ONLY because the user clicked the eye icon in the settings form.
    const cfg = CustomModelStore.resolveApiConfig(input.id);
    return { token: cfg?.authToken ?? null };
  });

  ipcMain.handle(IPC.CUSTOM_MODEL_TEST, async (_evt, raw) => {
    const input = TestCustomModelSchema.parse(raw);
    // The probe tests ONE model (the user picks which role/model in the UI).
    // Build a minimal ApiConfig that binds the probed model under the Sonnet
    // tier (arbitrary but valid) and selects it. supports1m is recorded on the
    // binding so resolveActiveModel / buildCustomEnv see the same 1M behavior
    // a saved config would produce — the probe then exercises the EXACT model
    // string a real turn would send via Options.model.
    const cfg: ApiConfig = {
      baseUrl: input.baseUrl,
      authToken: input.authToken,
      authMode: input.authMode ?? "auth_token",
      protocol: input.protocol ?? "anthropic",
      selectedRole: "sonnet",
      roles: { sonnet: { requestModel: input.model, supports1m: input.supports1m ?? false } },
      disableNonEssentialTraffic: input.disableNonEssentialTraffic ?? true,
      timeoutMs: input.timeoutMs,
    };
    // BOTH protocols probe through the real live chain (binary + env builder +
    // settingSources) — never a shortcut fetch. OpenAI-format endpoints get a
    // throwaway bridge instance under a synthetic config id, mirroring what
    // RuntimeManager.sendTurn does for a live turn, so the probe exercises
    // translation + auth + model routing end-to-end: "测得过 = 保存后一定能用".
    // (The former direct-fetch shortcut skipped the bridge and sent the
    // `[1m]`-suffixed model id straight onto the OpenAI wire — which has no
    // such convention — so gateways read `model[1m]` as an unknown model and
    // answered 401, failing tests for configs that work fine live.)
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

/**
 * Verify a custom endpoint by spawning a minimal SDK query against it and
 * waiting for the first system/init message (proves: DNS reachable, auth
 * accepted, model available, and — for OpenAI configs — the bridge
 * translation works). Aborts after {@link TEST_TIMEOUT_MS}.
 *
 * Uses the SAME env-builder, SAME model resolver, AND SAME settingSources as a
 * live turn, so a passing test guarantees the saved config will work
 * end-to-end. OpenAI-format callers pass a cfg whose baseUrl has already been
 * rewritten to a live bridge's local URL (exactly the rewrite
 * RuntimeManager.sendTurn applies), so the probe is the live chain verbatim.
 * The probe resolves the model id via {@link resolveActiveModel}
 * and passes `settingSources: ['project','local']` — matching what
 * {@link ClaudeAgentSdkProvider} does — so the two paths can never drift. This
 * is critical: without matching settingSources, the binary would read whatever
 * cc switch left in ~/.claude/settings.json and the probe would test the wrong
 * endpoint (the original "test passes, live turn fails" bug).
 */
async function probeEndpoint(
  cfg: ApiConfig,
): Promise<{
  ok: boolean;
  detail?: string;
  error?: string;
}> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TEST_TIMEOUT_MS);

  try {
    // The probe mirrors a live turn: resolveActiveModel yields the exact model
    // string (with the lowercase `[1m]` suffix when supports1m) that
    // buildCustomEnv also places on ANTHROPIC_MODEL for a live turn — so the
    // probe exercises the same model id a real turn sends. The probe passes it
    // via the SDK `model` option (it doesn't set ANTHROPIC_MODEL because its
    // cfg binds only one role); the binary accepts either channel.
    // betas is intentionally NOT set — 1M is declared via the suffix, not via
    // the anthropic-beta header. Where the suffix ends up depends on protocol:
    // anthropic gateways parse it themselves (DeepSeek convention); for openai
    // configs the bridge strips it before the upstream sees the request (the
    // OpenAI wire has no such convention) — mirroring a live turn either way.
    const probedModel = resolveActiveModel(cfg);
    // Resolve the real on-disk binary path. Without this, the SDK resolves the
    // claude binary to a path INSIDE app.asar in a packaged app and spawn()
    // fails with ENOTDIR (asar is a file, not a directory). Dev returns null
    // and the SDK resolves node_modules itself. Same fix the provider applies.
    const binaryPath = resolveSdkBinaryPath();
    const q = query({
      prompt: "hi",
      options: {
        abortController: ac,
        maxTurns: 1,
        model: probedModel,
        env: buildCustomEnv(cfg),
        // MUST mirror the live-turn provider's settingSources (see
        // ClaudeAgentSdkProvider.ts). The bundled binary re-reads
        // ~/.claude/settings.json after spawn and overwrites the env we pass
        // here — so without this, the probe would be testing whatever cc
        // switch currently points at, NOT the config the user just typed in.
        // That divergence was the original "test passes, live turn fails"
        // mystery. ['project','local'] skips the user-level file (cc switch's
        // territory) while keeping CLAUDE.md / project settings working.
        settingSources: ["project", "local"],
        includePartialMessages: false,
        ...(binaryPath ? { pathToClaudeCodeExecutable: binaryPath } : {}),
      },
    });

    for await (const m of q) {
      // The system/init message is the SDK's first emission once the subprocess
      // has booted and authenticated. Seeing it means the endpoint is live.
      if (m.type === "system" && (m as { subtype?: string }).subtype === "init") {
        const ver = (m as { claude_code_version?: string }).claude_code_version;
        return { ok: true, detail: ver ? `connected (SDK v${ver})` : "connected" };
      }
      // If the model already answered (some non-Anthropic backends skip the
      // init handshake), treat that as success too.
      if (m.type === "assistant") {
        return { ok: true, detail: "model responded" };
      }
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
