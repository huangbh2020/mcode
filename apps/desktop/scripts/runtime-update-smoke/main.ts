/**
 * Headless smoke for the agent runtime update feature.
 *
 * Covered (see run.sh for the stubbing setup):
 *   0. repo config/agent-runtime-compat.json stays in sync with the embedded
 *      BASELINE_COMPAT_LIST (the two must be edited together)
 *   1. compat list: remote override wins, fetch failure degrades to baseline
 *      + stale flag; classifyVersion tested/unlisted/broken
 *   2. check verdict matrix: ok / unlisted→untested / up-to-date / blocked /
 *      registry-unreachable (+ compat-stale degradation)
 *   3. green pin install (claude, wrapper PAIRED into the version dir)
 *   4. yellow versioned install → compat gates run and pass, "verifying"
 *      progress pushed, install.json records risk
 *   5. keep-2 retention prunes everything but the two newest
 *   6. G2 marker-scan rejection → gateBlocked, old versions untouched
 *   7. G1 harness-schema rejection → gateBlocked
 *   8. force install bypasses the gates and records forced
 *   9. rollback deletes the newest dir and reports the fallback version
 *  10. per-version remove (unknown version rejected, known version removed)
 *  11. codex vendored-layout install (pin)
 *  12. pi meta-package install through the real import gate + the
 *      updateAvailable semantics (on-latest suppresses the stale-vs-pin badge)
 */
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { create as tarCreate } from "tar";
import {
  BASELINE_COMPAT_LIST,
  classifyVersion,
  loadCompatList,
  type CompatList,
} from "@main/runtimes/runtimeCompat.js";
import { setManagedRuntimeRoot, listManagedVersions } from "@main/runtimes/managedRuntimeRoots.js";
import { codexVendorTriple } from "@main/providers/codex-sdk/codexBinaryResolve.js";
import {
  checkRuntimeUpdates,
  installRuntime,
  listRuntimes,
  removeRuntime,
  rollbackRuntime,
} from "@main/runtimes/runtimeInstaller.js";
import { COMPAT_LIST_URLS } from "@main/runtimes/runtimeCompat.js";
import type { RuntimeCheckVerdict } from "@contracts/ipc";

let passed = 0;
function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  passed++;
}

/* ── dirs (wired into the electron stub via globalThis) ── */

const root = mkdtempSync(join(tmpdir(), "mcode-runtime-update-smoke."));
const userData = join(root, "userData");
const appRoot = join(root, "app");
const runtimesRoot = join(userData, "runtimes");
const fixtures = join(root, "fixtures");
for (const d of [userData, appRoot, runtimesRoot, fixtures]) mkdirSync(d, { recursive: true });
(globalThis as unknown as { __smokeDirs: unknown }).__smokeDirs = { userData, appRoot };
(globalThis as unknown as { __smokeEvents: unknown[] }).__smokeEvents = [];

setManagedRuntimeRoot(runtimesRoot);

// The installer reads pins from app.getAppPath()/package.json.
const PINS = { claude: "0.3.258", codex: "0.153.4", pi: "0.83.0" };
writeFileSync(
  join(appRoot, "package.json"),
  JSON.stringify(
    {
      dependencies: { "@anthropic-ai/claude-agent-sdk": PINS.claude },
      devDependencies: {
        "@openai/codex": PINS.codex,
        "@earendil-works/pi-coding-agent": PINS.pi,
      },
    },
    null,
    2,
  ),
);

/* ── fixture builders ── */

const CLAUDE_MARKER = "permission_exit_plan_mode_v2";
const triple = codexVendorTriple() ?? "unknown-triple";
const IS_WIN = process.platform === "win32";
const CLAUDE_BIN = IS_WIN ? "claude.exe" : "claude";
const CODEX_BIN = IS_WIN ? "codex.exe" : "codex";

/** A fixture "binary": executable (answers --version with exit 0) and,
 *  when withMarker, carries the claude protocol marker in its bytes. win32:
 *  a copy of process.execPath with the marker appended (PE overlays tolerate
 *  trailing bytes); posix: a shell script. */
