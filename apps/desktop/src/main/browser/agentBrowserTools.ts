/**
 * Shared browser-tool implementation for agent providers (Pi + Claude).
 *
 * Both providers register `browser_*` tools that drive the app's embedded
 * browser (the same `BrowserManager` `WebContentsView` the browser panel
 * uses). The tool plumbing differs per provider — Pi uses `pi.registerTool`
 * (typebox schemas), Claude uses `createSdkMcpServer` (zod schemas + a
 * CallToolResult handler) — but the actual browser operations are identical.
 * This module is that shared core: pure functions that take parsed args,
 * resolve a browserId, call `BrowserManager`, and return a provider-neutral
 * result whose `content` array matches MCP's `CallToolResult.content` shape
 * (text / image blocks), so both providers can return it verbatim.
 *
 * browserId resolution: all tools accept an optional `browserId`. When
 * omitted, the first live view is reused; if none is live, `navigate` creates
 * one (and shows it so the user sees the agent browsing), while the other
 * tools return an error telling the model to call `navigate` first. The
 * resolved id is echoed back in the result text so the model can pass it on
 * subsequent calls (avoiding repeated discovery).
 */
import { BrowserManager } from "./BrowserManager.js";
import { log } from "@main/lib/logger.js";
import type { BrowserDevicePreset } from "@contracts/ipc";

/** The device presets an agent can request when navigating. Mirrors
 *  BrowserDevicePreset from contracts (desktop = no emulation, full viewport;
 *  iphone/android = Chromium device emulation at phone size + the renderer
 *  narrows the view to a phone-width column). */
export const AGENT_DEVICE_PRESETS = ["desktop", "iphone", "android"] as const;
export type AgentDevicePreset = (typeof AGENT_DEVICE_PRESETS)[number];

/** Normalize whatever the model passed into a valid preset (default desktop). */
function coerceDevice(v: unknown): BrowserDevicePreset {
  return v === "iphone" || v === "android" ? v : "desktop";
}

/** A text content block (matches MCP's TextContent minimal shape). */
export interface TextBlock {
  type: "text";
  text: string;
}

/** An image content block (matches MCP's ImageContent). `data` is base64. */
export interface ImageBlock {
  type: "image";
  data: string;
  mimeType: "image/png";
}

/** Provider-neutral tool result: `content` matches MCP CallToolResult.content
 *  and Pi's execute() return shape, so each provider returns it directly.
 *
 *  Declared as a `type` alias (not an interface) so it gains an implicit index
 *  signature — required for assignability to the SDK's CallToolResult, whose
 *  handler return type carries `[x: string]: unknown`. Interfaces don't get an
 *  implicit index signature, so an interface form would fail to assign. */
export type ToolResult = {
  content: Array<TextBlock | ImageBlock>;
  /** Pi's execute() also expects a `details` object; harmless for Claude. */
  details?: Record<string, unknown>;
  /** Allow the SDK's CallToolResult-required index signature (`_meta` etc). */
  [k: string]: unknown;
};

/** Optional hook the provider can pass in to surface a captured image as an
 *  inline block in the conversation. Pi wires this to `ctx.emit` (a
 *  `browser.image` RuntimeEvent); Claude instead relies on the image content
 *  block in the tool result being parsed by the store. */
export interface BrowserToolContext {
  /** Emitted right after a screenshot is captured, so the renderer can attach
   *  an inline image block (Pi path). */
  onImage?: (info: { toolCallId: string; data: string; mimeType: "image/png" }) => void;
}

/** Allowed URL schemes for `browser_navigate`. `file:` / `javascript:` /
 *  `data:` are rejected — the embedded browser is for web pages, and these
 *  schemes are either meaningless or unsafe under agent control. */
