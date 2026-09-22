/** No-op logger — the real one touches electron's `app.getPath`, which does
 *  not exist outside the Electron main process. */
export const log = {
  info: (_msg: string): void => {},
  warn: (_msg: string): void => {},
  error: (_msg: string): void => {},
};
