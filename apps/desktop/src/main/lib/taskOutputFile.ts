/**
 * Read the accumulated output the CLI spools for a settled bash task
 * (`task_notification.output_file`).
 *
 * The CLI writes the combined stdout+stderr of a tracked command to this file
 * and reveals the path only in the terminal bookend notification — the host
 * never sees the stream live (stream-json has no per-bash output events). This
 * reader turns that path into displayable text: tail-capped (dev servers can
 * log for hours), line-boundary aligned, ANSI-stripped (color escapes would
 * render as garbage in the activity console), CRLF-normalized.
 */
import { open } from "node:fs/promises";

/** Cap on what we read + ship over IPC per task. The tail is what the user
 *  needs after a stop/failure; the head of a long log adds nothing. */
export const TASK_OUTPUT_CAP_BYTES = 64 * 1024;

/** ANSI escape sequences: CSI (colors, cursor moves), OSC (window title),
 *  and the short two-char forms. Dev-server output is often full of them. */
const ANSI_ESCAPE_RE =
  /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/** Strip ANSI escapes from terminal output (shared by the CLI spool reader
 *  and the Pi live bash tracker). */
export function stripAnsiEscapes(s: string): string {
  return s.replace(ANSI_ESCAPE_RE, "");
}

/**
 * Read the tail of a CLI task output file. Never throws for missing/unreadable
 * files — callers treat a miss as "no output to show" (the file may be gone by
 * the time we read it, e.g. after a CLI restart cleaned its temp dir).
 * Returns an empty string when the file is empty or unreadable.
 */
export async function readTaskOutputTail(path: string): Promise<{
  output: string;
  truncated: boolean;
}> {
  let fh: Awaited<ReturnType<typeof open>>;
  try {
    fh = await open(path, "r");
  } catch {
    return { output: "", truncated: false };
  }
  try {
    const size = (await fh.stat()).size;
    if (size === 0) return { output: "", truncated: false };
    const start = Math.max(0, size - TASK_OUTPUT_CAP_BYTES);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    let text = buf.toString("utf8");
    if (start > 0) {
      // A mid-file slice can begin inside a UTF-8 codepoint or an escape
      // sequence; resuming at the first newline discards at most one
      // fragmentary line and keeps the rest intact.
      const nl = text.indexOf("\n");
      text = nl >= 0 ? text.slice(nl + 1) : "";
    }
    return {
      output: text.replace(ANSI_ESCAPE_RE, "").replace(/\r\n/g, "\n").trimEnd(),
      truncated: start > 0,
    };
  } catch {
    return { output: "", truncated: false };
  } finally {
    await fh.close().catch(() => {});
  }
}
