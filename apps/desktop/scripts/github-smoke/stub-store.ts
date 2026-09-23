/**
 * Stub for @main/store/repositories.js (headless smoke): a settings repo with
 * one pre-seeded token row (base64 of "smoke-test-token") so the client's
 * token resolution takes the settings path deterministically — no sqlite, no
 * `gh` exec. Only the members the GitHub client touches are provided.
 */
const TOKEN_B64 = Buffer.from("smoke-test-token", "utf8").toString("base64");

export const SettingRepo = {
  get(key: string): string | null {
    return key === "github.token" ? TOKEN_B64 : null;
  },
  getMany(keys: string[]): Record<string, string | null> {
    const out: Record<string, string | null> = {};
    for (const k of keys) out[k] = this.get(k);
    return out;
  },
  set(_key: string, _value: string): void {},
};

export const ProjectRepo = {};