async function makeBinaryFixture(destPath: string, withMarker: boolean): Promise<void> {
  if (IS_WIN) {
    copyFileSync(process.execPath, destPath);
    if (withMarker) appendFileSync(destPath, `\n// ${CLAUDE_MARKER}\n`);
  } else {
    const body = withMarker ? `#!/bin/sh\n# ${CLAUDE_MARKER}\nexec node --version\n` : "#!/bin/sh\nexec node --version\n";
    writeFileSync(destPath, body);
    chmodSync(destPath, 0o755);
  }
}

/** Pack `dir` into a gzipped tarball, npm-style, and register its sha512. */
async function packFixture(key: string, dir: string): Promise<void> {
  const out = join(fixtures, `${key.replace(/[^\w.-]+/g, "_")}.tgz`);
  await tarCreate({ gzip: true, file: out, cwd: dir, portable: true }, ["."]);
  const bytes = readFileSync(out);
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  routes.blobs.set(routes.tarballUrl(key), bytes);
  routes.integrity.set(key, integrity);
}

function sha512(buf: Buffer): string {
  return `sha512-${createHash("sha512").update(buf).digest("base64")}`;
}

/* ── fetch stub ── */

const REGISTRY = "https://registry.npmmirror.com";
const plat = `${process.platform}-${process.arch}`;
const CLAUDE_PLATFORM_PKG = `@anthropic-ai/claude-agent-sdk-${plat}`;
const CLAUDE_JS_PKG = "@anthropic-ai/claude-agent-sdk";
const CODEX_PKG = "@openai/codex";
const PI_META_PKG = "@mcode/runtime-pi";
const UPSTREAM_PI_PKG = "@earendil-works/pi-coding-agent";

const routes = {
  compat: null as { body: CompatList } | null,
  compatFail: false,
  /** Subset of COMPAT_LIST_URLS allowed to serve (chain-fallback tests);
   *  null = all serve. */
  compatUrls: null as Set<string> | null,
  registryFail: false,
  /** (name, version) -> fixture key for meta lookups */
  meta: new Map<string, string>(),
  /** package name -> latest version */
  latest: new Map<string, string>(),
  blobs: new Map<string, Buffer>(),
  integrity: new Map<string, string>(),
  tarballUrl(key: string): string {
    return `http://fixture.local/${key}.tgz`;
  },
};

function jsonRes(body: unknown): unknown {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers(),
  };
}

function blobRes(bytes: Buffer): unknown {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-length": String(bytes.length) }),
    body: Readable.toWeb(Readable.from([bytes])),
  };
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: unknown): Promise<unknown> => {
  const u = String(url);
  if ((COMPAT_LIST_URLS as readonly string[]).includes(u)) {
    if (routes.compatFail || !routes.compat) return { ok: false, status: 404, headers: new Headers() };
    if (routes.compatUrls && !routes.compatUrls.has(u)) return { ok: false, status: 404, headers: new Headers() };
    return jsonRes(routes.compat.body);
  }
  if (u.startsWith(`${REGISTRY}/`)) {
    if (routes.registryFail) return { ok: false, status: 503, headers: new Headers() };
    const rest = u.slice(REGISTRY.length + 1);
    const [encName, version] = rest.split("/");
    const name = encName.replace("%2F", "/");
    if (version === "latest") {
      const v = routes.latest.get(name);
      return v ? jsonRes({ version: v }) : { ok: false, status: 404, headers: new Headers() };
    }
    const key = routes.meta.get(`${name}@${version}`);
    if (!key) return { ok: false, status: 404, headers: new Headers() };
    return jsonRes({ dist: { tarball: routes.tarballUrl(key), integrity: routes.integrity.get(key) } });
  }
  const blob = routes.blobs.get(u);
  return blob ? blobRes(blob) : { ok: false, status: 404, headers: new Headers() };
}) as typeof fetch;

/* ── compat list fixtures ── */

