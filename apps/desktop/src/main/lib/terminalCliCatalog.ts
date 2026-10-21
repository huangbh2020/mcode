/**
 * Terminal-CLI catalog & management — powers the settings page's
 * 「终端会话类型」section (设置 → Agent).
 *
 * Terminal sessions run the USER'S OWN CLIs in a PTY (claude / pi / codex /
 * opencode / agy on PATH — see renderer/lib/terminalCli.ts for the
 * session-side counterpart). This module owns the main-side truth about
 * those CLIs:
 *
 *  - catalog: which command + npm package (if any) backs each providerId;
 *  - probe: resolve the executable (PATH first, then well-known locations)
 *    and run `--version` — cached 10 min, force-refreshed after every
 *    install/uninstall action;
 *  - npm actions: install/update (`npm install -g <pkg>@latest`) and
 *    uninstall, run through the shell so Windows .cmd shims resolve exactly
 *    like they would in the user's own terminal;
 *  - external CLIs (agy is installed by the Antigravity IDE, not npm): no
 *    install/uninstall — the install action opens the official download
 *    page in the OS browser instead.
 *
 * The enable/disable toggle is deliberately NOT here: it's a pure
 * renderer-side setting (TERMINAL_CLI_ENABLED_SETTING_KEY) that filters the
 * NewTerminalMenu — main never needs to know it.
 */
import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  TerminalCliCheckResult,
  TerminalCliId,
  TerminalCliStatus,
} from "@contracts/ipc";
import { which } from "@main/lib/binaryResolve.js";
import { resolveClaudeCliPath } from "@main/lib/claudeCli.js";
import { log } from "@main/lib/logger.js";

/** One catalog row. providerId doubles as the terminal session row's
 *  providerId (Session.providerId = "which CLI to run" for kind=terminal). */
export interface TerminalCliCatalogEntry {
  providerId: TerminalCliId;
  /** Shell command a terminal session injects. */
  command: string;
  /** npm global package; null for externally-managed CLIs. */
  packageName: string | null;
  /** Download page shown when an external CLI is missing. */
  downloadUrl: string | null;
}

/** The catalog — order matches the renderer's TERMINAL_CLI_PROVIDER_IDS so
 *  the settings rows and the new-terminal menu read top-to-bottom the same.
 *  Package names verified on a real machine (npm ls -g, 2026-10-19):
 *  claude → @anthropic-ai/claude-code, pi → @earendil-works/pi-coding-agent,
 *  codex → @openai/codex. opencode moved to the v2 package @opencode/cli
 *  (2026-10-21; v1 was opencode-ai — the v2 CLI is what the GUI provider
 *  embeds, and both surfaces should stay on the same line). agy is NOT on
 *  npm — the Antigravity IDE drops it at %LOCALAPPDATA%\agy\bin (its
 *  `agy install` only adds that to PATH). */
export const TERMINAL_CLI_CATALOG: readonly TerminalCliCatalogEntry[] = [
  { providerId: "claude-sdk", command: "claude", packageName: "@anthropic-ai/claude-code", downloadUrl: null },
  { providerId: "pi-sdk", command: "pi", packageName: "@earendil-works/pi-coding-agent", downloadUrl: null },
  { providerId: "codex-sdk", command: "codex", packageName: "@openai/codex", downloadUrl: null },
  { providerId: "opencode", command: "opencode", packageName: "@opencode/cli", downloadUrl: null },
  { providerId: "antigravity", command: "agy", packageName: null, downloadUrl: "https://antigravity.google/" },
];

export function findTerminalCliEntry(providerId: string): TerminalCliCatalogEntry | null {
  return TERMINAL_CLI_CATALOG.find((e) => e.providerId === providerId) ?? null;
}

/** Resolve the CLI's executable, or null when not installed. PATH first
 *  (that's how the user's shell resolves it — `where.exe` finds .cmd shims),
 *  then per-CLI well-known fallback locations. */
