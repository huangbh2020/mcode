/**
 * Terminal-session scrollback persistence — one serialized xterm snapshot
 * per GUI session id, stored under <userData>/term-history/<sessionId>.ser.
 *
 * File format: a JSON envelope `{"v":1,"cols":N,"rows":M,"content":"…"}`
 * carrying the CAPTURE GEOMETRY alongside the buffer. The serialize
 * addon's output contains wrap points and absolute cursor rows, so a
 * correct replay requires a terminal of the same size — the geometry MUST
 * ride with the content (addon contract). Files written before the
 * envelope existed are raw strings; loading one yields the content with no
 * geometry (the caller falls back to the terminal's default size).
 *
 * Pure fs module (base dir injected) so the smoke script can exercise the
 * path-safety, envelope and legacy-decode logic without Electron. The IPC
 * layer in ipc/terminal.ts owns the userData base dir and the settings
 * gate (`terminal.persistHistory`).
 */
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/** Session ids this module will persist for (sess_* / piimp-* style: short
 *  alphanumeric + a few separators). Anything else — dots, slashes, drive
 *  letters — is rejected so a crafted id can never traverse out of the
 *  history dir. Mirrors the defensive posture of other fs-facing IPC. */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** What loadTerminalHistory returns: content always, geometry when the
 *  envelope carried it (legacy files → undefined dims). */
export interface TerminalHistoryData {
  content: string;
  cols?: number;
  rows?: number;
}

/** Returns the safe absolute file path for a session's snapshot, or null
 *  when the id could escape the directory (regex refusal). */
export function terminalHistoryPath(baseDir: string, sessionId: string): string | null {
  if (!SESSION_ID_RE.test(sessionId)) return null;
  return join(baseDir, `${sessionId}.ser`);
}

/** Persist a snapshot. `dims` records the capture geometry (see the header
 *  — required for size-faithful replay). Returns {ok:false, error} on a
 *  refused id or fs failure; never throws. */
export function saveTerminalHistory(
  baseDir: string,
  sessionId: string,
  content: string,
  dims?: { cols: number; rows: number },
): { ok: boolean; error?: string } {
  const file = terminalHistoryPath(baseDir, sessionId);
  if (!file) return { ok: false, error: "invalid session id" };
  try {
    mkdirSync(baseDir, { recursive: true });
    const envelope = JSON.stringify({
      v: 1,
      cols: dims?.cols ?? 0,
      rows: dims?.rows ?? 0,
      content,
    });
    writeFileSync(file, envelope, "utf8");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Read the last snapshot. Null when never saved (or unreadable — a torn
 *  file restores nothing rather than corrupting the new terminal). */
export function loadTerminalHistory(baseDir: string, sessionId: string): TerminalHistoryData | null {
  const file = terminalHistoryPath(baseDir, sessionId);
  if (!file) return null;
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  // Envelope form. Shape-validated: anything that isn't a v1 object with a
  // string content degrades to the legacy interpretation below.
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as { v?: unknown; cols?: unknown; rows?: unknown; content?: unknown };
      if (parsed && typeof parsed.content === "string") {
        return {
          content: parsed.content,
          ...(typeof parsed.cols === "number" && parsed.cols >= 2 && parsed.cols <= 1000
            ? { cols: Math.floor(parsed.cols) }
            : {}),
          ...(typeof parsed.rows === "number" && parsed.rows >= 2 && parsed.rows <= 1000
            ? { rows: Math.floor(parsed.rows) }
            : {}),
        };
      }
    } catch {
      /* fall through to legacy */
    }
  }
  // Legacy raw-string snapshot (pre-envelope format).
  return { content: raw };
}

/** Delete a session's snapshot (best-effort cleanup). */
export function deleteTerminalHistory(baseDir: string, sessionId: string): void {
  const file = terminalHistoryPath(baseDir, sessionId);
  if (!file) return;
  try {
    unlinkSync(file);
  } catch {
    /* absent is the goal */
  }
}
