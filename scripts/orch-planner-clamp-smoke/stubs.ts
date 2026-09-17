/**
 * Stubs for every runtime dependency of orchestrator/planTool.ts that the
 * clamp smoke must not pull in (electron, SQLite, provider SDKs). One module,
 * aliased to many specifiers — see run.sh.
 *
 * The fake providerRegistry mirrors the real capabilities declarations
 * (PiAgentSdkProvider / CodexAgentSdkProvider / ClaudeAgentSdkProvider) so the
 * whitelist assertions exercise the same value sets production uses.
 */

/* ── in-process MCP server stub (stands in for createSdkMcpServer) ── */

/** Captured sendToRenderer pushes (plan.proposed assertions in main.ts). */
export const pushedEvents: Array<{ channel: string; event: unknown }> = [];
export function sendToRenderer(channel: string, msg: { channel: string; event: unknown }): void {
  pushedEvents.push(msg);
}

export interface FakeMcpTool {
  name: string;
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;
}
export interface FakeMcpServerConfig {
  name: string;
  tools: FakeMcpTool[];
}

/** Stands in for @anthropic-ai/claude-agent-sdk's createSdkMcpServer(): the
 *  real constructor wraps the config into a server object; the smoke just
 *  needs the tool list back so main.ts can invoke handlers directly. */
export function createSdkMcpServer(config: { name: string; tools: FakeMcpTool[] }): FakeMcpServerConfig {
  return config;
}

/* ── main-side singletons ── */

export const log = { info: () => {}, warn: () => {} };

/** Captured createRun input (plan.proposed run assertions in main.ts). */
export let lastCreateRun: Record<string, unknown> | null = null;
export const orchestrator = {
  start: async () => {},
  createRun(input: Record<string, unknown>): { run: Record<string, unknown> } | { error: string } {
    lastCreateRun = input;
    if (!Array.isArray(input.tasks) || input.tasks.length === 0) return { error: "no tasks" };
    return {
      run: {
        id: "run_smoke_1",
        parentSessionId: input.parentSessionId,
        projectId: input.projectId,
        goal: input.goal,
        title: String(input.goal ?? "").slice(0, 40),
        status: input.autoStart === false ? "planning" : "running",
        tasks: (input.tasks as Array<Record<string, unknown>>).map((t) => ({ ...t, status: "pending" })),
      },
    };
  },
};

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
