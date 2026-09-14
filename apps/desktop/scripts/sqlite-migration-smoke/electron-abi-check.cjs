/**
 * Proves the better-sqlite3 binary in node_modules loads and works under the
 * REAL Electron runtime (the ABI the app actually runs on). Run AFTER
 * scripts/ensure-better-sqlite3-electron-abi.mjs:
 *
 *   npx electron scripts/sqlite-migration-smoke/electron-abi-check.cjs
 *
 * Uses a throwaway database in the OS temp dir — never the real profile.
 * Prints ELECTRON-ABI-OK and exits 0 on success; a wrong-ABI binary fails the
 * require with NODE_MODULE_VERSION before anything else happens.
 */
const { app } = require("electron");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const dir = mkdtempSync(join(tmpdir(), "mcode-electron-abi-"));
app.setPath("userData", dir);

app.whenReady().then(() => {
  try {
    const Database = require("better-sqlite3");
    const db = new Database(join(dir, "probe.db"));
    db.pragma("journal_mode = WAL");
    db.exec("CREATE TABLE t (x TEXT)");
    db.prepare("INSERT INTO t VALUES (?)").run("中文 round-trip");
    const row = db.prepare("SELECT x FROM t").get();
    if (row.x !== "中文 round-trip") throw new Error("round-trip mismatch: " + JSON.stringify(row));
    db.close();
    console.log("ELECTRON-ABI-OK");
    app.exit(0);
  } catch (err) {
    console.error("ELECTRON-ABI-FAIL:", err);
    app.exit(1);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* temp cleaner will get it */
    }
  }
});
