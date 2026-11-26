/**
 * Antigravity (`agy acp`) multi-account store and `--gemini-dir` isolation.
 *
 * - Metadata lives in SQLite `settings` (`antigravity.accounts`,
 *   `antigravity.activeAccountId`).
 * - Secrets (Gemini API keys and captured Windows Google OAuth credential
 *   snapshots) are encrypted via Electron `safeStorage` under
 *   `antigravity.accountSecrets`.
 * - Every non-default account gets an isolated `--gemini-dir` under
 *   `<userData>/antigravity-homes/<accountId>` with its own `settings.json`,
 *   conversations, and brain/annotations, keeping `~/.gemini` untouched.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { app, safeStorage } from "electron";
import type {
  AntigravityAccountListResult,
  AntigravityAccountPublic,
  AntigravityAuthMethod,
  AntigravitySaveAccountInput,
} from "@contracts/ipc";
import { SettingRepo } from "@main/store/repositories.js";
import { log } from "@main/lib/logger.js";
import {
  AGY_APP_DATA_DIR_NAME,
  buildAgyHomeSettingsJson,
  buildAgyIsolatedHomeArgs,
  buildSanitizedAntigravityEnv,
} from "./antigravityEnv.js";
import {
  extractEmailHintFromCredentialBase64,
  readAntigravityWindowsCredentialBase64,
  writeAntigravityWindowsCredentialBase64,
} from "./antigravityWinCred.js";

export const DEFAULT_ANTIGRAVITY_ACCOUNT_ID = "default";

const ACCOUNTS_KEY = "antigravity.accounts";
const ACTIVE_ACCOUNT_KEY = "antigravity.activeAccountId";
const SECRETS_KEY = "antigravity.accountSecrets";

interface StoredAccountMeta {
  id: string;
  name: string;
  method: Exclude<AntigravityAuthMethod, "default">;
  hint?: string;
  baseUrl?: string;
  gcpProject?: string;
  gcpLocation?: string;
  createdAt: number;
}

type SecretMap = Record<string, string>; // accountId → base64(safeStorage encrypted or plain fallback)

let accountRevision = 1;

export function getAntigravityAccountRevision(): number {
  return accountRevision;
}

function bumpRevision(): void {
  accountRevision += 1;
}

function encryptSecret(plain: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(plain).toString("base64");
  }
  return Buffer.from(plain, "utf8").toString("base64");
}

function decryptSecret(encoded: string): string | null {
  try {
    const buf = Buffer.from(encoded, "base64");
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(buf);
    }
    return buf.toString("utf8");
  } catch (err) {
    log.warn(`antigravity account secret decrypt failed: ${(err as Error).message}`);
    return null;
  }
}

function loadStoredAccounts(): StoredAccountMeta[] {
  const raw = SettingRepo.get(ACCOUNTS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StoredAccountMeta[]) : [];
  } catch {
    return [];
  }
}

function saveStoredAccounts(accounts: StoredAccountMeta[]): void {
  SettingRepo.set(ACCOUNTS_KEY, JSON.stringify(accounts));
}

function loadSecretMap(): SecretMap {
  const raw = SettingRepo.get(SECRETS_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as SecretMap) : {};
  } catch {
    return {};
  }
}

function saveSecretMap(map: SecretMap): void {
  SettingRepo.set(SECRETS_KEY, JSON.stringify(map));
}

function maskApiKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length <= 6) return "••••";
  return `••••${trimmed.slice(-4)}`;
}

function defaultAccountEntry(): AntigravityAccountPublic {
  return {
    id: DEFAULT_ANTIGRAVITY_ACCOUNT_ID,
    name: "Default",
    method: "default",
    hint: "~/.gemini",
    createdAt: 0,
  };
}

export function getActiveAntigravityAccountId(): string {
  const saved = SettingRepo.get(ACTIVE_ACCOUNT_KEY);
  if (!saved || saved === DEFAULT_ANTIGRAVITY_ACCOUNT_ID) {
    return DEFAULT_ANTIGRAVITY_ACCOUNT_ID;
  }
  const exists = loadStoredAccounts().some((a) => a.id === saved);
  return exists ? saved : DEFAULT_ANTIGRAVITY_ACCOUNT_ID;
}

export function listAntigravityAccounts(): AntigravityAccountListResult {
  const custom: AntigravityAccountPublic[] = loadStoredAccounts().map((a) => ({
    id: a.id,
    name: a.name,
    method: a.method,
    ...(a.hint ? { hint: a.hint } : {}),
    ...(a.baseUrl ? { baseUrl: a.baseUrl } : {}),
    ...(a.gcpProject ? { gcpProject: a.gcpProject } : {}),
    ...(a.gcpLocation ? { gcpLocation: a.gcpLocation } : {}),
    createdAt: a.createdAt,
  }));
  return {
    accounts: [defaultAccountEntry(), ...custom],
    activeAccountId: getActiveAntigravityAccountId(),
  };
}

export function getIsolatedGeminiDir(accountId: string): string {
  return join(app.getPath("userData"), "antigravity-homes", accountId);
}

/** Switch the active Antigravity account. For saved Google OAuth snapshots,
 *  writes the captured credential back to Windows Credential Manager. */