function isAllowedUrl(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

/** Find a browserId to operate on. When the caller passed one, validate it
 *  exists. Otherwise pick the first live view. Returns `kind:"none"` when no
 *  usable view is found, so the caller can decide whether to auto-create
 *  (navigate does; the others surface an error). */
function resolveBrowserId(browserId?: string):
  | { ok: true; browserId: string }
  | { ok: false; reason: string } {
  if (browserId) {
    const infos = BrowserManager.list();
    if (infos.some((i) => i.browserId === browserId)) return { ok: true, browserId };
    return { ok: false, reason: `browserId "${browserId}" 不存在或已关闭` };
  }
  const infos = BrowserManager.list();
  if (infos.length > 0) return { ok: true, browserId: infos[0].browserId };
  return { ok: false, reason: "no-live-browser" };
}

/** Helper: build a text-only result. */
function text(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

/** Helper: build an error result (still a normal tool result — the model reads
 *  the text and recovers; we don't throw, which would surface as an
 *  isError tool result). */
function errorResult(msg: string): ToolResult {
  return { content: [{ type: "text", text: `❌ ${msg}` }] };
}

/** `browser_list` — list all live browser views with their current url/title.
 *  Safe to call with no browser open (returns an empty list). */
export function browserList(): ToolResult {
  const infos = BrowserManager.list();
  if (infos.length === 0) {
    return text("当前没有打开的浏览器视图。先调用 browser_navigate({ url }) 打开一个页面。");
  }
  const lines = infos.map(
    (i, idx) =>
      `[${idx}] browserId=${i.browserId}\n    url=${i.url || "(about:blank)"}\n    title=${i.title || "(无标题)"}`,
  );
  return text(`当前浏览器视图(${infos.length} 个):\n\n${lines.join("\n\n")}`);
}

/** `browser_navigate` — load a URL. When no browserId is given and none is
 *  live, a new view is created (and shown) so the user sees the agent
 *  browsing. `projectPath` is required to create a view (it's bound to a
 *  project for consistency with terminal/git). `device` selects the emulation
 *  preset (desktop = full-width PC; iphone/android = phone-sized column) —
 *  applied on creation, or switched via setDevice for an existing view. */
export async function browserNavigate(
  args: { url: string; browserId?: string; device?: AgentDevicePreset },
  projectPath: string,
): Promise<ToolResult> {
  const url = (args.url ?? "").trim();
  if (!url) return errorResult("url 不能为空");
  if (!isAllowedUrl(url)) {
    return errorResult(
      `仅支持 http/https 协议(收到 "${url.slice(0, 40)}")。请使用完整的 http(s):// 地址。`,
    );
  }
  const device = coerceDevice(args.device);

  let browserId = args.browserId;
  let createdNew = false;
  if (!browserId) {
    const resolved = resolveBrowserId();
    if (resolved.ok) {
      browserId = resolved.browserId;
    } else if (resolved.reason === "no-live-browser") {
      // Auto-create so the user sees the agent browsing. Pass the requested
      // device as initialDevice so emulation is applied at dom-ready (the safe
      // earliest point — applying synchronously crashes the GPU pre-init).
      if (!projectPath) {
        return errorResult("无法自动创建浏览器:缺少 projectPath。请先指定 browserId。");
      }
      const created = BrowserManager.create(projectPath, device);
      if (!created.ok) return errorResult(created.error ?? "创建浏览器失败");
      browserId = created.browserId;
      createdNew = true;
      log.info(`agent browser auto-created: ${browserId} project=${projectPath} device=${device}`);
    } else {
      return errorResult(resolved.reason);
    }
  } else {
    // Validate an explicitly-passed id.
    const check = resolveBrowserId(browserId);
    if (!check.ok) return errorResult(check.reason);
  }

  // For an existing view, apply the requested device preset (no-op if it
  // already matches). Skipped for a freshly-created view (initialDevice already
  // set it; calling setDevice again is harmless but redundant).
  if (!createdNew) {
    BrowserManager.setDevice(browserId, device);
  }

  // Tell the renderer to surface the browser panel + adopt this view as a tab.
  // The renderer's BrowserPanel takes over showing the view at precise bounds
  // (measured from its placeholder div). We DON'T show() here: a pre-show with
  // default bounds would briefly cover the icon rail before BrowserPanel syncs.
  // If the renderer is slow to adopt, screenshot's own temp-show covers capture.
  BrowserManager.notifyAgentOpened(browserId, { device });

  const res = BrowserManager.loadUrl(browserId, url);
  if (!res.ok) return errorResult(res.error ?? "导航失败");
  // Wait for the page to finish loading so a subsequent snapshot/screenshot
  // sees real content. fire-and-forget loadURL returns before any bytes are
  // fetched; without this wait, screenshot captures a blank page.
  const loaded = await BrowserManager.waitForLoad(browserId);
  if (!loaded.ok) return errorResult(loaded.error ?? "页面加载失败");
  return text(
    `已导航到 ${url}(browserId=${browserId})。页面已加载完成${loaded.title ? `,标题: "${loaded.title}"` : ""}。可调用 browser_snapshot 读取内容或 browser_screenshot 截图。`,
  );
}

/** `browser_snapshot` — read a structured snapshot of the page (read-only).
 *  Returns url/title, clipped html + bodyText, and an interactive-element
 *  list with selectors for `browser_click`. */
export async function browserSnapshot(args: { browserId?: string }): Promise<ToolResult> {
  const resolved = resolveBrowserId(args.browserId);
  if (!resolved.ok) {
    return errorResult(
      resolved.reason === "no-live-browser"
        ? "当前没有打开的浏览器。请先调用 browser_navigate({ url })。"
        : resolved.reason,
    );
  }
  const res = await BrowserManager.snapshot(resolved.browserId);
  if (!res.ok || !res.data) return errorResult(res.error ?? "读取快照失败");

  const d = res.data;
  const intLines = (d.interactive ?? []).slice(0, 40).map(
    (el) =>
      `  • <${el.tag}> role="${el.role}" name="${el.name}"\n      selector: ${el.selector}${
        el.text && el.text !== el.name ? `\n      text: ${el.text}` : ""
      }`,
  );
  const summary = [
    `页面快照(browserId=${resolved.browserId})`,
    `URL: ${d.url}`,
    `标题: ${d.title || "(无)"}`,
    `readyState: ${d.readyState}`,
    ``,
    `可交互元素(${d.interactive?.length ?? 0} 个,展示前 ${intLines.length}):`,
    intLines.join("\n") || "  (未发现可交互元素)",
    ``,
    `页面正文(前 ${d.bodyText.length} 字符):`,
    d.bodyText || "(空)",
  ].join("\n");
  return text(summary);
}

/** `browser_click` — click an element by CSS selector. The selector should
 *  come from a prior `browser_snapshot`'s interactive list. Returns post-click
 *  url/title so the model can detect navigation. */
export async function browserClick(args: { selector: string; browserId?: string }): Promise<ToolResult> {
  const selector = (args.selector ?? "").trim();
  if (!selector) return errorResult("selector 不能为空");
  const resolved = resolveBrowserId(args.browserId);
  if (!resolved.ok) {
    return errorResult(
      resolved.reason === "no-live-browser"
        ? "当前没有打开的浏览器。请先调用 browser_navigate({ url })。"
        : resolved.reason,
    );
  }
  const res = await BrowserManager.click(resolved.browserId, selector);
  if (!res.ok) return errorResult(res.error ?? "点击失败");
  return text(
    `已点击 "${selector}"(browserId=${resolved.browserId})。当前 URL: ${res.url ?? "(未知)"}${
      res.title ? `\n标题: ${res.title}` : ""
    }`,
  );
}

/** `browser_screenshot` — capture the current page as a PNG. Returns an image
 *  content block (so the model sees the screenshot) AND, when `ctx.onImage`
 *  is wired (Pi path), emits it for inline conversation rendering. */
export async function browserScreenshot(
  args: { browserId?: string },
  ctx: BrowserToolContext & { toolCallId: string },
): Promise<ToolResult> {
  const live = BrowserManager.list();
  log.info(`browserScreenshot called: requestedId=${args.browserId ?? "(none)"} liveCount=${live.length} liveIds=${JSON.stringify(live.map((l) => l.browserId))}`);
  const resolved = resolveBrowserId(args.browserId);
  if (!resolved.ok) {
    log.warn(`browserScreenshot resolveBrowserId failed: ${resolved.reason}`);
    return errorResult(
      resolved.reason === "no-live-browser"
        ? "当前没有打开的浏览器。请先调用 browser_navigate({ url })。"
        : resolved.reason,
    );
  }
  const res = await BrowserManager.screenshot(resolved.browserId);
  if (!res.ok || !res.data) {
    log.warn(`browserScreenshot BrowserManager.screenshot failed: ${res.error}`);
    return errorResult(res.error ?? "截图失败");
  }

  log.info(`browserScreenshot success: base64Len=${res.data.length}`);
  // Pi path: emit a structured event so the renderer attaches an inline image
  // block keyed off toolCallId. Claude path: the image content block
  // below is parsed by the store from the tool_result.
  ctx.onImage?.({ toolCallId: ctx.toolCallId, data: res.data, mimeType: "image/png" });

  return {
    content: [
      { type: "text", text: `已截图(browserId=${resolved.browserId})。` },
      { type: "image", data: res.data, mimeType: "image/png" },
    ],
  };
}
