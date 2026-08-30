/**
 * IPC handler for skill discovery. The composer's `/` menu lists skills the
 * user has installed; we discover them by scanning the local filesystem
 * (user-global `~/.mcode/skills/` + active-project `.claude/skills/`) and
 * parsing each skill's SKILL.md frontmatter.
 *
 * We deliberately do NOT call the SDK's `Query.supportedCommands()` for the
 * listing: that method needs a running query handle, but this app spawns a
 * fresh query per turn, so there is no live handle to query between turns.
 * Scanning the disk is instant, runs without booting the claude binary, and
 * matches what the SDK itself scans when `skills: "all"` is passed (the
 * binary scans $CLAUDE_CONFIG_DIR/skills, which we point at ~/.mcode/skills).
 * Selecting a skill inserts `/name` into the textarea; the user sends it as a
 * normal turn and the SDK (started with `skills: "all"`) recognizes and runs it.
 *
 * Additionally, the settings panel's "Import" feature scans external tools'
 * skill directories (Claude Code ~/.claude/skills, Codex ~/.codex/skills,
 * Zcode ~/.agents/skills + ~/.zcode/skills + plugin cache) and copies selected
 * skills into ~/.mcode/skills so they become available in Mcode.
 */
import type { IpcMain } from "electron";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path, { sep } from "node:path";
import {
  IPC,
  SkillsListSchema,
  SkillsReadSchema,
  SkillsSaveSchema,
  SkillsDeleteSchema,
  SkillsScanSourcesSchema,
  SkillsImportSchema,
} from "@contracts/ipc";
import type { SkillInfo, SkillSource, ExternalSkillInfo, SkillTool } from "@contracts/ipc";
import { ProjectRepo } from "@main/store/repositories.js";
import { log } from "@main/lib/logger.js";

/** Case-insensitive, normalized equality for project-root matching — same
 *  helper logic the file handlers use (they inline it as `samePath`). Paths
 *  arrive with arbitrary case/trailing slashes from the renderer, so a raw
 *  `===` would falsely refuse legit roots on case-insensitive filesystems. */
function samePath(a: string, b: string): boolean {
  return path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();
}

/** True if `abs` is inside `root` (or equals it), after normalizing both.
 *  Containment check for write/delete ops — same logic as files.ts pathWithin.
 *  Separator-aware so "/foo/bar" doesn't match root "/foo/ba". */
function pathWithin(root: string, abs: string): boolean {
  const r = path.resolve(root);
  const a = path.resolve(abs);
  if (a === r) return true;
  return a.startsWith(r + sep);
}

/** Resolve a known project root from a caller-supplied projectPath, or null
 *  when it isn't a persisted Project. Centralizes the same containment guard
 *  every skills handler uses (mirrors files.ts / git.ts). */
function findKnownProject(projectPath: string) {
  return ProjectRepo.list().find((p) => samePath(p.path, projectPath));
}

/** Resolve the skills root directory for a given source. Global skills live
 *  under ~/.mcode/skills (Mcode's own CLAUDE_CONFIG_DIR); project skills under
 *  <project>/.claude/skills. Returns the absolute root path.
 *
 *  The global root moved from ~/.claude/skills to ~/.mcode/skills because
 *  CLAUDE_CONFIG_DIR is now always set to ~/.mcode - the SDK's bundled binary
 *  scans $CLAUDE_CONFIG_DIR/skills for user-level skills, so this is where
 *  imported skills must live to be discoverable (especially under custom
 *  endpoints, where ~/.claude/skills is no longer read). */
function resolveSkillRoot(source: SkillSource, projectPath: string): string {
  if (source === "global") {
    return path.join(homedir(), ".mcode", "skills");
  }
  return path.join(projectPath, ".claude", "skills");
}

/** Resolves to an absolute path, following symlinks. Returns null on any
 *  error (missing / no access) so the caller can skip cleanly. */
async function safeRealPath(p: string): Promise<string | null> {
  try {
    return await fs.realpath(p);
  } catch {
    return null;
  }
}

