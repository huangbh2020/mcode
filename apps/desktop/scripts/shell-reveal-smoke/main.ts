/**
 * Headless smoke for the shell surfaces ("reveal in file manager" et al.) —
 * the boundary the RIGHT-CLICK menu of the IDE file tree is addressed through.
 *
 * Regression anchor (2026-09-14): `ipc/shell.ts` predates the worktree tier —
 * its guards only accepted paths under PROJECT roots, while a worktree
 * checkout lives OUTSIDE every project root by design. In a worktree session
 * the file tree's "在资源管理器中显示" was therefore refused silently. The fix
 * routes all three channels through the workspace-aware helpers
 * (`isKnownWorkspaceRoot` / `findContainingWorkspaceRoot`), aligning with what
 * `ipc/files.ts` already does. This smoke pins, against the REAL
 * `registerShellHandlers`:
 *
 *   - reveal/open/openFile work for paths inside a worktree root (the
 *     regression), the worktree root itself, and project paths,
 *   - case-mismatched paths still match on case-insensitive filesystems,
 *   - the boundary still refuses paths outside every legal root, including
 *     prefix-twins of a root (`/proj-twin` vs `/proj`), and
 *   - `showImageInFolder` still passes BYTES through to the artifact reveal
 *     (no path involved).
 *
 * Run: scripts/shell-reveal-smoke/run.sh
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platform } from "node:os";
import { registerShellHandlers } from "@main/ipc/shell.js";
import { IPC } from "@contracts/ipc";
import { seedWorkspaceRoots } from "./stub-repositories.js";
import { resetShellCalls, getShellCalls } from "./stub-electron.js";
import { getRevealedDataUrls } from "./stub-imageArtifacts.js";

let checks = 0;
let failures = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  checks++;
  if (cond) {
    process.stdout.write(`  ✓ ${name}\n`);
  } else {
    failures++;
    process.stdout.write(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}\n`);
  }
}

// ── Harness: capture the handlers registerShellHandlers installs ──
const handlers = new Map<string, (evt: unknown, raw: unknown) => Promise<unknown>>();
registerShellHandlers({
  handle: (channel: string, fn: (evt: unknown, raw: unknown) => Promise<unknown>) => {
    handlers.set(channel, fn);
  },
} as Parameters<typeof registerShellHandlers>[0]);

async function call(channel: string, input: unknown): Promise<void> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`handler not registered: ${channel}`);
  await fn(null, input);
}

/** The LAST recorded shell call, or null when none was made. */
function lastCall(): { op: string; path: string } | null {
  const all = getShellCalls();
  return all.length > 0 ? all[all.length - 1] : null;
}

// ── Fixtures: a project checkout + a worktree outside it + an unrelated dir ──
const base = mkdtempSync(join(tmpdir(), "mcode-shell-reveal-smoke-"));
const proj = join(base, "proj");
const wt = join(base, "worktrees", "repo", "feature-n");
const unrelated = join(base, "unrelated");
mkdirSync(proj, { recursive: true });
mkdirSync(wt, { recursive: true });
mkdirSync(unrelated, { recursive: true });
seedWorkspaceRoots([proj], [wt]);

process.stdout.write("shell:showItemInFolder\n");
await call(IPC.SHELL_SHOW_ITEM_IN_FOLDER, { path: join(wt, "src", "a.ts") });
check("worktree file is revealed (the regression)", lastCall()?.op === "showItemInFolder" && lastCall()?.path === join(wt, "src", "a.ts"), lastCall());

await call(IPC.SHELL_SHOW_ITEM_IN_FOLDER, { path: wt });
check("worktree root itself is revealed", lastCall()?.path === wt, lastCall());

await call(IPC.SHELL_SHOW_ITEM_IN_FOLDER, { path: join(proj, "docs", "readme.md") });
check("project file is still revealed", lastCall()?.path === join(proj, "docs", "readme.md"), lastCall());

resetShellCalls();
await call(IPC.SHELL_SHOW_ITEM_IN_FOLDER, { path: join(unrelated, "f.txt") });
check("path outside every workspace root is refused", getShellCalls().length === 0, getShellCalls());

await call(IPC.SHELL_SHOW_ITEM_IN_FOLDER, { path: join(base, "proj-twin", "f.txt") });
check("prefix-twin of a root is refused (separator-aware)", getShellCalls().length === 0, getShellCalls());

if (platform() === "win32" || platform() === "darwin") {
  await call(IPC.SHELL_SHOW_ITEM_IN_FOLDER, { path: wt.toUpperCase() });
  check("case-mismatched worktree path still matches (case-insensitive fs)", lastCall()?.path === wt.toUpperCase(), lastCall());
}

process.stdout.write("shell:openPath\n");
await call(IPC.SHELL_OPEN_PATH, { path: wt });
check("worktree root opens (exact match)", lastCall()?.op === "openPath" && lastCall()?.path === wt, lastCall());

resetShellCalls();
await call(IPC.SHELL_OPEN_PATH, { path: join(unrelated) });
check("unknown directory is refused", getShellCalls().length === 0, getShellCalls());

process.stdout.write("shell:openFile\n");
await call(IPC.SHELL_OPEN_FILE, { path: join(wt, "report.docx") });
check("worktree file opens with the default app", lastCall()?.op === "openPath" && lastCall()?.path === join(wt, "report.docx"), lastCall());

resetShellCalls();
await call(IPC.SHELL_OPEN_FILE, { path: join(unrelated, "evil.exe") });
check("openFile outside every workspace root is refused", getShellCalls().length === 0, getShellCalls());

process.stdout.write("shell:showImageInFolder\n");
const DATA_URL = "data:image/png;base64,AAAA";
await call(IPC.SHELL_SHOW_IMAGE_IN_FOLDER, { dataUrl: DATA_URL });
check("image bytes pass through to the artifact reveal", getRevealedDataUrls().length === 1 && getRevealedDataUrls()[0] === DATA_URL);

process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`);
if (failures > 0) process.exit(1);
