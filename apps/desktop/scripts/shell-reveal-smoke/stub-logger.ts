/**
 * In-memory stand-in for `@main/lib/logger.js` in the headless smoke (shell
 * reveal scope). The real logger imports `electron` for
 * `app.getPath("userData")`, and that package's CJS entry does a dynamic
 * `require("fs")` which cannot survive an ESM bundle. Aliased in run.sh —
 * same trick the other smokes use.
 */
type Level = "INFO" | "WARN" | "ERROR";

function write(level: Level, msg: string): void {
  process.stderr.write(`[smoke] [${level}] ${msg}\n`);
}

export const log = {
  info: (msg: string) => write("INFO", msg),
  warn: (msg: string) => write("WARN", msg),
  error: (msg: string) => write("ERROR", msg),
};