export function resolveTerminalCliPath(providerId: TerminalCliId): string | null {
  switch (providerId) {
    case "claude-sdk":
      // Shares claudeCli.ts's resolver (PATH → native installer drop at
      // ~/.local/bin) so the probe and the session pane agree.
      return resolveClaudeCliPath();
    case "pi-sdk":
    case "codex-sdk":
    case "opencode":
      return which(providerId === "pi-sdk" ? "pi" : providerId === "codex-sdk" ? "codex" : "opencode");
    case "antigravity": {
      const onPath = which("agy");
      if (onPath) return onPath;
      const local = process.env["LOCALAPPDATA"];
      if (local) {
        const exe = join(local, "agy", "bin", "agy.exe");
        if (existsSync(exe)) return exe;
      }
      return null;
    }
  }
}

/** Run a shell command and capture stdout, rejecting on failure. `exec`
 *  goes through cmd.exe / POSIX sh, so `npm` resolves via PATH exactly as
 *  in the user's terminal (Windows npm is a .cmd shim CreateProcess cannot
 *  launch directly). All command strings are fixed literals built from this
 *  module's catalog — no user-controlled interpolation. */
function run(cmd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr.trim().split("\n")[0] || err.message));
        return;
      }
      resolve(stdout);
    });
  });
}

/** Extract the semver-looking token from a `--version` first line, so
 *  "2.1.303 (Claude Code)" → "2.1.303" and "codex-cli 0.121.0" → "0.121.0".
 *  Exported for the smoke script. */
export function normalizeSemverToken(versionLine: string): string | null {
  const m = versionLine.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*/);
  return m ? m[0] : null;
}

/** Per-CLI probe cache (path + version). Version bumps are not time-critical
 *  to surface; a 10-minute cache keeps every settings-panel mount and
 *  terminal-pane probe from paying a process spawn. Invalidated (dropped)
 *  after every install/uninstall so the UI converges to the new truth. */
const PROBE_CACHE_MS = 10 * 60_000;
const probeCache = new Map<TerminalCliId, { at: number; value: TerminalCliStatus }>();

/** Probe one CLI: resolve the executable, then `"<path>" --version`. The
 *  command is built from the RESOLVED path double-quoted; paths containing
 *  quotes are rejected outright (same defensive rule as claudeCli.ts — no
 *  injection surface). Never throws; failures land in `error`. */
export async function probeTerminalCli(
  providerId: TerminalCliId,
  force = false,
): Promise<TerminalCliStatus> {
  const entry = findTerminalCliEntry(providerId);
  if (!entry) throw new Error(`unknown terminal cli: ${providerId}`);
  const cached = probeCache.get(providerId);
  if (!force && cached && Date.now() - cached.at < PROBE_CACHE_MS) return cached.value;

  const base: TerminalCliStatus = {
    providerId,
    command: entry.command,
    packageName: entry.packageName,
    manageMode: entry.packageName ? "npm" : "external",
    installed: false,
  };

  const path = resolveTerminalCliPath(providerId);
  if (!path) {
    const value = { ...base };
    probeCache.set(providerId, { at: Date.now(), value });
    return value;
  }
  base.installed = true;
  base.path = path;
  if (path.includes('"')) {
    base.error = "unquotable path";
    probeCache.set(providerId, { at: Date.now(), value: base });
    return base;
  }
  try {
    const out = await run(`"${path}" --version`, 8000);
    const line = out.trim().split("\n")[0] || "";
    base.version = line || undefined;
    if (!line) base.error = "empty --version output";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`terminal cli probe failed (${providerId}): ${msg}`);
    base.error = msg;
  }
  probeCache.set(providerId, { at: Date.now(), value: base });
  return base;
}

/** Probe every catalog CLI (settings panel list). */
export async function listTerminalCliStatuses(force = false): Promise<TerminalCliStatus[]> {
  const statuses = await Promise.all(
    TERMINAL_CLI_CATALOG.map((e) => probeTerminalCli(e.providerId, force)),
  );
  return statuses;
}

