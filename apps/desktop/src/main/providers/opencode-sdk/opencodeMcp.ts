/**
 * OpenCode MCP bridge — feeds Mcode's MCP server configuration into the
 * embedded server via OPENCODE_CONFIG_CONTENT's `mcp` block (the same
 * config surface the user's own opencode.json uses; our injected block is
 * part of the server fingerprint, so an MCP settings edit restarts the
 * server on the next turn — see opencodeServerManager).
 *
 * Collection semantics mirror piMcpBridge exactly: user scope from
 * ~/.mcode/.claude.json mcpServers (in-file = enabled) plus the project
 * .mcp.json explicit allowlist, project entries overriding same-name user
 * entries. Mapping:
 *   - stdio → { type: "local", command: [command, ...args], environment }
 *   - http  → { type: "remote", url, headers }
 *   - sse   → { type: "remote", url, headers } (opencode's remote transport
 *              negotiates streamable-http/SSE itself)
 */
import type { McpServerConfig } from "@contracts/ipc";
import {
  getMcpManagement,
  mcpServersOf,
  parseMcpConfig,
  readProjectMcpServers,
  readUserClaudeJson,
} from "@main/lib/mcpConfig.js";
import { samePath } from "@main/lib/pathGuard.js";
import { log } from "@main/lib/logger.js";

/** opencode's config block for one MCP server. */
export interface OpenCodeMcpEntry {
  type: "local" | "remote";
  command?: string[];
  environment?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

/** Map one Mcode config object to opencode's shape; entry=null + error when
 *  unusable. Pure — smoke-tested. */
export function toOpenCodeMcpEntry(
  config: McpServerConfig,
): { entry: OpenCodeMcpEntry | null; error?: string } {
  if (config.type === "http" || config.type === "sse") {
    return {
      entry: {
        type: "remote",
        url: config.url,
        ...(config.headers && Object.keys(config.headers).length > 0
          ? { headers: config.headers }
          : {}),
      },
    };
  }
  // stdio (or absent type — the SDK's default).
  const command = (config as { command?: string }).command;
  if (!command) {
    return { entry: null, error: "missing command" };
  }
  const args = (config as { args?: string[] }).args ?? [];
  const env = (config as { env?: Record<string, string> }).env;
  return {
    entry: {
      type: "local",
      command: [command, ...args],
      ...(env && Object.keys(env).length > 0 ? { environment: env } : {}),
    },
  };
}

/**
 * Collect Mcode's MCP servers as an opencode `mcp` config block. Never
 * throws — broken entries degrade to log lines.
 */
export async function collectOpenCodeMcpConfig(cwd: string): Promise<Record<string, OpenCodeMcpEntry>> {
  const out = new Map<string, OpenCodeMcpEntry>();

  try {
    const userCfg = await readUserClaudeJson();
    for (const [name, raw] of Object.entries(mcpServersOf(userCfg))) {
      const config = parseMcpConfig(raw);
      if (!config) {
        log.warn(`opencode mcp: ${name}: 配置无法解析,已跳过`);
        continue;
      }
      const { entry, error } = toOpenCodeMcpEntry(config);
      if (!entry) log.warn(`opencode mcp: ${name}: ${error ?? "配置不可用"}`);
      else out.set(name, entry);
    }
  } catch (err) {
    log.warn(`opencode mcp: 读取用户级配置失败:${(err as Error).message}`);
  }

  try {
    const projectServers = await readProjectMcpServers(cwd);
    const management = await getMcpManagement();
    for (const [name, raw] of Object.entries(projectServers)) {
      const enabled = (management.projectEnabled ?? []).some(
        (e) => e.name === name && samePath(e.projectPath, cwd),
      );
      if (!enabled) continue;
      const config = parseMcpConfig(raw);
      if (!config) {
        log.warn(`opencode mcp: ${name}(项目):配置无法解析,已跳过`);
        continue;
      }
      const { entry, error } = toOpenCodeMcpEntry(config);
      if (!entry) log.warn(`opencode mcp: ${name}(项目): ${error ?? "配置不可用"}`);
      else out.set(name, entry);
    }
  } catch (err) {
    log.warn(`opencode mcp: 读取项目级配置失败:${(err as Error).message}`);
  }

  return Object.fromEntries(out);
}
