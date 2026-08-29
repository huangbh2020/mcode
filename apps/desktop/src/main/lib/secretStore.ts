/**
 * Encrypted storage for secrets (auth tokens) backed by Electron safeStorage.
 *
 * safeStorage uses the OS-native keychain: Windows DPAPI, macOS Keychain,
 * Linux libsecret. The cleartext token NEVER touches disk — only an opaque
 * base64 ciphertext blob does, stored as JSON under the `settings` table
 * key `customModelKeys` (a `{ [modelId]: base64Ciphertext }` map). The
 * non-secret metadata (name, baseUrl, authMode, models, …) lives under
 * `customModels`.
 *
 * When safeStorage is unavailable (e.g. some headless Linux without a
 * secret service), we fall back to plain base64 of the cleartext and log a
 * loud warning — the feature still works, but the token is only obfuscated,
 * not encrypted. This is the documented Electron guidance.
 *
 * ## Schema migration (legacy shapes → flat model list)
 *
 * Configs persisted before the flat-model-list refactor carry older shapes:
 *
 *   1. `roles: RoleBindings` (5-tier role bindings) — the immediately
 *      previous shape.
 *   2. `models: string[]` + `alias: { haiku?, sonnet?, opus? }` — the
 *      original shape.
 *
 * `migrateMeta()` synthesizes the flat `models: CustomModelEntry[]` list on
 * read so old configs upgrade transparently: distinct `requestModel` values
 * (in canonical role order) become model entries, with `supports1m` OR-ed
 * across roles that share the same model id. The legacy `roles` map is kept
 * on the migrated record as an undocumented ghost field so pre-refactor
 * sessions — whose `model` column still holds a ROLE KEY like "sonnet" —
 * keep resolving to the same gateway model via {@link resolveApiConfig}.
 * The ghost is dropped the next time the config is saved (the new input
 * shape carries only the flat list).
 */
import { safeStorage } from "electron";
import type {
  CustomModelMeta,
  CustomModelPublic,
  CustomModelInput,
  ApiConfig,
  AuthMode,
  Protocol,
  CustomModelEntry,
} from "@contracts/customModel";
import { resolveProtocol } from "@contracts/customModel";
import { SettingRepo } from "@main/store/repositories.js";
import { log } from "@main/lib/logger.js";

/** Settings-table key for the encrypted-token map. */
const KEYS_SETTING_KEY = "customModelKeys";
/** Settings-table key for the public metadata array (no secrets). */
const META_SETTING_KEY = "customModels";

/** Default auth mode when a stored config predates the authMode field, or
 *  when the user creates one without choosing. `auth_token` is the right
 *  default for the overwhelming majority of third-party gateways (DeepSeek,
 *  one-api, new-api) — they all expect `Authorization: Bearer`. */
const DEFAULT_AUTH_MODE: AuthMode = "auth_token";

type KeyMap = Record<string, string>; // id -> base64 (ciphertext or plaintext)

let unavailableWarned = false;

function isAvailable(): boolean {
  const ok = safeStorage.isEncryptionAvailable();
  if (!ok && !unavailableWarned) {
    log.warn(
      "safeStorage encryption is NOT available — custom-model tokens will be stored as plain base64 (obfuscated only). Consider installing a system keychain/secret service.",
    );
    unavailableWarned = true;
  }
  return ok;
}

export function encrypt(plain: string): string {
  if (!isAvailable()) {
    return Buffer.from(plain, "utf8").toString("base64");
  }
  return safeStorage.encryptString(plain).toString("base64");
}

export function decrypt(b64: string): string {
  const buf = Buffer.from(b64, "base64");
  if (!isAvailable()) {
    return buf.toString("utf8");
  }
  try {
    return safeStorage.decryptString(buf);
  } catch (err) {
    log.error(`secretStore.decrypt failed: ${(err as Error).message}`);
    return "";
  }
}

function readKeyMap(): KeyMap {
  const raw = SettingRepo.get(KEYS_SETTING_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as KeyMap) : {};
  } catch {
    return {};
  }
}

function writeKeyMap(map: KeyMap): void {
  SettingRepo.set(KEYS_SETTING_KEY, JSON.stringify(map));
}

/** Normalize a possibly-undefined authMode to a concrete value (default
 *  auth_token). Used for both stored configs and runtime resolution. */
