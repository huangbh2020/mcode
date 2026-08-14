/**
 * RelayManager — SSH-based remote access relay for the mobile companion.
 *
 * Connects to a user-provided VPS via SSH (`ssh2` package), sets up a reverse
 * port-forwarding tunnel (`forwardIn`), and deploys a tiny TCP forwarder on
 * the VPS (socat or python3 script) so the phone can reach the desktop's
 * MobileHttpServer from anywhere — no third-party tunnel service needed.
 *
 * Data path:
 *   phone → VPS:publicPort → forwarder → VPS:localhost:tunnelPort
 *          → SSH forwardIn → desktop ssh2 'tcp connection' → localhost:7331
 *
 * The forwarder stays running on the VPS across SSH disconnects (nohup + disown),
 * so reconnecting is fast. The SSH connection has keepalive + auto-reconnect.
 *
 * Lifecycle mirrors LspManager / TunnelManager: module-load singleton, lazy
 * connect on demand, `disposeAll()` on app shutdown. State changes are pushed
 * to the renderer via `relay:event`.
 */
import { readFileSync } from "node:fs";
import * as nodeNet from "node:net";
import {
  Client,
  type ClientChannel,
  type SFTPWrapper,
} from "ssh2";
import { IPC, type RelayStatus, type RelayVpsConfig } from "@contracts/ipc";
import {
  RELAY_CONFIG_SETTING_KEY,
  RELAY_DEFAULT_PUBLIC_PORT,
} from "@contracts/relay";
import { log } from "@main/lib/logger.js";
import { sendToRenderer } from "@main/window.js";
import { SettingRepo } from "@main/store/repositories.js";
import { awaitDb } from "@main/store/db.js";
import { isMobileServerRunning, getMobileServer } from "@main/mobile/MobileHttpServer.js";
// The forwarder.py script content, inlined at build time via Vite's `?raw`
// suffix so it survives bundling. electron-vite emits a single main chunk and
// does not copy sibling non-JS assets into out/main, so a runtime readFileSync
// of a co-located file fails with ENOENT in dev/prod.
import FORWARDER_PY from "./forwarder.py?raw";

/** The local port the mobile HTTP server listens on. */
const MOBILE_LOCAL_PORT = 7331;

/** SSH keepalive interval (seconds). */
const KEEPALIVE_INTERVAL = 15;

/** Max reconnect attempts before giving up (user can retry manually). */
const MAX_RECONNECT_ATTEMPTS = 5;

/** Reconnect delay base (exponential backoff). */
const RECONNECT_BASE_DELAY_MS = 2000;

class RelayManagerImpl {
  private conn: Client | null = null;
  private config: RelayVpsConfig | null = null;
  private tunnelPort = 0;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalDisconnect = false;

  private status: RelayStatus = {
    state: "idle",
    endpoint: null,
    vpsHost: null,
    publicPort: RELAY_DEFAULT_PUBLIC_PORT,
    error: null,
    forwarderType: null,
  };

  /** Current status snapshot. */
  getStatus(): RelayStatus {
    return { ...this.status };
  }

  /** Read the saved VPS config from settings. */
  getConfig(): RelayVpsConfig | null {
    try {
      const raw = SettingRepo.get(RELAY_CONFIG_SETTING_KEY);
      if (!raw) return null;
      return JSON.parse(raw) as RelayVpsConfig;
    } catch {
      return null;
    }
  }

  /** Save VPS config to settings. */
  saveConfig(config: RelayVpsConfig): void {
    SettingRepo.set(RELAY_CONFIG_SETTING_KEY, JSON.stringify(config));
    this.config = config;
    log.info(`relay: config saved for ${config.host}:${config.sshPort}`);
  }

