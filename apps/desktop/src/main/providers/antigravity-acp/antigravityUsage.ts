/**
 * Antigravity CLI (`agy`) quota/usage fetcher via `agy -p /usage --output-format json`.
 *
 * Verified on agy 1.5.16:
 *   - Consumes zero quota/tokens/turns (`num_turns: 0`, `conversation_id: ""`).
 *   - Returns `command.name === "usage"` with `command.data.groups[].buckets[]`.
 *   - Safety latch: if a CLI version ever treats `/usage` as a billed model turn
 *     (`num_turns > 0` or non-empty `conversation_id`), permanently disables
 *     further polling for this process lifetime so quota is never wasted.
 */
import { execFile } from "node:child_process";
import type {
  AntigravityUsageBucket,
  AntigravityUsageGroup,
  AntigravityUsageResult,
} from "@contracts/ipc";
import {
  MIN_ANTIGRAVITY_CLI_VERSION,
  probeAntigravityCliVersion,
  resolveAntigravityExecutable,
} from "@main/lib/antigravityExecutable.js";
import { compareVersions } from "@main/lib/claudeExecutable.js";
import { log } from "@main/lib/logger.js";

const USAGE_ARGS = ["-p", "/usage", "--output-format", "json", "--print-timeout", "20s"] as const;
const USAGE_TIMEOUT_MS = 30_000;
const USAGE_MAX_BUFFER = 512 * 1024;
const CACHE_MS = 2 * 60_000;
/** Epoch ms threshold below which reset_time is treated as unset (e.g. 1970-01-01T00:00:00Z). */
const MIN_VALID_RESET_MS = 946_684_800_000; // 2000-01-01T00:00:00Z

let cachedUsage: { at: number; result: AntigravityUsageResult } | undefined;
let inFlightUsage: Promise<AntigravityUsageResult> | null = null;
let usageCommandLatchedOff = false;

export function invalidateAntigravityUsageCache(): void {
  cachedUsage = undefined;
}

function isRecord(val: unknown): val is Record<string, unknown> {
  return val != null && typeof val === "object" && !Array.isArray(val);
}

function readString(val: unknown): string | undefined {
  return typeof val === "string" && val.trim().length > 0 ? val.trim() : undefined;
}

function parseResetTime(val: unknown): number | null {
  const s = readString(val);
  if (!s) return null;
  const ms = Date.parse(s);
  if (!Number.isFinite(ms) || ms < MIN_VALID_RESET_MS) return null;
  return ms;
}

function didRunModelTurn(envelope: Record<string, unknown>): boolean {
  if (typeof envelope.num_turns === "number" && envelope.num_turns > 0) return true;
  if (readString(envelope.conversation_id) !== undefined) return true;
  return false;
}

/** Pure parser for `agy -p /usage --output-format json` stdout (exported for smoke tests). */
export function parseAntigravityUsageStdout(stdout: string): {
  parsed?: { groups: AntigravityUsageGroup[]; description?: string };
  error?: string;
  ranModelTurn: boolean;
} {
  let ranModelTurn = false;
  let errorText: string | undefined;

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(obj)) continue;

    if (didRunModelTurn(obj)) {
      ranModelTurn = true;
    }

    const status = readString(obj.status);
    if (status === "ERROR") {
      errorText = readString(obj.error) ?? "Antigravity usage query returned an error";
      continue;
    }
    if (status !== "SUCCESS") continue;

    const command = obj.command;
    if (!isRecord(command) || readString(command.name) !== "usage") continue;
    const data = command.data;
    if (!isRecord(data) || !Array.isArray(data.groups)) continue;

    const groups: AntigravityUsageGroup[] = [];
    for (const rawGroup of data.groups) {
      if (!isRecord(rawGroup)) continue;
      const groupName = readString(rawGroup.name);
      if (!groupName) continue;
      const rawBuckets = Array.isArray(rawGroup.buckets) ? rawGroup.buckets : [];
      const buckets: AntigravityUsageBucket[] = [];
      for (const rawBucket of rawBuckets) {
        if (!isRecord(rawBucket)) continue;
        if (rawBucket.disabled === true) continue;
        const id = readString(rawBucket.id);
        const fraction = rawBucket.remaining_fraction;
        if (!id || typeof fraction !== "number" || !Number.isFinite(fraction)) continue;
        const remainingPercent = Math.min(100, Math.max(0, Math.round(fraction * 100)));
        const window = readString(rawBucket.window) ?? "unknown";
        const name = readString(rawBucket.name) ?? window;
        const description = readString(rawBucket.description);
        buckets.push({
          id,
          name,
          window,
          remainingPercent,
          resetsAt: parseResetTime(rawBucket.reset_time),
          ...(description ? { description } : {}),
        });
      }
      if (buckets.length > 0) {
        const groupDesc = readString(rawGroup.description);
        groups.push({
          name: groupName,
          ...(groupDesc ? { description: groupDesc } : {}),
          buckets,
        });
      }
    }

    const description = readString(data.description);
    return {
      parsed: { groups, ...(description ? { description } : {}) },
      ranModelTurn,
    };
  }

  return { error: errorText, ranModelTurn };
}

