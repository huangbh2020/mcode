/** In-memory settings stub for the pi-models-store smoke — only SettingRepo
 *  (the encrypted apiKey map's backing table) is consumed. */
export const settings = new Map<string, string>();

export const SettingRepo = {
  get(key: string): string | null {
    return settings.get(key) ?? null;
  },
  set(key: string, value: string): void {
    settings.set(key, value);
  },
};