function resolveAuthMode(m: AuthMode | undefined): AuthMode {
  return m ?? DEFAULT_AUTH_MODE;
}

/** The pre-flat-list role keys, in the canonical order the old UI iterated
 *  them. Kept only for migration: pre-refactor configs carry a `roles` map
 *  keyed by these, and pre-refactor sessions persist one of them in their
 *  `model` column. */
const LEGACY_ROLE_KEYS = ["haiku", "sonnet", "opus", "fable", "subagent"] as const;
type LegacyRoleKey = (typeof LEGACY_ROLE_KEYS)[number];

/** The old per-tier binding shape — only the fields the migration reads. */
interface LegacyRoleBinding {
  requestModel?: string;
  supports1m?: boolean;
}
type LegacyRoleBindings = Partial<Record<LegacyRoleKey, LegacyRoleBinding>>;

/** A migrated meta record — the flat shape plus the legacy `roles` ghost (see
 *  the file header). The ghost is not part of CustomModelMeta's contract and
 *  never reaches the renderer (listPublic picks explicit fields); it is
 *  stripped on the next save. */
type MigratedMeta = CustomModelMeta & { roles?: LegacyRoleBindings };

/** Type-guard the legacy `roles` map off a raw record. */
function readLegacyRoles(v: unknown): LegacyRoleBindings | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const src = v as Record<string, unknown>;
  const out: LegacyRoleBindings = {};
  for (const key of LEGACY_ROLE_KEYS) {
    const b = src[key];
    if (b && typeof b === "object") {
      const binding: LegacyRoleBinding = {};
      const rm = (b as Record<string, unknown>).requestModel;
      const s1 = (b as Record<string, unknown>).supports1m;
      if (typeof rm === "string" && rm.trim()) binding.requestModel = rm.trim();
      if (s1 === true) binding.supports1m = true;
      if (binding.requestModel) out[key] = binding;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Read the models list off the OLDEST meta record (pre-role-binding), with
 *  backward-compat for records persisted before the model→models migration:
 *  a lone `model: string` becomes `[model]`. */
function readLegacyModels(m: { models?: unknown; model?: unknown }): string[] {
  if (Array.isArray(m.models) && m.models.length > 0) {
    return (m.models as string[]).filter((s) => typeof s === "string" && s.trim());
  }
  if (typeof m.model === "string" && m.model.trim()) return [m.model];
  return [];
}

/** Read the oldest shape's 3-key alias map off a record, if present. */
function readLegacyAlias(m: { alias?: unknown }):
  | { haiku?: string; sonnet?: string; opus?: string }
  | undefined {
  if (!m.alias || typeof m.alias !== "object") return undefined;
  const a = m.alias as { haiku?: unknown; sonnet?: unknown; opus?: unknown };
  const out: { haiku?: string; sonnet?: string; opus?: string } = {};
  if (typeof a.haiku === "string" && a.haiku.trim()) out.haiku = a.haiku.trim();
  if (typeof a.sonnet === "string" && a.sonnet.trim()) out.sonnet = a.sonnet.trim();
  if (typeof a.opus === "string" && a.opus.trim()) out.opus = a.opus.trim();
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Flatten legacy role bindings into the flat model list: distinct
 *  requestModels in canonical role order become entries; `supports1m` is
 *  OR-ed across roles sharing the same model id (a fill-all-roles config that
 *  ticked 1M on one tier keeps the declaration). */
function flattenRoles(roles: LegacyRoleBindings): CustomModelEntry[] {
  const entries: CustomModelEntry[] = [];
  const byId = new Map<string, CustomModelEntry>();
  for (const key of LEGACY_ROLE_KEYS) {
    const id = roles[key]?.requestModel?.trim();
    if (!id) continue;
    const existing = byId.get(id);
    if (existing) {
      if (roles[key]?.supports1m) existing.supports1m = true;
    } else {
      const entry: CustomModelEntry = { id };
      if (roles[key]?.supports1m) entry.supports1m = true;
      byId.set(id, entry);
      entries.push(entry);
    }
  }
  return entries;
}

/** Promote any legacy meta record to the flat model-list shape.
 *  Already-migrated records pass through untouched (the legacy `roles` ghost,
 *  if present, survives until the next save). */
function migrateMeta(raw: Record<string, unknown>): MigratedMeta {
  // Backfill the protocol field for records persisted before it existed.
  // Every pre-existing config spoke Anthropic, so "anthropic" is the safe
  // default and keeps old configs behaving exactly as before.
  const meta = raw as unknown as MigratedMeta;
  const withProtocol: MigratedMeta = meta.protocol ? meta : { ...meta, protocol: "anthropic" };

  // The flat shape carries models as an array of {id, supports1m} OBJECTS.
  // The OLDEST shape also used an array — of plain strings — so distinguish
  // by element type before short-circuiting.
  if (
    Array.isArray(raw.models) &&
    raw.models.every((m) => m != null && typeof m === "object" && !Array.isArray(m))
  ) {
    return withProtocol; // already flat shape
  }

  // Rebuild the role map from whichever legacy shape the record carries.
  let roles = readLegacyRoles(raw.roles);
  if (!roles) {
    // Oldest shape: models[] + alias → synthesize roles first (models[0] →
    // sonnet — the old default selectable tier; alias entries → their tiers).
    const legacyModels = readLegacyModels(raw as { models?: unknown; model?: unknown });
    const legacyAlias = readLegacyAlias(raw as { alias?: unknown });
    if (legacyModels.length > 0 || legacyAlias) {
      roles = {};
      if (legacyAlias?.haiku) roles.haiku = { requestModel: legacyAlias.haiku };
      if (legacyAlias?.sonnet) roles.sonnet = { requestModel: legacyAlias.sonnet };
      else if (legacyModels.length > 0) roles.sonnet = { requestModel: legacyModels[0] };
      if (legacyAlias?.opus) roles.opus = { requestModel: legacyAlias.opus };
    }
  }

  const entries = roles ? flattenRoles(roles) : [];
  // Drop the legacy fields (string `model`, `alias`); the ghost `roles` is
  // re-attached explicitly below.
  const { model: _m, alias: _a, roles: _r, ...rest } = raw as Record<string, unknown>;
  const out = { ...(rest as unknown as Omit<MigratedMeta, "models">), models: entries };
  // Keep the role map as an undocumented ghost so pre-refactor sessions (whose
  // `model` column holds a role key) keep resolving to the same gateway model.
  if (entries.length > 0 && roles) out.roles = roles;
  return out;
}

function readMeta(): MigratedMeta[] {
  const raw = SettingRepo.get(META_SETTING_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return (parsed as unknown[]).map((r) =>
      migrateMeta(r && typeof r === "object" ? (r as Record<string, unknown>) : {}),
    );
  } catch {
    return [];
  }
}

function writeMeta(list: MigratedMeta[]): void {
  // Always write the migrated (flat) shape — legacy fields are already
  // stripped by migrateMeta; the `roles` ghost is preserved so pre-refactor
  // sessions keep resolving until the user edits the config.
  SettingRepo.set(META_SETTING_KEY, JSON.stringify(list));
}

/** Mask a cleartext token for display: keep first 2 and last 4 chars. */
function maskToken(plain: string): string {
  if (!plain) return "";
  if (plain.length <= 6) return "***";
  return `${plain.slice(0, 2)}***${plain.slice(-4)}`;
}

export const CustomModelStore = {
  /** List all configs (desensitized — tokens masked, never cleartext). */
  listPublic(): CustomModelPublic[] {
    const metas = readMeta();
    const keys = readKeyMap();
    return metas.map((m) => {
      const cleartext = keys[m.id] ? decrypt(keys[m.id]) : "";
      return {
        id: m.id,
        name: m.name,
        baseUrl: m.baseUrl,
        authMode: resolveAuthMode(m.authMode),
        protocol: resolveProtocol(m.protocol),
        authTokenMasked: maskToken(cleartext),
        models: m.models,
        subagentModel: m.subagentModel,
        disableNonEssentialTraffic: m.disableNonEssentialTraffic ?? true,
        timeoutMs: m.timeoutMs,
        createdAt: m.createdAt,
      };
    });
  },

  /**
   * Create or update a config. On update with `authToken` omitted, the
   * existing stored token is preserved. Returns the new desensitized list.
   */
  save(input: CustomModelInput): CustomModelPublic[] {
    const metas = readMeta();
    const keys = readKeyMap();
    const now = Date.now();
    const disableTraffic = input.disableNonEssentialTraffic ?? true;
    // Subagent pin must reference a model this config actually serves; a stale
    // id (e.g. the model row was removed in the same edit) is dropped rather
    // than persisted — see ApiConfig.subagentModel.
    const validIds = new Set(input.models.map((m) => m.id));
    const subagentModel =
      input.subagentModel && validIds.has(input.subagentModel)
        ? input.subagentModel
        : undefined;

    if (input.id) {
      const idx = metas.findIndex((m) => m.id === input.id);
      if (idx < 0) throw new Error(`custom model not found: ${input.id}`);
      // Strip the legacy `roles` ghost — once the user re-saves in the flat
      // UI, pre-refactor sessions can no longer resolve role keys and fall
      // back to the first model (the config was edited anyway).
      const { roles: _ghost, ...prev } = metas[idx];
      metas[idx] = {
        ...prev,
        name: input.name,
        baseUrl: input.baseUrl,
        authMode: resolveAuthMode(input.authMode),
        protocol: resolveProtocol(input.protocol),
        models: input.models,
        subagentModel,
        disableNonEssentialTraffic: disableTraffic,
        timeoutMs: input.timeoutMs,
      };
      if (input.authToken) keys[input.id] = encrypt(input.authToken);
    } else {
      if (!input.authToken) throw new Error("authToken is required when creating a custom model");
      const id = `cm_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      metas.push({
        id,
        name: input.name,
        baseUrl: input.baseUrl,
        authMode: resolveAuthMode(input.authMode),
        protocol: resolveProtocol(input.protocol),
        models: input.models,
        subagentModel,
        disableNonEssentialTraffic: disableTraffic,
        timeoutMs: input.timeoutMs,
        createdAt: now,
      });
      keys[id] = encrypt(input.authToken);
    }

    writeMeta(metas);
    writeKeyMap(keys);
    return this.listPublic();
  },

  /** Delete a config and its encrypted token. */
  remove(id: string): CustomModelPublic[] {
    const metas = readMeta().filter((m) => m.id !== id);
    const keys = readKeyMap();
    delete keys[id];
    writeMeta(metas);
    writeKeyMap(keys);
    return this.listPublic();
  },

  /**
   * Resolve the full ApiConfig for a stored config + the model the session has
   * selected (main-process only — must NEVER be sent to the renderer).
   * Returns undefined if not found, the token can't be decrypted, or no model
   * is configured at all.
   *
   * `selected` is the model id persisted on the session. Resolution order:
   *   1. direct match on the flat model list (sessions created after the
   *      flat-list refactor);
   *   2. a legacy ROLE key ("sonnet" / "haiku" / …) still persisted on
   *      pre-refactor sessions — resolved through the migration ghost so
   *      those sessions keep pointing at the same gateway model;
   *   3. anything else (e.g. the model was deleted) → the first entry.
   */
  resolveApiConfig(id: string, selected?: string): ApiConfig | undefined {
    const metas = readMeta();
    const meta = metas.find((m) => m.id === id);
    if (!meta) return undefined;
    const keys = readKeyMap();
    const cipher = keys[id];
    if (!cipher) return undefined;
    const authToken = decrypt(cipher);
    if (!authToken) return undefined;
    const models = meta.models.filter((m) => m.id.trim());
    if (models.length === 0) return undefined;

    let resolved = selected && models.some((m) => m.id === selected) ? selected : undefined;
    if (!resolved && selected && (LEGACY_ROLE_KEYS as readonly string[]).includes(selected)) {
      resolved = meta.roles?.[selected as LegacyRoleKey]?.requestModel?.trim();
    }
    const selectedModel = resolved ?? models[0].id;
    // Drop a pin the model list no longer contains (the UI validates on
    // save; this is the belt-and-suspenders for hand-edited JSON).
    const pinned = meta.subagentModel;

    return {
      baseUrl: meta.baseUrl,
      authToken,
      authMode: resolveAuthMode(meta.authMode),
      protocol: resolveProtocol(meta.protocol),
      selectedModel,
      models,
      subagentModel:
        pinned && models.some((m) => m.id === pinned) ? pinned : undefined,
      disableNonEssentialTraffic: meta.disableNonEssentialTraffic ?? true,
      timeoutMs: meta.timeoutMs,
    };
  },
};
