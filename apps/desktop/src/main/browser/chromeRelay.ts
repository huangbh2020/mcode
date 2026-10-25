/**
 * Real-Chrome relay — a loopback WebSocket server the mcode-connector
 * browser extension connects to, so the agent's browser tools can drive the
 * user's REAL, logged-in Chrome (borrowing the Codex Chrome-extension
 * playbook, minus its native-messaging host: an extension CAN open a
 * WebSocket to 127.0.0.1, so no registry manifest / host binary is needed —
 * install the extension, paste the pairing token, done).
 *
 * Protocol (JSON frames over one WS connection, v1):
 *   ext → app  { v:1, type:"hello", token }        pairing (first frame only)
 *   app → ext  { type:"welcome", ok:true }          | { type:"bye", reason }
 *   app → ext  { type:"cmd", id, targetId?, method, params }
 *   ext → app  { type:"cmdResult", id, ok, result?, error? }
 *   ext → app  { type:"status", chromeVersion? }    optional metadata
 *
 * Command surface is a WHITELIST of CDP methods (see CHROME_RELAY_COMMANDS) —
 * the relay is deliberately not a raw CDP pipe. The extension side wraps
 * chrome.debugger attach/sendCommand/detach per target.
 *
 * Pairing token: generated on demand, stored safeStorage-encrypted (plaintext
 * fallback for OSes without a credential store — same pattern as the cookie
 * vault). Loopback-only listener on a random port; the port is shown in the
 * settings page for the extension popup.
 *
 * Status changes are pushed to the renderer as the "chromeRelay" browser
 * event (ChromeRelayStatusPayload) and the pure protocol helpers
 * (isAllowedChromeRelayCommand / parseChromeRelayFrame) are exported for the
 * smoke.
 */
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { safeStorage } from "electron";
import {
  BROWSER_CHROME_BACKEND_SETTING_KEY,
  BROWSER_CHROME_RELAY_TOKEN_ENC_SETTING_KEY,
  BROWSER_CHROME_RELAY_TOKEN_SETTING_KEY,
  type ChromeRelayStatusPayload,
} from "@contracts/ipc";
import { log } from "@main/lib/logger.js";
import { SettingRepo } from "@main/store/repositories.js";
import { sendToRenderer } from "@main/window.js";
import { IPC } from "@contracts/ipc";

/** CDP methods the relay is allowed to forward. Read-only skeleton scope:
 * tab lifecycle + navigation + evaluate + screenshot. Widen deliberately. */
export const CHROME_RELAY_COMMANDS = new Set([
  "Target.getTargets",
  "Target.createTarget",
  "Target.activateTarget",
  "Target.closeTarget",
  "Page.navigate",
  "Runtime.evaluate",
  "Page.captureScreenshot",
]);

export function isAllowedChromeRelayCommand(method: string): boolean {
  return CHROME_RELAY_COMMANDS.has(method);
}

/** One relay frame as it crosses the wire (union by `type`). */
export type ChromeRelayFrame =
  | { v: 1; type: "hello"; token: string }
  | { type: "welcome"; ok: true }
  | { type: "bye"; reason: string }
  | { type: "cmd"; id: string; targetId?: string; method: string; params?: unknown }
  | { type: "cmdResult"; id: string; ok: boolean; result?: unknown; error?: string }
  | { type: "status"; chromeVersion?: string };

/** Parse one inbound frame; null when it isn't valid JSON or has no type. */
export function parseChromeRelayFrame(raw: string): ChromeRelayFrame | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const t = (obj as { type?: unknown }).type;
  if (typeof t !== "string") return null;
  return obj as ChromeRelayFrame;
}

/** Constant-time token comparison; guards length-mismatch throws. */
function tokenEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/* ── token storage (cookie-vault pattern: safeStorage-encrypted base64,
 *    plaintext fallback, blank the plaintext once encrypted) ── */

export function getChromeRelayToken(): string {
  const enc = SettingRepo.get(BROWSER_CHROME_RELAY_TOKEN_ENC_SETTING_KEY);
  if (enc && safeStorage.isEncryptionAvailable()) {
    try {
      const plain = safeStorage.decryptString(Buffer.from(enc, "base64"));
      if (plain) return plain;
    } catch (err) {
      log.warn(`chrome relay: token decrypt failed: ${(err as Error).message}`);
    }
  }
  const plain = SettingRepo.get(BROWSER_CHROME_RELAY_TOKEN_SETTING_KEY) ?? "";
  if (plain) return plain;
  // First use — generate and persist.
  const fresh = randomBytes(24).toString("base64url");
  persistToken(fresh);
  return fresh;
}

