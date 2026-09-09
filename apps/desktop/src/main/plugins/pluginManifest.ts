/**
 * Plugin manifest discovery + component summarization.
 *
 * A plugin is a directory whose manifest sits at
 * `.claude-plugin/plugin.json` (canonical) or `.zcode-plugin` /
 * `.codex-plugin` (structurally identical — probing all three lets Mcode
 * consume plugins from the neighboring ecosystems for free; see
 * docs/plugin-feasibility.md §3.2). This module turns a plugin root into:
 *
 *   - {@link resolvePlugin} — locate + validate the manifest (throws with a
 *     user-presentable message when nothing valid is found);
 *   - {@link summarizeComponents} — the declarative inventory the install
 *     review and the settings panel show: skills / commands / agents
 *     (frontmatter name+description), hooks (event / matcher / command —
 *     parsed for REVIEW ONLY: v1 never executes them) and MCP servers
 *     (transport kind + secret-free detail).
 *
 * Path discipline: every manifest-declared component path must resolve
 * INSIDE the plugin root (same guard family as the ZCode plugin loader).
 * An escaping or unreadable component is skipped, never fatal — a plugin
 * with a broken hooks file still installs; the panel shows what survived.
 *
 * Pure node (no electron imports) so the manager can be smoke-tested
 * headlessly, mirroring main/runtimes/managedRuntimeRoots.ts.
 */
import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import path from "node:path";
import {
  PLUGIN_MANIFEST_DIRS,
  PluginManifestSchema,
  type PluginComponents,
  type PluginHookSummary,
  type PluginManifest,
} from "@contracts/ipc";

/* ── Manifest discovery ── */

export interface ResolvedPlugin {
  manifest: PluginManifest;
  /** Absolute plugin root (the directory containing the manifest dir). */
  rootDir: string;
  /** Which manifest layout was found (".claude-plugin" | ...). */
  manifestDir: string;
}

/** Probe the three known manifest locations under `root` and parse the first
 *  hit. Returns null when the directory has no recognizable manifest — the
 *  caller decides whether that's fatal (install) or ignorable (scan). */
export function findPluginManifest(root: string): ResolvedPlugin | null {
  for (const dir of PLUGIN_MANIFEST_DIRS) {
    const file = path.join(root, dir, "plugin.json");
    if (!existsSync(file)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf-8"));
    } catch {
      throw new Error(`插件清单无法解析:${path.join(dir, "plugin.json")} 不是合法 JSON`);
    }
    const parsed = PluginManifestSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `插件清单校验失败(${path.join(dir, "plugin.json")}):${parsed.error.issues
          .map((i) => `${i.path.join(".") || "(root)"} ${i.message}`)
          .join("; ")}`,
      );
    }
    return { manifest: parsed.data, rootDir: root, manifestDir: dir };
  }
  return null;
}

/** Directories never treated as plugin containers when probing children. */
const SKIP_SCAN_DIRS = new Set(["node_modules"]);
/** Cap on sole-child descent (nested archive wrappers); real layouts need ≤2. */
const MAX_DESCEND_DEPTH = 4;

/** Non-hidden child DIRECTORIES of `root` — flat files (README/LICENSE/…) are
 *  irrelevant to manifest discovery and must not break the sole-child logic. */
function listChildDirs(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP_SCAN_DIRS.has(e.name))
      .map((e) => path.join(root, e.name));
  } catch {
    return [];
  }
}

/** Like {@link findPluginManifest} but tolerates real-world repository
 *  layouts beyond the plain single-plugin shape. Marketplace repositories
 *  (`.claude-plugin/marketplace.json` + one directory per plugin — the
 *  official claude-plugins-official shape) are deliberately NOT resolved here:
 *  {@link findMarketplaceManifestFile} lets the manager point those at the
 *  marketplace flow instead of silently installing their first plugin.
 *
 *  Probes, in order:
 *   1. manifest directly in `root` (any of the three layout dirs);
 *   2. each first-level child directory (archive wrappers, and checkouts
 *      mixing flat files like README/LICENSE with the plugin dir) — exactly
 *      one hit installs, several hits throw listing the candidate names;
 *   3. chains of sole child directories (nested wrappers), depth-capped.
 *
 *  Hidden dirs (.git, .claude-plugin, …) and node_modules are never descended
 *  into. A child whose manifest exists but fails zod is remembered: when
 *  nothing else hits, that parse error surfaces (more informative than "not
 *  found"). */