function execUsage(
  exePath: string,
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      exePath,
      [...USAGE_ARGS],
      {
        timeout: USAGE_TIMEOUT_MS,
        maxBuffer: USAGE_MAX_BUFFER,
        windowsHide: true,
        env,
      },
      (err, stdout, stderr) => {
        // Even on non-zero exit, agy may print a structured JSON error envelope to stdout.
        if (err && !stdout.trim()) {
          const msg = (stderr || err.message).trim();
          reject(new Error(msg));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

async function fetchAntigravityUsage(force: boolean): Promise<AntigravityUsageResult> {
  const now = Date.now();
  const { resolveActiveAntigravityLaunchContext } = await import("./antigravityAccounts.js");
  const launchCtx = await resolveActiveAntigravityLaunchContext();
  if (launchCtx.method === "gemini-api-key" || launchCtx.method === "agent-platform") {
    const result: AntigravityUsageResult = {
      ok: true,
      groups: [],
      fetchedAt: now,
      unmetered: true,
    };
    cachedUsage = { at: now, result };
    return result;
  }

  if (usageCommandLatchedOff) {
    return {
      ok: false,
      groups: [],
      fetchedAt: now,
      error: "当前 agy CLI 版本将 /usage 视为普通对话，已停止自动查询以保护配额，请升级 agy。",
    };
  }

  const exePath = resolveAntigravityExecutable();
  if (!exePath) {
    return { ok: false, groups: [], fetchedAt: now, error: "未检测到 Antigravity CLI (agy)" };
  }

  const version = await probeAntigravityCliVersion(exePath, 8_000, force);
  if (version && compareVersions(version, MIN_ANTIGRAVITY_CLI_VERSION) < 0) {
    return {
      ok: false,
      groups: [],
      fetchedAt: now,
      error: `Antigravity CLI 版本过低 (${version})，需 >= ${MIN_ANTIGRAVITY_CLI_VERSION}`,
    };
  }

  try {
    const { stdout, stderr } = await execUsage(exePath, launchCtx.env);
    const { parsed, error, ranModelTurn } = parseAntigravityUsageStdout(stdout);
    if (ranModelTurn) {
      usageCommandLatchedOff = true;
      log.warn("antigravity /usage triggered a model turn — latching off usage polling");
      return {
        ok: false,
        groups: [],
        fetchedAt: Date.now(),
        error: "当前 agy CLI 版本将 /usage 视为普通对话，已停止自动查询以保护配额，请升级 agy。",
      };
    }
    if (parsed) {
      const result: AntigravityUsageResult = {
        ok: true,
        groups: parsed.groups,
        ...(parsed.description ? { description: parsed.description } : {}),
        fetchedAt: Date.now(),
      };
      cachedUsage = { at: result.fetchedAt, result };
      return result;
    }
    const msg = error || stderr.trim() || "未能解析 Antigravity 配额响应";
    log.warn(`antigravity /usage parse failed: ${msg}`);
    return { ok: false, groups: [], fetchedAt: Date.now(), error: msg };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`antigravity /usage failed: ${msg}`);
    return { ok: false, groups: [], fetchedAt: Date.now(), error: msg };
  }
}

export async function getAntigravityUsage(force = false): Promise<AntigravityUsageResult> {
  if (!force && cachedUsage && Date.now() - cachedUsage.at < CACHE_MS) {
    return cachedUsage.result;
  }
  if (!force && inFlightUsage) {
    return inFlightUsage;
  }
  const task = fetchAntigravityUsage(force).finally(() => {
    if (inFlightUsage === task) inFlightUsage = null;
  });
  inFlightUsage = task;
  return task;
}
