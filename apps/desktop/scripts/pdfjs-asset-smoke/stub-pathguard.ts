/** pathGuard stub — none of the pdfjs-asset code paths use it (real one pulls
 *  the DB-layer repositories transitively). */
export const isKnownWorkspaceRoot = (_p: string): boolean => false;
export const findContainingWorkspaceRoot = (_p: string): string | null => null;
export const isPasteTempPath = (_p: string): boolean => false;
