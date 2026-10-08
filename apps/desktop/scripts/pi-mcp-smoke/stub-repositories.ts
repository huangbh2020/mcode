/**
 * Stub for @main/store/repositories.js — only the surface mcpConfig.ts uses:
 * SettingRepo.get reading the management-state JSON planted by main.ts
 * (globalThis.__PI_MCP_SMOKE_MANAGEMENT__). pathGuard.ts also pulls
 * ProjectRepo/SessionRepo — empty shells suffice (samePath needs no rows).
 */
export const SettingRepo = {
  get(key: string): string | null {
    const map = (globalThis as { __PI_MCP_SMOKE_SETTINGS__?: Map<string, string> })
      .__PI_MCP_SMOKE_SETTINGS__;
    return map?.get(key) ?? null;
  },
  set(_key: string, _value: string): void {},
};

export const ProjectRepo = {};
export const SessionRepo = {};
export const MessageRepo = {};
export const RuntimeRepo = {};
