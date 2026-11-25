/**
 * Sync active Claude provider settings to native Claude Code `settings.json`
 * files (`~/.mcode/settings.json` and/or `~/.claude/settings.json`), and import
 * existing `settings.json` env blocks into Mcode.
 *
 * All writes preserve unknown top-level keys (permissions, hooks, outputStyle,
 * etc.) and unrelated user env vars, while clearing stale keys from
 * `CLAUDE_MANAGED_ENV_KEYS` so switching providers never leaks an old token or
 * base URL.
 */
import { existsSync, readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type {
  ApiConfig,
  ClaudeImportCandidate,
  ClaudeSettingsSyncState,
  ClaudeSettingsSyncTarget,
  ClaudeTierModels,
  CustomModelEntry,
} from "@contracts/customModel";
import {
  CLAUDE_MANAGED_ENV_KEYS,
  MCODE_CONFIG_DIR,
  buildClaudeSettingsEnv,
  strip1MSuffix,
} from "@main/providers/claude-sdk/customEnv.js";
import { parseCustomHeaderLines } from "@main/providers/upstreamHeaders.js";
import { SettingRepo } from "@main/store/repositories.js";
import { log } from "@main/lib/logger.js";

const ACTIVE_PROVIDER_KEY = "claudeActiveProviderId";
const SYNC_TARGET_KEY = "claudeSettingsSyncTarget";

const MCODE_SETTINGS_PATH = path.join(MCODE_CONFIG_DIR, "settings.json");
const CLAUDE_SETTINGS_PATH = path.join(homedir(), ".claude", "settings.json");

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

async function readJsonSafe(file: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf-8"));
    return asRecord(parsed) ?? {};
  } catch {
    return {};
  }
}

async function writeJsonAtomic(file: string, value: Record<string, unknown>): Promise<void> {
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
      /* best-effort cleanup */
    }
    await fs.writeFile(file, text, "utf-8");
  }
}

function targetPathsFor(target: ClaudeSettingsSyncTarget): string[] {
  switch (target) {
    case "mcode":
      return [MCODE_SETTINGS_PATH];
    case "claude":
      return [CLAUDE_SETTINGS_PATH];
    case "both":
      return [MCODE_SETTINGS_PATH, CLAUDE_SETTINGS_PATH];
    case "none":
      return [];
  }
}

export function getClaudeSettingsSyncState(): ClaudeSettingsSyncState {
  const activeRaw = SettingRepo.get(ACTIVE_PROVIDER_KEY);
  const targetRaw = SettingRepo.get(SYNC_TARGET_KEY);
  const syncTarget: ClaudeSettingsSyncTarget =
    targetRaw === "none" || targetRaw === "mcode" || targetRaw === "claude" || targetRaw === "both"
      ? targetRaw
      : "mcode";
  return {
    activeProviderId: activeRaw && activeRaw.trim() ? activeRaw : null,
    syncTarget,
  };
}

export function setActiveClaudeProviderId(id: string | null): ClaudeSettingsSyncState {
  if (id) {
    SettingRepo.set(ACTIVE_PROVIDER_KEY, id);
  } else {
    SettingRepo.set(ACTIVE_PROVIDER_KEY, "");
  }
  return getClaudeSettingsSyncState();
}

export function setClaudeSettingsSyncTarget(target: ClaudeSettingsSyncTarget): ClaudeSettingsSyncState {
  SettingRepo.set(SYNC_TARGET_KEY, target);
  return getClaudeSettingsSyncState();
}

/**
 * Synchronize `apiConfig` (resolved with its default model) to the configured
 * `settings.json` files. Returns an optional warning string (e.g. when syncing
 * an OpenAI-protocol provider to `~/.claude/settings.json`).
 */
export async function syncClaudeSettingsFiles(
  apiConfig: ApiConfig | null,
  target: ClaudeSettingsSyncTarget,
): Promise<{ warning?: string }> {
  const paths = targetPathsFor(target);
  if (paths.length === 0) return {};

  let warning: string | undefined;
  const nextEnv = apiConfig ? buildClaudeSettingsEnv(apiConfig) : null;

  if (apiConfig?.protocol === "openai" && (target === "claude" || target === "both")) {
    warning =
      "当前供应商使用 OpenAI 协议（依赖 Mcode 本地协议转换桥），写入 ~/.claude/settings.json 后无法在外部独立终端直接生效；仅原生 Anthropic 协议供应商支持外部终端直连。";
  }

  for (const file of paths) {
    // Only write native anthropic provider env to external ~/.claude/settings.json;
    // writing an openai endpoint's raw URL without Mcode's local bridge would break external CLI.
    if (file === CLAUDE_SETTINGS_PATH && apiConfig?.protocol === "openai") {
      continue;
    }

    const doc = await readJsonSafe(file);
    const prevEnv = asRecord(doc.env) ?? {};
    const mergedEnv: Record<string, unknown> = { ...prevEnv };

    for (const key of CLAUDE_MANAGED_ENV_KEYS) {
      delete mergedEnv[key];
    }
    if (nextEnv) {
      for (const [k, v] of Object.entries(nextEnv)) {
        mergedEnv[k] = v;
      }
    }

    if (Object.keys(mergedEnv).length > 0) {
      doc.env = mergedEnv;
    } else {
      delete doc.env;
    }

    await writeJsonAtomic(file, doc);
  }

  log.info(`claude settings sync: target=${target} active=${apiConfig ? apiConfig.baseUrl : "cleared"}`);
  return warning ? { warning } : {};
}