export async function selectAntigravityAccount(
  accountId: string,
): Promise<{ ok: boolean; activeAccountId: string; error?: string }> {
  if (accountId === DEFAULT_ANTIGRAVITY_ACCOUNT_ID) {
    SettingRepo.set(ACTIVE_ACCOUNT_KEY, DEFAULT_ANTIGRAVITY_ACCOUNT_ID);
    bumpRevision();
    return { ok: true, activeAccountId: DEFAULT_ANTIGRAVITY_ACCOUNT_ID };
  }

  const target = loadStoredAccounts().find((a) => a.id === accountId);
  if (!target) {
    return { ok: false, activeAccountId: getActiveAntigravityAccountId(), error: "账号不存在" };
  }

  if (target.method === "oauth-personal") {
    const secrets = loadSecretMap();
    const enc = secrets[target.id];
    const credB64 = enc ? decryptSecret(enc) : null;
    if (!credB64) {
      return {
        ok: false,
        activeAccountId: getActiveAntigravityAccountId(),
        error: "无法读取该 Google 账号的已保存凭据，请删除后重新捕获",
      };
    }
    try {
      await writeAntigravityWindowsCredentialBase64(credB64);
    } catch (err) {
      return {
        ok: false,
        activeAccountId: getActiveAntigravityAccountId(),
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  SettingRepo.set(ACTIVE_ACCOUNT_KEY, target.id);
  bumpRevision();
  return { ok: true, activeAccountId: target.id };
}

/** Add or update an API-key or GCP/Vertex AI isolated account. */
export function saveAntigravityAccount(
  input: AntigravitySaveAccountInput,
): { ok: boolean; account?: AntigravityAccountPublic; error?: string } {
  const name = input.name.trim();
  if (!name) return { ok: false, error: "请输入账号名称" };

  const accounts = loadStoredAccounts();
  const existingIdx = input.id ? accounts.findIndex((a) => a.id === input.id) : -1;
  const id = existingIdx >= 0 ? accounts[existingIdx]!.id : randomUUID();

  if (input.method === "gemini-api-key") {
    const apiKey = input.apiKey?.trim();
    if (!apiKey && existingIdx < 0) {
      return { ok: false, error: "请输入 Gemini API Key" };
    }
    if (apiKey) {
      const secrets = loadSecretMap();
      secrets[id] = encryptSecret(apiKey);
      saveSecretMap(secrets);
    }
    const baseUrl = input.baseUrl?.trim() || undefined;
    const meta: StoredAccountMeta = {
      id,
      name,
      method: "gemini-api-key",
      hint: apiKey ? maskApiKey(apiKey) : accounts[existingIdx]?.hint,
      ...(baseUrl ? { baseUrl } : {}),
      createdAt: existingIdx >= 0 ? accounts[existingIdx]!.createdAt : Date.now(),
    };
    if (existingIdx >= 0) accounts[existingIdx] = meta;
    else accounts.push(meta);
    saveStoredAccounts(accounts);
    if (getActiveAntigravityAccountId() === id) bumpRevision();
    return { ok: true, account: meta };
  }

  // agent-platform (GCP / Vertex AI)
  const gcpProject = input.gcpProject?.trim();
  if (!gcpProject) return { ok: false, error: "请输入 Google Cloud Project ID" };
  const gcpLocation = input.gcpLocation?.trim() || "global";
  const meta: StoredAccountMeta = {
    id,
    name,
    method: "agent-platform",
    hint: `${gcpProject} (${gcpLocation})`,
    gcpProject,
    gcpLocation,
    createdAt: existingIdx >= 0 ? accounts[existingIdx]!.createdAt : Date.now(),
  };
  if (existingIdx >= 0) accounts[existingIdx] = meta;
  else accounts.push(meta);
  saveStoredAccounts(accounts);
  if (getActiveAntigravityAccountId() === id) bumpRevision();
  return { ok: true, account: meta };
}

/** Capture the host machine's currently signed-in `agy` Google OAuth credential
 *  and save it as a named switchable account with its own `--gemini-dir`. */
export async function captureGoogleAntigravityAccount(
  rawName: string,
): Promise<{ ok: boolean; account?: AntigravityAccountPublic; error?: string }> {
  const name = rawName.trim();
  if (!name) return { ok: false, error: "请输入账号名称" };

  let credB64: string | null;
  try {
    credB64 = await readAntigravityWindowsCredentialBase64();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (!credB64) {
    return {
      ok: false,
      error: "未检测到当前本机 agy Google 登录凭据，请先在终端运行 `agy acp --login` 完成登录后再保存。",
    };
  }

  const id = randomUUID();
  const secrets = loadSecretMap();
  secrets[id] = encryptSecret(credB64);
  saveSecretMap(secrets);

  const emailHint = extractEmailHintFromCredentialBase64(credB64);
  const meta: StoredAccountMeta = {
    id,
    name,
    method: "oauth-personal",
    hint: emailHint ?? "Google OAuth",
    createdAt: Date.now(),
  };
  const accounts = loadStoredAccounts();
  accounts.push(meta);
  saveStoredAccounts(accounts);
  return { ok: true, account: meta };
}

/** Delete a saved account, its encrypted secret, and its isolated home dir. */
export async function deleteAntigravityAccount(
  accountId: string,
): Promise<{ ok: boolean; activeAccountId: string; error?: string }> {
  if (accountId === DEFAULT_ANTIGRAVITY_ACCOUNT_ID) {
    return { ok: false, activeAccountId: getActiveAntigravityAccountId(), error: "内置默认账号不可删除" };
  }

  const accounts = loadStoredAccounts();
  const next = accounts.filter((a) => a.id !== accountId);
  if (next.length === accounts.length) {
    return { ok: false, activeAccountId: getActiveAntigravityAccountId(), error: "账号不存在" };
  }
  saveStoredAccounts(next);

  const secrets = loadSecretMap();
  if (accountId in secrets) {
    delete secrets[accountId];
    saveSecretMap(secrets);
  }

  await rm(getIsolatedGeminiDir(accountId), { recursive: true, force: true }).catch(() => {});

  if (getActiveAntigravityAccountId() === accountId) {
    SettingRepo.set(ACTIVE_ACCOUNT_KEY, DEFAULT_ANTIGRAVITY_ACCOUNT_ID);
    bumpRevision();
  }
  return { ok: true, activeAccountId: getActiveAntigravityAccountId() };
}

export interface AntigravityLaunchContext {
  accountId: string;
  revision: number;
  method: AntigravityAuthMethod;
  /** Isolated `--gemini-dir` path, or null for the host's default `~/.gemini`. */
  geminiDir: string | null;
  /** Full `<geminiDir>/<appDataDir>` root where `conversations/` lives. */
  appDataRoot: string;
  /** Extra CLI flags to append to `agy acp` (`--gemini-dir ... --app-data-dir ...`). */
  cliHomeArgs: string[];
  /** Sanitized process env with account-specific auth vars applied. */
  env: NodeJS.ProcessEnv;
}

/** Ensure the active account's isolated `--gemini-dir` and `settings.json` are
 *  materialized on disk and return the launch flags + sanitized env. */
export async function resolveActiveAntigravityLaunchContext(): Promise<AntigravityLaunchContext> {
  const activeId = getActiveAntigravityAccountId();
  const revision = accountRevision;

  if (activeId === DEFAULT_ANTIGRAVITY_ACCOUNT_ID) {
    return {
      accountId: DEFAULT_ANTIGRAVITY_ACCOUNT_ID,
      revision,
      method: "default",
      geminiDir: null,
      appDataRoot: join(homedir(), ".gemini", AGY_APP_DATA_DIR_NAME),
      cliHomeArgs: [],
      env: buildSanitizedAntigravityEnv(process.env, "default"),
    };
  }

  const account = loadStoredAccounts().find((a) => a.id === activeId);
  if (!account) {
    return {
      accountId: DEFAULT_ANTIGRAVITY_ACCOUNT_ID,
      revision,
      method: "default",
      geminiDir: null,
      appDataRoot: join(homedir(), ".gemini", AGY_APP_DATA_DIR_NAME),
      cliHomeArgs: [],
      env: buildSanitizedAntigravityEnv(process.env, "default"),
    };
  }

  const geminiDir = getIsolatedGeminiDir(account.id);
  const appDataRoot = join(geminiDir, AGY_APP_DATA_DIR_NAME);
  await mkdir(appDataRoot, { recursive: true });

  const settingsPath = join(appDataRoot, "settings.json");
  const expectedSettings = buildAgyHomeSettingsJson({
    method: account.method,
    gcpProject: account.gcpProject,
    gcpLocation: account.gcpLocation,
  });
  const currentSettings = await readFile(settingsPath, "utf8").catch(() => null);
  if (currentSettings !== expectedSettings) {
    await writeFile(settingsPath, expectedSettings, { encoding: "utf8", mode: 0o600 });
  }

  const overrides: Record<string, string | undefined> = {};
  if (account.method === "gemini-api-key") {
    const secrets = loadSecretMap();
    const enc = secrets[account.id];
    const apiKey = enc ? decryptSecret(enc) : null;
    if (apiKey) overrides["GEMINI_API_KEY"] = apiKey;
    if (account.baseUrl) overrides["GOOGLE_GEMINI_BASE_URL"] = account.baseUrl;
  } else if (account.method === "agent-platform") {
    if (account.gcpProject) overrides["GOOGLE_CLOUD_PROJECT"] = account.gcpProject;
    if (account.gcpLocation) overrides["GOOGLE_CLOUD_LOCATION"] = account.gcpLocation;
  }

  return {
    accountId: account.id,
    revision,
    method: account.method,
    geminiDir,
    appDataRoot,
    cliHomeArgs: buildAgyIsolatedHomeArgs(geminiDir),
    env: buildSanitizedAntigravityEnv(process.env, account.method, overrides),
  };
}
