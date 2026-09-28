/**
 * Headless smoke for the "isolated" permission mode (project isolation):
 *
 *  - fileSnapshot: FILE_READING_TOOLS membership + getToolReadPath's
 *    per-tool path field (Read→file_path, Glob/Grep/LS→path, absent→"");
 *  - readGuard: guardReadPath's containment decisions (relative-inside ok,
 *    ../ escape / absolute / ~ / WSL-dialect escapes denied, in-project
 *    absolute ok);
 *  - bashWriteGuard (now shared by BOTH providers — Claude's canUseTool Bash
 *    branch was wired to it in the same change): strict-mode denial of
 *    out-of-project write targets, non-strict allowance, /dev/null and
 *    $VAR targets left alone, in-project relative targets ok.
 *
 * Pure functions — bundled with esbuild and run in Node, no stubs needed.
 */
import {
  FILE_READING_TOOLS,
  FILE_MUTATING_TOOLS,
  getToolReadPath,
} from "@main/lib/fileSnapshot.js";
import { guardReadPath } from "@main/lib/readGuard.js";
import { guardBashCommand } from "@main/lib/bashWriteGuard.js";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean): void {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`FAIL: ${name}`);
  }
}

/** Project cwd for the checks — Windows-style, matching the app's home
 *  platform. All guard logic is path-separator agnostic (node:path resolve). */
const CWD = "D:\\proj\\app";

/* ── FILE_READING_TOOLS / getToolReadPath ── */
check("read set: Read/Glob/Grep/LS", ["Read", "Glob", "Grep", "LS"].every((t) => FILE_READING_TOOLS.has(t)));
check("read set: write tools are NOT read tools", !FILE_READING_TOOLS.has("Write"));
check("read set: mutating set unchanged", ["Write", "Edit", "MultiEdit", "NotebookEdit"].every((t) => FILE_MUTATING_TOOLS.has(t)));
check("readPath: Read reads file_path", getToolReadPath("Read", { file_path: "src/a.ts" }) === "src/a.ts");
check("readPath: Glob reads path", getToolReadPath("Glob", { pattern: "**/*.ts", path: "src" }) === "src");
check("readPath: Grep reads path", getToolReadPath("Grep", { pattern: "x", path: "lib" }) === "lib");
check("readPath: absent path → empty (defaults to cwd, nothing to guard)", getToolReadPath("Glob", { pattern: "**" }) === "");
check("readPath: malformed input → empty", getToolReadPath("Read", null) === "");
check("readPath: non-string path → empty", getToolReadPath("LS", { path: 42 }) === "");

/* ── guardReadPath: containment decisions ── */
check("read guard: in-project relative → allowed", guardReadPath(CWD, "src/deep/a.ts") === null);
check("read guard: in-project absolute → allowed", guardReadPath(CWD, "D:\\proj\\app\\src\\a.ts") === null);
check("read guard: ./ prefixed → allowed", guardReadPath(CWD, "./README.md") === null);
check("read guard: ../ escape → denied", guardReadPath(CWD, "../outside.txt") !== null);
check("read guard: deep ../ escape → denied", guardReadPath(CWD, "src/../../evil.txt") !== null);
check("read guard: absolute outside → denied", guardReadPath(CWD, "D:\\other\\secrets.txt") !== null);
check("read guard: drive-root absolute → denied", guardReadPath(CWD, "D:\\root-level.txt") !== null);
check("read guard: sibling-prefix path is NOT inside", guardReadPath(CWD, "D:\\proj\\app-extra\\a.ts") !== null);
check("read guard: home tilde → denied", guardReadPath(CWD, "~/.ssh/config") !== null);
check("read guard: WSL /mnt escape → denied (and normalized, not literal ~/..)", guardReadPath(CWD, "/mnt/c/Windows/win.ini") !== null);
check("read guard: message steers to relative paths", (guardReadPath(CWD, "../out.txt") ?? "").includes("相对路径"));
check("read guard: message names the mode", (guardReadPath(CWD, "../out.txt") ?? "").includes("项目隔离"));

/* ── guardBashCommand: shared write-target guard (regression after the
      pi-sdk → lib move, plus the Claude-side wiring) ── */
check("bash guard: out-of-project redirect denied (strict)", guardBashCommand(CWD, "echo x > ../out.txt", true) !== null);
check("bash guard: out-of-project redirect allowed (non-strict)", guardBashCommand(CWD, "echo x > ../out.txt", false) === null);
check("bash guard: in-project redirect allowed", guardBashCommand(CWD, "echo x > logs/out.txt", true) === null);
check("bash guard: /dev/null allowed", guardBashCommand(CWD, "cmd > /dev/null 2>&1", true) === null);
check("bash guard: fd-qualified redirect outside denied", guardBashCommand(CWD, "cmd 2> ../err.log", true) !== null);
check("bash guard: tee outside denied", guardBashCommand(CWD, "cat x | tee ../copy.txt", true) !== null);
check("bash guard: $VAR target left alone", guardBashCommand(CWD, "echo x > $OUT", true) === null);
check("bash guard: WSL-dialect absolute target denied", guardBashCommand(CWD, "echo x > /mnt/d/other/o.txt", true) !== null);
check("bash guard: fused absolute target denied", guardBashCommand(CWD, "echo x >D:/tmp/o.txt", true) !== null || guardBashCommand(CWD, "echo x > D:/tmp/o.txt", true) !== null);

/* ── summary ── */
console.log(`project-isolation smoke: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
