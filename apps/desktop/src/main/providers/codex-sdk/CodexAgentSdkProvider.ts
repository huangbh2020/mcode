/**
 * Codex agent provider — drives the OpenAI Codex harness via the
 * `codex app-server` JSON-RPC protocol (stdio JSONL) and implements the
 * AgentProvider interface from @contracts/provider.
 *
 * ## Route decision (vs the official @openai/codex-sdk)
 * The published TS SDK wraps `codex exec --experimental-json`: one process
 * per turn, NO approval callbacks, NO interrupt API, NO diff/usage events.
 * Mcode's core interactions (tool approval, plan approval, per-turn file
 * card + rewind) need the app-server protocol — the same one the VS Code
 * extension speaks. We spawn the vendored binary directly; the only thing
 * we take from the npm package is the platform binary itself.
 *
 * ## How Codex differs from Claude / Pi
 *   - Permissions: sandbox × approvalPolicy, codex-native modes
 *     (readonly/workspace/full/bypass) — NOT Claude's 4 modes. The OS
 *     sandbox (Seatbelt/Landlock) is the primary containment; approvals are
 *     server-initiated requests when an action wants to escape it.
 *   - No canUseTool: approvals arrive as server→client REQUESTS
 *     (commandExecution / fileChange requestApproval) bridged to the host's
 *     IPC approval card. "Always allow" maps to acceptForSession (server
 *     grants for the rest of the thread). There is NO edit-then-approve.
 *   - File tracking: no pre-write hook for sandboxed writes. The turn's
 *     cumulative unified diff (turn/diff/updated) is reverse-applied at
 *     freeze time to reconstruct pre-turn content (CodexFileSnapshot);
 *     approval-gated writes recordPre before we answer accept.
 *   - Custom tools: no registerTool / in-process MCP. AskUserQuestion,
 *     plan tools and browser tools ride thread/start's experimental
 *     `dynamicTools` (functions the server calls back over JSON-RPC).
 *   - Model/auth: third-party Responses-API endpoints from
 *     CodexModelsStore — config.toml [model_providers] materialized into the
 *     isolated CODEX_HOME (~/.mcode/codex); keys ride the process env
 *     (MCODE_CODEX_KEY_<ID>), never disk. Model ids look like
 *     "providerId/modelId" (same shape as Pi).
 *   - Process model: one app-server per TURN (like Claude's one CLI per
 *     turn), thread identity persisted via ctx.onProviderSessionId and
 *     restored with thread/resume on subsequent turns.
 */
import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promises as fs, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import type {
  AgentProvider,
  StartTurnRequest,
  ProviderContext,
  TurnHandle,
  ProviderCapabilities,
  ApprovalRequest,
} from "@contracts/provider";
import type { ServerRequestFrame } from "./CodexAppServerClient.js";
import { CodexAppServerClient } from "./CodexAppServerClient.js";
import { CodexMessageAdapter } from "./CodexMessageAdapter.js";
import { CodexFileSnapshot } from "./CodexFileSnapshot.js";
import { resolveCodexBinaryPath } from "./codexBinaryResolve.js";
import {
  CodexModelsStore,
  codexHomePath,
  codexKeyEnvVar,
} from "@main/lib/codexModelsStore.js";
import { getOrSetFileSnapshot } from "@main/lib/fileSnapshotRegistry.js";
import { getMcpManagement } from "@main/lib/mcpConfig.js";
import { CODEX_IDENTITY_PROMPT, joinPromptSections } from "@main/lib/systemPrompt.js";
import { ASK_NATIVE_TOOL_PROMPT } from "@main/lib/askQuestion.js";
import {
  parseQuestions,
  formatAnswersForModel,
} from "@main/lib/askQuestion.js";
import {
  browserList,
  browserNavigate,
  browserSnapshot,
  browserClick,
  browserType,
  browserKeys,
  browserScroll,
  browserWait,
  browserHistory,
  browserSelect,
  browserFind,
  browserSwitchTab,
  browserCloseTab,
  browserUploadFile,
  browserSavePdf,
  browserDownloads,
  browserEvaluate,
  browserScreenshot,
  BROWSER_TOOL_SPECS,
  browserToolsUsagePrompt,
} from "@main/browser/agentBrowserTools.js";

/* ── Codex-native capability descriptors ── */

/** Codex's own permission presets — the official Permission Profiles surface
 *  (labels and semantics lifted verbatim from the codex binary's profile
 *  definitions; NOT Mcode-invented combinations):
 *    :read-only          "Read Only"    — read workspace files; approval
 *                                        required to edit or access internet
 *    :workspace          "Default"      — read+edit workspace files, run
 *                                        commands; approval required for
 *                                        internet or out-of-workspace edits
 *                                        (identical to Agent mode)
 *    :danger-full-access "Full Access"  — edit anywhere + internet, no
 *                                        approval. Exercise caution.
 *  Values are the profile names without the leading colon ("default" lands on
 *  the same neutral slot Claude/Pi use, so new codex sessions start in the
 *  official Default profile out of the box). */
export const CODEX_PERMISSION_MODES = [
  {
    value: "read-only",
    label: "Read Only",
    icon: "shield",
    hint: "仅可读取当前工作区文件;编辑文件或访问互联网需要审批",
  },
  {
    value: "default",
    label: "Default",
    icon: "shieldCheck",
    hint: "可读写当前工作区文件并执行命令;访问互联网或修改工作区外文件需要审批",
  },
  {
    value: "full-access",
    label: "Full Access",
    icon: "shieldLock",
    color: "text-danger",
    hint: "可修改工作区外文件并访问互联网,无需审批;请谨慎使用",
  },
] as const;

type CodexPermissionMode = (typeof CODEX_PERMISSION_MODES)[number]["value"];

/** Legacy values from the first implementation (pre-official-presets). A
 *  session row persisted with one still resolves to its nearest official
 *  profile instead of silently falling back to Default. */
const LEGACY_MODE_MAP: Record<string, CodexPermissionMode> = {
  "codex-readonly": "read-only",
  "codex-workspace": "default",
  "codex-full": "full-access",
  "codex-bypass": "full-access",
};

/** Normalize a persisted/UI permission-mode value to an official codex
 *  profile value. Unknown/absent → "default" (codex's own default). */
function normalizeCodexMode(mode: string | undefined | null): CodexPermissionMode {
  if (!mode) return "default";
  if (mode === "read-only" || mode === "default" || mode === "full-access") return mode;
  return LEGACY_MODE_MAP[mode] ?? "default";
}

