/**
 * Pure (Electron-free) naming helpers for Mcode's host MCP servers so message
 * adapters and smoke tests can check auto-approval without pulling in
 * BrowserManager or Electron modules.
 */
export const BROWSER_MCP_SERVER = "mcode-browser";
export const BROWSER_MCP_PREFIX = `mcp__${BROWSER_MCP_SERVER}__`;

export const BROWSER_READONLY_SUFFIXES = new Set([
  "browser_list",
  "browser_snapshot",
  "browser_screenshot",
  "browser_find",
  "browser_scroll",
  "browser_wait",
  "browser_switch_tab",
  "browser_save_pdf",
  "browser_downloads",
]);

export function isReadOnlyBrowserTool(toolName: string): boolean {
  if (toolName.startsWith(BROWSER_MCP_PREFIX)) {
    return BROWSER_READONLY_SUFFIXES.has(toolName.slice(BROWSER_MCP_PREFIX.length));
  }
  const sepIdx = Math.max(toolName.lastIndexOf("__"), toolName.lastIndexOf(":"), toolName.lastIndexOf("/"));
  const bare = sepIdx >= 0 ? toolName.slice(sepIdx + (toolName.slice(sepIdx, sepIdx + 2) === "__" ? 2 : 1)) : toolName;
  return BROWSER_READONLY_SUFFIXES.has(bare);
}

export const ORCH_PLAN_MCP_SERVER_NAME = "mcode-orchestrator";
export const ORCH_PLAN_TOOL_BARE_NAME = "orch_submit_plan";
export const ORCH_PLAN_TOOL_FULL_NAME = `mcp__${ORCH_PLAN_MCP_SERVER_NAME}__${ORCH_PLAN_TOOL_BARE_NAME}`;

export function isOrchPlanToolName(toolName: string): boolean {
  return (
    toolName === ORCH_PLAN_TOOL_FULL_NAME ||
    toolName === ORCH_PLAN_TOOL_BARE_NAME ||
    toolName.endsWith(`__${ORCH_PLAN_TOOL_BARE_NAME}`) ||
    toolName.endsWith(`:${ORCH_PLAN_TOOL_BARE_NAME}`) ||
    toolName.endsWith(`/${ORCH_PLAN_TOOL_BARE_NAME}`)
  );
}
