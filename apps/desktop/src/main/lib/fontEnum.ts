import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { log } from "@main/lib/logger.js";

/**
 * Enumerate installed system font family names for the UI font picker.
 *
 * Chromium's Local Font Access API (navigator.queryLocalFonts) is NOT
 * exposed by Electron (probed on Electron 33 / Chromium 130: the navigator
 * member doesn't exist; `enable-blink-features=LocalFonts,LocalFontAccess`
 * and `enable-experimental-web-platform-features` don't help), so the main
 * process shells out to the platform's own font registry instead:
 *
 *   darwin  osascript(JXA) → AppKit NSFontManager.availableFontFamilies
 *           — CoreText's authoritative display-family list (the same names
 *           the Mac font panel and CSS font-family accept), ~100ms for
 *           ~250 families. NOT system_profiler SPFontsDataType, which takes
 *           seconds. CF-level bridges (CTFontManagerCopyAvailableFontFami-
 *           lyNames via CFBridgingRelease) segfault under JXA — don't.
 *   win32   PowerShell reads the font registry (HKLM + HKCU, per-user fonts
 *           on Win10 1809+ land in HKCU). Entry names look like
 *           "Microsoft YaHei & Microsoft YaHei UI (TrueType)" → strip the
 *           "(...)" suffix and split on "&". Same registry-source +
 *           explicit-UTF8 pattern as terminal/envRefresh.ts (reg.exe pipe
 *           output is OEM-codepage-mangled for non-ASCII names).
 *   linux   fc-list --format '%{family}\n' (comma-separated aliases per line).
 *
 * On any per-platform failure we fall back to a small curated list of
 * real families for that OS so the picker stays usable; the renderer
 * composes every pick with the default system stack as CSS fallback, so a
 * stale name can never break the chrome.
 */

const execFileAsync = promisify(execFile);

/** Cache TTL — installing fonts mid-session is rare; the picker passes
 *  {refresh:true} to force a re-enumeration right after installing one. */
const CACHE_TTL_MS = 30_000;

let cache: { at: number; families: string[] } | null = null;

/** Family names that are safe to embed in a CSS font-family string, capped
 *  so a pathological entry can't bloat the style. Quotes and backslashes
 *  never occur in real family names we care about; stripping them is cheaper
 *  than escaping correctly. */
function sanitizeFamily(name: string): string {
  const cleaned = name.replace(/["\\]/g, "").trim();
  return cleaned.length > 0 && cleaned.length <= 64 ? cleaned : "";
}

/** macOS: NSFontManager.availableFontFamilies via JXA (see module doc). */
async function listMacFamilies(): Promise<string[]> {
  const script =
    'ObjC.import("AppKit");' +
    " JSON.stringify(ObjC.deepUnwrap(" +
    "$.NSFontManager.sharedFontManager.availableFontFamilies) || []);";
  const { stdout } = await execFileAsync(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", script],
    { timeout: 5000, encoding: "utf8" },
  );
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) throw new Error("unexpected osascript output");
  return parsed.filter((x): x is string => typeof x === "string");
}

/** Registry entry suffix, e.g. " (TrueType)" / " (OpenType)" / " (TrueType)". */
const WIN_FONT_SUFFIX_RE = /\s*\([^()]*\)\s*$/;

/** win32: HKLM + HKCU font registry keys via PowerShell (explicit UTF-8 —
 *  reg.exe pipes OEM code pages and mangles non-ASCII names). */
async function listWinFamilies(): Promise<string[]> {
  const script = [
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "$keys = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',",
    "  'HKCU:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'",
    "$names = foreach ($k in $keys) {",
    "  if (Test-Path -LiteralPath $k) {",
    "    (Get-ItemProperty -LiteralPath $k).PSObject.Properties.Name |",
    "      Where-Object { $_ -notlike 'PS*' }",
    "  }",
    "}",
    "$names | Sort-Object -Unique",
  ].join("; ");
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { timeout: 8000, windowsHide: true, encoding: "utf8" },
  );
  const out: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const entry = line.trim();
    if (!entry) continue;
    // "Microsoft YaHei & Microsoft YaHei UI (TrueType)" → two families.
    const base = entry.replace(WIN_FONT_SUFFIX_RE, "");
    for (const part of base.split("&")) {
      out.push(part);
    }
  }
  return out;
}

/** linux: fontconfig family list. */
async function listLinuxFamilies(): Promise<string[]> {
  const { stdout } = await execFileAsync(
    "fc-list",
    ["--format", "%{family}\n"],
    { timeout: 5000, encoding: "utf8" },
  );
  const out: string[] = [];
  for (const line of stdout.split("\n")) {
    for (const alias of line.split(",")) {
      out.push(alias);
    }
  }
  return out;
}

/** Curated real families per OS, used only when platform enumeration fails
 *  (sandboxed environment, missing fc-list, …). All names are known-good
 *  CSS family names for their platform; the renderer's CSS fallback stack
 *  covers anything stale. Data, not copy — never translated. */
const FALLBACK_FAMILIES: Partial<Record<NodeJS.Platform, string[]>> = {
  darwin: [
    "PingFang SC",
    "Hiragino Sans GB",
    "Songti SC",
    "Kaiti SC",
    "STHeiti",
    "Heiti SC",
    "Helvetica Neue",
    "Avenir Next",
  ],
  win32: [
    "Microsoft YaHei",
    "DengXian",
    "SimSun",
    "KaiTi",
    "SimHei",
    "Segoe UI",
    "Arial",
    "Times New Roman",
  ],
  linux: [
    "Noto Sans CJK SC",
    "Noto Serif CJK SC",
    "Source Han Sans SC",
    "WenQuanYi Micro Hei",
    "Ubuntu",
    "DejaVu Sans",
    "Liberation Sans",
  ],
};

/** Enumerate installed font families (sanitized, deduped, locale-sorted).
 *  Results are cached for CACHE_TTL_MS; pass refresh=true to re-enumerate. */
export async function listSystemFontFamilies(refresh = false): Promise<string[]> {
  if (!refresh && cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.families;
  }
  const fallback = FALLBACK_FAMILIES[process.platform] ?? [];
  let names: string[];
  try {
    if (process.platform === "darwin") names = await listMacFamilies();
    else if (process.platform === "win32") names = await listWinFamilies();
    else if (process.platform === "linux") names = await listLinuxFamilies();
    else names = fallback;
  } catch (err) {
    log.warn(
      `fontEnum: platform enumeration failed (${String(err)}); falling back to curated list`,
    );
    names = fallback;
  }
  const families = Array.from(
    new Set(names.map(sanitizeFamily).filter((n) => n.length > 0)),
  ).sort((a, b) => a.localeCompare(b));
  cache = { at: Date.now(), families };
  return families;
}
