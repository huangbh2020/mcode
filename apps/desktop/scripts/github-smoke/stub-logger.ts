/**
 * In-memory stand-ins for the electron/sqlite-adjacent modules the GitHub
 * client imports, so the smoke can bundle and run headless:
 *
 *  - stub-logger.ts  ← @main/lib/logger.js  (real one imports electron app)
 *  - stub-secrets.ts ← @main/lib/secretStore.js (real one imports safeStorage)
 *  - stub-store.ts   ← @main/store/repositories.js (real one opens sqlite)
 *
 * The store stub returns a base64("smoke-test-token") settings row so
 * resolveGithubToken takes the settings path deterministically (no `gh` exec).
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
