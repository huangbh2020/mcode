/**
 * OpenCode (v2) server manager — the app-wide singleton that owns the
 * embedded `opencode serve` child process.
 *
 * ## Why a private persistent server (not per-turn, not the user's own)
 * OpenCode is client-server: every interaction (sessions, prompts,
 * permissions, models) is HTTP + SSE against a server. Mcode spawns its OWN
 * instance on an ephemeral port with a generated password:
 *   - isolated from any server the user runs themselves (TUI/desktop spawn
 *     their own; v2 TUI auto-discovers a shared one on 4096 — we never touch
 *     that port), so our config injection can't affect their sessions;
 *   - shares opencode's REAL data dir (~/.local/share/opencode, SQLite WAL,
 *     multi-process safe) — credentials, models.dev cache and session
 *     history are shared with the user's terminal CLI by design ("官方登录"
 *     is the whole point);
 *   - persistent across turns: session state survives turn boundaries, and
 *     sessions are db-backed so a server restart (crash, config change)
 *     resumes by id with zero loss.
 *
 * ## Startup handshake (verified live on 2.1.1/Windows)
 *   - stdout line `server listening on http://127.0.0.1:<port>` (NOTE: no
 *     "opencode" prefix — the SDK's own createOpencodeServer greps the same
 *     line with a different regex; we spawn ourselves for binary-path
 *     control anyway);
 *   - v2 servers REQUIRE auth: without OPENCODE_SERVER_PASSWORD they
 *     generate one and print it to stdout (useless for us) — we generate our
 *     own and authenticate via Basic `opencode:<password>` headers on the
 *     SDK client.
 *
 * ## Event hub
 * ONE global SSE subscription (`client.v2.event.subscribe()`, the V2Event
 * bus) is multiplexed to per-turn listeners registered by the provider.
 * Because the server is private, every session visible on the bus during a
 * turn is either that turn's session or one of its subagent children — no
 * cross-project leakage is possible.
 *
 * ## Config injection & fingerprint restarts
 * OPENCODE_CONFIG_CONTENT carries the static permission-ask config (the
 * host-side bridge interprets modes, so the injected config NEVER changes
 * with the UI permission mode — zero restarts on mode flips), autoupdate
 * off, and the MCP bridge. The MCP block is part of the server fingerprint:
 * drift (settings edit) restarts the server in place.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server as NetServer } from "node:net";
import { randomBytes } from "node:crypto";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2";
import type { V2Event } from "@opencode-ai/sdk/v2/types";
import { resolveOpenCodeCliPath, openCodePathNeedsShellWrap } from "./opencodeBinaryResolve.js";
import { log } from "@main/lib/logger.js";

const HOSTNAME = "127.0.0.1";
const START_TIMEOUT_MS = 20_000;
/** v2 prints this (no "opencode" prefix — verified 2.1.1). */
const LISTENING_RE = /server listening on (https?:\/\/\S+)/;

