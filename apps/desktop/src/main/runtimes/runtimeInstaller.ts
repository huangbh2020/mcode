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
 *  - claude: @anthropic-ai/claude-agent-sdk-<platform>-<arch>@<expected>
 *      (dep-free tarball, binary at package root: claude[.exe])
 *  - codex:  @openai/codex@<expected>-<platform>-<arch>
 *      (dep-free tarball, binary under vendor/<triple>/bin/codex[.exe])
 *  - pi:     @mcode/runtime-pi@<expected>
 *      (Mcode's own preassembled meta-package — the pnpm-resolved pi
 *      dependency closure in a flat node_modules layout, packed by
 *      build/pack-pi-runtime.cjs; the version tracks the pinned
 *      @earendil-works/pi-coding-agent in package.json)
 *
 * Every install is atomic: download to a temp file (sha512-verified against
 * the registry's dist.integrity), extract into a staging dir, verify the
 * expected payload exists, then rename into place and prune older versions.
 * Progress is pushed to the renderer over `runtimes:event`.
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { app } from "electron";
import {
  IPC,
  type RuntimeAgentId,
  type RuntimeAgentState,
  type RuntimeProgressPayload,
} from "@contracts/ipc";
import { sendToRenderer } from "@main/window.js";
import { log } from "@main/lib/logger.js";
import { getManagedRuntimeRoot, listManagedVersions } from "./managedRuntimeRoots.js";
import { codexVendorTriple, findCodexBinaryInPackage } from "@main/providers/codex-sdk/codexBinaryResolve.js";
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

/** npmmirror first (CN-friendly, same metadata + integrity as official);
 *  official registry as the fallback. */
const REGISTRIES = ["https://registry.npmmirror.com", "https://registry.npmjs.org"] as const;

const META_TIMEOUT_MS = 15_000;
const LATEST_TIMEOUT_MS = 6_000;
const LATEST_TTL_MS = 10 * 60_000;
const DISK_TTL_MS = 30_000;
const PROGRESS_EMIT_INTERVAL_MS = 150;

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
    pin("@anthropic-ai/claude-agent-sdk", "claude");
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

/** Best-effort "latest" lookup; returns null when both registries fail. */
async function fetchLatestVersion(agent: RuntimeAgentId): Promise<string | null> {
  const name = latestCheckPackageFor(agent);
  for (const reg of REGISTRIES) {
    try {
      const res = await fetch(`${reg}/${registryPath(name)}/latest`, {
        signal: AbortSignal.timeout(LATEST_TIMEOUT_MS),
      });
      if (!res.ok) continue;
      const manifest = (await res.json()) as { version?: string };
      if (typeof manifest.version === "string" && manifest.version) return manifest.version;
    } catch {
      continue;
    }
  }
  return null;
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

/* ── disk helpers ── */

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
      const version = await withTimeout(fetchLatestVersion(agent), LATEST_TIMEOUT_MS + 2_000);
      latestCache.set(agent, { version, at: Date.now() });
    }),
  );
  return agents.map((agent) => {
    const managed = installedManagedPayload(agent);
    const installedVersion = managed?.version ?? null;
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
    return {
      agent,
      expectedVersion: expected[agent],
      installedVersion,
      source,
      activeVersion,
      activePath: managed?.entry ?? fallback?.path ?? null,
      latestVersion: latestCache.get(agent)?.version ?? null,
      installed: managed !== null,
      updateAvailable: activeVersion !== null && activeVersion !== expected[agent],
      installing: installing.get(agent) ?? false,
      lastError: lastErrors.get(agent) ?? "",
      diskBytes: managed ? dirSizeCached(managed.dir) : 0,
      installPath: managed?.entry ?? null,
    };
  });
}

/** Shared tail of both install paths: verify the extracted payload, fix
 *  binary permissions, atomically move staging into place, write the install
 *  record and prune other versions. Throws on layout mismatch; on success the
 *  caller must NOT clean up stagingDir anymore (it was renamed). */
function finalizeInstall(
  agent: RuntimeAgentId,
  stagingDir: string,
  version: string,
  record: { npmName?: string; source: "registry" | "local-path"; localPath?: string },
): { finalDir: string; entry: string } {
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
  rmSync(finalDir, { recursive: true, force: true });
  renameSync(stagingDir, finalDir);
  writeFileSync(
    join(finalDir, "install.json"),
    JSON.stringify({ agent, version, installedAt: new Date().toISOString(), ...record }, null, 2),
  );
  // Keep only the installed version around — a stale 300-600MB copy isn't
  // worth disk space; rollback = reinstall the old version from the panel.
  for (const other of listManagedVersions(agent)) {
    if (other === version) continue;
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

/** Download + install (or update / reinstall) one runtime. Resolves when the
 *  install fully finished (or failed — check `ok`/`error`). */
export async function installRuntime(agent: RuntimeAgentId): Promise<{ ok: boolean; error?: string }> {
  if (installing.get(agent)) {
    return { ok: false, error: `runtime ${agent} is already being installed` };
  }
  installing.set(agent, true);
  lastErrors.set(agent, "");
  let stagingDir: string | null = null;
  emitProgress(agent, "downloading", -1);
  try {
    const expected = loadExpectedVersions()[agent];
    const pkg = npmPackageFor(agent, expected);
    const meta = await fetchPackageMeta(pkg.name, pkg.version);
    if (!meta) {
      throw new Error(
        `registry has no ${pkg.name}@${pkg.version} — check the network/mirror, or the version hasn't been published yet ` +
          `(pi: publish @mcode/runtime-pi, or pack locally with \`pnpm pack:pi-runtime\` and use install-from-file)`,
      );
    }
    log.info(`runtime install: ${agent} downloading ${pkg.name}@${pkg.version}`);
    const tmpTarball = await downloadVerifiedTarball(agent, meta);
    try {
      emitProgress(agent, "extracting", -1);
      const root = getManagedRuntimeRoot() ?? join(app.getPath("userData"), "runtimes");
      stagingDir = join(root, agent, `.${expected}.staging-${Date.now()}`);
      mkdirSync(stagingDir, { recursive: true });
      const { extract } = await import("tar");
      // npm tarballs root everything under package/ — strip that prefix.
      await extract({ file: tmpTarball, cwd: stagingDir, strip: 1 });
    } finally {
      rmSync(tmpTarball, { force: true });
    }

    const { finalDir } = finalizeInstall(agent, stagingDir, expected, {
      npmName: pkg.name,
      source: "registry",
    });
    stagingDir = null;
    lastErrors.set(agent, "");
    emitProgress(agent, "done", 1);
    log.info(`runtime installed: ${agent}@${expected} -> ${finalDir}`);
    return { ok: true };
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
    const { finalDir } = finalizeInstall(agent, stagingDir, version, {
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

/** Delete every installed version of one runtime. Callers enforce the
 *  running-turn guard (see ipc/runtimes.ts). */
export async function removeRuntime(agent: RuntimeAgentId): Promise<{ ok: boolean; error?: string }> {
  if (installing.get(agent)) {
    return { ok: false, error: `runtime ${agent} is being installed — wait for it to finish` };
  }
  const root = getManagedRuntimeRoot();
  if (!root) return { ok: false, error: "runtime directory not initialized yet" };
  const dir = join(root, agent);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
  diskCache.delete(dir);
  lastErrors.set(agent, "");
  log.info(`runtime removed: ${agent}`);
  return { ok: true };
}

/** Managed version of one agent, or null (fallback sources not counted). */
export function installedVersionOf(agent: RuntimeAgentId): string | null {
  return installedManagedPayload(agent)?.version ?? null;
}
