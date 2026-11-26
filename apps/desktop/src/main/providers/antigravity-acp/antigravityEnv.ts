/**
 * Pure (Electron-free) environment sanitizer and CLI flag builder for
 * Antigravity (`agy acp`) account isolation (`--gemini-dir`).
 */
import type { AntigravityAuthMethod } from "@contracts/ipc";

export const AGY_APP_DATA_DIR_NAME = "antigravity-cli";

const AUTH_KEPT_ENV_KEYS: Partial<Record<AntigravityAuthMethod, ReadonlySet<string>>> = {
  "gemini-api-key": new Set(["GEMINI_API_KEY", "GOOGLE_GEMINI_BASE_URL"]),
  "agent-platform": new Set([
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_CLOUD_LOCATION",
    "GOOGLE_CLOUD_QUOTA_PROJECT",
    "CLOUDSDK_CORE_PROJECT",
  ]),
};

/**
 * Return a sanitized copy of `inherited` for launching `agy acp` under a
 * specific auth method:
 *   - Strips conflicting inherited auth vars (`GEMINI_API_KEY`, `GOOGLE_*`,
 *     `GCLOUD_PROJECT`, `CLOUDSDK_CORE_PROJECT`, `AGY_ACP_*`) unless allowed
 *     by `method`.
 *   - Removes alternate-case `AGY_CLI_DISABLE_AUTO_UPDATE` on Windows before
 *     setting the canonical uppercase `"true"`.
 *   - Applies account-specific `overrides` last.
 */
export function buildSanitizedAntigravityEnv(
  inherited: NodeJS.ProcessEnv,
  method: AntigravityAuthMethod,
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...inherited };
  const isWin = process.platform === "win32";
  const kept = AUTH_KEPT_ENV_KEYS[method];

  for (const key of Object.keys(out)) {
    const norm = isWin ? key.toUpperCase() : key;
    if (isWin && norm === "AGY_CLI_DISABLE_AUTO_UPDATE" && key !== "AGY_CLI_DISABLE_AUTO_UPDATE") {
      delete out[key];
      continue;
    }
    if (method === "default") continue;
    const isAuthKey =
      norm === "GEMINI_API_KEY" ||
      norm === "GCLOUD_PROJECT" ||
      norm === "CLOUDSDK_CORE_PROJECT" ||
      norm.startsWith("GOOGLE_") ||
      norm.startsWith("AGY_ACP_");
    if (isAuthKey && !kept?.has(norm)) {
      delete out[key];
    }
  }

  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined || v === "") delete out[k];
    else out[k] = v;
  }

  out["AGY_CLI_DISABLE_AUTO_UPDATE"] = "true";
  return out;
}

/** Build the `--gemini-dir` / `--app-data-dir` flags for an isolated account home. */
export function buildAgyIsolatedHomeArgs(geminiDir: string | null): string[] {
  if (!geminiDir) return [];
  return ["--gemini-dir", geminiDir, "--app-data-dir", AGY_APP_DATA_DIR_NAME];
}

/** Build the `settings.json` payload written inside an isolated `--gemini-dir` home. */
export function buildAgyHomeSettingsJson(params: {
  method: Exclude<AntigravityAuthMethod, "default">;
  gcpProject?: string;
  gcpLocation?: string;
}): string {
  const payload: Record<string, unknown> = {
    auth: { type: params.method },
  };
  if (params.method === "agent-platform" && params.gcpProject) {
    payload["gcp"] = {
      project: params.gcpProject,
      location: params.gcpLocation || "global",
    };
  }
  return JSON.stringify(payload, null, 2);
}
