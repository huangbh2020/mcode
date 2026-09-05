/**
 * `codex app-server` JSON-RPC client — the protocol base under
 * CodexAgentSdkProvider.
 *
 * ## Wire shape (verified against the app-server protocol README)
 * stdio, newline-delimited JSON (JSONL). The `jsonrpc: "2.0"` envelope field
 * is OMITTED on the wire; frames are `{ id, method, params }` for requests,
 * `{ id, result }` / `{ id, error }` for responses, and
 * `{ method, params }` (no id) for notifications.
 *
 * Three traffic classes, all handled here:
 *   1. client → server requests  : `request(method, params)` → Promise
 *   2. server → client notifications: `onNotification(cb)` (item deltas,
 *      turn completions, token usage, …)
 *   3. server → client REQUESTS   : approval prompts / user-input prompts /
 *      dynamic-tool invocations. These carry an `id` + `method` and MUST be
 *      answered with a response frame — `handleRequest(cb)` registers the
 *      dispatcher; the callback returns the result object.
 *
 * ## Process model
 * One app-server process per GUI session (crash-domain isolation, mirroring
 * Claude's one CLI per session). A non-deliberate exit rejects all pending
 * requests and invokes `onExit` so the provider can surface the failure or
 * respawn on the next turn.
 *
 * ## Env
 * The caller supplies the env (CODEX_HOME, MCODE_CODEX_KEY_* provider keys).
 * PATH/HOME etc. must be included by the caller — the child needs them to
 * resolve sandbox helpers.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

type JsonRpcId = number;

/** A request frame the SERVER sends us (approval / user-input / tool call). */
export interface ServerRequestFrame {
  id: JsonRpcId;
  method: string;
  params: unknown;
}

/** A notification frame from the server (no id). */
export interface NotificationFrame {
  method: string;
  params: unknown;
}

export interface CodexAppServerClientOptions {
  /** Absolute path to the codex binary. */
  codexPath: string;
  /** Working directory the process starts in (the session cwd). */
  cwd: string;
  /** Full env for the child (caller composes CODEX_HOME + keys + PATH). */
  env: Record<string, string>;
  /** Invoked on unexpected process exit. */
  onExit?: (code: number | null, signal: string | null) => void;
  /** Logger sink (provider context's log). */
  log: { info(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void };
}

/** Default per-request timeout — generous: thread/turn starts can cold-boot
 *  the model connector; approvals are answered by human timescales but ride
 *  their own frame (no timeout — they resolve when the user decides). */
const REQUEST_TIMEOUT_MS = 120_000;

export class CodexAppServerClient {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout | null;
  }>();
  private buffer = "";
  private started = false;
  private disposed = false;

  /** Server → client request dispatcher (approvals / prompts / tools). */
  private requestHandler: ((frame: ServerRequestFrame) => Promise<unknown> | unknown) | null = null;
  /** Notification listeners. */
  private readonly notificationListeners = new Set<(frame: NotificationFrame) => void>();

  constructor(private readonly opts: CodexAppServerClientOptions) {}

  /** Register the server→client request dispatcher. Must be set before
   *  `start()` so an early approval prompt is never unanswered. */
  handleRequest(cb: (frame: ServerRequestFrame) => Promise<unknown> | unknown): void {
    this.requestHandler = cb;
  }

  onNotification(cb: (frame: NotificationFrame) => void): () => void {
    this.notificationListeners.add(cb);
    return () => this.notificationListeners.delete(cb);
  }