const COMPAT_A: CompatList = {
  schema: 1,
  claude: { tested: ["0.3.258"], broken: {} },
  codex: { tested: ["0.153.4"], broken: {} },
  pi: { tested: ["0.83.0"], broken: { "0.90.0": "example known breakage" } },
};
const COMPAT_B: CompatList = {
  ...COMPAT_A,
  claude: { tested: ["0.3.258", "0.3.300"], broken: {} },
};

function tgzFixtureDir(name: string): string {
  const dir = join(fixtures, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

/* ═════════ phase 0 — baseline sync with repo config ═════════ */

const repoConfigPath = join(
  process.env["SMOKE_REPO_ROOT"] ?? join(__dirname, "../../.."),
  "config",
  "agent-runtime-compat.json",
);
const repoConfig = JSON.parse(readFileSync(repoConfigPath, "utf8")) as CompatList;
assert(
  JSON.stringify(repoConfig) === JSON.stringify(BASELINE_COMPAT_LIST),
  "config/agent-runtime-compat.json is out of sync with BASELINE_COMPAT_LIST — edit BOTH",
);

/* ═════════ phase 1 — compat list load + classify ═════════ */

routes.compat = { body: COMPAT_A };
{
  const { list, staleReason } = await loadCompatList();
  assert(staleReason === null, "healthy remote override must not be stale");
  assert(list.claude.tested.includes("0.3.258"), "remote override serves its own list");
  assert(classifyVersion(list, "claude", "0.3.260") === "unlisted", "unlisted version classifies unlisted");
  assert(classifyVersion(list, "claude", "0.3.258") === "tested", "tested version classifies tested");
  assert(
    classifyVersion(list, "pi", "0.90.0") === "broken:example known breakage",
    "broken version classifies broken with reason",
  );
}
{
  // The first mirror in the chain failing (CDN miss / file not synced) must
  // fall through to the next URL, not degrade to the baseline.
  routes.compatUrls = new Set(COMPAT_LIST_URLS.slice(1));
  const { list, staleReason } = await loadCompatList();
  routes.compatUrls = null;
  assert(staleReason === null, "chain falls through to the next mirror");
  assert(list.claude.tested.length > 0, "served by the surviving mirror");
}
routes.compatFail = true;
{
  const { list, staleReason } = await loadCompatList();
  assert(staleReason === "fetch-failed", "unreachable list degrades to baseline flagged stale");
  assert(list.pi.broken["0.90.0"] === undefined, "baseline has no broken entries");
}
routes.compatFail = false;

/* ═════════ phase 2 — check verdict matrix (seeded managed dirs) ═════════ */

mkdirSync(join(runtimesRoot, "claude", "0.3.258"), { recursive: true });
writeFileSync(join(runtimesRoot, "claude", "0.3.258", CLAUDE_BIN), "stub");
mkdirSync(join(runtimesRoot, "codex", "0.153.4", "vendor", triple, "bin"), { recursive: true });
writeFileSync(join(runtimesRoot, "codex", "0.153.4", "vendor", triple, "bin", CODEX_BIN), "stub");
const piPkgDir = join(runtimesRoot, "pi", "0.83.0", "node_modules", "@earendil-works", "pi-coding-agent");
mkdirSync(piPkgDir, { recursive: true });
writeFileSync(join(piPkgDir, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.83.0" }));

routes.latest.set(CLAUDE_PLATFORM_PKG, "0.3.300");
routes.latest.set(CODEX_PKG, "0.153.4");
routes.latest.set(PI_META_PKG, "0.90.0");

{
  const results = await checkRuntimeUpdates();
  const byAgent = new Map(results.map((r) => [r.agent, r]));
  assert(byAgent.get("claude")?.verdict === ("untested" satisfies RuntimeCheckVerdict), "claude latest unlisted → untested");
  assert(byAgent.get("claude")?.latestVersion === "0.3.300", "claude latest fetched fresh");
  assert(byAgent.get("codex")?.verdict === ("up-to-date" satisfies RuntimeCheckVerdict), "codex at latest → up-to-date");
  assert(
    byAgent.get("pi")?.verdict === ("blocked" satisfies RuntimeCheckVerdict) &&
      byAgent.get("pi")?.reasons.includes("compat-broken"),
    "pi latest broken → blocked with reason",
  );
  assert(byAgent.get("pi")?.compatListStale === false, "healthy compat list not flagged stale");
}
routes.compat = { body: COMPAT_B };
{
  const results = await checkRuntimeUpdates();
  assert(results.find((r) => r.agent === "claude")?.verdict === ("ok" satisfies RuntimeCheckVerdict), "claude latest listed-tested → ok");
}
{
  // Registry outage: every verdict degrades, version comparison unavailable.
  routes.registryFail = true;
  const results = await checkRuntimeUpdates();
  routes.registryFail = false;
  assert(results.every((r) => r.verdict === ("untested" satisfies RuntimeCheckVerdict)), "registry outage → untested across agents");
  assert(
    results.every((r) => r.reasons.includes("registry-unreachable")),
    "registry outage carries the machine-readable reason",
  );
  assert(results.every((r) => r.compatListStale === false), "compat list still healthy during registry outage");
}

/* ═════════ phase 3 — green pin install (wrapper paired) ═════════ */

{
  const dir = tgzFixtureDir("claude-plat-0.3.258");
  await makeBinaryFixture(join(dir, CLAUDE_BIN), true);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: CLAUDE_PLATFORM_PKG, version: "0.3.258" }));
  await packFixture("claude-plat@0.3.258", dir);

  const jsDir = tgzFixtureDir("claude-js-0.3.258");
  writeFileSync(join(jsDir, "package.json"), JSON.stringify({ name: CLAUDE_JS_PKG, version: "0.3.258" }));
  writeFileSync(join(jsDir, "sdk.mjs"), "export const query = async () => {};\n");
  writeFileSync(
    join(jsDir, "manifest.json"),
    JSON.stringify({ version: "2.1.258", sdkCompat: { testedWrapperVersions: ["0.3.227"], harnessSchema: 1 } }),
  );
  await packFixture("claude-js@0.3.258", dir !== jsDir ? jsDir : dir);

  routes.meta.set(`${CLAUDE_PLATFORM_PKG}@0.3.258`, "claude-plat@0.3.258");
  routes.meta.set(`${CLAUDE_JS_PKG}@0.3.258`, "claude-js@0.3.258");

  const res = await installRuntime("claude");
  assert(res.ok && res.version === "0.3.258", `pin install ok (got ${JSON.stringify(res)})`);
  const vDir = join(runtimesRoot, "claude", "0.3.258");
  assert(existsSync(join(vDir, CLAUDE_BIN)), "pin install places the binary");
  assert(existsSync(join(vDir, "sdk.mjs")) && existsSync(join(vDir, "manifest.json")), "wrapper paired into the same version dir");
  const record = JSON.parse(readFileSync(join(vDir, "install.json"), "utf8")) as Record<string, unknown>;
  assert(record["risk"] === "green" && !record["forced"], "pin install recorded green/not-forced");
}

/* ═════════ phase 4 — yellow versioned install, gates run and pass ═════════ */

async function stageClaude(version: string, opts: { withMarker: boolean; harnessSchema: number }): Promise<void> {
  const platKey = `claude-plat@${version}`;
  const jsKey = `claude-js@${version}`;
  const dir = tgzFixtureDir(`claude-plat-${version}`);
  await makeBinaryFixture(join(dir, CLAUDE_BIN), opts.withMarker);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: CLAUDE_PLATFORM_PKG, version }));
  await packFixture(platKey, dir);
  const jsDir = tgzFixtureDir(`claude-js-${version}`);
  writeFileSync(join(jsDir, "package.json"), JSON.stringify({ name: CLAUDE_JS_PKG, version }));
  writeFileSync(join(jsDir, "sdk.mjs"), "export const query = async () => {};\n");
  writeFileSync(
    join(jsDir, "manifest.json"),
    JSON.stringify({ version: `2.1.${version.split(".")[2]}`, sdkCompat: { testedWrapperVersions: ["0.3.227"], harnessSchema: opts.harnessSchema } }),
  );
  await packFixture(jsKey, jsDir);
  routes.meta.set(`${CLAUDE_PLATFORM_PKG}@${version}`, platKey);
  routes.meta.set(`${CLAUDE_JS_PKG}@${version}`, jsKey);
}

