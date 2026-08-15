/**
 * MobileHttpServer — the LAN-facing HTTP server that serves the mobile web app
 * and bridges it to the same main-process logic the desktop renderer uses.
 *
 * Endpoints (all under one origin, so the mobile bundle calls same-origin
 * `/api/*` with no CORS):
 *
 *   GET  /                      → mobile bundle (SPA, static)
 *   GET  /api/health            → { ok } (no auth; for connectivity checks)
 *   POST /api/pair/verify       → complete pairing (no auth; nonce + code)
 *   POST /api/rpc               → whitelisted RPC (Authorization: Bearer)
 *   GET  /api/events            → SSE event stream (Authorization: Bearer)
 *
 * ## Lifecycle
 * Started from index.ts on `app.whenReady` (after DB init), stopped on
 * `before-quit`. Bound to `0.0.0.0` so other devices on the LAN can reach it.
 * This is a deliberate widening of the threat boundary: only the pairing flow
 * guards access — every request past `/api/pair/*` requires a valid device
 * token.
 *
 * The server builds on the same node:http pattern as the OpenAI bridge server
 * (`providers/bridge/bridgeServer.ts`) but is long-lived and multi-route.
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { app } from "electron";
import { awaitDb, getDb } from "@main/store/db.js";
import { SettingRepo } from "@main/store/repositories.js";
import {
  MOBILE_DEFAULT_PORT,
  MOBILE_PORT_SETTING_KEY,
  MOBILE_ENABLED_SETTING_KEY,
  SSE_HEARTBEAT_INTERVAL_MS,
  PairingVerifyInputSchema,
  type MobileRpcRequest,
  type MobileRpcResponse,
  type PairingVerifyInput,
  type PairedDevice,
} from "@contracts/mobile";
import { pairingManager, detectLanIp } from "./PairingManager.js";
import { mobileEventBus } from "./MobileEventBus.js";
import { runtimeManager } from "@main/claude/RuntimeManager.js";
import { dispatchMobileRpc, RpcError, type DeviceContext } from "./mobileRpc.js";
import { registerMobileGitRpc } from "./mobileGitRpc.js";
import { serveMobileAsset } from "./serveMobileStatic.js";
import { log } from "@main/lib/logger.js";

/** Read the configured port from settings (post-DB). Falls back to default. */
async function resolvePort(): Promise<number> {
  await awaitDb();
  try {
    const raw = SettingRepo.get(MOBILE_PORT_SETTING_KEY);
    if (raw) {
      const n = parseInt(raw, 10);
      if (Number.isFinite(n) && n > 0 && n < 65536) return n;
    }
  } catch {
    // DB not ready yet — fall through to default.
  }
  return MOBILE_DEFAULT_PORT;
}

async function readEnabled(): Promise<boolean> {
  await awaitDb();
  try {
    const raw = SettingRepo.get(MOBILE_ENABLED_SETTING_KEY);
    if (raw === "0") return false;
  } catch {
    // ignore
  }
  return true;
}

export interface MobileServerHandle {
  /** Whether the server is currently listening. */
  readonly running: boolean;
  /** The bound port (0 if not running). */
  readonly port: number;
  /** The LAN endpoint base URL, e.g. `http://192.168.1.5:7331`. */
  readonly endpoint: string;
  /** Stop listening. Idempotent. */
  stop(): void;
}

let currentHandle: MobileServerHandle | null = null;

/** Read the request body as JSON, with a size guard. Mirrors bridgeServer. */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const LIMIT = 32 * 1024 * 1024;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > LIMIT) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("error", reject);
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch (err) {
        reject(err);
      }
    });
  });
}

/** Extract + validate the device token. Prefers the `Authorization: Bearer`
 *  header; falls back to a `?token=` query param so `EventSource` (which
 *  cannot set request headers) can authenticate the SSE stream. Returns the
 *  device on success, null on any failure (caller sends 401). */
async function authorize(req: IncomingMessage): Promise<PairedDevice | null> {
  let token: string | null = null;
  const header = req.headers["authorization"];
  if (header && typeof header === "string") {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match) token = match[1];
  }
  if (!token) {
    // Query-param fallback for EventSource (no header support).
    const u = req.url ?? "";
    const q = u.split("?", 2)[1];
    if (q) {
      const params = new URLSearchParams(q);
      token = params.get("token");
    }
  }
  if (!token) return null;
  return pairingManager.validateToken(token);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(json);
}

