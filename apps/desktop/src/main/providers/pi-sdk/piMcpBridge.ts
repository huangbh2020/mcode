/**
 * Pi MCP bridge — feeds Mcode's MCP server configuration into the Pi agent
 * via the SDK's built-in MCP extension (`createMcpExtension`).
 *
 * ## Why loadConfig (and not pi's own mcp.json scanning)
 *
 * pi's default MCP config sources are `~/.pi/agent/mcp.json` + project
 * `.pi/mcp.json` — files Mcode neither manages nor documents. Mcode's server
 * sources live elsewhere (see mcpConfig.ts):
 *   - user scope:  the `mcpServers` object of ~/.mcode/.claude.json —
 *     presence in the file IS the enable mechanism (disabled servers are
 *     stashed in the management state instead);
 *   - project scope: <projectRoot>/.mcp.json — DEFAULT OFF, an explicit
 *     allowlist (`projectEnabled`, matched against the turn's cwd) replaces
 *     the CLI's first-use approval dialog.
 * Overriding `loadConfig` swaps out pi's file scanning wholesale, so there is
 * exactly one config surface and no double-source drift. Entries handed to pi
 * are marked `exposure: "direct"` — tools are declared to the model like any
 * other tool, matching the Claude provider's `options.mcpServers` injection
 * (pi's default `codemode` exposure would hide them behind sandboxed scripts
 * and `tool_search`, a CLI-interaction shape Mcode doesn't offer).
 *
 * ## Approval
 *
 * MCP tools register under `mcp__<server>__<tool>` and run through pi's tool
 * pipeline, so the mcode extension's `tool_call` guard fires for them like
 * for built-ins — default-mode calls hit the host approval prompt (parity
 * with the Claude side); `shouldAutoApproveForPi` knows none of these names,
 * which is exactly right.
 *
 * ## Boundaries (v1)
 *
 *   - OAuth: HTTP servers answering 401 use pi's own OAuth flow with
 *     credentials in pi's agentDir (`mcp-auth.json`). Mcode offers no sign-in
 *     UI — servers that need OAuth should use `headers` auth instead. The
 *     platform-browser redirect (pi's default `openUrl`) still works.
 *   - SSE: Mcode's schema knows `type: "sse"` but pi 1.0.2 ships stdio + http
 *     transports only. SSE entries are skipped with an error entry rather
 *     than silently dropped.
 *   - Startup: `startupWaitMs` bounds how long the first prompt waits for
 *     `direct` servers still connecting (10s, pi's default) — same
 *     wait-for-MCP behavior as the Claude CLI.
 */
import type {
  createMcpExtension,
  LoadedMcpConfig,
  McpExtensionOptions,
  McpServerEntry,
} from "@earendil-works/pi-coding-agent";
import type { McpServerConfig } from "@contracts/ipc";
import {
  getMcpManagement,
  mcpServersOf,
  parseMcpConfig,
  readProjectMcpServers,
  readUserClaudeJson,
} from "@main/lib/mcpConfig.js";
import { samePath } from "@main/lib/pathGuard.js";

/** How long the first prompt waits for still-connecting `direct` servers. */
const STARTUP_WAIT_MS = 10_000;

/** Result of collecting Mcode's MCP servers for one turn. */
export interface PiMcpConfig {
  /** Entries for pi — exposure forced to `direct`, project overrides applied. */
  entries: McpServerEntry[];
  /** Human-readable problems (unparseable configs, unsupported transports) —
   *  pi reports them once at startup; we also log them. */
  errors: string[];
}

/** True when the entry names a project-allowed server for this cwd. */
function projectEnabledFor(
  enabled: Array<{ projectPath: string; name: string }> | undefined,
  cwd: string,
  name: string,
): boolean {
  if (!enabled) return false;
  return enabled.some((e) => e.name === name && samePath(e.projectPath, cwd));
}

/** Map one Mcode config object to a pi entry; null + error text when the
 *  config is unusable (schema failure or a transport pi doesn't ship). */
function toPiEntry(
  name: string,
  config: McpServerConfig,
  scope: "global" | "project",
): { entry: McpServerEntry; error?: string } {
  // pi 1.0.2 has no SSE transport — say so instead of dropping silently.
  // The discriminated check also narrows the union for the spread below.
  if (config.type === "sse") {
    return { entry: null as unknown as McpServerEntry, error: `${name}: SSE 传输不被 Pi 支持,请改用 http 或 stdio` };
  }
  // The `exposure` key lives on pi's config type; spread keeps transport
  // fields (command/args/env/url/headers) and passthrough extras intact.
  const piConfig = { ...config, exposure: "direct" as const };
  return {
    entry: { name, config: piConfig, source: "mcode", scope },
  };
}

/**
 * Collect Mcode's MCP servers for a Pi turn: user-scope servers from
 * ~/.mcode/.claude.json plus explicitly enabled project servers, project
 * entries overriding same-name user entries (pi's own precedence, already
 * Mcode's too). Never throws — failures degrade to `errors` entries so one
 * broken server never blocks the turn.
 */
export async function collectPiMcpConfig(cwd: string): Promise<PiMcpConfig> {
  const errors: string[] = [];
  const entries = new Map<string, McpServerEntry>();

  // User scope: in-file = enabled (disabled ones live in the management
  // stash, so absence from the file is the filter — nothing to check here).
  try {
    const userCfg = await readUserClaudeJson();
    for (const [name, raw] of Object.entries(mcpServersOf(userCfg))) {
      const config = parseMcpConfig(raw);
      if (!config) {
        errors.push(`${name}: 配置无法解析(不符合 MCP schema),已跳过`);
        continue;
      }
      const { entry, error } = toPiEntry(name, config, "global");
      if (error) errors.push(error);
      else entries.set(name, entry);
    }
  } catch (err) {
    errors.push(`读取用户级 MCP 配置失败:${(err as Error).message}`);
  }

  // Project scope: allowlist-gated (Mcode semantics — project servers are
  // opt-in per project), same-name overrides the user entry.
  try {
    const projectServers = await readProjectMcpServers(cwd);
    const management = await getMcpManagement();
    for (const [name, raw] of Object.entries(projectServers)) {
      if (!projectEnabledFor(management.projectEnabled, cwd, name)) continue;
      const config = parseMcpConfig(raw);
      if (!config) {
        errors.push(`${name}(项目):配置无法解析,已跳过`);
        continue;
      }
      const { entry, error } = toPiEntry(name, config, "project");
      if (error) errors.push(error);
      else entries.set(name, entry);
    }
  } catch (err) {
    errors.push(`读取项目 MCP 配置失败:${(err as Error).message}`);
  }

  return { entries: [...entries.values()], errors };
}

/**
 * Build the pi MCP extension from a pre-collected config. `loadConfig` closes
 * over the entries (pi's hook is synchronous; the async reads happened in
 * {@link collectPiMcpConfig} on the provider's per-turn read batch).
 */
export function buildPiMcpExtension(
  createExtension: typeof createMcpExtension,
  config: PiMcpConfig,
): ReturnType<typeof createMcpExtension> {
  const loadConfig: McpExtensionOptions["loadConfig"] = () => {
    const loaded: LoadedMcpConfig = {
      servers: config.entries,
      errors: config.errors,
      // Mcode has no codemode surface — with only `direct` servers present
      // the codemode tool would be dead weight in the tool list.
      autoEnableCodemode: false,
    };
    return loaded;
  };
  return createExtension({ loadConfig, startupWaitMs: STARTUP_WAIT_MS });
}
