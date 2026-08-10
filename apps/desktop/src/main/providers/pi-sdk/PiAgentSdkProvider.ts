/**
 * Pi Agent SDK provider — wraps createAgentSession() from
 * @earendil-works/pi-coding-agent and implements the AgentProvider interface
 * from @contracts/provider.
 *
 * ## How Pi differs from Claude
 *   - Event model: subscribe(listener) callback stream, not an async iterator.
 *   - Turn drive: session.prompt(text) resolves when the run completes; the
 *     model streams via events.
 *   - Thinking levels: off/minimal/low/medium/high/xhigh (+ our "default"
 *     sentinel) — wider than Claude's 6.
 *   - Approval: Pi has no `canUseTool` callback. Instead we inject an inline
 *     Extension (`mcodeExtension.ts`) whose `tool_call` handler is the Pi
 *     equivalent — it can block a tool with `{ block: true, reason }` (the
 *     agent loop converts a block into an `isError` tool result the model
 *     reacts to). The same handler enforces the strict in-project path/command
 *     guard and routes to the host's IPC approval bridge.
 *   - AskUserQuestion: no native tool. The extension registers one via
 *     `pi.registerTool`; its `execute` bridges to `ctx.requestUserInput`.
 *   - System prompt: the extension's `before_agent_start` handler appends the
 *     AskUserQuestion usage hint (loader `appendSystemPrompt` carries the
 *     static Windows path hint separately).
 *   - Model selection: provider/id strings via ModelRuntime; we build our
 *     own ModelRuntime each turn and inject configured API keys via
 *     `modelRuntime.setRuntimeApiKey(provider, key)` (top of the auth
 *     priority chain — overrides ~/.pi/agent/auth.json and env vars).
 *   - Session resume: SessionManager JSONL files. We stash the pi session
 *     file path in the GUI session's `claudeSessionId` field (already the
 *     generic "provider session id" slot).
 *
 * Lazy-loads the SDK module so the (large) package and its transitive deps
 * stay out of the main-process startup path — same pattern as
 * ClaudeAgentSdkProvider and TerminalManager.
 */
import type { AgentProvider, StartTurnRequest, ProviderContext, TurnHandle, ProviderCapabilities } from "@contracts/provider";
import { PiMessageAdapter } from "./PiMessageAdapter.js";
import { PiModelsStore } from "@main/lib/piModelsStore.js";
import { loadPiSdk } from "./piSdkLoader.js";
import { buildPiTokenSnapshot } from "./piTokenUsage.js";
import { buildPiSkillLoader, rewriteSkillPrefix, createMntNormalizingReadTool } from "./piSkillBridge.js";
import { createMcodeExtension } from "./mcodeExtension.js";
import { getFileSnapshot } from "@main/lib/fileSnapshotRegistry.js";

/** Pi's permission modes, shown in the composer dropdown. Pi has no native
 *  permission system — the inline extension's `tool_call` handler interprets
 *  these at runtime (see `shouldAutoApproveForPi` in mcodeExtension.ts). The
 *  semantics match Claude's (the same 4 user-facing modes, same icons/colors),
 *  so users get a consistent experience across providers. `dontAsk`/`auto` are
 *  intentionally not surfaced (same as Claude) but still work if set. */
const PI_PERMISSION_MODES = [
  { value: "default", label: "Default", icon: "shield", hint: "标准行为,工具按规则触发审批" },
  { value: "acceptEdits", label: "Edit Auto", icon: "shieldCheck", color: "text-warning", hint: "工作目录内的文件编辑自动放行" },
  { value: "plan", label: "Plan", icon: "shieldHalf", color: "text-info", hint: "只读探索,所有写操作都需审批" },
  { value: "bypassPermissions", label: "Bypass", icon: "shieldLock", color: "text-danger", hint: "跳过所有权限检查(慎用)" },
];

