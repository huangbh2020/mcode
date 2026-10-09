/**
 * The project-level `.agent/skills` drop-in root — the skills.list "agent"
 * source (see ipc/skills.ts) and its Claude-side loading strategy.
 *
 * Pi and Codex accept additional skill-root paths directly, but Claude's CLI
 * only auto-discovers `<cwd>/.claude/skills`; `Options.skills` is a name
 * allowlist, not a path list. The `.agent` dir therefore rides the plugin
 * loader: passed as a local plugin (`options.plugins`), the CLI adopts its
 * `<name>/SKILL.md` subdirectories as plugin-qualified skills named
 * `.agent:<dirName>` (verified against CLI 2.1.258 — no plugin manifest
 * required, and the registered name is the DIRECTORY name; frontmatter
 * `name` is ignored for plugin-adopted skills). Directory names are thus the
 * single naming authority for this source, shared by the listing
 * (`scanSkillsRoot`'s nameFromDir) and the allowlist qualification in
 * {@link resolveAgentSkillInjection}.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

/** Namespace prefix the CLI assigns to skills adopted from a local plugin
 *  whose directory is named `.agent` (the dir basename becomes the plugin
 *  name). */
export const AGENT_SKILL_NAMESPACE = ".agent";

/** The project-level agent skills root for a session cwd. */
export function agentSkillsRoot(cwd: string): string {
  return path.join(cwd, ".agent", "skills");
}

export interface AgentSkillInjection {
  /** The dir to pass as a local plugin (`<cwd>/.agent`). */
  dir: string;
  /** Skill names (= skill DIRECTORY names) discovered under the root. */
  names: Set<string>;
  /** True when `.agent/hooks/hooks.json` exists. */
  hasHooks: boolean;
}

/** Inspect a project's `.agent/skills` root for the Claude provider. Returns
 *  null when the project has no `.agent/skills` with at least one entry
 *  (nothing to inject). Never throws.
 *
 *  `names` holds directory names — same entry rule as scanSkillsRoot:
 *  directories or symlinks to directories, dot-prefixed entries excluded
 *  (the CLI's skills-dir adoption skips those too). */
export async function resolveAgentSkillInjection(cwd: string): Promise<AgentSkillInjection | null> {
  const dir = path.join(cwd, ".agent");
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(agentSkillsRoot(cwd), { withFileTypes: true });
  } catch {
    return null;
  }
  const names = new Set<string>();
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    try {
      if (!(await fs.stat(path.join(dir, "skills", entry.name))).isDirectory()) continue;
    } catch {
      continue;
    }
    names.add(entry.name);
  }
  if (names.size === 0) return null;
  // Mcode runs no plugin hooks (v1 policy — hooks are parsed + shown in the
  // Plugins panel, never executed). A plugin-shaped `.agent` must not become
  // a silent hook-execution channel, so its presence forces disableAllHooks
  // like an enabled hook-bearing plugin does.
  let hasHooks = false;
  try {
    hasHooks = (await fs.stat(path.join(dir, "hooks", "hooks.json"))).isFile();
  } catch {
    // absent — nothing to disable
  }
  return { dir, names, hasHooks };
}
