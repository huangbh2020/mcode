/**
 * Codex model-provider store — manages the user's third-party Responses-API
 * endpoint configs that drive the Codex harness.
 *
 * ## Storage layout
 *   - settings key `codexProviders`  : JSON array of CodexProviderConfig +
 *     id (metadata only, no secrets).
 *   - settings key `codexProviderKeys`: JSON map id → safeStorage ciphertext
 *     (same pattern as customModelKeys / piProviderKeys).
 *
 * ## config.toml materialization
 * Mcode owns an ISOLATED CODEX_HOME (`~/.mcode/codex`, mirrors the
 * CLAUDE_CONFIG_DIR=~/.mcode precedent). `<CODEX_HOME>/config.toml` is
 * **generated wholesale** from Mcode's settings state on every save/delete —
 * hand-edits to this file are not preserved (it is Mcode-managed by design;
 * users wanting a hand-tuned codex config should keep using their own
 * ~/.codex, which Mcode never touches). Cleartext keys NEVER land in the
 * TOML: each `[model_providers.<id>]` table references an env var
 * (`MCODE_CODEX_KEY_<ID>`) that the app-server subprocess receives at spawn.
 *
 * ⚠️ wire_api is pinned to "responses" — Codex's only supported wire API.
 */
import { homedir } from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import type { CodexModelOption, CodexProviderConfig, CodexProviderPublic } from "@contracts/codexModel";
import { SettingRepo } from "@main/store/repositories.js";
import { encrypt, decrypt } from "@main/lib/secretStore.js";
import { log } from "@main/lib/logger.js";

const execFileAsync = promisify(execFile);

const PROVIDERS_SETTING_KEY = "codexProviders";
const KEYS_SETTING_KEY = "codexProviderKeys";

type StoredProvider = CodexProviderConfig & { id: string };
type KeyMap = Record<string, string>;

/** Mcode's isolated CODEX_HOME — every codex artifact (config.toml, auth,
 *  skills, session rollouts) lives under here, never ~/.codex. */
export function codexHomePath(): string {
  return path.join(homedir(), ".mcode", "codex");
}

/** The env var name a provider's key is injected under (referenced from the
 *  TOML `env_key` field). Uppercased slug-safe transformation of the id. */
export function codexKeyEnvVar(providerId: string): string {
  const slug = providerId.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();
  return `MCODE_CODEX_KEY_${slug}`;
}

/** Model-catalog file materialized next to config.toml. Codex reads it via
 *  `model_catalog_json`, which Mcode passes per turn as an absolute path. */
const MODEL_CATALOG_FILENAME = "mcode-model-catalog.json";

/** Absolute path of the materialized model catalog (see ensureModelCatalog). */
export function codexModelCatalogPath(): string {
  return path.join(codexHomePath(), MODEL_CATALOG_FILENAME);
}

function readProviders(): StoredProvider[] {
  const raw = SettingRepo.get(PROVIDERS_SETTING_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StoredProvider[]) : [];
  } catch (err) {
    log.error(`codexProviders: failed to parse: ${(err as Error).message}`);
    return [];
  }
}

function writeProviders(list: StoredProvider[]): void {
  SettingRepo.set(PROVIDERS_SETTING_KEY, JSON.stringify(list));
}

function readKeyMap(): KeyMap {
  const raw = SettingRepo.get(KEYS_SETTING_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as KeyMap) : {};
  } catch (err) {
    log.error(`codexProviderKeys: failed to parse: ${(err as Error).message}`);
    return {};
  }
}

function writeKeyMap(map: KeyMap): void {
  SettingRepo.set(KEYS_SETTING_KEY, JSON.stringify(map));
}

function validateProvider(id: string, cfg: CodexProviderConfig): string | null {
  if (!id.trim()) return "Provider id 不能为空";
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return "Provider id 只能包含字母、数字、连字符和下划线";
  if (!cfg.name?.trim()) return "Provider 名称不能为空";
  if (!cfg.baseUrl?.trim()) return "Base URL 不能为空";
  if (!/^https?:\/\//.test(cfg.baseUrl.trim())) return "Base URL 必须以 http(s):// 开头";
  const models = cfg.models ?? [];
  if (models.length === 0) return "至少需要配置一个模型";
  for (const m of models) {
    if (!m.id?.trim()) return "模型 id 不能为空";
  }
  return null;
}

/* ── config.toml generation ── */

/** Escape a TOML basic string (lazy but correct for our value alphabet:
 *  backslash, double quote, and the C0 control characters). */
function tomlStr(v: string): string {
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\x00-\x1f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)}"`;
}