/** Read up to `maxBytes` of a file as utf-8 text. Returns null on any error. */
async function readTextHead(filePath: string, maxBytes = 8192): Promise<string | null> {
  try {
    const handle = await fs.open(filePath, "r");
    try {
      const buf = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(buf, 0, maxBytes, 0);
      return buf.subarray(0, bytesRead).toString("utf-8");
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/**
 * Parse the YAML frontmatter of a SKILL.md file. We only need `name`,
 * `description`, and (optionally) `argument-hint` / `argumentHint`, so a
 * hand-rolled line scan is enough — no yaml dependency. The frontmatter is
 * the YAML block delimited by `---` lines at the top of the file.
 *
 * Returns whatever fields were found; the caller fills in fallbacks
 * (e.g. name ← directory name).
 */
function parseSkillFrontmatter(md: string): {
  name?: string;
  description?: string;
  argumentHint?: string;
} {
  // Frontmatter must be the very first thing in the file: "---\n".
  if (!md.startsWith("---\n") && !md.startsWith("---\r\n")) return {};
  // Find the closing "---" on its own line. Split on newlines so the leading
  // "---" line isn't matched by the closing fence regex.
  const lines = md.split(/\r?\n/);
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return {};
  const fm = lines.slice(1, end);

  const out: { name?: string; description?: string; argumentHint?: string } = {};
  for (const raw of fm) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    // Strip surrounding quotes (single/double) and trailing whitespace.
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key === "name") out.name = val;
    else if (key === "description") out.description = val;
    else if (key === "argument-hint" || key === "argumenthint") out.argumentHint = val;
  }
  return out;
}

/**
 * Scan one skills root dir and append its skills to `into`. Each direct child
 * directory is treated as a skill; its SKILL.md frontmatter supplies the
 * metadata, with the directory name as the `name` fallback. Symlinks are
 * followed (realpath). Any IO error is caught and skipped — this function
 * never throws.
 */
async function scanSkillsRoot(rootDir: string, source: SkillSource, into: Map<string, SkillInfo>): Promise<void> {
  const root = await safeRealPath(rootDir);
  if (!root) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return; // not present / unreadable — nothing to list
  }
  for (const entry of entries) {
    // A skill is a directory — either a real one or a symlink pointing at a
    // directory (common when linking a shared checkout like gstack). NOTE:
    // `Dirent.isDirectory()` does NOT follow symlinks — a symlink reports
    // `isSymbolicLink()` and `isDirectory() === false` — so we must accept
    // both and let `safeRealPath` resolve the link to its real target. Plain
    // files (e.g. .DS_Store) fall through and are skipped.
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const skillPath = path.join(root, entry.name);
    const real = await safeRealPath(skillPath);
    if (!real) continue;
    // Guard against symlinks that resolve to a file (not a dir) — `realpath`
    // follows the link, so a stat on the resolved path tells the true type.
    let isDir = true;
    try {
      const st = await fs.stat(real);
      isDir = st.isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) continue;

    const md = await readTextHead(path.join(real, "SKILL.md"));
    const fm = md ? parseSkillFrontmatter(md) : {};
    const name = fm.name?.trim() || entry.name;
    // Dedupe by name: project-scoped entries are scanned AFTER global ones,
    // so a project skill naturally overrides a same-named global skill.
    into.set(name, {
      name,
      description: fm.description?.trim() ?? "",
      argumentHint: fm.argumentHint?.trim() || undefined,
      source,
    });
  }
}

/** Scan a user-picked local directory for skills, with auto-detection of
 *  whether the directory itself is a single skill or a collection of skills:
 *  - If `<dir>/SKILL.md` exists → treat `dir` as ONE skill (folder name is the
 *    skill name fallback).
 *  - Otherwise → treat `dir` as a skills ROOT and scan each SKILL.md-bearing
 *    subdirectory (same logic as scanning a tool's install location).
 *  Appends results to `into` keyed by `local:${dir}:${name}` so the same
 *  folder scanned twice doesn't double-add. Never throws. */
async function scanLocalSkillDir(
  dir: string,
  into: Map<string, ExternalSkillInfo>,
): Promise<void> {
  const real = await safeRealPath(dir);
  if (!real) return;
  // Ensure it's a directory; silently skip otherwise (defensive — the picker
  // only returns directories, but realpath could resolve to something else).
  try {
    const st = await fs.stat(real);
    if (!st.isDirectory()) return;
  } catch {
    return;
  }
  // Case 1: the directory itself is a skill (contains SKILL.md directly).
  const ownMd = await readTextHead(path.join(real, "SKILL.md"));
  if (ownMd != null) {
    const fm = parseSkillFrontmatter(ownMd);
    const name = fm.name?.trim() || path.basename(real);
    into.set(`local:${real}:${name}`, {
      name,
      description: fm.description?.trim() ?? "",
      tool: "local",
      sourcePath: real,
    });
    return;
  }
  // Case 2: treat as a skills root — scan each subdirectory.
  await scanExternalSkillsRoot(real, "local", into);
}

