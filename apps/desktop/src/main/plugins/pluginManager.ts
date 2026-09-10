/**
 * Plugin lifecycle manager (docs/plugin-feasibility.md §3/v1).
 *
 * Owns `~/.mcode/plugins/`:
 *
 *   plugins/<name>/<version>/          installed plugin payloads (v1 keeps a
 *                                      single version per name — reinstalling
 *                                      prunes the old tree)
 *   plugins/marketplaces/<name>/       cloned/copied marketplace trees
 *   plugins/.staging-<ts>-<rand>/      transient install scratch (removed on
 *                                      success AND failure)
 *
 * Lifecycle rules:
 *   - Installs land DISABLED. The renderer's component-review dialog then
 *     calls setEnabled — the "review before activation" gate lives in the UI,
 *     the state lives here.
 *   - Enable/disable takes effect at the NEXT turn start (each turn rebuilds
 *     provider options; no live reload needed).
 *   - Hooks are parsed for display but NEVER executed in v1: the Claude
 *     provider sets `disableAllHooks` for the session, and Codex/Pi have no
 *     hook channel at all. The panel states this openly (静默 no-op 比明示
 *     不完整更糟 — feasibility §3.4).
 *   - Uninstall is refused while any turn is running (the IPC handler checks
 *     runtimeManager, mirroring runtimes.remove).
 *
 * Delivery queries at the bottom are the ONLY entry points providers touch:
 * getEnabledPlugins / getEnabledPluginSkillRoots / getPluginMcpServers.
 *
 * Electron-free except for SettingRepo (SQL settings table) — same headless
 * smoke-test posture as main/runtimes/*.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { z } from "zod";
import {
  BUILTIN_MARKETPLACES,
  PLUGINS_ENABLED_SETTING_KEY,
  PLUGINS_MARKETPLACES_SETTING_KEY,
  PLUGINS_MCP_DISABLED_SETTING_KEY,
  PLUGIN_NAME_RE,
  PluginManifestSchema,
  PluginMarketEntrySchema,
  PluginMarketplaceManifestSchema,
  McpServerConfigSchema,
  type McpServerConfig,
  type PluginManifest,
  type PluginMarketEntrySource,
  type PluginMarketplaceRecord,
  type PluginMarketplaceState,
  type PluginSourceInfo,
  type PluginState,
} from "@contracts/ipc";
import { SettingRepo } from "@main/store/repositories.js";
import { MCODE_CONFIG_DIR } from "@main/providers/claude-sdk/customEnv.js";
import {
  findPluginManifest,
  findPluginManifestDeep,
  findMarketplaceManifestFile,
  pluginSkillsDirs,
  pluginMcpFiles,
  pluginVersionOf,
  summarizeComponents,
  describePluginMcp,
} from "./pluginManifest.js";

export const PLUGINS_ROOT = path.join(MCODE_CONFIG_DIR, "plugins");
const MARKETPLACES_DIR = path.join(PLUGINS_ROOT, "marketplaces");
const INSTALL_RECORD_FILE = ".mcode-install.json";
const GIT_TIMEOUT_MS = 120_000;
/** Archive downloads are one shot per install and can be tens of MB on a slow
 *  link — generous, but bounded so a stalled socket cannot hold the install
 *  (and the panel's busy state) forever. */
const DOWNLOAD_TIMEOUT_MS = 300_000;

/* ── Settings-table helpers ── */

function readJsonSetting<T>(key: string, fallback: T): T {
  try {
    const raw = SettingRepo.get(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJsonSetting(key: string, value: unknown): void {
  SettingRepo.set(key, JSON.stringify(value));
}

/** Enabled plugin names (empty when never configured). */
export function readEnabledPlugins(): string[] {
  const names = readJsonSetting<string[]>(PLUGINS_ENABLED_SETTING_KEY, []);
  return Array.isArray(names) ? names.filter((n) => typeof n === "string") : [];
}

function writeEnabledPlugins(names: string[]): void {
  writeJsonSetting(PLUGINS_ENABLED_SETTING_KEY, names);
}

function readMarketplaceRecords(): PluginMarketplaceRecord[] {
  const recs = readJsonSetting<PluginMarketplaceRecord[]>(PLUGINS_MARKETPLACES_SETTING_KEY, []);
  return Array.isArray(recs) ? recs : [];
}

function readMcpDisabled(): Set<string> {
  const names = readJsonSetting<string[]>(PLUGINS_MCP_DISABLED_SETTING_KEY, []);
  return new Set(Array.isArray(names) ? names.filter((n) => typeof n === "string") : []);
}

/* ── Process helpers (git / unzip) ── */

interface SpawnResult {
  ok: boolean;
  message: string;
}

interface RunOpts {
  cwd?: string;
  timeoutMs?: number;
  /** Spawn WITHOUT the proxy env vars (http(s)_proxy / ALL_PROXY) — used by
   *  gitClone's proxy-bypass retry so curl can't fall back to them. */
  noProxyEnv?: boolean;
}

const PROXY_ENV_RE = /^(https?_proxy|all_proxy)$/i;

function runCommand(
  cmd: string,
  args: string[],
  opts: RunOpts = {},
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const env = opts.noProxyEnv
      ? Object.fromEntries(
          Object.entries(process.env).filter(([k]) => !PROXY_ENV_RE.test(k)),
        )
      : undefined;
    const child = spawn(cmd, args, { cwd: opts.cwd, windowsHide: true, env });
    let tail = "";
    let settled = false;
    const finish = (r: SpawnResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, message: `${cmd} 超时(${Math.round((opts.timeoutMs ?? 30_000) / 1000)}s)` });
    }, opts.timeoutMs ?? 30_000);
    const feed = (buf: Buffer) => {
      tail = (tail + buf.toString("utf-8")).slice(-2000);
    };
    child.stdout?.on("data", feed);
    child.stderr?.on("data", feed);
    child.on("error", (err) => finish({ ok: false, message: `${cmd} 无法启动:${err.message}` }));
    child.on("close", (code) =>
      finish(
        code === 0
          ? { ok: true, message: "" }
          : { ok: false, message: `${cmd} 退出码 ${code}:${tail.trim().slice(-400) || "(无输出)"}` },
      ),
    );
  });
}

