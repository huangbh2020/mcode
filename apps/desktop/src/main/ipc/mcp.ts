/**
 * IPC handlers for the settings panel's MCP management section.
 *
 * Six operations over the three server sources (see lib/mcpConfig.ts for the
 * storage design): list (aggregate user file + stash + project .mcp.json +
 * builtin), toggle, add, remove, scanImport (read ~/.claude.json) and import.
 * All mutations are read-modify-write over ~/.mcode/.claude.json so the CLI's
 * own keys in that file always survive; project .mcp.json is never written.
 */
import type { IpcMain } from "electron";
import {
  IPC,
  McpListSchema,
  McpToggleSchema,
  McpSaveSchema,
  McpRemoveSchema,
  McpScanImportSchema,
  McpImportSchema,
  MCP_RESERVED_NAME,
  type McpServerEntry,
} from "@contracts/ipc";
import { ProjectRepo } from "@main/store/repositories.js";
import { samePath } from "@main/lib/pathGuard.js";
import {
  readUserClaudeJson,
  writeUserClaudeJson,
  mcpServersOf,
  parseMcpConfig,
  readCliMcpSources,
  readProjectMcpServers,
  getMcpManagement,
  saveMcpManagement,
  describeMcpConfig,
} from "@main/lib/mcpConfig.js";

/** Resolve a known project root from a caller-supplied projectPath (same
 *  guard as skills.ts — ProjectRepo cross-check, case-insensitive match).
 *  Returns the canonical Project, whose `.path` is what we persist in the
 *  management state so later samePath matching stays stable. */
function findKnownProject(projectPath: string) {
  return ProjectRepo.list().find((p) => samePath(p.path, projectPath));
}

/** Description line for the built-in browser server row. */
const BUILTIN_DETAIL = "browser_navigate / browser_snapshot / browser_click 等应用内浏览器工具";

