/** Smoke stub for cross-spawn (pulled in by @opencode-ai/sdk's server
 *  helper). The smoke never spawns an opencode server, so a throwing stub
 *  keeps the bundle ESM-clean while preserving module-shape parity. */
const unsupported = (): never => {
  throw new Error("cross-spawn is stubbed out in the opencode provider smoke");
};

export default Object.assign(unsupported, { spawn: unsupported, sync: unsupported });
export const spawn = unsupported;
export const spawnSync = unsupported;
