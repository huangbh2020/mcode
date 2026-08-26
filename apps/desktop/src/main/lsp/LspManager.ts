/**
 * LSP manager - owns the lifecycle of language server processes.
 *
 * Responsibilities:
 *  - Persist per-language config (enabled flag + optional custom path) in the
 *    settings table under `lsp.servers`.
 *  - Install/uninstall servers via the platform package manager (npm/pip/go/
 *    brew), streaming output to an in-memory log the renderer polls via list().
 *  - Detect installed servers via `which()` (PATH lookup).
 *  - Lazily spawn a stdio JSON-RPC server per (workspacePath, language) on
 *    first document open / capability request, run the LSP initialize handshake,
 *    and bridge requests + document-sync notifications.
 *  - Push server notifications (diagnostics / logMessage / state changes) to
 *    the renderer over `lsp:event`.
 *  - Dispose all children on app shutdown.
 *
 * The manager is a module-load singleton (`export const lspManager`), mirroring
 * `TerminalManager` and `BridgeRegistry`. It does no work at construction time;
 * servers start lazily on demand.
 *
 * Security: every `workspacePath` / `filePath` coming from the renderer is
 * validated against known project roots (`isKnownProjectPath` /
 * `findContainingProject`) before being passed to a server, so a compromised
 * renderer can't point a server at arbitrary files.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { readFile, rm, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { request as httpRequest } from "node:https";
import { app } from "electron";
import {
  IPC,
  LSP_SERVERS_SETTING_KEY,
  type LspDiagnostic,
  type LspLanguageId,
  type LspLanguageState,
  type LspOpResult,
  type LspRequestResult,
  type LspServerConfig,
  type LspStateChangedPayload,
} from "@contracts/ipc";
import { log } from "@main/lib/logger.js";
import { sendToRenderer } from "@main/window.js";
import { SettingRepo } from "@main/store/repositories.js";
import { isKnownProjectPath, findContainingProject } from "@main/lib/pathGuard.js";
import { which } from "@main/lib/binaryResolve.js";
import {
  ALL_LANGUAGE_SPECS,
  LANGUAGE_SPECS,
  currentPlatform,
  type LanguageServerSpec,
} from "./languageSpecs.js";

/** JSON-RPC 2.0 message shapes (only the fields we read). */
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: unknown;
}
interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}
type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse;

/** A live language server child process + its JSON-RPC bookkeeping. */
interface ServerHandle {
  proc: ChildProcess;
  workspacePath: string;
  language: LspLanguageId;
  /** Monotonic JSON-RPC request id counter. */
  nextId: number;
  /** Pending request id -> { resolve, reject, timer }. */
  pending: Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >;
  /** Accumulated stdout buffer for Content-Length framing. Kept as a Buffer
   *  because Content-Length is in BYTES, not characters -- using a string
   *  would miscount multi-byte UTF-8 sequences (e.g. Chinese log messages)
   *  and split frames at the wrong position. */
  buffer: Buffer;
  /** Tail of stderr output (for error reporting when the server crashes). */
  stderrTail: string;
  /** URIs the server has been told are open (didOpen sent). */
  openUris: Set<string>;
  /** Resolves once the `initialize`/`initialized` handshake completes. */
  initialized: Promise<void>;
  /** Rejects the initialized promise on handshake failure. */
  initReject: (e: Error) => void;
  /** Resolves the initialized promise on handshake success. */
  initResolve: () => void;
  /** True if we intentionally killed the process (suppress crash recovery). */
  intentionalStop: boolean;
}

/** In-flight install/uninstall per language (so the UI can show progress). */
interface InstallHandle {
  proc: ChildProcess;
  log: string;
}

const REQUEST_TIMEOUT_MS = 60_000;
/** Initialize is given a much longer timeout because Java servers (jdtls)
 *  import the entire project (Maven/Gradle) on first start, which can take
 *  minutes on large projects. */
const INITIALIZE_TIMEOUT_MS = 180_000;
const INSTALL_LOG_MAX = 8192;
/** Max consecutive spawn failures before we stop retrying (prevents an
 *  infinite restart loop when the server can't start -- e.g. missing Java). */
const MAX_SPAWN_FAILURES = 3;
/** Cooldown (ms) after which a failed language may be retried. */
const SPAWN_FAILURE_COOLDOWN_MS = 30_000;

/** `lsp:event` payload shapes (kept here so the manager stays self-contained).
 *  The stateChanged shape is the shared contract type LspStateChangedPayload. */
type LspEventPayload =
  | { uri: string; diagnostics: LspDiagnostic[] }
  | { level: "info" | "warn" | "error"; message: string }
  | LspStateChangedPayload;

class LspManagerImpl {
  /** Keyed by `${workspacePath}::${language}`. */
  private servers = new Map<string, ServerHandle>();
  /** Keyed by language id. */
  private installs = new Map<LspLanguageId, InstallHandle>();
  /** Cached install logs retained after a process exits (truncated). */
  private installLogs = new Map<LspLanguageId, string>();
  /** Last error message from a failed server start (per language). Reset when
   *  the server starts successfully. Shown in the UI so the user knows why. */
  private lastErrors = new Map<LspLanguageId, string>();
  /** Tracks consecutive spawn failures per `${workspacePath}::${language}` to
   *  prevent infinite restart loops when the server can't start. Resets on a
   *  successful init. Value = { count, lastAttempt }. */
  private spawnFailures = new Map<string, { count: number; lastAttempt: number }>();

  /* ───────────────────────── config persistence ───────────────────────── */

  /** Load the persisted config list, merged with defaults for any missing
   *  language. Always returns an entry for every supported language. */
  loadConfig(): LspServerConfig[] {
    const raw = SettingRepo.get(LSP_SERVERS_SETTING_KEY);
    let parsed: LspServerConfig[] = [];
    if (raw) {
      try {
        const v = JSON.parse(raw);
        if (Array.isArray(v)) parsed = v as LspServerConfig[];
      } catch {
        // corrupt - fall through to defaults
      }
    }
    // Merge: ensure every language has an entry; unknown entries dropped.
    const byLang = new Map(parsed.filter((c) => LANGUAGE_SPECS[c.language]).map((c) => [c.language, c]));
    return ALL_LANGUAGE_SPECS.map((spec) => ({
      language: spec.language,
      enabled: byLang.get(spec.language)?.enabled ?? false,
      serverPath: byLang.get(spec.language)?.serverPath,
      args: byLang.get(spec.language)?.args,
    }));
  }

  private saveConfig(configs: LspServerConfig[]): void {
    SettingRepo.set(LSP_SERVERS_SETTING_KEY, JSON.stringify(configs));
  }

  private getConfig(language: LspLanguageId): LspServerConfig | undefined {
    return this.loadConfig().find((c) => c.language === language);
  }

  private updateConfig(language: LspLanguageId, patch: Partial<LspServerConfig>): LspServerConfig[] {
    const configs = this.loadConfig().map((c) =>
      c.language === language ? { ...c, ...patch, language: c.language } : c,
    );
    this.saveConfig(configs);
    return configs;
  }

  /* ───────────────────────── state queries ───────────────────────── */