/** camelCase SandboxPolicy `type` for turn/start's sandboxPolicy object form
 *  (thread/start takes the kebab SandboxMode string; turn overrides use the
 *  tagged object — see SandboxPolicy in the protocol schema). */
function sandboxPolicyType(mode: CodexPermissionMode): string {
  switch (mode) {
    case "read-only": return "readOnly";
    case "full-access": return "dangerFullAccess";
    case "default":
    default: return "workspaceWrite";
  }
}

/** The (sandbox, approvalPolicy) pair each official profile maps to. Values
 *  are the app-server's wire spellings: SandboxMode is kebab-case
 *  ("read-only"|"workspace-write"|"danger-full-access"), approvalPolicy is
 *  "on-request"|"never" ("untrusted" exists but is being retired upstream). */
function codexModeToPolicy(mode: CodexPermissionMode): {
  sandbox: string;
  approvalPolicy: string;
} {
  switch (mode) {
    case "read-only":
      return { sandbox: "read-only", approvalPolicy: "on-request" };
    case "full-access":
      return { sandbox: "danger-full-access", approvalPolicy: "never" };
    case "default":
    default:
      return { sandbox: "workspace-write", approvalPolicy: "on-request" };
  }
}

/* ── static baseline for the model picker ── */
// No builtinModels: codex's own catalog entries (gpt-5.x via ChatGPT auth)
// are unreachable inside Mcode's isolated CODEX_HOME (no auth.json is ever
// written there), and the picker drives off the user-configured
// `codexAvailableModels` projection instead. Dynamic model/list discovery is
// a possible future enhancement, not wired today.

export class CodexAgentSdkProvider implements AgentProvider {
  readonly id = "codex-sdk";
  readonly displayName = "Codex";
  readonly capabilities: ProviderCapabilities = {
    // Approvals arrive as server→client requests bridged to the host's
    // approval card (see the requestApproval handler in startTurn).
    supportsApproval: true,
    supportsResume: true, // thread/resume via persisted threadId
    supportsStreaming: true, // item/agentMessage/delta
    supportsMcp: true, // config.toml [mcp_servers] materialization
    supportsAskUserQuestion: true, // dynamicTools ask_user_question
    // Codex's own reasoning-effort surface, verbatim: values are the binary's
    // effort enum, labels its TUI display names, hints its model-catalog
    // preset descriptions (translated). "default" = omit effort → the model's
    // own default (e.g. GPT-5.6 defaults to medium). "persistent" exists in
    // the enum but is a Responses-API persistence mechanism, not a picker
    // option — intentionally not surfaced.
    thinkingLevels: [
      { value: "default", label: "Default", hint: "不显式指定 effort,由模型使用自身默认档位" },
      { value: "minimal", label: "Minimal", hint: "最少推理,速度优先" },
      { value: "low", label: "Low", hint: "更快的响应、较轻的推理;适合简单问答与短解释" },
      { value: "medium", label: "Medium", hint: "推理深度与时延平衡,适合日常任务" },
      { value: "high", label: "High", hint: "更深的推理,面向复杂问题" },
      { value: "xhigh", label: "XHigh", hint: "超高推理深度,面向复杂问题" },
      { value: "max", label: "Max", hint: "最大推理深度,面向最难的问题" },
      { value: "ultra", label: "Ultra", hint: "最大推理并自动任务委派(可能主动使用多个子代理)" },
    ],
    permissionModes: [...CODEX_PERMISSION_MODES],
    supportsCustomEndpoint: false, // Codex manages its own model-provider panel
  };

