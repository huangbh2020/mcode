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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadNodePty } from "@main/terminal/TerminalManager.js";
import {
  IPC,
  McpListSchema,
  McpToggleSchema,
  McpSaveSchema,
  McpRemoveSchema,
  McpScanImportSchema,
  McpImportSchema,
  McpAuthorizeSchema,
  McpUnauthorizeSchema,
  MCP_RESERVED_NAME,
  type McpServerEntry,
} from "@contracts/ipc";
import { ProjectRepo } from "@main/store/repositories.js";
import { samePath } from "@main/lib/pathGuard.js";
import { MCODE_CONFIG_DIR } from "@main/providers/claude-sdk/customEnv.js";
import { resolveSdkBinaryPath } from "@main/providers/claude-sdk/sdkBinaryPath.js";
import {
  listPluginMcpPanelEntries,
  setPluginMcpDisabled,
} from "@main/plugins/pluginManager.js";
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

/* ── OAuth needs-auth state ──
 * The CLI records remote servers that demanded OAuth but hold no stored
 * token in `<CLAUDE_CONFIG_DIR>/mcp-needs-auth-cache.json`
 * (`{ "<namespaced server name>": { timestamp } }`). Until the user completes
 * the browser login, the server's tools never reach the model — surfaced in
 * the panel as a badge + an authorize action. */

const NEEDS_AUTH_CACHE_FILE = path.join(MCODE_CONFIG_DIR, "mcp-needs-auth-cache.json");

