#!/usr/bin/env node
/**
 * Re-provision better-sqlite3's native binary for ELECTRON after every install.
 *
 * Why this exists: better-sqlite3 ships its JS + a build step that provisions
 * a prebuilt (or compiles) for the NODE runtime running the install. The app
 * loads the module in Electron's MAIN process, whose ABI (NODE_MODULE_VERSION)
 * differs from plain Node's — Electron 33 is ABI 130. Loading a Node-ABI
 * binary in Electron crashes at startup with
 * "NODE_MODULE_VERSION ... This version of Node.js requires ...".
 *
 * What it does: re-runs better-sqlite3's own `prebuild-install` with
 * `--runtime=electron --target=<electron version>` — i.e. swaps the binary in
 * node_modules for the matching prebuilt. pnpm-workspace.yaml's allowBuilds
 * entry already lets better-sqlite3 run its own (Node-targeted) build script;
 * this hook runs afterwards and fixes up the target runtime.
 *
 * Wiring: apps/desktop/package.json `scripts.postinstall`.
 *
 * Failure policy: this script NEVER fails the install. If the prebuilt can't
 * be downloaded (offline, mirror down), it prints the manual fix loudly and
 * exits 0 — the error the developer would otherwise see is the cryptic
 * NODE_MODULE_VERSION crash at app startup, which this warning explains.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

// Resolve through apps/desktop/node_modules (this script lives in its scripts/).
const pkgDir = dirname(require.resolve("better-sqlite3/package.json"));

// Marker: skip when the Electron-ABI binary is already in place. The marker
// lives NEXT TO the binary, so the next `pnpm install` (which re-provisions
// the Node binary via better-sqlite3's own postinstall) removes it and this
// hook re-runs.
const markerPath = join(pkgDir, "build", "Release", ".electron-abi");
if (existsSync(markerPath)) {
  process.exit(0);
}

let electronVersion;
try {
  electronVersion = JSON.parse(readFileSync(require.resolve("electron/package.json"), "utf8")).version;
} catch {
  console.warn("[ensure-better-sqlite3-abi] electron not installed — skipping (dev-only state?)");
  process.exit(0);
}

// prebuild-install is better-sqlite3's own dependency: pnpm hoists it as a
// sibling inside better-sqlite3's virtual store (pkgDir/../prebuild-install).
const prebuildBin = join(pkgDir, "..", "prebuild-install", "bin.js");
if (!existsSync(prebuildBin)) {
  console.warn(
    "[ensure-better-sqlite3-abi] prebuild-install not found next to better-sqlite3 —\n" +
      "  run manually: npx prebuild-install --runtime=electron --target=" +
      electronVersion +
      " (inside node_modules/better-sqlite3)",
  );
  process.exit(0);
}

// GitHub releases are often unreachable from mainland China; same mirror the
// .npmrc uses for electron itself. prebuild-install picks this npm-config var
// up. (registry.npmmirror.com, not npmmirror.com — the apex host doesn't
// resolve on some networks; the registry host is what .npmrc uses too.)
const env = {
  ...process.env,
  npm_config_better_sqlite3_binary_host_mirror:
    "https://registry.npmmirror.com/-/binary/better-sqlite3",
};

const args = [
  "--runtime=electron",
  `--target=${electronVersion}`,
  `--platform=${process.platform}`,
  `--arch=${process.arch}`,
];

try {
  console.log(
    `[ensure-better-sqlite3-abi] provisioning Electron ${electronVersion} prebuild for better-sqlite3…`,
  );
  // Output is piped (not inherited) so success stays quiet; failures print
  // everything — prebuild-install's own stderr is the only diagnostic for
  // mirror/DNS problems. cwd MUST be better-sqlite3's own directory:
  // prebuild-install reads ./package.json from its cwd to learn the package
  // name + version it is provisioning (from the install dir it would read
  // @mcode/desktop's and fetch nonsense).
  const out = execFileSync(process.execPath, [prebuildBin, ...args, "--verbose"], {
    env,
    cwd: pkgDir,
  });
  writeFileSync(markerPath, electronVersion);
  console.log("[ensure-better-sqlite3-abi] done — binary now matches Electron's ABI");
} catch (err) {
  const detail = [err.stdout, err.stderr].filter(Boolean).join("\n").trim();
  console.warn(
    `[ensure-better-sqlite3-abi] WARNING: could not fetch the Electron prebuilt (${err.message}).\n` +
      (detail ? detail + "\n  " : "") +
      "  The app will crash at startup with a NODE_MODULE_VERSION error until fixed.\n" +
      `  Manual fix: cd ${pkgDir} && npx prebuild-install ${args.join(" ")}`,
  );
  process.exit(0);
}