  async startTurn(req: StartTurnRequest, ctx: ProviderContext): Promise<TurnHandle> {
    const ac = new AbortController();

    /* ── 1. Binary + config bootstrap ── */
    const codexPath = resolveCodexBinaryPath();
    if (!codexPath) {
      return failTurn(ctx, req.sessionId, "CODEX_BINARY_MISSING", "未找到 Codex:请到 设置 → Agent 下载安装(Codex is missing — open Settings → Agent and install it).");
    }

    // Materialize config.toml (model_providers) + AGENTS.md into the isolated
    // CODEX_HOME. Cleartext keys never land here — they ride the env.
    const providers = await CodexModelsStore.listPublic();
    if (providers.length === 0) {
      return failTurn(ctx, req.sessionId, "CODEX_NO_MODEL", "Codex 未配置任何模型:请先在「设置 → 模型配置 → Codex」中添加模型端点后再发送。");
    }
    await CodexModelsStore.ensureConfigMaterialized(req.cwd);
    await ensureCodexHomeIdentity();
    const mcpManagement = await getMcpManagement();
    const browserToolsEnabled = !mcpManagement.browserDisabled;

    /* ── 2. Model resolution ("providerId/modelId", Pi-style) ── */
    const configured = new Set(providers.map((p) => p.id));
    let providerId: string | null = null;
    let modelId: string | null = null;
    if (req.model && req.model !== "default") {
      const slash = req.model.indexOf("/");
      if (slash > 0 && slash < req.model.length - 1) {
        const p = req.model.slice(0, slash);
        const m = req.model.slice(slash + 1);
        if (configured.has(p)) {
          providerId = p;
          modelId = m;
        } else {
          ctx.log.warn(`codex: model "${req.model}" names unconfigured provider "${p}", falling back to the first configured provider`);
        }
      }
    }
    if (!providerId || !modelId) {
      const first = providers[0];
      providerId = first.id;
      modelId = first.models[0]?.id ?? null;
      if (modelId) ctx.log.info(`codex: falling back to first configured model "${providerId}/${modelId}"`);
    }
    if (!modelId) {
      return failTurn(ctx, req.sessionId, "CODEX_NO_MODEL", "Codex 所选模型端点没有可用模型:请在「设置 → 模型配置 → Codex」补全模型列表。");
    }

    /* ── 3. Permission mode → sandbox/approvalPolicy ── */
    const mode = normalizeCodexMode(req.permissionMode);
    const { sandbox, approvalPolicy } = codexModeToPolicy(mode);

    // Per-model context-window override (third-party models the codex catalog
    // doesn't know). Passed as a PROCESS-LOCAL `-c` CLI override — priority
    // over config.toml and scoped to this turn's app-server process, so
    // concurrent sessions with different windows never race on the shared
    // config file (verified: config/read reflects the flag value).
    const selectedModel = providers.find((p) => p.id === providerId)?.models.find((m) => m.id === modelId);
    const contextWindow = selectedModel?.contextWindow;

    /* ── 4. Spawn app-server (env carries CODEX_HOME + provider keys) ── */
    const env = await buildCodexEnv(ctx);
    // File snapshot: sandboxed writes reconstruct from the turn diff at
    // freeze (there is no pre-write hook; approval params carry only
    // grantRoot, so no recordPre path exists on this provider).
    const snapshot = getOrSetFileSnapshot(req.sessionId, () => new CodexFileSnapshot(req.cwd)) as CodexFileSnapshot;
    // User-configured per-model context window doubles as the occupancy
    // fallback when the server never reports modelContextWindow (third-party
    // endpoints often don't) — the adapter's hardcoded default would
    // understate usage for smaller windows.
    const adapter = new CodexMessageAdapter(ctx, req.sessionId, snapshot, contextWindow, async (threadId) => {
      // thread/read bootstrap for subagent transcripts (see adapter). The
      // client isn't constructed yet when the adapter is — resolve lazily.
      const client = clientRef;
      if (!client) return [];
      const res = (await client.request("thread/read", {
        threadId,
        includeTurns: true,
      })) as { thread?: { turns?: Array<{ items?: unknown[] }> } } | undefined;
      const items: unknown[] = [];
      for (const turn of res?.thread?.turns ?? []) {
        for (const it of turn.items ?? []) items.push(it);
      }
      return items as import("./CodexMessageAdapter.js").ThreadItem[];
    });
    // Set once the onExit handler has surfaced an unexpected process death,
    // so the done() catch doesn't emit a second (duplicate) error card.
    let crashEmitted = false;
    // Late-bound client handle for the adapter's thread/read bootstrap (the
    // client is constructed below, after the adapter).
    let clientRef: CodexAppServerClient | null = null;
    const client = new CodexAppServerClient({
      codexPath,
      cwd: req.cwd,
      env,
      extraArgs: [
        // Collab spawnAgent threads are spawned by the server itself and do
        // NOT inherit the main thread's model/modelProvider (thread/start and
        // thread/resume overrides apply to the main thread only) — they fall
        // back to the process default, which without this pin is codex's
        // builtin model (gpt-5.6-sol); third-party gateways then reject the
        // unknown name (2026-09-06 实测 DeepSeek 网关 invalid_request_error)。
        // Explicit thread/turn params keep priority for the main thread, and
        // per-turn processes make the pin session-safe (no shared-file races).
        "-c",
        `model=${modelId}`,
        "-c",
        `model_provider=${providerId}`,
        ...(contextWindow ? ["-c", `model_context_window=${contextWindow}`] : []),
      ],
      log: ctx.log,
      onExit: (code, signal) => {
        // Mid-turn process death: no client request is pending, so nothing
        // else rejects the waitTurnDone race — finalize here or the turn
        // hangs forever until the user hits stop.
        ctx.log.error(`codex app-server exited unexpectedly (code=${code ?? "null"} signal=${signal ?? "null"})`);
        crashEmitted = true;
        ctx.emit({
          type: "error",
          sessionId: req.sessionId,
          message: "Codex app-server 进程意外退出,回合已终止。",
          code: "CODEX_APP_SERVER_EXITED",
        });
        if (!ac.signal.aborted && !adapter.hasTurnEnded) adapter.finalizeError();
      },
    });
    clientRef = client;
    if (contextWindow) {
      ctx.log.info(`codex: model "${providerId}/${modelId}" context window override: ${contextWindow}`);
    }

    // Plan-mode state — in-process boolean (synchronous; ctx.getPermissionMode
    // rides async IPC and races). ⚠️ ENFORCEMENT SCOPE: unlike Pi's extension
    // (whose tool_call handler gates EVERY tool), codex's native tools
    // (Bash/apply_patch) never round-trip through us, and the sandbox cannot
    // be downgraded mid-turn — so plan mode here is advisory for sandboxed
    // workspace writes (covered by the AGENTS.md prompt) and user-prompted
    // for sandbox-escaping actions (approvals still surface while active).
    // The boolean drives the plan card/composer chip lifecycle and is reset
    // in the turn finally-block if the turn ends mid-plan.
    const planMode = { active: false };
    // Turn-scoped state the request handlers close over.
    const activeTurn = { threadId: null as string | null, turnId: null as string | null };

    client.handleRequest((frame) =>
      handleServerRequest(frame, {
        ctx,
        req,
        snapshot,
        planMode,
        activeTurn,
      }),
    );
    const unsubscribe = client.onNotification((frame) => adapter.handleNotification(frame));

    // Temp files written for turn-input images (deleted in finally).
    const tempImagePaths: string[] = [];

    let finished = false;
    const done = (async () => {
      try {
        await client.start();

        // Thread identity: resume the persisted thread, or start a new one.
        const threadParams: Record<string, unknown> = {
          cwd: req.cwd,
          sandbox,
          approvalPolicy,
          model: modelId,
          modelProvider: providerId,
          // Experimental (requires initialize capabilities.experimentalApi):
          // register Mcode's host-side tools (ask/plan/browser).
          dynamicTools: buildDynamicTools(browserToolsEnabled),
        };
        let threadId: string | null = null;
        if (req.resumeProviderSessionId) {
          try {
            // ⚠️ turn/start SILENTLY DROPS unknown fields on 0.153.4 — its
            // params have no modelProvider (verified live: an override to a
            // different provider still hit the thread's original endpoint).
            // Provider/model switches across turns MUST ride thread/resume,
            // whose params officially carry model/modelProvider/cwd/sandbox/
            // approvalPolicy as thread configuration overrides.
            const resumed = (await client.request("thread/resume", {
              threadId: req.resumeProviderSessionId,
              excludeTurns: true,
              cwd: req.cwd,
              sandbox,
              approvalPolicy,
              model: modelId,
              modelProvider: providerId,
            })) as { thread?: { id?: string } } | undefined;
            threadId = resumed?.thread?.id ?? null;
          } catch (err) {
            ctx.log.warn(`codex: thread/resume failed (${(err as Error).message}), starting a new thread`);
          }
        }
        if (!threadId) {
          const started = (await client.request("thread/start", threadParams)) as { thread?: { id?: string } } | undefined;
          threadId = started?.thread?.id ?? null;
        }
        if (!threadId) throw new Error("thread/start 未返回 threadId");
        activeTurn.threadId = threadId;
        // Item notifications carry threadId — the adapter routes non-main
        // thread items to the subagent transcript viewer.
        adapter.setMainThreadId(threadId);
        ctx.onProviderSessionId?.(threadId);

        // Register Mcode's skill roots so the model can invoke user/project
        // skills ($name), plus the skills directories of ENABLED plugins
        // (settings → Plugins). Best-effort: failure only means no skills.
        try {
          const { getEnabledPluginSkillRoots } = await import("@main/plugins/pluginManager.js");
          await client.request("skills/extraRoots/set", {
            extraRoots: [...skillRootsFor(req.cwd), ...(await getEnabledPluginSkillRoots())],
          });
        } catch (err) {
          ctx.log.warn(`codex: skills/extraRoots/set failed: ${(err as Error).message}`);
        }

        // Turn input: text + images (local files — codex takes paths, not
        // inline base64).
        const input: Array<Record<string, unknown>> = [
          { type: "text", text: req.prompt },
        ];
        if (req.images?.length) {
          for (const img of req.images) {
            const p = await writeTempImage(img.data, img.mimeType);
            tempImagePaths.push(p);
            input.push({ type: "localImage", path: p });
          }
        }

        // Per-turn overrides: model/effort/sandbox/approvalPolicy are official
        // turn/start params. modelProvider is deliberately NOT sent here —
        // turn/start has no such field and silently drops it (provider
        // switches ride thread/resume above).
        const startedTurn = (await client.request("turn/start", {
          threadId,
          input,
          model: modelId,
          approvalPolicy,
          sandboxPolicy: { type: sandboxPolicyType(mode) },
          ...(req.effort && req.effort !== "default" ? { effort: req.effort } : {}),
        })) as { turn?: { id?: string } } | undefined;
        activeTurn.turnId = startedTurn?.turn?.id ?? null;

        // turn/start returns immediately; the turn's real completion is
        // notification-driven (adapter resolves waitTurnDone on
        // turn/completed). Abort races the wait — on abort we request
        // turn/interrupt and wait for the final state either way.
        const abortedPromise = new Promise<"interrupted">((resolve) => {
          if (ac.signal.aborted) resolve("interrupted");
          else ac.signal.addEventListener("abort", () => resolve("interrupted"), { once: true });
        });
        const reason = await Promise.race([adapter.waitTurnDone(), abortedPromise]);

        if (reason === "interrupted" && activeTurn.turnId) {
          try {
            await client.request("turn/interrupt", { threadId, turnId: activeTurn.turnId });
          } catch {
            /* turn may have completed concurrently */
          }
        }

        // Give the notification pump a short grace to deliver the terminal
        // turn/completed (it may still be in flight right after interrupt).
        await Promise.race([
          adapter.waitTurnDone(),
          new Promise((r) => setTimeout(r, 2000)),
        ]);
        if (!adapter.hasTurnEnded) {
          adapter.finalizeAborted();
        }
        await adapter.flushFinal();
      } catch (err) {
        if (ac.signal.aborted) {
          if (!adapter.hasTurnEnded) adapter.finalizeAborted();
          await adapter.flushFinal();
        } else {
          ctx.log.error(`codex turn failed: ${(err as Error).message}`);
          // A crash already surfaced its own error card via onExit — don't
          // duplicate it with the transport-failure card here.
          if (!crashEmitted) {
            ctx.emit({
              type: "error",
              sessionId: req.sessionId,
              message: (err as Error).message,
              code: "CODEX_SDK_ERROR",
            });
          }
          if (!adapter.hasTurnEnded) adapter.finalizeError();
          await adapter.flushFinal();
        }
      } finally {
        unsubscribe();
        finished = true;
        // The turn ended with the model still in plan mode (interrupt, error,
        // or the model simply stopped without calling exit_plan_mode) — the
        // per-turn planMode closure dies here, so reset the renderer's plan
        // state to match or the composer chip stays stuck on plan.
        if (planMode.active) {
          planMode.active = false;
          ctx.emit({ type: "mode.change", sessionId: req.sessionId, mode: "default", source: "model" });
          ctx.emit({ type: "plan.update", sessionId: req.sessionId, plan: "", phase: "cleared" });
        }
        // Codex takes file paths for turn images — delete the temp copies.
        for (const p of tempImagePaths) {
          try {
            await fs.unlink(p);
          } catch {
            /* best-effort */
          }
        }
        try {
          await client.dispose();
        } catch {
          /* process already gone */
        }
      }
    })();

    return {
      done,
      interrupt: () => {
        ac.abort();
        adapter.markAborted();
      },
      isRunning: () => !finished && !ac.signal.aborted,
    };
  }

