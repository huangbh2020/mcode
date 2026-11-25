/**
 * Direct stdio transport to the Claude Code CLI — no Agent SDK package.
 *
 * One `CliTransport` owns one `claude` process. It writes the host's frames to
 * the child's stdin, reads the child's stdout line by line, and keeps the two
 * directions of the control protocol apart from the session messages:
 *
 *   - control_response  → resolves the pending host→CLI `request()` of that id
 *   - control_request   → handed to `onControlRequest`; its return value is
 *                         written back as a success response, a throw as an
 *                         error response, `undefined` leaves it unanswered
 *   - control_cancel_request → aborts the signal of that in-flight request
 *   - anything else    → yielded by `readMessages()` (the session stream)
 *
 * Process lifecycle mirrors what the Agent SDK did for us, because every
 * behaviour around it was tuned against the real CLI:
 *   - stdin EOF is the graceful stop. The CLI finishes its turn, tears its own
 *     tools down and exits — unless background tasks keep it alive, which is
 *     the persistent-transport case the provider relies on.
 *   - abort / close = end stdin, wait {@link CliTransportOptions.eofGraceMs},
 *     then kill (harder on win32, where a bare SIGKILL reaches only the CLI
 *     itself — hence the injectable `hardKill`).
 *   - the message iterator ends when stdout closes, then throws if the process
 *     ended abnormally (non-zero exit / signal / spawn failure) or was
 *     aborted; a clean exit just ends it.
 *
 * This module is pure node (no electron, no `@main/*` imports) so the smoke
 * scripts and CLI protocol probes can bundle it as is.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import {
  CliAbortedError,
  CliClosedError,
  ControlHandlerError,
  controlError,
  controlSuccess,
  isControlRequestFrame,
  isControlResponseFrame,
  type ControlCancelFrame,
  type ControlRequest,
  type ControlRequestFrame,
  type ControlResponseFrame,
} from "./claudeProtocol.js";
import type { ClaudeMessage, ClaudeResultMessage } from "./claudeStreamTypes.js";

export interface CliTransportLog {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface CliTransportOptions {
  /** Executable to spawn — the user's `claude` (see lib/claudeExecutable.ts). */
  command: string;
  args: string[];
  cwd: string;
  /** Let a shell resolve `command` (the unresolved-shim last resort — see
   *  lib/claudeExecutable.ts). Off for every other launch form. */
  shell?: boolean;
  /** The child's whole environment (the caller spreads `process.env`). */
  env: NodeJS.ProcessEnv;
  /** User stop / reap. Firing it closes the transport (stdin EOF → kill). */
  abortController: AbortController;
  /** How long the process gets to exit on its own after stdin EOF before it
   *  is killed. Default 2000 ms — the Agent SDK's own grace. */
  eofGraceMs?: number;
  /** Forceful kill once the grace runs out. Default: SIGKILL. The provider
   *  injects a process-TREE kill, because on win32 killing only the CLI
   *  orphans whatever it started (a dev server the model launched). */
  hardKill?: (child: ChildProcess) => void;
  /** stderr chunks, for logging. A tail is also kept for error messages. */
  stderr?: (data: string) => void;
  /** Answers the CLI's control requests (approval asks, user dialogs…).
   *  Return the success payload, throw to answer with an error, or return
   *  `undefined` to send nothing (the CLI's own deadline then settles it). */
  onControlRequest?: (
    request: ControlRequest,
    ctx: { signal: AbortSignal; requestId: string },
  ) => Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined;
  log?: CliTransportLog;
}

/** Default stderr tail kept for exit messages. */
const STDERR_TAIL_CHARS = 2048;
/** Upper bound on the wait for the process exit after stdout closed. */
const EXIT_WAIT_MS = 5_000;
/** POSIX: SIGTERM first, SIGKILL after this. */
const TERM_TO_KILL_MS = 5_000;

