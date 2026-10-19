// Headless smoke for the tool.media chain (script-generated inline video):
// SdkMessageAdapter's Bash-window video diff + lib/mediaDiff's rg inventory.
//
// The adapter runs for real (stubs: logger, serviceScanner's window hooks,
// electron's app.getPath — rgSearch then falls back to `which rg`, so rg must
// be on PATH). Covered scenarios:
//  1. Foreground Bash window: new video on disk → exactly one tool.media
//     with the absolute path.
//  2. No new files → no event.
//  3. Re-running the diff for the same window (task_notification after the
//     foreground result) → no duplicate (bashVideoEmitted dedup).
//  4. Backgrounded Bash: task_started(is_backgrounded) + placeholder
//     tool_result does NOT diff early; task_notification completion does.
//  5. node_modules videos are invisible to the inventory.
//  6. flushFinal clears leftover baselines.
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SdkMessageAdapter } from "@main/providers/claude-sdk/SdkMessageAdapter.js";
import { FileSnapshot } from "@main/lib/fileSnapshot.js";
import { snapshotVideoFiles } from "@main/lib/mediaDiff.js";
import type { ProviderContext } from "@contracts/provider";
import type { RuntimeEvent } from "@contracts/runtime";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const project = await mkdtemp(join(tmpdir(), "mcode-tool-media-"));
  await mkdir(join(project, "out"), { recursive: true });
  await mkdir(join(project, "node_modules", "pkg"), { recursive: true });

  const events: RuntimeEvent[] = [];
  const ctx = { emit: (e: RuntimeEvent) => { events.push(e); } } as unknown as ProviderContext;
  const adapter = new SdkMessageAdapter(ctx, "sess-smoke", false, project, new FileSnapshot("sess-smoke"), null);
  const media = () => events.filter((e): e is Extract<RuntimeEvent, { type: "tool.media" }> => e.type === "tool.media");
  // Deterministic access to the window bookkeeping (private fields).
  const internals = adapter as unknown as {
    emitBashWindowVideos(id: string): Promise<void>;
    state: {
      bashVideoBaselines: Map<string, Promise<Map<string, unknown>>>;
      bashVideoEmitted: Set<string>;
    };
  };
  /** Wait until the window's baseline inventory walk has fully landed —
   *  rg spawns take 100s of ms on Windows, and writing the "new" file
   *  before the baseline resolves makes the diff legitimately see nothing. */
  const awaitBaseline = async (id: string): Promise<void> => {
    const p = internals.state.bashVideoBaselines.get(id);
    if (p) await p;
  };

  // ── 1. Foreground window produces a video ──
  // The project starts EMPTY (only dirs, no files — rg --files exits 1
  // there): this is the regression guard for the empty-baseline fix in
  // mediaDiff (null → empty set, not "window disabled").
  await adapter.dispatch({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "toolu_fg", name: "Bash", input: { command: "npm run video" } }] },
  } as never);
  await awaitBaseline("toolu_fg");
  await writeFile(join(project, "out", "clip.mp4"), Buffer.alloc(2048, 1));
  await adapter.dispatch({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "toolu_fg", content: "done" }] },
  } as never);
  await sleep(600); // the diff is fire-and-forget — give it a beat
  const m1 = media().filter((e) => e.toolCallId === "toolu_fg");
  check("foreground window emits one tool.media", m1.length === 1, m1);
  check(
    "carries the new file's absolute path",
    m1.length === 1 && m1[0].filePaths.length === 1 && m1[0].filePaths[0] === join(project, "out", "clip.mp4"),
    m1[0]?.filePaths,
  );

  // ── 2. Window with no new files ──
  events.length = 0;
  await adapter.dispatch({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "toolu_none", name: "Bash", input: { command: "ls" } }] },
  } as never);
  await awaitBaseline("toolu_none");
  await adapter.dispatch({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "toolu_none", content: "ok" }] },
  } as never);
  await sleep(300);
  check("no new files → no tool.media", media().length === 0, media());

  // ── 3. Dedup: re-run the diff for an already-emitted window ──
  await internals.emitBashWindowVideos("toolu_fg");
  await sleep(200);
  check("same window does not double-report", media().length === 0, media());

  // ── 4. Backgrounded window: settle at task_notification, not tool_result ──
  events.length = 0;
  await adapter.dispatch({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "toolu_bg", name: "Bash", input: { command: "render --bg" } }] },
  } as never);
  await adapter.dispatch({
    type: "system",
    subtype: "task_started",
    task_id: "task_bg",
    tool_use_id: "toolu_bg",
    task_type: "local_bash",
    description: "render --bg",
    is_backgrounded: true,
  } as never);
  await awaitBaseline("toolu_bg");
  // Placeholder tool_result while the render is still running — must NOT diff.
  await adapter.dispatch({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "toolu_bg", content: "started in background" }] },
  } as never);
  check("backgrounded placeholder result does not diff early", media().length === 0, media());
  // The render finishes → new file → task_notification settles the window.
  await writeFile(join(project, "out", "render2.mp4"), Buffer.alloc(1024, 2));
  await adapter.dispatch({
    type: "system",
    subtype: "task_notification",
    task_id: "task_bg",
    status: "completed",
  } as never);
  await sleep(300);
  const m4 = media().filter((e) => e.toolCallId === "toolu_bg");
  check("task_notification settles the background window", m4.length === 1, m4);
  check(
    "only the render2 file is reported",
    m4.length === 1 && m4[0].filePaths.length === 1 && m4[0].filePaths[0].endsWith("render2.mp4"),
    m4[0]?.filePaths,
  );

  // ── 5. node_modules videos are invisible ──
  await writeFile(join(project, "node_modules", "pkg", "evil.mp4"), Buffer.alloc(16, 3));
  const inv = await snapshotVideoFiles(project);
  check(
    "inventory excludes node_modules",
    ![...inv.keys()].some((p) => p.includes("node_modules")) && inv.size === 2,
    [...inv.keys()],
  );

  // ── 5b. OVERWRITE is the common render shape (stable output paths — every
  // run rewrites C1.mp4). A re-render in a LATER window must fire even
  // though the file already existed at that window's baseline. ──
  events.length = 0;
  await adapter.dispatch({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "toolu_rerender", name: "Bash", input: { command: "npm run video" } }] },
  } as never);
  await awaitBaseline("toolu_rerender");
  // Same path, different bytes — the (mtime, size) fingerprint must catch it.
  await writeFile(join(project, "out", "clip.mp4"), Buffer.alloc(4096, 9));
  await adapter.dispatch({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "toolu_rerender", content: "re-rendered" }] },
  } as never);
  await sleep(600);
  const m5 = media().filter((e) => e.toolCallId === "toolu_rerender");
  check(
    "overwritten render in a later window still emits",
    m5.length === 1 && m5[0].filePaths.length === 1 && m5[0].filePaths[0].endsWith("clip.mp4"),
    m5,
  );

  // ── 6. flushFinal clears leftover baselines ──
  await adapter.dispatch({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "toolu_dangling", name: "Bash", input: { command: "hang" } }] },
  } as never);
  await adapter.flushFinal("error");
  check("flushFinal clears baselines + emitted", internals.state.bashVideoBaselines.size === 0 && internals.state.bashVideoEmitted.size === 0, {
    baselines: internals.state.bashVideoBaselines.size,
    emitted: internals.state.bashVideoEmitted.size,
  });

  // Windows temp dirs can be briefly EBUSY (AV/indexer scanning the files rg
  // just read) — retry once, then let it go; the smoke's verdict is already in.
  try {
    await rm(project, { recursive: true, force: true });
  } catch {
    await sleep(800);
    await rm(project, { recursive: true, force: true }).catch(() => {});
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error("smoke crashed:", err);
  process.exit(1);
});
