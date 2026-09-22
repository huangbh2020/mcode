/**
 * Headless smoke for the agent-service scanner (main/lib/serviceScanner.ts):
 *
 *  1. Pure parsers — Windows netstat / lsof -F / ss -tlnp LISTENING rows,
 *     ps and CIM-JSON process rows, the CLI cmdline signature and the
 *     `--resume=` session stamp.
 *  2. Live end-to-end (real platform snapshots, no stubs for the scanner
 *     itself): spawn a fake "claude CLI" process (its argv carries the SDK
 *     transport signature + --resume=<sid>), have IT spawn an HTTP listener
 *     as its child, bind the fake cliSid via the RuntimeManager stub, run
 *     one scan pass and assert the listener is discovered with the right
 *     port/pid and attributed to the stubbed session; then stopService must
 *     kill the process tree and the next pass must emit the empty roster.
 *
 * Electron-adjacent modules (window / mobile bus / logger / RuntimeManager)
 * are esbuild-aliased to local stubs — see run.sh.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServicesEvent, ServiceSnapshot } from "@contracts/runtime";
import {
  isClaudeCliCmdline,
  listListening,
  noteBashToolEnd,
  noteBashToolStart,
  parseLsofListening,
  parseNetstatListening,
  parsePsLines,
  parseResumeSessionId,
  parseSsListening,
  parseWinProcJson,
  serviceScanner,
} from "@main/lib/serviceScanner.js";
import { sent } from "./stub-window.js";
import { events as mobileEvents } from "./stub-mobile-bus.js";
import { stubState } from "./stub-runtime-manager.js";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean): void {
  if (cond) passed += 1;
  else {
    failed += 1;
    console.error(`FAIL: ${name}`);
  }
}

/* ── 1. parsers ─────────────────────────────────────────────────────── */

{
  const netstatSample = [
    "Active Connections",
    "",
    "  Proto  Local Address          Foreign Address        State           PID",
    "  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       4321",
    "  TCP    0.0.0.0:8080           0.0.0.0:0              LISTENING       8765",
    "  TCP    [::]:8080              [::]:0                 LISTENING       8765",
    "  TCP    127.0.0.1:9999         127.0.0.1:9998         ESTABLISHED     4321",
    "  TCP    127.0.0.1:7000         0.0.0.0:0              LISTENING       garbage",
  ].join("\r\n");
  const socks = parseNetstatListening(netstatSample);
  check("netstat: finds LISTENING rows with pid", socks.some((s) => s.pid === 4321 && s.port === 5173));
  check("netstat: ipv6 local address parses", socks.some((s) => s.pid === 8765 && s.port === 8080));
  check(
    "netstat: ipv4+ipv6 dual-bind kept as two rows (dedupe is by pid:port later)",
    socks.filter((s) => s.pid === 8765 && s.port === 8080).length === 2,
  );
  check("netstat: non-LISTENING rows skipped", !socks.some((s) => s.port === 9999));
  check("netstat: malformed pid skipped", !socks.some((s) => s.port === 7000));
}

{
  const lsofSample = ["p1234", "n*:5173", "nlocalhost:3000", "p5678", "n[::1]:3001", "f12"].join("\n");
  const socks = parseLsofListening(lsofSample);
  check("lsof: first process block sockets", socks.some((s) => s.pid === 1234 && s.port === 5173));
  check("lsof: second address for same pid", socks.some((s) => s.pid === 1234 && s.port === 3000));
  check("lsof: ipv6 bracket name parses", socks.some((s) => s.pid === 5678 && s.port === 3001));
}

{
  const ssSample = [
    "State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process",
    "LISTEN 0      128    0.0.0.0:5173        0.0.0.0:*          users:((\"node\",pid=4321,fd=20))",
    "LISTEN 0      128    [::]:5173           [::]:*             users:((\"node\",pid=4321,fd=21))",
    "LISTEN 0      5      0.0.0.0:9000        0.0.0.0:*", // no process column (permissions)
    "ESTAB  0      0      127.0.0.1:80        127.0.0.1:443",
  ].join("\n");
  const socks = parseSsListening(ssSample);
  check("ss: LISTEN row with pid parses", socks.some((s) => s.pid === 4321 && s.port === 5173));
  check("ss: row without pid skipped", !socks.some((s) => s.port === 9000));
  check("ss: non-LISTEN skipped", socks.every((s) => s.port !== 80));
}

{
  const ps = parsePsLines(
    ["  100  1  node /path/cli.js --output-format stream-json", "  101 100  python -m http.server 8000", "bad line"].join("\n"),
  );
  check("ps: two rows parsed", ps.length === 2);
  check("ps: name is argv0 basename", ps[0]?.name === "node" && ps[1]?.name === "python");
  check("ps: ppid chain preserved", ps[1]?.ppid === 100);
}

