/** Smoke stub for @main/lib/mcpConfig.js — pulls in db/electron otherwise.
 *  The smoke only exercises opencodeMcp's pure mapping (toOpenCodeMcpEntry);
 *  the collectors are not under test. */
import type { McpServerConfig } from "@contracts/ipc";

export async function readUserClaudeJson(): Promise<Record<string, unknown>> {
  return {};
}
export function mcpServersOf(_cfg: Record<string, unknown>): Record<string, unknown> {
  return {};
}
export function parseMcpConfig(_raw: unknown): McpServerConfig | null {
  return null;
}
export async function readProjectMcpServers(_cwd: string): Promise<Record<string, unknown>> {
  return {};
}
export async function getMcpManagement(): Promise<{
  projectEnabled?: Array<{ projectPath: string; name: string }>;
}> {
  return {};
}
