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

/** Stands in for @anthropic-ai/claude-agent-sdk's query(): single assistant
 *  message carrying the canned proposal JSON, then a result terminator. */
export function query(_opts: unknown): AsyncIterable<unknown> {
  lastQueryPrompt = (_opts as { prompt?: string })?.prompt ?? "";
  return (async function* () {
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
};

export const coordinatorSession = {
  id: "s1",
  projectId: "p1",
  kind: "chat",
  providerId: "claude-sdk",
  model: "default",
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
    { id: "cfg1", models: [{ id: "deepseek-v4-pro" }, { id: "glm-5" }] },
    { id: "cfg2", models: [{ id: "other-gateway-model" }] },
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