function persistToken(token: string): void {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      SettingRepo.set(
        BROWSER_CHROME_RELAY_TOKEN_ENC_SETTING_KEY,
        safeStorage.encryptString(token).toString("base64"),
      );
      if (SettingRepo.get(BROWSER_CHROME_RELAY_TOKEN_SETTING_KEY)) {
        SettingRepo.set(BROWSER_CHROME_RELAY_TOKEN_SETTING_KEY, "");
      }
      return;
    }
  } catch (err) {
    log.warn(`chrome relay: token encryption failed (plaintext): ${(err as Error).message}`);
  }
  SettingRepo.set(BROWSER_CHROME_RELAY_TOKEN_SETTING_KEY, token);
}

/* ── server lifecycle + connection state ── */

interface Pending {
  resolve: (v: { ok: true; result: unknown } | { ok: false; error: string }) => void;
  timer: NodeJS.Timeout;
}

let httpServer: Server | null = null;
let wss: WebSocketServer | null = null;
let client: WebSocket | null = null;
let chromeVersion: string | null = null;
let listeningPort: number | null = null;
let enabled = false;
const pending = new Map<string, Pending>();
const CMD_TIMEOUT_MS = 15_000;

function status(): ChromeRelayStatusPayload {
  return {
    enabled,
    listening: listeningPort !== null,
    port: listeningPort,
    connected: client !== null,
    chromeVersion,
  };
}

function pushStatus(): void {
  sendToRenderer(IPC.BROWSER_EVENT, {
    channel: "browser:event",
    browserId: "chrome-relay",
    type: "chromeRelay",
    payload: status(),
  });
}

function failAllPending(reason: string): void {
  for (const [id, p] of pending) {
    clearTimeout(p.timer);
    p.resolve({ ok: false, error: reason });
    pending.delete(id);
  }
}

function detachClient(): void {
  if (!client) return;
  client = null;
  chromeVersion = null;
  failAllPending("Chrome 扩展连接已断开");
  pushStatus();
}

export function chromeRelayStatus(): ChromeRelayStatusPayload {
  return status();
}

/** Start the loopback WS server (idempotent). Returns the port. */
export async function startChromeRelay(): Promise<number> {
  if (listeningPort !== null) return listeningPort;
  const token = getChromeRelayToken();
  let port = 0;
  await new Promise<void>((resolve, reject) => {
    httpServer = createServer((_req, res) => {
      // Plain HTTP GET on the relay port = a quick "is it alive" probe.
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, relay: "mcode-chrome", version: 1 }));
    });
    wss = new WebSocketServer({ server: httpServer, maxPayload: 32 * 1024 * 1024 });
    wss.on("connection", (ws, req) => {
      // The listener is bound to 127.0.0.1 so connections can only arrive
      // via loopback; the remoteAddress check is defense-in-depth against a
      // future bind change, not the actual gate.
      const addr = req.socket.remoteAddress ?? "";
      const isLoopback =
        addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1" || addr.startsWith("127.");
      if (!isLoopback) {
        ws.close(4403, "forbidden");
        return;
      }
      let paired = false;
      ws.on("message", (data) => {
        const frame = parseChromeRelayFrame(data.toString());
        if (!frame) return;
        if (!paired) {
          if (frame.type === "hello" && typeof frame.token === "string") {
            if (!tokenEquals(frame.token, token)) {
              log.warn("chrome relay: pairing rejected (bad token)");
              ws.send(JSON.stringify({ type: "bye", reason: "bad token" }));
              ws.close(4401, "bad token");
              return;
            }
            paired = true;
            // One paired extension at a time — a second hello replaces none;
            // it is refused while one is live (stale SW reconnects race).
            if (client && client.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "bye", reason: "another extension is connected" }));
              ws.close(4409, "conflict");
              return;
            }
            client = ws;
            log.info("chrome relay: extension paired");
            ws.send(JSON.stringify({ type: "welcome", ok: true }));
            pushStatus();
          }
          return;
        }
        if (frame.type === "cmdResult") {
          const p = pending.get(frame.id);
          if (p) {
            pending.delete(frame.id);
            clearTimeout(p.timer);
            p.resolve(frame.ok ? { ok: true, result: frame.result } : { ok: false, error: frame.error ?? "extension error" });
          }
          return;
        }
        if (frame.type === "status" && typeof frame.chromeVersion === "string") {
          chromeVersion = frame.chromeVersion;
          pushStatus();
        }
      });
      ws.on("close", () => {
        if (client === ws) detachClient();
      });
      ws.on("error", () => {
        if (client === ws) detachClient();
      });
    });
    httpServer.listen(0, "127.0.0.1", () => {
      const addr = httpServer?.address();
      port = typeof addr === "object" && addr ? addr.port : 0;
      listeningPort = port;
      log.info(`chrome relay: listening on 127.0.0.1:${port}`);
      resolve();
    });
    httpServer.on("error", (err) => {
      log.error(`chrome relay: server error: ${(err as Error).message}`);
      listeningPort = null;
      reject(err);
    });
  });
  pushStatus();
  return port;
}

