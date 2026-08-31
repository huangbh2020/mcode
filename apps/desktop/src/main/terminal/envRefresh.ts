/**
 * Build the environment block handed to PTY shells.
 *
 * Problem being solved (2026-08-31): the PTY env was a verbatim copy of the
 * Electron main process's `process.env`, i.e. a FROZEN SNAPSHOT taken at app
 * launch. On Windows a freshly opened system terminal gets the CURRENT
 * registry environment (HKLM + HKCU merged), so anything the launch chain
 * lost — or anything installed after the app started (nvm, java, sdkman...)
 * — was invisible inside the integrated terminal. Symptom that drove this:
 * `nvm list` failing with `ERROR open \settings.txt` because `NVM_HOME` was
 * missing from the snapshot while present in both registry scopes.
 *
 * POSIX needs no equivalent: shellResolve spawns login shells (`-l`), which
 * re-source /etc/zprofile + ~/.zprofile on every terminal create. This module
 * is therefore a no-op passthrough outside win32.
 *
 * Windows refresh mechanics:
 *  - Read HKLM `...\Session Manager\Environment` and HKCU\Environment via a
 *    single powershell.exe -Command run. reg.exe is NOT used: its piped output
 *    is OEM-codepage encoded and mojibakes non-ASCII PATH entries on zh-CN
 *    systems; PowerShell lets us force UTF-8.
 *  - Values are read RAW (`DoNotExpandEnvironmentNames`) so REG_EXPAND_SZ
 *    entries like `%NVM_HOME%` survive for us to expand against the merged
 *    (fresh) environment — letting PowerShell expand them would use the stale
 *    app-process env.
 *  - Merge mirrors how Windows builds a new process env: user values override
 *    system values, except PATH which concatenates system + user. Registry
 *    values replace same-name (case-insensitive) snapshot values; inherited
 *    PATH entries missing from the registry PATH are appended back so dev-mode
 *    launch chains (`pnpm dev` PATH additions) don't lose tool resolution.
 *  - %VAR% expansion falls back to process.env for volatile per-session vars
 *    (USERPROFILE lives in `HKCU\Volatile Environment`, which we don't read).
 *
 * Failure policy: any error (powershell missing/wedged, timeout, unparseable
 * output) degrades to the plain inherited env — terminal creation must never
 * fail because of the refresh.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface RegistryValue {
  /** Name as stored in the registry (original casing). */
  name: string;
  /** Raw, unexpanded value. */
  value: string;
  /** REG_EXPAND_SZ (needs %VAR% expansion) vs REG_SZ. */
  expand: boolean;
}

/** Registry scopes keyed by uppercased variable name (names are unique per key). */
interface RegistryEnv {
  system: Map<string, RegistryValue>;
  user: Map<string, RegistryValue>;
}

export interface TerminalEnvResult {
  env: Record<string, string>;
  /** Number of registry variables applied over the snapshot; null = refresh failed (fell back to inherited env). */
  registryVarsApplied: number | null;
}

/** No double-quote characters anywhere — keeps the script immune to Windows argv re-quoting. */
const REGISTRY_DUMP_SCRIPT = [
  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
  "$tab = [char]9",
  "foreach ($kp in @('HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', 'HKCU:\\Environment')) {",
  "  $scope = 'U'",
  "  if ($kp -like 'HKLM:*') { $scope = 'S' }",
  "  $k = Get-Item -LiteralPath $kp -ErrorAction SilentlyContinue",
  "  if ($null -eq $k) { continue }",
  "  foreach ($n in $k.GetValueNames()) {",
  "    if ([string]::IsNullOrEmpty($n)) { continue }",
  "    $kind = $k.GetValueKind($n).ToString()",
  "    if ($kind -ne 'String' -and $kind -ne 'ExpandString') { continue }",
  "    $raw = $k.GetValue($n, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)",
  "    if ($null -eq $raw) { continue }",
  "    $kc = 'S'",
  "    if ($kind -eq 'ExpandString') { $kc = 'E' }",
  "    Write-Output (@($scope, $kc, $n, [string]$raw) -join $tab)",
  "  }",
  "}",
].join("\n");

const PS_TIMEOUT_MS = 8_000;
const PS_MAX_BUFFER = 4 * 1024 * 1024;

/** Short cache: covers the "several terminals created in a burst" pattern
 *  (pairs 150ms apart in practice) while keeping every-day opens fresh. */
const REGISTRY_ENV_TTL_MS = 10_000;
let registryEnvPromise: Promise<RegistryEnv | null> | null = null;
let registryEnvFetchedAt = 0;

