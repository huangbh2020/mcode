/**
 * Project-isolation read-path guard, shared by the Claude provider's
 * canUseTool and the Pi extension's tool_call handler.
 *
 * "isolated" is a UI-only permission mode (the CLI/SDK levels know nothing
 * about it): file edits auto-approve INSIDE the project (acceptEdits-like),
 * while reads — unlike every other mode — are ALSO confined to the project
 * working directory. This module is the single decision + denial message for
 * that read boundary, mirroring how `guardToolPath` (writes) and
 * `guardBashCommand` (bash write-targets) share one message each.
 *
 * Only called in isolated mode; every other mode keeps reads free (reading
 * docs/config outside the project is often legitimate — that's why the
 * boundary is opt-in rather than always-on like the write guard).
 */
import { normalizeToolFilePath } from "@main/lib/fileSnapshot.js";
import { expandTilde } from "@main/lib/bashWriteGuard.js";

/**
 * Judge a read tool's target path against the project boundary.
 *
 * @returns the denial message when the path resolves outside `cwd`, or null
 *  when the read is allowed (inside the project, or unresolvable — matching
 *  the write guard's silent-skip behavior for malformed input).
 */
export function guardReadPath(cwd: string, rawPath: string): string | null {
  // `~` must be expanded before resolve — see expandTilde; without it
  // `~/secrets` would resolve to a literal `<cwd>/~/secrets` folder and be
  // wrongly admitted as "inside the project".
  const norm = normalizeToolFilePath(cwd, expandTilde(rawPath));
  if (!norm || norm.insideProject) return null;
  return `拒绝:项目隔离模式下,读取范围仅限当前项目目录(${norm.absPath} 在其之外)。请使用项目内相对路径。`;
}