  /** Version probe for the settings UI. */
  async healthCheck(): Promise<{ ok: boolean; version?: string; error?: string }> {
    try {
      const codexPath = resolveCodexBinaryPath();
      if (!codexPath) return { ok: false, error: "未找到 Codex(设置 → Agent 可安装)" };
      const r = spawnSync(codexPath, ["--version"], { timeout: 10_000, encoding: "utf-8" });
      if (r.error) return { ok: false, error: r.error.message };
      const version = (r.stdout ?? "").trim().split("\n")[0] || undefined;
      return { ok: r.status === 0 || Boolean(version), version };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
}

/* ── helpers ── */

/** Emit an error + error-reason turn.done and return a dead handle. */
function failTurn(
  ctx: ProviderContext,
  sessionId: string,
  code: string,
  message: string,
): TurnHandle {
  ctx.log.error(`codex: ${message}`);
  ctx.emit({ type: "error", sessionId, message, code });
  ctx.emit({ type: "turn.done", sessionId, reason: "error" });
  return { done: Promise.resolve(), interrupt: () => {}, isRunning: () => false };
}

/** Child env: isolated CODEX_HOME + every configured provider key (the TOML
 *  env_key references pick these up) + inherited PATH/HOME for sandbox
 *  helpers. Keys are decrypted per turn and never persisted. */
async function buildCodexEnv(ctx: ProviderContext): Promise<Record<string, string>> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CODEX_HOME: codexHomePath(),
  };
  const providers = await CodexModelsStore.listPublic();
  for (const p of providers) {
    if (!p.hasApiKey) continue;
    const key = CodexModelsStore.resolveApiKey(p.id);
    if (key) {
      env[codexKeyEnvVar(p.id)] = key;
    } else {
      ctx.log.warn(`codex: failed to decrypt key for provider "${p.id}"`);
    }
  }
  return env;
}

/** Mcode skill roots made visible to codex: the global manager root plus
 *  the project's .claude/skills (same pair the Claude provider exposes via
 *  Options.skills discovery). Only existing dirs are sent. */
function skillRootsFor(cwd: string): string[] {
  const roots = [path.join(homedir(), ".mcode", "skills"), path.join(cwd, ".claude", "skills")];
  return roots.filter((r) => {
    try {
      return statSync(r).isDirectory();
    } catch {
      return false;
    }
  });
}

