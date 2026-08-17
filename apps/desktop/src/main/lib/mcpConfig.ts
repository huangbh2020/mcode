/**
 * MCP config file IO + management state for the settings panel's MCP section.
 *
 * Three server sources (see contracts/ipc.ts "MCP management"):
 *  - user scope: the `mcpServers` object of ~/.mcode/.claude.json. This is the
 *    CLI's own user-level config location (CLAUDE_CONFIG_DIR is always set to
 *    ~/.mcode), so whatever sits in the file is loaded automatically by the
 *    claude binary — the file itself is the enable mechanism. Disabling a
 *    server means moving its config OUT of the file into the settings-table
 *    stash (MCP_MANAGEMENT_SETTING_KEY), re-enabling moves it back.
 *  - project scope: <projectRoot>/.mcp.json, read-only here. The panel
 *    records explicit enables in the management state; the provider passes
 *    per-turn enabled/disabledMcpjsonServers so no CLI approval dialog is
 *    ever needed (our onUserDialog bridge cancels unknown kinds).
 *  - builtin: the in-process mcode-browser server; only its disabled flag
 *    lives in the management state.
 *
 * The user config file is a big grab-bag the CLI rewrites frequently (project
 * state, approval caches, onboarding flags...), so every write is a
 * read-modify-write that preserves all unknown keys, and entries we don't
 * recognize (configs that fail our schema) are left untouched rather than
 * dropped — they simply stay enabled and outside the panel's control.
 */
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  McpServerConfigSchema,
  MCP_MANAGEMENT_SETTING_KEY,
  type McpKind,
  type McpManagementState,
  type McpServerConfig,
} from "@contracts/ipc";
import { MCODE_CONFIG_DIR } from "@main/providers/claude-sdk/customEnv.js";
import { awaitDb } from "@main/store/db.js";
import { SettingRepo } from "@main/store/repositories.js";

/** Mcode's own ~/.mcode/.claude.json — the CLI's user-level config file under
 *  the redirected CLAUDE_CONFIG_DIR. User-scope MCP servers live in its
 *  top-level `mcpServers` object. */
const USER_CLAUDE_JSON = path.join(MCODE_CONFIG_DIR, ".claude.json");

/** The real Claude CLI's config file — scanned (read-only) by the import
 *  feature. Never written. */
const CLI_CLAUDE_JSON = path.join(homedir(), ".claude.json");

/** Narrow an unknown JSON value to a plain string-keyed record, or null. */
function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** Read and JSON.parse a file; null on any error (missing, unreadable,
 *  invalid JSON). Never throws. */
async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, "utf-8"));
  } catch {
    return null;
  }
}

/** Write JSON atomically-ish: tmp file + rename, falling back to a direct
 *  write when rename fails (Windows can refuse renames over an existing file
 *  held by another process). Creates parent dirs as needed. */
