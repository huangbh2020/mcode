/**
 * Download-on-demand installer for the agent runtimes (claude / codex / pi).
 *
 * The big native payloads (claude.exe ~209MB, codex vendor tree ~378MB) and
 * the pi JS library with its dependency tree (~44MB) are NOT shipped inside
 * the installer — they are downloaded from the npm registry on demand and
 * unpacked under `<userData>/runtimes/<agent>/<version>/`. The resolvers
 * (sdkBinaryPath / codexBinaryResolve / piSdkLoader) look there FIRST, so a
 * successful install is immediately visible to the providers; a missing
 * runtime surfaces as a friendly "not installed" error that points at the
 * settings panel.
 *
 * Sources (same artifacts `npm install` would fetch — no new trust origin):
 *  - claude: @anthropic-ai/claude-agent-sdk-<platform>-<arch>@<version>
 *      (dep-free tarball, binary at package root: claude[.exe]) PLUS the
 *      matching JS wrapper @anthropic-ai/claude-agent-sdk@<version> extracted
 *      into the SAME version dir — wrapper and CLI are version-locked
 *      upstream, and sdkLoader loads the managed wrapper so the pair always
 *      updates together (docs/agent-runtime-update.md §6);
 *  - codex:  @openai/codex@<version>-<platform>
 *      (dep-free tarball, binary under vendor/<triple>/bin/codex[.exe])
 *  - pi:     @mcode/runtime-pi@<version>
 *      (Mcode's own preassembled meta-package — the pnpm-resolved pi
 *      dependency closure in a flat node_modules layout, packed by
 *      build/pack-pi-runtime.cjs; the version tracks the pinned
 *      @earendil-works/pi-coding-agent in package.json). Until that package
 *      is published, a registry miss falls back to assembling the SAME
 *      closure locally with npm (assemblePiClosureWithNpm).
 *
 * Every install is atomic: download to a temp file (sha512-verified against
 * the registry's dist.integrity), extract into a staging dir, run the
 * compatibility gates for non-green targets (wrapper pairing metadata /
 * binary protocol markers / launch probe — see runCompatGates), verify the
 * expected payload exists, then rename into place. The two newest versions
 * are kept (KEEP_VERSIONS) so a bad update can be rolled back by deleting
 * the newest dir (rollbackRuntime); older ones are pruned.
 * Progress is pushed to the renderer over `runtimes:event`.
 *
 * Install targets: installRuntime() without a version installs the app's
 * pinned version (historical behavior); with `version` it installs THAT
 * upstream release — the "check for updates → update to latest" path.
 * Version risk is classified against Mcode's compat list
 * (runtimeCompat.ts): green (pinned or human-tested) skips the gates,
 * yellow (unlisted) / red (known-broken) run them; `force` bypasses the
 * gates for either (never the sha512 check) and is recorded in install.json.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { app } from "electron";
import {
  IPC,
  type RuntimeAgentId,
  type RuntimeAgentState,
  type RuntimeCheckResult,
  type RuntimeCheckVerdict,
  type RuntimeProgressPayload,
} from "@contracts/ipc";
import { sendToRenderer } from "@main/window.js";
import { log } from "@main/lib/logger.js";
import { compareVersions, getManagedRuntimeRoot, listManagedVersions } from "./managedRuntimeRoots.js";
import { codexVendorTriple, findCodexBinaryInPackage } from "@main/providers/codex-sdk/codexBinaryResolve.js";
import { polyfillWorkerThreads } from "@main/providers/pi-sdk/piSdkLoader.js";
import { classifyVersion, loadCompatList } from "./runtimeCompat.js";
import {
  installedManagedPayload,
  payloadEntryPath,
  probeRuntimeAvailability,
  type RuntimeSource,
} from "./runtimeAvailability.js";

/** Used when this app's package.json can't be read (shouldn't happen — it
 *  ships inside the asar and exists in dev). Keep in sync with package.json. */
const FALLBACK_VERSIONS: Record<RuntimeAgentId, string> = {
  claude: "0.3.258",
  codex: "0.153.4",
  pi: "0.83.0",
};

/** The claude JS wrapper package — installed PAIRED with the platform
 *  binary into the same version dir (see module docblock). */
const CLAUDE_JS_SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

/** Managed version dirs kept per agent: the active one + the previous one as
 *  the rollback target. A stale 200-400MB copy is the price of a one-click
 *  rollback; users can free it via per-version remove. */
const KEEP_VERSIONS = 2;

/** npmmirror first (CN-friendly, same metadata + integrity as official);
 *  official registry as the fallback. */
const REGISTRIES = ["https://registry.npmmirror.com", "https://registry.npmjs.org"] as const;

const META_TIMEOUT_MS = 15_000;
const LATEST_TIMEOUT_MS = 6_000;
const LATEST_TTL_MS = 10 * 60_000;
const DISK_TTL_MS = 30_000;
const PROGRESS_EMIT_INTERVAL_MS = 150;
/** Safety cap for the local `npm install` pi assembly (140-package closure on
 *  a slow mirror can take minutes; a hung npm must not wedge the panel's
 *  installing state forever). */
const PI_NPM_ASSEMBLE_TIMEOUT_MS = 10 * 60_000;

/* ── expected versions (from this app's package.json) ── */

let expectedVersions: Record<RuntimeAgentId, string> | null = null;

function loadExpectedVersions(): Record<RuntimeAgentId, string> {
  if (expectedVersions) return expectedVersions;
  const out: Record<RuntimeAgentId, string> = { ...FALLBACK_VERSIONS };
  try {
    const raw = readFileSync(join(app.getAppPath(), "package.json"), "utf8");
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    // Strip range prefixes (^ ~ >=) — package.json pins exact versions for
    // all three, but be defensive.
    const pin = (name: string, key: RuntimeAgentId) => {
      const v = deps[name];
      if (typeof v === "string" && v.length > 0) out[key] = v.replace(/^[\^~>=<\s]+/, "");
    };
    pin(CLAUDE_JS_SDK_PACKAGE, "claude");
    pin("@openai/codex", "codex");
    pin("@earendil-works/pi-coding-agent", "pi");
  } catch {
    // keep fallbacks
  }
  expectedVersions = out;
  return out;
}

