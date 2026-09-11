/**
 * Smoke-test stub for @main/store/repositories.js — an in-memory SettingRepo.
 * The real module pulls in sql.js + electron's `app`; the plugin manager only
 * touches SettingRepo.get/set, so this keeps the bundle headless.
 */
const store = new Map<string, string>();

export const SettingRepo = {
  get(key: string): string | null {
    return store.get(key) ?? null;
  },
  getMany(keys: string[]): Record<string, string | null> {
    const out: Record<string, string | null> = {};
    for (const k of keys) out[k] = store.get(k) ?? null;
    return out;
  },
  set(key: string, value: string): void {
    store.set(key, value);
  },
  /** Smoke-only: raw view of the settings store for assertions. */
  __dump(): Record<string, string> {
    return Object.fromEntries(store);
  },
};