routes.compat = { body: COMPAT_A }; // 0.3.260 NOT listed → yellow
await stageClaude("0.3.260", { withMarker: true, harnessSchema: 1 });
{
  const res = await installRuntime("claude", "0.3.260");
  assert(res.ok && res.version === "0.3.260", `yellow install passes gates (got ${JSON.stringify(res)})`);
  const record = JSON.parse(
    readFileSync(join(runtimesRoot, "claude", "0.3.260", "install.json"), "utf8"),
  ) as Record<string, unknown>;
  assert(record["risk"] === "yellow", "yellow install recorded");
  const events = (globalThis as unknown as { __smokeEvents: Array<{ channel: string; msg: { payload?: { phase?: string; agent?: string } } }> }).__smokeEvents;
  assert(
    events.some((e) => e.msg?.payload?.phase === "verifying" && e.msg.payload.agent === "claude"),
    "verifying progress pushed while gates run",
  );
}

/* ═════════ phase 5 — keep-2 retention ═════════ */

await stageClaude("0.3.261", { withMarker: true, harnessSchema: 1 });
{
  const res = await installRuntime("claude", "0.3.261");
  assert(res.ok, "second versioned install ok");
  const versions = listManagedVersions("claude").filter((v) => !v.startsWith("."));
  assert(versions.length === 2, `keep-2 retention (got [${versions.join(", ")}])`);
  assert(versions[0] === "0.3.261" && versions[1] === "0.3.260", "newest-first order after prune");
}