/** The npm package + exact version to download for one agent. */
function npmPackageFor(agent: RuntimeAgentId, version: string): { name: string; version: string } {
  const plat = `${process.platform}-${process.arch}`;
  switch (agent) {
    case "claude":
      return { name: `@anthropic-ai/claude-agent-sdk-${plat}`, version };
    case "codex":
      // Platform builds are published as versions of the SAME package:
      // @openai/codex@0.153.4-win32-x64 (the wrapper's optionalDependencies
      // alias these). See codexBinaryResolve.ts for the layout.
      return { name: "@openai/codex", version: `${version}-${plat}` };
    case "pi":
      return { name: "@mcode/runtime-pi", version };
  }
}

/** The package whose "latest" dist-tag reflects the upstream version for an
 *  agent. For codex this is the wrapper (its latest is the bare semver, while
 *  platform builds carry `<semver>-<plat>` versions). */
function latestCheckPackageFor(agent: RuntimeAgentId): string {
  switch (agent) {
    case "claude":
      return `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
    case "codex":
      return "@openai/codex";
    case "pi":
      return "@mcode/runtime-pi";
  }
}

/* ── payload layouts (what a good extraction must contain) ──
 *  payloadEntryPath / installedManagedPayload live in runtimeAvailability.ts
 *  so the settings panel can probe the SAME layout definition. */

/* ── module state ── */

const installing = new Map<RuntimeAgentId, boolean>();
const lastErrors = new Map<RuntimeAgentId, string>();
const latestCache = new Map<RuntimeAgentId, { version: string | null; at: number }>();
const diskCache = new Map<string, { bytes: number; at: number }>();

function emitProgress(
  agent: RuntimeAgentId,
  phase: RuntimeProgressPayload["phase"],
  progress: number,
  error?: string,
): void {
  const payload: RuntimeProgressPayload = { agent, phase, progress };
  if (error) payload.error = error;
  try {
    sendToRenderer(IPC.RUNTIMES_EVENT, { channel: IPC.RUNTIMES_EVENT, payload });
  } catch {
    // no window yet — progress is best-effort
  }
}

/* ── registry access ── */

function registryPath(name: string): string {
  return name.replace("/", "%2F");
}

async function fetchPackageMeta(
  name: string,
  version: string,
): Promise<{ tarballUrl: string; integrity: string } | null> {
  for (const reg of REGISTRIES) {
    try {
      const res = await fetch(`${reg}/${registryPath(name)}/${version}`, {
        signal: AbortSignal.timeout(META_TIMEOUT_MS),
      });
      if (!res.ok) continue;
      const manifest = (await res.json()) as {
        dist?: { tarball?: string; integrity?: string };
      };
      if (!manifest.dist?.tarball) continue;
      return { tarballUrl: manifest.dist.tarball, integrity: manifest.dist.integrity ?? "" };
    } catch {
      continue;
    }
  }
  return null;
}

/** Best-effort "latest" lookup. Tries each candidate package on both
 *  registries; `missing` distinguishes "registries answered, no such package"
 *  (a publishing gap, e.g. @mcode/runtime-pi before its first release) from
 *  "couldn't reach the registries at all" (offline / GFW) — the UI words
 *  these differently. */
interface LatestLookup {
  version: string | null;
  missing: boolean;
}

/** Fallback "latest" sources for agents whose primary package may not exist
 *  yet: the upstream package is the honest new-version signal, and installing
 *  an upstream pi version works via the local npm-assembly fallback. */
const LATEST_FALLBACK_PACKAGES: Partial<Record<RuntimeAgentId, string>> = {
  pi: "@earendil-works/pi-coding-agent",
};

async function fetchLatestVersion(agent: RuntimeAgentId): Promise<LatestLookup> {
  const fallback = LATEST_FALLBACK_PACKAGES[agent];
  const candidates = fallback ? [latestCheckPackageFor(agent), fallback] : [latestCheckPackageFor(agent)];
  // "missing" requires every HTTP answer to have been a definitive 404 —
  // 5xx/timeouts are registry trouble, not a publishing gap.
  const statuses: number[] = [];
  for (const name of candidates) {
    for (const reg of REGISTRIES) {
      try {
        const res = await fetch(`${reg}/${registryPath(name)}/latest`, {
          signal: AbortSignal.timeout(LATEST_TIMEOUT_MS),
        });
        statuses.push(res.status);
        if (!res.ok) continue;
        const manifest = (await res.json()) as { version?: string };
        if (typeof manifest.version === "string" && manifest.version) {
          return { version: manifest.version, missing: false };
        }
      } catch {
        continue;
      }
    }
  }
  return { version: null, missing: statuses.length > 0 && statuses.every((s) => s === 404) };
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return await Promise.race([
    p.catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

/* ── download + extract ── */

async function downloadVerifiedTarball(
  agent: RuntimeAgentId,
  meta: { tarballUrl: string; integrity: string },
): Promise<string> {
  if (!meta.integrity) {
    throw new Error("registry metadata has no dist.integrity — refusing to install an unverifiable artifact");
  }
  const res = await fetch(meta.tarballUrl, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`tarball download failed: HTTP ${res.status} for ${meta.tarballUrl}`);
  }
  const total = Number(res.headers.get("content-length") ?? 0);
  const hash = createHash("sha512");
  const tmpFile = join(tmpdir(), `mcode-runtime-${agent}-${Date.now()}.tgz`);
  let received = 0;
  let lastEmit = 0;
  try {
    await pipeline(
      Readable.fromWeb(res.body as unknown as NodeWebReadableStream),
      async function* (source: AsyncIterable<Uint8Array>) {
        for await (const chunk of source) {
          hash.update(chunk);
          received += chunk.byteLength;
          const now = Date.now();
          if (total > 0 && now - lastEmit > PROGRESS_EMIT_INTERVAL_MS) {
            lastEmit = now;
            emitProgress(agent, "downloading", Math.min(received / total, 1));
          }
          yield chunk;
        }
      },
      createWriteStream(tmpFile),
    );
  } catch (err) {
    rmSync(tmpFile, { force: true });
    throw new Error(
      `tarball download failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const computed = `sha512-${hash.digest("base64")}`;
  if (computed !== meta.integrity) {
    rmSync(tmpFile, { force: true });
    throw new Error(`sha512 mismatch for ${meta.tarballUrl} (expected ${meta.integrity}, got ${computed})`);
  }
  return tmpFile;
}

/* ── install-time compatibility gates (docs/agent-runtime-update.md §4.3) ──
 *
 * Green targets (the app's pinned version, or one the compat list marks
 * human-tested) skip all of this — a regression pass already covered them.
 * Yellow (unlisted) / red (known-broken) targets run, in order:
 *   G1 wrapper pairing metadata (claude) — the JS wrapper ships in the same
 *      version dir as the binary; the gate requires its manifest.json and
 *      that the harness schema didn't jump. Upstream's
 *      sdkCompat.testedWrapperVersions names only PRIOR compatible wrappers
 *      (0.3.258's list stops at 0.3.227, excluding itself), so the lock-step
 *      pair (wrapper v + CLI from package v) passes by construction.
 *   G2 binary marker scan — protocol strings Mcode's approval UI depends on
 *      must still be present in the new binary (chunked streaming search;
 *      never loads the 200MB file into memory).
 *   G3 launch probe — the new payload must actually launch. claude/codex:
 *      `--version` (deterministic, no auth and no token cost — a full
 *      system/init smoke would run a model query on credentialed machines);
 *      pi: import the entry and check the driver export.
 * force=true skips G1-G3 entirely (the sha512 integrity check is never
 * skipped); the skip is recorded in install.json. */

type InstallRisk = "green" | "yellow" | "red";

function riskClassFor(agent: RuntimeAgentId, version: string, compatList: Awaited<ReturnType<typeof loadCompatList>>["list"]): { risk: InstallRisk; note?: string } {
  // The pinned version ships with (and was packaged against) this app build.
  if (version === loadExpectedVersions()[agent]) return { risk: "green" };
  const cls = classifyVersion(compatList, agent, version);
  if (cls === "tested") return { risk: "green" };
  if (cls.startsWith("broken:")) return { risk: "red", note: cls.slice("broken:".length) };
  return { risk: "yellow" };
}
/** Chunked streaming substring search over a big binary — ~200MB never
 *  enters memory; a marker crossing a chunk boundary is covered by the
 *  carry-overlap. claude.exe is a bun single-file executable whose JS
 *  payload is plaintext (the AGENTS.md upgrade checklist greps it with
 *  plain `grep`), so a plain utf8 substring scan is meaningful. */
function binaryContainsMarker(filePath: string, marker: string): boolean {
  let fd: number;
  try {
    fd = openSync(filePath, "r");
  } catch {
    return false;
  }
  const CHUNK = 1 << 20;
  const overlap = marker.length * 2 + 64;
  try {
    let carry: Buffer = Buffer.alloc(0);
    const buf = Buffer.alloc(CHUNK);
    for (;;) {
      const bytes = readSync(fd, buf, 0, CHUNK, null);
      if (bytes <= 0) return false;
      const haystack =
        carry.length > 0 ? Buffer.concat([carry, buf.subarray(0, bytes)]) : buf.subarray(0, bytes);
      if (haystack.indexOf(marker) !== -1) return true;
      carry = Buffer.from(haystack.subarray(Math.max(0, haystack.length - overlap)));
    }
  } finally {
    closeSync(fd);
  }
}

/** Run a launch probe (`--version`) with a hard timeout. Resolves with
 *  ok=false on non-zero exit / spawn error / timeout — never rejects. */
function execLaunchProbe(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ ok: boolean; timedOut: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const append = (chunk: Buffer | string): void => {
      if (output.length < 8_192) output += chunk.toString();
    };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, timedOut: false, output: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, timedOut, output: output.trim().slice(0, 500) });
    });
  });
}

