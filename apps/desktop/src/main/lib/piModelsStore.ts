/**
 * Pi models.json store — manages ~/.pi/agent/models.json (metadata) and an
 * encrypted credentials map (apiKey per provider).
 *
 * ## Why two stores
 *
 * models.json is the file Pi SDK reads on every startTurn. The SDK supports
 * three ways to source an apiKey for a custom provider:
 *   1. `models.json` `providers.<name>.apiKey` field (literal / `$ENV` /
 *      `!command`) — visible on disk, awkward to encrypt.
 *   2. `~/.pi/agent/auth.json` — written by the Pi CLI, but Mcode should
 *      not clobber it.
 *   3. `AuthStorage.setRuntimeApiKey(provider, key)` — in-process only.
 *
 * Mcode uses (3) at turn time. The cleartext key lives **only in the
 * encrypted settings map** (safeStorage-backed, same pattern as
 * customModelKeys). models.json is kept as a credential-free metadata file
 * (baseUrl / api / models / unknown-fields-preserved). The store strips any
 * apiKey field from the config before writing to models.json — hand-written
 * `$ENV` refs are still tolerated on read (preserved in the stored metadata
 * copy in case someone hand-edits the file).
 */
import { homedir } from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import type {
  PiModelDefinition,
  PiModelsFile,
  PiProviderConfig,
  PiProviderPublic,
} from "@contracts/piModel";
import { SettingRepo } from "@main/store/repositories.js";
import { encrypt, decrypt } from "@main/lib/secretStore.js";
import { log } from "@main/lib/logger.js";

/** Encrypted apiKey map keyed by provider name. Stored as plain JSON in the
 *  settings table (the values themselves are safeStorage ciphertext blobs). */
const KEYS_SETTING_KEY = "piProviderKeys";
type KeyMap = Record<string, string>;

function readKeyMap(): KeyMap {
  const raw = SettingRepo.get(KEYS_SETTING_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as KeyMap) : {};
  } catch (err) {
    log.error(`piProviderKeys: failed to parse: ${(err as Error).message}`);
    return {};
  }
}

function writeKeyMap(map: KeyMap): void {
  SettingRepo.set(KEYS_SETTING_KEY, JSON.stringify(map));
}

/** Per-model keys the settings form owns. On merge, absence in the incoming
 *  form config clears the key from the stored entry (see saveProvider). */
const PI_MODEL_FORM_MANAGED_KEYS = [
  "name",
  "reasoning",
  "maxTokens",
  "thinkingLevelMap",
] as const;

/** Path to ~/.pi/agent/models.json (Pi SDK's default read target). */
function modelsPath(): string {
  return path.join(homedir(), ".pi", "agent", "models.json");
}

async function readModelsFile(): Promise<PiModelsFile> {
  try {
    const raw = await fs.readFile(modelsPath(), "utf-8");
    const parsed = JSON.parse(raw) as PiModelsFile;
    if (!parsed || typeof parsed !== "object") return { providers: {} };
    if (!parsed.providers || typeof parsed.providers !== "object") {
      return { ...parsed, providers: {} };
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn(`piModels: failed to read models.json (treating as empty): ${(err as Error).message}`);
    }
    return { providers: {} };
  }
}

async function writeModelsFile(file: PiModelsFile): Promise<void> {
  const dir = path.dirname(modelsPath());
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(modelsPath(), JSON.stringify(file, null, 2), "utf-8");
}

/** Build a PiProviderPublic from stored config + hasApiKey flag. The apiKey
 *  itself is never returned. */
function toPublic(cfg: PiProviderConfig, hasApiKey: boolean): PiProviderPublic {
  return { ...cfg, hasApiKey };
}

/** Validate a provider config (without apiKey — that's now stored separately).
 *  baseUrl / api / at-least-one-model are required. */
function validateProvider(name: string, cfg: PiProviderConfig): string | null {
  if (!name.trim()) return "Provider 名称不能为空";
  if (!cfg.baseUrl?.trim()) return "Base URL 不能为空";
  if (!cfg.api) return "API 类型不能为空";
  const models = cfg.models ?? [];
  if (models.length === 0) return "至少需要配置一个模型";
  for (const m of models) {
    if (!m.id?.trim()) return "模型 id 不能为空";
    if (typeof m.contextWindow === "number" && m.contextWindow <= 0) return `模型 ${m.id}:contextWindow 必须大于 0`;
    if (typeof m.maxTokens === "number" && m.maxTokens <= 0) return `模型 ${m.id}:maxTokens 必须大于 0`;
  }
  return null;
}