/** Drop one CLI's cached probe (after install/uninstall). */
function invalidateProbe(providerId: TerminalCliId): void {
  probeCache.delete(providerId);
}

/* ── npm actions ── */

/** Timeouts: installs can be slow on weak links (claude-code is a ~50MB
 *  package), uninstalls are quick, `npm view` is one registry round-trip. */
const NPM_INSTALL_TIMEOUT_MS = 10 * 60_000;
const NPM_UNINSTALL_TIMEOUT_MS = 2 * 60_000;
const NPM_VIEW_TIMEOUT_MS = 30_000;

/** Install or update to the npm latest. EXTERNAL CLIs are rejected here —
 *  the IPC handler opens their official download page instead (Electron
 *  shell access stays out of this module so it stays smoke-testable).
 *  After a successful npm install the probe cache is dropped so the next
 *  list reflects the new version immediately. */
export async function installTerminalCli(providerId: TerminalCliId): Promise<{ ok: boolean; error?: string }> {
  const entry = findTerminalCliEntry(providerId);
  if (!entry) return { ok: false, error: `unknown terminal cli: ${providerId}` };
  if (!entry.packageName) {
    return { ok: false, error: "externally managed CLI — use its official installer" };
  }
  try {
    invalidateProbe(providerId);
    await run(`npm install -g ${entry.packageName}@latest --no-fund --no-audit`, NPM_INSTALL_TIMEOUT_MS);
    invalidateProbe(providerId);
    log.info(`terminal cli installed/updated: ${entry.packageName}@latest`);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`terminal cli install failed (${entry.packageName}): ${msg}`);
    return { ok: false, error: msg };
  }
}

/** Remove the npm global package. After a "successful" uninstall the CLI can
 *  STILL resolve — a second installation method (claude's native installer
 *  at ~/.local/bin, an IDE-managed drop) lives outside npm's tree. We
 *  re-probe and report the leftover honestly instead of showing
 *  "uninstalled" next to a CLI that still runs. */
export async function uninstallTerminalCli(providerId: TerminalCliId): Promise<{ ok: boolean; error?: string }> {
  const entry = findTerminalCliEntry(providerId);
  if (!entry) return { ok: false, error: `unknown terminal cli: ${providerId}` };
  if (!entry.packageName) {
    return { ok: false, error: "externally managed CLI — uninstall from its own installer" };
  }
  try {
    invalidateProbe(providerId);
    await run(`npm uninstall -g ${entry.packageName}`, NPM_UNINSTALL_TIMEOUT_MS);
    invalidateProbe(providerId);
    const after = await probeTerminalCli(providerId, true);
    if (after.installed) {
      log.info(
        `terminal cli npm package removed but executable still resolves (${entry.packageName} — non-npm install)`,
      );
      return { ok: false, error: "npm-removed" };
    }
    log.info(`terminal cli uninstalled: ${entry.packageName}`);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`terminal cli uninstall failed (${entry.packageName}): ${msg}`);
    return { ok: false, error: msg };
  }
}

/** Registry latest for every npm-managed CLI (`npm view <pkg> version`).
 *  External CLIs are skipped — there is no registry to ask. Never throws;
 *  each result carries its own error. */
export async function checkTerminalCliUpdates(): Promise<TerminalCliCheckResult[]> {
  const results = await Promise.all(
    TERMINAL_CLI_CATALOG.filter((e) => e.packageName).map(async (e): Promise<TerminalCliCheckResult> => {
      try {
        const out = await run(`npm view ${e.packageName} version`, NPM_VIEW_TIMEOUT_MS);
        const latest = out.trim().split("\n").pop()?.trim() ?? "";
        if (!latest) return { providerId: e.providerId, latestVersion: null, error: "empty registry reply" };
        return { providerId: e.providerId, latestVersion: latest };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { providerId: e.providerId, latestVersion: null, error: msg };
      }
    }),
  );
  return results;
}
