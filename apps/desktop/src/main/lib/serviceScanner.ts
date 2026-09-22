/**
 * ServiceScanner — ground-truth discovery of agent-started services.
 *
 * The CLI's own bash-task bookkeeping (`bash-tasks.update`) loses services in
 * several real scenarios: `nohup … &` commands exit instantly and the roster
 * marks them completed while the detached process keeps serving; a turn that
 * ends abnormally marks every running task killed; each turn's adapter
 * starts with an empty roster and REPLACEs the list. Instead of patching the
 * ledger, this scanner observes the FACT: a TCP LISTENING socket owned by a
 * process inside the session's claude-CLI process subtree. That covers every
 * ledger quirk (nohup orphans included) and knows the port, which is what
 * the user actually cares about ("a server is running on :5173").
 *
 * Attribution needs no hooks: the SDK spawns the CLI via plain `node` with a
 * stable argument signature (`--output-format stream-json … --input-format
 * stream-json`), and every turn after the first adds `--resume=<cliSid>` —
 * so the process's own command line names its session. RuntimeManager keeps
 * the cliSid→GUI-session map in memory (`providerSessionId`), which this
 * module reverse-lookups. A turn-1 CLI (no --resume yet) is provisionally
 * bound when exactly one running-turn session lacks a binding.
 *
 * Discovery is sticky: once a `pid:port` is seen it is tracked by direct
 * liveness (is that pid still LISTENING on that port) rather than by
 * ancestry, so a service survives its CLI's death (the exact nohup case).
 * Entries are process-lifetime only — never persisted, never hydrated.
 *
 * Ancestry alone misses services that DETACH from their spawning shell
 * (Windows `Start-Process`, POSIX nohup/setsid): the intermediate shell
 * exits within the command's own lifetime, and Windows keeps the dead pid
 * in ParentProcessId while POSIX reparents — either way the chain from the
 * CLI is permanently broken (observed live: `powershell Start-Process
 * python -m http.server` leaves the listener with a dead powershell ppid).
 * So a second, ancestry-free attribution path covers exactly that: the
 * adapter reports each Bash tool call (noteBashToolStart/End), and any
 * LISTENING socket that appears during that window is claimed for the
 * session — a socket that binds while the model's command runs IS the
 * model's service, regardless of process lineage.
 *
 * Scope: claude-SDK sessions only. Pi's agent loop runs in-process, so its
 * bash children are direct children of main and indistinguishable from the
 * user's own terminals by ancestry — deliberately out of scope.
 */
import { execFile } from "node:child_process";
import { basename } from "node:path";
import { IPC } from "@contracts/ipc";
import type { ServiceSnapshot, ServicesEvent } from "@contracts/runtime";
import { sendToRenderer } from "@main/window.js";
import { mobileEventBus } from "@main/mobile/MobileEventBus.js";
import { runtimeManager } from "@main/claude/RuntimeManager.js";
import { killProcessTree } from "@main/lib/procTree.js";
import { log } from "@main/lib/logger.js";

const TICK_MS = 5_000;
/** Truncation for the command line carried on the snapshot (display-only). */
const CMDLINE_MAX = 200;

/* ── platform snapshots ─────────────────────────────────────────────── */

export interface ProcInfo {
  pid: number;
  ppid: number;
  /** Process image name — "node.exe" on Windows, argv0 basename on POSIX. */
  name: string;
  commandLine: string;
}

/** Run a helper binary and capture stdout. Rejects on spawn failure / non-zero. */
function run(file: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(String(stdout ?? ""));
      },
    );
  });
}

/** `Get-CimInstance Win32_Process … | ConvertTo-Json -Compress` rows. */
export function parseWinProcJson(out: string): ProcInfo[] {
  const text = out.trim();
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const infos: ProcInfo[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;
    const pid = Number(r.ProcessId);
    const ppid = Number(r.ParentProcessId);
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid)) continue;
    infos.push({
      pid,
      ppid,
      name: typeof r.Name === "string" ? r.Name : "",
      commandLine: typeof r.CommandLine === "string" ? r.CommandLine : "",
    });
  }
  return infos;
}