/** Push-based queue the read loop feeds and `readMessages()` drains. */
class MessageQueue {
  private items: ClaudeMessage[] = [];
  private waiters: Array<(r: { done: true; error?: unknown } | { done: false; value: ClaudeMessage }) => void> = [];
  private endState: { done: true; error?: unknown } | null = null;

  push(value: ClaudeMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.items.push(value);
  }

  end(error?: unknown): void {
    if (this.endState) return;
    this.endState = { done: true, error };
    for (const waiter of this.waiters.splice(0)) waiter(this.endState);
  }

  next(): Promise<{ done: true; error?: unknown } | { done: false; value: ClaudeMessage }> {
    if (this.items.length > 0) {
      return Promise.resolve({ done: false, value: this.items.shift()! });
    }
    if (this.endState) return Promise.resolve(this.endState);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void;
  reject: (err: unknown) => void;
}

export class CliTransport {
  private readonly child: ChildProcess;
  private readonly ac: AbortController;
  private readonly log?: CliTransportLog;
  private readonly queue = new MessageQueue();
  private readonly pending = new Map<string, PendingRequest>();
  /** CLI→host requests being answered right now, by request_id. */
  private readonly inbound = new Map<string, AbortController>();
  private stderrTail = "";
  private spawnError: Error | null = null;
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  private stdoutClosed = false;
  private finalized = false;
  private closeRequested = false;
  private exitError: Error | null = null;
  private lastErrorResultText: string | undefined;
  private readonly onAbort = () => this.close();
  private readonly killTimers: NodeJS.Timeout[] = [];
  /** Resolves once the process outcome is settled (see `settle`). */
  private readonly settledPromise: Promise<void>;
  private markSettled!: () => void;

  constructor(private readonly opts: CliTransportOptions) {
    this.ac = opts.abortController;
    this.log = opts.log;
    this.settledPromise = new Promise((resolve) => {
      this.markSettled = resolve;
    });
    this.child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: opts.shell,
    });

