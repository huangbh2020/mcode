/**
 * Locate and version-probe the USER'S OWN Claude CLI for terminal sessions.
 *
 * This is deliberately separate from the SDK provider path
 * (`resolveSdkBinaryPath` → managed runtime / bundled binary): terminal
 * sessions exist precisely to run whatever the user installed and keeps
 * updated (`claude` on PATH, or the native installer's ~/.local/bin drop),
 * version-fresh and outside Mcode's ~/.mcode config redirection. The old
 * ClaudePathResolver was deleted when the SDK started bundling its own
 * binary; this is its small successor, consumed only by the terminal-session
 * UI (version badge + not-installed empty state) and its smoke script.
 */
import { exec } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Session } from "@contracts/session";
import type { TerminalCliProbeResult } from "@contracts/ipc";
import { which } from "@main/lib/binaryResolve.js";
import { SessionRepo } from "@main/store/repositories.js";
import { broadcastSessionChanged } from "@main/lib/sessionSync.js";
import { log } from "@main/lib/logger.js";

/** Resolve the user's `claude` executable, or null when not installed.
 *  Order: PATH lookup (covers npm global shims on Windows — `where.exe`
 *  finds claude.cmd/claude.ps1, which is exactly how the user's shell would
 *  resolve it) → the native installer's default drop location. */
export function resolveClaudeCliPath(): string | null {
  const onPath = which("claude");
  if (onPath) return onPath;
  if (process.platform === "win32") {
    const native = join(homedir(), ".local", "bin", "claude.exe");
    if (existsSync(native)) return native;
  } else {
    const native = join(homedir(), ".local", "bin", "claude");
    if (existsSync(native)) return native;
  }
  return null;
}

/** Cached probe result (path + version). Version bumps of the CLI are not
 *  time-critical to surface — a 10-minute cache keeps every terminal-session
 *  pane mount from paying a process spawn. */
let cached: { at: number; value: TerminalCliProbeResult } | null = null;
const PROBE_CACHE_MS = 10 * 60_000;

/** Probe the user's CLI: resolve the executable, then run `claude --version`
 *  (through a shell — npm-installed CLIs on Windows are .cmd shims that
 *  CreateProcess cannot launch directly). The command string is a fixed
 *  literal built from the RESOLVED path quoted with double quotes; paths
 *  containing quotes are rejected outright, so there is no injection
 *  surface from user-controlled input. */
export async function probeClaudeCli(force = false): Promise<TerminalCliProbeResult> {
  if (!force && cached && Date.now() - cached.at < PROBE_CACHE_MS) return cached.value;
  const path = resolveClaudeCliPath();
  if (!path) {
    const value: TerminalCliProbeResult = { found: false };
    cached = { at: Date.now(), value };
    return value;
  }
  if (path.includes('"')) {
    // Defensive: a PATH entry containing a quote cannot be safely embedded
    // in the shell command below — report found without a version.
    const value: TerminalCliProbeResult = { found: true, path, error: "unquotable path" };
    cached = { at: Date.now(), value };
    return value;
  }
  const value = await new Promise<TerminalCliProbeResult>((resolve) => {
    exec(`"${path}" --version`, { timeout: 5000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        log.warn(`claude cli probe failed: ${err.message}`);
        resolve({ found: true, path, error: stderr.trim().split("\n")[0] || err.message });
        return;
      }
      const version = stdout.trim().split("\n")[0] || undefined;
      resolve({ found: true, path, version });
    });
  });
  cached = { at: Date.now(), value };
  return value;
}

/* ── Terminal-session resume reconciliation (adopt the CLI's real id) ──
 *
 * Why this exists (2026-10-19, diagnosed from a live incident): we pin the
 * CLI session id at session creation (`claude --session-id <uuid>`) so
 * restarts can `--resume`. That pin is USUALLY honored — but not always:
 * when the CLI auto-updates itself mid-launch ("Updated to latest…"), the
 * relaunched process drops the pinned id and the conversation lands under a
 * RANDOM id (the user's very first terminal session hit exactly this). A
 * later `--resume <pinned-id>` then dies with "No conversation found".
 *
 * The reconciler (driven from the scrollback-save path, throttled) checks
 * whether `<pinned>.jsonl` materialized under ~/.claude/projects/<encoded
 * cwd>/; when it never does, it ADOPTS the newest jsonl in that directory
 * whose mtime postdates the session row's creation and that no other
 * terminal session already claims, and persists it as the row's
 * claudeSessionId — the NEXT reopen resumes correctly. */