/** `ps -eo pid=,ppid=,args=` rows — everything after the second column is argv. */
export function parsePsLines(out: string): ProcInfo[] {
  const infos: ProcInfo[] = [];
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    const commandLine = m[3].trim();
    infos.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      name: commandLine.split(/\s+/)[0] ? basename(commandLine.split(/\s+/)[0]) : "",
      commandLine,
    });
  }
  return infos;
}

async function listProcessesWin(): Promise<Map<number, ProcInfo>> {
  const out = await run(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress",
    ],
    10_000,
  );
  return new Map(parseWinProcJson(out).map((p) => [p.pid, p]));
}

async function listProcessesPosix(): Promise<Map<number, ProcInfo>> {
  const out = await run("ps", ["-eo", "pid=,ppid=,args="], 5_000);
  return new Map(parsePsLines(out).map((p) => [p.pid, p]));
}

export async function listProcesses(): Promise<Map<number, ProcInfo>> {
  return process.platform === "win32" ? listProcessesWin() : listProcessesPosix();
}

export interface ListeningSocket {
  pid: number;
  port: number;
}

/** Windows `netstat -ano -p tcp` — LISTENING rows carry the pid in the last column. */
export function parseNetstatListening(out: string): ListeningSocket[] {
  const socks: ListeningSocket[] = [];
  for (const line of out.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    // TCP  <local>  <remote>  LISTENING  <pid>
    if (cols.length < 5 || cols[0] !== "TCP" || cols[3] !== "LISTENING") continue;
    const port = Number(cols[1].split(":").pop());
    const pid = Number(cols[4]);
    if (!Number.isInteger(port) || port <= 0 || !Number.isInteger(pid) || pid <= 0) continue;
    socks.push({ pid, port });
  }
  return socks;
}

/** `lsof -nP -iTCP -sTCP:LISTEN -Fpn` — `p` starts a process block, `n` names a socket. */
export function parseLsofListening(out: string): ListeningSocket[] {
  const socks: ListeningSocket[] = [];
  let pid = 0;
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) {
      pid = Number(line.slice(1));
    } else if (line.startsWith("n") && pid > 0) {
      const port = Number(line.slice(1).split(":").pop());
      if (Number.isInteger(port) && port > 0) socks.push({ pid, port });
    }
  }
  return socks;
}

/** `ss -tlnp` — LISTEN rows with a users:(…pid=N…) process column. */
export function parseSsListening(out: string): ListeningSocket[] {
  const socks: ListeningSocket[] = [];
  for (const line of out.split(/\r?\n/).slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols[0] !== "LISTEN") continue;
    const port = Number(cols[3]?.split(":").pop());
    const pidM = line.match(/pid=(\d+)/);
    if (!pidM) continue;
    const pid = Number(pidM[1]);
    if (!Number.isInteger(port) || port <= 0 || !Number.isInteger(pid) || pid <= 0) continue;
    socks.push({ pid, port });
  }
  return socks;
}

async function listListeningWin(): Promise<ListeningSocket[]> {
  return parseNetstatListening(await run("netstat", ["-ano", "-p", "tcp"], 8_000));
}

