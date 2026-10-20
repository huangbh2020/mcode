import type { MessageId } from "@renderer/lib/i18n/core.js";

/**
 * Built-in tool display-name localization.
 *
 * Tool cards / approval cards / turn-flow nodes previously showed the raw
 * tool name (`Read`, `Edit`, `Bash`, …). Under the zh locale those now
 * render localized (`读取` / `编辑` / `执行命令`, …); under en the values
 * mirror the raw names verbatim, so the en display is unchanged.
 *
 * Scope is DISPLAY ONLY: every logic path (fold grouping sets, icon map,
 * guard tool sets, path extraction) keeps comparing the raw `toolName` —
 * only the final rendered string goes through here. MCP tools
 * (`mcp__<server>__<tool>`) and unknown future tools are not in the table
 * and fall through to the raw name, which is the correct rendering for
 * them in every locale.
 *
 * Both casings are tabulated because the renderer sees raw names from all
 * providers: Claude capitalizes (Read/Grep/…) while Pi lowercases
 * (read/grep/…) — see the WRITE_EDIT_TOOL_NAMES comment in MessageBlocks.
 */
const TOOL_NAME_MESSAGE_IDS = {
  // Claude (capitalized)
  Read: "chatStream.toolName.Read",
  Glob: "chatStream.toolName.Glob",
  Write: "chatStream.toolName.Write",
  Edit: "chatStream.toolName.Edit",
  MultiEdit: "chatStream.toolName.MultiEdit",
  NotebookEdit: "chatStream.toolName.NotebookEdit",
  Bash: "chatStream.toolName.Bash",
  PowerShell: "chatStream.toolName.PowerShell",
  Grep: "chatStream.toolName.Grep",
  TodoWrite: "chatStream.toolName.TodoWrite",
  TodoRead: "chatStream.toolName.TodoRead",
  TaskCreate: "chatStream.toolName.TaskCreate",
  TaskUpdate: "chatStream.toolName.TaskUpdate",
  TaskGet: "chatStream.toolName.TaskGet",
  TaskOutput: "chatStream.toolName.TaskOutput",
  Task: "chatStream.toolName.Task",
  WebSearch: "chatStream.toolName.WebSearch",
  WebFetch: "chatStream.toolName.WebFetch",
  AskUserQuestion: "chatStream.toolName.AskUserQuestion",
  EnterPlanMode: "chatStream.toolName.EnterPlanMode",
  ExitPlanMode: "chatStream.toolName.ExitPlanMode",
  SlashCommand: "chatStream.toolName.SlashCommand",
  Skill: "chatStream.toolName.Skill",
  BashOutput: "chatStream.toolName.BashOutput",
  KillShell: "chatStream.toolName.KillShell",
  // Pi (lowercase aliases)
  read: "chatStream.toolName.read",
  find: "chatStream.toolName.find",
  write: "chatStream.toolName.write",
  edit: "chatStream.toolName.edit",
  multiedit: "chatStream.toolName.multiedit",
  notebookedit: "chatStream.toolName.notebookedit",
  bash: "chatStream.toolName.bash",
  grep: "chatStream.toolName.grep",
  ls: "chatStream.toolName.ls",
  task: "chatStream.toolName.task",
} as const satisfies Record<string, MessageId>;

/** Localized display name for a tool. `t` comes from `useI18n()` (or the
 *  store-free `translate` bound at the call site); unrecognized names
 *  (MCP, provider-specific) pass through untouched. */
export function toolDisplayName(
  t: (id: MessageId) => string,
  toolName: string,
): string {
  const id = TOOL_NAME_MESSAGE_IDS[toolName as keyof typeof TOOL_NAME_MESSAGE_IDS];
  return id ? t(id) : toolName;
}