/** Write CODEX_HOME/AGENTS.md — Codex's global instructions file, which we
 *  own inside the isolated home. Idempotent (writes only on drift). */
async function ensureCodexHomeIdentity(): Promise<void> {
  const dir = codexHomePath();
  await fs.mkdir(dir, { recursive: true });
  const content = `${joinPromptSections(
    CODEX_IDENTITY_PROMPT,
    ASK_NATIVE_TOOL_PROMPT,
    PLAN_MODE_PROMPT,
    browserToolsUsagePrompt(),
    process.platform === "win32" ? WIN32_PATH_HINT : "",
  )}\n`;
  const file = path.join(dir, "AGENTS.md");
  try {
    const prev = await fs.readFile(file, "utf-8");
    if (prev === content) return;
  } catch {
    /* first write */
  }
  await fs.writeFile(file, content, "utf-8");
}

const WIN32_PATH_HINT = [
  `## Windows 路径`,
  `本机 Windows 下 bash 可能运行在 WSL 或 Git Bash 中。写文件时始终使用 Windows 原生路径(如 D:\\workspace\\file.ts);不要使用 /mnt/<drive>/... 形式的路径。`,
].join("\n");

const PLAN_MODE_PROMPT = [
  `## 计划模式工具`,
  `当任务复杂或涉及重要修改时,先制定计划再执行:`,
  `1. 调用 enter_plan_mode 进入计划模式`,
  `2. 使用只读方式充分调研;如需验证可写文件/执行命令,但每个修改操作都需用户审批`,
  `3. 调用 exit_plan_mode({plan: "你的详细计划"}) 提交计划给用户审批`,
  `4. 用户批准后退出计划模式开始执行;拒绝则留在计划模式修改计划`,
  `计划文本应为结构化的 Markdown,包含目标、步骤、影响范围。`,
  `仅当任务复杂、多步或涉及重要修改时才进入计划模式;简单、单步或目标明确的任务直接执行,不要走计划流程。`,
].join("\n");

/** Server→client request routing context. */
interface RequestDeps {
  ctx: ProviderContext;
  req: StartTurnRequest;
  snapshot: CodexFileSnapshot;
  planMode: { active: boolean };
  activeTurn: { threadId: string | null; turnId: string | null };
}

/** Dispatch the server's request frames: approvals, user input, dynamic
 *  tool calls. */
async function handleServerRequest(
  frame: ServerRequestFrame,
  deps: RequestDeps,
): Promise<unknown> {
  const { method, params } = frame;
  const p = (params ?? {}) as Record<string, unknown>;

  // ── Approvals (v2 item/* + legacy aliases) ──
  if (
    method === "item/commandExecution/requestApproval" ||
    method === "execCommandApproval"
  ) {
    return decideApproval(deps, {
      toolName: "Bash",
      input: { command: p.command ?? "" },
      description: typeof p.reason === "string" ? p.reason : undefined,
      p,
    });
  }
  if (
    method === "item/fileChange/requestApproval" ||
    method === "applyPatchApproval"
  ) {
    // NOTE: the params carry only grantRoot (the directory being granted),
    // not per-file paths — pre-turn content reconstruction rides the turn
    // diff (CodexFileSnapshot), not the approval hook.
    return decideApproval(deps, {
      toolName: "file_change",
      input: {
        ...(typeof p.grantRoot === "string" ? { grantRoot: p.grantRoot } : {}),
      },
      description: typeof p.reason === "string" ? p.reason : undefined,
      p,
    });
  }

  // ── Codex-native user input (elicitation) ──
  if (method === "item/tool/requestUserInput") {
    return answerNativeUserInput(p, deps);
  }

  // ── Dynamic tool invocations (our registered host tools) ──
  if (method === "item/tool/call") {
    return invokeDynamicTool(p, deps);
  }

  // Unknown server request — respond with empty result so the server
  // unblocks (calibrate against the generated schema as new kinds appear).
  deps.ctx.log.warn(`codex: unhandled server request "${method}"`);
  return {};
}

/** Shared decision pipeline for both approval kinds. */
async function decideApproval(
  deps: RequestDeps,
  args: {
    toolName: string;
    input: unknown;
    description?: string;
    p: Record<string, unknown>;
  },
): Promise<unknown> {
  const { ctx, req } = deps;
  // Live mode read — a mid-turn mode flip applies to the next approval.
  const mode = normalizeCodexMode(ctx.getPermissionMode?.() ?? req.permissionMode);

  // Full Access maps to approvalPolicy "never" (official semantics: act
  // without asking). The server normally won't ask under that policy; this
  // covers an escalation prompt arriving anyway — auto-accept mirrors "never".
  if (mode === "full-access") {
    return { decision: "accept" };
  }

  const alwaysAllowed = ctx.isToolAlwaysAllowed?.(args.toolName) ?? false;
  if (alwaysAllowed) {
    // Recorded "always allow" — re-affirm the session-scoped server grant.
    return { decision: "acceptForSession" };
  }

  const requestApproval = ctx.requestApproval;
  if (!requestApproval) {
    // No bridge (shouldn't happen) — deny safe.
    return { decision: "decline" };
  }
  const approvalReq: ApprovalRequest = {
    requestId: randomUUID(),
    toolName: args.toolName,
    input: args.input,
    ...(args.description ? { description: args.description } : {}),
  };
  const decision = await requestApproval(approvalReq);

  if (!decision.allow) {
    return { decision: "decline" };
  }
  // Scope the server grant to what the user actually chose: a one-shot
  // approval maps to codex's "accept" (this execution only); "always allow"
  // (persist, recorded host-side by ApprovalBridge) upgrades to
  // acceptForSession so identical actions stop prompting for this thread.
  return { decision: decision.persist ? "acceptForSession" : "accept" };
}

/** Codex's native user-input request ({questions: [{title, options?}]},
 *  answers keyed by question title). Bridges to the same renderer question
 *  card as our dynamic ask_user_question tool. */
async function answerNativeUserInput(p: Record<string, unknown>, deps: RequestDeps): Promise<unknown> {
  const { ctx } = deps;
  const requestUserInput = ctx.requestUserInput;
  const rawQuestions = Array.isArray(p.questions) ? p.questions : [];
  const questions = rawQuestions.map((q) => {
    const obj = (q ?? {}) as { title?: string; options?: string[] | null };
    const title = typeof obj.title === "string" ? obj.title : "问题";
    return {
      header: title.slice(0, 20),
      question: title,
      multiSelect: false,
      options: (obj.options ?? []).filter((o): o is string => typeof o === "string").map((label) => ({ label })),
    };
  });
  if (!requestUserInput || questions.length === 0) {
    return { answers: {} };
  }
  const decision = await requestUserInput({ requestId: randomUUID(), questions });
  if (decision.dismissed) {
    return { answers: {} };
  }
  // answers: {[questionTitle]: {answers: string[]}}
  const out: Record<string, { answers: string[] }> = {};
  for (const q of questions) {
    const v = decision.answers[q.question];
    if (v == null) continue;
    out[q.question] = { answers: Array.isArray(v) ? v : [String(v)] };
  }
  return { answers: out };
}

