/**
 * Headless smoke for browser_script (agentBrowserTools.ts batch executor).
 * The REAL browserScript + its real browser* siblings run; only the
 * electron-adjacent seams (BrowserManager, electron app, SettingRepo, logger,
 * imageArtifacts) are esbuild-alias stubs backed by state.ts's recorder.
 *
 * Assertions:
 *  A. Validation: empty steps, >40 steps, unknown op (with step index).
 *  B. Dispatch: each op forwards to the right BrowserManager method with the
 *     right field mapping (click index→selector via the snapshot index map,
 *     type selector+text, keys, scroll direction, evaluate script).
 *  C. First-error abort: a failing step stops the batch, the error names the
 *     step index + op, and earlier steps' transcript lines are preserved;
 *     later steps never run.
 *  D. Transcript: per-step lines [i/n] op: excerpt, snapshot output excerpted
 *     at the cap, success header includes step count.
 *  E. Domain guard: navigate steps to untrusted domains fail with guidance to
 *     use browser_navigate; localhost navigates pass (and go through the
 *     real browserNavigate auto-create path when no live view exists).
 *  F. finalScreenshot: appends an image content block.
 */
import { browserScript, type ToolResult } from "@main/browser/agentBrowserTools.js";
import { BROWSER_TOOL_SPECS } from "@main/browser/agentBrowserTools.js";
import { calls, scripted, resetStubs, LIVE } from "./state.js";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    pass += 1;
    console.log(`  ok  ${name}`);
  } else {
    fail += 1;
    console.error(`FAIL  ${name}`);
  }
}
function textOf(r: ToolResult): string {
  return r.content.find((b): b is { type: "text"; text: string } => b.type === "text")?.text ?? "";
}
const ran = (): string[] => calls.map(([m]) => m);

async function main(): Promise<void> {
  console.log("browser script smoke");

  console.log("A. validation");
  const empty = await browserScript({ steps: [] }, "/proj");
  check("empty steps rejected", textOf(empty).startsWith("❌"));
  const tooMany = await browserScript({ steps: Array.from({ length: 41 }, () => ({ op: "snapshot" })) }, "/proj");
  check(">40 steps rejected", textOf(tooMany).includes("拆"));
  const badOp = await browserScript({ steps: [{ op: "snapshot" }, { op: "explode" }] }, "/proj");
  check("unknown op rejected with 1-based index", textOf(badOp).includes("第 2 步"));

  console.log("B. dispatch");
  resetStubs();
  // Seed a snapshot index map: snapshot first so the index handle (index 3 →
  // "#btn") is registered for the click/type steps.
  scripted.snapshot = { ok: true, data: { url: "http://localhost:5173/", title: "App", readyState: "complete", bodyText: "page", interactive: [{ index: 3, role: "button", name: "btn", tag: "button", selector: "#btn", text: "", inView: true, state: [] }] } };
  const ok = await browserScript(
    {
      steps: [
        { op: "snapshot" },
        { op: "click", index: 3 },
        { op: "type", selector: "#q", text: "hello" },
        { op: "keys", keys: "Enter" },
        { op: "scroll", direction: "down", pages: 2 },
        { op: "evaluate", script: "return 1+1" },
      ],
    },
    "/proj",
  );
  const text = textOf(ok);
  check("batch succeeds", !text.startsWith("❌"));
  check("click resolved snapshot index to selector", calls.some(([m, a]) => m === "click" && (a as { selector: string }).selector === "#btn"));
  check("type forwarded selector+text", calls.some(([m, a]) => m === "type" && (a as { text: string }).text === "hello"));
  check("keys forwarded", calls.some(([m, a]) => m === "sendKeys" && (a as { keys: string }).keys === "Enter"));
  check("scroll forwarded", calls.some(([m, a]) => m === "scroll" && (a as { direction: string }).direction === "down"));
  check("evaluate forwarded to evaluateAsync", calls.some(([m, a]) => m === "evaluateAsync" && (a as { code: string }).code === "return 1+1"));

  console.log("C. first-error abort");
  resetStubs();
  scripted.snapshot = { ok: true, data: { url: "http://localhost:5173/", title: "App", readyState: "complete", bodyText: "page", interactive: [] } };
  scripted.click = { ok: false, error: "元素被遮挡" };
  const aborted = await browserScript(
    {
      steps: [
        { op: "snapshot" },
        { op: "click", selector: "#gone" },
        { op: "keys", keys: "Enter" },
      ],
    },
    "/proj",
  );
  const abText = textOf(aborted);
  check("aborts on failing step", abText.startsWith("❌"));
  check("error names step index + op", abText.includes("第 2 步") && abText.includes("click"));
  check("transcript of earlier step preserved", abText.includes("[1/3] snapshot"));
  check("later step never ran", !ran().includes("sendKeys"));

  console.log("D. transcript");
  resetStubs();
  scripted.snapshot = { ok: true, data: { url: "http://localhost:5173/", title: "App", readyState: "complete", bodyText: "X".repeat(5000), interactive: [] } };
  const big = await browserScript({ steps: [{ op: "snapshot" }] }, "/proj");
  const bigText = textOf(big);
  check("snapshot excerpt truncated", bigText.includes("截断") && bigText.length < 1000);
  check("header reports step count", bigText.includes("browser_script 完成(1 步"));

  console.log("E. domain guard");
  resetStubs();
  // No live browser + localhost navigate → auto-create path runs.
  scripted.list = [];
  const navCreate = await browserScript({ steps: [{ op: "navigate", url: "http://localhost:4173/" }] }, "/proj");
  check("localhost navigate in script passes", !textOf(navCreate).startsWith("❌"));
  check("auto-create ran (no live view)", ran().includes("create"));
  // Restore live list; untrusted domain rejected without touching loadUrl.
  resetStubs();
  scripted.list = LIVE;
  const untrusted = await browserScript({ steps: [{ op: "navigate", url: "https://evil.example/" }] }, "/proj", { toolCallId: "tc1", sessionId: "s1" });
  const unText = textOf(untrusted);
  check("untrusted navigate step rejected", unText.startsWith("❌") && unText.includes("browser_navigate"));
  check("untrusted navigate never loaded", !ran().includes("loadUrl"));
  // Without a sessionId in ctx the domain check is skipped (provider always
  // passes one; the shared core tolerates its absence).
  resetStubs();
  scripted.list = LIVE;
  const noSession = await browserScript({ steps: [{ op: "navigate", url: "https://evil.example/" }] }, "/proj");
  check("no sessionId in ctx → gate skipped (documented)", !textOf(noSession).startsWith("❌") || ran().includes("loadUrl"));

  console.log("F. finalScreenshot");
  resetStubs();
  scripted.list = LIVE;
  scripted.screenshot = { ok: true, data: "aW1n", mimeType: "image/png" };
  const shot = await browserScript({ steps: [{ op: "snapshot" }], finalScreenshot: true }, "/proj", { toolCallId: "tc2", sessionId: "s2" });
  check(
    "image block appended",
    shot.content.some((b) => b.type === "image" && (b as { data: string }).data === "aW1n"),
  );
  check("screenshot manager method called", ran().includes("screenshot"));

  console.log("G. spec table");
  check("browser_script registered in BROWSER_TOOL_SPECS", (BROWSER_TOOL_SPECS.browser_script?.description ?? "").length > 40);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

void main();