  /** Connect to the VPS: SSH + deploy forwarder + reverse tunnel. */
  async connect(): Promise<{ ok: boolean; error?: string }> {
    await awaitDb();

    if (this.conn && this.status.state === "connected") {
      return { ok: true };
    }

    // Load config if not already loaded.
    if (!this.config) {
      this.config = this.getConfig();
    }
    if (!this.config) {
      const msg = "未配置 VPS，请先填写服务器信息";
      this.setState({ state: "error", error: msg });
      return { ok: false, error: msg };
    }

    // Guard: the relay forwards to the local mobile HTTP server. If it's
    // not running, the phone will see connection errors.
    if (!isMobileServerRunning()) {
      const msg = "移动端服务未运行，请先确保局域网配对功能正常工作";
      this.setState({ state: "error", error: msg });
      return { ok: false, error: msg };
    }

    this.intentionalDisconnect = false;
    this.reconnectAttempts = 0;

    return this.doConnect();
  }

  /** Disconnect from the VPS. The forwarder keeps running on the VPS. */
  async disconnect(): Promise<void> {
    this.intentionalDisconnect = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.conn) {
      this.conn.end();
      this.conn = null;
    }
    this.tunnelPort = 0;
    this.setState({
      state: "idle",
      endpoint: null,
      error: null,
      forwarderType: null,
    });
    log.info("relay: disconnected");
  }

  /** Kill the connection on app shutdown. Best-effort, synchronous. */
  disposeAll(): void {
    this.intentionalDisconnect = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.conn) {
      try {
        this.conn.end();
      } catch {
        // best-effort
      }
      this.conn = null;
    }
  }

  // ─────────────────────────── internal ───────────────────────────

  /** Actual SSH connection + forwarder deployment + forwardIn setup. */
  private async doConnect(): Promise<{ ok: boolean; error?: string }> {
    const cfg = this.config!;
    this.setState({
      state: "connecting",
      error: null,
      vpsHost: cfg.host,
      publicPort: cfg.publicPort,
    });

    return new Promise((resolve) => {
      const conn = new Client();
      this.conn = conn;

      const connectOpts: Record<string, unknown> = {
        host: cfg.host,
        port: cfg.sshPort,
        username: cfg.username,
        keepaliveInterval: KEEPALIVE_INTERVAL * 1000,
        readyTimeout: 20_000,
        algorithms: {
          // Allow a broad set of algorithms for compatibility with older
          // SSH servers common on VPS images.
          serverHostKey: [
            "ssh-ed25519",
            "ecdsa-sha2-nistp256",
            "ecdsa-sha2-nistp384",
            "rsa-sha2-512",
            "rsa-sha2-256",
            "ssh-rsa",
            "ssh-dss",
          ],
        },
      };

      if (cfg.privateKeyPath) {
        try {
          connectOpts.privateKey = readFileSync(cfg.privateKeyPath, "utf8");
          if (cfg.password) connectOpts.passphrase = cfg.password;
        } catch {
          // Fall back to password auth
          connectOpts.password = cfg.password;
        }
      } else {
        connectOpts.password = cfg.password;
      }

      conn.on("ready", async () => {
        log.info("relay: SSH connected");
        try {
          await this.deployForwarder(conn, cfg);
          await this.setupForwardIn(conn, cfg);
          this.reconnectAttempts = 0;
          resolve({ ok: true });
        } catch (err) {
          const msg = (err as Error).message;
          log.error(`relay: setup failed: ${msg}`);
          this.setState({ state: "error", error: msg });
          resolve({ ok: false, error: msg });
        }
      });

      conn.on("error", (err: Error) => {
        log.error(`relay: SSH error: ${err.message}`);
        if (this.status.state === "connecting") {
          // Connection phase failure → resolve with error.
          resolve({ ok: false, error: friendlySshError(err) });
        }
        if (!this.intentionalDisconnect) {
          this.scheduleReconnect();
        }
      });

      conn.on("close", () => {
        log.info("relay: SSH closed");
        this.conn = null;
        this.tunnelPort = 0;
        if (!this.intentionalDisconnect) {
          this.scheduleReconnect();
        }
      });

      conn.on("tcp connection", (info: { destIP: string; destPort: number }, accept: () => ClientChannel) => {
        // A phone connection arrived through the reverse tunnel. Forward
        // it to the local mobile HTTP server.
        const stream = accept();
        this.pipeToLocal(stream);
      });

      conn.connect(connectOpts);
    });
  }

  /** Deploy the forwarder on the VPS: try socat first, then python3. */
  private async deployForwarder(conn: Client, cfg: RelayVpsConfig): Promise<void> {
    this.setState({ state: "deploying" });
    this.tunnelPort = await pickRandomPort();

    // Check if a forwarder is already running for our public port.
    const checkRunning = await execAsync(
      conn,
      `pgrep -f "TCP-LISTEN:${cfg.publicPort}" || pgrep -f "forwarder.py.*${cfg.publicPort}"`,
    );
    if (checkRunning.trim()) {
      // Forwarder might be from a previous session with a different tunnelPort.
      // Kill it and restart with the current tunnelPort.
      log.info("relay: killing stale forwarder");
      await execAsync(
        conn,
        `pkill -f "TCP-LISTEN:${cfg.publicPort}" || true; pkill -f "forwarder.py.*${cfg.publicPort}" || true`,
      ).catch(() => {});
      await sleep(500);
    }

    // Try socat (simplest — one-liner, no file upload).
    const socatPath = await execAsync(conn, "which socat 2>/dev/null");
    if (socatPath.trim()) {
      log.info("relay: using socat forwarder");
      const cmd = `nohup socat TCP-LISTEN:${cfg.publicPort},fork,reuseaddr TCP:127.0.0.1:${this.tunnelPort} >/dev/null 2>&1 &`;
      await execAsync(conn, cmd);
      // Verify it's listening.
      await sleep(300);
      const check = await execAsync(conn, `pgrep -f "TCP-LISTEN:${cfg.publicPort}"`);
      if (check.trim()) {
        this.setState({ forwarderType: "socat" });
        log.info(`relay: socat forwarder started on port ${cfg.publicPort}`);
        return;
      }
      log.warn("relay: socat start failed, falling back to python3");
    }

    // Fallback: python3 forwarder script.
    const pythonPath = await execAsync(conn, "which python3 2>/dev/null");
    if (!pythonPath.trim()) {
      throw new Error("VPS 上没有 socat 或 python3，请安装其一：apt install socat 或 apt install python3");
    }

    log.info("relay: using python3 forwarder");
    await this.uploadForwarderScript(conn);
    const cmd = `nohup python3 ~/.mcode/forwarder.py ${cfg.publicPort} ${this.tunnelPort} >/dev/null 2>&1 &`;
    await execAsync(conn, cmd);
    await sleep(500);
    const check = await execAsync(conn, `pgrep -f "forwarder.py.*${cfg.publicPort}"`);
    if (!check.trim()) {
      throw new Error("python3 forwarder 启动失败，请检查 VPS 端口是否被占用");
    }
    this.setState({ forwarderType: "python3" });
    log.info(`relay: python3 forwarder started on port ${cfg.publicPort}`);
  }

  /** Upload forwarder.py to the VPS via SFTP. */
  private async uploadForwarderScript(conn: Client): Promise<void> {
    await new Promise<void>((resolveP, rejectP) => {
      conn.sftp((err: Error | undefined, sftp: SFTPWrapper) => {
        if (err) return rejectP(err);
        // Ensure ~/.mcode/ exists.
        sftp.mkdir(".mcode", (mkdirErr) => {
          // EEXIST is fine.
          if (mkdirErr && (mkdirErr as NodeJS.ErrnoException).code !== "FAILURE") {
            // ignore — directory likely exists
          }
          const remotePath = ".mcode/forwarder.py";
          const stream = sftp.createWriteStream(remotePath, { mode: 0o755 });
          stream.on("error", rejectP);
          stream.on("close", () => resolveP());
          stream.end(FORWARDER_PY);
        });
      });
    });
  }

  /** Set up the SSH reverse tunnel via forwardIn. */
  private async setupForwardIn(conn: Client, cfg: RelayVpsConfig): Promise<void> {
    await new Promise<void>((resolveP, rejectP) => {
      // forwardIn tells the SSH server to listen on 127.0.0.1:tunnelPort
      // and forward connections back to us via 'tcp connection'.
      conn.forwardIn("127.0.0.1", this.tunnelPort, (err: Error | undefined) => {
        if (err) {
          return rejectP(new Error(`SSH 反向隧道建立失败: ${err.message}`));
        }
        log.info(`relay: forwardIn established on 127.0.0.1:${this.tunnelPort}`);
        const endpoint = `http://${cfg.host}:${cfg.publicPort}`;
        this.setState({ state: "connected", endpoint, error: null });
        resolveP();
      });
    });
  }

  /** Pipe an SSH-forwarded stream to the local mobile HTTP server. */
  private pipeToLocal(stream: ClientChannel): void {
    const server = getMobileServer();
    const localPort = server.port || MOBILE_LOCAL_PORT;
    const socket = nodeNet.connect({ host: "127.0.0.1", port: localPort }, () => {
      stream.pipe(socket);
      socket.pipe(stream);
    });
    const cleanup = () => {
      try { stream.destroy(); } catch { /* */ }
      try { socket.destroy(); } catch { /* */ }
    };
    stream.on("error", cleanup);
    stream.on("close", cleanup);
    socket.on("error", cleanup);
    socket.on("close", cleanup);
  }

  /** Schedule a reconnection with exponential backoff. */
  private scheduleReconnect(): void {
    if (this.intentionalDisconnect) return;
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.setState({
        state: "error",
        error: `连接断开，重试 ${MAX_RECONNECT_ATTEMPTS} 次后放弃。请检查网络后重试。`,
        endpoint: null,
      });
      return;
    }
    this.reconnectAttempts++;
    const delay = RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts - 1);
    log.info(`relay: reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    this.setState({ state: "connecting", error: `正在重连(${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})…` });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.intentionalDisconnect) return;
      void this.doConnect().then((result) => {
        if (!result.ok && this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          this.scheduleReconnect();
        }
      });
    }, delay);
  }

  /** Update internal status + push a relay:event to the renderer. */
  private setState(patch: Partial<RelayStatus>): void {
    this.status = { ...this.status, ...patch };
    sendToRenderer(IPC.RELAY_EVENT, {
      channel: IPC.RELAY_EVENT,
      status: this.getStatus(),
    } as const);
  }
}

/** Process-wide singleton. */
export const relayManager = new RelayManagerImpl();

// ─────────────────────────── helpers ───────────────────────────

/** Execute a command via SSH and return stdout. */
function execAsync(conn: Client, cmd: string): Promise<string> {
  return new Promise((resolveP, rejectP) => {
    conn.exec(cmd, (err: Error | undefined, stream: ClientChannel) => {
      if (err) return rejectP(err);
      let stdout = "";
      stream.on("data", (data: Buffer) => {
        stdout += data.toString("utf8");
      });
      stream.on("close", () => resolveP(stdout));
      stream.stderr.on("data", () => {
        // ignore stderr — some commands write to it (which, pgrep)
      });
    });
  });
}

/** Translate raw SSH errors into user-friendly Chinese messages. */
function friendlySshError(err: Error): string {
  const msg = err.message;
  if (/authentication failed|All configured authentication methods failed/i.test(msg)) {
    return "SSH 认证失败：请检查用户名和密码/密钥是否正确";
  }
  if (/connect ECONNREFUSED|Connection refused/i.test(msg)) {
    return `无法连接到 SSH 服务：请确认 ${msg.includes("port") ? "端口" : "地址"}正确且 SSH 服务正在运行`;
  }
  if (/ENOTFOUND|getaddrinfo/i.test(msg)) {
    return "无法解析服务器地址：请检查 IP/域名是否正确";
  }
  if (/ETIMEDOUT|Timed out|timeout/i.test(msg)) {
    return "SSH 连接超时：请检查服务器地址/端口和网络";
  }
  return `SSH 连接失败: ${msg}`;
}

/** Pick a random available port for the SSH reverse tunnel (internal use). */
async function pickRandomPort(): Promise<number> {
  return new Promise((resolveP, rejectP) => {
    const srv = nodeNet.createServer();
    srv.unref();
    srv.on("error", rejectP);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolveP(port));
      } else {
        srv.close();
        rejectP(new Error("无法分配隧道端口"));
      }
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