/** Stop the server and drop any extension connection (idempotent). */
export function stopChromeRelay(): void {
  failAllPending("chrome relay 已停用");
  if (client) {
    try {
      client.close(1001, "relay stopped");
    } catch {
      /* already gone */
    }
    client = null;
  }
  chromeVersion = null;
  wss?.close();
  wss = null;
  const srv = httpServer;
  httpServer = null;
  if (srv) {
    srv.close(() => undefined);
    // Force-destroy lingering sockets — a connected WS keeps the server's
    // "close" pending otherwise.
    srv.closeAllConnections?.();
  }
  listeningPort = null;
  pushStatus();
}

/** Enable/disable (settings toggle + lifecycle in one call). */
export function setChromeRelayEnabled(on: boolean): ChromeRelayStatusPayload {
  enabled = on;
  SettingRepo.set(BROWSER_CHROME_BACKEND_SETTING_KEY, on ? "1" : "0");
  if (on) {
    void startChromeRelay().catch(() => {
      log.warn("chrome relay: failed to start");
    });
  } else {
    stopChromeRelay();
  }
  return status();
}

/** Seed the enabled flag from the persisted setting at app start; when on,
 * bring the server up. */
export function initChromeRelayFromSettings(): void {
  enabled = SettingRepo.get(BROWSER_CHROME_BACKEND_SETTING_KEY) === "1";
  if (enabled) {
    void startChromeRelay().catch(() => undefined);
  }
}

/** Regenerate the pairing token (disconnects the current extension). */
export function resetChromeRelayToken(): string {
  const fresh = randomBytes(24).toString("base64url");
  persistToken(fresh);
  // The old token stops working only for NEW hellos; the live connection was
  // authenticated with it, so drop it to make the reset immediate.
  if (client) {
    try {
      client.close(4401, "token reset");
    } catch {
      /* ignore */
    }
    detachClient();
  }
  return fresh;
}

/** Send one whitelisted CDP command to the paired extension. Rejects when
 *  disabled / not connected / the method isn't whitelisted / timed out. */
export async function chromeRelayCommand(
  method: string,
  params?: unknown,
  opts?: { targetId?: string },
): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  if (!enabled || listeningPort === null) {
    return { ok: false, error: "真实 Chrome 接入未启用(设置 → 浏览器 → 真实 Chrome)。" };
  }
  if (!isAllowedChromeRelayCommand(method)) {
    return { ok: false, error: `CDP 命令不在白名单: ${method}` };
  }
  if (!client || client.readyState !== WebSocket.OPEN) {
    return { ok: false, error: "Chrome 扩展未连接。请在 Chrome 里安装并连接 mcode-connector 扩展。" };
  }
  const id = randomUUID();
  const frame: ChromeRelayFrame = { type: "cmd", id, method, params, ...(opts?.targetId ? { targetId: opts.targetId } : {}) };
  const sock: WebSocket = client;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ ok: false, error: `chrome relay 命令超时: ${method}` });
    }, CMD_TIMEOUT_MS);
    pending.set(id, { resolve, timer });
    sock.send(JSON.stringify(frame), (err) => {
      if (err) {
        pending.delete(id);
        clearTimeout(timer);
        resolve({ ok: false, error: `chrome relay 发送失败: ${(err as Error).message}` });
      }
    });
  });
}