  /** Build the renderer-facing state list. `installed`/`serverPath` come from
   *  a `which()` probe (cheap enough to run on each list call). */
  async list(): Promise<{ languages: LspLanguageState[] }> {
    const configs = this.loadConfig();
    const languages: LspLanguageState[] = configs.map((c) => {
      const spec = LANGUAGE_SPECS[c.language];
      const resolved = this.resolveServerPath(spec, c);
      const running = this.isLanguageRunning(c.language);
      return {
        language: c.language,
        enabled: c.enabled,
        installed: resolved != null,
        serverPath: resolved,
        running,
        installing: this.installs.has(c.language),
        installLog: this.installLogs.get(c.language) ?? "",
        lastError: running ? "" : (this.lastErrors.get(c.language) ?? ""),
      };
    });
    return { languages };
  }

  /* ───────────────────────── install / uninstall ───────────────────────── */

  async install(language: LspLanguageId): Promise<LspOpResult> {
    if (this.installs.has(language)) {
      return { ok: false, error: "安装已在进行中" };
    }
    const spec = LANGUAGE_SPECS[language];
    const pf = currentPlatform();
    const cmd = spec.install[pf];

    // Java on win/linux has no package-manager entry - use the special download
    // path. darwin falls through to the brew command below.
    if (cmd.length === 0) {
      if (language === "java") {
        return this.installJava();
      }
      return { ok: false, error: `暂不支持在 ${pf} 上安装 ${spec.displayName}` };
    }

    return this.runInstall(language, cmd, () => {
      // post-install: nothing extra for the package-manager languages
    });
  }

  async uninstall(language: LspLanguageId): Promise<LspOpResult> {
    // Stop any running server first.
    await this.stopLanguage(language);
    const spec = LANGUAGE_SPECS[language];
    const pf = currentPlatform();
    const cmd = spec.uninstall[pf];

    if (cmd.length === 0) {
      if (language === "java") {
        return this.uninstallJava();
      }
      return { ok: false, error: `暂不支持在 ${pf} 上卸载 ${spec.displayName}` };
    }

    return this.runInstall(language, cmd, () => {
      // post-uninstall: nothing extra
    });
  }

  /** Install from a user-downloaded archive or binary. For Java, the archive
   *  (tar.gz) is extracted into userData/lsp/java and a launcher shim is
   *  written -- same as the auto-download path. For other languages, the file
   *  is treated as the server binary itself and its path is recorded as a
   *  custom serverPath (so `which()` is bypassed). */
  async installFromFile(language: LspLanguageId, archivePath: string): Promise<LspOpResult> {
    if (!existsSync(archivePath)) {
      return { ok: false, error: `文件不存在: ${archivePath}` };
    }
    const spec = LANGUAGE_SPECS[language];

    if (language === "java") {
      // Extract the tar.gz into the install dir + write launcher shim.
      return this.installJavaFromFile(archivePath);
    }

    // For non-Java languages: treat the selected file as the server binary.
    // Verify it's executable-ish (has a known binary name or no .tar/.zip ext).
    const ext = archivePath.toLowerCase();
    if (ext.endsWith(".tar.gz") || ext.endsWith(".zip") || ext.endsWith(".gz") || ext.endsWith(".7z")) {
      return {
        ok: false,
        error: `${spec.displayName} 的手动安装需要直接选择可执行文件,不支持压缩包。请先解压,再选择解压后的可执行文件。`,
      };
    }

    // Record the path as the custom server path + enable.
    this.updateConfig(language, { enabled: true, serverPath: archivePath });
    this.installLogs.set(language, `从本地文件安装: ${archivePath}\n[exit] code 0`);
    log.info(`lsp: ${language} installed from file: ${archivePath}`);
    return { ok: true };
  }

  /** Extract a user-downloaded jdtls tar.gz into the install dir. */
  private async installJavaFromFile(tarPath: string): Promise<LspOpResult> {
    const destDir = this.javaInstallDir();
    if (existsSync(destDir)) {
      try {
        await removeWithRetry(destDir);
      } catch (err) {
        return { ok: false, error: `无法清除旧目录(可能被占用): ${(err as Error).message}` };
      }
    }
    mkdirSync(destDir, { recursive: true });

    try {
      await new Promise<void>((resolveP, rejectP) => {
        const p = spawn(
          process.platform === "win32" ? "tar.exe" : "tar",
          ["-xzf", tarPath, "-C", destDir],
          { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
        );
        let err = "";
        p.stderr?.on("data", (c: Buffer) => (err += c.toString("utf8")));
        p.on("error", rejectP);
        p.on("exit", (code) =>
          code === 0 ? resolveP() : rejectP(new Error(`tar 退出码 ${code}: ${err}`)),
        );
      });
    } catch (err) {
      return { ok: false, error: `解压失败: ${(err as Error).message}` };
    }

    // Write the launcher shim (same as auto-download).
    const launcherPath = this.javaLauncherPath();
    const launcherContent =
      process.platform === "win32"
        ? `@echo off\r\n"${join(destDir, "bin", "jdtls.bat")}" %*\r\n`
        : `#!/bin/sh\nexec "${join(destDir, "bin", "jdtls")}" "$@"\n`;
    writeFileSync(launcherPath, launcherContent, { mode: 0o755 });

    // Enable Java now that it's installed.
    this.updateConfig("java", { enabled: true });
    this.installLogs.set(
      "java",
      `从本地文件解压 jdtls 到 ${destDir}\n启动器: ${launcherPath}\n[exit] code 0`,
    );
    log.info(`lsp: jdtls installed from file at ${destDir}`);
    return { ok: true };
  }

  /** Run a package-manager command, streaming stdout/stderr to the install log. */
  private runInstall(
    language: LspLanguageId,
    cmd: string[],
    _onDone: () => void,
  ): Promise<LspOpResult> {
    return new Promise((resolveP) => {
      const [exe, ...args] = cmd;
      log.info(`lsp: install ${language}: ${cmd.join(" ")}`);
      const proc = spawn(exe, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: process.platform === "win32",
      });
      const handle: InstallHandle = { proc, log: "" };
      this.installs.set(language, handle);

      const append = (chunk: Buffer | string) => {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        handle.log += text;
        if (handle.log.length > INSTALL_LOG_MAX) {
          handle.log = handle.log.slice(-INSTALL_LOG_MAX);
        }
      };
      proc.stdout?.on("data", append);
      proc.stderr?.on("data", append);

      proc.on("error", (err) => {
        handle.log += `\n[error] ${err.message}\n`;
        this.finishInstall(language, handle);
        resolveP({ ok: false, error: err.message });
      });
      proc.on("exit", (code) => {
        const ok = code === 0;
        handle.log += `\n[exit] code ${code}\n`;
        this.finishInstall(language, handle);
        if (ok) {
          // Verify the binary is now findable.
          const spec = LANGUAGE_SPECS[language];
          const found = this.detectServer(spec);
          resolveP(
            found
              ? { ok: true }
              : { ok: false, error: "安装命令成功完成,但未找到 server 可执行文件(可能需要重启或手动指定路径)" },
          );
        } else {
          resolveP({ ok: false, error: `安装进程退出码 ${code}` });
        }
      });
    });
  }