/** Throttle: one reconciliation attempt per terminal session per interval —
 *  the check is a directory scan, and the save path ticks every 3s. */
const RECONCILE_THROTTLE_MS = 30_000;
const reconcileLastAttempt = new Map<string, number>();

/** mtime slack below the session row's created_at: the row is created
 *  seconds before claude boots, and filesystem timestamps have their own
 *  granularity — a candidate written a minute "before" the row can still
 *  be the conversation our injection started. */
const RECONCILE_CREATED_SLACK_MS = 60_000;

/** The CLI encodes the cwd into a directory name by stripping
 *  non-alphanumerics; the drive letter's CASE varies with how the CLI was
 *  invoked (`D--…` vs `d--…` observed), so match by normalizing both
 *  sides rather than re-deriving the encoder. */
export function findClaudeProjectDir(
  projectsRoot: string,
  cwd: string,
): string | null {
  const want = cwd.toLowerCase().replace(/[^a-z0-9]/g, "");
  let entries: string[];
  try {
    entries = readdirSync(projectsRoot);
  } catch {
    return null;
  }
  for (const name of entries) {
    if (name.toLowerCase().replace(/[^a-z0-9]/g, "") === want) {
      return join(projectsRoot, name);
    }
  }
  return null;
}

/** One reconciliation pass. Returns the ADOPTED session id, or null when
 *  the pin is honored / nothing adoptable / throttled. `projectsRoot`
 *  override exists for the smoke script (temp-dir fixture). Never throws.
 *
 * Candidate criterion is mtime-based (portable + testable). Known narrow
 * miss: a user manually resuming one of THEIR old sessions in this cwd
 * after our terminal session was created could get that file adopted —
 * rare, self-limiting (one wrong resume), accepted. */
export function reconcileTerminalClaudeSessionId(
  session: Session,
  projectPath: string,
  projectsRoot = join(homedir(), ".claude", "projects"),
): string | null {
  if (session.kind !== "terminal" || !session.claudeSessionId) return null;
  // Claude-only: pi/codex terminal sessions run their own CLIs — their ids
  // never live under ~/.claude (pi needs no reconcile; codex has its own in
  // codexSession.ts).
  if (session.providerId !== "claude-sdk") return null;
  const now = Date.now();
  const last = reconcileLastAttempt.get(session.id) ?? 0;
  if (now - last < RECONCILE_THROTTLE_MS) return null;
  reconcileLastAttempt.set(session.id, now);

  try {
    const dir = findClaudeProjectDir(projectsRoot, projectPath);
    if (!dir) return null;

    // Pin honored — the pinned file exists, nothing to do (the common path).
    if (existsSync(join(dir, `${session.claudeSessionId}.jsonl`))) return null;

    const claimed = new Set(SessionRepo.listTerminalClaudeSessionIds());
    let best: { id: string; mtime: number } | null = null;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const id = name.slice(0, -".jsonl".length);
      if (claimed.has(id)) continue;
      const file = join(dir, name);
      let mtime: number;
      try {
        mtime = statSync(file).mtimeMs;
      } catch {
        continue;
      }
      if (mtime < session.createdAt - RECONCILE_CREATED_SLACK_MS) continue;
      if (!best || mtime > best.mtime) best = { id, mtime };
    }
    if (!best) return null;

    SessionRepo.updateClaudeSessionId(session.id, best.id);
    const updated = SessionRepo.get(session.id);
    if (updated) broadcastSessionChanged(updated);
    log.info(
      `terminal session ${session.id}: adopted CLI session id ${best.id} (pinned ${session.claudeSessionId} never materialized — likely a CLI auto-update relaunch)`,
    );
    return best.id;
  } catch (err) {
    log.warn(
      `terminal session reconcile failed for ${session.id}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