/* ── dynamic tools ── */

/** JSON-schema function descriptors handed to thread/start. Names use
 *  snake_case (codex tool conventions). */
function buildDynamicTools(browserToolsEnabled: boolean): Array<Record<string, unknown>> {
  const tools: Array<Record<string, unknown>> = [
    {
      type: "function",
      name: "ask_user_question",
      description:
        "Ask the user a question when you need information or a decision. " +
        "Provide a clear question and 2-4 options. After calling this tool, STOP and wait for the answer.",
      inputSchema: {
        type: "object",
        properties: {
          questions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                header: { type: "string", description: "A short label for the question" },
                question: { type: "string", description: "The full question text" },
                multiSelect: { type: "boolean", description: "Whether multiple options can be selected" },
                options: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      label: { type: "string" },
                      description: { type: "string" },
                    },
                    required: ["label"],
                  },
                },
              },
              required: ["header", "question", "multiSelect", "options"],
            },
          },
        },
        required: ["questions"],
      },
    },
    {
      type: "function",
      name: "enter_plan_mode",
      description:
        "进入计划模式:先只读调研、必要时经用户逐项审批做验证,然后用 exit_plan_mode 提交计划。",
      inputSchema: { type: "object", properties: {} },
    },
    {
      type: "function",
      name: "exit_plan_mode",
      description:
        "提交你的执行计划给用户审批。批准后退出计划模式开始执行;拒绝则留在计划模式修改计划。",
      inputSchema: {
        type: "object",
        properties: {
          plan: { type: "string", description: "完整的执行计划(Markdown),包含目标、步骤、影响范围" },
        },
        required: ["plan"],
      },
    },
  ];
  // Browser tools (read-only trio + side-effect ones) — descriptions come
  // from the shared spec so Claude/Pi/Codex stay in sync. Gated by the MCP
  // panel's builtin-browser switch (same flag Claude's in-process MCP server
  // uses).
  if (!browserToolsEnabled) return tools;
  const schema = (props: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
    type: "object",
    properties: props,
    ...(required.length ? { required } : {}),
  });
  const optId = { type: "string", description: "目标浏览器视图 id;省略则用第一个已开视图" };
  tools.push(
    {
      type: "function",
      name: "browser_list",
      description: BROWSER_TOOL_SPECS.browser_list.description,
      inputSchema: schema({}),
    },
    {
      type: "function",
      name: "browser_navigate",
      description: BROWSER_TOOL_SPECS.browser_navigate.description,
      inputSchema: schema({
        url: { type: "string", description: "目标 URL,http(s):// 网页或 file:/// 本地文件" },
        device: { type: "string", enum: ["desktop", "iphone", "android"], description: "设备仿真档位,默认 desktop" },
        browserId: optId,
      }, ["url"]),
    },
    {
      type: "function",
      name: "browser_snapshot",
      description: BROWSER_TOOL_SPECS.browser_snapshot.description,
      inputSchema: schema({ browserId: optId }),
    },
    {
      type: "function",
      name: "browser_click",
      description: BROWSER_TOOL_SPECS.browser_click.description,
      inputSchema: schema({
        index: { type: "number", description: "要点击元素的索引(来自最近一次 browser_snapshot 的 [n]),优先使用" },
        selector: { type: "string", description: "要点击元素的 CSS selector(index 的替代写法)" },
        coordinateX: { type: "number", description: "视口坐标点击的 X(canvas 等无 selector 元素用)" },
        coordinateY: { type: "number", description: "视口坐标点击的 Y" },
        browserId: optId,
      }),
    },
    {
      type: "function",
      name: "browser_type",
      description: BROWSER_TOOL_SPECS.browser_type.description,
      inputSchema: schema({
        index: { type: "number", description: "目标输入元素的索引(来自最近一次 browser_snapshot),优先使用" },
        selector: { type: "string", description: "目标输入元素的 CSS selector(index 的替代写法)" },
        text: { type: "string", description: "要输入的文本内容;空串=清空字段" },
        clear: { type: "boolean", description: "true(默认)=清空后输入;false=追加" },
        browserId: optId,
      }, ["text"]),
    },
    {
      type: "function",
      name: "browser_keys",
      description: BROWSER_TOOL_SPECS.browser_keys.description,
      inputSchema: schema({
        keys: { type: "string", description: '按键或组合键,如 "Enter" / "Escape" / "Control+a" / "Shift+Enter"' },
        browserId: optId,
      }, ["keys"]),
    },
    {
      type: "function",
      name: "browser_scroll",
      description: BROWSER_TOOL_SPECS.browser_scroll.description,
      inputSchema: schema({
        direction: { type: "string", enum: ["up", "down"], description: "滚动方向" },
        pages: { type: "number", description: "滚动量(单位=视口高,默认 1;10≈滚到底)" },
        selector: { type: "string", description: "改为滚动该元素内部的滚动区" },
        browserId: optId,
      }, ["direction"]),
    },
    {
      type: "function",
      name: "browser_wait",
      description: BROWSER_TOOL_SPECS.browser_wait.description,
      inputSchema: schema({
        selector: { type: "string", description: "等待该 CSS selector 元素出现" },
        text: { type: "string", description: "等待该文本出现在页面中" },
        seconds: { type: "number", description: "固定等待秒数" },
        timeoutSeconds: { type: "number", description: "等待超时(默认 10,上限 30)" },
        browserId: optId,
      }),
    },
    {
      type: "function",
      name: "browser_history",
      description: BROWSER_TOOL_SPECS.browser_history.description,
      inputSchema: schema({
        action: { type: "string", enum: ["back", "forward", "reload"], description: "后退/前进/刷新" },
        browserId: optId,
      }, ["action"]),
    },
    {
      type: "function",
      name: "browser_select",
      description: BROWSER_TOOL_SPECS.browser_select.description,
      inputSchema: schema({
        index: { type: "number", description: "下拉框元素的索引(来自最近一次 browser_snapshot),优先使用" },
        selector: { type: "string", description: "下拉框元素的 CSS selector(index 的替代写法)" },
        value: { type: "string", description: "选项的 value 或精确可见文本" },
        browserId: optId,
      }, ["value"]),
    },
    {
      type: "function",
      name: "browser_find",
      description: BROWSER_TOOL_SPECS.browser_find.description,
      inputSchema: schema({
        selector: { type: "string", description: "按 CSS 查询元素(与 text 二选一)" },
        text: { type: "string", description: "在页面文本中搜索(与 selector 二选一)" },
        regex: { type: "boolean", description: "text 按正则解释(默认字面)" },
        caseSensitive: { type: "boolean", description: "区分大小写(默认不区分)" },
        contextChars: { type: "number", description: "文本匹配的上下文字符数(默认 150)" },
        maxResults: { type: "number", description: "最多返回条数(默认 25)" },
        attributes: { type: "array", items: { type: "string" }, description: 'selector 模式下要提取的属性,如 ["href","src"]' },
        cssScope: { type: "string", description: "把查找范围限定在该 CSS selector 内" },
        browserId: optId,
      }),
    },
    {
      type: "function",
      name: "browser_switch_tab",
      description: BROWSER_TOOL_SPECS.browser_switch_tab.description,
      inputSchema: schema({
        browserId: { type: "string", description: "要切换到的浏览器视图 id(browser_list 查询)" },
      }, ["browserId"]),
    },
    {
      type: "function",
      name: "browser_close_tab",
      description: BROWSER_TOOL_SPECS.browser_close_tab.description,
      inputSchema: schema({
        browserId: { type: "string", description: "要关闭的浏览器视图 id" },
      }, ["browserId"]),
    },
    {
      type: "function",
      name: "browser_upload_file",
      description: BROWSER_TOOL_SPECS.browser_upload_file.description,
      inputSchema: schema({
        index: { type: "number", description: "文件输入框元素的索引(来自最近一次 browser_snapshot),优先使用" },
        selector: { type: "string", description: '文件输入框元素的 CSS selector(index 的替代写法)' },
        paths: {
          type: "array",
          items: { type: "string" },
          description: "要上传的本地文件路径数组(绝对路径,或相对项目根的路径)",
        },
        browserId: optId,
      }, ["paths"]),
    },
    {
      type: "function",
      name: "browser_save_pdf",
      description: BROWSER_TOOL_SPECS.browser_save_pdf.description,
      inputSchema: schema({
        fileName: { type: "string", description: "保存的文件名(不含路径;省略则按时间戳命名)" },
        paperFormat: { type: "string", enum: ["letter", "legal", "tabloid", "a3", "a4", "a5"], description: "纸张格式,默认 a4" },
        landscape: { type: "boolean", description: "横向(默认纵向)" },
        printBackground: { type: "boolean", description: "是否打印背景色/图(默认 true)" },
        scale: { type: "number", description: "缩放 0.1-2(默认 1)" },
        headerFooter: { type: "boolean", description: "显示页眉页脚(默认 false)" },
        browserId: optId,
      }),
    },
    {
      type: "function",
      name: "browser_downloads",
      description: BROWSER_TOOL_SPECS.browser_downloads.description,
      inputSchema: schema({}),
    },
    {
      type: "function",
      name: "browser_evaluate",
      description: BROWSER_TOOL_SPECS.browser_evaluate.description,
      inputSchema: schema({
        script: { type: "string", description: "要在页面中执行的 JavaScript 代码" },
        browserId: optId,
      }, ["script"]),
    },
    {
      type: "function",
      name: "browser_screenshot",
      description: BROWSER_TOOL_SPECS.browser_screenshot.description,
      inputSchema: schema({
        browserId: optId,
        fullPage: { type: "boolean", description: "true=截整页(含滚动外内容)" },
      }),
    },
  );
  return tools;
}