const GATE_PROBE_TIMEOUT_MS = 20_000;
const CURRENT_HARNESS_SCHEMA = 1;

/** Protocol strings Mcode depends on, per binary. claude: the ExitPlanMode
 *  dialog kind — upstream renaming it silently kills plan approval (the
 *  AGENTS.md upgrade checklist greps exactly this). codex: none yet. */
const BINARY_GATE_MARKERS: Record<"claude" | "codex", string[]> = {
  claude: ["permission_exit_plan_mode_v2"],
  codex: [],
};

interface SdkManifestShape {
  version?: unknown;
  sdkCompat?: { testedWrapperVersions?: unknown; harnessSchema?: unknown } | null;
}

/** G1 — the paired wrapper's manifest must exist and speak our harness
 *  schema. Runs against the STAGING copy, so a failure here aborts before
 *  anything is placed. */
function gateClaudeWrapperPairing(stagingDir: string, targetVersion: string): void {
  let manifest: SdkManifestShape;
  try {
    manifest = JSON.parse(readFileSync(join(stagingDir, "manifest.json"), "utf8")) as SdkManifestShape;
  } catch {
    throw new Error(
      "claude JS wrapper manifest.json is missing or unreadable in the downloaded package — wrapper/binary pairing unverified",
    );
  }
  const harness = manifest.sdkCompat?.harnessSchema;
  if (typeof harness === "number" && harness !== CURRENT_HARNESS_SCHEMA) {
    throw new Error(
      `claude wrapper harness schema jumped (${String(harness)} ≠ ${CURRENT_HARNESS_SCHEMA}) — this Mcode build predates the new wrapper contract; update the app first`,
    );
  }
  log.info(
    `runtime gate: claude ${targetVersion} wrapper pairing ok (bundled cli ${typeof manifest.version === "string" ? manifest.version : "?"})`,
  );
}

/** G3 for pi — import the staged entry and check the driver export exists.
 *  Uses the staging path directly; ESM imports can't be unloaded, but the
 *  module cache holding a staging-path entry after a failed install is
 *  harmless (staging is deleted; nothing references it again). */