/**
 * Scan one external tool's skills root dir and append its skills to `into`.
 * Similar to {@link scanSkillsRoot} but records the source directory path and
 * tool origin so the import handler can copy the skill folder later. Dedupes
 * by name WITHIN a single tool (first occurrence wins); cross-tool dedup is
 * left to the UI so the user can see the same skill available from multiple
 * tools. Never throws - IO errors are caught and skipped.
 */
async function scanExternalSkillsRoot(
  rootDir: string,
  tool: SkillTool,
  into: Map<string, ExternalSkillInfo>,
): Promise<void> {
  const root = await safeRealPath(rootDir);
  if (!root) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return; // not present / unreadable - nothing to list
  }
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    // Skip Codex's system skills directory - those are built-in, not user
    // skills meant for import.
    if (entry.name === ".system") continue;
    const skillPath = path.join(root, entry.name);
    const real = await safeRealPath(skillPath);
    if (!real) continue;
    let isDir = true;
    try {
      const st = await fs.stat(real);
      isDir = st.isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) continue;

    const md = await readTextHead(path.join(real, "SKILL.md"));
    const fm = md ? parseSkillFrontmatter(md) : {};
    const name = fm.name?.trim() || entry.name;
    // Dedupe within this tool only: if the same name appeared in another tool,
    // we still add it (different sourcePath). But within one tool's tree,
    // first occurrence wins.
    if (into.has(`${tool}:${name}`)) continue;
    into.set(`${tool}:${name}`, {
      name,
      description: fm.description?.trim() ?? "",
      tool,
      sourcePath: real,
    });
  }
}

/** The fixed external skill directories scanned by the import feature, keyed
 *  by tool. Zcode has multiple roots (user skills + plugin cache). The plugin
 *  cache glob is resolved lazily because it may not exist. */
function getExternalSkillDirs(): Array<{ tool: SkillTool; dir: string }> {
  const home = homedir();
  const dirs: Array<{ tool: SkillTool; dir: string }> = [
    { tool: "claude-code", dir: path.join(home, ".claude", "skills") },
    { tool: "codex", dir: path.join(home, ".codex", "skills") },
    { tool: "zcode", dir: path.join(home, ".agents", "skills") },
    { tool: "zcode", dir: path.join(home, ".zcode", "skills") },
  ];
  // Zcode plugin cache: ~/.zcode/cli/plugins/cache/*/*/skills
  // Each entry is <marketplace>/<plugin>/<version>/skills - we glob two levels
  // deep under the cache dir and append any skills/ folders found.
  return dirs;
}

/** Scan the Zcode plugin cache for additional skill directories. The cache
 *  structure is ~/.zcode/cli/plugins/cache/<marketplace>/<plugin>/<version>/skills.
 *  Returns the list of `skills` directories found (may be empty). */