export const PiModelsStore = {
  /** List all custom providers (apiKey presence only, never cleartext). */
  async listPublic(): Promise<Record<string, PiProviderPublic>> {
    const file = await readModelsFile();
    const keys = readKeyMap();
    const out: Record<string, PiProviderPublic> = {};
    for (const [name, cfg] of Object.entries(file.providers)) {
      out[name] = toPublic(cfg, Boolean(keys[name]));
    }
    return out;
  },

  /**
   * Save (create or update) one provider.
   *
   * - models.json: shallow-merge the config (preserves unknown provider-level
   *   fields; merges per-model by id to preserve model-level fields like
   *   compat / cost — fields the form never edits). Fields the form DOES
   *   manage are replaced wholesale: the form omits them when unset, so an
   *   absent key means the user cleared it and must not resurrect the
   *   previous value. The apiKey field is **stripped** before writing — the
   *   key never lands in models.json.
   * - settings table: when `apiKey` is non-empty, encrypt via safeStorage and
   *   store under `piProviderKeys[name]`. Empty string = "preserve existing
   *   key" on update; missing and provider-new = error.
   */
  async saveProvider(
    name: string,
    config: PiProviderConfig,
    apiKey?: string,
  ): Promise<Record<string, PiProviderPublic>> {
    const err = validateProvider(name, config);
    if (err) throw new Error(err);

    // ---- apiKey handling (encrypted settings map) ----
    const keys = readKeyMap();
    const isNew = !(name in keys);
    if (apiKey && apiKey.trim()) {
      keys[name] = encrypt(apiKey.trim());
    } else if (isNew) {
      throw new Error("新建 Provider 必须填写 API Key");
    }
    // else: empty + existing → preserve old key (no-op on keys map)

    // ---- models.json handling (metadata only) ----
    const file = await readModelsFile();
    const existing = file.providers[name] ?? {};
    const existingModels = new Map((existing.models ?? []).map((m) => [m.id, m]));
    // Per-model fields the settings form manages: piConfigFromForm omits each
    // of these when unset (empty display name, unchecked reasoning, cleared
    // maxTokens, an all-"default" thinkingLevelMap). Spread-merging prev would
    // resurrect the old value and make those edits silently no-op — e.g. a
    // thinkingLevelMap entry can never be reset to "use provider default".
    const mergedModels = (config.models ?? []).map((m) => {
      const prev = existingModels.get(m.id);
      if (!prev) return m;
      const merged: PiModelDefinition = { ...prev, ...m };
      for (const k of PI_MODEL_FORM_MANAGED_KEYS) {
        if (!(k in m)) delete merged[k];
      }
      return merged;
    });
    // Strip apiKey from the config before writing — it's not stored in
    // models.json. Other fields (name / baseUrl / api / authHeader / models
    // / unknown fields) are written verbatim.
    const { apiKey: _drop, ...configWithoutKey } = config;
    const merged: PiProviderConfig = {
      ...existing,
      ...configWithoutKey,
      models: mergedModels,
    };
    // Same rule at provider level for the omittable form-managed fields
    // (baseUrl / api / models are always written and validated non-empty).
    for (const k of ["name", "authHeader"] as const) {
      if (!(k in configWithoutKey)) delete merged[k];
    }
    file.providers[name] = merged;
    await writeModelsFile(file);
    writeKeyMap(keys);
    log.info(`piModels: saved provider "${name}" (${mergedModels.length} models)`);
    return this.listPublic();
  },

  /** Delete one provider. Removes both models.json entry and encrypted key. */
  async deleteProvider(name: string): Promise<Record<string, PiProviderPublic>> {
    const file = await readModelsFile();
    if (name in file.providers) {
      delete file.providers[name];
      await writeModelsFile(file);
    }
    const keys = readKeyMap();
    if (name in keys) {
      delete keys[name];
      writeKeyMap(keys);
    }
    log.info(`piModels: deleted provider "${name}"`);
    return this.listPublic();
  },

  /**
   * Resolve the cleartext apiKey for a provider. Main-process only — the
   * result MUST NOT cross IPC. Used by PiAgentSdkProvider to inject the key
   * into the pi authStorage at turn time.
   */
  resolveApiKey(name: string): string | null {
    const keys = readKeyMap();
    const ciphertext = keys[name];
    if (!ciphertext) return null;
    const cleartext = decrypt(ciphertext);
    return cleartext || null;
  },
};