  private finishInstall(language: LspLanguageId, handle: InstallHandle): void {
    this.installLogs.set(language, handle.log);
    this.installs.delete(language);
  }

  /* ───────────────────────── Java special install path ───────────────────────── */

  /** Download the eclipse.jdt.ls tar.gz from the official mirror and extract it
   *  into `<userData>/lsp/java`. darwin uses brew (handled by the normal path).
   *  Automatically selects the jdtls version compatible with the user's JDK:
   *    - Java 21+ -> jdtls 1.40.0 (latest stable)
   *    - Java 17  -> jdtls 1.37.0 (last version supporting Java 17)
   *    - < Java 17 -> error (jdtls requires at least Java 17) */
  private async installJava(): Promise<LspOpResult> {
    const destDir = this.javaInstallDir();
    if (existsSync(destDir)) {
      try {
        await removeWithRetry(destDir);
      } catch (err) {
        return { ok: false, error: `无法清除旧目录(可能被占用): ${(err as Error).message}` };
      }
    }
    mkdirSync(destDir, { recursive: true });

    // Detect the Java version to pick the right jdtls version. Use the
    // configured javaHome if set, otherwise the system java.
    const config = this.getConfig("java");
    const javaBin = resolveJavaExecutable(config?.javaHome);
    const versionCheck = await checkJavaVersionAtLeast(javaBin, 17);
    if (!versionCheck.ok) {
      const hint =
        versionCheck.version > 0
          ? `当前检测到 Java ${versionCheck.version}。`
          : `未检测到 Java(当前路径: ${javaBin})。`;
      return {
        ok: false,
        error: `${hint}jdtls 至少需要 Java 17。请在"高级"设置中指定 JDK 17+ 的路径(JAVA_HOME),jdtls 自身的运行环境不影响项目的 JDK 版本。`,
      };
    }
    const javaVersion = versionCheck.version;
    // jdtls 1.38.0+ requires Java 21; 1.37.0 is the last version for Java 17.
    const jdtlsVersion = javaVersion >= 21 ? "1.40.0" : "1.37.0";
    log.info(`lsp: detected Java ${javaVersion}, selecting jdtls ${jdtlsVersion}`);

    const baseUrl = `https://download.eclipse.org/jdtls/milestones/${jdtlsVersion}`;

    let tarName: string;
    try {
      tarName = (await this.fetchText(`${baseUrl}/latest.txt`)).trim();
    } catch (err) {
      return { ok: false, error: `无法解析 jdtls 文件名: ${(err as Error).message}` };
    }
    if (!tarName.endsWith(".tar.gz")) {
      return { ok: false, error: `jdtls latest.txt 返回了意外的文件名: ${tarName}` };
    }

    const tarPath = join(destDir, "jdtls.tar.gz");
    log.info(`lsp: downloading jdtls ${tarName} to ${tarPath}`);

    try {
      await this.downloadFile(`${baseUrl}/${tarName}`, tarPath);
    } catch (err) {
      return { ok: false, error: `下载失败: ${(err as Error).message}` };
    }

    // Extract with the system tar (available on all platforms via git-bash on
    // Windows; on win32 we fall back to tar.exe which ships in modern Windows).
    try {
      await new Promise<void>((resolveP, rejectP) => {
        const p = spawn(
          process.platform === "win32" ? "tar.exe" : "tar",
          ["-xzf", tarPath, "-C", destDir],
          { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
        );
        let err = "";
        p.stderr?.on("data", (c: Buffer) => (err += c.toString("utf8")));
        p.on("error", rejectP);
        p.on("exit", (code) =>
          code === 0 ? resolveP() : rejectP(new Error(`tar 退出码 ${code}: ${err}`)),
        );
      });
    } catch (err) {
      return { ok: false, error: `解压失败: ${(err as Error).message}` };
    }

    // Write a small launcher script so `jdtls` is a single command regardless
    // of platform (jdtls ships bin/jdtls on POSIX, bin/jdtls.bat on Windows,
    // but the launcher name varies). We create a shim in destDir.
    const launcherPath = this.javaLauncherPath();
    const launcherContent =
      process.platform === "win32"
        ? `@echo off\r\n"${join(destDir, "bin", "jdtls.bat")}" %*\r\n`
        : `#!/bin/sh\nexec "${join(destDir, "bin", "jdtls")}" "$@"\n`;
    writeFileSync(launcherPath, launcherContent, { mode: 0o755 });

    // Clean up the tarball.
    try {
      await unlinkWithRetry(tarPath);
    } catch {
      // non-fatal
    }

    this.installLogs.set(
      "java",
      `检测到 Java ${javaVersion},选择 jdtls ${jdtlsVersion}\n下载并解压 ${tarName} 到 ${destDir}\n启动器: ${launcherPath}\n[exit] code 0`,
    );
    log.info(`lsp: jdtls installed at ${destDir}`);
    return { ok: true };
  }

  private async uninstallJava(): Promise<LspOpResult> {
    const destDir = this.javaInstallDir();
    if (!existsSync(destDir)) return { ok: true };
    try {
      await removeWithRetry(destDir);
      this.installLogs.set("java", "已删除 jdtls 目录\n[exit] code 0");
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `删除失败: ${(err as Error).message}` };
    }
  }

  private javaInstallDir(): string {
    return join(app.getPath("userData"), "lsp", "java");
  }

  private javaLauncherPath(): string {
    return process.platform === "win32"
      ? join(this.javaInstallDir(), "jdtls.cmd")
      : join(this.javaInstallDir(), "jdtls");
  }

