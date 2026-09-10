/**
 * One-off end-to-end check of the `{source:"url"}` entries of the REAL official
 * catalog — 152 of its 292 entries use that shape, and they are REPOSITORIES
 * (`https://github.com/<owner>/<repo>.git`), not archives. Treating them as
 * downloads fetched GitHub's HTML repo page and handed it to tar, which failed
 * with "Unrecognized archive format"; they must install via git clone.
 *
 * Adds the real claude-plugins-official marketplace, picks the first N
 * url-source entries straight out of its manifest, installs each through the
 * production manager and reports per-entry results. Needs network (the ENTRY
 * urls are remote even when the marketplace itself is added from a local
 * checkout — pass a path to skip the catalog clone). Not part of run.sh:
 *   scripts/plugins-smoke/run-e2e-url-source.sh [count] [checkout-dir]
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { addMarketplace, installFromMarketplace, listMarketplaces, removeMarketplace } from "../../src/main/plugins/pluginManager.js";

const MARKETPLACE = "https://github.com/anthropics/claude-plugins-official";
const NAME = "claude-plugins-official";
const want = Number(process.argv[2] ?? 3);
const checkout = process.argv[3];

const added = await addMarketplace(
  checkout ? { kind: "local", ref: checkout } : { kind: "git", ref: MARKETPLACE },
);
if (!added.ok) {
  console.error("addMarketplace FAILED:", added.error);
  process.exit(1);
}
const mp = listMarketplaces().find((m) => m.name === NAME);
if (!mp) {
  console.error("marketplace not listed after add");
  process.exit(1);
}

// The panel state carries no raw source shape, so read the cloned manifest to
// select the entries that used to fail (`{source:"url"}`).
const manifestPath = path.join(
  homedir(),
  ".mcode",
  "plugins",
  "marketplaces",
  NAME,
  ".claude-plugin",
  "marketplace.json",
);
const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
  plugins: Array<{ name: string; source: unknown }>;
};
const urlEntries = manifest.plugins.filter(
  (e) => typeof e.source === "object" && e.source !== null && (e.source as { source?: string }).source === "url",
);

console.log(`marketplace : ${NAME} (${mp.plugins.length} entries, ${urlEntries.length} of them url sources)`);
const targets = urlEntries.slice(0, want);
console.log(`installing  : ${targets.map((t) => t.name).join(", ")}\n`);

let failed = 0;
for (const entry of targets) {
  const res = await installFromMarketplace(NAME, entry.name);
  if (res.ok) {
    console.log(`  ✓ ${entry.name} → ${res.plugin?.name} v${res.plugin?.version}`);
  } else {
    failed++;
    console.error(`  ✗ ${entry.name} — ${res.error}`);
  }
}

removeMarketplace(NAME);
if (failed > 0) {
  console.error(`\n${failed}/${targets.length} url-source entries FAILED`);
  process.exit(1);
}
console.log(`\nPASS — ${targets.length} url-source entries installed`);