    this.child.stdin?.on("error", (err: NodeJS.ErrnoException) => {
      // The usual cause is a write after the child exited (EPIPE) — e.g. the
      // answer to an approval the user's stop already made moot.
      this.log?.warn(`claude cli: stdin write failed (child likely exited): ${err.code ?? err.message}`);
    });

    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
      opts.stderr?.(chunk);
    });

    // readline over stdout: one JSON object per line; crlfDelay handles \r\n.
    const rl = createInterface({ input: this.child.stdout!, crlfDelay: Infinity });
    rl.on("line", (line) => this.onLine(line));
    rl.on("close", () => {
      this.stdoutClosed = true;
      void this.settle();
    });

    this.child.on("error", (err: NodeJS.ErrnoException) => {
      // spawn ENOENT / EACCES, or a later process error.
      this.spawnError = new CliClosedError(`Failed to spawn Claude Code process: ${err.message}`);
      this.log?.error(`claude cli: process error: ${err.message}`);
      void this.settle();
    });
    this.child.on("exit", (code, signal) => {
      this.exitInfo = { code, signal };
      this.clearKillTimers();
      void this.settle();
    });

    this.ac.signal.addEventListener("abort", this.onAbort, { once: true });
    if (this.ac.signal.aborted) this.close();
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  /** Resolves when the process outcome is settled — the point after which
   *  temp files and loopback servers owned for this process can go. */
  get closed(): Promise<void> {
    return this.settledPromise;
  }

  /** True while the process is alive and its stdin still takes writes. */
  isWritable(): boolean {
    const stdin = this.child.stdin;
    return !!stdin && !stdin.writableEnded && !stdin.destroyed && !this.finalized;
  }

  /** Append one JSON line to the CLI's stdin (a user turn, or a raw frame).
   *  Returns false when stdin can no longer take it — nothing is thrown, the
   *  caller decides what a dropped write means. */
  writeLine(frame: unknown): boolean {
    const stdin = this.child.stdin;
    if (!stdin || stdin.writableEnded || stdin.destroyed) return false;
    try {
      stdin.write(`${JSON.stringify(frame)}\n`);
      return true;
    } catch (err) {
      this.log?.warn(`claude cli: failed to write to process stdin: ${(err as Error).message}`);
      return false;
    }
  }

  /** End stdin — the graceful stop. Idempotent. */
  endInput(): void {
    const stdin = this.child.stdin;
    if (stdin && !stdin.writableEnded) stdin.end();
  }

  /** Send a host→CLI control request and await its success payload. Rejects
   *  with an error response, or when the process goes away first. */
  request<T extends Record<string, unknown> = Record<string, unknown>>(request: ControlRequest): Promise<T> {
    if (this.exitError) return Promise.reject(this.exitError);
    if (this.finalized) return Promise.reject(new CliClosedError("Claude Code process closed"));
    const request_id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(request_id, { resolve: resolve as (v: Record<string, unknown>) => void, reject });
      const written = this.writeLine({ type: "control_request", request_id, request });
      if (!written) {
        this.pending.delete(request_id);
        reject(new CliClosedError("Claude Code stdin is closed"));
      }
    });
  }

  /** Tear the process down: stdin EOF, grace, kill. Used on abort/reap and
   *  when the owner is done with the transport. Idempotent. */
  close(): void {
    if (this.closeRequested) return;
    this.closeRequested = true;
    this.endInput();
    this.rejectPending(
      this.ac.signal.aborted ? new CliAbortedError() : new CliClosedError("Claude Code process closed"),
    );
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const hardKill =
      this.opts.hardKill ??
      (() => {
        if (process.platform === "win32") child.kill("SIGKILL");
        else {
          child.kill("SIGTERM");
          this.killTimers.push(
            setTimeout(() => {
              if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
            }, TERM_TO_KILL_MS).unref(),
          );
        }
      });
    this.killTimers.push(
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) hardKill(child);
      }, this.opts.eofGraceMs ?? 2_000).unref(),
    );
  }

  /** The session stream: every non-control frame the CLI writes, until its
   *  stdout closes. Throws when the process ended abnormally or was aborted
   *  (see the module doc). */
  async *readMessages(): AsyncGenerator<ClaudeMessage, void> {
    for (;;) {
      const next = await this.queue.next();
      if (next.done) {
        if (next.error) throw next.error;
        return;
      }
      yield next.value;
    }
  }

  /* ─── internals ───────────────────────────────────────────────────── */

  private onLine(line: string): void {
    if (!line.trim()) return;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      this.log?.warn(`claude cli: non-JSON stdout: ${line.slice(0, 200)}`);
      return;
    }
    if (!msg || typeof msg !== "object") return;
    const type = (msg as { type?: unknown }).type;
    if (type === "control_response") {
      if (isControlResponseFrame(msg)) this.onResponse(msg);
      else this.log?.warn(`claude cli: malformed control_response: ${line.slice(0, 200)}`);
      return;
    }
    if (type === "control_request") {
      if (isControlRequestFrame(msg)) void this.onInboundRequest(msg);
      return;
    }
    if (type === "control_cancel_request") {
      const requestId = (msg as ControlCancelFrame).request_id;
      this.inbound.get(requestId)?.abort();
      this.inbound.delete(requestId);
      return;
    }
    this.queue.push(msg as ClaudeMessage);
    this.rememberErrorResult(msg as ClaudeMessage);
  }

  /** Text of the latest error `result`, when the last result was one. The
   *  CLI exits non-zero after writing it, and its own words ("API error:
   *  401 …") say far more to the user than an exit code does — so it
   *  replaces the exit error (see computeExitError). */
  private rememberErrorResult(msg: ClaudeMessage): void {
    if (msg.type !== "result") return;
    const result = msg as ClaudeResultMessage;
    let text: string | undefined;
    if (result.is_error) {
      text =
        result.subtype === "success"
          ? typeof result.result === "string"
            ? result.result
            : ""
          : (result.errors ?? [])
              .map((line) => line.trim())
              .filter(Boolean)
              .join("; ");
    }
    this.lastErrorResultText = text || undefined;
  }

  private onResponse(frame: ControlResponseFrame): void {
    const { response } = frame;
    const pending = this.pending.get(response.request_id);
    if (!pending) {
      // A response that arrived after we gave up on the request (abort,
      // timeout) — nothing is waiting for it.
      return;
    }
    this.pending.delete(response.request_id);
    if (response.subtype === "success") pending.resolve(response.response ?? {});
    else {
      const err = new CliClosedError(response.error || "control request failed") as CliClosedError & { code?: string };
      if (response.error_code) err.code = response.error_code;
      pending.reject(err);
    }
  }

  private async onInboundRequest(frame: ControlRequestFrame): Promise<void> {
    const { request_id, request } = frame;
    if (this.inbound.has(request_id)) {
      this.log?.warn(`claude cli: duplicate control request ${request.subtype} ${request_id} — skipping`);
      return;
    }
    const ac = new AbortController();
    this.inbound.set(request_id, ac);
    try {
      if (!this.opts.onControlRequest) {
        // The CLI's own convention for a request nobody can serve.
        throw new ControlHandlerError(
          `Unsupported control request subtype: ${request.subtype}`,
          "unsupported_request",
        );
      }
      const result = await this.opts.onControlRequest(request, { signal: ac.signal, requestId: request_id });
      if (result === undefined) {
        this.log?.info(`claude cli: control request ${request.subtype} ${request_id} left unanswered`);
        return;
      }
      this.writeLine(controlSuccess(request_id, result));
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      this.writeLine(
        controlError(
          request_id,
          err instanceof Error ? err.message : String(err),
          typeof code === "string" ? code : undefined,
        ),
      );
    } finally {
      this.inbound.delete(request_id);
    }
  }

  private rejectPending(err: Error): void {
    for (const pending of this.pending.values()) pending.reject(err);
    this.pending.clear();
  }

  private clearKillTimers(): void {
    for (const timer of this.killTimers) clearTimeout(timer);
    this.killTimers.length = 0;
  }

  /** Runs once both stdout has closed and the process outcome is known: turns
   *  the outcome into the iterator's terminal error (if any), releases every
   *  waiter, and closes the CLI→host requests still in flight. */
  private async settle(): Promise<void> {
    if (this.finalized) return;
    if (!this.stdoutClosed && !this.spawnError) return;
    if (!this.spawnError) {
      if (!this.exitInfo) {
        await new Promise<void>((resolve) => {
          const onExit = () => {
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(() => {
            this.child.off("exit", onExit);
            resolve();
          }, EXIT_WAIT_MS);
          timer.unref?.();
          this.child.once("exit", onExit);
        });
      }
    }
    // readline emits every pending `line` before `close`, so by now a
    // trailing control_response (e.g. a pending get_context_usage) has
    // already resolved its waiter — nothing left to drain here.
    this.finalized = true;
    this.ac.signal.removeEventListener("abort", this.onAbort);
    this.exitError = this.computeExitError();
    this.rejectPending(this.exitError ?? new CliClosedError("Claude Code process closed"));
    for (const ac of this.inbound.values()) ac.abort();
    this.inbound.clear();
    this.queue.end(this.exitError ?? undefined);
    this.markSettled();
  }

  private computeExitError(): Error | null {
    if (this.ac.signal.aborted) return new CliAbortedError();
    if (this.spawnError) return this.spawnError;
    const { code, signal } = this.exitInfo ?? { code: null, signal: null };
    const failed = (typeof code === "number" && code !== 0) || !!signal;
    if (failed && this.lastErrorResultText !== undefined) {
      return new CliClosedError(`Claude Code returned an error result: ${this.lastErrorResultText}`);
    }
    const tail = this.stderrTail.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").trim();
    const suffix = tail ? `. stderr: ${tail.slice(-400)}` : "";
    if (typeof code === "number" && code !== 0) {
      return new CliClosedError(`Claude Code process exited with code ${code}${suffix}`);
    }
    if (signal) {
      return new CliClosedError(`Claude Code process terminated by signal ${signal}${suffix}`);
    }
    return null;
  }
}