function resolvePowerShellExe(): string {
  const sysRoot = process.env.SystemRoot ?? process.env.systemroot ?? "C:\\Windows";
  const candidate = join(sysRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return existsSync(candidate) ? candidate : "powershell.exe";
}

async function readRegistryEnv(): Promise<RegistryEnv | null> {
  try {
    const { stdout } = await execFileAsync(
      resolvePowerShellExe(),
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", REGISTRY_DUMP_SCRIPT],
      { windowsHide: true, timeout: PS_TIMEOUT_MS, maxBuffer: PS_MAX_BUFFER, encoding: "utf8" },
    );
    const system = new Map<string, RegistryValue>();
    const user = new Map<string, RegistryValue>();
    for (const line of stdout.split(/\r?\n/)) {
      if (!line) continue;
      const parts = line.split("\t");
      if (parts.length < 4) continue;
      const [scope, kind, name, ...valueParts] = parts;
      if (!name) continue;
      if ((scope !== "S" && scope !== "U") || (kind !== "S" && kind !== "E")) continue;
      const entry: RegistryValue = { name, value: valueParts.join("\t"), expand: kind === "E" };
      (scope === "S" ? system : user).set(name.toUpperCase(), entry);
    }
    if (system.size === 0 && user.size === 0) return null;
    return { system, user };
  } catch {
    return null;
  }
}

function getRegistryEnvCached(): Promise<RegistryEnv | null> {
  if (registryEnvPromise && Date.now() - registryEnvFetchedAt < REGISTRY_ENV_TTL_MS) {
    return registryEnvPromise;
  }
  registryEnvFetchedAt = Date.now();
  const p = readRegistryEnv().then(
    (r) => {
      // Don't cache failures — the next terminal create should retry.
      if (!r && registryEnvPromise === p) {
        registryEnvPromise = null;
        registryEnvFetchedAt = 0;
      }
      return r;
    },
    () => null,
  );
  registryEnvPromise = p;
  return p;
}

function splitPathEntries(path: string): string[] {
  return path
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Comparison form for PATH dedup: case-insensitive, forward slashes and trailing separators normalized away. */
function pathEntryKey(entry: string): string {
  return entry.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

/** Build the PTY environment: inherited process env + (win32) live registry overlay. */
export async function buildTerminalEnv(): Promise<TerminalEnvResult> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
  }
  if (process.platform !== "win32") {
    return { env, registryVarsApplied: null };
  }

  const reg = await getRegistryEnvCached();
  if (!reg) {
    return { env, registryVarsApplied: null };
  }

  // Expansion lookup: registry first (user overrides system — same precedence
  // the merged env will get), snapshot as fallback for volatile session vars
  // (USERPROFILE & friends are not stored under HKCU\Environment).
  const lookup = new Map<string, string>();
  for (const [k, v] of Object.entries(env)) {
    const upper = k.toUpperCase();
    if (!lookup.has(upper)) lookup.set(upper, v);
  }
  for (const rv of reg.system.values()) lookup.set(rv.name.toUpperCase(), rv.value);
  for (const rv of reg.user.values()) lookup.set(rv.name.toUpperCase(), rv.value);

  const expand = (v: string): string =>
    v.replace(/%([^%]+)%/g, (ref, name: string) => lookup.get(name.toUpperCase()) ?? ref);

  // Track original casing so the overlay replaces same-name snapshot entries
  // instead of growing case-duplicate keys (PATH/Path coexisting confuses
  // CreateProcessW consumers).
  const existingKeys = new Map<string, string>();
  for (const k of Object.keys(env)) {
    const upper = k.toUpperCase();
    if (!existingKeys.has(upper)) existingKeys.set(upper, k);
  }
  let applied = 0;

  const overlay = (rv: RegistryValue, value: string): void => {
    const upper = rv.name.toUpperCase();
    const existing = existingKeys.get(upper);
    if (existing !== undefined && existing !== rv.name) delete env[existing];
    env[rv.name] = value;
    existingKeys.set(upper, rv.name);
    applied++;
  };

  const sysPath = reg.system.get("PATH");
  const usrPath = reg.user.get("PATH");
  if (sysPath !== undefined || usrPath !== undefined) {
    // System + user concatenation, then inherited snapshot entries appended —
    // deduped by normalized form (the registry scopes legitimately overlap,
    // e.g. %NVM_HOME% expanding onto a literal user-PATH entry).
    const mergedEntries: string[] = [];
    const seen = new Set<string>();
    const pushEntry = (entry: string): void => {
      const key = pathEntryKey(entry);
      if (!seen.has(key)) {
        mergedEntries.push(entry);
        seen.add(key);
      }
    };
    for (const scope of [sysPath, usrPath]) {
      if (!scope) continue;
      for (const entry of splitPathEntries(expand(scope.value))) pushEntry(entry);
    }
    const inherited = env[existingKeys.get("PATH") ?? "PATH"] ?? "";
    for (const entry of splitPathEntries(inherited)) pushEntry(entry);
    // The `if` above guarantees at least one scope defines PATH; the "Path"
    // fallback only satisfies the type checker.
    const pathName = sysPath?.name ?? usrPath?.name ?? "Path";
    const existing = existingKeys.get("PATH");
    if (existing !== undefined && existing !== pathName) delete env[existing];
    env[pathName] = mergedEntries.join(";");
    existingKeys.set("PATH", pathName);
    applied++;
  }

  for (const rv of reg.system.values()) {
    if (rv.name.toUpperCase() === "PATH") continue;
    overlay(rv, rv.expand ? expand(rv.value) : rv.value);
  }
  for (const rv of reg.user.values()) {
    if (rv.name.toUpperCase() === "PATH") continue;
    overlay(rv, rv.expand ? expand(rv.value) : rv.value);
  }

  return { env, registryVarsApplied: applied };
}
