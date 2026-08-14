/**
 * Encrypted credential vault for the embedded browser panel.
 *
 * Stores one credential per origin ({username, password}) for two purposes:
 *  1. HTTP Basic Auth auto-fill — app.on("login") looks up the page's origin.
 *  2. Manual vault — the user manages entries in the browser panel's
 *     credential dialog and can one-click fill them into login forms.
 *
 * Passwords are encrypted with Electron safeStorage (OS keychain) via the
 * shared secretStore helpers and persisted as a JSON map under the
 * `browser.credentials` settings key. Plaintext passwords NEVER leave the
 * main process: the list API returns origin + username only, and form filling
 * happens main-side via executeJavaScript.
 */
import { BROWSER_CREDENTIALS_SETTING_KEY, type BrowserCredentialPublic } from "@contracts/ipc";
import { encrypt, decrypt } from "@main/lib/secretStore.js";
import { SettingRepo } from "@main/store/repositories.js";

interface StoredCredential {
  username: string;
  passwordEnc: string;
}

type CredentialMap = Record<string, StoredCredential>; // origin -> credential

/** Normalize a URL to its origin (scheme://host[:port]). Returns "" for URLs
 *  the URL constructor can't parse (not a real origin — don't store those). */
export function urlOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

function read(): CredentialMap {
  const raw = SettingRepo.get(BROWSER_CREDENTIALS_SETTING_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as CredentialMap) : {};
  } catch {
    return {};
  }
}

function write(map: CredentialMap): void {
  SettingRepo.set(BROWSER_CREDENTIALS_SETTING_KEY, JSON.stringify(map));
}

export const BrowserCredentialStore = {
  /** List all credentials WITHOUT passwords (for the renderer's vault UI). */
  list(): BrowserCredentialPublic[] {
    return Object.entries(read())
      .map(([origin, c]) => ({ origin, username: c.username }))
      .sort((a, b) => a.origin.localeCompare(b.origin));
  },

  /** Create/update the credential for an origin (password re-encrypted). */
  save(origin: string, username: string, password: string): BrowserCredentialPublic[] {
    const map = read();
    map[origin] = { username, passwordEnc: encrypt(password) };
    write(map);
    return this.list();
  },

  /** Delete the credential for an origin. */
  remove(origin: string): BrowserCredentialPublic[] {
    const map = read();
    delete map[origin];
    write(map);
    return this.list();
  },

  /** Get the decrypted credential for an origin (main-process only).
   *  Returns undefined when absent or undecryptable. */
  get(origin: string): { username: string; password: string } | undefined {
    const c = read()[origin];
    if (!c) return undefined;
    const password = decrypt(c.passwordEnc);
    if (!password) return undefined;
    return { username: c.username, password };
  },
};
