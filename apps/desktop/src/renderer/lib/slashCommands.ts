/**
 * Composer skill-command data layer.
 *
 * The `/` menu lists skills discovered from the local filesystem (user-global
 * `~/.claude/skills/` + active-project `.claude/skills/`). The store fetches
 * the list over IPC and caches it; this module provides the type the cache
 * holds and the filter used by the picker.
 *
 * Selecting a skill creates an atomic skill tag (a chip above the textarea,
 * replacing the `/query` trigger token); the user then types their message and
 * sends the turn. The `/name` invocation is injected into the prompt by
 * composePromptWithTags on Send. The SDK is started with `skills: "all"`, so
 * the agent recognizes and runs the skill.
 *
 * This is intentionally separate from the Cmd/Ctrl+K app command palette
 * (`lib/commands.ts`) and from terminal custom commands.
 */
import type { SkillInfo } from "@contracts/ipc";

/** Re-exported so UI code imports the skill shape from one place. */
export type { SkillInfo } from "@contracts/ipc";
export type { SkillSource } from "@contracts/ipc";

/** Built-in slash commands surfaced in the `/` menu alongside skills. Unlike
 *  skills (which are filesystem-scanned and inserted as atomic pills), built-in
 *  commands are fixed entries with bespoke behavior handled by the composer:
 *  - `compact`: immediately sends `/compact` to the agent (summarize + release
 *    context). Disabled while a turn is running.
 *  - `init`: fills the editor with an editable AGENTS.md-generation prompt so
 *    the user can tweak it before sending.
 *  - `browser`: fills the editor with a browser-control prompt template so the
 *    user can fill in a URL + intent (snapshot / click / screenshot / device),
 *    then send. Surfaces the agent browser feature to users who otherwise
 *    wouldn't know it exists. */
export type BuiltInCommandKind = "compact" | "init" | "browser";

export interface BuiltInCommand {
  /** Command name without the leading slash, e.g. "compact". */
  name: string;
  /** Short human description shown in the picker. */
  description: string;
  /** Optional argument hint shown after the name (currently unused). */
  argumentHint?: string;
  /** Discriminator distinguishing this from SkillInfo (which lacks `kind`). */
  kind: BuiltInCommandKind;
}

/** Fixed list of built-in `/` commands. Order is the display order. */
export const BUILT_IN_COMMANDS: BuiltInCommand[] = [
  {
    name: "compact",
    description: "压缩对话历史(总结并释放上下文)",
    kind: "compact",
  },
  {
    name: "init",
    description: "生成项目说明文件 AGENTS.md",
    kind: "init",
  },
  {
    name: "browser",
    description: "用应用内浏览器打开网页(导航/快照/点击/截图)",
    kind: "browser",
  },
];

/** Case-insensitive match on built-in command name + description.
 *  Empty query = all built-in commands. */
export function filterBuiltInCommands(query: string): BuiltInCommand[] {
  const q = query.trim().toLowerCase().replace(/^\//, "");
  if (!q) return BUILT_IN_COMMANDS;
  return BUILT_IN_COMMANDS.filter((c) => {
    if (c.name.toLowerCase().includes(q)) return true;
    return c.description.toLowerCase().includes(q);
  });
}

/** A unified entry the picker renders - either a discovered skill or a
 *  built-in command. The `kind` field discriminates them. */
export type SlashEntry = SkillInfo | BuiltInCommand;

/** Type guard: is this entry a built-in command (has a `kind`)? */
export function isBuiltInCommand(entry: SlashEntry): entry is BuiltInCommand {
  return (entry as BuiltInCommand).kind !== undefined;
}

/** Case-insensitive match on skill name + description. Empty query = all.
 *  Mirrors the old static filterSlashCommands shape, now over a dynamic list. */
export function filterSkillCommands(query: string, skills: SkillInfo[]): SkillInfo[] {
  const q = query.trim().toLowerCase().replace(/^\//, "");
  if (!q) return skills;
  return skills.filter((s) => {
    if (s.name.toLowerCase().includes(q)) return true;
    return s.description.toLowerCase().includes(q);
  });
}
