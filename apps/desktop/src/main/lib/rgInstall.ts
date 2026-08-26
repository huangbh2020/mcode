/**
 * One-click ripgrep install for machines where `rg` isn't on PATH.
 *
 * The file/grep IPC handlers prefer ripgrep and silently degrade to the
 * in-process scanners when it's missing — fine functionally, but slow on big
 * repos. The search dialog surfaces that gap via `rg.status` and offers this
 * install: we download the official release binary (pinned version, with a
 * couple of China-friendly GitHub mirrors tried in order) into
 * `userData/bin`, extract it, verify it runs, and reset the rg resolution
 * cache so subsequent searches pick it up immediately.
 *
 * Extraction uses the system `tar` (bsdtar on Windows/macOS handles zip and
 * tar.gz; GNU tar on Linux handles tar.gz) — the same approach the Java LSP
 * installer uses, so no new decompression dependency.
 */
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  createWriteStream,
} from "node:fs";
import { app } from "electron";
import { join } from "node:path";
import { bundledRgPath, resetRgCache } from "@main/lib/rgSearch.js";
import { log } from "@main/lib/logger.js";

/** Pinned ripgrep release. Kept exact (no ranges) so the download URL stays
 *  deterministic; bump here to update. 14.1.1 is the latest stable. */
const RG_VERSION = "14.1.1";
const RG_RELEASE_BASE = "https://github.com/BurntSushi/ripgrep/releases/download";

interface RgAsset {
  fileName: string;
  kind: "zip" | "tgz";
}

function assetFor(): RgAsset {
  if (process.platform === "win32") {
    return { fileName: `ripgrep-${RG_VERSION}-x86_64-pc-windows-msvc.zip`, kind: "zip" };
  }
  if (process.platform === "darwin") {
    return process.arch === "arm64"
      ? { fileName: `ripgrep-${RG_VERSION}-aarch64-apple-darwin.tar.gz`, kind: "tgz" }
      : { fileName: `ripgrep-${RG_VERSION}-x86_64-apple-darwin.tar.gz`, kind: "tgz" };
  }
  return process.arch === "arm64"
    ? { fileName: `ripgrep-${RG_VERSION}-aarch64-unknown-linux-musl.tar.gz`, kind: "tgz" }
    : { fileName: `ripgrep-${RG_VERSION}-x86_64-unknown-linux-musl.tar.gz`, kind: "tgz" };
}

/** Download URL chain: GitHub official first, then common China mirrors
 *  (GitHub releases are frequently slow/blocked from CN networks). The first
 *  URL that yields a complete download wins. */
const DOWNLOAD_URLS: Array<(fileName: string) => string> = [
  (f) => `${RG_RELEASE_BASE}/${RG_VERSION}/${f}`,
  (f) => `https://ghfast.top/${RG_RELEASE_BASE}/${RG_VERSION}/${f}`,
  (f) => `https://ghproxy.net/${RG_RELEASE_BASE}/${RG_VERSION}/${f}`,
];

/** Per-download wall-clock cap, well above any healthy transfer. */
const DOWNLOAD_TIMEOUT_MS = 180_000;

export interface RgInstallResult {
  ok: boolean;
  error?: string;
  path?: string;
}

let installInFlight: Promise<RgInstallResult> | null = null;

/** True while an install is running (mirrored to the renderer via rg.status). */
export function isRgInstalling(): boolean {
  return installInFlight !== null;
}

/** Kick off a one-click install. Concurrent calls share the same in-flight
 *  promise instead of downloading twice. */
export function installRg(): Promise<RgInstallResult> {
  if (!installInFlight) {
    installInFlight = doInstall().finally(() => {
      installInFlight = null;
    });
  }
  return installInFlight;
}

