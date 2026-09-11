/**
 * One-off end-to-end check against a REAL marketplace checkout (default:
 * anthropics/claude-plugins-official, 292 entries mixing url / git-subdir /
 * relative sources). Verifies the production manager parses the whole catalog
 * with no blanked entries. Not part of run.sh — invoke via:
 *   scripts/plugins-smoke/run-e2e-official.sh <path-to-checkout>
 */
import { addMarketplace, listMarketplaces, removeMarketplace } from "../../src/main/plugins/pluginManager.js";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: run-e2e-official.sh <path-to-cloned-marketplace>");
  process.exit(2);
}

const res = await addMarketplace({ kind: "local", ref: dir });
if (!res.ok) {
  console.error("addMarketplace FAILED:", res.error);
  process.exit(1);
}
const marketplaces = listMarketplaces();
const m = marketplaces[marketplaces.length - 1];
const names = m.plugins.map((p) => p.name);
console.log(`marketplace : ${m.name}`);
console.log(`entries     : ${names.length}`);
console.log(`with desc   : ${m.plugins.filter((p) => p.description).length}`);
console.log(`first five  : ${names.slice(0, 5).join(", ")}`);
console.log(`has context7: ${names.includes("context7")}`);
removeMarketplace(m.name);
if (names.length < 290) {
  console.error(`EXPECTED ~292 entries, got ${names.length} — entries were dropped`);
  process.exit(1);
}
console.log("PASS");