/**
 * Read the keys currently present in `~/.mcode/settings.json`'s `env` block,
 * so `--settings.env` in a GUI turn can shadow any conflicting keys from disk
 * (e.g. when a session selects a provider other than the currently synced one).
 */
export function buildShadowingSettingsEnv(
  cfg: ApiConfig,
  opts?: { sessionId?: string; thinkingEffort?: string },
): Record<string, string> {
  const desired = buildClaudeSettingsEnv(cfg, opts);
  if (!existsSync(MCODE_SETTINGS_PATH)) return desired;

  try {
    const parsed = asRecord(JSON.parse(readFileSync(MCODE_SETTINGS_PATH, "utf-8")));
    const diskEnv = asRecord(parsed?.env);
    if (!diskEnv) return desired;

    const out: Record<string, string> = { ...desired };
    for (const key of CLAUDE_MANAGED_ENV_KEYS) {
      if (key in diskEnv && !(key in out)) {
        out[key] = "";
      }
    }
    return out;
  } catch {
    return desired;
  }
}

/**
 * Read an existing `settings.json` (`~/.claude/settings.json` or
 * `~/.mcode/settings.json`) and extract a {@link ClaudeImportCandidate} for
 * quick import into Mcode's Claude provider form.
 */
export async function importFromClaudeSettingsFile(
  preferredSource?: "claude" | "mcode",
): Promise<ClaudeImportCandidate | null> {
  const order: Array<"claude" | "mcode"> =
    preferredSource === "mcode" ? ["mcode", "claude"] : ["claude", "mcode"];

  for (const src of order) {
    const file = src === "claude" ? CLAUDE_SETTINGS_PATH : MCODE_SETTINGS_PATH;
    if (!existsSync(file)) continue;
    const doc = await readJsonSafe(file);
    const env = asRecord(doc.env);
    if (!env) continue;

    const str = (k: string): string => (typeof env[k] === "string" ? (env[k] as string).trim() : "");
    const baseUrl = str("ANTHROPIC_BASE_URL");
    const apiKey = str("ANTHROPIC_API_KEY");
    const authToken = str("ANTHROPIC_AUTH_TOKEN");
    const token = authToken || apiKey;
    const authMode = !authToken && apiKey ? "api_key" : "auth_token";

    if (!baseUrl && !token) continue;

    const rawModel = str("ANTHROPIC_MODEL");
    const sonnet = strip1MSuffix(str("ANTHROPIC_DEFAULT_SONNET_MODEL"));
    const opus = strip1MSuffix(str("ANTHROPIC_DEFAULT_OPUS_MODEL"));
    const fable = strip1MSuffix(str("ANTHROPIC_DEFAULT_FABLE_MODEL"));
    const haiku = strip1MSuffix(str("ANTHROPIC_DEFAULT_HAIKU_MODEL") || str("ANTHROPIC_SMALL_FAST_MODEL"));
    const subagent = strip1MSuffix(str("CLAUDE_CODE_SUBAGENT_MODEL"));

    const seen = new Set<string>();
    const models: CustomModelEntry[] = [];
    const pushModel = (raw: string) => {
      if (!raw) return;
      const supports1m = /\[1m\]$/i.test(raw);
      const id = strip1MSuffix(raw);
      if (!id) return;
      const existing = models.find((m) => m.id === id);
      if (existing) {
        if (supports1m) existing.supports1m = true;
        return;
      }
      seen.add(id);
      models.push(supports1m ? { id, supports1m: true } : { id });
    };

    pushModel(rawModel);
    pushModel(sonnet);
    pushModel(opus);
    pushModel(fable);
    pushModel(haiku);
    pushModel(subagent);

    const tierModels: ClaudeTierModels = {};
    const defaultBare = strip1MSuffix(rawModel);
    if (defaultBare) tierModels.defaultModel = defaultBare;
    if (sonnet) tierModels.sonnet = sonnet;
    if (opus) tierModels.opus = opus;
    if (fable) tierModels.fable = fable;
    if (haiku) tierModels.haiku = haiku;
    if (subagent) tierModels.subagent = subagent;

    const timeoutNum = Number(str("API_TIMEOUT_MS"));
    const customHeadersRaw = str("ANTHROPIC_CUSTOM_HEADERS");
    const parsedHeaders = customHeadersRaw ? parseCustomHeaderLines(customHeadersRaw) : undefined;

    return {
      source: src,
      baseUrl: baseUrl || "https://api.anthropic.com",
      authMode,
      authToken: token,
      models,
      tierModels: Object.keys(tierModels).length > 0 ? tierModels : undefined,
      disableNonEssentialTraffic: str("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC") !== "0",
      timeoutMs: Number.isFinite(timeoutNum) && timeoutNum > 0 ? timeoutNum : undefined,
      customHeaders: parsedHeaders && Object.keys(parsedHeaders).length > 0 ? parsedHeaders : undefined,
    };
  }

  return null;
}
