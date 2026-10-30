/**
 * Stand-in for @main/lib/logger.js — the only electron-adjacent import of
 * gitQueue.ts. Warnings are recorded so the smoke can assert the stale-lock
 * cleanup path actually logged.
 */
export const warnings: string[] = [];

export const log = {
  info: (msg: string): void => void msg,
  warn: (msg: string): void => {
    warnings.push(msg);
  },
  error: (msg: string): void => void msg,
  debug: (msg: string): void => void msg,
};
