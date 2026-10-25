/**
 * Headless smoke for main/browser/chromeRelay.ts (real-Chrome relay). The
 * relay server itself runs REAL — including the `ws` WebSocketServer — with a
 * node `ws` client standing in for the mcode-connector extension. Only the
 * electron-adjacent seams (safeStorage/electron app, SettingRepo, logger,
 * sendToRenderer) are esbuild-alias stubs.
 *
 * Assertions:
 *  A. Frame parsing: valid JSON with type / bad JSON / object without type.
 *  B. Command whitelist: whitelisted CDP methods pass, others rejected.
 *  C. Token storage: first access generates + persists (plaintext fallback —
 *     safeStorage stub is unavailable); a pre-seeded token is honored.
 *  D. End-to-end pairing:
 *     - wrong token → connection closed 4401;
 *     - correct token → welcome frame; a second client while one is live →
 *       closed 4409;
 *     - status frame updates chromeRelayStatus();
 *     - chromeRelayCommand round-trips through the fake extension
 *       (cmd → cmdResult), and a non-whitelisted method never reaches the
 *       wire;
 *     - a command with no connected extension errors clearly.
 *  E. Lifecycle: setEnabled(false) stops the listener, fails pending
 *     commands, and pushes statuses for every transition.
 */
import WebSocket from "ws";
import {
  parseChromeRelayFrame,
  isAllowedChromeRelayCommand,
  getChromeRelayToken,
  startChromeRelay,
  stopChromeRelay,
  chromeRelayStatus,
  chromeRelayCommand,
  setChromeRelayEnabled,
} from "@main/browser/chromeRelay.js";
import { settingsMap, pushedStatuses } from "./stubs.js";

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fake extension: connect + hello, collect frames, answer commands via
 *  `responder`. */
function fakeExtension(
  url: string,
  token: string,
  responder?: (method: string, params: unknown) => { ok: boolean; result?: unknown; error?: string },
): { frames: Array<Record<string, unknown>>; close: () => void; closedWith: () => number | null } {
  const frames: Array<Record<string, unknown>> = [];
  let closeCode: number | null = null;
  const ws = new WebSocket(url);
  ws.on("open", () => ws.send(JSON.stringify({ v: 1, type: "hello", token })));
  ws.on("message", (data) => {
    const f = JSON.parse(String(data)) as Record<string, unknown>;
    frames.push(f);
    if (f.type === "cmd" && responder) {
      const r = responder(String(f.method), f.params);
      ws.send(JSON.stringify({ type: "cmdResult", id: f.id, ...r }));
    }
  });
  ws.on("close", (code) => {
    closeCode = code;
  });
  return { frames, close: () => ws.close(), closedWith: () => closeCode };
}

/** Wait until predicate over the frames list is true (or timeout). */
async function until(pred: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(25);
  }
  return pred();
}

async function main(): Promise<void> {
  console.log("chrome relay smoke");

  console.log("A. frame parsing");
  check("parses a valid frame", parseChromeRelayFrame('{"type":"hello","token":"t"}')?.type === "hello");
  check("bad JSON → null", parseChromeRelayFrame("{nope") === null);
  check("no type → null", parseChromeRelayFrame('{"x":1}') === null);

  console.log("B. whitelist");
  check("Page.navigate allowed", isAllowedChromeRelayCommand("Page.navigate"));
  check("Runtime.evaluate allowed", isAllowedChromeRelayCommand("Runtime.evaluate"));
  check("Page.captureScreenshot allowed", isAllowedChromeRelayCommand("Page.captureScreenshot"));
  check("Target.createTarget allowed", isAllowedChromeRelayCommand("Target.createTarget"));
  check("Network.setRequestInterception denied", !isAllowedChromeRelayCommand("Network.setRequestInterception"));
  check("Browser.close denied", !isAllowedChromeRelayCommand("Browser.close"));

  console.log("C. token");
  settingsMap.set("browser.chromeRelayToken", "smoke-token-123");
  check("seeded token honored", getChromeRelayToken() === "smoke-token-123");
  settingsMap.delete("browser.chromeRelayToken");
  settingsMap.delete("browser.chromeRelayToken.enc");
  const fresh = getChromeRelayToken();
  check("first use generates a token", typeof fresh === "string" && fresh.length >= 20);
  check("generated token persisted (plaintext fallback)", settingsMap.get("browser.chromeRelayToken") === fresh);

  console.log("D. pairing + commands");
  const token = getChromeRelayToken();
  // setEnabled (not bare startChromeRelay) so the `enabled` gate that
  // chromeRelayCommand checks is true — same as the real settings toggle.
  const started = setChromeRelayEnabled(true);
  await until(() => chromeRelayStatus().listening);
  const port = chromeRelayStatus().port ?? 0;
  void started;
  const url = `ws://127.0.0.1:${port}`;
  check("listening on a real port", port > 0 && chromeRelayStatus().listening);

  const bad = fakeExtension(url, "wrong-token");
  await until(() => bad.closedWith() !== null);
  check("bad token → closed 4401", bad.closedWith() === 4401);

  const ext = fakeExtension(url, token, (method, params) => {
    if (method === "Page.navigate") return { ok: true, result: { frameId: "f1", loaderId: "l1" } };
    if (method === "Runtime.evaluate") return { ok: true, result: { result: { value: params } } };
    return { ok: true, result: { done: true } };
  });
  check("welcome received", await until(() => ext.frames.some((f) => f.type === "welcome")));

  const second = fakeExtension(url, token);
  await until(() => second.closedWith() !== null);
  check("second client while one live → closed 4409", second.closedWith() === 4409);

  check("status shows connected", chromeRelayStatus().connected);

  const nav = await chromeRelayCommand("Page.navigate", { url: "https://github.com/" }, { targetId: "42" });
  check("command round-trips", nav.ok && (nav.result as { frameId?: string }).frameId === "f1");
  check("extension saw the targetId", ext.frames.some((f) => f.type === "cmd" && f.targetId === "42"));

  const denied = await chromeRelayCommand("Emulation.setDeviceMetricsOverride", {});
  check("non-whitelisted command rejected locally", !denied.ok && !ext.frames.some((f) => f.type === "cmd" && f.method === "Emulation.setDeviceMetricsOverride"));

  const echo = await chromeRelayCommand("Runtime.evaluate", { hello: 1 }, { targetId: "42" });
  check("evaluate echoes params through the fake", echo.ok && JSON.stringify((echo.result as { result: { value: unknown } }).result.value) === JSON.stringify({ hello: 1 }));

  console.log("E. lifecycle");
  const stopped = setChromeRelayEnabled(false);
  check("disable stops listening", !stopped.listening && stopped.port === null);
  const afterStop = await chromeRelayCommand("Page.navigate", { url: "https://github.com/" });
  check("command after stop errors clearly", !afterStop.ok && afterStop.error.includes("未启用"));
  check("statuses were pushed for transitions", pushedStatuses.length >= 3);

  stopChromeRelay();
  ext.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  // Keep node alive across any dangling socket handles just long enough to
  // flush, then exit explicitly.
  setTimeout(() => process.exit(fail > 0 ? 1 : 0), 200);
}

void main();