/** curl's message when a configured proxy refuses the connection — the
 *  "proxy app is configured but not running" signature. Only this failure
 *  justifies bypassing the user's proxy: a RUNNING proxy that fails for
 *  auth/DNS/timeout reasons must stay in the path (it may be the only route
 *  to GitHub, and bypassing it would silently leak the request direct). */
const PROXY_REFUSED_RE = /Failed to connect to (?:127\.0\.0\.1|localhost|\[?::1\]?)\s*port/i;

/** Shallow-clone a git repo into `dest` (which must not exist).
 *
 *  Proxy fallback: Mcode spawns git with the inherited environment, so a
 *  machine whose git config / shell env points at a currently-dead local
 *  proxy (Clash/v2ray off — "Failed to connect to 127.0.0.1 port 7897") fails
 *  on the very first hop. When — and only when — the failure is a proxy
 *  connect-refused, retry once with proxies stripped: command-line `-c
 *  http.proxy=` overrides git config files, and the cleaned env stops curl's
 *  env-var fallback. */
async function gitClone(url: string, dest: string, ref?: string): Promise<void> {
  const baseArgs = ["clone", "--depth", "1", "--quiet"];
  if (ref) baseArgs.push("--branch", ref);
  baseArgs.push(url, dest);
  const direct = await runCommand("git", baseArgs, { timeoutMs: GIT_TIMEOUT_MS });
  if (direct.ok) return;
  if (!PROXY_REFUSED_RE.test(direct.message)) {
    throw new Error(`git clone 失败:${direct.message}`);
  }
  const bypass = await runCommand(
    "git",
    ["-c", "http.proxy=", "-c", "https.proxy=", ...baseArgs],
    { timeoutMs: GIT_TIMEOUT_MS, noProxyEnv: true },
  );
  if (!bypass.ok) {
    throw new Error(
      `git clone 失败(代理不可用,绕过代理直连也失败):${bypass.message}。若 GitHub 需要代理访问,请先开启代理软件再重试。`,
    );
  }
}

/** Node's fetch/undici collapses EVERY network failure into the bare string
 *  "fetch failed" — the actionable part (ECONNREFUSED to a proxy port,
 *  ENOTFOUND, TLS/cert errors) hangs off `cause`. Walk the chain so the panel
 *  shows something a user can act on. */
function describeFetchError(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; depth < 4 && cur instanceof Error; depth++) {
    if (cur.message) parts.push(cur.message);
    cur = (cur as { cause?: unknown }).cause;
  }
  return parts.join(" ← ") || String(err);
}

/** Last-resort transport when the platform has no curl: node's fetch. Ignores
 *  the proxy environment entirely (undici does not read it), which is exactly
 *  why curl goes first. */
async function downloadViaFetch(url: string, dest: string): Promise<void> {
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    await fs.writeFile(dest, Buffer.from(await res.arrayBuffer()));
  } catch (err) {
    throw new Error(
      `下载失败:${describeFetchError(err)}(${url})。若该地址需要代理访问,请先开启代理软件再重试。`,
    );
  }
}

/** Download `url` into `dest` (marketplace zip entries: `{source:"url"}` —
 *  152 of the official catalog's 292 entries, so this path is not exotic).
 *
 *  Transport is curl for the same reason gitClone uses git: it resolves
 *  proxies the way the rest of the machine does, and — the part undici's fetch
 *  cannot do — it can be re-run with the proxy env stripped. On a machine whose
 *  shell/git point at a currently-dead local proxy, `fetch` dies on the first
 *  hop (as the useless "fetch failed") while a git clone of the SAME host
 *  succeeds via the bypass; zip installs must not be the one path that fails
 *  there. Same rule as gitClone for when to bypass: only a proxy
 *  connect-refused, never a running proxy that failed for auth/DNS reasons.
 *
 *  Order: curl (inherited env) → curl (proxies stripped) → node fetch (only
 *  when curl is missing, e.g. a minimal Linux image). */
async function downloadFile(url: string, dest: string): Promise<void> {
  const args = [
    "-fL",
    "--silent",
    "--show-error",
    "--retry",
    "2",
    "--connect-timeout",
    "15",
    "-o",
    dest,
    url,
  ];
  const first = await runCommand("curl", args, { timeoutMs: DOWNLOAD_TIMEOUT_MS });
  if (first.ok) return;
  // runCommand reports a missing binary as "<cmd> 无法启动: …" (spawn ENOENT).
  if (/无法启动/.test(first.message)) return downloadViaFetch(url, dest);
  if (!PROXY_REFUSED_RE.test(first.message)) throw new Error(`下载失败:${first.message}`);
  const bypass = await runCommand("curl", args, {
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
    noProxyEnv: true,
  });
  if (bypass.ok) return;
  throw new Error(
    `下载失败(代理不可用,绕过代理直连也失败):${bypass.message}。若该地址需要代理访问,请先开启代理软件再重试。`,
  );
}