async function writeJson(file: string, value: unknown): Promise<void> {
  const text = JSON.stringify(value, null, 2);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.mcode-tmp`;
  try {
    await fs.writeFile(tmp, text, "utf-8");
    await fs.rename(tmp, file);
  } catch {
    try {
      await fs.rm(tmp, { force: true });
    } catch {
      // best-effort cleanup
    }
    await fs.writeFile(file, text, "utf-8");
  }
}

/** Read the whole ~/.mcode/.claude.json object. Returns {} when the file is
 *  missing or unparseable (the CLI creates/populates it on first run; a
 *  missing file simply means "no user-scope servers yet"). */
export async function readUserClaudeJson(): Promise<Record<string, unknown>> {
  const parsed = await readJson(USER_CLAUDE_JSON);
  return asRecord(parsed) ?? {};
}

/** Overwrite ~/.mcode/.claude.json. Callers must pass a value derived from
 *  readUserClaudeJson() (read-modify-write) so unknown keys survive. */
export async function writeUserClaudeJson(cfg: Record<string, unknown>): Promise<void> {
  await writeJson(USER_CLAUDE_JSON, cfg);
}

/** Validate an unknown config object against the contract schema. Returns the
 *  narrowed config, or null for anything we don't model (left untouched in
 *  the file, not listed, not toggleable). */
export function parseMcpConfig(raw: unknown): McpServerConfig | null {
  const res = McpServerConfigSchema.safeParse(raw);
  return res.success ? res.data : null;
}

/** Extract the `mcpServers` record from a config file object ({} when the
 *  key is absent or not a record). */
export function mcpServersOf(cfg: Record<string, unknown>): Record<string, unknown> {
  return asRecord(cfg.mcpServers) ?? {};
}

/** A server found in the local Claude CLI config, offered for import. */
export interface CliMcpSource {
  name: string;
  config: McpServerConfig;
  /** "全局" for the global scope, else the project path it was scoped to. */
  origin: string;
}

/** Scan the real Claude CLI's ~/.claude.json (read-only) for importable MCP
 *  servers: the top-level global `mcpServers` plus every
 *  `projects[path].mcpServers` entry. Same-name entries across scopes are all
 *  returned (the dialog lets the user pick); configs failing the schema are
 *  skipped. Never throws — degrades to []. */
export async function readCliMcpSources(): Promise<CliMcpSource[]> {
  const parsed = asRecord(await readJson(CLI_CLAUDE_JSON));
  if (!parsed) return [];
  const out: CliMcpSource[] = [];
  const globalServers = mcpServersOf(parsed);
  for (const [name, raw] of Object.entries(globalServers)) {
    const config = parseMcpConfig(raw);
    if (config) out.push({ name, config, origin: "全局" });
  }
  const projects = asRecord(parsed.projects);
  if (projects) {
    for (const [projectPath, rawProject] of Object.entries(projects)) {
      const projectCfg = asRecord(rawProject);
      if (!projectCfg) continue;
      for (const [name, raw] of Object.entries(mcpServersOf(projectCfg))) {
        const config = parseMcpConfig(raw);
        if (config) out.push({ name, config, origin: projectPath });
      }
    }
  }
  return out;
}

/** Read a project's .mcp.json `mcpServers` record ({} when absent/broken).
 *  Read-only — the panel never rewrites a project file. */
export async function readProjectMcpServers(projectRoot: string): Promise<Record<string, unknown>> {
  const parsed = asRecord(await readJson(path.join(projectRoot, ".mcp.json")));
  return parsed ? mcpServersOf(parsed) : {};
}

/** Read the persisted MCP management state (settings table). AwaitDb-guarded
 *  because the provider's startTurn also calls this outside an IPC context. */
export async function getMcpManagement(): Promise<McpManagementState> {
  await awaitDb();
  const raw = SettingRepo.get(MCP_MANAGEMENT_SETTING_KEY);
  if (!raw) return {};
  return asRecord(JSON.parse(raw)) ? (JSON.parse(raw) as McpManagementState) : {};
}

/** Persist the MCP management state. */
export function saveMcpManagement(state: McpManagementState): void {
  SettingRepo.set(MCP_MANAGEMENT_SETTING_KEY, JSON.stringify(state));
}

/** Transport kind + secret-free one-line summary for display. Env and header
 *  values are intentionally excluded (they routinely hold tokens).
 *  Narrowing must go through the `type` discriminant — `"command" in config`
 *  is useless here because passthrough's index signature makes every key
 *  `unknown` on every union member. */
export function describeMcpConfig(config: McpServerConfig): { kind: McpKind; detail: string } {
  if (config.type === "http" || config.type === "sse") {
    return { kind: config.type, detail: config.url };
  }
  // Absent `type` = stdio (same default as the SDK).
  const parts = [config.command, ...(config.args ?? [])];
  const envCount = config.env ? Object.keys(config.env).length : 0;
  return {
    kind: "stdio",
    detail: envCount > 0 ? `${parts.join(" ")} · ${envCount} 个环境变量` : parts.join(" "),
  };
}