export interface OpenCodeServerHandle {
  client: OpencodeClient;
  baseUrl: string;
  fingerprint: string;
  /** Authenticated raw fetch against the server. Needed where the SDK's
   *  generated request shapes lag the installed CLI (2.1.1's prompt takes a
   *  FLAT {text} body while SDK 1.19.3 still sends {prompt:{text}}; the
   *  permission reply takes {decision} not {reply}). Verified live. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
}

type EventListener = (event: V2Event) => void;

interface ServerState {
  process: ChildProcess | null;
  client: OpencodeClient | null;
  baseUrl: string | null;
  password: string;
  fingerprint: string;
  starting: Promise<OpenCodeServerHandle> | null;
  listeners: Set<EventListener>;
  eventTaskRunning: boolean;
}

const state: ServerState = {
  process: null,
  client: null,
  baseUrl: null,
  password: "",
  fingerprint: "",
  starting: null,
  listeners: new Set(),
  eventTaskRunning: false,
};

function alive(): boolean {
  return Boolean(state.process && state.process.exitCode === null && !state.process.killed);
}

/** Ask the OS for a free TCP port (bind :0, read it, release). The race
 *  window before spawn is negligible for a loopback listener. */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv: NetServer = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, HOSTNAME, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

/**
 * The config injected via OPENCODE_CONFIG_CONTENT. Deliberately STATIC with
 * respect to the UI permission mode: every mutating/networky tool asks, and
 * the host-side permission bridge decides once/reject per Mcode's own mode
 * logic (pi's interpretation model). Consequences:
 *   - mode flips take effect on the very next ask — no server restart;
 *   - even bypassPermissions still surfaces asks (host auto-approves), which
 *     keeps recordPre (rewind snapshots) working in every mode;
 *   - reads stay at opencode defaults (allowed in-project; .env denied —
 *     stricter than Mcode needs, acceptable).
 * Exported pure for the smoke script.
 */
export function buildOpenCodeServerConfig(mcp?: Record<string, unknown>): Record<string, unknown> {
  return {
    permission: {
      edit: "ask",
      bash: "ask",
      webfetch: "ask",
      websearch: "ask",
      task: "ask",
      subagent: "ask",
    },
    // Our child process must never self-update (the npm-managed version is
    // the user's; a mid-session binary swap would tear every conversation).
    autoupdate: false,
    ...(mcp && Object.keys(mcp).length > 0 ? { mcp } : {}),
  };
}

/** Fingerprint of everything the injected config depends on — drift restarts
 *  the server (only the MCP block can drift; the permission asks are
 *  constant by design). */
export function openCodeServerFingerprint(mcp?: Record<string, unknown>): string {
  return JSON.stringify(buildOpenCodeServerConfig(mcp));
}

function killServer(): void {
  const p = state.process;
  state.process = null;
  state.client = null;
  state.baseUrl = null;
  state.eventTaskRunning = false;
  if (p && p.exitCode === null && !p.killed) {
    try {
      p.kill();
    } catch {
      /* already gone */
    }
  }
}

async function startServer(fingerprint: string): Promise<OpenCodeServerHandle> {
  const cliPath = resolveOpenCodeCliPath();
  if (!cliPath) {
    throw new Error(
      "未找到 OpenCode CLI:请先安装 v2(npm install -g @opencode/cli)或在设置页查看安装引导",
    );
  }
  const port = await findFreePort();
  const password = randomBytes(24).toString("base64url");
  const [command, args, shellWrap] = openCodePathNeedsShellWrap(cliPath)
    ? (["cmd.exe", ["/c", cliPath, "serve", "--hostname", HOSTNAME, "--port", String(port)], true] as const)
    : ([cliPath, ["serve", "--hostname", HOSTNAME, "--port", String(port)], false] as const);

  const config = JSON.parse(fingerprint) as Record<string, unknown>;
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: {
      ...(process.env as Record<string, string>),
      OPENCODE_SERVER_PASSWORD: password,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    },
    windowsHide: true,
    shell: shellWrap ? true : false,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const baseUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`opencode serve did not report a listening line within ${START_TIMEOUT_MS}ms`));
    }, START_TIMEOUT_MS);
    let buf = "";
    const onOut = (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const m = LISTENING_RE.exec(buf);
      if (m) {
        cleanup();
        clearTimeout(timer);
        resolve(m[1].replace(/\/+$/, ""));
      }
    };
    const onExit = (code: number | null) => {
      cleanup();
      clearTimeout(timer);
      reject(new Error(`opencode serve exited during startup (code=${code ?? "null"}): ${buf.slice(-400)}`));
    };
    const cleanup = () => {
      child.stdout?.off("data", onOut);
      child.off("exit", onExit);
    };
    child.stdout?.on("data", onOut);
    child.on("exit", onExit);
    child.on("error", (err) => {
      cleanup();
      clearTimeout(timer);
      reject(err);
    });
  });

  child.on("exit", (code, signal) => {
    // Mid-flight death: the next ensure* call respawns. Sessions are
    // db-backed, so the next turn resumes by id — nothing is lost except
    // the in-flight one (its adapter times out / errors the turn).
    if (state.process === child) {
      log.warn(`opencode server exited (code=${code ?? "null"} signal=${signal ?? "null"}); will respawn on next use`);
      killServer();
    }
  });
  // Keep stderr out of the console but visible in logs for diagnostics.
  child.stderr?.on("data", (chunk: Buffer) => {
    const line = chunk.toString("utf8").trim();
    if (line) log.info(`opencode server stderr: ${line.slice(0, 300)}`);
  });

  const client = createOpencodeClient({
    baseUrl,
    headers: {
      Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
    },
  });

  state.process = child;
  state.client = client;
  state.baseUrl = baseUrl;
  state.password = password;
  state.fingerprint = fingerprint;
  log.info(`opencode server ready at ${baseUrl}`);
  return handleOf(fingerprint);
}