/** GNU tar's message when `C:\...` is misread as a remote `host:file` target
 *  (an MSYS/Git Bash tar sitting ahead of System32's bsdtar in PATH). */
const TAR_REMOTE_HOST_RE = /Cannot connect to .* resolve failed/i;
/** Extract a .zip via the platform tool. bsdtar (macOS / Windows 10+) reads
 *  zip natively; Linux GNU tar doesn't, so unzip is the fallback there.
 *
 *  win32 discipline: PATH can surface an MSYS/Git Bash GNU tar before the
 *  system bsdtar, and GNU tar misreads `C:\...` as a remote target — so prefer
 *  the System32 bsdtar explicitly, and when a PATH tar fails with exactly that
 *  remote-host signature, retry once with `--force-local` (GNU tar's own
 *  opt-in for colon paths; a healthy bsdtar never needs the retry). */
async function extractZip(zipPath: string, dest: string): Promise<void> {
  if (process.platform === "win32") {
    const systemTar = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
    const tarBin = existsSync(systemTar) ? systemTar : "tar";
    let viaTar = await runCommand(tarBin, ["-xf", zipPath, "-C", dest], { timeoutMs: 60_000 });
    if (!viaTar.ok && TAR_REMOTE_HOST_RE.test(viaTar.message)) {
      viaTar = await runCommand(tarBin, ["--force-local", "-xf", zipPath, "-C", dest], { timeoutMs: 60_000 });
    }
    if (viaTar.ok) return;
    throw new Error(`zip 解压失败:${viaTar.message}`);
  }
  const viaTar = await runCommand("tar", ["-xf", zipPath, "-C", dest], { timeoutMs: 60_000 });
  if (viaTar.ok) return;
  if (process.platform === "linux") {
    const viaUnzip = await runCommand("unzip", ["-oq", zipPath, "-d", dest], { timeoutMs: 60_000 });
    if (viaUnzip.ok) return;
    throw new Error(`zip 解压失败:${viaUnzip.message}`);
  }
  throw new Error(`zip 解压失败:${viaTar.message}`);
}

/* ── Installed-plugin scan ── */

interface InstallRecord {
  source: PluginSourceInfo;
  installedAt: string;
}

function readInstallRecord(pluginRoot: string): InstallRecord | null {
  try {
    const raw = JSON.parse(readFileSync(path.join(pluginRoot, INSTALL_RECORD_FILE), "utf-8")) as InstallRecord;
    if (raw && raw.source && typeof raw.source.kind === "string") return raw;
  } catch {
    /* no/invalid record */
  }
  return null;
}

/** Newest-version directory of an installed plugin (v1's single-version
 *  model makes "newest" a plain lexicographic max — semver-ish strings sort
 *  well enough for the 0.x world this ships in). */
function installedRootOf(name: string): string | null {
  const base = path.join(PLUGINS_ROOT, name);
  if (!existsSync(base)) return null;
  let newest: string | null = null;
  for (const entry of readdirSync(base)) {
    const dir = path.join(base, entry);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    if (!newest || entry > newest) newest = entry;
  }
  return newest ? path.join(base, newest) : null;
}

/** Build one PluginState row; null when the directory holds no valid
 *  manifest (orphans from interrupted installs are invisible by design). */
function toPluginState(rootDir: string, enabled: Set<string>): PluginState | null {
  let resolved;
  try {
    resolved = findPluginManifest(rootDir);
  } catch {
    return null;
  }
  if (!resolved) return null;
  const record = readInstallRecord(rootDir);
  return {
    name: resolved.manifest.name,
    version: pluginVersionOf(resolved.manifest),
    description: resolved.manifest.description ?? "",
    rootDir,
    enabled: enabled.has(resolved.manifest.name),
    installedAt: record?.installedAt ?? "",
    source: record?.source ?? { kind: "unknown", ref: "" },
    components: summarizeComponents(rootDir, resolved.manifest),
  };
}