  /** Spawn the process and perform the protocol `initialize` handshake. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.disposed = false;

    const child = spawn(this.opts.codexPath, ["app-server"], {
      cwd: this.opts.cwd,
      env: this.opts.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.proc = child;

    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => this.feed(chunk));
    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (chunk: string) => {
      // app-server logs human diagnostics on stderr — pipe to our log.
      const text = chunk.trim();
      if (text) this.opts.log.info(`[codex app-server] ${text}`);
    });
    child.on("error", (err) => {
      this.opts.log.error(`codex app-server spawn failed: ${err.message}`);
      this.failAllPending(new Error(`codex app-server 启动失败:${err.message}`));
    });
    child.on("exit", (code, signal) => {
      const deliberate = this.disposed;
      this.proc = null;
      this.failAllPending(
        deliberate
          ? new Error("codex app-server disposed")
          : new Error(`codex app-server 意外退出(code=${code ?? "null"})`),
      );
      if (!deliberate) this.opts.onExit?.(code, signal);
    });

    // Protocol handshake. experimentalApi opts into the dynamicTools API
    // (server rejects thread/start.dynamicTools without it — verified live
    // against 0.153.4). Unknown fields are ignored by the server.
    await this.request("initialize", {
      clientInfo: { name: "Mcode", title: "Mcode", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
  }

  /** Client → server request. Resolves with the `result` value; rejects on
   *  JSON-RPC error frames, timeouts, and process death. */
  request(method: string, params?: unknown): Promise<unknown> {
    const proc = this.proc;
    if (!proc || !proc.stdin?.writable) {
      return Promise.reject(new Error(`codex app-server 未运行(${method})`));
    }
    const id = this.nextId++;
    const frame = { id, method, ...(params !== undefined ? { params } : {}) };
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex app-server 请求超时(${method})`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.writeFrame(frame);
    });
  }

  /** Fire-and-forget client → server notification (none used today; kept for
   *  protocol completeness). */
  notify(method: string, params?: unknown): void {
    this.writeFrame({ method, ...(params !== undefined ? { params } : {}) });
  }

  /** Tear down the process. Deliberate — suppresses onExit. */
  async dispose(): Promise<void> {
    this.disposed = true;
    const proc = this.proc;
    this.proc = null;
    this.failAllPending(new Error("codex app-server disposed"));
    if (!proc) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch { /* already dead */ }
        resolve();
      }, 2000);
      proc.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      try { proc.kill("SIGTERM"); } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  isRunning(): boolean {
    return this.proc !== null && !this.disposed;
  }

  /* ── internals ── */

  private writeFrame(frame: unknown): void {
    const proc = this.proc;
    if (!proc?.stdin?.writable) return;
    proc.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  /** Feed stdout text into the JSONL framer and dispatch complete lines. */
  private feed(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      this.dispatchLine(line);
    }
    // Pathological buffer growth (no newlines ever) — drop after 8MB.
    if (this.buffer.length > 8 * 1024 * 1024) {
      this.opts.log.warn("codex app-server: dropping oversized partial frame");
      this.buffer = "";
    }
  }

  private dispatchLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch (err) {
      this.opts.log.warn(`codex app-server: unparseable frame: ${line.slice(0, 200)} (${(err as Error).message})`);
      return;
    }

    // Class 3 — server → client REQUEST (has id + method): answer it.
    if (typeof msg.id === "number" && typeof msg.method === "string") {
      void this.dispatchServerRequest(msg as unknown as ServerRequestFrame);
      return;
    }

    // Response to one of OUR requests (has id, no method).
    if (typeof msg.id === "number" && msg.method === undefined) {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (entry.timer) clearTimeout(entry.timer);
      if (msg.error) {
        const err = msg.error as { code?: number; message?: string };
        entry.reject(new Error(`codex rpc ${err.code ?? ""}: ${err.message ?? "unknown error"}`));
      } else {
        entry.resolve(msg.result);
      }
      return;
    }

    // Class 2 — notification (method, no id).
    if (typeof msg.method === "string") {
      const frame: NotificationFrame = { method: msg.method, params: msg.params };
      for (const cb of this.notificationListeners) {
        try {
          cb(frame);
        } catch (err) {
          this.opts.log.error(`codex notification handler threw: ${(err as Error).message}`);
        }
      }
    }
  }

  private async dispatchServerRequest(frame: ServerRequestFrame): Promise<void> {
    const handler = this.requestHandler;
    if (!handler) {
      // No handler — respond with a JSON-RPC error so the server unblocks.
      this.writeFrame({ id: frame.id, error: { code: -32601, message: `Mcode: no handler for ${frame.method}` } });
      return;
    }
    try {
      const result = await handler(frame);
      this.writeFrame({ id: frame.id, result: result ?? {} });
    } catch (err) {
      this.writeFrame({
        id: frame.id,
        error: { code: -32000, message: (err as Error).message || "handler failed" },
      });
    }
  }

  private failAllPending(err: Error): void {
    for (const [, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }
}

/** Fresh approval/request id (used for our side of bridged requests). */
export function newRequestId(): string {
  return randomUUID();
}