{
  const one = parseWinProcJson(
    JSON.stringify([{ ProcessId: 10, ParentProcessId: 1, Name: "node.exe", CommandLine: "node x.js" }]),
  );
  check("cim: array row parses", one.length === 1 && one[0]?.pid === 10 && one[0]?.name === "node.exe");
  const single = parseWinProcJson(
    JSON.stringify({ ProcessId: 11, ParentProcessId: 1, Name: "python.exe", CommandLine: null }),
  );
  check("cim: single object normalized to array", single.length === 1);
  check("cim: null CommandLine tolerated", single[0]?.commandLine === "");
  check("cim: empty input", parseWinProcJson("").length === 0);
  check("cim: bad json tolerated", parseWinProcJson("not json").length === 0);
}

{
  const cli = "node C:\\x\\cli.js --output-format stream-json --verbose --input-format stream-json --resume=abc-123";
  const notCli = "node C:\\x\\server.js --port 3000";
  check("cli signature: matched", isClaudeCliCmdline(cli));
  check("cli signature: plain server rejected", !isClaudeCliCmdline(notCli));
  check("resume: --resume=x parses", parseResumeSessionId(cli) === "abc-123");
  check("resume: space-separated form parses", parseResumeSessionId("node cli.js --resume def-456 --verbose") === "def-456");
  check("resume: absent → null", parseResumeSessionId(notCli) === null);
}

/* ── 2. live discovery + stop ───────────────────────────────────────── */

const FAKE_CLI_SID = "smoke-cli-sid-000";
const SESSION_ID = "sess-smoke";

/** The listener child: binds an ephemeral port, prints it, keeps serving. */
const LISTENER_SCRIPT = `
const http = require("http");
const srv = http.createServer((q, s) => { s.end("smoke"); });
srv.listen(0, "127.0.0.1", () => {
  process.stdout.write(String(srv.address().port));
});
`;/** The fake CLI: carries the SDK transport signature + --resume stamp, and
 *  spawns the listener as its child (so the listener is its descendant —
 *  exactly the shape a Bash-tool service has under the real CLI). */
const FAKE_CLI_SCRIPT = `
const { spawn } = require("child_process");
spawn(process.execPath, ["-e", ${JSON.stringify(LISTENER_SCRIPT)}], { stdio: ["ignore", "inherit", "inherit"] });
setTimeout(() => {}, 120000); // stay alive like a real CLI
`;

async function spawnFakeCli(): Promise<{ pid: number; listenerPid: number; port: number; cleanup: () => void }> {
  // Spawn exactly like the SDK does: `node <script-file> --output-format …` —
  // with `-e`, node would eat the leading-dash args as its own options.
  const dir = mkdtempSync(join(tmpdir(), "mcode-svc-smoke."));
  const cliFile = join(dir, "fake-cli.cjs");
  writeFileSync(cliFile, FAKE_CLI_SCRIPT);
  const child = spawn(
    process.execPath,
    [cliFile, "--output-format", "stream-json", "--input-format", "stream-json", `--resume=${FAKE_CLI_SID}`],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const cleanup = (): void => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  };
  // The fake CLI inherits the listener's stdout, so the FIRST line the pipe
  // delivers is the chosen port.
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("listener never reported its port")), 15_000);
    let buf = "";
    child.stdout!.on("data", (d: Buffer) => {
      buf += d.toString();
      const m = buf.match(/\d+/);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[0]));
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`fake CLI exited early (code ${code}))`));
    });
  });

  // Resolve the listener's pid: the only process LISTENING on that port.
  const socks = await listListening();
  const hit = socks.find((s) => s.port === port);
  if (!hit) throw new Error(`no listener found on port ${port}`);
  return { pid: child.pid!, listenerPid: hit.pid, port, cleanup };
}

/** Spawn a STANDALONE listener — a direct child of this smoke process, with
 *  NO fake CLI anywhere in its ancestry. This is the detached-service shape
 *  the claim path exists for (Windows `Start-Process` / POSIX nohup leave
 *  the real listener with a dead or reparented ppid, so ancestry can never
 *  attribute it). Returns its pid + port once the socket listens. */
async function spawnStandaloneListener(): Promise<{ pid: number; port: number }> {
  const child = spawn(process.execPath, ["-e", LISTENER_SCRIPT], { stdio: ["ignore", "pipe", "ignore"] });
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("standalone listener never reported its port")), 15_000);
    child.stdout!.on("data", (d: Buffer) => {
      const m = d.toString().match(/\d+/);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[0]));
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`standalone listener exited early (code ${code})`));
    });
  });
  const socks = await listListening();
  const hit = socks.find((s) => s.port === port);
  if (!hit) throw new Error(`standalone listener not found on port ${port}`);
  return { pid: child.pid!, port };
}

async function alive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function lastServiceEvent(sessionId: string): ServicesEvent | undefined {
  for (let i = sent.length - 1; i >= 0; i -= 1) {
    const args = sent[i]?.args as { sessionId: string; event: { type: string } }[] | undefined;
    const msg = args?.[0];
    if (msg?.sessionId === sessionId && msg.event?.type === "services.update") {
      return msg.event as unknown as ServicesEvent;
    }
  }
  return undefined;
}

