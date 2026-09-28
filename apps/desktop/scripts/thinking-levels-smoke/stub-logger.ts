/** esbuild-alias stub for `@main/lib/logger.js` — the real one requires the
 *  electron package (CJS dynamic requires that blow up under plain Node).
 *  BridgeRegistry imports it for rebuild logging only; the smoke doesn't
 *  assert on log output. */
export const log = {
  info: (..._args: unknown[]) => {},
  warn: (..._args: unknown[]) => {},
  error: (..._args: unknown[]) => {},
};