async function gateProbePiEntry(stagingDir: string): Promise<void> {
  const pkgJsonPath = payloadEntryPath("pi", stagingDir);
  if (!pkgJsonPath || !existsSync(pkgJsonPath)) {
    throw new Error("pi package.json missing from the extracted payload");
  }
  polyfillWorkerThreads();
  const pkgDir = dirname(pkgJsonPath);
  const mod = (await import(pathToFileURL(join(pkgDir, "dist", "index.js")).href)) as Record<
    string,
    unknown
  >;
  if (typeof mod["createAgentSession"] !== "function") {
    throw new Error("pi entry loaded but createAgentSession export is missing — upstream layout changed?");
  }
}

/** Run all gates for one agent against its staging dir. Returns a structured
 *  failure (never throws) so the caller can surface gateBlocked cleanly. */
async function runCompatGates(
  agent: RuntimeAgentId,
  stagingDir: string,
  targetVersion: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    if (agent === "claude") {
      gateClaudeWrapperPairing(stagingDir, targetVersion);
      const entry = payloadEntryPath(agent, stagingDir);
      if (!entry || !existsSync(entry)) throw new Error("claude binary missing from the extracted payload");
      for (const marker of BINARY_GATE_MARKERS.claude) {
        if (!binaryContainsMarker(entry, marker)) {
          throw new Error(
            `new claude binary lacks the "${marker}" protocol marker — upstream renamed a dialog kind and Mcode's approval UI would break`,
          );
        }
      }
      const probe = await execLaunchProbe(entry, ["--version"], GATE_PROBE_TIMEOUT_MS);
      if (!probe.ok) {
        throw new Error(
          probe.timedOut
            ? "claude --version probe timed out — the new binary does not launch cleanly"
            : `claude --version probe failed (exit ${String(probe.output)}): ${probe.output}`,
        );
      }
      log.info(`runtime gate: claude ${targetVersion} launch probe ok (${probe.output})`);
    } else if (agent === "codex") {
      const entry = findCodexBinaryInPackage(stagingDir);
      if (!entry) throw new Error("codex binary missing from the extracted package");
      for (const marker of BINARY_GATE_MARKERS.codex) {
        if (!binaryContainsMarker(entry, marker)) {
          throw new Error(`new codex binary lacks the "${marker}" protocol marker`);
        }
      }
      const probe = await execLaunchProbe(entry, ["--version"], GATE_PROBE_TIMEOUT_MS);
      if (!probe.ok) {
        throw new Error(
          probe.timedOut
            ? "codex --version probe timed out — the new binary does not launch cleanly"
            : `codex --version probe failed: ${probe.output}`,
        );
      }
      log.info(`runtime gate: codex ${targetVersion} launch probe ok (${probe.output})`);
    } else {
      await gateProbePiEntry(stagingDir);
      log.info(`runtime gate: pi ${targetVersion} entry import ok`);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/* ── disk helpers ── */

/** Windows transiently fails the placement mutations (rm/rename) right after
 *  a big extraction: antivirus holds handles on the freshly-written
 *  claude.exe while it scans it (Defender, and CN AVs especially), and the
 *  search indexer may touch the new directory. The running-turn guard rules
 *  out our own consumers, so a short async backoff ladder rides the scan out
 *  (~4s worst case, never blocking the main process); after the last attempt
 *  the error propagates and the caller reports a failed install with the old
 *  version untouched. */
const RETRYABLE_FS_CODES = new Set(["EPERM", "EBUSY", "EACCES", "ENOTEMPTY", "EEXIST"]);

async function withFsRetry<T>(label: string, op: () => T): Promise<T> {
  const delays = [100, 250, 500, 1000, 2000];
  for (;;) {
    try {
      return op();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (!RETRYABLE_FS_CODES.has(code) || delays.length === 0) throw err;
      const delay = delays.shift()!;
      log.warn(
        `runtime install: ${label} hit ${code} — retrying in ${delay}ms (antivirus/indexer commonly locks freshly extracted binaries on Windows)`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/** Assemble the pi dependency closure LOCALLY with npm — the fallback for
 *  when `@mcode/runtime-pi` isn't on the registry yet (pre-publish window /
 *  mirror lag). Identical recipe to build/pack-pi-runtime.cjs: a real npm
 *  install hoists the closure into `<stagingDir>/node_modules` (npm verifies
 *  each package's integrity itself; --ignore-scripts keeps it hermetic — no
 *  postinstall of any transitive dep runs). Produces exactly the layout
 *  `payloadEntryPath("pi", ...)` asserts. */
async function assemblePiClosureWithNpm(stagingDir: string, version: string): Promise<void> {
  writeFileSync(
    join(stagingDir, "package.json"),
    JSON.stringify({ name: "@mcode/runtime-pi", version, private: true }, null, 2) + "\n",
  );
  await new Promise<void>((resolve, reject) => {
    // win32: npm is npm.cmd, and Node >= 18.20 refuses to spawn .cmd without
    // a shell (CVE-2024-27980).
    const child = spawn(
      "npm",
      [
        "install",
        `@earendil-works/pi-coding-agent@${version}`,
        "--ignore-scripts",
        "--omit=dev",
        "--no-audit",
        "--no-fund",
        "--loglevel=error",
        "--no-save",
      ],
      { cwd: stagingDir, shell: process.platform === "win32", stdio: ["ignore", "pipe", "pipe"] },
    );
    // Keep only the tail — npm error context lives at the end, and a garbled
    // CN codepage flood shouldn't grow this without bound.
    let output = "";
    const append = (chunk: Buffer | string): void => {
      output += chunk.toString();
      if (output.length > 8_000) output = output.slice(-8_000);
    };
    const killTimer = setTimeout(() => child.kill(), PI_NPM_ASSEMBLE_TIMEOUT_MS);
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (err) => {
      clearTimeout(killTimer);
      reject(new Error(`npm spawn failed: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(killTimer);
      if (code === 0) {
        resolve();
        return;
      }
      const tail = output.trim().split("\n").slice(-4).join(" | ");
      reject(new Error(`npm install exited ${code ?? "abnormally"}${tail ? `: ${tail}` : ""}`));
    });
  });
}

function dirSize(dir: string): number {
  let total = 0;
  const walk = (p: string): void => {
    let st;
    try {
      st = statSync(p);
    } catch {
      return;
    }
    if (!st.isDirectory()) {
      total += st.size;
      return;
    }
    let entries: string[];
    try {
      entries = readdirSync(p);
    } catch {
      return;
    }
    for (const entry of entries) walk(join(p, entry));
  };
  walk(dir);
  return total;
}

function dirSizeCached(dir: string): number {
  const cached = diskCache.get(dir);
  if (cached && Date.now() - cached.at < DISK_TTL_MS) return cached.bytes;
  const bytes = dirSize(dir);
  diskCache.set(dir, { bytes, at: Date.now() });
  return bytes;
}

/* ── public API ── */

export function isRuntimeInstalling(agent: RuntimeAgentId): boolean {
  return installing.get(agent) ?? false;
}

export async function listRuntimes(): Promise<RuntimeAgentState[]> {
  const expected = loadExpectedVersions();
  const agents: RuntimeAgentId[] = ["claude", "codex", "pi"];
  // Best-effort latest-version refresh (bounded so an offline panel still
  // paints immediately).
  await Promise.all(
    agents.map(async (agent) => {
      const cached = latestCache.get(agent);
      if (cached && Date.now() - cached.at < LATEST_TTL_MS) return;
      const lookup = await withTimeout(fetchLatestVersion(agent), LATEST_TIMEOUT_MS + 2_000);
      latestCache.set(agent, { version: lookup?.version ?? null, at: Date.now() });
    }),
  );
  return agents.map((agent) => {
    const managed = installedManagedPayload(agent);
    const installedVersion = managed?.version ?? null;
    const allManaged = listManagedVersions(agent);
    const previousVersion = allManaged.length >= 2 ? normalizeInstalledVersion(agent, allManaged[1]) : null;
    // Effective source: managed first, else the fallback the resolvers would
    // use (dev node_modules / legacy bundled). The panel displays THIS — a
    // dev checkout must not read "not installed" while every agent works.
    const fallback = managed ? null : probeRuntimeAvailability(agent);
    const activeVersion = managed?.version ?? fallback?.version ?? null;
    const source: RuntimeSource | null = managed
      ? "managed"
      : fallback
        ? fallback.source
        : null;
    const latest = latestCache.get(agent)?.version ?? null;
    return {
      agent,
      expectedVersion: expected[agent],
      installedVersion,
      previousVersion,
      source,
      activeVersion,
      activePath: managed?.entry ?? fallback?.path ?? null,
      latestVersion: latest,
      installed: managed !== null,
      // Stale vs this build's pin — unless the user already moved to the
      // upstream latest (a manual "update to latest" must not leave a
      // permanent "update available" badge). Offline (latest null) degrades
      // to the historical pin comparison.
      updateAvailable:
        activeVersion !== null && activeVersion !== expected[agent] && activeVersion !== latest,
      installing: installing.get(agent) ?? false,
      lastError: lastErrors.get(agent) ?? "",
      diskBytes: managed ? dirSizeCached(managed.dir) : 0,
      installPath: managed?.entry ?? null,
    };
  });
}

/** Shared tail of both install paths: verify the extracted payload, fix
 *  binary permissions, atomically move staging into place, write the install
 *  record and prune older versions (keeping KEEP_VERSIONS newest as the
 *  rollback ladder). Throws on layout mismatch; on success the caller must
 *  NOT clean up stagingDir anymore (it was renamed). */
async function finalizeInstall(
  agent: RuntimeAgentId,
  stagingDir: string,
  version: string,
  record: {
    npmName?: string;
    source: "registry" | "local-path";
    localPath?: string;
    risk?: InstallRisk;
    riskNote?: string;
    forced?: boolean;
  },
): Promise<{ finalDir: string; entry: string }> {
  const entry = payloadEntryPath(agent, stagingDir);
  if (!entry || !existsSync(entry)) {
    throw new Error(`extracted archive but the expected payload is missing — wrong package for "${agent}", or the upstream layout changed?`);
  }
  if (process.platform !== "win32" && agent !== "pi") {
    // node-tar preserves the tarball's modes, but be defensive: the binary
    // must be executable for spawn.
    try {
      chmodSync(entry, 0o755);
    } catch {
      // best-effort
    }
  }
  const root = getManagedRuntimeRoot() ?? join(app.getPath("userData"), "runtimes");
  const finalDir = join(root, agent, version);
  await withFsRetry(`clear stale ${version} dir`, () => rmSync(finalDir, { recursive: true, force: true }));
  try {
    await withFsRetry(`place ${version}`, () => renameSync(stagingDir, finalDir));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "";
    if (code === "EPERM" || code === "EBUSY" || code === "EACCES") {
      throw new Error(
        `无法落位 ${agent}@${version}:新文件被短暂锁定,常见于杀毒软件/系统索引正在扫描刚解压的大体积二进制。请稍候重试安装,或将运行时目录加入杀软白名单 (place failed after retries: ${err instanceof Error ? err.message : String(err)})`,
      );
    }
    throw err;
  }
  writeFileSync(
    join(finalDir, "install.json"),
    JSON.stringify({ agent, version, installedAt: new Date().toISOString(), ...record }, null, 2),
  );
  // Keep the newest KEEP_VERSIONS dirs — the runner-up is the rollback
  // target; anything older is dead weight. Version dirs sort before the dot
  // prefixed `.staging-` leftovers of crashed installs, so those never
  // occupy a keep slot and get reaped here.
  for (const other of listManagedVersions(agent).slice(KEEP_VERSIONS)) {
    rmSync(join(root, agent, other), { recursive: true, force: true });
  }
  return { finalDir, entry };
}

/** Version dir name for an installed runtime. The codex platform package
 *  publishes its version WITH the platform suffix (0.153.4-win32-x64) —
 *  normalize to the bare semver so updateAvailable compares against the
 *  expected version correctly. */
function normalizeInstalledVersion(agent: RuntimeAgentId, version: string): string {
  if (agent === "codex") {
    const suffix = `-${process.platform}-${process.arch}`;
    if (version.endsWith(suffix)) return version.slice(0, -suffix.length);
  }
  return version;
}

/** Read the version out of an extracted npm-shaped package root (package.json
 *  at staging root). Falls back to `fallback` when unreadable. */
function extractedVersion(stagingDir: string, fallback: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(stagingDir, "package.json"), "utf8")) as {
      version?: string;
    };
    if (typeof pkg.version === "string" && pkg.version) return pkg.version;
  } catch {
    // keep fallback
  }
  return fallback;
}

/* ── manual "check for updates" (docs/agent-runtime-update.md §4.2) ──
 * User-clicked only — never scheduled. Fresh registry lookups (bypasses the
 * list TTL cache; the fresh values are written back so listRuntimes picks
 * them up) + the compat list fetched from GitHub raw. */

export async function checkRuntimeUpdates(): Promise<RuntimeCheckResult[]> {
  const agents: RuntimeAgentId[] = ["claude", "codex", "pi"];
  const lookups = new Map<RuntimeAgentId, LatestLookup>();
  const [{ list, staleReason }] = await Promise.all([
    loadCompatList(),
    // Force-refresh latest for every agent in parallel; write back to the
    // cache regardless of success (a null overwrites a stale non-null —
    // the click asked for fresh truth, not cached comfort).
    ...agents.map(async (agent) => {
      const lookup = await withTimeout(fetchLatestVersion(agent), LATEST_TIMEOUT_MS + 2_000);
      lookups.set(agent, lookup ?? { version: null, missing: false });
      latestCache.set(agent, { version: lookup?.version ?? null, at: Date.now() });
    }),
  ]);
  return agents.map((agent) => {
    const managed = installedManagedPayload(agent);
    const fallback = managed ? null : probeRuntimeAvailability(agent);
    const activeVersion = managed?.version ?? fallback?.version ?? null;
    const latestVersion = lookups.get(agent)?.version ?? null;
    const reasons: string[] = [];
    let verdict: RuntimeCheckVerdict;
    if (activeVersion === null) {
      verdict = "not-installed";
    } else if (latestVersion === null) {
      verdict = "untested";
      // Registries answered but the package isn't published vs. couldn't
      // reach them — the UI words these differently.
      reasons.push(lookups.get(agent)?.missing ? "registry-missing" : "registry-unreachable");
    } else if (
      compareVersions(latestVersion, normalizeInstalledVersion(agent, activeVersion)) <= 0
    ) {
      verdict = "up-to-date";
    } else {
      const cls = classifyVersion(list, agent, latestVersion);
      if (cls === "tested") {
        verdict = "ok";
        reasons.push("listed-tested");
      } else if (cls.startsWith("broken:")) {
        verdict = "blocked";
        reasons.push("compat-broken", cls);
      } else {
        verdict = "untested";
        reasons.push("compat-unlisted");
      }
    }
    // The ACTIVE version itself can be compat-list broken (installed before
    // the entry landed, or force-installed). A newer release to advise always
    // wins — upgrading out of the broken version is the best guidance — so
    // the red flip only fires when the user is already sitting on the latest
    // ("up-to-date" would otherwise paint a known-broken install green).
    if (activeVersion !== null) {
      const activeCls = classifyVersion(list, agent, normalizeInstalledVersion(agent, activeVersion));
      if (activeCls.startsWith("broken:")) {
        reasons.push("active-version-broken", activeCls);
        if (verdict === "up-to-date") verdict = "blocked";
      }
    }
    if (staleReason !== null) reasons.push(`compat-list-stale:${staleReason}`);
    return {
      agent,
      activeVersion,
      latestVersion,
      verdict,
      reasons,
      compatListStale: staleReason !== null,
      checkedAt: new Date().toISOString(),
    };
  });
}

/** Download + install (or update / reinstall) one runtime. Without `version`
 *  installs the app's pinned version; with `version` installs that upstream
 *  release. Resolves when the install fully finished (or failed — check
 *  `ok`/`error`; `gateBlocked` marks a compat-gate rejection the UI may
 *  offer to force past). */
export async function installRuntime(
  agent: RuntimeAgentId,
  version?: string,
  force = false,
): Promise<{ ok: boolean; error?: string; version?: string; gateBlocked?: boolean }> {
  if (installing.get(agent)) {
    return { ok: false, error: `runtime ${agent} is already being installed` };
  }
  installing.set(agent, true);
  lastErrors.set(agent, "");
  let stagingDir: string | null = null;
  emitProgress(agent, "downloading", -1);
  try {
    const expected = loadExpectedVersions()[agent];
    const targetVersion = version ?? expected;
    // Risk classification needs the compat list only for non-pin targets —
    // an offline reinstall of the pin must not wait on the list fetch.
    let risk: InstallRisk = "green";
    let riskNote: string | undefined;
    if (targetVersion !== expected) {
      const { list } = await loadCompatList();
      const classified = riskClassFor(agent, targetVersion, list);
      risk = classified.risk;
      riskNote = classified.note;
      // Red = a HUMAN marked this version known-broken. That knowledge beats
      // any mechanical gate, so refuse up front (before any download) unless
      // the user explicitly forced past the verdict.
      if (risk === "red" && !force) {
        const msg = `${targetVersion} is marked known-broken in Mcode's compat list${riskNote ? `: ${riskNote}` : ""} — install was refused`;
        lastErrors.set(agent, msg);
        emitProgress(agent, "error", 0, msg);
        log.warn(`runtime install: refused known-broken ${agent}@${targetVersion}`);
        return { ok: false, error: msg, gateBlocked: true };
      }
    }
    const pkg = npmPackageFor(agent, targetVersion);
    const meta = await fetchPackageMeta(pkg.name, pkg.version);
    if (!meta && agent !== "pi") {
      throw new Error(
        `registry has no ${pkg.name}@${pkg.version} — check the network/mirror, or the version hasn't been published yet`,
      );
    }
    if (meta) {
      log.info(
        `runtime install: ${agent} downloading ${pkg.name}@${pkg.version}${force ? " (forced)" : ""}`,
      );
      const tmpTarball = await downloadVerifiedTarball(agent, meta);
      try {
        emitProgress(agent, "extracting", -1);
        const root = getManagedRuntimeRoot() ?? join(app.getPath("userData"), "runtimes");
        stagingDir = join(root, agent, `.${targetVersion}.staging-${Date.now()}`);
        mkdirSync(stagingDir, { recursive: true });
        const { extract } = await import("tar");
        // npm tarballs root everything under package/ — strip that prefix.
        await extract({ file: tmpTarball, cwd: stagingDir, strip: 1 });
      } finally {
        rmSync(tmpTarball, { force: true });
      }
    } else {
      // pi registry miss (@mcode/runtime-pi not published / mirror lag yet):
      // assemble the closure locally with npm instead of a prepacked tarball.
      emitProgress(agent, "downloading", -1);
      const root = getManagedRuntimeRoot() ?? join(app.getPath("userData"), "runtimes");
      stagingDir = join(root, agent, `.${targetVersion}.staging-${Date.now()}`);
      mkdirSync(stagingDir, { recursive: true });
      log.warn(
        `runtime install: registry has no ${pkg.name}@${targetVersion} — assembling pi closure locally with npm`,
      );
      try {
        await assemblePiClosureWithNpm(stagingDir, targetVersion);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(
          `registry has no ${pkg.name}@${pkg.version} and local npm assembly failed (${reason}) — ` +
            `check the network/npm, or pack locally with \`pnpm pack:pi-runtime\` and use install-from-file`,
        );
      }
    }

    // claude only: pair the JS wrapper into the SAME version dir. The
    // wrapper and the platform binary are version-locked upstream, and
    // sdkLoader prefers the managed wrapper — so wrapper and CLI always
    // update (and roll back) together.
    if (agent === "claude" && stagingDir) {
      emitProgress(agent, "downloading", -1);
      const jsMeta = await fetchPackageMeta(CLAUDE_JS_SDK_PACKAGE, targetVersion);
      if (!jsMeta) {
        throw new Error(
          `registry has no ${CLAUDE_JS_SDK_PACKAGE}@${targetVersion} — the JS wrapper must pair with the binary; nothing was changed`,
        );
      }
      const jsTarball = await downloadVerifiedTarball(agent, jsMeta);
      try {
        const { extract } = await import("tar");
        await extract({ file: jsTarball, cwd: stagingDir, strip: 1 });
      } finally {
        rmSync(jsTarball, { force: true });
      }
    }

    // Compat gates for non-green targets (unless forced). Failures keep the
    // old runtime untouched — staging is reaped by the finally below.
    if (risk !== "green" && !force && stagingDir) {
      emitProgress(agent, "verifying", -1);
      const gate = await runCompatGates(agent, stagingDir, targetVersion);
      if (!gate.ok) {
        lastErrors.set(agent, gate.error);
        emitProgress(agent, "error", 0, gate.error);
        log.warn(`runtime install: compat gate rejected ${agent}@${targetVersion}: ${gate.error}`);
        return { ok: false, error: gate.error, gateBlocked: true };
      }
    }

    const { finalDir } = await finalizeInstall(agent, stagingDir, targetVersion, {
      npmName: pkg.name,
      source: "registry",
      risk,
      ...(riskNote ? { riskNote } : {}),
      ...(force ? { forced: true } : {}),
    });
    stagingDir = null;
    lastErrors.set(agent, "");
    emitProgress(agent, "done", 1);
    log.info(`runtime installed: ${agent}@${targetVersion} -> ${finalDir}${force ? " (forced)" : ""}`);
    return { ok: true, version: targetVersion };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    lastErrors.set(agent, msg);
    emitProgress(agent, "error", 0, msg);
    log.error(`runtime install failed (${agent}): ${msg}`);
    return { ok: false, error: msg };
  } finally {
    if (stagingDir) rmSync(stagingDir, { recursive: true, force: true });
    installing.set(agent, false);
  }
}

/** Roll back one runtime to its previous managed version by deleting the
 *  NEWEST version dir — the resolvers pick the newest remaining dir, so no
 *  pointer state is needed. claude/codex take effect on the next turn (the
 *  binary is spawned per turn); pi needs an app restart (its module is
 *  cached in piSdkLoader). */
export async function rollbackRuntime(
  agent: RuntimeAgentId,
): Promise<{ ok: boolean; rolledBackTo?: string; error?: string }> {
  if (installing.get(agent)) {
    return { ok: false, error: `runtime ${agent} is being installed — wait for it to finish` };
  }
  const root = getManagedRuntimeRoot();
  if (!root) return { ok: false, error: "runtime directory not initialized yet" };
  const versions = listManagedVersions(agent);
  if (versions.length < 2) {
    return { ok: false, error: "no previous version on disk to roll back to" };
  }
  const newest = versions[0];
  const dir = join(root, agent, newest);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
  diskCache.delete(dir);
  lastErrors.set(agent, "");
  log.info(`runtime rolled back: ${agent} removed ${newest}; resolvers now fall back to ${versions[1]}`);
  return { ok: true, rolledBackTo: normalizeInstalledVersion(agent, versions[1]) };
}

/** Install a runtime from a user-picked LOCAL PATH — the escape hatch when
 *  the registry path fails (@mcode/runtime-pi unpublished, stale mirror,
 *  offline). Accepted, per agent:
 *   - claude: a directory containing claude[.exe] at its root (the platform
 *     package layout), or the binary file itself;
 *   - codex:  a directory with the vendored layout (vendor/<triple>/bin or
 *     legacy codex/), or the binary file itself (sandbox/code-mode helpers
 *     won't come along — advanced);
 *   - pi:     the packed meta-package directory (contains
 *     node_modules/@earendil-works/pi-coding-agent, i.e. what
 *     `pnpm pack:pi-runtime` stages), or the pi package dir itself;
 *   - any agent: an npm-shaped .tgz (previous install-from-file behavior).
 * The version is taken from the copied package.json when available, else the
 * expected version. No integrity check beyond the payload assertion — the
 * user hand-picked the path. */
export async function installRuntimeFromLocalPath(
  agent: RuntimeAgentId,
  localPath: string,
): Promise<{ ok: boolean; error?: string; version?: string }> {
  if (installing.get(agent)) {
    return { ok: false, error: `runtime ${agent} is already being installed` };
  }
  let st;
  try {
    st = statSync(localPath);
  } catch {
    return { ok: false, error: `path not found: ${localPath}` };
  }
  installing.set(agent, true);
  lastErrors.set(agent, "");
  let stagingDir: string | null = null;
  emitProgress(agent, "extracting", -1);
  try {
    const root = getManagedRuntimeRoot() ?? join(app.getPath("userData"), "runtimes");
    stagingDir = join(root, agent, `.local.staging-${Date.now()}`);
    mkdirSync(stagingDir, { recursive: true });

    if (st.isFile()) {
      if (/\.(tgz|tar\.gz)$/i.test(localPath)) {
        const { extract } = await import("tar");
        await extract({ file: localPath, cwd: stagingDir, strip: 1 });
      } else {
        installSingleBinary(agent, localPath, stagingDir);
      }
    } else {
      const layout = detectLocalDirLayout(agent, localPath);
      if (layout === null) {
        throw new Error(
          `该目录不包含可识别的 ${agent} 安装结构 — 请选择安装目录或 .tgz 包(no recognizable ${agent} install layout in that directory)`,
        );
      }
      if (layout === "pi-package") {
        cpSync(localPath, join(stagingDir, "node_modules", "@earendil-works", "pi-coding-agent"), {
          recursive: true,
        });
      } else {
        cpSync(localPath, stagingDir, { recursive: true });
      }
    }

    const version = normalizeInstalledVersion(
      agent,
      extractedVersion(stagingDir, loadExpectedVersions()[agent]),
    );
    const { finalDir } = await finalizeInstall(agent, stagingDir, version, {
      source: "local-path",
      localPath,
    });
    stagingDir = null;
    lastErrors.set(agent, "");
    emitProgress(agent, "done", 1);
    log.info(`runtime installed from local path: ${agent}@${version} (${localPath}) -> ${finalDir}`);
    return { ok: true, version };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    lastErrors.set(agent, msg);
    emitProgress(agent, "error", 0, msg);
    log.error(`runtime install-from-local-path failed (${agent}): ${msg}`);
    return { ok: false, error: msg };
  } finally {
    if (stagingDir) rmSync(stagingDir, { recursive: true, force: true });
    installing.set(agent, false);
  }
}

/** What a picked DIRECTORY looks like, per agent:
 *  - "package-dir": copy the whole directory into the managed version dir
 *    (claude platform package / codex vendored package / pi meta-package);
 *  - "pi-package": the pi package itself — place it under
 *    node_modules/@earendil-works/pi-coding-agent in the staging root;
 *  - null: unrecognized. */
function detectLocalDirLayout(
  agent: RuntimeAgentId,
  dir: string,
): "package-dir" | "pi-package" | null {
  if (agent === "claude") {
    return existsSync(join(dir, "claude.exe")) || existsSync(join(dir, "claude"))
      ? "package-dir"
      : null;
  }
  if (agent === "codex") {
    return findCodexBinaryInPackage(dir) ? "package-dir" : null;
  }
  // pi: the packed meta-package root (node_modules inside) ...
  if (existsSync(join(dir, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"))) {
    return "package-dir";
  }
  // ... or the pi package itself (dist/ + package.json).
  if (existsSync(join(dir, "dist", "index.js"))) {
    return "pi-package";
  }
  return null;
}

/** Place a user-picked agent BINARY into the managed layout (claude: package
 *  root; codex: vendor/<triple>/bin/). */
function installSingleBinary(agent: RuntimeAgentId, file: string, stagingDir: string): void {
  const name = basename(file);
  if (agent === "pi") {
    throw new Error("pi 是 JS 库,请选择包含 node_modules 的安装目录或 .tgz 包(pi is a JS library — pick its install directory or .tgz)");
  }
  const expectedNames =
    agent === "claude"
      ? ["claude.exe", "claude"]
      : ["codex.exe", "codex"];
  if (!expectedNames.includes(name.toLowerCase())) {
    throw new Error(
      `"${name}" 不是 ${agent} 的可执行文件(is not the ${agent} executable — expected ${expectedNames.join(" / ")})`,
    );
  }
  const dest =
    agent === "claude"
      ? join(stagingDir, name)
      : join(stagingDir, "vendor", codexVendorTriple() ?? "unknown-triple", "bin", name);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(file, dest);
}

/** Delete managed version(s) of one runtime. Without `version` the whole
 *  agent dir goes; with `version` only that version dir (must be a known
 *  managed version — the value crosses the IPC boundary and must never be
 *  interpreted as a path). Callers enforce the running-turn guard (see
 *  ipc/runtimes.ts). */
export async function removeRuntime(
  agent: RuntimeAgentId,
  version?: string,
): Promise<{ ok: boolean; error?: string }> {
  if (installing.get(agent)) {
    return { ok: false, error: `runtime ${agent} is being installed — wait for it to finish` };
  }
  const root = getManagedRuntimeRoot();
  if (!root) return { ok: false, error: "runtime directory not initialized yet" };
  try {
    if (version !== undefined) {
      if (!listManagedVersions(agent).includes(version)) {
        return { ok: false, error: `"${version}" is not a managed ${agent} version on disk` };
      }
      const dir = join(root, agent, version);
      rmSync(dir, { recursive: true, force: true });
      diskCache.delete(dir);
      log.info(`runtime version removed: ${agent}@${version}`);
      return { ok: true };
    }
    const dir = join(root, agent);
    rmSync(dir, { recursive: true, force: true });
    diskCache.delete(dir);
    lastErrors.set(agent, "");
    log.info(`runtime removed: ${agent}`);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

/** Managed version of one agent, or null (fallback sources not counted). */
export function installedVersionOf(agent: RuntimeAgentId): string | null {
  return installedManagedPayload(agent)?.version ?? null;
}