export class PiAgentSdkProvider implements AgentProvider {
  readonly id = "pi-sdk";
  readonly displayName = "Pi";
  readonly capabilities: ProviderCapabilities = {
    // The inline extension's `tool_call` handler is the Pi equivalent of
    // canUseTool: it can block tools and routes to the host's IPC approval
    // bridge. See mcodeExtension.ts.
    supportsApproval: true,
    supportsResume: true, // SessionManager.continueRecent / open
    supportsStreaming: true, // subscribe() event stream
    supportsMcp: false, // Pi uses extensions, not MCP servers
    // The inline extension registers a native AskUserQuestion tool via
    // pi.registerTool; its execute bridges to ctx.requestUserInput. See
    // mcodeExtension.ts.
    supportsAskUserQuestion: true,
    // Declarative descriptors — the renderer's dynamic dropdowns read these.
    thinkingLevels: [
      { value: "default", label: "Auto", hint: "让 Pi 自选" },
      { value: "off", label: "Off", hint: "关闭思考" },
      { value: "minimal", label: "Minimal", hint: "极少思考" },
      { value: "low", label: "Low", hint: "快速" },
      { value: "medium", label: "Med", hint: "平衡" },
      { value: "high", label: "High", hint: "更多思考" },
      { value: "xhigh", label: "XHigh", hint: "深度思考" },
      { value: "max", label: "Max", hint: "最充分,最慢" },
    ],
    // Pi has no native permission modes — these are interpreted at runtime by
    // the extension's tool_call handler (shouldAutoApproveForPi).
    permissionModes: PI_PERMISSION_MODES,
    builtinModels: [], // MVP: models come from ~/.pi/agent/models.json discovery
    supportsCustomEndpoint: false, // Pi manages its own models.json
  };