  /** Download `url` to `dest` with redirect handling. */
  private downloadFile(url: string, dest: string): Promise<void> {
    return new Promise((resolveP, rejectP) => {
      const tryFetch = (u: string, redirectsLeft: number) => {
        const stream = createWriteStream(dest);
        const req = httpRequest(u, (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            stream.close();
            if (redirectsLeft <= 0) return rejectP(new Error("重定向次数过多"));
            return tryFetch(res.headers.location, redirectsLeft - 1);
          }
          if (res.statusCode !== 200) {
            stream.close();
            return rejectP(new Error(`HTTP ${res.statusCode}`));
          }
          // res is an http.IncomingMessage, which is already a Node Readable
          // stream - pipe directly to the file.
          res.pipe(stream);
          stream.on("finish", () => resolveP());
          stream.on("error", rejectP);
        });
        req.on("error", rejectP);
        req.end();
      };
      tryFetch(url, 5);
    });
  }

  /** Fetch a small text resource (e.g. latest.txt) with redirect handling. */
  private fetchText(url: string): Promise<string> {
    return new Promise((resolveP, rejectP) => {
      const tryFetch = (u: string, redirectsLeft: number) => {
        const req = httpRequest(u, (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            if (redirectsLeft <= 0) return rejectP(new Error("重定向次数过多"));
            return tryFetch(res.headers.location, redirectsLeft - 1);
          }
          if (res.statusCode !== 200) {
            return rejectP(new Error(`HTTP ${res.statusCode}`));
          }
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => (body += chunk));
          res.on("end", () => resolveP(body));
        });
        req.on("error", rejectP);
        req.end();
      };
      tryFetch(url, 5);
    });
  }

  /* ───────────────────────── enable / disable / path ───────────────────────── */

  async toggle(
    language: LspLanguageId,
    enabled: boolean,
  ): Promise<{ languages: LspLanguageState[] }> {
    this.updateConfig(language, { enabled });
    if (enabled) {
      // Re-enabling clears the crash-loop guard so the user can retry after
      // fixing the environment (e.g. upgrading Java).
      this.clearSpawnFailures(language);
    } else {
      // Disabling kills any running server for this language.
      await this.stopLanguage(language);
    }
    return this.list();
  }

  async setPath(
    language: LspLanguageId,
    serverPath?: string,
    args?: string[],
    javaHome?: string,
  ): Promise<{ languages: LspLanguageState[] }> {
    // Restart any running server so it picks up the new path.
    await this.stopLanguage(language);
    // Clear the crash-loop guard so the new path gets a fresh chance.
    this.clearSpawnFailures(language);
    this.updateConfig(language, {
      serverPath: serverPath?.trim() || undefined,
      args: args && args.length > 0 ? args : undefined,
      javaHome: javaHome?.trim() || undefined,
    });
    return this.list();
  }

  /** Restart a language server for one workspace: stop any live process, clear
   *  the crash-loop guard, then immediately relaunch (rather than waiting for
   *  the next openDocument/request) so the toolbar pill visibly goes through
   *  starting → running/stopped. Invoked when the user clicks a startup-failure
   *  notice after fixing the environment. */
  async restart(
    workspacePath: string,
    language: LspLanguageId,
  ): Promise<LspOpResult> {
    this.assertWorkspace(workspacePath);
    const key = serverKey(workspacePath, language);
    // Give the server a fresh chance — the crash-loop guard would otherwise
    // refuse another attempt for SPAWN_FAILURE_COOLDOWN_MS.
    this.clearSpawnFailures(language);
    const existing = this.servers.get(key);
    if (existing && !existing.proc.killed && existing.proc.exitCode === null) {
      this.removeServer(key, existing);
    }
    try {
      await this.ensureServer(workspacePath, language);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /* ───────────────────────── health check ───────────────────────── */

  async healthCheck(language: LspLanguageId): Promise<LspOpResult> {
    const spec = LANGUAGE_SPECS[language];
    const config = this.getConfig(language);
    const resolved = this.resolveServerPath(spec, config);

    // Java needs a JDK too.
    if (language === "java") {
      const javaOk = await this.checkJavaRuntime(language);
      if (!javaOk.ok) return javaOk;
    }

    if (!resolved) {
      return {
        ok: false,
        error: `未找到 ${spec.displayName} 可执行文件(${spec.binaryNames.join(" / ")}),请先安装或在高级中指定路径`,
      };
    }
    // Probe with --version (most servers support it; gopls uses -h).
    const probeArgs = language === "go" ? ["version"] : ["--version"];
    return new Promise<LspOpResult>((resolveP) => {
      const p = spawn(resolved, probeArgs, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: process.platform === "win32",
      });
      let out = "";
      p.stdout?.on("data", (c: Buffer) => (out += c.toString("utf8")));
      p.stderr?.on("data", (c: Buffer) => (out += c.toString("utf8")));
      p.on("error", (err) => resolveP({ ok: false, error: err.message }));
      p.on("exit", (code) => {
        if (code === 0) {
          resolveP({ ok: true });
        } else {
          // Some servers exit non-zero on --version but still work; treat any
          // output as a soft pass.
          resolveP(out.trim() ? { ok: true } : { ok: false, error: `退出码 ${code}` });
        }
      });
    });
  }

  private async checkJavaRuntime(language: LspLanguageId): Promise<LspOpResult> {
    // Use the user's configured javaHome if set for this language.
    const config = this.getConfig(language);
    const javaBin = resolveJavaExecutable(config?.javaHome);
    const check = await checkJavaVersionAtLeast(javaBin, 17);
    if (!check.ok) {
      if (check.version === 0) {
        return {
          ok: false,
          error: `未找到 java 或无法获取版本。Java 语言服务器需要 JDK 17+(当前: ${javaBin})。可在高级设置中指定 JDK 17+ 的路径。`,
        };
      }
      return {
        ok: false,
        error: `Java 版本过低:当前 Java ${check.version},jdtls 要求 Java 17+。请安装 JDK 17+ 并在高级设置中指定其路径(不影响项目本身的 JDK)。`,
      };
    }
    return { ok: true };
  }

  /* ───────────────────────── binary detection ───────────────────────── */

  /** Probe binaryNames via which(), honoring a user override. Returns the
   *  resolved path or null. For Java, also checks the in-app install dir. */
  private detectServer(spec: LanguageServerSpec): string | null {
    // Java: prefer the in-app launcher shim, then PATH.
    if (spec.language === "java") {
      const launcher = this.javaLauncherPath();
      if (existsSync(launcher)) return launcher;
    }
    for (const name of spec.binaryNames) {
      const found = which(name);
      if (found) return found;
    }
    return null;
  }

  /** Resolve the server path for a config: user override > detection. */
  private resolveServerPath(spec: LanguageServerSpec, config?: LspServerConfig): string | null {
    if (config?.serverPath && config.serverPath.trim()) {
      const p = config.serverPath.trim();
      if (existsSync(p)) return p;
    }
    return this.detectServer(spec);
  }

  /* ───────────────────────── document sync ───────────────────────── */

  async openDocument(
    workspacePath: string,
    filePath: string,
    language: LspLanguageId,
  ): Promise<void> {
    this.assertPaths(workspacePath, filePath);
    const spec = LANGUAGE_SPECS[language];
    const handle = await this.ensureServer(workspacePath, language);

    const uri = filePathToUri(filePath);
    if (handle.openUris.has(uri)) return;
    handle.openUris.add(uri);

    // Read the file content for didOpen. We trust the renderer's model content
    // is the source of truth, but for the initial open we read from disk so the
    // server and the file agree before the first didChange.
    let text = "";
    try {
      text = await readFile(filePath, "utf8");
    } catch {
      // file may be unsaved/new - send empty content
    }
    const languageId = spec.languageId;
    this.sendNotify(handle, "textDocument/didOpen", {
      textDocument: { uri, languageId, version: 1, text },
    });

    // Background warm-up: several servers (typescript-language-server in
    // particular) lazily load the project on the FIRST workspace query — the
    // user's first F12 / Ctrl+F12 / hover would otherwise pay that whole
    // latency interactively. Fire a cheap documentSymbol request right after
    // open so the load happens while the user is still reading the file.
    // Best-effort: errors are swallowed; the request timeout bounds it and
    // removeServer rejects pending entries if the server dies meanwhile.
    void this.sendRequest(handle, "textDocument/documentSymbol", {
      textDocument: { uri },
    }).catch(() => {});
  }

  async closeDocument(workspacePath: string, filePath: string): Promise<void> {
    this.assertPaths(workspacePath, filePath);
    const key = serverKey(workspacePath, this.languageForFile(filePath));
    const handle = this.servers.get(key);
    if (!handle) return;
    const uri = filePathToUri(filePath);
    if (!handle.openUris.has(uri)) return;
    handle.openUris.delete(uri);
    this.sendNotify(handle, "textDocument/didClose", { textDocument: { uri } });
  }

  async didChange(
    workspacePath: string,
    filePath: string,
    text: string,
    version: number,
  ): Promise<void> {
    this.assertPaths(workspacePath, filePath);
    const language = this.languageForFile(filePath);
    if (!language) return;
    const handle = this.servers.get(serverKey(workspacePath, language));
    if (!handle) return;
    const uri = filePathToUri(filePath);
    this.sendNotify(handle, "textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
  }

  async didSave(workspacePath: string, filePath: string, text: string): Promise<void> {
    this.assertPaths(workspacePath, filePath);
    const language = this.languageForFile(filePath);
    if (!language) return;
    const handle = this.servers.get(serverKey(workspacePath, language));
    if (!handle) return;
    const uri = filePathToUri(filePath);
    this.sendNotify(handle, "textDocument/didSave", { textDocument: { uri }, text });
  }

  /* ───────────────────────── capability requests ───────────────────────── */

  async request(
    workspacePath: string,
    language: LspLanguageId,
    method: string,
    params: unknown,
  ): Promise<LspRequestResult> {
    this.assertWorkspace(workspacePath);
    const handle = await this.ensureServer(workspacePath, language);
    try {
      const result = await this.sendRequest(handle, method, params);
      return { result };
    } catch (err) {
      const e = err as { code?: number; message: string };
      return { error: { code: e.code ?? -32603, message: e.message } };
    }
  }

  /* ───────────────────────── server lifecycle ───────────────────────── */

  /** Build the spawn command for a language server. Most languages use the
   *  spec's startCommand + user args. Java is special: jdtls is an Eclipse
   *  Equinox application launched via `java -jar org.eclipse.equinox.launcher_*.
   *  jar`. We bypass the Python launcher script entirely because it doesn't
   *  reliably forward stdio pipes on Windows. */
  private async buildSpawnCommand(
    spec: LanguageServerSpec,
    resolved: string,
    workspacePath: string,
    config: LspServerConfig | undefined,
  ): Promise<{ cmd: string; args: string[]; spawnOpts: { shell?: boolean } }> {
    const userArgs = config?.args ?? [];

    if (spec.language === "java") {
      return this.buildJavaSpawnCommand(workspacePath, userArgs, config?.javaHome);
    }

    // Default: use the spec's startCommand.
    const { cmd, args } = spec.startCommand(resolved);
    return {
      cmd,
      args: [...args, ...userArgs],
      spawnOpts: { shell: process.platform === "win32" },
    };
  }

  /** Construct the Java command line to launch jdtls directly via the Equinox
   *  launcher. This mirrors what the Python `bin/jdtls` script does but without
   *  the stdio-pipe issues of nested process spawning.
   *  @param javaHome Optional override JDK home (JAVA_HOME). When set, jdtls
   *         runs with this JDK instead of the system `java`. This lets users
   *         whose project targets Java 8 run jdtls with a separate Java 17+.
   *  @throws if the Java version is < 17 (jdtls 1.37.0 requirement). */
  private async buildJavaSpawnCommand(
    workspacePath: string,
    userArgs: string[],
    javaHome?: string,
  ): Promise<{ cmd: string; args: string[]; spawnOpts: { shell?: boolean } }> {
    const installDir = this.javaInstallDir();

    // Per-workspace data directory.
    const dataDir = join(installDir, "workspaces", hashPath(workspacePath));
    mkdirSync(dataDir, { recursive: true });

    // Find the equinox launcher jar (version varies per release).
    const launcherJar = findLauncherJar(join(installDir, "plugins"));

    // Platform-specific config directory.
    const configDir = join(installDir, javaConfigDir());

    // Resolve the Java executable. If javaHome is set (user override), use
    // that JDK; otherwise fall back to JAVA_HOME env or `java` on PATH.
    const javaBin = resolveJavaExecutable(javaHome);

    // Verify Java version >= 17 BEFORE spawning (jdtls 1.37.0 requires Java 17;
    // if we let it start with an older JDK the bundles fail to resolve and the
    // server exits silently with code 0, which is very hard to debug).
    const versionOk = await checkJavaVersionAtLeast(javaBin, 17);
    if (!versionOk.ok) {
      throw new Error(
        `Java 版本过低。jdtls 要求 Java 17+,但当前${versionOk.version ? `是 Java ${versionOk.version}` : "无法确定版本"}。` +
          `请安装 JDK 17+ 并确保 JAVA_HOME 或 PATH 指向它。`,
      );
    }

    const args = [
      "-Declipse.application=org.eclipse.jdt.ls.core.id1",
      "-Dosgi.bundles.defaultStartLevel=4",
      "-Declipse.product=org.eclipse.jdt.ls.core.product",
      "-Dlog.level=ALL",
      "-Xmx1G",
      "--add-modules=ALL-SYSTEM",
      "--add-opens", "java.base/java.util=ALL-UNNAMED",
      "--add-opens", "java.base/java.lang=ALL-UNNAMED",
      "-jar", launcherJar,
      "-configuration", configDir,
      "-data", dataDir,
      ...userArgs,
    ];

    return { cmd: javaBin, args, spawnOpts: { shell: false } };
  }

  /** Lazily spawn (or reuse) the server for (workspacePath, language). Throws
   *  if the language is disabled, the server binary isn't found, or the server
   *  has failed to start too many times recently (crash-loop guard). */
  private async ensureServer(workspacePath: string, language: LspLanguageId): Promise<ServerHandle> {
    this.assertWorkspace(workspacePath);
    const key = serverKey(workspacePath, language);
    const existing = this.servers.get(key);
    if (existing && !existing.proc.killed && existing.proc.exitCode === null) {
      await existing.initialized;
      return existing;
    }

    // Crash-loop guard: if the server failed to start MAX_SPAWN_FAILURES times
    // recently, refuse until the cooldown expires. This prevents an infinite
    // restart loop (e.g. jdtls with an incompatible Java version).
    const failure = this.spawnFailures.get(key);
    if (failure && failure.count >= MAX_SPAWN_FAILURES) {
      const elapsed = Date.now() - failure.lastAttempt;
      if (elapsed < SPAWN_FAILURE_COOLDOWN_MS) {
        const lastErr = this.lastErrors.get(language);
        const detail = lastErr ? `\n原因: ${lastErr}` : "";
        const message = `${LANGUAGE_SPECS[language].displayName} 语言服务器连续启动失败 ${failure.count} 次,已暂停重试。${detail}\n请修复环境后在设置中关闭再重新启用。`;
        // Surface the refusal to the editor toolbar (no server ever spawned).
        this.pushStateEvent(workspacePath, language, {
          phase: "stopped",
          running: false,
          error: message,
        });
        throw new Error(message);
      }
      // Cooldown expired - reset and try again.
      this.spawnFailures.delete(key);
    }

    const config = this.getConfig(language);
    if (!config?.enabled) {
      // Opted-out language: no event — the user disabled it deliberately, so
      // the toolbar shows nothing rather than nagging.
      throw new Error(`${LANGUAGE_SPECS[language].displayName} 语言服务器未启用。请在设置 > 语言服务器中开启。`);
    }
    const spec = LANGUAGE_SPECS[language];
    const resolved = this.resolveServerPath(spec, config);
    if (!resolved) {
      const message = `未找到 ${spec.displayName} 可执行文件(${spec.binaryNames.join(" / ")}),请先安装或指定路径`;
      this.pushStateEvent(workspacePath, language, {
        phase: "stopped",
        running: false,
        error: message,
      });
      throw new Error(message);
    }

    const { cmd, args, spawnOpts } = await this.buildSpawnCommand(spec, resolved, workspacePath, config);
    log.info(`lsp: starting ${language} for ${workspacePath}: ${cmd} ${args.join(" ")}`);
    const proc = spawn(cmd, args, {
      cwd: workspacePath,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      ...spawnOpts,
    });

    let initResolve!: () => void;
    let initReject!: (e: Error) => void;
    const initialized = new Promise<void>((res, rej) => {
      initResolve = res;
      initReject = rej;
    });
    // Attach a no-op catch so a rejected-but-unawaited initialized promise
    // (e.g. proc dies before anyone awaits) doesn't trigger unhandledRejection.
    initialized.catch(() => {});

    const handle: ServerHandle = {
      proc,
      workspacePath,
      language,
      nextId: 1,
      pending: new Map(),
      buffer: Buffer.alloc(0),
      stderrTail: "",
      openUris: new Set(),
      initialized,
      initReject,
      initResolve,
      intentionalStop: false,
    };
    this.servers.set(key, handle);
    // The initialize handshake can take minutes (Java imports the whole
    // project) — tell the renderer the server is STARTING so the editor can
    // show a loading state while requests wait on `initialized`.
    this.pushEvent(handle, "stateChanged", { phase: "starting", running: false });

    proc.stdout?.on("data", (chunk: Buffer) => this.onStdout(handle, chunk));
    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      const trimmed = text.trim();
      if (trimmed) {
        log.info(`lsp[${language}] stderr: ${trimmed}`);
        this.pushEvent(handle, "log", { level: "info", message: trimmed });
      }
      // Accumulate the tail for error reporting (keep last ~2KB).
      handle.stderrTail = (handle.stderrTail + text).slice(-2048);
    });
    proc.on("error", (err) => {
      // A restart may have already swapped this slot for a fresh handle —
      // never tear down or report on a server we no longer own.
      if (this.servers.get(key) !== handle) return;
      log.error(`lsp[${language}] spawn error: ${err.message}`);
      this.lastErrors.set(language, err.message);
      handle.initReject(err);
      this.recordSpawnFailure(key);
      this.removeServer(key, handle);
      this.pushStateEvent(workspacePath, language, {
        phase: "stopped",
        running: false,
        error: err.message,
      });
    });
    proc.on("exit", (code, signal) => {
      log.info(`lsp[${language}] exit code=${code} signal=${signal}`);
      // A restart can replace this handle in `servers` before the old process
      // actually exits. Only act on the handle that still owns the slot; a
      // slot that is already free was torn down intentionally (toggle/setPath/
      // restart/dispose) — just clear any lingering "starting" indicator.
      const current = this.servers.get(key);
      if (current === undefined) {
        this.pushStateEvent(workspacePath, language, {
          phase: "stopped",
          running: false,
          error: undefined,
        });
        return;
      }
      if (current !== handle) return;
      // If the process exits before initialization completes, it's a crash.
      // Store the stderr tail as the last error so the user can see why.
      const wasInitializing = !handle.intentionalStop;
      if (wasInitializing && handle.stderrTail.trim()) {
        this.lastErrors.set(language, extractLastError(handle.stderrTail));
      }
      this.removeServer(key, handle);
      if (wasInitializing) {
        this.recordSpawnFailure(key);
      }
      // Always notify: both crashes (with the recorded reason) and intentional
      // stops (settings toggle / dispose) clear any "starting" indicator.
      this.pushStateEvent(workspacePath, language, {
        phase: "stopped",
        running: false,
        error: wasInitializing ? this.lastErrors.get(language) : undefined,
      });
    });

    // Run the initialize handshake.
    try {
      log.info(`lsp[${language}]: sending initialize (timeout ${INITIALIZE_TIMEOUT_MS / 1000}s)`);
      await this.initialize(handle);
      log.info(`lsp[${language}]: initialized successfully`);
      initResolve();
      // Success - clear any prior failure count + error.
      this.spawnFailures.delete(key);
      this.lastErrors.delete(language);
      this.pushEvent(handle, "stateChanged", { phase: "running", running: true });
      return handle;
    } catch (err) {
      log.error(`lsp[${language}]: initialize failed: ${(err as Error).message}`);
      initReject(err as Error);
      this.lastErrors.set(language, (err as Error).message);
      this.recordSpawnFailure(key);
      // A concurrent restart may have swapped this slot for a fresh handle;
      // only tear down the one this initialize flow still owns.
      if (this.servers.get(key) === handle) {
        this.removeServer(key, handle);
        this.pushStateEvent(workspacePath, language, {
          phase: "stopped",
          running: false,
          error: (err as Error).message,
        });
      }
      throw err;
    }
  }

  /** Record a spawn failure for the crash-loop guard. */
  private recordSpawnFailure(key: string): void {
    const prev = this.spawnFailures.get(key);
    this.spawnFailures.set(key, {
      count: (prev?.count ?? 0) + 1,
      lastAttempt: Date.now(),
    });
  }

  /** Clear the crash-loop guard for a language (all workspaces). Called when
   *  the user re-enables the language or changes the server path, giving the
   *  server a fresh chance to start. */
  private clearSpawnFailures(language: LspLanguageId): void {
    for (const key of this.spawnFailures.keys()) {
      if (key.endsWith(`::${language}`)) {
        this.spawnFailures.delete(key);
      }
    }
  }

  /** Send `initialize` + `initialized` notification. */
  private async initialize(handle: ServerHandle): Promise<void> {
    const rootUri = dirPathToUri(handle.workspacePath);
    const spec = LANGUAGE_SPECS[handle.language];
    const result = (await this.sendRequest(handle, "initialize", {
      processId: process.pid,
      clientInfo: { name: "mcode", version: "1.0" },
      rootUri,
      capabilities: {
        textDocument: {
          synchronization: { didOpen: true, didChange: true, didClose: true, didSave: true },
          hover: { contentFormat: ["markdown", "plaintext"] },
          definition: { linkSupport: false },
          references: {},
          publishDiagnostics: { relatedInformation: false },
        },
        workspace: {
          workspaceEdit: {},
          didChangeConfiguration: {},
        },
      },
      initializationOptions: spec.initOptions ?? {},
    }, INITIALIZE_TIMEOUT_MS)) as { capabilities?: unknown } | null;
    void result; // capabilities acknowledged; we proceed regardless
    this.sendNotify(handle, "initialized", {});
  }

  /** Stop all servers for a language (any workspace). */
  private async stopLanguage(language: LspLanguageId): Promise<void> {
    const keys: string[] = [];
    for (const [key, handle] of this.servers) {
      if (handle.language === language) keys.push(key);
    }
    for (const key of keys) {
      const handle = this.servers.get(key);
      if (handle) this.removeServer(key, handle);
    }
  }

  /** Kill + forget a server. Idempotent. */
  private removeServer(key: string, handle: ServerHandle): void {
    handle.intentionalStop = true;
    // Reject any pending requests.
    for (const [id, entry] of handle.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error("language server stopped"));
      void id;
    }
    handle.pending.clear();
    try {
      handle.proc.kill();
    } catch {
      // already dead
    }
    this.servers.delete(key);
  }

  /** True if any server for this language is alive. */
  private isLanguageRunning(language: LspLanguageId): boolean {
    for (const handle of this.servers.values()) {
      if (handle.language === language && !handle.proc.killed && handle.proc.exitCode === null) {
        return true;
      }
    }
    return false;
  }

  /** Kill every server (app shutdown). Best-effort; swallows errors. */
  disposeAll(): void {
    for (const [key, handle] of [...this.servers]) {
      this.removeServer(key, handle);
    }
    for (const [, install] of this.installs) {
      try {
        install.proc.kill();
      } catch {
        // ignore
      }
    }
    this.installs.clear();
    log.info("lsp: disposed all servers");
  }

  /* ───────────────────────── JSON-RPC transport ───────────────────────── */

  /** Send a request and await its response (with a timeout). */
  private sendRequest(
    handle: ServerHandle,
    method: string,
    params: unknown,
    timeoutMs: number = REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    return new Promise((resolveP, rejectP) => {
      if (!handle.proc.stdin || handle.proc.stdin.destroyed) {
        rejectP(new Error("language server stdin closed"));
        return;
      }
      const id = handle.nextId++;
      const timer = setTimeout(() => {
        const entry = handle.pending.get(id);
        if (entry) {
          handle.pending.delete(id);
          entry.reject(new Error(`LSP 请求超时: ${method}`));
        }
      }, timeoutMs);
      handle.pending.set(id, { resolve: resolveP, reject: rejectP, timer });
      this.writeMessage(handle.proc.stdin, { jsonrpc: "2.0", id, method, params });
    });
  }

  /** Send a notification (no response expected). */
  private sendNotify(handle: ServerHandle, method: string, params: unknown): void {
    if (!handle.proc.stdin || handle.proc.stdin.destroyed) return;
    this.writeMessage(handle.proc.stdin, { jsonrpc: "2.0", method, params });
  }

  /** Send a response to a server-initiated request (carries the matching id).
   *  Used for requests like workspace/configuration that the server expects a
   *  reply to - without it the server would hang. */
  private sendResponse(handle: ServerHandle, id: number | string, result: unknown): void {
    if (!handle.proc.stdin || handle.proc.stdin.destroyed) return;
    this.writeMessage(handle.proc.stdin, { jsonrpc: "2.0", id, result });
  }

  /** Write a single JSON-RPC message framed with Content-Length. */
  private writeMessage(stream: NodeJS.WritableStream, msg: JsonRpcMessage): void {
    const body = JSON.stringify(msg);
    const header = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n`;
    stream.write(header + body, "utf8");
  }

  /** Accumulate stdout chunks (as a Buffer) and split on Content-Length frames.
   *  CRITICAL: Content-Length is in BYTES, so we must operate on the Buffer,
   *  not a string -- a string would miscount multi-byte UTF-8 and split frames
   *  mid-character (manifesting as "unparseable message" warnings). */
  private onStdout(handle: ServerHandle, chunk: Buffer): void {
    handle.buffer = Buffer.concat([handle.buffer, chunk]);
    // The header/body separator is the byte sequence \r\n\r\n.
    const SEP = Buffer.from("\r\n\r\n", "utf8");
    let sepIdx: number;
    while ((sepIdx = handle.buffer.indexOf(SEP)) !== -1) {
      const headerBuf = handle.buffer.subarray(0, sepIdx);
      const headerStr = headerBuf.toString("utf8");
      const lengthMatch = headerStr.match(/Content-Length:\s*(\d+)/i);
      if (!lengthMatch) {
        // Malformed frame - drop the header and continue.
        handle.buffer = handle.buffer.subarray(sepIdx + SEP.length);
        continue;
      }
      const length = parseInt(lengthMatch[1], 10);
      const bodyStart = sepIdx + SEP.length;
      if (handle.buffer.length - bodyStart < length) {
        // Not enough bytes yet; wait for more.
        break;
      }
      const body = handle.buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      handle.buffer = handle.buffer.subarray(bodyStart + length);
      this.onMessage(handle, body);
    }
  }

  /** Dispatch a parsed JSON-RPC message. */
  private onMessage(handle: ServerHandle, body: string): void {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(body) as JsonRpcMessage;
    } catch {
      log.warn(`lsp[${handle.language}]: unparseable message: ${body.slice(0, 200)}`);
      return;
    }

    // Response to a pending request.
    if ("id" in msg && ("result" in msg || "error" in msg) && !("method" in msg)) {
      const resp = msg as JsonRpcResponse;
      const id = typeof resp.id === "number" ? resp.id : parseInt(String(resp.id), 10);
      const entry = handle.pending.get(id);
      if (entry) {
        clearTimeout(entry.timer);
        handle.pending.delete(id);
        if (resp.error) {
          log.info(`lsp[${handle.language}]: response id=${id} error: ${resp.error.message}`);
          entry.reject(Object.assign(new Error(resp.error.message), { code: resp.error.code }));
        } else {
          log.info(`lsp[${handle.language}]: response id=${id} ok`);
          entry.resolve(resp.result);
        }
      }
      return;
    }

    // Notification or server-initiated request.
    const req = msg as JsonRpcRequest;
    switch (req.method) {
      case "textDocument/publishDiagnostics":
        this.pushEvent(handle, "diagnostics", req.params as LspEventPayload);
        break;
      case "window/logMessage":
      case "window/showMessage": {
        const p = (req.params ?? {}) as { message?: string; type?: number };
        const level = p.type === 1 ? "error" : p.type === 2 ? "warn" : "info";
        this.pushEvent(handle, "log", { level, message: p.message ?? "" });
        break;
      }
      case "$/cancelRequest":
        // We don't support server-initiated cancellation.
        break;
      default:
        // Other server-initiated requests (e.g. workspace/configuration) get a
        // response so the server doesn't hang. workspace/configuration expects
        // an array (one entry per requested item); others get null.
        if (req.id !== undefined) {
          const result = req.method === "workspace/configuration" ? [null] : null;
          this.sendResponse(handle, req.id, result);
        }
        break;
    }
  }

  /* ───────────────────────── helpers ───────────────────────── */

  /** Push an lsp:event to the renderer. No-op if the window is gone. */
  private pushEvent(handle: ServerHandle, type: "diagnostics" | "log" | "stateChanged", payload: LspEventPayload): void {
    sendToRenderer(IPC.LSP_EVENT, {
      channel: IPC.LSP_EVENT,
      workspacePath: handle.workspacePath,
      language: handle.language,
      type,
      payload,
    } as const);
  }

  /** Push a stateChanged event for a (workspace, language) that has no live
   *  ServerHandle yet — used for pre-spawn refusals (crash-loop guard,
   *  binary not found) so the editor toolbar can surface WHY the server
   *  won't start. */
  private pushStateEvent(
    workspacePath: string,
    language: LspLanguageId,
    payload: LspStateChangedPayload,
  ): void {
    sendToRenderer(IPC.LSP_EVENT, {
      channel: IPC.LSP_EVENT,
      workspacePath,
      language,
      type: "stateChanged",
      payload,
    } as const);
  }

  /** Determine the LSP language id for a file path (null = unsupported). */
  private languageForFile(filePath: string): LspLanguageId | null {
    const ext = extnameLower(filePath);
    for (const spec of ALL_LANGUAGE_SPECS) {
      if (spec.extensions.includes(ext)) return spec.language;
    }
    return null;
  }

  /** Security: workspacePath must be a known project root. */
  private assertWorkspace(workspacePath: string): void {
    if (!isKnownProjectPath(workspacePath)) {
      throw new Error(`工作区路径不是已知项目: ${workspacePath}`);
    }
  }

  /** Security: workspacePath must be a known project root AND filePath must
   *  live inside SOME known project root. */
  private assertPaths(workspacePath: string, filePath: string): void {
    this.assertWorkspace(workspacePath);
    const containing = findContainingProject(filePath);
    if (!containing) {
      throw new Error(`文件路径不在任何已知项目内: ${filePath}`);
    }
  }
}

export const lspManager = new LspManagerImpl();

/* ───────────────────────── path / uri helpers ───────────────────────── */

/** Lowercased extension with leading dot (e.g. ".ts"). */
function extnameLower(p: string): string {
  const i = p.lastIndexOf(".");
  if (i === -1) return "";
  return p.slice(i).toLowerCase();
}

/** Extract the most useful error line from a server's stderr output. Looks
 *  for lines containing "Error"/"Exception" (Python/Java tracebacks) or the
 *  last non-empty line as a fallback. Returns a single-line summary. */
function extractLastError(stderr: string): string {
  const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return "";
  // Prefer lines that look like the actual error message.
  const errorLine = lines.find((l) => /^(Error|Exception|Traceback|raise|FATAL)/i.test(l))
    ?? lines.find((l) => /error|exception|requires|not found|cannot|failed/i.test(l));
  if (errorLine) {
    // Strip Python traceback prefixes like "raise Exception(...)" -> "..."
    const cleaned = errorLine.replace(/^raise\s+/i, "").replace(/^Exception\(["']?/, "").replace(/["']?\)$/, "");
    return cleaned;
  }
  // Fallback: last line.
  return lines[lines.length - 1];
}

/** Remove a file or directory with retries. On Windows, AV scans and pending
 *  file handles can briefly lock files, causing EPERM/EBUSY on the first
 *  attempt. We retry a few times with increasing delay before giving up.
 *  Resolves on success, rejects with the last error. */
async function removeWithRetry(target: string): Promise<void> {
  const MAX_ATTEMPTS = 5;
  const BASE_DELAY_MS = 200;
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      // Prefer rm (works for both files and directories). If the target is
      // already gone, treat as success.
      await rm(target, { recursive: true, force: true });
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return; // already gone
      // EPERM / EBUSY / ENOTEMPTY -- retry after delay.
      if (attempt < MAX_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, BASE_DELAY_MS * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

/** Delete a single file with retries (same rationale as removeWithRetry). */
async function unlinkWithRetry(target: string): Promise<void> {
  const MAX_ATTEMPTS = 5;
  const BASE_DELAY_MS = 200;
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      await unlink(target);
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return; // already gone
      if (attempt < MAX_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, BASE_DELAY_MS * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

/** Convert an absolute file path to a `file://` URI (LSP convention). */
function filePathToUri(p: string): string {
  // Normalize backslashes to forward slashes for Windows paths.
  const norm = p.replace(/\\/g, "/");
  // Windows absolute paths need a leading slash before the drive letter.
  const prefixed = /^[a-zA-Z]:/.test(norm) ? `/${norm}` : norm;
  return `file://${prefixed}`;
}

/** Convert a directory path to a `file://` URI (for rootUri). */
function dirPathToUri(p: string): string {
  return filePathToUri(p) + "/";
}

/** Build the server map key. */
function serverKey(workspacePath: string, language: LspLanguageId | null): string {
  return `${resolve(workspacePath)}::${language ?? "_"}`;
}

/** Hash a path to a short hex string (for workspace data dir naming). */
function hashPath(p: string): string {
  let h = 0;
  for (let i = 0; i < p.length; i++) {
    h = ((h << 5) - h + p.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(16);
}

/** Find the equinox launcher jar in the jdtls plugins directory. There's
 *  exactly one `org.eclipse.equinox.launcher_<version>.jar` (the platform-
 *  specific fragments are separate). Returns the full path or throws. */
function findLauncherJar(pluginsDir: string): string {
  const entries = readdirSync(pluginsDir);
  const jar = entries.find((e) => /^org\.eclipse\.equinox\.launcher_\d/.test(e));
  if (!jar) throw new Error(`未在 ${pluginsDir} 中找到 equinox launcher jar`);
  return join(pluginsDir, jar);
}

/** The platform-specific config directory name for jdtls. */
function javaConfigDir(): string {
  switch (process.platform) {
    case "win32":
      return "config_win";
    case "darwin":
      return process.arch === "arm64" ? "config_mac_arm" : "config_mac";
    default:
      return process.arch === "arm64" ? "config_linux_arm" : "config_linux";
  }
}

/** Resolve the Java executable path. Priority: explicit override >
 *  JAVA_HOME/bin/java > `java` on PATH. */
function resolveJavaExecutable(javaHomeOverride?: string): string {
  const home = javaHomeOverride || process.env.JAVA_HOME;
  if (home) {
    const exe = join(home, "bin", process.platform === "win32" ? "java.exe" : "java");
    if (existsSync(exe)) return exe;
  }
  return which("java") ?? "java";
}

/** Check that the Java at `javaBin` is at least `minMajor` (e.g. 21). Runs
 *  `java -version` and parses the major version from stderr. Returns
 *  { ok, version } where version is the major version number (or 0 if unknown). */
function checkJavaVersionAtLeast(
  javaBin: string,
  minMajor: number,
): Promise<{ ok: boolean; version: number }> {
  return new Promise((resolveP) => {
    const p = spawn(javaBin, ["-version"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    p.stderr?.on("data", (c: Buffer) => (out += c.toString("utf8")));
    p.stdout?.on("data", (c: Buffer) => (out += c.toString("utf8")));
    p.on("error", () => resolveP({ ok: false, version: 0 }));
    p.on("exit", () => {
      // `java -version` output: 'openjdk version "17.0.18"' or 'version "21"'
      const match = out.match(/version "(\d+)/);
      const version = match ? parseInt(match[1], 10) : 0;
      resolveP({ ok: version >= minMajor, version });
    });
  });
}