/* ═════════ phase 6 — G2 marker rejection ═════════ */

await stageClaude("0.3.262", { withMarker: false, harnessSchema: 1 });
{
  const res = await installRuntime("claude", "0.3.262");
  assert(res.ok === false && res.gateBlocked === true, "marker-less binary rejected by the gate");
  assert((res.error ?? "").includes(CLAUDE_MARKER), `gate error names the missing marker (got ${res.error})`);
  const versions = listManagedVersions("claude").filter((v) => !v.startsWith("."));
  assert(versions.length === 2 && versions[0] === "0.3.261", "rejected install left existing versions untouched");
}

/* ═════════ phase 7 — G1 harness-schema rejection ═════════ */

await stageClaude("0.3.263", { withMarker: true, harnessSchema: 99 });
{
  const res = await installRuntime("claude", "0.3.263");
  assert(res.ok === false && res.gateBlocked === true, "harness-schema jump rejected by the gate");
  assert((res.error ?? "").includes("harness"), `gate error mentions the schema (got ${res.error})`);
}

/* ═════════ phase 8 — force bypasses gates, records forced ═════════ */

{
  const res = await installRuntime("claude", "0.3.262", true);
  assert(res.ok && res.version === "0.3.262", "forced install of the marker-less version succeeds");
  const record = JSON.parse(
    readFileSync(join(runtimesRoot, "claude", "0.3.262", "install.json"), "utf8"),
  ) as Record<string, unknown>;
  assert(record["forced"] === true, "forced install recorded in install.json");
  assert(listManagedVersions("claude").filter((v) => !v.startsWith(".")).length === 2, "keep-2 after forced install (0.3.262 + 0.3.261)");
}

/* ═════════ phase 9 — rollback ═════════ */

{
  const before = (await listRuntimes()).find((r) => r.agent === "claude");
  assert(before?.previousVersion === "0.3.261", "previousVersion exposes the rollback ladder");
  const res = await rollbackRuntime("claude");
  assert(res.ok && res.rolledBackTo === "0.3.261", `rollback falls back to the runner-up (got ${JSON.stringify(res)})`);
  assert(!existsSync(join(runtimesRoot, "claude", "0.3.262")), "rollback deleted the newest version dir");
  const state = (await listRuntimes()).find((r) => r.agent === "claude");
  assert(state?.activeVersion === "0.3.261", "listRuntimes reports the rolled-back version as active");
  assert(state?.previousVersion === null, "ladder exhausted after rollback (single version left)");
}