export function findPluginManifestDeep(root: string): ResolvedPlugin | null {
  const direct = findPluginManifest(root);
  if (direct) return direct;
  const parseErrors: unknown[] = [];
  let cur = root;
  for (let depth = 0; depth <= MAX_DESCEND_DEPTH; depth++) {
    const childDirs = listChildDirs(cur);
    if (childDirs.length === 0) break;
    const hits: ResolvedPlugin[] = [];
    for (const dir of childDirs) {
      try {
        const hit = findPluginManifest(dir);
        if (hit) hits.push(hit);
      } catch (err) {
        parseErrors.push(err);
      }
    }
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
      const names = hits.map((h) => h.manifest.name).join("、");
      throw new Error(
        `该仓库包含多个插件(${names})。请改用「插件市场」添加该仓库后从中安装,或指定其中单个插件的目录。`,
      );
    }
    if (childDirs.length === 1) {
      cur = childDirs[0];
      continue;
    }
    break;
  }
  if (parseErrors.length > 0) throw parseErrors[0];
  return null;
}

const MARKETPLACE_MANIFEST_RELS = [
  path.join(".claude-plugin", "marketplace.json"),
  "marketplace.json",
];

/** Detect a marketplace manifest in `root` (top level, or one wrapper level
 *  down — zip archives and git checkouts often add exactly one folder).
 *  Returns the file path or null; existence only, no schema validation — the
 *  caller just needs to redirect the user to the marketplace flow. */
export function findMarketplaceManifestFile(root: string): string | null {
  const bases = [root];
  const childDirs = listChildDirs(root);
  if (childDirs.length === 1) bases.push(childDirs[0]);
  for (const base of bases) {
    for (const rel of MARKETPLACE_MANIFEST_RELS) {
      const file = path.join(base, rel);
      if (existsSync(file)) return file;
    }
  }
  return null;
}

/** Normalize the manifest version into a safe directory-name-safe string.
 *  Claude requires strict semver; we stay permissive (0.0.0 fallback) since
 *  community manifests routinely miss it. */
export function pluginVersionOf(manifest: PluginManifest): string {
  const raw = (manifest.version ?? "").trim();
  if (!raw) return "0.0.0";
  const safe = raw.replace(/[^A-Za-z0-9.+-]/g, "-");
  return safe || "0.0.0";
}

/* ── Frontmatter (SKILL.md / commands/*.md / agents/*.md) ── */

/** Minimal `key: value` frontmatter reader for the `---`-fenced YAML block.
 *  Good enough for name/description lines (same approach as the skills IPC's
 *  hand-rolled parser); anything fancier degrades to empty fields. */
