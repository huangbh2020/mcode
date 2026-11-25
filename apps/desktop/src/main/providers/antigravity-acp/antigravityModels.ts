/**
 * Antigravity CLI (`agy`) model listing & family/effort folding.
 *
 * `agy models` prints `<modelId>\t<name>` lines where models with effort levels
 * are flattened as `<family>-<level>` (e.g. `gemini-4-hydrogen-high`).
 * Following Orca's `antigravityModelChoices` convention, when a family has 2+
 * effort variants (and the bare family id is not itself a standalone model), we
 * fold them into a single model option + effort variants so Mcode's unified
 * ModelDropdown + EffortSlider can select both cleanly.
 */
import { execFile } from "node:child_process";
import type { AntigravityModelOption } from "@contracts/ipc";
import {
  probeAntigravityCliVersion,
  resolveAntigravityExecutable,
  MIN_ANTIGRAVITY_CLI_VERSION,
} from "@main/lib/antigravityExecutable.js";
import { compareVersions } from "@main/lib/claudeExecutable.js";
import { log } from "@main/lib/logger.js";

export const ANTIGRAVITY_EFFORT_ORDER = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

const LEVEL_SUFFIX_RE = /^(.+)-(minimal|low|medium|high|xhigh|max)$/;
const CACHE_MS = 5 * 60_000;

interface RawModelEntry {
  modelId: string;
  name: string;
}

interface ParsedModelCatalog {
  options: AntigravityModelOption[];
  /** familyId → (effort → raw wire modelId) */
  familyWireMap: Map<string, Map<string, string>>;
  /** raw wire modelId → label */
  rawIds: Set<string>;
}

let cachedCatalog:
  | {
      at: number;
      result: { installed: boolean; models: AntigravityModelOption[]; loggedIn: boolean; error?: string };
      parsed?: ParsedModelCatalog;
    }
  | undefined;

export function invalidateAntigravityModelsCache(): void {
  cachedCatalog = undefined;
}

/** Parse `agy models` stdout into raw rows and fold `<family>-<level>` groups. */
export function parseAntigravityModelListing(stdout: string): ParsedModelCatalog {
  const rawRows: RawModelEntry[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split("\t").map((p) => p.trim());
    if (parts.length !== 2 || !parts[0] || !parts[1]) continue;
    rawRows.push({ modelId: parts[0], name: parts[1] });
  }

  const rawIds = new Set(rawRows.map((r) => r.modelId));
  const familyBuckets = new Map<string, Array<{ level: string; entry: RawModelEntry }>>();

  for (const row of rawRows) {
    const m = LEVEL_SUFFIX_RE.exec(row.modelId);
    if (!m) continue;
    const family = m[1]!;
    const level = m[2]!;
    if (rawIds.has(family)) continue;
    const list = familyBuckets.get(family);
    if (list) list.push({ level, entry: row });
    else familyBuckets.set(family, [{ level, entry: row }]);
  }

  const foldedFamilies = new Set<string>();
  const familyWireMap = new Map<string, Map<string, string>>();
  for (const [family, bucket] of familyBuckets) {
    if (bucket.length < 2) continue;
    foldedFamilies.add(family);
    const levelMap = new Map<string, string>();
    for (const item of bucket) {
      levelMap.set(item.level, item.entry.modelId);
    }
    familyWireMap.set(family, levelMap);
  }

  const options: AntigravityModelOption[] = [];
  const emittedFamilies = new Set<string>();

  for (const row of rawRows) {
    const m = LEVEL_SUFFIX_RE.exec(row.modelId);
    const family = m?.[1];
    if (family && foldedFamilies.has(family)) {
      if (emittedFamilies.has(family)) continue;
      emittedFamilies.add(family);
      const levelMap = familyWireMap.get(family)!;
      const variants = ANTIGRAVITY_EFFORT_ORDER.filter((lvl) => levelMap.has(lvl));
      const label = row.name.replace(/\s*\([^()]+\)$/, "").trim() || family;
      options.push({
        id: family,
        label,
        variants,
      });
      continue;
    }
    options.push({
      id: row.modelId,
      label: row.name,
    });
  }

  return { options, familyWireMap, rawIds };
}

/** Resolve `(uiModelId, effort)` back to the concrete wire model id accepted by `agy acp`. */
export function resolveAntigravityWireModel(
  modelId: string | undefined,
  effort: string | undefined,
  parsed?: ParsedModelCatalog,
): string | undefined {
  if (!modelId || modelId === "default") return undefined;

  const familyMap = parsed?.familyWireMap.get(modelId);
  if (familyMap && familyMap.size > 0) {
    if (effort && effort !== "default" && familyMap.has(effort)) {
      return familyMap.get(effort);
    }
    for (const preferred of ["medium", "high", "low", "xhigh", "max", "minimal"]) {
      const hit = familyMap.get(preferred);
      if (hit) return hit;
    }
    return familyMap.values().next().value;
  }

  // Fallback if cache hasn't hydrated yet: if caller passed a base family + explicit effort,
  // check if rawIds contains `<modelId>-<effort>`.
  if (effort && effort !== "default" && parsed?.rawIds.has(`${modelId}-${effort}`)) {
    return `${modelId}-${effort}`;
  }
  return modelId;
}

function execModels(exePath: string, timeoutMs = 25_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      exePath,
      ["models"],
      {
        timeout: timeoutMs,
        windowsHide: true,
        env: { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: "true" },
      },
      (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr || stdout || err.message).trim();
          reject(new Error(msg));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

export async function listAntigravityModels(force = false): Promise<{
  installed: boolean;
  models: AntigravityModelOption[];
  loggedIn: boolean;
  error?: string;
}> {
  if (!force && cachedCatalog && Date.now() - cachedCatalog.at < CACHE_MS) {
    return cachedCatalog.result;
  }

  const exePath = resolveAntigravityExecutable();
  if (!exePath) {
    const result = { installed: false, models: [], loggedIn: false };
    cachedCatalog = { at: Date.now(), result };
    return result;
  }

  const version = await probeAntigravityCliVersion(exePath, 8_000, force);
  if (version && compareVersions(version, MIN_ANTIGRAVITY_CLI_VERSION) < 0) {
    const result = {
      installed: true,
      models: [],
      loggedIn: false,
      error: `Antigravity CLI 版本过低 (${version})，需 >= ${MIN_ANTIGRAVITY_CLI_VERSION}`,
    };
    cachedCatalog = { at: Date.now(), result };
    return result;
  }

  try {
    const stdout = await execModels(exePath);
    const parsed = parseAntigravityModelListing(stdout);
    const result = {
      installed: true,
      models: parsed.options,
      loggedIn: parsed.options.length > 0,
    };
    if (parsed.options.length > 0) {
      cachedCatalog = { at: Date.now(), result, parsed };
    }
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`agy models failed: ${message}`);
    const authIssue = /auth|login|sign\s*in|401|unauthenticated|credential/i.test(message);
    return {
      installed: true,
      models: [],
      loggedIn: !authIssue,
      error: message,
    };
  }
}

export async function getCachedAntigravityCatalog(force = false): Promise<ParsedModelCatalog | undefined> {
  if (force || !cachedCatalog || Date.now() - cachedCatalog.at >= CACHE_MS) {
    await listAntigravityModels(force);
  }
  return cachedCatalog?.parsed;
}
