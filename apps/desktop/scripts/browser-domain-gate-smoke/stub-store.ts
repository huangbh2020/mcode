/** SettingRepo stub for the domain-gate smoke: an in-memory settings map the
 *  tests can seed/inspect. Wired via esbuild --alias in run.sh. */
export const settingsMap = new Map<string, string>();

export const SettingRepo = {
  get(key: string): string | null {
    return settingsMap.get(key) ?? null;
  },
  set(key: string, value: string): void {
    settingsMap.set(key, value);
  },
};
