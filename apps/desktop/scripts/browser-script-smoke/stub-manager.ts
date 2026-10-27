/** BrowserManager stub (esbuild alias target for
 *  @main/browser/BrowserManager.js) — records every call, returns scripted
 *  results with generic-success fallbacks shaped like the real methods'
 *  returns so the REAL browser* tool functions accept them. */
import { record, LIVE } from "./state.js";

export const BrowserManager = {
  list: () => record("list", undefined, LIVE),
  create: (projectPath: string, device?: string) =>
    record("create", { projectPath, device }, { ok: true, browserId: "b1" }),
  notifyAgentOpened: (browserId: string, opts: unknown) =>
    record("notifyAgentOpened", { browserId, opts }, undefined),
  loadUrl: (browserId: string, url: string) => record("loadUrl", { browserId, url }, { ok: true }),
  waitForLoad: (browserId: string) => record("waitForLoad", { browserId }, { ok: true }),
  click: (browserId: string, selector: string) =>
    record("click", { browserId, selector }, { ok: true, url: "http://localhost:5173/after", title: "After" }),
  clickAt: (browserId: string, x: number, y: number) => record("clickAt", { browserId, x, y }, { ok: true }),
  type: (browserId: string, selector: string, text: string) => record("type", { browserId, selector, text }, { ok: true }),
  sendKeys: (browserId: string, keys: string) => record("sendKeys", { browserId, keys }, { ok: true }),
  scroll: (browserId: string, direction: string, pages: number) =>
    record("scroll", { browserId, direction, pages }, { ok: true }),
  selectOption: (browserId: string, selector: string, value: string) =>
    record("selectOption", { browserId, selector, value }, { ok: true }),
  waitFor: (browserId: string, arg: unknown) => record("waitFor", { browserId, arg }, { ok: true, found: true }),
  find: (browserId: string, arg: unknown) =>
    record("find", { browserId, arg }, { ok: true, matches: [{ snippet: "hit" }] }),
  evaluateAsync: (browserId: string, code: string) => record("evaluateAsync", { browserId, code }, { ok: true, result: "42" }),
  snapshot: (browserId: string) =>
    record("snapshot", { browserId }, {
      ok: true,
      data: {
        url: "http://localhost:5173/",
        title: "App",
        readyState: "complete",
        bodyText: "body text",
        interactive: [{ index: 1, role: "button", name: "Go", tag: "button", selector: "#go", text: "Go", inView: true, state: [] }],
      },
    }),
  screenshot: (browserId: string) => record("screenshot", { browserId }, { ok: true, data: "aW1n", mimeType: "image/png" }),
};
