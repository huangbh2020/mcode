/**
 * Stubs for every runtime dependency of ipc/orchestrator.ts that the clamp
 * smoke must not pull in (electron, SQLite, SDK, provider SDKs). One module,
 * aliased to many specifiers — see run.sh.
 *
 * The fake providerRegistry mirrors the real capabilities declarations
 * (PiAgentSdkProvider / CodexAgentSdkProvider / ClaudeAgentSdkProvider) so the
 * whitelist assertions exercise the same value sets production uses.
 */

/* ── planner SDK reply (set per scenario by main.ts) ── */

let plannerReply = "{}";
export function setPlannerReply(text: string): void {
  plannerReply = text;
}
export let lastQueryPrompt = "";
export function resetCapturedPrompt(): void {
  lastQueryPrompt = "";
}

/** Captured sendToRenderer pushes (planner.delta assertions in main.ts). */
export const pushedEvents: Array<{ channel: string; event: unknown }> = [];
export function sendToRenderer(channel: string, msg: { channel: string; event: unknown }): void {
  pushedEvents.push(msg);
}

export let lastQueryIncludePartial = false;
export let lastQuerySystemPrompt = "";

/** Stands in for @anthropic-ai/claude-agent-sdk's query(): optional
 *  stream_event deltas (only when includePartialMessages is on — mirrors the
 *  real SDK contract), then a canned assistant proposal + result terminator. */
export function query(opts: unknown): AsyncIterable<unknown> {
  lastQueryPrompt = (opts as { prompt?: string })?.prompt ?? "";
  const options = (opts as { options?: { includePartialMessages?: boolean; systemPrompt?: string } })?.options ?? {};
  // 真实契约:开关在 query({ prompt, options }) 的 options 里,不在顶层。
  lastQueryIncludePartial = options.includePartialMessages === true;
  lastQuerySystemPrompt = options.systemPrompt ?? "";
  return (async function* () {
    if (lastQueryIncludePartial) {
      yield {
        type: "stream_event",
        event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "思考中:" } },
      };
      yield {
        type: "stream_event",
        event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: plannerReply.slice(0, 20) } },
      };
      yield {
        type: "stream_event",
        event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: plannerReply.slice(20) } },
      };
    }
    yield {
      type: "assistant",
      message: { content: [{ type: "text", text: plannerReply }] },
    };
    yield { type: "result", subtype: "success" };
  })();
}

/* ── main-side singletons ── */

export const log = { info: () => {}, warn: () => {} };

export const orchestrator = { start: async () => {} };

export const runtimeManager = {};

export const TemplateStore = { list: () => [] };

export const ProfileStore = {
  list: () => [
    {
      id: "builtin-implementer",
      tags: ["coding"],
      providerId: "claude-sdk",
      model: "sonnet",
      builtin: true,
    },
  ],
  get: (id: string) =>
    ProfileStore.list().find((p) => p.id === id),
};

export const coordinatorSession = {
  id: "s1",
  projectId: "p1",
  kind: "chat",
  providerId: "claude-sdk",
  // 真实形态:会话骑着 cfg1 网关,composer 选中的是配置内的一个具体模型
  // (发送守卫保证不可能是 "default")—— 缺省补值链会把它填进空节点。
  model: "deepseek-v4-pro",
  effort: "high",
  permissionMode: "default",
  customModelId: "cfg1",
};

export const SessionRepo = { get: (id: string) => (id === "s1" ? coordinatorSession : null) };
export const ProjectRepo = { get: () => ({ id: "p1", path: "/tmp/p1" }) };
export const MessageRepo = {};

export const createOrReuseSession = () => ({ session: { id: "w1" } });
export const resolveSessionCwd = async () => "/tmp/p1";

export const CustomModelStore = {
  listPublic: () => [
    { id: "cfg1", name: "主网关", models: [{ id: "deepseek-v4-pro" }, { id: "glm-5" }] },
    { id: "cfg2", name: "备用网关", models: [{ id: "other-gateway-model" }] },
  ],
};

export const PiModelsStore = {
  listPublic: async () => ({
    "pi-remote": { models: [{ id: "pi-large", name: "Pi Large" }] },
  }),
};

export const CodexModelsStore = {
  listPublic: async () => [{ models: [{ id: "gpt-5.2-codex", label: "GPT Codex" }] }],
};

export const buildCustomEnv = () => ({});
export const resolveActiveModel = () => "stub-model";
export const resolveSdkBinaryPath = () => undefined;
export const resolveModelForGitOp = async () => ({
  ok: true as const,
  config: { baseUrl: "http://stub", authToken: "stub" },
  releaseBridge: () => {},
});

/* ── provider registry with production-shaped capabilities ── */

const claudeCaps = {
  builtinModels: [
    { id: "default", label: "Auto" },
    { id: "sonnet", label: "Sonnet" },
    { id: "opus", label: "Opus" },
    { id: "fable", label: "Fable" },
  ],
  thinkingLevels: [
    { value: "default", label: "Auto" },
    { value: "low", label: "Low" },
    { value: "medium", label: "Med" },
    { value: "high", label: "High" },
    { value: "xhigh", label: "XHigh" },
    { value: "max", label: "Max" },
  ],
  permissionModes: [
    { value: "default", label: "Default" },
    { value: "acceptEdits", label: "Edit Auto" },
    { value: "plan", label: "Plan" },
    { value: "bypassPermissions", label: "Bypass" },
  ],
};

const piCaps = {
  builtinModels: [] as Array<{ id: string; label: string }>,
  thinkingLevels: [
    { value: "default", label: "Auto" },
    { value: "off", label: "Off" },
    { value: "minimal", label: "Minimal" },
    { value: "low", label: "Low" },
    { value: "medium", label: "Med" },
    { value: "high", label: "High" },
    { value: "xhigh", label: "XHigh" },
    { value: "max", label: "Max" },
  ],
  permissionModes: [
    { value: "default", label: "Default" },
    { value: "acceptEdits", label: "Edit Auto" },
    { value: "plan", label: "Plan" },
    { value: "bypassPermissions", label: "Bypass" },
  ],
};

const codexCaps = {
  builtinModels: [] as Array<{ id: string; label: string }>,
  thinkingLevels: [
    { value: "default", label: "Default" },
    { value: "minimal", label: "Minimal" },
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
    { value: "xhigh", label: "XHigh" },
    { value: "max", label: "Max" },
    { value: "ultra", label: "Ultra" },
  ],
  permissionModes: [
    { value: "read-only", label: "Read Only" },
    { value: "default", label: "Default" },
    { value: "full-access", label: "Full Access" },
  ],
};

const capsById: Record<string, typeof claudeCaps> = {
  "claude-sdk": claudeCaps,
  "pi-sdk": piCaps,
  "codex-sdk": codexCaps,
};

export const providerRegistry = {
  get: (id: string) => (capsById[id] ? { id, capabilities: capsById[id] } : undefined),
  list: () => Object.entries(capsById).map(([id, capabilities]) => ({ id, capabilities })),
  resolve: () => ({ id: "claude-sdk", capabilities: claudeCaps }),
};
