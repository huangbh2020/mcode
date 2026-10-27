/** Electron-adjacent stubs for the chrome-relay smoke (esbuild alias
 *  targets). safeStorage reports unavailable so the token falls to the
 *  plaintext-fallback path; settings live in an in-memory map. */
export const settingsMap = new Map<string, string>();
export const pushedStatuses: unknown[] = [];

export const electronStub = {
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => {
      throw new Error("unavailable");
    },
    decryptString: () => "",
  },
  app: { getPath: () => "/tmp" },
};

export const SettingRepo = {
  get: (key: string): string | null => settingsMap.get(key) ?? null,
  set: (key: string, value: string): void => {
    settingsMap.set(key, value);
  },
};

export const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

export const windowStub = {
  sendToRenderer: (_channel: string, msg: unknown): void => {
    pushedStatuses.push(msg);
  },
};
