/** In-memory logger stub for the pi-import smoke (the real one pulls in
 *  electron's userData paths). Keeps the last message per level for
 *  assertions. */
export const logCalls: Array<{ level: string; msg: string }> = [];

export const log = {
  info: (msg: string) => logCalls.push({ level: "info", msg }),
  warn: (msg: string) => logCalls.push({ level: "warn", msg }),
  error: (msg: string) => logCalls.push({ level: "error", msg }),
  debug: (msg: string) => logCalls.push({ level: "debug", msg }),
};