function readFrontmatter(file: string): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(file, "utf-8");
  } catch {
    return {};
  }
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    out[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

/* ── Component path resolution (in-root guard) ── */

/** Resolve a manifest-declared relative path and enforce that it stays inside
 *  the plugin root. Returns null when the path escapes, is absolute, or
 *  doesn't exist — callers treat that as "component not present". */
function resolveInRoot(root: string, rel: string): string | null {
  if (!rel || path.isAbsolute(rel)) return null;
  const abs = path.resolve(root, rel);
  const relBack = path.relative(root, abs);
  if (!relBack || relBack.startsWith("..") || path.isAbsolute(relBack)) return null;
  return existsSync(abs) ? abs : null;
}

/** The plugin's skills directory, if declared/defaulted and present. */
export function pluginSkillsDir(root: string, manifest: PluginManifest): string | null {
  return resolveInRoot(root, manifest.skills ?? "skills");
}

export function pluginCommandsDir(root: string, manifest: PluginManifest): string | null {
  return resolveInRoot(root, manifest.commands ?? "commands");
}

export function pluginAgentsDir(root: string, manifest: PluginManifest): string | null {
  return resolveInRoot(root, manifest.agents ?? "agents");
}

export function pluginHooksFile(root: string, manifest: PluginManifest): string | null {
  return resolveInRoot(root, manifest.hooks ?? "hooks/hooks.json");
}

/** The plugin's MCP definition file: manifest `mcpServers` path or the
 *  conventional root `.mcp.json`. */
export function pluginMcpFile(root: string, manifest: PluginManifest): string | null {
  return resolveInRoot(root, manifest.mcpServers ?? ".mcp.json");
}

/* ── Component summaries ── */

interface NamedSummary {
  name: string;
  description: string;
}

/** Scan `<dir>` for one-skill-per-subdirectory layouts (SKILL.md frontmatter
 *  name + description). Subdirectories without a readable SKILL.md are
 *  skipped; the skill NAME prefers frontmatter, falling back to the directory
 *  name (Claude's own discovery does the same). */
function scanSkillDirs(dir: string): NamedSummary[] {
  const out: NamedSummary[] = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const fm = readFrontmatter(path.join(dir, e.name, "SKILL.md"));
    out.push({ name: fm.name || e.name, description: fm.description ?? "" });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Scan `<dir>` for `*.md` command/agent definitions (file name minus
 *  extension = the invocation name; description from frontmatter). */
function scanMarkdownFiles(dir: string): NamedSummary[] {
  const out: NamedSummary[] = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".md")) continue;
    const base = e.name.slice(0, -3);
    const fm = readFrontmatter(path.join(dir, e.name));
    out.push({ name: fm.name || base, description: fm.description ?? "" });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Parse a Claude hooks definition file for REVIEW display. Layout:
 *  `{ "<Event>": [ { "matcher"?: "...", "hooks": [ { "type": "command",
 *  "command": "..." } ] } ] }`. Unparseable shapes degrade to a single
 *  placeholder entry so the panel still says "this plugin has hooks". */
function parseHooksFile(file: string): PluginHookSummary[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return [{ event: "(unknown)", command: "(hooks 文件无法解析)" }];
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return [{ event: "(unknown)", command: "(hooks 定义格式不受支持)" }];
  }
  const out: PluginHookSummary[] = [];
  for (const [event, groups] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (!g || typeof g !== "object") continue;
      const group = g as Record<string, unknown>;
      const matcher = typeof group.matcher === "string" ? group.matcher : undefined;
      const hooks = Array.isArray(group.hooks) ? group.hooks : [];
      for (const h of hooks) {
        if (!h || typeof h !== "object") continue;
        const hook = h as Record<string, unknown>;
        const command = typeof hook.command === "string" ? hook.command : JSON.stringify(hook);
        out.push(matcher ? { event, matcher, command } : { event, command });
      }
    }
  }
  if (out.length === 0) return [{ event: "(unknown)", command: "(hooks 定义为空)" }];
  return out;
}

/** Secret-free one-liner for an MCP server config (mirrors
 *  lib/mcpConfig.ts describeMcpConfig, kept local to avoid an import cycle
 *  into the IPC layer). */
export function describePluginMcp(config: unknown): {
  kind: "stdio" | "http" | "sse";
  detail: string;
} | null {
  if (!config || typeof config !== "object") return null;
  const cfg = config as Record<string, unknown>;
  if (cfg.type === "http" || cfg.type === "sse") {
    if (typeof cfg.url !== "string" || !cfg.url) return null;
    return { kind: cfg.type, detail: cfg.url };
  }
  if (typeof cfg.command !== "string" || !cfg.command) return null;
  const args = Array.isArray(cfg.args) ? cfg.args.filter((a) => typeof a === "string") : [];
  return { kind: "stdio", detail: [cfg.command, ...args].join(" ") };
}

/** Build the full component summary for an installed/being-reviewed plugin. */
export function summarizeComponents(root: string, manifest: PluginManifest): PluginComponents {
  const skillsDir = pluginSkillsDir(root, manifest);
  const commandsDir = pluginCommandsDir(root, manifest);
  const agentsDir = pluginAgentsDir(root, manifest);
  const hooksFile = pluginHooksFile(root, manifest);
  const mcpFile = pluginMcpFile(root, manifest);

  const mcpServers: PluginComponents["mcpServers"] = [];
  if (mcpFile) {
    try {
      const cfg = JSON.parse(readFileSync(mcpFile, "utf-8")) as Record<string, unknown>;
      const servers = (cfg.mcpServers ?? cfg) as Record<string, unknown>;
      if (servers && typeof servers === "object" && !Array.isArray(servers)) {
        for (const [name, raw] of Object.entries(servers)) {
          const desc = describePluginMcp(raw);
          if (desc) mcpServers.push({ name, kind: desc.kind, detail: desc.detail });
        }
      }
    } catch {
      /* unreadable .mcp.json — no servers from it */
    }
  }

  return {
    skills: skillsDir ? scanSkillDirs(skillsDir) : [],
    commands: commandsDir ? scanMarkdownFiles(commandsDir) : [],
    agents: agentsDir ? scanMarkdownFiles(agentsDir) : [],
    hooks: hooksFile ? parseHooksFile(hooksFile) : [],
    mcpServers,
  };
}
