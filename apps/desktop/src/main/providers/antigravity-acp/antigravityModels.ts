/**
 * Antigravity CLI (`agy`) model listing & family/effort folding.
 *
 * Primary source: a short-lived ACP session (`agy acp` → `initialize` →
 * `session/new`), which returns the full `availableModels` list (whereas
 * `agy models` can return a shorter fallback list). The disposable listing
 * session's on-disk files under `~/.gemini/antigravity-cli` are removed right
 * after the child exits. Falls back to `agy models` if the ACP probe fails.
 *
 * Models with effort levels are flattened as `<family>-<level>` (e.g.
 * `gemini-4-hydrogen-high`). When a family has 2+ effort variants (and the
 * bare family id is not itself a standalone model), we fold them into a single
 * model option + effort variants so Mcode's unified ModelDropdown + Effort
 * selector can pick both cleanly.
 */
import { execFile } from "node:child_process";
import { rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AntigravityModelOption } from "@contracts/ipc";
import {
  probeAntigravityCliVersion,
  resolveAntigravityExecutable,
  MIN_ANTIGRAVITY_CLI_VERSION,
} from "@main/lib/antigravityExecutable.js";
import { compareVersions } from "@main/lib/claudeExecutable.js";
import { killProcessTree } from "@main/lib/procTree.js";
import { log } from "@main/lib/logger.js";
import {
  ACP_PROTOCOL_VERSION,
  AcpAuthRequiredError,
  AcpInitializeResponseSchema,
  AcpSessionResponseSchema,
} from "./acpProtocol.js";
import { AcpTransport } from "./acpTransport.js";

export const ANTIGRAVITY_EFFORT_ORDER = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

const LEVEL_SUFFIX_RE = /^(.+)-(minimal|low|medium|high|xhigh|max)$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONVERSATION_SUFFIXES = [".db", ".db-wal", ".db-shm", ".db-journal"] as const;
const CACHE_MS = 5 * 60_000;

export interface RawAntigravityModelEntry {
  modelId: string;
  name: string;
}

export interface ParsedModelCatalog {
  options: AntigravityModelOption[];
  /** familyId → (effort → raw wire modelId) */
  familyWireMap: Map<string, Map<string, string>>;
  /** raw wire modelId set */
  rawIds: Set<string>;
}

export interface AntigravityModelListResult {
  installed: boolean;
  models: AntigravityModelOption[];
  loggedIn: boolean;
  error?: string;
}

let cachedCatalog:
  | {
      at: number;
      result: AntigravityModelListResult;
      parsed?: ParsedModelCatalog;
    }
  | undefined;

let inFlightList: Promise<AntigravityModelListResult> | null = null;

export function invalidateAntigravityModelsCache(): void {
  cachedCatalog = undefined;
}