export function registerMcpHandlers(ipcMain: IpcMain): void {
  // ── List servers across all three sources ──
  ipcMain.handle(IPC.MCP_LIST, async (_evt, raw) => {
    const input = McpListSchema.parse(raw);
    const state = await getMcpManagement();
    const servers: McpServerEntry[] = [];

    // User scope: enabled entries come from the config file; disabled ones
    // from the stash. A name present in both (only possible via an external
    // edit of the file) resolves to enabled — the file wins.
    const cfg = await readUserClaudeJson();
    const fileServers = mcpServersOf(cfg);
    for (const [name, rawConfig] of Object.entries(fileServers)) {
      const config = parseMcpConfig(rawConfig);
      if (!config) continue;
      const { kind, detail } = describeMcpConfig(config);
      servers.push({ name, scope: "user", kind, detail, enabled: true });
    }
    for (const [name, config] of Object.entries(state.userDisabled ?? {})) {
      if (name in fileServers) continue;
      const { kind, detail } = describeMcpConfig(config);
      servers.push({ name, scope: "user", kind, detail, enabled: false });
    }

    // Project scope: entries of the selected project's .mcp.json; enabled =
    // explicitly recorded in the allowlist (project servers default to OFF).
    if (input.projectPath) {
      const project = findKnownProject(input.projectPath);
      if (project) {
        const enabledNames = new Set(
          (state.projectEnabled ?? [])
            .filter((e) => samePath(e.projectPath, project.path))
            .map((e) => e.name),
        );
        for (const [name, rawConfig] of Object.entries(await readProjectMcpServers(project.path))) {
          const config = parseMcpConfig(rawConfig);
          if (!config) continue;
          const { kind, detail } = describeMcpConfig(config);
          servers.push({ name, scope: "project", kind, detail, enabled: enabledNames.has(name) });
        }
      }
    }

    // Built-in in-process browser server.
    servers.push({
      name: MCP_RESERVED_NAME,
      scope: "builtin",
      kind: "builtin",
      detail: BUILTIN_DETAIL,
      enabled: !state.browserDisabled,
    });

    servers.sort((a, b) =>
      a.scope === b.scope ? a.name.localeCompare(b.name) : a.scope === "user" ? -1 : b.scope === "user" ? 1 : a.scope === "project" ? -1 : 1,
    );
    return { servers };
  });

  // ── Toggle a server (scope-specific semantics) ──
  ipcMain.handle(IPC.MCP_TOGGLE, async (_evt, raw) => {
    const input = McpToggleSchema.parse(raw);
    try {
      if (input.scope === "builtin") {
        const state = await getMcpManagement();
        state.browserDisabled = !input.enabled;
        saveMcpManagement(state);
        return { ok: true };
      }

      if (input.scope === "project") {
        if (!input.projectPath) return { ok: false, error: "缺少 projectPath" };
        const project = findKnownProject(input.projectPath);
        if (!project) return { ok: false, error: "未知的项目路径" };
        const state = await getMcpManagement();
        const list = state.projectEnabled ?? [];
        if (input.enabled) {
          if (!list.some((e) => samePath(e.projectPath, project.path) && e.name === input.name)) {
            list.push({ projectPath: project.path, name: input.name });
          }
          state.projectEnabled = list;
        } else {
          state.projectEnabled = list.filter(
            (e) => !(samePath(e.projectPath, project.path) && e.name === input.name),
          );
        }
        saveMcpManagement(state);
        return { ok: true };
      }

      // User scope: move the config between the file (enabled) and the stash.
      const cfg = await readUserClaudeJson();
      const fileServers = mcpServersOf(cfg);
      const state = await getMcpManagement();
      const stash = state.userDisabled ?? {};
      if (input.enabled) {
        const config = stash[input.name];
        if (!config) {
          // Enabling something already enabled (or unknown) — idempotent ok
          // only when the file actually has it; otherwise refuse.
          if (!(input.name in fileServers)) return { ok: false, error: "未找到该 server 的配置" };
          return { ok: true };
        }
        fileServers[input.name] = config;
        delete stash[input.name];
      } else {
        const rawConfig = fileServers[input.name];
        const config = parseMcpConfig(rawConfig);
        if (!config) return { ok: false, error: "未找到该 server 的配置" };
        delete fileServers[input.name];
        stash[input.name] = config;
      }
      cfg.mcpServers = fileServers;
      state.userDisabled = stash;
      await writeUserClaudeJson(cfg);
      saveMcpManagement(state);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  // ── Add a user-scope server ──
  ipcMain.handle(IPC.MCP_SAVE, async (_evt, raw) => {
    const input = McpSaveSchema.parse(raw);
    if (input.name === MCP_RESERVED_NAME) {
      return { ok: false, error: `「${MCP_RESERVED_NAME}」是内置 server 的保留名` };
    }
    try {
      const cfg = await readUserClaudeJson();
      const fileServers = mcpServersOf(cfg);
      const state = await getMcpManagement();
      if (input.name in fileServers || state.userDisabled?.[input.name]) {
        return { ok: false, error: "同名 server 已存在" };
      }
      fileServers[input.name] = input.config;
      cfg.mcpServers = fileServers;
      await writeUserClaudeJson(cfg);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  // ── Remove a user-scope server (file + stash) ──
  ipcMain.handle(IPC.MCP_REMOVE, async (_evt, raw) => {
    const input = McpRemoveSchema.parse(raw);
    try {
      const cfg = await readUserClaudeJson();
      const fileServers = mcpServersOf(cfg);
      const state = await getMcpManagement();
      const stash = state.userDisabled ?? {};
      const inFile = input.name in fileServers;
      const inStash = input.name in stash;
      if (!inFile && !inStash) return { ok: false, error: "未找到该 server" };
      if (inFile) delete fileServers[input.name];
      if (inStash) delete stash[input.name];
      cfg.mcpServers = fileServers;
      state.userDisabled = stash;
      await writeUserClaudeJson(cfg);
      saveMcpManagement(state);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  // ── Scan the local Claude CLI config for importable servers ──
  ipcMain.handle(IPC.MCP_SCAN_IMPORT, async (_evt, raw) => {
    McpScanImportSchema.parse(raw);
    const sources = (await readCliMcpSources()).map((s) => ({
      name: s.name,
      origin: s.origin,
      config: s.config,
      ...describeMcpConfig(s.config),
    }));
    return { sources };
  });

  // ── Import selected servers into the user scope ──
  ipcMain.handle(IPC.MCP_IMPORT, async (_evt, raw) => {
    const input = McpImportSchema.parse(raw);
    const imported: string[] = [];
    const skipped: string[] = [];
    const errors: Array<{ name: string; error: string }> = [];
    try {
      const cfg = await readUserClaudeJson();
      const fileServers = mcpServersOf(cfg);
      const state = await getMcpManagement();
      const stash = state.userDisabled ?? {};
      let changed = false;
      for (const item of input.servers) {
        if (item.name in fileServers || item.name in stash) {
          skipped.push(item.name);
          continue;
        }
        fileServers[item.name] = item.config;
        imported.push(item.name);
        changed = true;
      }
      if (changed) {
        cfg.mcpServers = fileServers;
        await writeUserClaudeJson(cfg);
      }
      return { imported, skipped, errors };
    } catch (err) {
      return {
        imported,
        skipped,
        errors: [...errors, { name: "(批量写入)", error: (err as Error).message }],
      };
    }
  });
}