/* ═════════ phase 10 — per-version remove ═════════ */

{
  const bad = await removeRuntime("claude", "0.3.999");
  assert(bad.ok === false, "removing an unknown version is rejected");
  const ok = await removeRuntime("claude", "0.3.261");
  assert(ok.ok === true, "removing a known version succeeds");
  assert(!existsSync(join(runtimesRoot, "claude", "0.3.261")), "removed version dir is gone");
}

/* ═════════ phase 11 — codex vendored-layout install ═════════ */

{
  const dir = tgzFixtureDir("codex-plat");
  const binDir = join(dir, "vendor", triple, "bin");
  mkdirSync(binDir, { recursive: true });
  await makeBinaryFixture(join(binDir, CODEX_BIN), false);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: CODEX_PKG, version: `0.153.4-${plat}` }));
  await packFixture("codex-plat@0.153.4", dir);
  routes.meta.set(`${CODEX_PKG}@0.153.4-${plat}`, "codex-plat@0.153.4");

  const res = await installRuntime("codex");
  assert(res.ok && res.version === "0.153.4", `codex pin install ok (got ${JSON.stringify(res)})`);
  assert(existsSync(join(runtimesRoot, "codex", "0.153.4", "vendor", triple, "bin", CODEX_BIN)), "codex vendored layout placed");
}

/* ═════════ phase 12 — pi meta-package through the import gate ═════════ */

{
  const key = "pi-meta@0.89.0";
  const dir = tgzFixtureDir("pi-0.89.0");
  const pkg = join(dir, "node_modules", "@earendil-works", "pi-coding-agent");
  mkdirSync(join(pkg, "dist"), { recursive: true });
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.89.0", exports: { ".": "./dist/index.js" } }),
  );
  writeFileSync(join(pkg, "dist", "index.js"), "export function createAgentSession() { return {}; }\n");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: PI_META_PKG, version: "0.89.0" }));
  await packFixture(key, dir);
  routes.meta.set(`${PI_META_PKG}@0.89.0`, key);

  // 0.89.0 is unlisted → yellow → the gate imports the staged entry.
  const res = await installRuntime("pi", "0.89.0");
  assert(res.ok && res.version === "0.89.0", `pi yellow install passes the import gate (got ${JSON.stringify(res)})`);

  // 0.90.0 is compat-list BROKEN: refused up front (before any download)
  // unless forced; force skips the gates entirely.
  const refused = await installRuntime("pi", "0.90.0");
  assert(
    refused.ok === false && refused.gateBlocked === true && (refused.error ?? "").includes("known-broken"),
    `broken version refused without force (got ${JSON.stringify(refused)})`,
  );
  const metaKey = "pi-meta@0.90.0";
  const dir90 = tgzFixtureDir("pi-0.90.0");
  const pkg90 = join(dir90, "node_modules", "@earendil-works", "pi-coding-agent");
  mkdirSync(join(pkg90, "dist"), { recursive: true });
  writeFileSync(
    join(pkg90, "package.json"),
    JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.90.0", exports: { ".": "./dist/index.js" } }),
  );
  writeFileSync(join(pkg90, "dist", "index.js"), "export function createAgentSession() { return {}; }\n");
  writeFileSync(join(dir90, "package.json"), JSON.stringify({ name: PI_META_PKG, version: "0.90.0" }));
  await packFixture(metaKey, dir90);
  routes.meta.set(`${PI_META_PKG}@0.90.0`, metaKey);
  const forced = await installRuntime("pi", "0.90.0", true);
  assert(forced.ok && forced.version === "0.90.0", "broken version force-installs past the refusal");
  const forcedRecord = JSON.parse(
    readFileSync(join(runtimesRoot, "pi", "0.90.0", "install.json"), "utf8"),
  ) as Record<string, unknown>;
  assert(forcedRecord["forced"] === true && forcedRecord["risk"] === "red", "forced red install recorded");
}

/* ═════════ phase 13 — updateAvailable semantics + final verdict sweep ═════════ */

