/**
 * Locate and probe the user's Antigravity CLI (`agy`) for ACP chat sessions.
 *
 * Pure node (no electron, no logger) so smoke scripts and probes can import it
 * directly. Mirrors `claudeExecutable.ts` caching and version comparison rules.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { which } from "@main/lib/binaryResolve.js";
import { compareVersions } from "@main/lib/claudeExecutable.js";

/** Minimum `agy` version verified to support `agy acp` with `--gemini-dir` and
 *  standard ACP session capabilities (load/resume/list/systemPrompt.append). */
export const MIN_ANTIGRAVITY_CLI_VERSION = "1.5.5";

const CACHE_MS = 10 * 60_000;
let cachedPath: { at: number; value: string | null } | undefined;
let cachedVersion: { path: string; at: number; value: string | null } | undefined;

/** Clear cached executable path and version probe (e.g. after CLI install). */
export function invalidateAntigravityExecutableCache(): void {
  cachedPath = undefined;
  cachedVersion = undefined;
}

/** Resolve the user's `agy` executable path, or null when not installed. */
export function resolveAntigravityExecutable(): string | null {
  if (cachedPath && Date.now() - cachedPath.at < CACHE_MS) return cachedPath.value;

  let found = which("agy");
  if (!found) {
    if (process.platform === "win32") {
      const local = process.env["LOCALAPPDATA"];
      if (local) {
        const candidate = join(local, "agy", "bin", "agy.exe");
        if (existsSync(candidate)) found = candidate;
      }
    } else {
      const candidate = join(homedir(), ".local", "bin", "agy");
      if (existsSync(candidate)) found = candidate;
    }
  }

  cachedPath = { at: Date.now(), value: found };
  return found;
}

/** Run `agy --version` and extract the dotted semver token (e.g. "1.5.16"). */
export function probeAntigravityCliVersion(
  exePath: string,
  timeoutMs = 8_000,
  force = false,
): Promise<string | null> {
  if (!force && cachedVersion && cachedVersion.path === exePath && Date.now() - cachedVersion.at < CACHE_MS) {
    return Promise.resolve(cachedVersion.value);
  }
  return new Promise((resolve) => {
    execFile(
      exePath,
      ["--version"],
      {
        timeout: timeoutMs,
        windowsHide: true,
        env: { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: "true" },
      },
      (err, stdout) => {
        const value = err ? null : (stdout.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*/)?.[0] ?? null);
        cachedVersion = { path: exePath, at: Date.now(), value };
        resolve(value);
      },
    );
  });
}

export class AntigravityCliUnavailableError extends Error {
  constructor(
    readonly reason: "not-installed" | "too-old",
    message: string,
    readonly version?: string | null,
  ) {
    super(message);
    this.name = "AntigravityCliUnavailableError";
  }
}

/** Verify `agy` is installed and meets {@link MIN_ANTIGRAVITY_CLI_VERSION}. */
export async function assertAntigravityCliUsable(force = false): Promise<{
  path: string;
  version: string | null;
}> {
  if (force) invalidateAntigravityExecutableCache();
  const exePath = resolveAntigravityExecutable();
  if (!exePath) {
    throw new AntigravityCliUnavailableError(
      "not-installed",
      "未检测到 Antigravity CLI (agy)。请先安装 Antigravity 并确保 agy 在 PATH 中（或位于 %LOCALAPPDATA%\\agy\\bin）。",
    );
  }
  const version = await probeAntigravityCliVersion(exePath, 8_000, force);
  if (version && compareVersions(version, MIN_ANTIGRAVITY_CLI_VERSION) < 0) {
    throw new AntigravityCliUnavailableError(
      "too-old",
      `当前 Antigravity CLI 版本过低 (${version})，需要 >= ${MIN_ANTIGRAVITY_CLI_VERSION} 才能支持 ACP 对话模式，请升级后重试。`,
      version,
    );
  }
  return { path: exePath, version };
}