async function scanZcodePluginSkillDirs(): Promise<string[]> {
  const home = homedir();
  const cacheRoot = path.join(home, ".zcode", "cli", "plugins", "cache");
  const realRoot = await safeRealPath(cacheRoot);
  if (!realRoot) return [];
  const result: string[] = [];
  try {
    // Level 1: marketplaces
    for (const market of await fs.readdir(realRoot, { withFileTypes: true })) {
      if (!market.isDirectory()) continue;
      const marketPath = path.join(realRoot, market.name);
      // Level 2: plugins
      let plugins: import("node:fs").Dirent[];
      try {
        plugins = await fs.readdir(marketPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const plugin of plugins) {
        if (!plugin.isDirectory()) continue;
        const pluginPath = path.join(marketPath, plugin.name);
        // Level 3: versions
        let versions: import("node:fs").Dirent[];
        try {
          versions = await fs.readdir(pluginPath, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const ver of versions) {
          if (!ver.isDirectory()) continue;
          const skillsDir = path.join(pluginPath, ver.name, "skills");
          const realSkills = await safeRealPath(skillsDir);
          if (realSkills) result.push(realSkills);
        }
      }
    }
  } catch {
    // Best-effort; swallow.
  }
  return result;
}

/** Shared skills-list core — used by both the desktop IPC handler and the
 *  mobile RPC whitelist. `projectPath` is optional: when omitted (or when it
 *  isn't a persisted Project root), only the user-global root is scanned —
 *  the settings panel relies on this to list global skills even with no
 *  projects at all. */
export async function listSkillsForProject(projectPath: string | undefined): Promise<SkillInfo[]> {
  const project = projectPath ? findKnownProject(projectPath) : null;

  const byName = new Map<string, SkillInfo>();
  try {
    // Global first, then project — so project entries override.
    await scanSkillsRoot(resolveSkillRoot("global", ""), "global", byName);
    if (project) {
      await scanSkillsRoot(resolveSkillRoot("project", project.path), "project", byName);
    }
  } catch (err) {
    // Should be unreachable (scanSkillsRoot never throws), but be defensive:
    // a broken skills dir must never break the composer.
    log.warn(`skills.list scan failed: ${(err as Error).message}`);
  }
  // Stable ordering: project-first then global, alphabetical within each,
  // so the menu doesn't reshuffle between renders.
  return [...byName.values()].sort((a, b) => {
    if (a.source !== b.source) return a.source === "project" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** Shared skills-read core — used by both the desktop IPC handler and the
 *  mobile RPC whitelist. `projectPath` is only required for project-scoped
 *  skills; global skills resolve without it. Returns "" when a project skill
 *  is requested with no/unknown project or the skill dir escapes the root. */
export async function readSkillForProject(
  projectPath: string | undefined,
  source: SkillSource,
  name: string,
): Promise<string> {
  const root = resolveSkillRootForRequest(source, projectPath);
  if (!root) return "";
  const skillDir = path.join(root, name);
  // Containment guard: the resolved skill dir must stay inside the root.
  if (!pathWithin(root, skillDir)) return "";
  try {
    return await fs.readFile(path.join(skillDir, "SKILL.md"), "utf-8");
  } catch {
    // Missing file (e.g. a skill dir without SKILL.md) → empty editor.
    return "";
  }
}

/** Resolve the skills root for a read/save/delete request, or null when the
 *  request is invalid: project-scoped ops need a persisted Project root,
 *  global ops never look at projectPath. Centralizes the source-dependent
 *  project guard the three mutation/read handlers share. */
function resolveSkillRootForRequest(
  source: SkillSource,
  projectPath: string | undefined,
): string | null {
  if (source === "global") {
    return resolveSkillRoot("global", "");
  }
  if (!projectPath) return null;
  const project = findKnownProject(projectPath);
  if (!project) return null;
  return resolveSkillRoot("project", project.path);
}

export function registerSkillsHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.SKILLS_LIST, async (_evt, raw) => {
    const input = SkillsListSchema.parse(raw);
    const skills = await listSkillsForProject(input.projectPath);
    return { skills };
  });

  // ── Read one skill's full SKILL.md source ──
  ipcMain.handle(IPC.SKILLS_READ, async (_evt, raw) => {
    const input = SkillsReadSchema.parse(raw);
    const content = await readSkillForProject(input.projectPath, input.source, input.name);
    return { content };
  });

  // ── Create or overwrite a skill's SKILL.md ──
  ipcMain.handle(IPC.SKILLS_SAVE, async (_evt, raw) => {
    const input = SkillsSaveSchema.parse(raw);
    const root = resolveSkillRootForRequest(input.source, input.projectPath);
    if (!root) return { ok: false, error: "未知的项目路径" };
    const skillDir = path.join(root, input.name);
    if (!pathWithin(root, skillDir)) {
      return { ok: false, error: "无效的 skill 路径" };
    }
    try {
      // Rename (move) the skill directory when a new name is requested and it
      // actually differs. Reserved for future rename UI; v1 leaves it unset.
      if (input.newName && input.newName !== input.name) {
        const newDir = path.join(root, input.newName);
        if (!pathWithin(root, newDir)) {
          return { ok: false, error: "无效的新 skill 名" };
        }
        await fs.rename(skillDir, newDir);
      }
      const targetDir = input.newName && input.newName !== input.name
        ? path.join(root, input.newName)
        : skillDir;
      // mkdir -p the skill dir (and the .claude/skills root if it's the first
      // project-scoped skill). recursive:true is a no-op if it already exists.
      await fs.mkdir(targetDir, { recursive: true });
      await fs.writeFile(path.join(targetDir, "SKILL.md"), input.content, "utf-8");
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  // ── Delete a skill directory ──
  ipcMain.handle(IPC.SKILLS_DELETE, async (_evt, raw) => {
    const input = SkillsDeleteSchema.parse(raw);
    const root = resolveSkillRootForRequest(input.source, input.projectPath);
    if (!root) return { ok: false, error: "未知的项目路径" };
    const skillDir = path.join(root, input.name);
    if (!pathWithin(root, skillDir)) {
      return { ok: false, error: "无效的 skill 路径" };
    }
    try {
      // Distinguish symlink vs real directory: a symlinked skill (common when
      // users link a shared checkout like gstack) must only have the LINK
      // removed — unlinking the target would destroy the shared source. Real
      // directories are removed recursively.
      const stat = await fs.lstat(skillDir);
      if (stat.isSymbolicLink()) {
        await fs.unlink(skillDir);
      } else if (stat.isDirectory()) {
        await fs.rm(skillDir, { recursive: true, force: true });
      } else {
        // Not a dir and not a symlink — refuse rather than delete an unknown
        // file type (defensive; the lister only ever surfaces directories).
        return { ok: false, error: "目标不是 skill 目录" };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  // ── Scan external tools for skills available to import ──
  // Scans Claude Code (~/.claude/skills), Codex (~/.codex/skills), and Zcode
  // (~/.agents/skills + ~/.zcode/skills + plugin cache) for SKILL.md-bearing
  // directories. When the caller supplies a `localDir`, that user-picked
  // directory is scanned too (auto-detecting single-skill vs skills-collection).
  // Returns a flat list with the tool origin and source path for each, so the
  // UI can present them and the import handler can copy them.
  ipcMain.handle(IPC.SKILLS_SCAN_SOURCES, async (_evt, raw) => {
    const input = SkillsScanSourcesSchema.parse(raw);
    const byKey = new Map<string, ExternalSkillInfo>();
    try {
      const dirs = getExternalSkillDirs();
      for (const { tool, dir } of dirs) {
        await scanExternalSkillsRoot(dir, tool, byKey);
      }
      // Zcode plugin cache skills (discovered separately due to nested dir
      // structure).
      const pluginDirs = await scanZcodePluginSkillDirs();
      for (const dir of pluginDirs) {
        await scanExternalSkillsRoot(dir, "zcode", byKey);
      }
      // User-picked local directory (import dialog's "select folder" flow).
      if (input.localDir) {
        await scanLocalSkillDir(input.localDir, byKey);
      }
    } catch (err) {
      log.warn(`skills.scanSources failed: ${(err as Error).message}`);
    }
    // Sort by tool then name for stable display. Tool order is fixed so the
    // UI grouping is deterministic (localeCompare would put "local" after
    // "zcode", but we want it last as the "additional source" section).
    const toolOrder: SkillTool[] = ["claude-code", "codex", "zcode", "local"];
    const toolRank = (t: SkillTool) => toolOrder.indexOf(t);
    const sources = [...byKey.values()].sort((a, b) => {
      const ra = toolRank(a.tool);
      const rb = toolRank(b.tool);
      if (ra !== rb) return ra - rb;
      return a.name.localeCompare(b.name);
    });
    return { sources };
  });

  // ── Import (copy) selected skills into ~/.mcode/skills ──
  // Copies each selected skill's directory tree from its external source into
  // the global Mcode skills root. Skills that already exist at the destination
  // are skipped (not overwritten) to protect user edits. Returns per-skill
  // imported / skipped / error lists so the UI can report precisely.
  ipcMain.handle(IPC.SKILLS_IMPORT, async (_evt, raw) => {
    const input = SkillsImportSchema.parse(raw);
    const globalRoot = resolveSkillRoot("global", "");
    const imported: string[] = [];
    const skipped: string[] = [];
    const errors: Array<{ name: string; error: string }> = [];
    for (const item of input.skills) {
      const destDir = path.join(globalRoot, item.name);
      // Containment guard: destination must stay inside the global skills root.
      if (!pathWithin(globalRoot, destDir)) {
        errors.push({ name: item.name, error: "无效的 skill 名" });
        continue;
      }
      // Source must exist and be a directory (the scan guaranteed this, but
      // the user may have deleted it between scan and import).
      let srcStat: import("node:fs").Stats;
      try {
        srcStat = await fs.stat(item.sourcePath);
      } catch {
        errors.push({ name: item.name, error: "源目录不存在" });
        continue;
      }
      if (!srcStat.isDirectory()) {
        errors.push({ name: item.name, error: "源路径不是目录" });
        continue;
      }
      // Skip if the destination already exists (don't overwrite user edits).
      try {
        await fs.lstat(destDir);
        skipped.push(item.name);
        continue;
      } catch {
        // Good - destination doesn't exist, proceed with copy.
      }
      try {
        await fs.mkdir(globalRoot, { recursive: true });
        // fs.cp with recursive:true copies the entire directory tree
        // (SKILL.md + references/ + assets/ + scripts/ etc.).
        await fs.cp(item.sourcePath, destDir, { recursive: true });
        imported.push(item.name);
      } catch (err) {
        errors.push({ name: item.name, error: (err as Error).message });
      }
    }
    return { imported, skipped, errors };
  });
}