/** Serialize one MCP server config into TOML lines (codex field names:
 *  command/args/env for stdio; url for streamable HTTP). SSE is mapped to
 *  url best-effort (codex's native transport is streamable HTTP). Returns
 *  null for configs we can't represent. */
function mcpServerToml(name: string, raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const cfg = raw as Record<string, unknown>;
  const lines: string[] = [`[mcp_servers.${name}]`];
  const type = cfg.type;
  if (type === "http" || type === "sse") {
    if (typeof cfg.url !== "string" || !cfg.url) return null;
    lines.push(`url = ${tomlStr(cfg.url)}`);
    if (cfg.headers && typeof cfg.headers === "object") {
      const entries = Object.entries(cfg.headers as Record<string, unknown>).filter(
        ([, v]) => typeof v === "string",
      );
      if (entries.length > 0) {
        const inner = entries.map(([k, v]) => `${tomlStr(k)} = ${tomlStr(v as string)}`).join(", ");
        lines.push(`http_headers = { ${inner} }`);
      }
    }
    return lines.join("\n");
  }
  // stdio (absent type = stdio, same default as the Claude SDK)
  if (typeof cfg.command !== "string" || !cfg.command) return null;
  lines.push(`command = ${tomlStr(cfg.command)}`);
  if (Array.isArray(cfg.args) && cfg.args.length > 0) {
    const args = cfg.args.filter((a): a is string => typeof a === "string").map(tomlStr);
    lines.push(`args = [${args.join(", ")}]`);
  }
  if (cfg.env && typeof cfg.env === "object") {
    const entries = Object.entries(cfg.env as Record<string, unknown>).filter(
      ([, v]) => typeof v === "string",
    );
    if (entries.length > 0) {
      const inner = entries.map(([k, v]) => `${tomlStr(k)} = ${tomlStr(v as string)}`).join(", ");
      lines.push(`env = { ${inner} }`);
    }
  }
  return lines.join("\n");
}

/** Write `content` to `file` unless it is already there. Skips the write
 *  entirely when the content is unchanged (a running app-server may read the
 *  file at any moment — every turn start materializes) and replaces atomically
 *  (tmp in the same directory + rename) so a concurrent reader never sees a
 *  truncated file. */
