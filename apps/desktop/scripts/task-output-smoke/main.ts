/**
 * Headless smoke for main/lib/taskOutputFile.ts — the reader behind the
 * 「运行命令」panel's settle-time output display (task_notification.output_file).
 * Covers: ANSI strip, CRLF normalization, tail cap with line-boundary resume,
 * the file's own partial last line, multibyte preservation, and the
 * missing/empty-file no-throw paths. Pure module — no stubs needed.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTaskOutputTail, TASK_OUTPUT_CAP_BYTES } from "@main/lib/taskOutputFile.js";

let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed += 1;
  } else {
    console.log(`ok: ${msg}`);
  }
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "mcode-task-output-smoke-"));
  try {
    // 1. ANSI strip + CRLF normalization + trimEnd.
    const f1 = join(dir, "a.log");
    writeFileSync(f1, "\x1b[32mOK\x1b[0m line1\r\nplain line2\r\n");
    let r = await readTaskOutputTail(f1);
    assert(r.output === "OK line1\nplain line2", "ANSI stripped + CRLF normalized + trimEnd");
    assert(!r.truncated, "small file not truncated");

    // 2. Missing file → empty, no throw.
    r = await readTaskOutputTail(join(dir, "nope.log"));
    assert(r.output === "" && !r.truncated, "missing file → empty, no throw");

    // 3. Tail cap: oversize file resumes at a line boundary, keeps the file's
    //    own partial last line (the tail must reflect the file, not invent one).
    const f3 = join(dir, "big.log");
    const line = "x".repeat(99) + "\n";
    const size = TASK_OUTPUT_CAP_BYTES + 5000;
    const big = Buffer.alloc(size, 0);
    for (let off = 0; off < size; off += 100) big.write(line, off, "utf8");
    writeFileSync(f3, big);
    r = await readTaskOutputTail(f3);
    const lines = r.output.split("\n");
    assert(r.truncated, "oversize file marked truncated");
    assert(lines[0].length === 99, `resume at line boundary (first line ${lines[0].length})`);
    assert(lines.every((l) => l.length <= 99), "no line exceeds source line length");
    const fileLastPartial = size % 100;
    assert(
      lines[lines.length - 1].length === fileLastPartial,
      `tail preserves file's own partial last line (${fileLastPartial})`,
    );

    // 4. Empty file.
    const f4 = join(dir, "empty.log");
    writeFileSync(f4, "");
    r = await readTaskOutputTail(f4);
    assert(r.output === "" && !r.truncated, "empty file → empty");

    // 5. Multibyte content survives.
    const f5 = join(dir, "zh.log");
    writeFileSync(f5, "进度：50%\n完成 ✓\n");
    r = await readTaskOutputTail(f5);
    assert(r.output === "进度：50%\n完成 ✓", "utf-8 multibyte preserved");

    // 6. CSI cursor codes + OSC title escapes.
    const f6 = join(dir, "esc.log");
    writeFileSync(f6, "\x1b[2K\x1b[1Gstep 1\x1b]0;title\x07done\n");
    r = await readTaskOutputTail(f6);
    assert(r.output === "step 1done", "CSI + OSC escapes stripped");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (failed > 0) {
    console.error(`${failed} assertion(s) failed`);
    process.exit(1);
  }
  console.log("task-output smoke: all assertions passed");
}

void main();
