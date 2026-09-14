/**
 * Stub for `@renderer/lib/monacoSetup.js` (dynamically imported by the
 * store's `reloadLspLanguages`): Monaco is a browser-only dependency this
 * smoke must not bundle. Exposes just the surface the store consumes.
 */
export const monaco = {};
export function setTsWorkerDiagnosticsEnabled(_enabled: boolean): void {}
export function isTsWorkerDiagnosticsEnabled(): boolean {
  return false;
}