/** Ensure the singleton server is up with the given config fingerprint.
 *  Restarts in place on fingerprint drift (MCP settings change). Concurrent
 *  callers share one startup promise. */
export async function ensureOpenCodeServer(mcp?: Record<string, unknown>): Promise<OpenCodeServerHandle> {
  const fingerprint = openCodeServerFingerprint(mcp);
  if (alive() && state.client && state.fingerprint === fingerprint) {
    return handleOf(state.fingerprint);
  }
  if (alive() && state.client && state.fingerprint !== fingerprint) {
    log.info("opencode server config drift — restarting in place");
    killServer();
  }
  if (state.starting) return state.starting;
  state.starting = startServer(fingerprint)
    .then((handle) => {
      runEventHub();
      return handle;
    })
    .finally(() => {
      state.starting = null;
    });
  return state.starting;
}

function handleOf(fingerprint: string): OpenCodeServerHandle {
  const baseUrl = state.baseUrl!;
  const auth = `Basic ${Buffer.from(`opencode:${state.password}`).toString("base64")}`;
  return {
    client: state.client!,
    baseUrl,
    fingerprint,
    fetch: (path: string, init?: RequestInit) =>
      fetch(`${baseUrl}${path}`, {
        ...init,
        headers: { Authorization: auth, "Content-Type": "application/json", ...(init?.headers ?? {}) },
      }),
  };
}

/* ── global event hub ── */

/** Single SSE subscription multiplexed to all registered listeners.
 *
 *  ⚠️ WIRE SHAPE (verified live on 2.1.1): the hey-api SSE stream yields the
 *  EVENT OBJECT ITSELF ({id, type, data, …}) per iteration — NOT a
 *  {data: event} wrapper. `chunk.data` is the event's INNER payload; reading
 *  it as the event silently drops everything (the original infinite-loading
 *  bug). Restart logic: if the stream dies while the server is still alive
 *  (transient disconnect), resubscribe; if the server died, the next
 *  ensureOpenCodeServer re-runs the hub. */
function runEventHub(): void {
  const client = state.client;
  if (!client || state.eventTaskRunning) return;
  state.eventTaskRunning = true;
  void (async () => {
    while (state.client === client && alive()) {
      try {
        const sub = await client.v2.event.subscribe();
        for await (const chunk of sub.stream) {
          if (state.client !== client) break;
          const ev = chunk as unknown as V2Event;
          if (!ev || typeof ev !== "object" || !("type" in ev)) continue;
          for (const listener of [...state.listeners]) {
            try {
              listener(ev);
            } catch (err) {
              log.error(`opencode event listener failed: ${(err as Error).message}`);
            }
          }
        }
      } catch (err) {
        if (state.client !== client) return;
        log.warn(`opencode event stream error: ${(err as Error).message}; resubscribing in 1s`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    state.eventTaskRunning = false;
  })();
}

/** Register a listener on the global V2Event bus. Returns an unregister
 *  function; the provider calls it when the turn ends. */
export function onOpenCodeEvent(listener: EventListener): () => void {
  state.listeners.add(listener);
  return () => {
    state.listeners.delete(listener);
  };
}

/** Best-effort shutdown (app quit). The before-quit killDescendants sweep
 *  also covers the child — this just makes it graceful. */
export function disposeOpenCodeServer(): void {
  killServer();
  state.listeners.clear();
}