async function writeIfChanged(file: string, content: string): Promise<void> {
  try {
    const prev = await fs.readFile(file, "utf-8");
    if (prev === content) return;
  } catch {
    /* first write */
  }
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  await fs.writeFile(tmp, content, "utf-8");
  try {
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** Write <CODEX_HOME>/config.toml from current settings state. Skips the
 *  write entirely when the content is unchanged (a running app-server may
 *  read the file at any moment — every turn start materializes) and writes
 *  atomically (tmp + rename) so a concurrent reader never sees a truncated
 *  file. `cwd` (when provided) enables project-scope .mcp.json materialization
 *  for servers the user explicitly enabled (same allowlist semantics as the
 *  Claude provider). */
async function materializeConfigToml(cwd?: string): Promise<void> {
  const providers = readProviders();
  const lines = [
    "# Generated by Mcode — managed file, hand-edits are overwritten on save.",
    "# Cleartext API keys are injected via process env at app-server spawn",
    "# (see each provider's env_key); they are never written to this file.",
    "",
  ];
  for (const p of providers) {
    lines.push(`[model_providers.${p.id}]`);
    lines.push(`name = ${tomlStr(p.name)}`);
    lines.push(`base_url = ${tomlStr(p.baseUrl)}`);
    lines.push(`env_key = ${tomlStr(codexKeyEnvVar(p.id))}`);
    lines.push(`wire_api = "responses"`);
    if (p.imageGeneration) {
      // Opt-in unlock for codex's standalone imagegen tool (`image_gen.imagegen`).
      // codex gates that tool behind
      // `is_openai() || uses_openai_actor_authorization() || (requires_openai_auth && codex-backend auth)`
      // (core/tools/spec_plan.rs `image_generation_available` + the extension's
      // own install gate); without one of these the model's tool list has no
      // image tool and it answers "no built-in image generation tool
      // available". A nonempty `x-openai-actor-authorization` header satisfies
      // the gate with zero auth impact (env_key bearer still wins in
      // `resolve_provider_auth`), while `requires_openai_auth = true` does NOT
      // unlock the tool when auth comes from env_key (verified against the
      // real binary, 0.153.4). The header is an unknown no-op for
      // OpenAI-compatible gateways; codex's standalone web search stays gated
      // off because third-party models fall back to metadata with
      // supports_search_tool=false. The images request posts to
      // `{baseUrl}/images/generations` with the model fixed to `gpt-image-2`,
      // so enabling this presumes a gateway that backs the OpenAI images API.
      lines.push(`http_headers = { x-openai-actor-authorization = "mcode" }`);
    }
    lines.push("");
  }

  // MCP sync: user-scope enabled servers (the .claude.json file IS the
  // enable mechanism — disabled ones live in the management stash and are
  // absent from the file) + project .mcp.json allowlisted servers.
  try {
    const { getMcpManagement, readUserClaudeJson, mcpServersOf, readProjectMcpServers } =
      await import("@main/lib/mcpConfig.js");
    const management = await getMcpManagement();
    const userCfg = await readUserClaudeJson();
    const sources: Array<[string, unknown]> = Object.entries(mcpServersOf(userCfg));
    if (cwd) {
      const enabled = new Set(
        (management.projectEnabled ?? [])
          .filter((e) => e.projectPath === cwd)
          .map((e) => e.name),
      );
      if (enabled.size > 0) {
        const projectServers = await readProjectMcpServers(cwd);
        for (const [name, cfg] of Object.entries(projectServers)) {
          if (enabled.has(name)) sources.push([name, cfg]);
        }
      }
    }
    // Plugins: MCP servers contributed by ENABLED plugins, injected under the
    // same "<plugin>__<server>" namespace the Claude provider passes per turn
    // (options.mcpServers) — one namespace, identical tool names across
    // providers. Best-effort, same as the scopes above.
    try {
      const { getPluginMcpServers } = await import("@main/plugins/pluginManager.js");
      for (const [name, cfg] of await getPluginMcpServers()) {
        sources.push([name, cfg]);
      }
    } catch (err) {
      log.warn(`codexModels: plugin MCP sync failed (continuing without): ${(err as Error).message}`);
    }
    let wrote = 0;
    for (const [name, cfg] of sources) {
      const toml = mcpServerToml(name, cfg);
      if (toml) {
        lines.push(toml, "");
        wrote++;
      } else {
        log.warn(`codexModels: skipped unrepresentable MCP server "${name}"`);
      }
    }
    if (wrote > 0) log.info(`codexModels: materialized ${wrote} MCP server(s) into config.toml`);
  } catch (err) {
    // MCP sync must never block model-provider materialization.
    log.warn(`codexModels: MCP sync failed (continuing without): ${(err as Error).message}`);
  }

  const dir = codexHomePath();
  await fs.mkdir(dir, { recursive: true });
  // Atomic replace (see writeIfChanged): a concurrent app-server reading
  // config.toml never observes a half-written file.
  await writeIfChanged(path.join(dir, "config.toml"), lines.join("\n"));
}

/* ── model catalog (third-party context windows) ── */

/** One entry of codex's own catalog as rendered by `codex debug models`.
 *  Kept as an opaque record on purpose: Mcode clones an existing entry rather
 *  than restating codex's schema, so a codex upgrade adding a required field
 *  can't turn our file into a parse error (a rejected catalog fails the
 *  app-server start, i.e. every turn). */
type CatalogEntry = Record<string, unknown> & { slug: string; priority?: number };

/** `codex debug models` costs a full codex process start — cache per binary. */
let catalogTemplateCache: { codexPath: string; entries: CatalogEntry[] } | null = null;
/** Signature of the last catalog written, so per-turn materialization is a
 *  no-op unless the configured models actually changed. */
let catalogCache: { signature: string; path: string } | null = null;

/** Read codex's own catalog to clone entry templates from (see
 *  ensureModelCatalog). Best-effort: null when codex can't be queried. */
async function readCatalogTemplate(codexPath: string): Promise<CatalogEntry[] | null> {
  if (catalogTemplateCache?.codexPath === codexPath) return catalogTemplateCache.entries;
  try {
    const { stdout } = await execFileAsync(codexPath, ["debug", "models"], {
      env: { ...process.env, CODEX_HOME: codexHomePath() },
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    const parsed: unknown = JSON.parse(stdout);
    const raw = (parsed as { models?: unknown }).models;
    const entries = Array.isArray(raw)
      ? raw.filter(
          (m): m is CatalogEntry =>
            typeof m === "object" && m !== null && typeof (m as CatalogEntry).slug === "string",
        )
      : [];
    if (entries.length === 0) return null;
    catalogTemplateCache = { codexPath, entries };
    return entries;
  } catch (err) {
    log.warn(`codexModels: could not read codex's builtin model catalog: ${(err as Error).message}`);
    return null;
  }
}

/** Configured models that declare an explicit context window, deduped by id
 *  (two providers may expose the same model id — the first one wins). */
function modelsWithContextWindow(
  providers: StoredProvider[],
): Array<{ id: string; label?: string; contextWindow: number }> {
  const seen = new Set<string>();
  const out: Array<{ id: string; label?: string; contextWindow: number }> = [];
  for (const p of providers) {
    for (const m of p.models ?? []) {
      const id = m.id?.trim();
      if (!id || seen.has(id)) continue;
      if (typeof m.contextWindow !== "number" || m.contextWindow <= 0) continue;
      seen.add(id);
      out.push({ id, ...(m.label?.trim() ? { label: m.label.trim() } : {}), contextWindow: m.contextWindow });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export const CodexModelsStore = {
  /** List all configured providers (apiKey presence only, never cleartext). */
  async listPublic(): Promise<CodexProviderPublic[]> {
    const providers = readProviders();
    const keys = readKeyMap();
    return providers.map((p) => ({ ...p, hasApiKey: Boolean(keys[p.id]) }));
  },

  /** Save (create or update) one provider, then rematerialize config.toml. */
  async saveProvider(
    id: string,
    config: CodexProviderConfig,
    apiKey?: string,
  ): Promise<CodexProviderPublic[]> {
    const err = validateProvider(id, config);
    if (err) throw new Error(err);

    const keys = readKeyMap();
    const isNew = !(id in keys);
    if (apiKey && apiKey.trim()) {
      keys[id] = encrypt(apiKey.trim());
    } else if (isNew) {
      throw new Error("新建 Provider 必须填写 API Key");
    }
    // else: empty + existing → preserve old key.

    const providers = readProviders();
    const stored: StoredProvider = {
      id,
      name: config.name.trim(),
      baseUrl: config.baseUrl.trim(),
      ...(config.imageGeneration ? { imageGeneration: true } : {}),
      models: config.models
        .filter((m) => m.id?.trim())
        .map((m: CodexModelOption) => ({
          id: m.id.trim(),
          ...(m.label?.trim() ? { label: m.label.trim() } : {}),
          ...(m.hint?.trim() ? { hint: m.hint.trim() } : {}),
          ...(typeof m.contextWindow === "number" && m.contextWindow > 0 ? { contextWindow: m.contextWindow } : {}),
        })),
    };
    const idx = providers.findIndex((p) => p.id === id);
    if (idx >= 0) providers[idx] = stored;
    else providers.push(stored);

    writeProviders(providers);
    writeKeyMap(keys);
    await materializeConfigToml();
    log.info(`codexModels: saved provider "${id}" (${stored.models.length} models)`);
    return this.listPublic();
  },

  /** Delete one provider (settings + encrypted key), rematerialize config.toml. */
  async deleteProvider(id: string): Promise<CodexProviderPublic[]> {
    const providers = readProviders().filter((p) => p.id !== id);
    writeProviders(providers);
    const keys = readKeyMap();
    if (id in keys) {
      delete keys[id];
      writeKeyMap(keys);
    }
    await materializeConfigToml();
    log.info(`codexModels: deleted provider "${id}"`);
    return this.listPublic();
  },

  /** Resolve the cleartext apiKey for a provider. Main-process only — the
   *  result MUST NOT cross IPC. Used by CodexAgentSdkProvider to inject the
   *  key into the app-server process env at spawn time. */
  resolveApiKey(providerId: string): string | null {
    const ciphertext = readKeyMap()[providerId];
    if (!ciphertext) return null;
    return decrypt(ciphertext) || null;
  },

  /** Ensure config.toml exists and matches current settings (called lazily
   *  before spawning app-server — covers a config written by an older build
   *  or a deleted CODEX_HOME). `cwd` enables project-scope MCP sync. */
  async ensureConfigMaterialized(cwd?: string): Promise<void> {
    await materializeConfigToml(cwd);
  },

  /** Materialize the model catalog for the configured third-party models and
   *  return its absolute path (null when no model declares a context window,
   *  or when the catalog could not be built — the turn then keeps today's
   *  behaviour, codex's 272k fallback metadata).
   *
   *  WHY it exists: `-c model_context_window` is applied as `min(model
   *  metadata, override)` — it can only NARROW a window. A model codex has no
   *  metadata for resolves to its 272k fallback, so the override can never
   *  raise it. Measured on codex 0.153.4 (the window a session actually
   *  reports): unknown model + override 1000000 → 258400 (= 272k × 95%),
   *  unknown model + override 100000 → 95000, builtin gpt-6-astra (872k
   *  metadata) + override 1000000 → 828400. Declaring the window as catalog
   *  metadata is the only way up; the effective window then is
   *  context_window × effective_context_window_percent (95%).
   *
   *  The file content depends only on the configured models — never on the
   *  session — and is written atomically, so it adds no shared-state race. */
  async ensureModelCatalog(codexPath: string | null): Promise<string | null> {
    const targets = modelsWithContextWindow(readProviders());
    const file = codexModelCatalogPath();
    if (targets.length === 0 || !codexPath) {
      if (catalogCache) {
        catalogCache = null;
        await fs.rm(file, { force: true }).catch(() => {});
      }
      return null;
    }
    const signature = JSON.stringify(targets);
    if (catalogCache?.signature === signature) {
      try {
        await fs.access(file);
        return catalogCache.path;
      } catch {
        /* removed externally → rebuild below */
      }
    }
    const entries = await readCatalogTemplate(codexPath);
    if (!entries) return null;
    // Clone codex's own default entry (lowest priority = the model codex picks
    // when nothing is pinned) as the template: that keeps the entry
    // schema-complete AND keeps codex's own instructions template.
    // `base_instructions` is mandatory, and handing codex our own text there
    // would replace the agent's system prompt (an empty string silences it).
    const defaultEntry = entries.reduce(
      (best, e) => ((e.priority ?? Number.MAX_SAFE_INTEGER) < (best.priority ?? Number.MAX_SAFE_INTEGER) ? e : best),
      entries[0],
    );
    const custom: CatalogEntry[] = targets.map((t, i) => ({
      ...structuredClone(defaultEntry),
      slug: t.id,
      display_name: t.label ?? t.id,
      description: t.label ?? t.id,
      context_window: t.contextWindow,
      max_context_window: t.contextWindow,
      visibility: "list",
      // Park third-party entries behind codex's own models (priority decides
      // the catalog default, see the clone note above); Mcode pins the model
      // per turn regardless.
      priority: 1000 + i,
    }));
    const customIds = new Set(custom.map((c) => c.slug));
    const models = [...entries.filter((e) => !customIds.has(e.slug)), ...custom];
    await writeIfChanged(file, `${JSON.stringify({ models }, null, 2)}\n`);
    catalogCache = { signature, path: file };
    log.info(`codexModels: materialized model catalog (${custom.length} model(s) with an explicit context window)`);
    return file;
  },
};
