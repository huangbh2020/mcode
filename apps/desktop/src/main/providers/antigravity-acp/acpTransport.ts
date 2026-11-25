/**
 * Direct stdio NDJSON JSON-RPC 2.0 transport for ACP servers (`agy acp`).
 *
 * Pure node (no electron, no `@main/*` imports) so smoke tests can run it
 * against a scripted fake ACP process directly.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import {
  ACP_AUTH_REQUIRED_CODE,
  AcpAbortedError,
  AcpAuthRequiredError,
  AcpConnectionClosedError,
  AcpRpcError,
  AcpRpcEnvelopeSchema,
} from "./acpProtocol.js";

export interface AcpTransportLog {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface AcpRequestContext {
  id: string | number;
  signal: AbortSignal;
}

export interface AcpTransportOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  eofGraceMs?: number;
  hardKill?: (child: ChildProcess) => void;
  onRequest?: (
    method: string,
    params: unknown,
    ctx: AcpRequestContext,
  ) => Promise<unknown> | unknown;
  onNotification?: (method: string, params: unknown) => void;
  onOtherLine?: (line: string) => void;
  onClose?: (error: Error) => void;
  log?: AcpTransportLog;
}

interface PendingRpc {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

const STDERR_TAIL_CHARS = 2048;
const DEFAULT_EOF_GRACE_MS = 2_000;

export class AcpTransport {
  private readonly child: ChildProcess;
  private readonly pending = new Map<string | number, PendingRpc>();
  private readonly incomingControllers = new Map<string | number, AbortController>();
  private nextId = 1;
  private closedError: Error | null = null;
  private closing = false;
  private exited = false;
  private stderrTail = "";
  private graceTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly options: AcpTransportOptions) {
    this.child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
    });
    this.child.stderr?.on("error", () => {
      /* ignore stderr stream teardown errors */
    });
    this.child.stdin?.on("error", (err) => {
      this.terminate(new AcpConnectionClosedError(err.message, this.stderrTail));
    });

    if (this.child.stdout) {
      const rl = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
      rl.on("line", (line) => this.handleLine(line));
      rl.on("close", () => {
        if (!this.exited) {
          this.terminate(
            new AcpConnectionClosedError("ACP stdout closed", this.stderrTail.trim() || undefined),
          );
        }
      });
    }

    this.child.on("error", (err) => {
      this.terminate(new AcpConnectionClosedError(err.message, this.stderrTail.trim() || undefined));
    });

    this.child.on("exit", (code, signal) => {
      this.exited = true;
      if (this.graceTimer) clearTimeout(this.graceTimer);
      const detail = this.stderrTail.trim();
      const msg = detail || `ACP process exited (code=${code ?? "null"}, signal=${signal ?? "null"})`;
      this.terminate(new AcpConnectionClosedError(msg, detail || undefined));
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get isClosed(): boolean {
    return this.closedError !== null;
  }

  request<T = unknown>(
    method: string,
    params: unknown,
    opts?: { timeoutMs?: number | null; signal?: AbortSignal },
  ): Promise<T> {
    if (this.closedError) {
      return Promise.reject(this.closedError);
    }
    if (opts?.signal?.aborted) {
      return Promise.reject(new AcpAbortedError());
    }
    const id = this.nextId++;
    const timeoutMs = opts?.timeoutMs === undefined ? 60_000 : opts.timeoutMs;

    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
        void this.notify("$/cancel_request", { requestId: id }).catch(() => {});
        reject(new AcpAbortedError());
      };

      const timer =
        timeoutMs !== null
          ? setTimeout(() => {
              const entry = this.pending.get(id);
              if (!entry) return;
              this.pending.delete(id);
              opts?.signal?.removeEventListener("abort", onAbort);
              void this.notify("$/cancel_request", { requestId: id }).catch(() => {});
              reject(new Error(`ACP request '${method}' timed out after ${timeoutMs}ms`));
            }, timeoutMs)
          : undefined;

      opts?.signal?.addEventListener("abort", onAbort, { once: true });

      this.pending.set(id, {
        method,
        resolve: (val) => {
          opts?.signal?.removeEventListener("abort", onAbort);
          resolve(val as T);
        },
        reject: (err) => {
          opts?.signal?.removeEventListener("abort", onAbort);
          reject(err);
        },
        timer,
      });

      this.sendFrame({ jsonrpc: "2.0", id, method, params }).catch((err) => {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
        entry.reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  notify(method: string, params: unknown): Promise<void> {
    return this.sendFrame({ jsonrpc: "2.0", method, params });
  }

  close(reason?: Error): void {
    if (this.closing) return;
    this.closing = true;
    this.terminate(reason ?? new AcpConnectionClosedError("ACP transport closed"));

    try {
      if (this.child.stdin && !this.child.stdin.destroyed) {
        this.child.stdin.end();
      }
    } catch {
      /* ignore */
    }

    if (!this.exited) {
      const grace = this.options.eofGraceMs ?? DEFAULT_EOF_GRACE_MS;
      this.graceTimer = setTimeout(() => {
        if (this.exited) return;
        try {
          if (this.options.hardKill) {
            this.options.hardKill(this.child);
          } else {
            this.child.kill("SIGKILL");
          }
        } catch {
          /* ignore */
        }
      }, grace);
      this.graceTimer.unref();
    }
  }

  private sendFrame(frame: Record<string, unknown>): Promise<void> {
    if (this.closedError) {
      return Promise.reject(this.closedError);
    }
    const stdin = this.child.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) {
      return Promise.reject(new AcpConnectionClosedError("ACP stdin is not writable"));
    }
    const line = `${JSON.stringify(frame)}\n`;
    return new Promise((resolve, reject) => {
      stdin.write(line, "utf8", (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private handleLine(rawLine: string): void {
    const trimmed = rawLine.trim();
    if (!trimmed) return;

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(trimmed);
    } catch {
      this.options.onOtherLine?.(trimmed);
      return;
    }

    const envelope = AcpRpcEnvelopeSchema.safeParse(parsedJson);
    if (!envelope.success) {
      this.options.onOtherLine?.(trimmed);
      return;
    }
    const msg = envelope.data;

    // 1. Incoming request or notification
    if (msg.method !== undefined) {
      if (msg.id !== undefined) {
        this.handleIncomingRequest(msg.id, msg.method, msg.params);
      } else {
        this.handleIncomingNotification(msg.method, msg.params);
      }
      return;
    }

    // 2. Response to one of our outgoing requests
    if (msg.id !== undefined) {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (entry.timer) clearTimeout(entry.timer);

      if (msg.error) {
        const err =
          msg.error.code === ACP_AUTH_REQUIRED_CODE
            ? new AcpAuthRequiredError(msg.error.message, msg.error.data)
            : new AcpRpcError(msg.error.code, msg.error.message, msg.error.data);
        entry.reject(err);
      } else {
        entry.resolve(msg.result);
      }
    }
  }

  private handleIncomingNotification(method: string, params: unknown): void {
    if (method === "$/cancel_request" && params && typeof params === "object") {
      const reqId = (params as { requestId?: unknown }).requestId;
      if (typeof reqId === "string" || typeof reqId === "number") {
        this.incomingControllers.get(reqId)?.abort();
      }
      return;
    }
    try {
      this.options.onNotification?.(method, params);
    } catch (err) {
      this.options.log?.warn("acp notification handler error:", err);
    }
  }

  private handleIncomingRequest(id: string | number, method: string, params: unknown): void {
    const controller = new AbortController();
    this.incomingControllers.set(id, controller);

    const finish = (payload: Record<string, unknown>) => {
      this.incomingControllers.delete(id);
      if (!this.closedError) {
        void this.sendFrame({ jsonrpc: "2.0", id, ...payload }).catch(() => {});
      }
    };

    if (!this.options.onRequest) {
      finish({ error: { code: -32601, message: `Method not supported: ${method}` } });
      return;
    }

    Promise.resolve()
      .then(() => this.options.onRequest!(method, params, { id, signal: controller.signal }))
      .then(
        (result) => {
          finish({ result: result === undefined ? null : result });
        },
        (err: unknown) => {
          const code = err instanceof AcpRpcError ? err.code : -32000;
          const message = err instanceof Error ? err.message : String(err);
          finish({ error: { code, message } });
        },
      );
  }

  private terminate(error: Error): void {
    if (this.closedError) return;
    this.closedError = error;

    for (const [, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();

    for (const [, ctrl] of this.incomingControllers) {
      ctrl.abort();
    }
    this.incomingControllers.clear();

    try {
      this.options.onClose?.(error);
    } catch {
      /* ignore */
    }
  }
}
