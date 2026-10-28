/** Electron stub for the pdfjs-asset smoke — files.ts / appResourceProtocol.ts
 *  import electron at the top level but none of the code under test executes
 *  the imported bindings. */
export const app = {
  getPath: (_name: string): string => process.cwd(),
  getAppPath: (): string => process.cwd(),
};
export const clipboard = {};
export const nativeImage = {};
export const shell = {};
export const protocol = {
  registerSchemesAsPrivileged: (): void => {},
  handle: (_scheme: string, _fn: unknown): void => {},
};
