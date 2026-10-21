/**
 * OpenCode (v2) CLI resolution — where the GUI provider finds `opencode`.
 *
 * OpenCode v2 = npm 包 `@opencode/cli`（bin: opencode/opencode2，postinstall
 * 拉平台原生二进制）。本机实测（2.1.1，Windows）：
 *   - `where opencode` 命中的是 npm 全局 bin 目录里的 **extensionless bash
 *     shim**（给 git-bash 用）和 `opencode.cmd`（cmd 转发 shim）——两者都
 *     不能被 Node 的 CreateProcess 直接拉起；
 *   - 真正的可执行文件在 `<npm-bin>/node_modules/@opencode/cli/bin/
 *     opencode.exe`（.cmd 里的 `%dp0%\node_modules\@opencode\cli\bin\
 *     opencode.exe` 就是它）。
 *
 * 解析顺序：which("opencode") → 已是 .exe 直接用；否则推导 shim 同目录下
 * 的 npm vendor exe；再否则退 .cmd（serverManager 经 cmd.exe 包装 spawn）。
 * 非 win32 平台 which 结果即真身，直接用。
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { which } from "@main/lib/binaryResolve.js";

let cache: { at: number; path: string | null } | null = null;
const CACHE_MS = 10 * 60_000;

function isExe(p: string): boolean {
  return process.platform !== "win32" || /\.exe$/i.test(p);
}

/** Resolve the opencode CLI executable for direct spawn. Returns null when
 *  not installed. Cached 10min (path changes only on install/uninstall). */
export function resolveOpenCodeCliPath(force = false): string | null {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.path;
  const resolved = resolveNow();
  cache = { at: Date.now(), path: resolved };
  return resolved;
}

function resolveNow(): string | null {
  const onPath = which("opencode");
  if (!onPath) return null;
  if (isExe(onPath)) return onPath;
  // Windows shim (extensionless bash script or .cmd): derive the npm vendor
  // exe sitting in the sibling node_modules tree.
  const dir = dirname(onPath);
  const candidates = [
    join(dir, "node_modules", "@opencode", "cli", "bin", "opencode.exe"),
    join(dir, "opencode.exe"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // Last resort: the .cmd shim itself (spawnable via cmd.exe wrapper).
  const cmd = join(dir, "opencode.cmd");
  if (existsSync(cmd)) return cmd;
  return onPath;
}

/** True when the resolved path needs a cmd.exe wrapper to spawn (Windows
 *  .cmd shim — CreateProcess cannot launch it directly). */
export function openCodePathNeedsShellWrap(p: string): boolean {
  return process.platform === "win32" && !isExe(p);
}