/** Send a `MobileRpcResponse` envelope, mapping thrown errors to statuses. */
function sendRpcResult(res: ServerResponse, promise: Promise<unknown>): void {
  promise
    .then((result) => sendJson(res, 200, { ok: true, result } satisfies MobileRpcResponse))
    .catch((err: unknown) => {
      if (err instanceof RpcError) {
        sendJson(res, err.status, { ok: false, error: err.message, status: err.status } satisfies MobileRpcResponse);
      } else if (err instanceof Error) {
        // zod errors bubble up here too — treat as bad request for safety.
        sendJson(res, 400, { ok: false, error: err.message, status: 400 } satisfies MobileRpcResponse);
      } else {
        sendJson(res, 500, { ok: false, error: "internal error", status: 500 } satisfies MobileRpcResponse);
      }
    });
}

/** SSE event-stream handler. Subscribes to the bus, writes each RuntimeEvent
 *  framed as `event: message\ndata: <json>\n\n`, and emits heartbeats. */
function handleEvents(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // disable proxy buffering (nginx et al.)
  });
  // Initial flush so the client sees headers immediately.
  res.write(": connected\n\n");

  // Running-state snapshot as the first data frame of every (re)connect.
  // The bus is unbuffered, so a phone that was backgrounded while a turn ran
  // misses the terminal `turn.done` — without this frame its client-side
  // running state stays stuck on forever (spinner, slash picker disabled).
  res.write(
    `data: ${JSON.stringify({
      sessionId: "",
      event: {
        type: "session.runningSnapshot",
        sessionId: "",
        running: runtimeManager.runningSessionIds(),
      },
    })}\n\n`,
  );

  const unsubscribe = mobileEventBus.subscribe((e) => {
    // Filter is per-client in the future (sessionId subscription); for now we
    // fan out everything and let the client drop irrelevant sessionIds — cheap
    // on LAN, and keeps the server stateless.
    res.write(`data: ${JSON.stringify({ sessionId: e.sessionId, event: e })}\n\n`);
  });

  const heartbeat = setInterval(() => {
    res.write(": ping\n\n");
  }, SSE_HEARTBEAT_INTERVAL_MS);

  req.on("close", () => {
    unsubscribe();
    clearInterval(heartbeat);
    try {
      res.end();
    } catch {
      // already ended
    }
  });
}

/** POST /api/pair/verify — complete pairing. No auth required (nonce + code). */
async function handlePairVerify(req: IncomingMessage, res: ServerResponse, endpoint: string): Promise<void> {
  let body: PairingVerifyInput;
  try {
    body = PairingVerifyInputSchema.parse(await readJsonBody(req)) as PairingVerifyInput;
  } catch (err) {
    sendJson(res, 400, { error: `无效的配对请求: ${(err as Error).message}` });
    return;
  }
  const outcome = await pairingManager.verify(body, endpoint);
  if (!outcome.ok) {
    sendJson(res, 401, { error: outcome.reason });
    return;
  }
  sendJson(res, 200, outcome.result);
}

/** POST /api/rpc — dispatch a whitelisted RPC. Auth required. */
async function handleRpc(req: IncomingMessage, res: ServerResponse, device: PairedDevice): Promise<void> {
  let body: MobileRpcRequest;
  try {
    body = (await readJsonBody(req)) as MobileRpcRequest;
  } catch (err) {
    sendJson(res, 400, { ok: false, error: `invalid body: ${(err as Error).message}`, status: 400 });
    return;
  }
  if (!body || typeof body.method !== "string") {
    sendJson(res, 400, { ok: false, error: "missing method", status: 400 });
    return;
  }
  const ctx: DeviceContext = { device };
  // Entry/exit tracing. git:* calls are user-triggered slow ops (LLM rounds,
  // network) — always logged so a hung request is visible in main.log. Other
  // methods log only when slow or failing. Without this a request stuck
  // server-side leaves no trace at all: the handlers log only on completion,
  // and handler failures are swallowed into 4xx responses by sendRpcResult
  // (the outer route catch never fires for them).
  const started = Date.now();
  const slowOp = body.method.startsWith("git:");
  if (slowOp) log.info(`mobile: rpc ${body.method} start (${device.name})`);
  const traced = dispatchMobileRpc(body, ctx).then(
    (result) => {
      const ms = Date.now() - started;
      if (slowOp) log.info(`mobile: rpc ${body.method} ok in ${ms}ms`);
      else if (ms > 3000) log.warn(`mobile: rpc ${body.method} slow (${ms}ms)`);
      return result;
    },
    (err: unknown) => {
      const ms = Date.now() - started;
      log.warn(`mobile: rpc ${body.method} failed in ${ms}ms: ${(err as Error)?.message ?? err}`);
      throw err;
    },
  );
  sendRpcResult(res, traced);
}

/** Start the mobile server. Resolves with a handle (running:false if disabled
 *  or DB unavailable). Safe to call once at app start. */
