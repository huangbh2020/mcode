/**
 * Minimal `electron` stand-in for the headless smoke.
 *
 * `@main/ipc/files.ts` (the module under test) imports the real package for
 * `app` / `clipboard` / `nativeImage` / `shell`; its CJS entry cannot survive
 * an ESM bundle and none of it is reachable from the paths exercised here
 * (listDirGuarded reads the filesystem only). Aliased in run.sh.
 */
export const app = {
  getPath: () => process.env["SMOKE_USER_DATA"] ?? "/tmp/mcode-worktree-env-smoke",
  isPackaged: false,
};

export const clipboard = { writeText: (): void => {}, readText: (): string => "" };
export const nativeImage = { createFromPath: (): null => null };
export const shell = { showItemInFolder: (): void => {}, openPath: async (): Promise<""> => "" };