  async startTurn(req: StartTurnRequest, ctx: ProviderContext): Promise<TurnHandle> {
    const sdk = await loadPiSdk();
    const ac = new AbortController();

    // Resolve the resume target: the persisted pi session file (if any).
    // We reuse the generic provider-session-id slot (`claudeSessionId`) which
    // RuntimeManager passes as `resumeProviderSessionId`. For pi this value is
    // the session file path.
    let sessionManager;
    if (req.resumeProviderSessionId) {
      try {
        sessionManager = sdk.SessionManager.open(req.resumeProviderSessionId);
      } catch (err) {
        ctx.log.warn(`pi: failed to open session file ${req.resumeProviderSessionId}, starting fresh: ${(err as Error).message}`);
        sessionManager = sdk.SessionManager.create(req.cwd);
      }
    } else {
      sessionManager = sdk.SessionManager.create(req.cwd);
    }

    // Tools allowlist. We do NOT restrict tools by permission mode here.
    // Pi has no native permission-mode state machine (unlike Claude, whose SDK
    // exits plan mode and restores the tool set after ExitPlanMode approval).
    // The `tools` allowlist is fixed at session creation — if we gated write/
    // edit/bash out under plan mode, they'd STAY gated out after the user
    // approves the plan (the model would see "no edit/write tools available"
    // even though planMode.active is now false).
    //
    // Instead, ALL tools are always available. The extension's `tool_call`
    // handler enforces the plan-mode read-only gate dynamically via the
    // in-process `planMode.active` flag: while in plan mode, write/edit/bash
    // are blocked with a clear reason; after ExitPlanMode approval, the flag
    // flips and they pass through immediately. This is the only correct way
    // to handle the "plan mode → approve → execute" lifecycle on Pi.
    const tools = undefined; // all built-in + extension tools
    // guard): deny writes outside the project working directory, except in
    // bypassPermissions/dontAsk where the user opted out of all checks. WSL
    // paths are normalized in every mode. Enforced by the extension's
    // tool_call handler (see mcodeExtension.ts).
    const strict = !(req.permissionMode === "bypassPermissions" || req.permissionMode === "dontAsk");

    // Build a ModelRuntime that injects all configured API keys. Pi's
    // setRuntimeApiKey stores the key at the top of the auth priority chain
    // (above ~/.pi/agent/auth.json and env vars), so the user's GUI-configured
    // key is authoritative. Keys are decrypted from the safeStorage-backed
    // map on every turn (one-shot, never persisted in this process).
    const modelRuntime = await sdk.ModelRuntime.create();
    try {
      const publicProviders = await PiModelsStore.listPublic();
      for (const [name, pub] of Object.entries(publicProviders)) {
        if (!pub.hasApiKey) continue;
        const key = PiModelsStore.resolveApiKey(name);
        if (key) {
          await modelRuntime.setRuntimeApiKey(name, key);
        }
      }
    } catch (err) {
      // Don't abort the turn on key-loading errors — the user may have an
      // env-var fallback. Log and proceed.
      ctx.log.warn(`pi: failed to load API keys (continuing without): ${(err as Error).message}`);
    }

    // Resolve the model the user picked in the composer. Pi model ids are
    // "providerId/modelId" (see projectModel in ipc/piModels.ts); pi SDK's
    // createAgentSession takes a Model object, not a string, so we look it up
    // via the same runtime that already has the user's keys injected. When the
    // id is absent ("default" / unset / malformed / unknown to the runtime),
    // we fall back to pi's default — letting the SDK pick from settings/env,
    // exactly the pre-selection behavior.
    let resolvedModel: ReturnType<typeof modelRuntime.getModel> | undefined;
    if (req.model && req.model !== "default") {
      const slashIdx = req.model.indexOf("/");
      if (slashIdx > 0 && slashIdx < req.model.length - 1) {
        const providerName = req.model.slice(0, slashIdx);
        const modelId = req.model.slice(slashIdx + 1);
        try {
          resolvedModel = modelRuntime.getModel(providerName, modelId);
          if (!resolvedModel) {
            ctx.log.warn(`pi: model "${req.model}" not found in runtime, falling back to default`);
          }
        } catch (err) {
          ctx.log.warn(`pi: failed to resolve model "${req.model}": ${(err as Error).message}`);
        }
      }
    }

    // Build the inline Mcode extension — bridges host approval,
    // AskUserQuestion, system-prompt injection, and the strict in-project
    // path/command guard into the Pi agent via the SDK's extension API. See
    // mcodeExtension.ts for why an extension (vs the old customTools wrapping)
    // is the right vehicle: the `tool_call` event covers ALL tools, and
    // `block:true`+`reason` is the Pi equivalent of Claude's canUseTool deny.
    const mcodeExtension = createMcodeExtension({ ctx, cwd: req.cwd, strict, sessionId: req.sessionId, projectPath: req.cwd, turnNumber: req.turnNumber });

    // Bridge Mcode's skill roots + `/name` trigger into Pi's skill model, and
    // inject the inline extension via the loader's `extensionFactories`. Pi's
    // DefaultResourceLoader otherwise scans only ~/.pi/agent/skills + <cwd>/.pi
    // /skills (CONFIG_DIR_NAME=".pi"), which never overlap with Mcode's
    // ~/.mcode/skills + <cwd>/.claude/skills — so skills silently no-op. The
    // loader also narrows the discovered set to `req.skills` (Claude's allowlist
    // analogue, since Pi has no `Options.skills` equivalent). See
    // piSkillBridge.ts for the full rationale.
    const skillLoader = await buildPiSkillLoader({
      sdk,
      cwd: req.cwd,
      allowNames: req.skills && req.skills.length > 0 ? req.skills : undefined,
      extensionFactories: [mcodeExtension],
    });

    // customTools override built-ins by name in AgentSession's definition
    // registry. Only the win32 read override remains — skills legitimately
    // reference files outside the project (under ~/.mcode/skills), and the
    // model rewrites the injected Windows paths to /mnt/c/... which the SDK's
    // read tool can't resolve. The override is read-only so it carries no
    // in-project containment check — only the WSL translation.
    // The write/edit/bash guards moved to the extension's tool_call handler.
    const customTools = process.platform === "win32"
      ? [createMntNormalizingReadTool(sdk, req.cwd)]
      : [];

    const { session } = await sdk.createAgentSession({
      cwd: req.cwd,
      thinkingLevel: req.effort && req.effort !== "default" ? (req.effort as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max") : undefined,
      tools,
      customTools,
      sessionManager,
      modelRuntime,
      // Custom loader: SDK skips its own default construction AND does not call
      // reload() on ours (we already reloaded in buildPiSkillLoader). The
      // loader also carries the Windows path system-prompt hint (win32 only).
      resourceLoader: skillLoader,
      ...(resolvedModel ? { model: resolvedModel } : {}),
    });

    // Rewrite a leading `/name` (composer pill serialization) to Pi's
    // `/skill:name` trigger for names the loader actually resolved, so Pi's
    // `_expandSkillCommand` (which only recognizes the `/skill:` prefix)
    // expands the skill body instead of shipping the literal `/name` to the
    // LLM. Names are the allowlist-filtered set, matching what Pi's internal
    // `find(s => s.name === skillName)` will search.
    const knownSkillNames = new Set(skillLoader.getSkills().skills.map((s) => s.name));
    const promptText = rewriteSkillPrefix(req.prompt, knownSkillNames);

    // Register the pi session id with the host so it can be persisted and
    // resumed next turn.
    ctx.onProviderSessionId?.(session.sessionFile ?? session.sessionId);

    // Snapshot provider for the turn-end token-usage emit. Reads the SDK's
    // already-normalized context-usage + cumulative session stats and maps them
    // onto our provider-neutral ContextSnapshot. The adapter calls this at
    // agent_end (BEFORE turn.done) so the runtime appends a usage-history
    // record. `session.model` carries the resolved model id (provider/model);
    // getSessionStats / getContextUsage never throw on a healthy session, but
    // the adapter still guards against a thrown read.
    const modelId = session.model?.id ?? req.model;
    const provideTokenSnapshot = () => {
      let ctxUsage, stats;
      try {
        ctxUsage = session.getContextUsage();
        stats = session.getSessionStats();
      } catch {
        // Session torn down / mid-dispose — nothing to report this turn.
        return undefined;
      }
      return buildPiTokenSnapshot(ctxUsage, stats, modelId);
    };

    // Per-session file snapshot for the "本轮修改" card + 撤销本轮 (rewind) —
    // shared with the Claude provider via the snapshot registry. The
    // extension's tool_call handler records pre-turn content (recordPre);
    // flushFinal() below freezes it into a `turn.files` event at turn end.
    // RuntimeManager clears it at the start of every sendTurn (provider-
    // agnostic), so consecutive turns never leak into each other's snapshot.
    const snapshot = getFileSnapshot(req.sessionId);

    const adapter = new PiMessageAdapter(ctx, req.sessionId, provideTokenSnapshot, snapshot);
    const unsubscribe = session.subscribe((event) => {
      adapter.dispatch(event);
    });

    let finished = false;
    const done = (async () => {
      try {
        // session.prompt resolves when the agent finishes processing the
        // prompt (including retries). Streaming events arrive via subscribe.
        // `promptText` carries the `/skill:name`-rewritten leading token so Pi
        // expands an embedded skill pill (see rewriteSkillPrefix above).
        await session.prompt(promptText);
        // End-of-turn finalization: freeze the file snapshot and emit
        // `turn.files` (the "本轮修改" card). agent_end has already emitted
        // turn.done inside the subscribe stream; turn.files arriving after it
        // is expected — the renderer's turn.files handler is written for that
        // ordering (same shape as Claude's flushFinal).
        await adapter.flushFinal();
      } catch (err) {
        // A user-initiated abort makes prompt() reject.
        if (ac.signal.aborted) {
          // Still run the end-of-turn finalization so partially-written files
          // surface on the "本轮修改" card and can be rewound — mirrors
          // ClaudeAgentSdkProvider's abort path, which also calls flushFinal.
          await adapter.flushFinal();
          ctx.emit({
            type: "turn.done",
            sessionId: req.sessionId,
            reason: "interrupted",
          });
        } else {
          ctx.log.error(`pi SDK error: ${(err as Error).message}`);
          ctx.emit({
            type: "error",
            sessionId: req.sessionId,
            message: (err as Error).message,
            code: "PI_SDK_ERROR",
          });
          ctx.emit({
            type: "turn.done",
            sessionId: req.sessionId,
            reason: "error",
          });
        }
      } finally {
        unsubscribe();
        session.dispose();
        finished = true;
      }
    })();

    return {
      done,
      interrupt: async () => {
        ac.abort();
        try {
          await session.abort();
        } catch {
          /* ignore */
        }
      },
      isRunning: () => !finished && !ac.signal.aborted,
    };
  }

  async healthCheck(): Promise<{ ok: boolean; version?: string; error?: string }> {
    try {
      const sdk = await loadPiSdk();
      // A minimal in-memory session creation probes whether the SDK can boot
      // with the current cwd and discover models. We don't send a prompt —
      // just verify the factory works.
      const { session } = await sdk.createAgentSession({
        sessionManager: sdk.SessionManager.inMemory(),
      });
      session.dispose();
      return { ok: true, version: (sdk as { VERSION?: string }).VERSION };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
}
