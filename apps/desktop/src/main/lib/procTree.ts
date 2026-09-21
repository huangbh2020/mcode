/**
 * Process-tree reaping — kill every descendant of a root pid.
 *
 * Why this exists (2026-09-21): the claude CLI the SDK spawns is a child of
 * the Electron main process, and every command the model runs through the
 * Bash tool is a grandchild (bash → python / npm / vite …). When the app
 * quits, the SDK tears down the CLI itself, but nothing reliably kills the
 * GRANDCHILDREN — on macOS they reparent to launchd, on Windows there is no
 * job object, so a long-running script the model started survives the app
 * and the user has to hunt it down in the task manager. Reaping the whole
 * descendant tree at quit closes that gap.
 *
 * Deliberately scoped to APP QUIT only: killing "all descendants of main"
 * is the right move there (PTYs / LSP servers / browser views are Electron's
 * own quit path anyway), but far too blunt for per-session teardown.
 */
import { execFile } from "node:child_process";
import { log } from "./logger.js";

function execFileText(file: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout ?? ""));
    });
  });
}

/** POSIX: collect every descendant pid (transitive closure, root excluded)
 *  from one `ps` snapshot. Returns [] when nothing matched. */
async function descendantsPosix(rootPid: number): Promise<number[]> {
  const out = await execFileText("ps", ["-eo", "pid=,ppid="], 5_000);
  const childrenOf = new Map<number, number[]>();
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    if (pid === ppid) continue; // kernel idle process quirk
    const list = childrenOf.get(ppid);
    if (list) list.push(pid);
    else childrenOf.set(ppid, [pid]);
  }
  const out2: number[] = [];
  const queue = [rootPid];
  const seen = new Set<number>([rootPid]);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const child of childrenOf.get(cur) ?? []) {
      if (seen.has(child)) continue; // cycle guard (shouldn't happen, cheap)
      seen.add(child);
      out2.push(child);
      queue.push(child);
    }
  }
  return out2;
}

/** Windows: list DIRECT children of a pid via PowerShell CIM. `taskkill /T`
 *  walks the rest of each subtree itself. */
async function directChildrenWindows(rootPid: number): Promise<number[]> {
  const out = await execFileText(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Get-CimInstance Win32_Process -Filter "ParentProcessId=${rootPid}" -Property ProcessId | ForEach-Object { $_.ProcessId }`,
    ],
    8_000,
  );
  return out
    .split(/\r?\n/)
    .map((l) => Number(l.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

function signal(pid: number, sig: NodeJS.Signals): boolean {
  try {
    process.kill(pid, sig);
    return true;
  } catch {
    return false; // ESRCH (already gone) or EPERM — nothing more to do
  }
}

export interface KillTreeResult {
  /** Pids we signalled (best-effort list; some may have exited first). */
  terminated: number[];
}

/**
 * Terminate every descendant of `rootPid` (the root itself is spared).
 * POSIX: SIGTERM the whole set, wait `graceMs`, SIGKILL the survivors.
 * Windows: `taskkill /T /F` per direct child (forceful — Windows offers no
 * graceful two-phase equivalent worth the quit-time cost).
 * Never rejects: every failure is logged and best-effort, because this runs
 * on the quit path where a rejection would only delay shutdown.
 */
export async function killDescendants(rootPid: number, graceMs = 400): Promise<KillTreeResult> {
  const terminated: number[] = [];
  try {
    if (process.platform === "win32") {
      const children = await directChildrenWindows(rootPid);
      if (children.length === 0) return { terminated };
      log.info(`procTree: killing ${children.length} child tree(s) under pid ${rootPid}`);
      await Promise.all(
        children.map(async (pid) => {
          try {
            await execFileText("taskkill", ["/PID", String(pid), "/T", "/F"], 10_000);
            terminated.push(pid);
          } catch (err) {
            // 128 = process not found (already gone); anything else is logged.
            const msg = err instanceof Error ? err.message : String(err);
            if (!/exit code 128|not found|找不到/i.test(msg)) {
              log.warn(`procTree: taskkill ${pid} failed: ${msg}`);
            }
          }
        }),
      );
      return { terminated };
    }

    const pids = await descendantsPosix(rootPid);
    if (pids.length === 0) return { terminated };
    log.info(`procTree: SIGTERM ${pids.length} descendant(s) of pid ${rootPid}`);
    for (const pid of pids) {
      if (signal(pid, "SIGTERM")) terminated.push(pid);
    }
    // Give the tree a moment to exit on the TERM, then hard-kill whoever is
    // still alive (a stuck `npm run dev` ignores TERM; SIGKILL won't).
    if (graceMs > 0) {
      await new Promise((r) => setTimeout(r, graceMs));
      let killed = 0;
      for (const pid of terminated) {
        try {
          process.kill(pid, 0); // liveness probe — throws ESRCH when gone
          process.kill(pid, "SIGKILL");
          killed += 1;
        } catch {
          /* already exited — the common, happy path */
        }
      }
      if (killed > 0) log.info(`procTree: SIGKILLed ${killed} lingering descendant(s)`);
    }
    return { terminated };
  } catch (err) {
    log.warn(`procTree: descendant reap failed: ${err instanceof Error ? err.message : String(err)}`);
    return { terminated };
  }
}