/** Fold raw `{ modelId, name }` entries into grouped model options + effort map. */
export function buildAntigravityModelCatalog(
  rawRows: ReadonlyArray<RawAntigravityModelEntry>,
): ParsedModelCatalog {
  const rawIds = new Set(rawRows.map((r) => r.modelId));
  const familyBuckets = new Map<string, Array<{ level: string; entry: RawAntigravityModelEntry }>>();

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

/** Parse `agy models` stdout into raw rows and fold `<family>-<level>` groups. */
export function parseAntigravityModelListing(stdout: string): ParsedModelCatalog {
  const rawRows: RawAntigravityModelEntry[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split("\t").map((p) => p.trim());
    if (parts.length !== 2 || !parts[0] || !parts[1]) continue;
    rawRows.push({ modelId: parts[0], name: parts[1] });
  }
  return buildAntigravityModelCatalog(rawRows);
}

/** Update the cached catalog when a live ACP session returns `availableModels`. */
export function hydrateAntigravityModelCatalog(
  availableModels: ReadonlyArray<RawAntigravityModelEntry> | undefined,
): void {
  if (!availableModels || availableModels.length === 0) return;
  const parsed = buildAntigravityModelCatalog(availableModels);
  if (parsed.options.length === 0) return;
  cachedCatalog = {
    at: Date.now(),
    result: { installed: true, models: parsed.options, loggedIn: true },
    parsed,
  };
}

/**
 * Remove the temporary session files created by an ACP model-listing probe so
 * `~/.gemini/antigravity-cli/conversations` does not accumulate empty DBs.
 */
export async function discardAgyListingSession(
  sessionId: string,
  agyAppDataRoot = join(homedir(), ".gemini", "antigravity-cli"),
): Promise<void> {
  if (!UUID_RE.test(sessionId)) return;
  const conversationBase = join(agyAppDataRoot, "conversations", sessionId);
  const exists = await stat(`${conversationBase}.db`).catch(() => null);
  if (!exists) return;
  await Promise.all([
    ...CONVERSATION_SUFFIXES.map((suffix) => rm(`${conversationBase}${suffix}`, { force: true })),
    rm(join(agyAppDataRoot, "brain", sessionId), { recursive: true, force: true }),
    rm(join(agyAppDataRoot, "annotations", `${sessionId}.pbtxt`), { force: true }),
  ]);
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

function execModels(
  exePath: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = 25_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      exePath,
      ["models"],
      {
        timeout: timeoutMs,
        windowsHide: true,
        env,
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

async function probeModelsViaTempAcpSession(
  exePath: string,
  cliHomeArgs: string[],
  env: NodeJS.ProcessEnv,
  appDataRoot: string,
): Promise<RawAntigravityModelEntry[]> {
  let closedResolve: (() => void) | null = null;
  const closedPromise = new Promise<void>((resolve) => {
    closedResolve = resolve;
  });

  const probeCwd = tmpdir();
  const transport = new AcpTransport({
    command: exePath,
    args: ["acp", ...cliHomeArgs],
    cwd: probeCwd,
    env,
    hardKill: (child) => {
      if (child.pid) void killProcessTree(child.pid);
    },
    onClose: () => {
      closedResolve?.();
    },
    log,
  });

  let tempSessionId: string | null = null;
  try {
    const rawInit = await transport.request(
      "initialize",
      {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: "mcode", version: "0.1.0" },
      },
      { timeoutMs: 15_000 },
    );
    const initialized = AcpInitializeResponseSchema.parse(rawInit);
    if (initialized.protocolVersion !== ACP_PROTOCOL_VERSION) {
      throw new Error(`Unsupported ACP protocol version: ${initialized.protocolVersion}`);
    }

    const rawSession = await transport.request(
      "session/new",
      { cwd: probeCwd, mcpServers: [] },
      { timeoutMs: 20_000 },
    );
    const sessionRes = AcpSessionResponseSchema.parse(rawSession);
    tempSessionId = sessionRes.sessionId;
    return (sessionRes.models?.availableModels ?? []).map((m) => ({
      modelId: m.modelId,
      name: m.name,
    }));
  } finally {
    transport.close();
    await Promise.race([
      closedPromise,
      new Promise<void>((resolve) => setTimeout(resolve, 1_500)),
    ]);
    if (tempSessionId) {
      await discardAgyListingSession(tempSessionId, appDataRoot).catch((err) => {
        log.warn(
          `antigravity: failed to discard temp listing session ${tempSessionId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    }
  }
}

async function fetchAntigravityModels(force: boolean): Promise<AntigravityModelListResult> {
  const exePath = resolveAntigravityExecutable();
  if (!exePath) {
    const result: AntigravityModelListResult = { installed: false, models: [], loggedIn: false };
    cachedCatalog = { at: Date.now(), result };
    return result;
  }

  const version = await probeAntigravityCliVersion(exePath, 8_000, force);
  if (version && compareVersions(version, MIN_ANTIGRAVITY_CLI_VERSION) < 0) {
    const result: AntigravityModelListResult = {
      installed: true,
      models: [],
      loggedIn: false,
      error: `Antigravity CLI 版本过低 (${version})，需 >= ${MIN_ANTIGRAVITY_CLI_VERSION}`,
    };
    cachedCatalog = { at: Date.now(), result };
    return result;
  }

  const { resolveActiveAntigravityLaunchContext } = await import("./antigravityAccounts.js");
  const launchCtx = await resolveActiveAntigravityLaunchContext();

  // 1. Primary path: short-lived ACP session returns the full availableModels catalog.
  try {
    const rawRows = await probeModelsViaTempAcpSession(
      exePath,
      launchCtx.cliHomeArgs,
      launchCtx.env,
      launchCtx.appDataRoot,
    );
    const parsed = buildAntigravityModelCatalog(rawRows);
    if (parsed.options.length > 0) {
      const result: AntigravityModelListResult = {
        installed: true,
        models: parsed.options,
        loggedIn: true,
      };
      cachedCatalog = { at: Date.now(), result, parsed };
      return result;
    }
  } catch (err) {
    if (err instanceof AcpAuthRequiredError) {
      return {
        installed: true,
        models: [],
        loggedIn: false,
        error: err.message,
      };
    }
    log.warn(
      `antigravity temp ACP model probe failed, falling back to 'agy models': ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // 2. Fallback path: `agy models` CLI output.
  try {
    const stdout = await execModels(exePath, launchCtx.env);
    const parsed = parseAntigravityModelListing(stdout);
    const result: AntigravityModelListResult = {
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

export async function listAntigravityModels(force = false): Promise<AntigravityModelListResult> {
  if (!force && cachedCatalog && Date.now() - cachedCatalog.at < CACHE_MS) {
    return cachedCatalog.result;
  }
  if (!force && inFlightList) {
    return inFlightList;
  }
  const task = fetchAntigravityModels(force).finally(() => {
    if (inFlightList === task) inFlightList = null;
  });
  inFlightList = task;
  return task;
}

export async function getCachedAntigravityCatalog(force = false): Promise<ParsedModelCatalog | undefined> {
  if (force || !cachedCatalog || Date.now() - cachedCatalog.at >= CACHE_MS) {
    await listAntigravityModels(force);
  }
  return cachedCatalog?.parsed;
}
