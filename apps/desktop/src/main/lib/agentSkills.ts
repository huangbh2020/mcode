/**
 * The project-level agent-skill drop-in roots — the skills.list "agent"
 * source (see ipc/skills.ts) and its Claude-side loading strategy.
 *
 * Two roots are recognized, highest priority first:
 *   - `<cwd>/.agents/skills` (plural — the cross-tool convention Zcode &
 *     friends use; the common shape skills land in when dropped in from
 *     other tools)
 *   - `<cwd>/.agent/skills` (singular — Mcode's original drop-in root and
 *     the canonical create target for new skills)
 *
 * Pi and Codex accept additional skill-root paths directly, but Claude's CLI
 * only auto-discovers `<cwd>/.claude/skills` at runtime (CLI 2.1.293 binary:
 * `.agents/skills` appears only in its one-shot import/migration flow, and
 * `.agent/skills` doesn't appear at all); `Options.skills` is a name
 * allowlist, not a path list. The drop-in dirs therefore ride the plugin
 * loader: passed as a local plugin (`options.plugins`), the CLI adopts its
 * `<name>/SKILL.md` subdirectories as plugin-qualified skills named
 * `<pluginName>:<dirName>` (verified against CLI 2.1.258 — no plugin manifest
 * required, and the registered name is the DIRECTORY name; frontmatter
 * `name` is ignored for plugin-adopted skills). The plugin name is the
 * injected directory's basename, so each root's namespace is `.agents` /
 * `.agent` respectively. Directory names are thus the single naming
 * authority for this source, shared by the listing (`scanSkillsRoot`'s
 * nameFromDir) and the allowlist qualification in
 * {@link resolveAgentSkillInjections}.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

/** The project-level agent skills roots for a session cwd, highest priority
 *  first: `.agents` (plural, cross-tool convention) wins over `.agent`
 *  (Mcode's original) when both carry the same skill name. */
export function agentSkillsRoots(cwd: string): string[] {
  return [path.join(cwd, ".agents", "skills"), path.join(cwd, ".agent", "skills")];
}

/** The canonical create target — Mcode's original `.agent/skills` root. New
 *  skills land here unless the project already uses one of the roots (see
 *  {@link agentSkillEditRoot}). */
export function agentSkillsRoot(cwd: string): string {
  return path.join(cwd, ".agent", "skills");
}

/** One Claude-side plugin injection for a drop-in root carrying skills. */
export interface AgentSkillPlugin {
  /** The dir to pass as a local plugin (e.g. `<cwd>/.agent`). */
  dir: string;
  /** Namespace the CLI assigns to this plugin's skills (= dir basename). */
  namespace: string;
  /** Skill names (= skill DIRECTORY names) discovered under the root. */
  names: Set<string>;
}

export interface AgentSkillInjection {
  /** One entry per drop-in root carrying skills, priority order. */
  plugins: AgentSkillPlugin[];
  /** True when any drop-in dir carries `hooks/hooks.json`. */
  hasHooks: boolean;
  /** Picked skill name → `namespace:name` for the CLI skills allowlist
   *  (priority order, first hit wins). Names that don't live in a drop-in
   *  root are absent — the provider sends them bare. */
  qualifiedNames: Map<string, string>;
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** Collect the skill DIRECTORY names under one drop-in root — same entry
 *  rule as scanSkillsRoot: directories or symlinks to directories,
 *  dot-prefixed entries excluded (the CLI's skills-dir adoption skips those
 *  too). */
async function scanAgentSkillNames(root: string): Promise<Set<string>> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return new Set();
  }
  const names = new Set<string>();
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (await isDirectory(path.join(root, entry.name))) names.add(entry.name);
  }
  return names;
}

/** Inspect a project's drop-in roots for the Claude provider. Returns null
 *  when neither `.agents/skills` nor `.agent/skills` has at least one entry
 *  (nothing to inject). Never throws. */
export async function resolveAgentSkillInjections(cwd: string): Promise<AgentSkillInjection | null> {
  const plugins: AgentSkillPlugin[] = [];
  for (const root of agentSkillsRoots(cwd)) {
    const names = await scanAgentSkillNames(root);
    if (names.size === 0) continue;
    const dir = path.dirname(root);
    plugins.push({ dir, namespace: path.basename(dir), names });
  }
  if (plugins.length === 0) return null;
  const qualifiedNames = new Map<string, string>();
  for (const plugin of plugins) {
    for (const name of plugin.names) {
      if (!qualifiedNames.has(name)) qualifiedNames.set(name, `${plugin.namespace}:${name}`);
    }
  }
  // Mcode runs no plugin hooks (v1 policy — hooks are parsed + shown in the
  // Plugins panel, never executed). A plugin-shaped drop-in dir must not
  // become a silent hook-execution channel, so hook presence forces
  // disableAllHooks like an enabled hook-bearing plugin does.
  let hasHooks = false;
  for (const plugin of plugins) {
    try {
      if ((await fs.stat(path.join(plugin.dir, "hooks", "hooks.json"))).isFile()) {
        hasHooks = true;
      }
    } catch {
      // absent — nothing to disable
    }
  }
  return { plugins, hasHooks, qualifiedNames };
}

/** Resolve the root a read/save/delete of skill `name` should target:
 *  ① the drop-in root that already carries the skill (edit in place,
 *  priority order), ② else the first root that already exists (the project's
 *  chosen convention), ③ else the canonical `.agent/skills` create target.
 *  Never throws. */
export async function agentSkillEditRoot(cwd: string, name: string): Promise<string> {
  const roots = agentSkillsRoots(cwd);
  for (const root of roots) {
    if (await isDirectory(path.join(root, name))) return root;
  }
  for (const root of roots) {
    if (await isDirectory(root)) return root;
  }
  return agentSkillsRoot(cwd);
}