/** Execute a dynamic-tool invocation from the server against host bridges. */
async function invokeDynamicTool(p: Record<string, unknown>, deps: RequestDeps): Promise<unknown> {
  const name = typeof p.tool === "string" ? p.tool : typeof p.name === "string" ? p.name : "";
  const args = (p.arguments ?? p.args ?? {}) as Record<string, unknown>;
  const { ctx, req, planMode } = deps;
  const text = (t: string): unknown => ({ success: true, contentItems: [{ type: "inputText", text: t }] });
  const fail = (t: string): unknown => ({ success: false, contentItems: [{ type: "inputText", text: t }] });

  try {
    switch (name) {
      case "ask_user_question": {
        const requestUserInput = ctx.requestUserInput;
        if (!requestUserInput) return text("提问不可用");
        const questions = parseQuestions(args);
        if (questions.length === 0) return text("参数格式错误:未解析出有效问题");
        const decision = await requestUserInput({
          requestId: randomUUID(),
          questions,
        });
        if (decision.dismissed) {
          return text("用户关闭了提问,未提供答案,请继续当前任务");
        }
        return text(formatAnswersForModel(decision.answers, questions));
      }
      case "enter_plan_mode": {
        planMode.active = true;
        ctx.emit({ type: "mode.change", sessionId: req.sessionId, mode: "plan", source: "model" });
        ctx.emit({ type: "plan.update", sessionId: req.sessionId, plan: "", phase: "drafting" });
        return text(
          "已进入计划模式。请只读调研(必要时经审批验证),完成后调用 exit_plan_mode 提交计划。",
        );
      }
      case "exit_plan_mode": {
        const plan = typeof args.plan === "string" ? args.plan : "";
        ctx.emit({ type: "plan.update", sessionId: req.sessionId, plan, phase: "ready" });
        const requestPlanApproval = ctx.requestPlanApproval;
        if (!requestPlanApproval) {
          planMode.active = false;
          ctx.emit({ type: "mode.change", sessionId: req.sessionId, mode: "default", source: "model" });
          return text("计划审批不可用,已自动退出计划模式。");
        }
        try {
          const decision = await requestPlanApproval({ requestId: randomUUID(), plan });
          if (decision.approved) {
            const finalPlan = decision.editedPlan ?? plan;
            planMode.active = false;
            ctx.emit({ type: "mode.change", sessionId: req.sessionId, mode: "default", source: "model" });
            const feedback = decision.feedback?.trim();
            return text(`计划已批准,开始执行:\n\n${finalPlan}${feedback ? `\n\n用户调整意见:${feedback}` : ""}`);
          }
          const reason = decision.reason ?? "用户未提供理由";
          ctx.emit({ type: "plan.update", sessionId: req.sessionId, plan, phase: "drafting" });
          return text(`计划被用户拒绝。原因:${reason}。你仍处于计划模式,请修改计划后重新调用 exit_plan_mode。`);
        } catch (err) {
          planMode.active = false;
          ctx.emit({ type: "plan.update", sessionId: req.sessionId, plan: "", phase: "cleared" });
          ctx.emit({ type: "mode.change", sessionId: req.sessionId, mode: "default", source: "model" });
          throw err;
        }
      }
      case "browser_list":
        return toContent(browserList());
      case "browser_navigate":
        return toContent(
          await browserNavigate(
            {
              url: String(args.url ?? ""),
              browserId: optStr(args.browserId),
              device: optDevice(args.device),
              newTab: args.newTab === true,
            },
            req.cwd,
          ),
        );
      case "browser_snapshot":
        return toContent(await browserSnapshot({ browserId: optStr(args.browserId) }));
      case "browser_click":
        return toContent(
          await browserClick({
            index: typeof args.index === "number" ? args.index : undefined,
            selector: optStr(args.selector),
            coordinateX: typeof args.coordinateX === "number" ? args.coordinateX : undefined,
            coordinateY: typeof args.coordinateY === "number" ? args.coordinateY : undefined,
            browserId: optStr(args.browserId),
          }),
        );
      case "browser_type":
        return toContent(
          await browserType({
            index: typeof args.index === "number" ? args.index : undefined,
            selector: optStr(args.selector),
            text: typeof args.text === "string" ? args.text : "",
            clear: args.clear !== false,
            browserId: optStr(args.browserId),
          }),
        );
      case "browser_keys":
        return toContent(
          await browserKeys({ keys: String(args.keys ?? ""), browserId: optStr(args.browserId) }),
        );
      case "browser_scroll":
        return toContent(
          await browserScroll({
            direction: args.direction === "up" ? "up" : "down",
            pages: typeof args.pages === "number" ? args.pages : undefined,
            selector: optStr(args.selector),
            browserId: optStr(args.browserId),
          }),
        );
      case "browser_wait":
        return toContent(
          await browserWait({
            selector: optStr(args.selector),
            text: optStr(args.text),
            seconds: typeof args.seconds === "number" ? args.seconds : undefined,
            timeoutSeconds: typeof args.timeoutSeconds === "number" ? args.timeoutSeconds : undefined,
            browserId: optStr(args.browserId),
          }),
        );
      case "browser_history":
        return toContent(
          await browserHistory({
            action: args.action as "back" | "forward" | "reload",
            browserId: optStr(args.browserId),
          }),
        );
      case "browser_select":
        return toContent(
          await browserSelect({
            index: typeof args.index === "number" ? args.index : undefined,
            selector: optStr(args.selector),
            value: String(args.value ?? ""),
            browserId: optStr(args.browserId),
          }),
        );
      case "browser_find":
        return toContent(
          await browserFind({
            selector: optStr(args.selector),
            text: optStr(args.text),
            regex: args.regex === true,
            caseSensitive: args.caseSensitive === true,
            contextChars: typeof args.contextChars === "number" ? args.contextChars : undefined,
            maxResults: typeof args.maxResults === "number" ? args.maxResults : undefined,
            attributes: Array.isArray(args.attributes)
              ? (args.attributes as unknown[]).filter((a): a is string => typeof a === "string")
              : undefined,
            cssScope: optStr(args.cssScope),
            browserId: optStr(args.browserId),
          }),
        );
      case "browser_switch_tab":
        return toContent(await browserSwitchTab({ browserId: String(args.browserId ?? "") }));
      case "browser_close_tab":
        return toContent(await browserCloseTab({ browserId: String(args.browserId ?? "") }));
      case "browser_upload_file":
        return toContent(
          await browserUploadFile(
            {
              index: typeof args.index === "number" ? args.index : undefined,
              selector: optStr(args.selector),
              paths: args.paths,
              browserId: optStr(args.browserId),
            },
            req.cwd,
          ),
        );
      case "browser_save_pdf":
        return toContent(
          await browserSavePdf(
            {
              fileName: optStr(args.fileName),
              paperFormat: optStr(args.paperFormat),
              landscape: args.landscape === true,
              printBackground: args.printBackground !== false,
              scale: typeof args.scale === "number" ? args.scale : undefined,
              headerFooter: args.headerFooter === true,
              browserId: optStr(args.browserId),
            },
            {
              toolCallId: typeof p.callId === "string" ? p.callId : randomUUID(),
              sessionId: req.sessionId,
              turnNumber: req.turnNumber,
            },
          ),
        );
      case "browser_downloads":
        return toContent(browserDownloads());
      case "browser_evaluate":
        return toContent(
          await browserEvaluate({ script: String(args.script ?? ""), browserId: optStr(args.browserId) }),
        );
      case "browser_screenshot": {
        const r = await browserScreenshot(
          { browserId: optStr(args.browserId), fullPage: args.fullPage === true },
          {
          toolCallId: typeof p.callId === "string" ? p.callId : randomUUID(),
          sessionId: req.sessionId,
          turnNumber: req.turnNumber,
          onImage: (info) => {
            ctx.emit({
              type: "browser.image",
              sessionId: req.sessionId,
              toolCallId: info.toolCallId,
              data: info.data,
              mimeType: info.mimeType,
            });
          },
        });
        return toContent(r);
      }
      default:
        return fail(`未知工具:${name}`);
    }
  } catch (err) {
    return fail(`工具执行失败:${(err as Error).message}`);
  }
}

/** Shared ToolResult (TextBlock|ImageBlock) → dynamic-tool response. */
function toContent(r: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; details?: unknown }): unknown {
  return {
    success: true,
    contentItems: r.content.map((b) =>
      b.type === "image"
        ? { type: "inputImage", imageUrl: `data:${b.mimeType ?? "image/png"};base64,${b.data ?? ""}` }
        : { type: "inputText", text: b.text ?? "" },
    ),
  };
}

function optStr(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

function optDevice(v: unknown): "desktop" | "iphone" | "android" | undefined {
  return v === "iphone" || v === "android" || v === "desktop" ? v : undefined;
}

/** Persist a base64 image to a temp file for turn input (codex takes file
 *  paths for local images, not inline base64). */
async function writeTempImage(base64: string, mimeType: string): Promise<string> {
  const ext = mimeType.includes("jpeg") ? "jpg" : mimeType.includes("webp") ? "webp" : mimeType.includes("gif") ? "gif" : "png";
  const file = path.join(tmpdir(), `mcode-codex-${randomUUID()}.${ext}`);
  await fs.writeFile(file, Buffer.from(base64, "base64"));
  return file;
}