function readNeedsAuthNames(): Set<string> {
  try {
    const raw = JSON.parse(readFileSync(NEEDS_AUTH_CACHE_FILE, "utf-8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return new Set();
    return new Set(Object.keys(raw as Record<string, unknown>));
  } catch {
    return new Set();
  }
}

function forgetNeedsAuth(name: string): void {
  try {
    if (!existsSync(NEEDS_AUTH_CACHE_FILE)) return;
    const raw = JSON.parse(readFileSync(NEEDS_AUTH_CACHE_FILE, "utf-8")) as Record<string, unknown>;
    if (!(name in raw)) return;
    delete raw[name];
    // Rewrite via the JSON round-trip — tiny file, atomicity is not critical
    // (a torn write just loses the flag; the CLI re-adds it on the next 401).
    writeFileSync(NEEDS_AUTH_CACHE_FILE, JSON.stringify(raw), "utf-8");
  } catch {
    /* best-effort badge cleanup */
  }
}

/** Re-add `name` to the CLI's needs-auth cache (best-effort mirror of what
 *  the CLI does on a 401). After a sign-out the server DOES require OAuth
 *  again — without this the panel badge would stay dark until the next turn
 *  happens to hit the unauthorized request. */
function markNeedsAuth(name: string): void {
  try {
    const raw = existsSync(NEEDS_AUTH_CACHE_FILE)
      ? (JSON.parse(readFileSync(NEEDS_AUTH_CACHE_FILE, "utf-8")) as Record<string, unknown>)
      : {};
    raw[name] = { timestamp: Date.now() };
    writeFileSync(NEEDS_AUTH_CACHE_FILE, JSON.stringify(raw), "utf-8");
  } catch {
    /* best-effort badge update */
  }
}

/** Names of servers holding a stored OAuth token (non-empty accessToken in
 *  `.credentials.json`). darwin keeps MCP OAuth tokens in the Keychain, so
 *  there this set is always empty — callers treat darwin as "unknown". */
function readAuthorizedNames(): Set<string> {
  const out = new Set<string>();
  try {
    const file = path.join(MCODE_CONFIG_DIR, ".credentials.json");
    if (!existsSync(file)) return out;
    const raw = JSON.parse(readFileSync(file, "utf-8")) as {
      mcpOAuth?: Record<string, { serverName?: string; accessToken?: string }>;
    };
    for (const entry of Object.values(raw.mcpOAuth ?? {})) {
      if (entry.serverName && typeof entry.accessToken === "string" && entry.accessToken.length > 0) {
        out.add(entry.serverName);
      }
    }
  } catch {
    /* unreadable credentials — no authorized state */
  }
  return out;
}

/** Whether `.credentials.json` holds an OAuth token for `name` (the CLI keys
 *  entries `"<serverName>|<url hash>"` with a serverName field inside). Used
 *  to double-check login/logout outcomes — the CLI prints some failures
 *  (e.g. "No MCP server named …") while still exiting 0. */
function hasStoredToken(name: string): boolean {
  return readAuthorizedNames().has(name);
}

interface CapturedRun {
  ok: boolean;
  /** Trailing combined output (ANSI stripped) — user-presentable error
   *  context. */
  message: string;
  /** True when the process never launched (bad path), as opposed to
   *  launching and exiting non-zero. */
  spawnFailed: boolean;
}

const ANSI_RE = /\x1B\[[0-9;?]*[ -/]*[@-~]|\x1B\][^\x07]*(?:\x07|\x1B\\)/g;

/** Run a short-lived CLI process inside a pseudo-TTY, capturing trailing
 *  output. Used by the OAuth login flow: `claude mcp login` REFUSES to
 *  authenticate when stdin isn't a terminal (probed live), so a plain spawn
 *  is a dead end — a PTY satisfies the check and the CLI opens the system
 *  browser itself; the localhost callback completes the flow. */
function runCaptured(
  cmd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<CapturedRun> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = (r: CapturedRun) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };
    let pty: import("node-pty").IPty;
    try {
      pty = loadNodePty().spawn(cmd, args, {
        name: "xterm-256color",
        cols: 100,
        rows: 30,
        cwd: MCODE_CONFIG_DIR,
        // node-pty's env type wants strings; drop undefined values.
        env: Object.fromEntries(
          Object.entries(opts.env ?? process.env).filter(([, v]) => v !== undefined),
        ) as Record<string, string>,
      });
    } catch (err) {
      finish({ ok: false, message: (err as Error).message, spawnFailed: true });
      return;
    }
    let tail = "";
    pty.onData((d) => {
      tail = (tail + d).slice(-2000);
    });
    pty.onExit(({ exitCode }) =>
      finish(
        exitCode === 0
          ? { ok: true, message: "", spawnFailed: false }
          : {
              ok: false,
              message: `退出码 ${exitCode}:${tail.replace(ANSI_RE, "").trim().slice(-400) || "(无输出)"}`,
              spawnFailed: false,
            },
      ),
    );
    // Defensive nudge: some CLI auth flows sit behind an "Press Enter …"
    // prompt; a lone Enter is a no-op when there isn't one.
    setTimeout(() => {
      try {
        pty.write("\r");
      } catch {
        /* process may have exited already */
      }
    }, 2_000);
    timer = setTimeout(() => {
      try {
        pty.kill();
      } catch {
        /* already gone */
      }
      finish({
        ok: false,
        message: `授权超时(${Math.round(opts.timeoutMs / 1000)}s):请确认已在浏览器中完成登录`,
        spawnFailed: false,
      });
    }, opts.timeoutMs);
  });
}

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

    // Plugin-contributed servers: entries of ENABLED plugins, namespaced
    // "<plugin>__<server>". The per-server toggle flips the denylist in the
    // plugins settings; the plugin's own enable switch is the master gate.
    for (const entry of await listPluginMcpPanelEntries()) {
      servers.push(entry);
    }

    // Built-in in-process browser server.
    servers.push({
      name: MCP_RESERVED_NAME,
      scope: "builtin",
      kind: "builtin",
      detail: BUILTIN_DETAIL,
      enabled: !state.browserDisabled,
    });

    // Remote servers' OAuth state: a stored token wins over a stale needs-auth
    // cache entry (the CLI clears the cache on login, but belt-and-suspenders).
    const needsAuth = readNeedsAuthNames();
    const authorized = readAuthorizedNames();
    for (const s of servers) {
      if (s.kind !== "http" && s.kind !== "sse") continue;
      if (authorized.has(s.name)) s.authorized = true;
      else if (needsAuth.has(s.name)) s.needsAuth = true;
    }

    servers.sort((a, b) =>
      a.scope === b.scope ? a.name.localeCompare(b.name) : a.scope === "user" ? -1 : b.scope === "user" ? 1 : a.scope === "project" ? -1 : b.scope === "plugin" ? -1 : 1,
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

      if (input.scope === "plugin") {
        // Plugin-contributed server: flip its entry on the plugins.mcpDisabled
        // denylist. The config itself lives in the plugin tree and is never
        // rewritten here.
        return setPluginMcpDisabled(input.name, !input.enabled);
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

  // ── OAuth authorize a remote server (browser login via the Claude CLI) ──
  ipcMain.handle(IPC.MCP_AUTHORIZE, async (_evt, raw) => {
    const input = McpAuthorizeSchema.parse(raw);
    // Spawn-safe guards: the name lands in argv and as a config key, the URL
    // in argv (a cmd /c fallback re-quotes them) — keep both to a
    // conservative charset.
    if (!/^[A-Za-z0-9_-]+$/.test(input.name)) return { ok: false, error: "非法 server 名" };
    if (!/^https?:\/\/[^\s"'`<>^|]*$/.test(input.url)) {
      return { ok: false, error: "仅支持 http(s) 地址" };
    }
    const claudeBin = resolveSdkBinaryPath();
    if (!claudeBin) {
      return { ok: false, error: "未找到 Claude CLI 运行时:请到「设置 → Agent」安装后再试。" };
    }

    const cfg = await readUserClaudeJson();
    const fileServers = mcpServersOf(cfg);
    const existed = fileServers[input.name];
    try {
      // `claude mcp login` resolves the server from the config file, so
      // register it (user scope, exactly the namespaced name + URL the SDK
      // injects per-turn — OAuth tokens are keyed by name + URL) for the
      // duration of the flow. The finally-block restores what was there.
      fileServers[input.name] = { type: input.kind, url: input.url };
      cfg.mcpServers = fileServers;
      await writeUserClaudeJson(cfg);

      const env = { ...process.env, CLAUDE_CONFIG_DIR: MCODE_CONFIG_DIR };
      const res = await runCaptured(claudeBin, ["mcp", "login", input.name], { env, timeoutMs: 300_000 });
      if (!res.ok) {
        return { ok: false, error: res.message || "claude mcp login 失败" };
      }
      // Exit code 0 alone isn't trustworthy (the CLI prints some failures
      // while exiting 0), so where tokens land in the credentials file,
      // require one for this server.
      if (process.platform !== "darwin" && !hasStoredToken(input.name)) {
        return { ok: false, error: res.message || "CLI 报告成功,但未找到已存储的授权令牌" };
      }
      // Success: clear the stale flag so the panel badge goes away now (the
      // CLI re-adds it if the token ever expires and a 401 recurs).
      forgetNeedsAuth(input.name);
      return { ok: true };
    } finally {
      try {
        const restore = await readUserClaudeJson();
        const servers = mcpServersOf(restore);
        if (existed) servers[input.name] = existed;
        else delete servers[input.name];
        restore.mcpServers = servers;
        await writeUserClaudeJson(restore);
      } catch {
        /* best-effort config restore */
      }
    }
  });

  // ── OAuth sign-out: clear a remote server's stored token ──
  ipcMain.handle(IPC.MCP_UNAUTHORIZE, async (_evt, raw) => {
    const input = McpUnauthorizeSchema.parse(raw);
    // Same spawn-safe guards as authorize.
    if (!/^[A-Za-z0-9_-]+$/.test(input.name)) return { ok: false, error: "非法 server 名" };
    if (!/^https?:\/\/[^\s"'`<>^|]*$/.test(input.url)) {
      return { ok: false, error: "仅支持 http(s) 地址" };
    }
    // Nothing to clear (darwin can't see the Keychain — let the CLI try
    // anyway there rather than false-negatives).
    if (process.platform !== "darwin" && !hasStoredToken(input.name)) {
      return { ok: false, error: "该 server 没有已存储的授权" };
    }
    const claudeBin = resolveSdkBinaryPath();
    if (!claudeBin) {
      return { ok: false, error: "未找到 Claude CLI 运行时:请到「设置 → Agent」安装后再试。" };
    }

    const cfg = await readUserClaudeJson();
    const fileServers = mcpServersOf(cfg);
    const existed = fileServers[input.name];
    try {
      // `claude mcp logout` also resolves the server from the config file —
      // same temporary registration + restore as the login flow.
      fileServers[input.name] = { type: input.kind, url: input.url };
      cfg.mcpServers = fileServers;
      await writeUserClaudeJson(cfg);

      const env = { ...process.env, CLAUDE_CONFIG_DIR: MCODE_CONFIG_DIR };
      const res = await runCaptured(claudeBin, ["mcp", "logout", input.name], { env, timeoutMs: 60_000 });
      if (!res.ok) return { ok: false, error: res.message || "claude mcp logout 失败" };
      if (process.platform !== "darwin" && hasStoredToken(input.name)) {
        return { ok: false, error: res.message || "CLI 报告成功,但授权令牌仍然存在" };
      }
      // The server does require OAuth (it had a token) — flip the panel to
      // 待授权 immediately instead of waiting for the next 401 to re-add it.
      markNeedsAuth(input.name);
      return { ok: true };
    } finally {
      try {
        const restore = await readUserClaudeJson();
        const servers = mcpServersOf(restore);
        if (existed) servers[input.name] = existed;
        else delete servers[input.name];
        restore.mcpServers = servers;
        await writeUserClaudeJson(restore);
      } catch {
        /* best-effort config restore */
      }
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
