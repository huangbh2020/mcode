/** electron stub for the runtime-update smoke — app paths point at the temp
 *  dirs the test wires up via globalThis.__smokeDirs before any call. */
interface SmokeDirs {
  userData: string;
  appRoot: string;
}

export const app = {
  getPath(_name: string): string {
    return (globalThis as unknown as { __smokeDirs: SmokeDirs }).__smokeDirs.userData;
  },
  getAppPath(): string {
    return (globalThis as unknown as { __smokeDirs: SmokeDirs }).__smokeDirs.appRoot;
  },
};