export async function startMobileServer(): Promise<MobileServerHandle> {
  if (currentHandle) return currentHandle;

  // Wait for DB so settings (enabled flag, port) are readable.
  try {
    await awaitDb();
  } catch (err) {
    log.error(`mobile: DB not ready, server not started: ${(err as Error).message}`);
    return makeIdleHandle();
  }

  const enabled = await readEnabled();
  if (!enabled) {
    log.info("mobile: disabled by setting (mobile.enabled=0); server not started");
    return makeIdleHandle();
  }

  // Register the git subset into the mobile RPC whitelist (idempotent — the
  // table absorbs the extra handlers). Done once per server start.
  try {
    registerMobileGitRpc();
  } catch (err) {
    log.warn(`mobile: git RPC registration failed: ${(err as Error).message}`);
  }

  const port = await resolvePort();
  const lanIp = detectLanIp();
  const endpoint = lanIp ? `http://${lanIp}:${port}` : `http://localhost:${port}`;

  const server: Server = createServer((req, res) => {
    // All API responses get a permissive CSP-free header set as needed. The
    // mobile bundle is served with its own meta CSP (Phase 4).
    const rawUrl = req.url ?? "/";
    const path = rawUrl.split("?", 2)[0];

    // CORS: same-origin in production; allow all origins so a dev Vite server
    // (different port) can call this API directly during mobile development.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // ── Unauthenticated routes ──────────────────────────────────────────
    if (path === "/api/health") {
      sendJson(res, 200, { ok: true, endpoint, dbReady: !!getDb() });
      return;
    }
    if (path === "/api/pair/verify" && req.method === "POST") {
      handlePairVerify(req, res, endpoint).catch((err) => {
        log.error(`mobile: pair/verify failed: ${(err as Error).message}`);
        sendJson(res, 500, { error: "internal error" });
      });
      return;
    }

    // ── Authenticated routes ────────────────────────────────────────────
    if (path.startsWith("/api/")) {
      // Authorize first.
      const authPromise = authorize(req);
      // SSE handler keeps the connection open, so handle it inline.
      if (path === "/api/events" && req.method === "GET") {
        authPromise.then((device) => {
          if (!device) {
            sendJson(res, 401, { error: "unauthorized" });
            return;
          }
          handleEvents(req, res);
        });
        return;
      }
      if (path === "/api/rpc" && req.method === "POST") {
        authPromise
          .then((device) => {
            if (!device) {
              sendJson(res, 401, { ok: false, error: "unauthorized", status: 401 });
              return;
            }
            return handleRpc(req, res, device);
          })
          .catch((err) => {
            log.error(`mobile: rpc failed: ${(err as Error).message}`);
            sendJson(res, 500, { ok: false, error: "internal error", status: 500 });
          });
        return;
      }
      // Unknown /api route.
      sendJson(res, 404, { error: "not found" });
      return;
    }

    // ── Static mobile bundle (SPA) ──────────────────────────────────────
    serveMobileAsset(req, res);
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.on("error", reject);
      server.listen(port, "0.0.0.0", () => resolve());
    });
  } catch (err) {
    log.error(`mobile: failed to listen on 0.0.0.0:${port}: ${(err as Error).message}`);
    return makeIdleHandle();
  }

  log.info(`mobile: server listening on 0.0.0.0:${port} (${endpoint})${lanIp ? "" : " [no LAN IP detected]"}`);

  currentHandle = {
    running: true,
    port,
    endpoint,
    stop: () => {
      server.close(() => log.info(`mobile: server stopped (${port})`));
      currentHandle = null;
    },
  };
  return currentHandle;
}

/** Stop the running mobile server, if any. */
export function stopMobileServer(): void {
  currentHandle?.stop();
  currentHandle = null;
}

/** A non-running handle returned when the server is disabled or errored. */
function makeIdleHandle(): MobileServerHandle {
  return {
    running: false,
    port: 0,
    endpoint: "",
    stop: () => {
      /* nothing */
    },
  };
}

/** The currently-running server handle (or a non-running idle handle). */
export function getMobileServer(): MobileServerHandle {
  return currentHandle ?? makeIdleHandle();
}

/** True if the mobile feature is available (enabled + server reachable). Used
 *  by the PC UI to decide whether to show the "connect phone" button. */
export function isMobileServerRunning(): boolean {
  return !!currentHandle?.running;
}

/** Re-export so index.ts / RuntimeManager don't need a second import. */
export { mobileEventBus } from "./MobileEventBus.js";

/** Convenience for the PC UI: lazily read app path without importing electron
 *  in the index module twice. Currently unused but reserved for the dialog. */
export function _appRef(): Electron.App {
  return app;
}