async function listListeningPosix(): Promise<ListeningSocket[]> {
  if (process.platform === "darwin") {
    return parseLsofListening(await run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"], 8_000));
  }
  try {
    return parseSsListening(await run("ss", ["-tlnp"], 5_000));
  } catch {
    // ss unavailable (minimal containers) — lsof reads the same facts.
    return parseLsofListening(await run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"], 8_000));
  }
}

export async function listListening(): Promise<ListeningSocket[]> {
  return process.platform === "win32" ? listListeningWin() : listListeningPosix();
}

/* ── CLI identification ─────────────────────────────────────────────── */

/** The SDK's ProcessTransport argument signature — stable across SDK
 *  versions and unlike anything a user would type by hand. */
export function isClaudeCliCmdline(commandLine: string): boolean {
  return (
    commandLine.includes("stream-json") &&
    (commandLine.includes("--input-format") || commandLine.includes("--output-format"))
  );
}

/** `--resume=<cliSessionId>` (turn 2+) — the command-line session stamp. */
export function parseResumeSessionId(commandLine: string): string | null {
  const m = commandLine.match(/--resume(?:=|\s)([A-Za-z0-9-]+)/);
  return m ? (m[1] ?? null) : null;
}

/* ── scanner ────────────────────────────────────────────────────────── */

interface TrackedService extends ServiceSnapshot {
  sessionId: string;
}

function socketKey(pid: number, port: number): string {
  return `${pid}:${port}`;
}

function emitServices(sessionId: string, services: ServiceSnapshot[]): void {
  const e: ServicesEvent = { type: "services.update", sessionId, services };
  sendToRenderer(IPC.CLAUDE_EVENT, { channel: IPC.CLAUDE_EVENT, sessionId, event: e });
  try {
    mobileEventBus.broadcast(e);
  } catch (err) {
    log.error(`service scanner: mobile broadcast error: ${(err as Error).message}`);
  }
}

class ServiceScanner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private scanning = false;
  private disposed = false;
  /** Sticky roster — key `${pid}:${port}`. Entries leave only when the
   *  socket stops listening; they deliberately survive their CLI's death. */
  private tracked = new Map<string, TrackedService>();
  /** CLI pids observed alive by the last completed scan — the activity gate
   *  that keeps the 5s cadence running while a CLI (turn or background-task
   *  hold) is around, and lets it idle at zero cost otherwise. */
  private liveCliPids = new Set<number>();
  /** Last signature emitted per session — an empty list is emitted ONCE (on
   *  the transition), so a dead-service session doesn't spam the wire. */
  private lastSigBySession = new Map<string, string>();
  /** Sockets claimed by the Bash-window diff (key `${pid}:${port}`). A claim
   *  is a pending attribution that the next scan adopts into `tracked`; it
   *  is pruned as soon as the socket stops listening. */
  private claimed = new Map<string, { sessionId: string; claimedAt: number }>();
  /** Open Bash-tool windows per session. Depth handles concurrent Bash calls
   *  in one turn; the baseline is the listener set captured at window open. */
  private bashWindows = new Map<string, { depth: number; startedAt: number; baseline?: Set<string> }>();
  /** Ring of recent scan results (timestamped listener key sets) — lets the
   *  claim path distinguish "bound during this command" from "already
   *  listening before it" even when the baseline snapshot raced the command
   *  (a fast-binding service can beat the baseline's netstat roundtrip). */
  private scanHistory: Array<{ at: number; keys: Set<string> }> = [];

  start(): void {
    if (this.timer || this.disposed) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
    log.info(`service scanner: started (${TICK_MS / 1000}s tick, ancestry + bash-window attribution)`);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.disposed = true;
    this.tracked.clear();
    this.liveCliPids.clear();
    this.lastSigBySession.clear();
    this.claimed.clear();
    this.bashWindows.clear();
    this.scanHistory = [];
  }

  private tick(): void {
    if (this.scanning || this.disposed) return;
    if (!this.shouldScan()) return;
    this.scanning = true;
    this.scanOnce()
      .catch((err) => {
        log.warn(`service scanner: scan failed: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        this.scanning = false;
      });
  }

  /** Scan only while something relevant can exist: a CLI process is alive
   *  (turn running or background-task hold), or a tracked service still
   *  needs liveness checks. Otherwise the tick is a no-op. */
  private shouldScan(): boolean {
    return (
      this.liveCliPids.size > 0 ||
      this.tracked.size > 0 ||
      runtimeManager.runningSessionIds().length > 0
    );
  }

  /** One full pass: snapshot processes + listeners, bind CLIs to sessions,
   *  refresh the sticky roster, emit per-session changes. Also the immediate
   *  refresh path after a stop request. */
  async scanOnce(): Promise<void> {
    const [procs, listening] = await Promise.all([listProcesses(), listListening()]);

    // 1. Identify live CLI processes; remember them for the activity gate.
    const cliProcs: ProcInfo[] = [];
    for (const p of procs.values()) {
      if (isClaudeCliCmdline(p.commandLine)) cliProcs.push(p);
    }
    this.liveCliPids = new Set(cliProcs.map((p) => p.pid));

    // 2. Bind CLI pid → GUI session via the `--resume=` command-line stamp.
    const boundSessions = new Set<string>();
    const cliBindings = new Map<number, string>();
    const unbound: number[] = [];
    for (const p of cliProcs) {
      const cliSid = parseResumeSessionId(p.commandLine);
      const sid = cliSid ? runtimeManager.findSessionIdByProviderId(cliSid) : null;
      if (sid) {
        cliBindings.set(p.pid, sid);
        boundSessions.add(sid);
      } else {
        unbound.push(p.pid);
      }
    }
    // Turn-1 CLIs carry no --resume. When exactly one such CLI exists AND
    // exactly one running-turn session has no binding yet, they belong to
    // each other; ambiguity is left to the next turn's --resume to resolve.
    if (unbound.length === 1) {
      const candidates = runtimeManager
        .runningSessionIds()
        .filter((sid) => !boundSessions.has(sid));
      if (candidates.length === 1) {
        cliBindings.set(unbound[0]!, candidates[0]!);
        boundSessions.add(candidates[0]!);
      }
    }

    // 3. Descendant closure per binding → pid → session attribution.
    const childrenOf = new Map<number, number[]>();
    for (const p of procs.values()) {
      const list = childrenOf.get(p.ppid);
      if (list) list.push(p.pid);
      else childrenOf.set(p.ppid, [p.pid]);
    }
    const pidSession = new Map<number, string>();
    for (const [cliPid, sid] of cliBindings) {
      const queue = [cliPid];
      const seen = new Set<number>([cliPid]);
      while (queue.length > 0) {
        const cur = queue.shift()!;
        for (const child of childrenOf.get(cur) ?? []) {
          if (seen.has(child)) continue;
          seen.add(child);
          if (!pidSession.has(child)) pidSession.set(child, sid);
          queue.push(child);
        }
      }
    }

    // 4. Refresh the sticky roster: keep existing entries whose socket still
    //    listens, adopt newly-attributed listeners — attribution is ancestry
    //    (pid inside a bound CLI's subtree) OR a Bash-window claim (socket
    //    appeared while the session's command ran). Both paths converge into
    //    the same liveness-governed roster; adopted claims are consumed.
    const now = Date.now();
    const listenKeys = new Set<string>();
    for (const l of listening) listenKeys.add(socketKey(l.pid, l.port));
    const next = new Map<string, TrackedService>();
    for (const l of listening) {
      const key = socketKey(l.pid, l.port);
      const existing = this.tracked.get(key);
      if (existing) {
        next.set(key, existing);
        continue;
      }
      const claim = this.claimed.get(key);
      const sid = pidSession.get(l.pid) ?? claim?.sessionId;
      if (!sid) continue;
      const proc = procs.get(l.pid);
      const entry: TrackedService = {
        key,
        port: l.port,
        pid: l.pid,
        name: proc?.name || proc?.commandLine.split(/\s+/)[0] || String(l.pid),
        commandLine: proc?.commandLine
          ? proc.commandLine.slice(0, CMDLINE_MAX)
          : undefined,
        startedAt: now,
        sessionId: sid,
      };
      next.set(key, entry);
      log.info(
        `service scanner: discovered ${key} (${entry.name}) for session ${sid} ` +
          `via ${claim ? "bash-window" : "ancestry"}`,
      );
    }
    this.tracked = next;
    // Claims are consumed on adoption; any claim whose socket stopped
    // listening (without ever being adopted) is dropped as stale.
    for (const key of this.claimed.keys()) {
      if (this.tracked.has(key) || !listenKeys.has(key)) this.claimed.delete(key);
    }
    // Ring for the claim path's pre-existing check (see scanHistory above).
    this.scanHistory.push({ at: now, keys: listenKeys });
    if (this.scanHistory.length > 13) this.scanHistory.shift();

    // 5. Emit per-session rosters. Unchanged non-empty lists are re-sent
    //    every pass (cheap, and it self-heals a renderer that reloaded its
    //    buckets); an empty list is sent once, on the transition.
    const bySession = new Map<string, ServiceSnapshot[]>();
    for (const s of this.tracked.values()) {
      const list = bySession.get(s.sessionId);
      if (list) list.push(s);
      else bySession.set(s.sessionId, [s]);
    }
    const sessions = new Set<string>([...bySession.keys(), ...this.lastSigBySession.keys()]);
    for (const sid of sessions) {
      const list = bySession.get(sid) ?? [];
      const sig = list.map((s) => s.key).join(",");
      const prev = this.lastSigBySession.get(sid);
      if (sig === prev && sig === "") continue; // was empty, still empty
      if (sig !== prev) this.lastSigBySession.set(sid, sig);
      emitServices(sid, list);
    }
  }

  /** Kill the process tree owning a tracked service. Guards on the sticky
   *  roster (session + pid + port must all match) so a stale renderer can
   *  never aim the kill at an arbitrary pid. Refreshes the roster right
   *  after so the UI drops the row without waiting for the next tick. */
  async stopService(sessionId: string, pid: number, port: number): Promise<void> {
    const entry = this.tracked.get(`${pid}:${port}`);
    if (!entry || entry.sessionId !== sessionId) {
      throw new Error(`service ${pid}:${port} is not tracked for this session`);
    }
    await killProcessTree(pid);
    await this.scanOnce();
  }

  /** Bash tool call opened (adapter hook, fired at the tool_use edge). The
   *  baseline listener set is captured now — asynchronously, but the CLI's
   *  own permission roundtrip + shell spawn + command startup give the
   *  netstat roundtrip a comfortable head start. Depth handles concurrent
   *  Bash calls; the baseline is taken once at the first open. */
  async noteBashToolStart(sessionId: string): Promise<void> {
    if (this.disposed) return;
    const open = this.bashWindows.get(sessionId);
    if (open) {
      open.depth += 1;
      return;
    }
    const startedAt = Date.now();
    this.bashWindows.set(sessionId, { depth: 1, startedAt });
    try {
      const baseline = new Set((await listListening()).map((l) => socketKey(l.pid, l.port)));
      const cur = this.bashWindows.get(sessionId);
      // Superseded (window closed while we snapshot) or disposed — discard.
      if (!cur || cur.startedAt !== startedAt) return;
      cur.baseline = baseline;
    } catch {
      // No baseline: the diff below then relies on scanHistory alone, which
      // still separates "listened before the window" from "bound within it".
    }
  }

  /** Bash tool call closed (adapter hook, fired at the tool_result edge).
   *  Any socket now listening that was neither in the baseline nor in any
   *  scan that predates the window is claimed for the session: it bound
   *  while the model's command ran, so it is the model's service — dead
   *  intermediate shells and detached lineages notwithstanding. */
  async noteBashToolEnd(sessionId: string): Promise<void> {
    if (this.disposed) return;
    const win = this.bashWindows.get(sessionId);
    if (!win) return;
    win.depth -= 1;
    if (win.depth > 0) return;
    this.bashWindows.delete(sessionId);
    let listening: ListeningSocket[];
    try {
      listening = await listListening();
    } catch {
      return;
    }
    const preExisting = (key: string): boolean =>
      (win.baseline?.has(key) ?? false) ||
      this.scanHistory.some((s) => s.at <= win.startedAt && s.keys.has(key));
    for (const l of listening) {
      const key = socketKey(l.pid, l.port);
      if (this.claimed.has(key) || this.tracked.has(key)) continue;
      if (preExisting(key)) continue;
      this.claimed.set(key, { sessionId, claimedAt: Date.now() });
      log.info(`service scanner: claimed ${key} for session ${sessionId} (bash-window diff)`);
    }
  }
}

export const serviceScanner = new ServiceScanner();

/** App-start hook (index.ts, next to initAutoArchiver). */
export function initServiceScanner(): void {
  serviceScanner.start();
}

/** App-quit hook (before-quit cleanup chain). */
export function disposeServiceScanner(): void {
  serviceScanner.dispose();
}

/** Adapter hooks — the Bash tool_use / tool_result edges, reported so the
 *  claim path can window each command. Fire-and-forget from the caller: a
 *  failed listener snapshot must never touch the event stream. */
export function noteBashToolStart(sessionId: string): Promise<void> {
  return serviceScanner.noteBashToolStart(sessionId);
}

export function noteBashToolEnd(sessionId: string): Promise<void> {
  return serviceScanner.noteBashToolEnd(sessionId);
}