async function doInstall(): Promise<RgInstallResult> {
  const binDir = app.getPath("userData");
  const target = bundledRgPath();
  if (existsSync(target)) {
    return { ok: true, path: target }; // already installed (e.g. race)
  }
  const asset = assetFor();
  const tmpRoot = join(binDir, "rg-install-tmp");
  mkdirSync(tmpRoot, { recursive: true });
  const archivePath = join(tmpRoot, asset.fileName);
  const extractDir = join(tmpRoot, "x");
  rmSync(extractDir, { recursive: true, force: true });
  try {
    await downloadArchive(archivePath, asset.fileName, DOWNLOAD_URLS);
    mkdirSync(extractDir, { recursive: true });
    await extractArchive(archivePath, extractDir, asset.kind);

    const found = await findBinary(extractDir, process.platform === "win32" ? "rg.exe" : "rg");
    if (!found) {
      return { ok: false, error: "解压后未找到 rg 二进制" };
    }

    // Verify the extracted binary actually runs before adopting it.
    if (!(await verifyRg(found))) {
      return { ok: false, error: "下载的 ripgrep 无法运行,请重试或手动安装" };
    }

    mkdirSync(join(binDir, "bin"), { recursive: true });
    renameSync(found, target);
    if (process.platform !== "win32") {
      try {
        chmodSync(target, 0o755);
      } catch {
        // chmod failure is cosmetic on most setups — keep going.
      }
    }
    resetRgCache();
    log.info(`rg installed: ${target}`);
    return { ok: true, path: target };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`rg install failed: ${msg}`);
    return { ok: false, error: msg };
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

async function downloadArchive(dest: string, fileName: string, urls: Array<(f: string) => string>): Promise<void> {
  let lastErr: Error | null = null;
  for (const build of urls) {
    try {
      await downloadToFile(build(fileName), dest);
      return;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      rmSync(dest, { force: true });
    }
  }
  throw lastErr ?? new Error("下载失败");
}

/** Stream `url` into `dest` (written via a `.part` sibling then renamed).
 *  Uses global fetch + AbortSignal.timeout; follows redirects automatically
 *  (GitHub release URLs 302 to the CDN). */
async function downloadToFile(url: string, dest: string): Promise<void> {
  const part = `${dest}.part`;
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} ${url}`);
  }
  const reader = res.body.getReader();
  const ws = createWriteStream(part);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!ws.write(value)) {
        await new Promise<void>((resolveP) => ws.once("drain", resolveP));
      }
    }
    await new Promise<void>((resolveP, rejectP) =>
      ws.end((err: Error | null | undefined) => (err ? rejectP(err) : resolveP())),
    );
    renameSync(part, dest);
  } catch (err) {
    try {
      ws.destroy();
    } catch {
      // ignore
    }
    throw err;
  }
}

/** Extract with the system tar: bsdtar (Windows/macOS) handles zip AND
 *  tar.gz; GNU tar (Linux) handles tar.gz. */
function extractArchive(archivePath: string, destDir: string, kind: "zip" | "tgz"): Promise<void> {
  const args = kind === "zip" ? ["-xf", archivePath, "-C", destDir] : ["-xzf", archivePath, "-C", destDir];
  return new Promise((resolveP, rejectP) => {
    const p = spawn(process.platform === "win32" ? "tar.exe" : "tar", args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let err = "";
    p.stderr?.on("data", (c: Buffer) => (err += c.toString("utf8")));
    p.on("error", rejectP);
    p.on("exit", (code) =>
      code === 0 ? resolveP() : rejectP(new Error(`解压失败(tar 退出码 ${code}): ${err}`)),
    );
  });
}

/** Walk the extracted tree for a file named exactly `name` (the release
 *  archives nest the binary under a `ripgrep-<version>-<target>/` dir). */
async function findBinary(dir: string, name: string): Promise<string | null> {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      const hit = await findBinary(full, name);
      if (hit) return hit;
    } else if (e.name === name && statSync(full).size > 0) {
      return full;
    }
  }
  return null;
}

function verifyRg(bin: string): Promise<boolean> {
  return new Promise((resolveP) => {
    const p = spawn(bin, ["--version"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let out = "";
    p.stdout?.on("data", (c: Buffer) => (out += c.toString("utf8")));
    p.on("error", () => resolveP(false));
    p.on("exit", (code) => resolveP(code === 0 && /ripgrep/i.test(out)));
  });
}