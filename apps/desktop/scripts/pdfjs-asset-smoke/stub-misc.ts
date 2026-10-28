/** Stubs for the remaining heavy imports of ipc/files.ts that the pdfjs-asset
 *  code never touches. */
export const resolveRg = async (): Promise<string | null> => null;
export const rgListFiles = async (): Promise<string[]> => [];
export const rgGrep = async (): Promise<unknown[]> => [];

export const cachedTreeFiles = (): string[] => [];
export const sortDirents = <T,>(x: T[]): T[] => x;
export const SEARCH_MAX_DEPTH = 20;
export const SEARCH_MAX_VISIT = 20000;

export const log = {
  info: (): void => {},
  warn: (): void => {},
  error: (): void => {},
};