/** List every installed plugin with component summaries + enable state. */
export function listPlugins(): PluginState[] {
  const enabled = new Set(readEnabledPlugins());
  if (!existsSync(PLUGINS_ROOT)) return [];
  const out: PluginState[] = [];
  for (const entry of readdirSync(PLUGINS_ROOT)) {
    // Skip housekeeping dirs (marketplaces / staging / dotfiles).
    if (entry.startsWith(".") || entry === "marketplaces") continue;
    if (!PLUGIN_NAME_RE.test(entry)) continue;
    const rootDir = installedRootOf(entry);
    if (!rootDir) continue;
    const state = toPluginState(rootDir, enabled);
    if (state) out.push(state);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/* ── Install pipeline ── */

const installing = new Set<string>();

/** What stagePluginSource/finalizePluginInstall need to know about where the
 *  payload comes from. `git`/`local-*` come from the RPCs; `marketplace-path`
 *  is a resolved marketplace-relative directory; `git-subdir` clones a repo
 *  and takes a subdirectory of it; `remote-zip` downloads an ARCHIVE.
 *
 *  Marketplace `{source:"url"}` entries split across `git` and `remote-zip` by
 *  URL shape (see urlLooksLikeArchive) — the official catalog's 152 of them are
 *  all `https://github.com/<owner>/<repo>.git`. */
type StageKind = "git" | "git-subdir" | "local-dir" | "local-zip" | "marketplace-path" | "remote-zip";

interface StageSource {
  kind: StageKind;
  ref: string;
  /** Branch/tag for git sources. */
  gitRef?: string;
  /** Subdirectory inside the cloned tree (git-subdir sources only). */
  subPath?: string;
}

interface StageOutcome {
  stagingDir: string;
  /** The staged directory that actually holds the manifest (may be nested
   *  one level below stagingDir — zip wrapper / git checkout root). */
  pluginRoot: string;
  manifest: PluginManifest;
  version: string;
}

function makeStagingDir(): string {
  return path.join(PLUGINS_ROOT, `.staging-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}

/** Materialize `source` into a fresh staging dir and resolve its manifest.
 *  Throws user-presentable Chinese errors; the staging dir is removed on
 *  failure, and stays behind on success for finalizePluginInstall. */
async function stagePluginSource(source: StageSource): Promise<StageOutcome> {
  await fs.mkdir(PLUGINS_ROOT, { recursive: true });
  const stagingDir = makeStagingDir();
  await fs.mkdir(stagingDir, { recursive: true });
  try {
    if (source.kind === "git") {
      await gitClone(source.ref, path.join(stagingDir, "repo"), source.gitRef);
      await fs.rm(path.join(stagingDir, "repo", ".git"), { recursive: true, force: true });
    } else if (source.kind === "git-subdir") {
      // Official-marketplace shape `{source:"git-subdir", url, path, ref?}` —
      // clone the tree, then take only `path` (the clone lives in staging and
      // is discarded wholesale, so the subPath must merely stay inside it).
      await gitClone(source.ref, path.join(stagingDir, "repo"), source.gitRef);
      const sub = path.resolve(path.join(stagingDir, "repo"), source.subPath ?? "");
      const rel = path.relative(path.join(stagingDir, "repo"), sub);
      if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
        throw new Error(`git-subdir 的 path 逃逸出仓库:${source.subPath}`);
      }
      if (!existsSync(sub) || !statSync(sub).isDirectory()) {
        throw new Error(`git-subdir 子目录不存在:${source.subPath}`);
      }
      await fs.cp(sub, path.join(stagingDir, "plugin"), { recursive: true });
      await fs.rm(path.join(stagingDir, "repo"), { recursive: true, force: true });
    } else if (source.kind === "remote-zip") {
      // `{source:"url", url}` whose path ends in an archive extension — fetch it
      // and run the same platform extraction as local zips. Transport/proxy
      // policy lives in downloadFile (same discipline as gitClone).
      const tmpZip = path.join(stagingDir, "..", `.dl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.zip`);
      try {
        await downloadFile(source.ref, tmpZip);
        try {
          await extractZip(tmpZip, stagingDir);
        } catch (err) {
          // The URL claimed an archive but the bytes say otherwise — point at
          // the likely mistake instead of leaving a bare tar error.
          throw new Error(
            `${err instanceof Error ? err.message : String(err)}。该地址看起来是压缩包但无法解压;若它其实是 git 仓库,请改用「从 Git 安装」`,
          );
        }
      } finally {
        await fs.rm(tmpZip, { force: true }).catch(() => {});
      }
    } else if (source.kind === "local-zip") {
      await extractZip(source.ref, stagingDir);
    } else {
      // local-dir / marketplace-path: plain copy; never ship a .git tree.
      const src = path.resolve(source.ref);
      if (!existsSync(src) || !statSync(src).isDirectory()) {
        throw new Error(`插件目录不存在:${src}`);
      }
      await fs.cp(src, path.join(stagingDir, "plugin"), { recursive: true });
      await fs.rm(path.join(stagingDir, "plugin", ".git"), { recursive: true, force: true });
    }

    // Marketplace repos (`.claude-plugin/marketplace.json` + one dir per
    // plugin — the official claude-plugins-official shape) must NOT be
    // installed as a plugin: their manifest probe would silently pick one of
    // the plugin children. Redirect to the marketplace flow with an explicit
    // message instead of a confusing "manifest not found".
    if (findMarketplaceManifestFile(stagingDir)) {
      throw new Error(
        "该仓库是插件市场(marketplace)而非单个插件。请在下方「插件市场」区域添加该 git 地址,再从市场列表中安装插件。",
      );
    }

    const resolved = findPluginManifestDeep(stagingDir);
    if (!resolved) {
      throw new Error(
        "未找到插件清单:目录里没有 .claude-plugin/.zcode-plugin/.codex-plugin 的 plugin.json",
      );
    }
    const manifest = PluginManifestSchema.parse(resolved.manifest);
    return { stagingDir, pluginRoot: resolved.rootDir, manifest, version: pluginVersionOf(manifest) };
  } catch (err) {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

/** Copy the staged plugin into its final `plugins/<name>/<version>/` slot,
 *  write the install record, prune other versions (single-version model).
 *  Copies (not renames) so the staging tree can be cleaned uniformly after. */
async function finalizePluginInstall(stage: StageOutcome, source: PluginSourceInfo): Promise<string> {
  const finalDir = path.join(PLUGINS_ROOT, stage.manifest.name, stage.version);
  await fs.mkdir(path.dirname(finalDir), { recursive: true });
  // Stage the new copy BESIDE the final slot, then swap — a same-version
  // reinstall never leaves a half-copied directory at the live path.
  const swapDir = `${finalDir}.swapping-${Date.now()}`;
  await fs.cp(stage.pluginRoot, swapDir, { recursive: true });
  const record: InstallRecord = { source, installedAt: new Date().toISOString() };
  await fs.writeFile(
    path.join(swapDir, INSTALL_RECORD_FILE),
    JSON.stringify(record, null, 2),
    "utf-8",
  );
  rmSync(finalDir, { recursive: true, force: true });
  await fs.rename(swapDir, finalDir);
  for (const other of readdirSync(path.join(PLUGINS_ROOT, stage.manifest.name))) {
    if (other === stage.version) continue;
    rmSync(path.join(PLUGINS_ROOT, stage.manifest.name, other), { recursive: true, force: true });
  }
  return finalDir;
}

export interface InstallResult {
  ok: boolean;
  error?: string;
  plugin?: PluginState;
}

async function installFromSource(source: StageSource, sourceInfo?: PluginSourceInfo): Promise<InstallResult> {
  if (installing.has(source.ref)) {
    return { ok: false, error: "该来源正在安装中" };
  }
  installing.add(source.ref);
  try {
    const stage = await stagePluginSource(source);
    try {
      const finalDir = await finalizePluginInstall(stage, sourceInfo ?? { kind: "local-dir", ref: source.ref });
      const state = toPluginState(finalDir, new Set(readEnabledPlugins()));
      return state ? { ok: true, plugin: state } : { ok: false, error: "安装后清单解析失败" };
    } finally {
      await fs.rm(stage.stagingDir, { recursive: true, force: true }).catch(() => {});
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    installing.delete(source.ref);
  }
}

/** Install from a local plugin directory or .zip archive. */
export async function installFromLocal(localPath: string): Promise<InstallResult> {
  const abs = path.resolve(localPath);
  if (!existsSync(abs)) return { ok: false, error: `路径不存在:${abs}` };
  const st = statSync(abs);
  if (!st.isDirectory() && !st.isFile()) return { ok: false, error: "路径既非目录也非文件" };
  const kind: StageKind = st.isFile() ? "local-zip" : "local-dir";
  if (kind === "local-zip" && !abs.toLowerCase().endsWith(".zip")) {
    return { ok: false, error: "暂只支持安装插件目录或 .zip 包" };
  }
  return installFromSource({ kind, ref: abs }, { kind, ref: abs });
}

/** Install by shallow-cloning a git repository. */
export async function installFromGit(url: string, ref?: string): Promise<InstallResult> {
  return installFromSource(
    { kind: "git", ref: url, gitRef: ref },
    { kind: "git", ref: url },
  );
}

/* ── Enable / disable / remove ── */

export function setPluginEnabled(name: string, enabledValue: boolean): { ok: boolean; error?: string } {
  if (!PLUGIN_NAME_RE.test(name)) return { ok: false, error: "非法插件名" };
  if (!installedRootOf(name)) return { ok: false, error: `插件 ${name} 未安装` };
  const names = readEnabledPlugins().filter((n) => n !== name);
  if (enabledValue) names.push(name);
  writeEnabledPlugins(names);
  return { ok: true };
}

export function removePlugin(name: string): { ok: boolean; error?: string } {
  if (!PLUGIN_NAME_RE.test(name)) return { ok: false, error: "非法插件名" };
  const base = path.join(PLUGINS_ROOT, name);
  if (!existsSync(base)) return { ok: false, error: `插件 ${name} 未安装` };
  rmSync(base, { recursive: true, force: true });
  writeEnabledPlugins(readEnabledPlugins().filter((n) => n !== name));
  // Drop this plugin's per-server MCP toggles (namespaced `<name>__`).
  const mcpDisabled = [...readMcpDisabled()].filter((n) => !n.startsWith(`${name}__`));
  writeJsonSetting(PLUGINS_MCP_DISABLED_SETTING_KEY, mcpDisabled);
  return { ok: true };
}

/* ── Marketplaces ── */

/** Canonical form of a git URL for identity comparison: case, trailing slashes
 *  and a `.git` suffix are noise — the same repository typed as
 *  `https://github.com/x/y`, `.../y.git` or with a trailing slash must match
 *  one built-in entry, not produce three. */
function normalizeGitUrl(url: string): string {
  return url
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
}

const BUILTIN_MARKETPLACE_URLS = new Set(BUILTIN_MARKETPLACES.map((b) => normalizeGitUrl(b.url)));

/** True for a record pointing at one of the shipped catalogs (tested by URL, so
 *  it also holds for records written before the URL was declared built-in). */
function isBuiltinMarketplaceRecord(rec: PluginMarketplaceRecord): boolean {
  return (
    rec.builtin === true ||
    (rec.source.kind === "git" && BUILTIN_MARKETPLACE_URLS.has(normalizeGitUrl(rec.source.ref)))
  );
}

/** Materialize a record for every shipped marketplace that is missing, and
 *  adopt an existing copy of the same repository (matched by URL) as built-in.
 *  Idempotent and write-free unless something actually changed, so it is safe
 *  to call on every list. User records keep their order; new built-ins append
 *  (a user's own catalogs stay first, which is also where the panel opens). */
function ensureBuiltinMarketplaceRecords(
  records: PluginMarketplaceRecord[],
): PluginMarketplaceRecord[] {
  let changed = false;
  const knownUrls = new Set<string>();
  const out: PluginMarketplaceRecord[] = [];
  for (const rec of records) {
    if (rec.source.kind === "git") knownUrls.add(normalizeGitUrl(rec.source.ref));
    if (isBuiltinMarketplaceRecord(rec) && rec.builtin !== true) {
      changed = true;
      out.push({ ...rec, builtin: true });
    } else {
      out.push(rec);
    }
  }
  for (const def of BUILTIN_MARKETPLACES) {
    if (knownUrls.has(normalizeGitUrl(def.url))) continue;
    // Name clash with an unrelated user marketplace: skip this one rather than
    // taking over a directory the user is already using under that name.
    if (out.some((r) => r.name === def.name)) continue;
    out.push({
      name: def.name,
      source: { kind: "git", ref: def.url },
      addedAt: new Date().toISOString(),
      builtin: true,
    });
    changed = true;
  }
  if (changed) writeJsonSetting(PLUGINS_MARKETPLACES_SETTING_KEY, out);
  return out;
}

/** Locate + parse a marketplace tree's manifest
 *  (`.claude-plugin/marketplace.json`, root `marketplace.json` fallback).
 *
 *  Entry-level tolerance: the official marketplace mixes several `source`
 *  shapes and keeps adding new ones, so ONE unrecognized entry must not blank
 *  the whole catalog — when the strict schema rejects the manifest, entries
 *  are re-validated individually and only the bad ones are skipped. */
function readMarketplaceManifest(dir: string) {
  const candidates = [
    path.join(dir, ".claude-plugin", "marketplace.json"),
    path.join(dir, "marketplace.json"),
  ];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const raw: unknown = JSON.parse(readFileSync(file, "utf-8"));
      const parsed = PluginMarketplaceManifestSchema.safeParse(raw);
      if (parsed.success) return parsed.data;
      if (raw && typeof raw === "object" && Array.isArray((raw as { plugins?: unknown }).plugins)) {
        const obj = raw as { name?: unknown; owner?: unknown; plugins: unknown[] };
        const plugins: z.infer<typeof PluginMarketEntrySchema>[] = [];
        for (const entry of obj.plugins) {
          const ep = PluginMarketEntrySchema.safeParse(entry);
          if (ep.success) plugins.push(ep.data);
        }
        if (plugins.length > 0) {
          return {
            name: typeof obj.name === "string" ? obj.name : undefined,
            owner: typeof obj.owner === "string" ? obj.owner : undefined,
            plugins,
          };
        }
      }
      return null; // present but unusable
    } catch {
      return null;
    }
  }
  return null;
}

function marketplaceDirOf(name: string): string {
  return path.join(MARKETPLACES_DIR, name);
}

/** Materialize a marketplace tree into `dest` (must not exist; staged under
 *  MARKETPLACES_DIR's parent so the final rename stays on one filesystem). */
async function materializeMarketplaceTree(
  source: { kind: "git" | "local"; ref: string },
  dest: string,
): Promise<void> {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  if (source.kind === "git") {
    await gitClone(source.ref, dest);
    await fs.rm(path.join(dest, ".git"), { recursive: true, force: true });
  } else {
    const src = path.resolve(source.ref);
    if (!existsSync(src) || !statSync(src).isDirectory()) {
      throw new Error(`marketplace 目录不存在:${src}`);
    }
    await fs.cp(src, dest, { recursive: true });
    await fs.rm(path.join(dest, ".git"), { recursive: true, force: true });
  }
}

/** Add a marketplace (git URL or local directory). The display name comes
 *  from the explicit override or the manifest's own `name`; the last resort
 *  is a sanitized form of the ref. */
export async function addMarketplace(input: {
  kind: "git" | "local";
  ref: string;
  name?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const records = readMarketplaceRecords();
  // Same repository (however it was spelled) already listed — usually one of the
  // shipped catalogs, which must be refreshed rather than added a second time.
  if (
    input.kind === "git" &&
    records.some(
      (r) => r.source.kind === "git" && normalizeGitUrl(r.source.ref) === normalizeGitUrl(input.ref),
    )
  ) {
    return { ok: false, error: `该仓库已在插件市场中:${input.ref}` };
  }
  const staging = path.join(PLUGINS_ROOT, `.mp-staging-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    await materializeMarketplaceTree({ kind: input.kind, ref: input.ref }, staging);
    const manifest = readMarketplaceManifest(staging);
    if (!manifest) {
      throw new Error("marketplace 清单缺失或无效(需要 .claude-plugin/marketplace.json)");
    }
    const rawName = input.name ?? manifest.name ?? sanitizeMarketplaceName(input.ref);
    if (!PLUGIN_NAME_RE.test(rawName)) {
      throw new Error(`marketplace 名称非法:${rawName}`);
    }
    if (records.some((r) => r.name === rawName)) {
      throw new Error(`同名 marketplace 已存在:${rawName}`);
    }
    const dest = marketplaceDirOf(rawName);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    rmSync(dest, { recursive: true, force: true });
    await fs.rename(staging, dest);
    records.push({
      name: rawName,
      source: { kind: input.kind, ref: input.ref },
      addedAt: new Date().toISOString(),
    });
    writeJsonSetting(PLUGINS_MARKETPLACES_SETTING_KEY, records);
    return { ok: true };
  } catch (err) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function sanitizeMarketplaceName(ref: string): string {
  // "owner/repo" or a URL tail — keep the last path segment, strip .git.
  const tail = ref.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "marketplace";
  const cleaned = tail.replace(/\.git$/, "").replace(/[^A-Za-z0-9._-]/g, "-");
  return cleaned || "marketplace";
}

export function removeMarketplace(name: string): { ok: boolean; error?: string } {
  const records = readMarketplaceRecords();
  const rec = records.find((r) => r.name === name);
  if (!rec) return { ok: false, error: `marketplace ${name} 不存在` };
  // Shipped catalogs are part of the product surface, not user state: the panel
  // hides their remove action, and this is the guard for any other caller.
  if (isBuiltinMarketplaceRecord(rec)) {
    return { ok: false, error: `内置插件市场不可移除,可刷新:${name}` };
  }
  writeJsonSetting(
    PLUGINS_MARKETPLACES_SETTING_KEY,
    records.filter((r) => r.name !== name),
  );
  rmSync(marketplaceDirOf(name), { recursive: true, force: true });
  return { ok: true };
}

/** Re-fetch a marketplace tree (git: fresh clone; local: re-copy). */
export async function refreshMarketplace(name: string): Promise<{ ok: boolean; error?: string }> {
  const record = readMarketplaceRecords().find((r) => r.name === name);
  if (!record) return { ok: false, error: `marketplace ${name} 不存在` };
  const dest = marketplaceDirOf(name);
  const staging = path.join(PLUGINS_ROOT, `.mp-staging-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    await materializeMarketplaceTree(record.source, staging);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    rmSync(dest, { recursive: true, force: true });
    await fs.rename(staging, dest);
    return { ok: true };
  } catch (err) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** All marketplaces with their parsed entries; `installed` matched against
 *  the installed plugin set by name. */
export function listMarketplaces(): PluginMarketplaceState[] {
  const installed = new Set(listPlugins().map((p) => p.name));
  // Also the seeding point for the shipped catalogs: any list call (i.e. opening
  // the plugin panel) makes sure they are present in the records.
  return ensureBuiltinMarketplaceRecords(readMarketplaceRecords()).map((rec) => {
    const dir = marketplaceDirOf(rec.name);
    const manifest = existsSync(dir) ? readMarketplaceManifest(dir) : null;
    return {
      name: rec.name,
      sourceKind: rec.source.kind,
      sourceRef: rec.source.ref,
      addedAt: rec.addedAt,
      builtin: rec.builtin === true,
      cloned: existsSync(dir),
      plugins: (manifest?.plugins ?? []).map((e) => ({
        marketplace: rec.name,
        name: e.name,
        description: e.description ?? "",
        version: e.version ?? "",
        installed: installed.has(e.name),
      })),
    };
  });
}

/** True when a marketplace `{source:"url"}` points at a downloadable archive
 *  rather than a repository.
 *
 *  The Claude marketplace schema uses `url` for BOTH, and a repository URL is
 *  the dominant case by far — all 152 `url` entries of
 *  anthropics/claude-plugins-official are `https://github.com/<owner>/<repo>.git`
 *  (verified against the real manifest). Treating those as downloads fetched
 *  GitHub's HTML repo page with HTTP 200 and handed it to tar, which failed
 *  with the very unhelpful "Unrecognized archive format" — half the catalog
 *  could not be installed. Only an archive-extension path is downloaded. */
function urlLooksLikeArchive(url: string): boolean {
  let pathname = url;
  try {
    pathname = new URL(url).pathname;
  } catch {
    /* not a parseable URL — fall back to the raw string */
  }
  return /\.(zip|tgz|tar\.gz|tar)$/i.test(pathname);
}

/** Resolve a marketplace entry's `source` into an installable source.
 *  Relative paths must stay inside the marketplace tree (same path
 *  discipline as plugin component paths). */
function resolveMarketplaceEntrySource(
  marketplaceName: string,
  entryName: string,
): StageSource & { info: PluginSourceInfo } {
  const rec = readMarketplaceRecords().find((r) => r.name === marketplaceName);
  if (!rec) throw new Error(`marketplace ${marketplaceName} 不存在`);
  const dir = marketplaceDirOf(marketplaceName);
  const manifest = existsSync(dir) ? readMarketplaceManifest(dir) : null;
  const entry = manifest?.plugins.find((p) => p.name === entryName);
  if (!entry) throw new Error(`marketplace ${marketplaceName} 中没有插件 ${entryName}`);

  const src: PluginMarketEntrySource = entry.source;
  if (typeof src === "string") {
    if (path.isAbsolute(src)) throw new Error("marketplace 条目 source 不允许绝对路径");
    const abs = path.resolve(dir, src);
    const rel = path.relative(dir, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error("marketplace 条目 source 逃逸出 marketplace 目录");
    }
    if (!existsSync(abs)) throw new Error(`marketplace 条目路径不存在:${src}`);
    return {
      kind: "marketplace-path",
      ref: abs,
      info: { kind: "marketplace", ref: `${marketplaceName}:${src}` },
    };
  }
  if (src.source === "github") {
    const url = `https://github.com/${src.repo}.git`;
    return {
      kind: "git",
      ref: url,
      info: { kind: "marketplace", ref: `${marketplaceName}:github/${src.repo}` },
    };
  }
  if (src.source === "git-subdir") {
    return {
      kind: "git-subdir",
      ref: src.url,
      gitRef: src.ref,
      subPath: src.path,
      info: { kind: "marketplace", ref: `${marketplaceName}:${src.url}#${src.path}` },
    };
  }
  if (src.source === "url") {
    return {
      kind: urlLooksLikeArchive(src.url) ? "remote-zip" : "git",
      ref: src.url,
      info: { kind: "marketplace", ref: `${marketplaceName}:${src.url}` },
    };
  }
  // git
  return {
    kind: "git",
    ref: src.url,
    gitRef: src.ref,
    info: { kind: "marketplace", ref: `${marketplaceName}:${src.url}` },
  };
}

export async function installFromMarketplace(
  marketplaceName: string,
  entryName: string,
): Promise<InstallResult> {
  try {
    const { info, ...source } = resolveMarketplaceEntrySource(marketplaceName, entryName);
    return await installFromSource(source, info);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/* ── Provider delivery queries ──
 * Called at turn start by the three providers; each call re-reads the
 * enabled set + rescans the (tiny) plugin trees, so enable/disable lands on
 * the very next turn without any invalidation protocol. */

export interface EnabledPlugin {
  name: string;
  rootDir: string;
  manifest: PluginManifest;
  /** True when the plugin declares hooks (parsed for display; v1 never
   *  executes them — the Claude provider's disableAllHooks is the backstop). */
  hasHooks: boolean;
}

/** Resolve the currently enabled plugins (missing dirs silently skipped). */
export async function getEnabledPlugins(): Promise<EnabledPlugin[]> {
  const enabledNames = new Set(readEnabledPlugins());
  if (enabledNames.size === 0) return [];
  const out: EnabledPlugin[] = [];
  for (const name of enabledNames) {
    const rootDir = installedRootOf(name);
    if (!rootDir) continue;
    try {
      const resolved = findPluginManifest(rootDir);
      if (!resolved) continue;
      const hasHooks = summarizeComponents(rootDir, resolved.manifest).hooks.length > 0;
      out.push({ name: resolved.manifest.name, rootDir, manifest: resolved.manifest, hasHooks });
    } catch {
      /* invalid manifest on disk — skip this plugin for this turn */
    }
  }
  return out;
}

/** Existing skills directories of enabled plugins — appended to Codex's
 *  `skills/extraRoots/set` and Pi's `additionalSkillPaths`. A manifest may
 *  declare multiple skills roots (Claude's string[] form). */
export async function getEnabledPluginSkillRoots(): Promise<string[]> {
  const roots: string[] = [];
  for (const p of await getEnabledPlugins()) {
    roots.push(...pluginSkillsDirs(p.rootDir, p.manifest));
  }
  return roots;
}

/** Raw `[serverName, config]` pairs across every MCP definition file of a
 *  plugin (the manifest may declare multiple — Claude's string[] form).
 *  Unreadable files are skipped, never fatal. */
function readPluginMcpEntries(p: EnabledPlugin): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [];
  for (const file of pluginMcpFiles(p.rootDir, p.manifest)) {
    let cfg: unknown;
    try {
      cfg = JSON.parse(readFileSync(file, "utf-8"));
    } catch {
      continue;
    }
    const servers =
      cfg && typeof cfg === "object" && !Array.isArray(cfg)
        ? (cfg as Record<string, unknown>).mcpServers ?? cfg
        : null;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) continue;
    for (const [serverName, raw] of Object.entries(servers as Record<string, unknown>)) {
      out.push([serverName, raw]);
    }
  }
  return out;
}

/** Namespaced MCP server entries of enabled plugins:
 *  `[["<plugin>__<server>", config], ...]`, honoring the per-server disable
 *  list (plugins.mcpDisabled, written by the MCP panel). Invalid configs are
 *  skipped — a broken plugin server never blocks a turn. */
export async function getPluginMcpServers(): Promise<Array<[string, McpServerConfig]>> {
  const disabled = readMcpDisabled();
  const out: Array<[string, McpServerConfig]> = [];
  for (const p of await getEnabledPlugins()) {
    for (const [serverName, raw] of readPluginMcpEntries(p)) {
      const parsed = McpServerConfigSchema.safeParse(raw);
      if (!parsed.success) continue;
      const fullName = `${p.name}__${serverName}`;
      if (disabled.has(fullName)) continue;
      out.push([fullName, parsed.data]);
    }
  }
  return out;
}

/** Toggle one plugin-contributed MCP server (MCP panel, scope "plugin").
 *  Pure denylist write — the plugin's own enable state is untouched. */
export function setPluginMcpDisabled(
  serverName: string,
  disabledValue: boolean,
): { ok: boolean; error?: string } {
  const next = new Set([...readMcpDisabled()].filter((n) => n !== serverName));
  if (disabledValue) next.add(serverName);
  writeJsonSetting(PLUGINS_MCP_DISABLED_SETTING_KEY, [...next]);
  return { ok: true };
}

/** Rows for the MCP panel (scope "plugin"): one per server of each ENABLED
 *  plugin, `enabled` = not on the plugins.mcpDisabled denylist. Disabled
 *  plugins contribute no rows — the plugin's own switch is the master gate,
 *  so the two controls never contradict each other. */
export async function listPluginMcpPanelEntries(): Promise<
  Array<{ name: string; scope: "plugin"; kind: "stdio" | "http" | "sse"; detail: string; enabled: boolean }>
> {
  const disabled = readMcpDisabled();
  const out: Array<{ name: string; scope: "plugin"; kind: "stdio" | "http" | "sse"; detail: string; enabled: boolean }> = [];
  for (const p of await getEnabledPlugins()) {
    for (const [serverName, raw] of readPluginMcpEntries(p)) {
      const desc = describePluginMcp(raw);
      if (!desc) continue;
      const fullName = `${p.name}__${serverName}`;
      out.push({
        name: fullName,
        scope: "plugin",
        kind: desc.kind,
        detail: desc.detail,
        enabled: !disabled.has(fullName),
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