{
  // Seed the fake binding BEFORE the scan so the --resume path resolves.
  stubState.byProvider.set(FAKE_CLI_SID, SESSION_ID);

  const fake = await spawnFakeCli();
  try {
    await serviceScanner.scanOnce();
    const evt = lastServiceEvent(SESSION_ID);
    const found: ServiceSnapshot | undefined = evt?.services.find((s) => s.port === fake.port && s.pid === fake.listenerPid);
    check("live: listener discovered under the bound CLI", !!found);
    check("live: snapshot carries key/name/startedAt", !!found && /^\d+:\d+$/.test(found.key) && !!found.name && found.startedAt > 0);
    check("live: mobile bus mirrors the roster", mobileEvents.some((e) => (e as ServicesEvent).type === "services.update" && (e as ServicesEvent).sessionId === SESSION_ID));

    // Sticky across a pass where the CLI is still alive but binding intact.
    await serviceScanner.scanOnce();
    check("live: sticky tracking keeps the entry", lastServiceEvent(SESSION_ID)?.services.some((s) => s.key === found?.key) === true);

    // Guard: a kill aimed at an untracked pid must be refused.
    let guardRejected = false;
    try {
      await serviceScanner.stopService(SESSION_ID, 999999, 1);
    } catch {
      guardRejected = true;
    }
    check("live: stopService refuses untracked pid", guardRejected);

    // Stop through the real path (killProcessTree) and verify ground truth.
    await serviceScanner.stopService(SESSION_ID, fake.listenerPid, fake.port);
    await new Promise((r) => setTimeout(r, 500));
    check("live: listener process killed", !(await alive(fake.listenerPid)));
    const after = lastServiceEvent(SESSION_ID);
    check("live: roster emitted empty after stop", after !== undefined && after.services.length === 0);
  } finally {
    // Belt-and-braces: never leave the fake processes behind on a failed assert.
    for (const pid of [fake.pid, fake.listenerPid]) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    fake.cleanup();
  }
}

/* ── 3. bash-window claim path (detached services, no CLI ancestry) ─── */

{
  // The detached-service reproduction: a listener that is NOT under any
  // bound CLI. The scanner's ancestry path can never attribute it (this
  // smoke's RuntimeManager stub has no binding for any real ancestor), so
  // only the Bash-window diff can claim it — exactly the production shape
  // of `powershell Start-Process python -m http.server` whose powershell
  // exits before any scan observes the chain.
  const sessionId2 = "sess-smoke-claim";

  // (a) Pre-existing listener inside a bash window must NOT be claimed:
  // open the window first, THEN start the listener — no wait, the honest
  // pre-existing case is the reverse: listener already listening when the
  // window opens. Start it, let the baseline capture it, expect no claim.
  const pre = await spawnStandaloneListener();
  await noteBashToolStart(sessionId2);
  await noteBashToolEnd(sessionId2);
  await serviceScanner.scanOnce();
  check(
    "claim: pre-existing listener not attributed",
    !lastServiceEvent(sessionId2)?.services.some((s) => s.port === pre.port),
  );

  // (b) A listener that binds INSIDE the window is claimed despite having
  // no CLI ancestry (the Start-Process/nohup case).
  await noteBashToolStart(sessionId2);
  const claimed = await spawnStandaloneListener();
  await noteBashToolEnd(sessionId2);
  await serviceScanner.scanOnce();
  const evt2 = lastServiceEvent(sessionId2);
  const claimedSnap = evt2?.services.find((s) => s.port === claimed.port && s.pid === claimed.pid);
  check("claim: detached listener adopted via bash-window diff", !!claimedSnap);
  check("claim: adopted under the window's session", !!claimedSnap && evt2?.sessionId === sessionId2);

  // The claimed service is stoppable through the guarded path.
  await serviceScanner.stopService(sessionId2, claimed.pid, claimed.port);
  await new Promise((r) => setTimeout(r, 500));
  check("claim: claimed service killable via stopService", !(await alive(claimed.pid)));

  // (c) Depth semantics: two overlapping Bash windows — no diff at the
  // first close; the diff at the LAST close claims the mid-window listener
  // but still spares the pre-window one.
  const pre2 = await spawnStandaloneListener();
  await noteBashToolStart(sessionId2);
  await noteBashToolStart(sessionId2);
  const mid = await spawnStandaloneListener();
  await noteBashToolEnd(sessionId2); // first close — window still open (depth 1)
  await serviceScanner.scanOnce();
  check(
    "claim: first close runs no diff (mid-window listener not yet adopted)",
    !lastServiceEvent(sessionId2)?.services.some((s) => s.port === mid.port),
  );
  await noteBashToolEnd(sessionId2); // final close — diff runs
  await serviceScanner.scanOnce();
  const evt3 = lastServiceEvent(sessionId2);
  check("claim: mid-window listener claimed at last close", !!evt3?.services.some((s) => s.port === mid.port));
  check("claim: pre-window listener still not claimed", !evt3?.services.some((s) => s.port === pre2.port));

  // Cleanup — never leave listeners behind.
  await serviceScanner.stopService(sessionId2, mid.pid, mid.port).catch(() => {});
  for (const pid of [pre.pid, pre2.pid]) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

console.log(`service-scanner smoke: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);