{
  // Phase 10 removed the last claude dir — reinstall a versioned copy so the
  // sweep below has an active claude runtime to reason about.
  const reinstall = await installRuntime("claude", "0.3.261");
  assert(reinstall.ok, "claude reinstalled for the final sweep");

  const results = await checkRuntimeUpdates();
  const byAgent = new Map(results.map((r) => [r.agent, r]));
  // pi was force-moved onto 0.90.0, which IS the upstream latest — an active
  // version that is compat-list broken surfaces as blocked (red), NOT
  // up-to-date; the banner then points at rollback instead of force-install.
  assert(byAgent.get("pi")?.verdict === ("blocked" satisfies RuntimeCheckVerdict), "active version compat-broken and on the latest → blocked");
  assert(
    byAgent.get("pi")?.reasons.includes("active-version-broken") === true &&
      byAgent.get("pi")?.reasons.some((r) => r.startsWith("broken:")) === true,
    "active-broken verdict carries the machine reasons",
  );
  assert(byAgent.get("claude")?.verdict === ("untested" satisfies RuntimeCheckVerdict), "claude 0.3.261 vs latest 0.3.300 → untested");

  const states = await listRuntimes();
  const claudeState = states.find((r) => r.agent === "claude");
  const piState = states.find((r) => r.agent === "pi");
  assert(claudeState?.updateAvailable === true, "claude stale-vs-pin shows updateAvailable");
  // User already moved to the upstream latest → the pin-stale badge must NOT show.
  routes.latest.set(CLAUDE_PLATFORM_PKG, "0.3.261");
  await checkRuntimeUpdates();
  const states2 = await listRuntimes();
  assert(
    states2.find((r) => r.agent === "claude")?.updateAvailable === false,
    "being on the upstream latest suppresses the stale-vs-pin badge",
  );
  assert(piState?.installed === true, "pi managed install visible in listRuntimes");
}

/* ═════════ phase 14 — pi latest falls back to the upstream package ═════════ */

{
  // @mcode/runtime-pi unpublished (the real-world state as of 2026-09): the
  // upstream package's dist-tag is the honest new-version signal.
  routes.latest.delete(PI_META_PKG);
  routes.latest.set(UPSTREAM_PI_PKG, "0.87.1");
  const results = await checkRuntimeUpdates();
  const pi = results.find((r) => r.agent === "pi");
  assert(pi?.latestVersion === "0.87.1", "pi latest falls back to the upstream package when the meta package is unpublished");
  // pi sits on the force-installed 0.90.0 — ahead of the upstream 0.87.1, and
  // 0.90.0 is itself compat-list broken → up-to-date flips to blocked.
  assert(pi?.verdict === ("blocked" satisfies RuntimeCheckVerdict), "pi 0.90.0 ahead of upstream 0.87.1 + active broken → blocked");
}
{
  // A broken ACTIVE version never hides a newer release: the normal
  // latest-based verdict stands (upgrading out is the best guidance) — only
  // the reasons are annotated for the UI/log layer.
  routes.latest.set(UPSTREAM_PI_PKG, "0.91.0");
  const results = await checkRuntimeUpdates();
  const pi = results.find((r) => r.agent === "pi");
  assert(pi?.verdict === ("untested" satisfies RuntimeCheckVerdict), "newer upstream exists → normal untested verdict wins over active-broken");
  assert(
    pi?.reasons.includes("active-version-broken") === true,
    "active-broken still recorded in reasons",
  );
  routes.latest.set(UPSTREAM_PI_PKG, "0.87.1");
}
{
  // Every source answered 404 → "missing" (a publishing gap), NOT
  // "unreachable" (network) — the UI words these differently.
  routes.latest.delete(UPSTREAM_PI_PKG);
  const results = await checkRuntimeUpdates();
  const pi = results.find((r) => r.agent === "pi");
  assert(pi?.verdict === ("untested" satisfies RuntimeCheckVerdict), "no source → untested");
  assert(
    pi?.reasons.includes("registry-missing") && !pi.reasons.includes("registry-unreachable"),
    "all sources 404 → registry-missing",
  );
}

/* ── done ── */

console.log(`runtime-update-smoke: ${passed} assertions passed`);
