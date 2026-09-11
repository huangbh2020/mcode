/**
 * E2E: reproduce the "dead local proxy" failure and verify the bypass retry.
 *
 * Preconditions exercised (the exact user-reported failure):
 *   - git GLOBAL config in the (scratch) HOME points at a dead proxy
 *     (`http.proxy = http://127.0.0.1:1` — nothing listens there);
 *   - the process env carries the same dead proxy (https_proxy/HTTPS_PROXY/…).
 *
 * First clone attempt must die with curl's "Failed to connect to 127.0.0.1
 * port …"; gitClone's retry strips config + env proxies and goes direct. The
 * machine running this test must be able to reach GitHub directly (with a
 * live proxy required, the bypass attempt legitimately fails).
 *
 * Run via scripts/plugins-smoke/run-e2e-proxy.sh.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import {
  addMarketplace,
  listMarketplaces,
  removeMarketplace,
} from "../../src/main/plugins/pluginManager.js";

const DEAD = "http://127.0.0.1:1";

// Dead proxy in the env — runCommand's first attempt inherits it.
for (const k of ["https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY", "all_proxy", "ALL_PROXY"]) {
  process.env[k] = DEAD;
}
// Dead proxy in git's global config (scratch HOME provided by the runner).
writeFileSync(
  path.join(process.env.HOME ?? "/tmp", ".gitconfig"),
  `[http]\n\tproxy = ${DEAD}\n[https]\n\tproxy = ${DEAD}\n`,
);

const MARKET = "https://github.com/anthropics/claude-plugins-official.git";

console.log("attempting addMarketplace with a dead proxy configured (expect bypass retry)…");
const res = await addMarketplace({ kind: "git", ref: MARKET });
if (!res.ok) {
  console.error("addMarketplace FAILED:", res.error);
  process.exit(1);
}

const mp = listMarketplaces()[0];
const count = mp.plugins.length;
console.log(`marketplace added via proxy bypass: ${mp.name}, ${count} entries`);
removeMarketplace(mp.name);

if (count < 250) {
  console.error(`expected the full official catalog (~292), got ${count}`);
  process.exit(1);
}
console.log("PASS");
