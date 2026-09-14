/**
 * In-memory stand-in for the `electron` module in the headless smoke (shell
 * reveal scope). Only what `@main/ipc/shell.js` touches at runtime: the
 * `shell` surface, turned into recording spies so the smoke can assert WHICH
 * calls reached the OS and which were refused by the path guards. `IpcMain`
 * is a type-only import in shell.ts — erased at bundle time.
 */

export type ShellCall = { op: "openPath" | "showItemInFolder"; path: string };

const calls: ShellCall[] = [];

/** Drop every recorded call (between scenarios). */
export function resetShellCalls(): void {
  calls.length = 0;
}

export function getShellCalls(): readonly ShellCall[] {
  return calls;
}

export const shell = {
  openPath: async (path: string): Promise<string> => {
    calls.push({ op: "openPath", path });
    return ""; // "" = success
  },
  showItemInFolder: (path: string): void => {
    calls.push({ op: "showItemInFolder", path });
  },
};
