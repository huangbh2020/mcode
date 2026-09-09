/**
 * Shared browser-tool implementation for agent providers (Pi + Claude + Codex).
 *
 * All providers register `browser_*` tools that drive the app's embedded
 * browser (the same `BrowserManager` `WebContentsView` the browser panel
 * uses). The tool plumbing differs per provider — Pi uses `pi.registerTool`
 * (typebox schemas), Claude uses `createSdkMcpServer` (zod schemas + a
 * CallToolResult handler), Codex registers JSON-schema `dynamicTools` — but
 * the actual browser operations are identical. This module is that shared
 * core: pure functions that take parsed args, resolve a browserId, call
 * `BrowserManager`, and return a provider-neutral result whose `content`
 * array matches MCP's `CallToolResult.content` shape (text / image blocks),
 * so every provider can return it verbatim.
 *
 * browserId resolution: all tools accept an optional `browserId`. When
 * omitted, the agent's ACTIVE view (set via `browser_switch_tab`) is used; if
 * none was set, the first live view is reused; if none is live, `navigate`
 * creates one (and shows it so the user sees the agent browsing), while the
 * other tools return an error telling the model to call `navigate` first. The
 * resolved id is echoed back in the result text so the model can pass it on
 * subsequent calls (avoiding repeated discovery).
 *
 * Element handles: `browser_snapshot` assigns each interactive element a
 * 1-based `index`. The index→selector map is kept per browserId (module state
 * below) so `browser_click` / `browser_type` / `browser_select` accept an
 * `index` handle — immune to the quoting/escaping issues of copying raw CSS
 * selector strings out of the snapshot text. A raw `selector` stays accepted
 * everywhere as a fallback handle.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { app } from "electron";
import { BrowserManager, type BrowserDownloadEntry } from "./BrowserManager.js";
import { SNAPSHOT_DISPLAY_CAP } from "./snapshotScript.js";
import { log } from "@main/lib/logger.js";
import { SettingRepo } from "@main/store/repositories.js";
import {
  BROWSER_SCREENSHOT_DIR_SETTING_KEY,
  type BrowserDevicePreset,
} from "@contracts/ipc";

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

/** The agent's active view — the implicit target for browserId-less calls.
 *  Set by browser_navigate (on the view it went to) and browser_switch_tab;
 *  cleared lazily when the view dies. Module state (main process, shared by
 *  all providers since they run in the same process). */
let activeBrowserId: string | null = null;

/** Last snapshot's index→selector map per browserId, so `index` handles on
 *  click/type/select resolve to stable selectors. Stale entries are pruned
 *  whenever the live-view list is consulted. */
const snapshotIndexMaps = new Map<string, Map<number, string>>();

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
  /** GUI session id the screenshot belongs to — used to organize the saved
   *  file under `<dir>/<sessionId>/turn-<N>/`. Providers pass it when
   *  available; omitted → screenshots are still shown inline but not saved to
   *  the per-session layout. */
  sessionId?: string;
  /** 1-based turn number within the session (see StartTurnRequest.turnNumber).
   *  Combined with sessionId, screenshots land in per-turn folders. */
  turnNumber?: number;
}

/**
 * Save a screenshot (base64 PNG) to disk under the configured screenshot
 * directory, organized per session + turn:
 *
 *   `<dir>/<sessionId>/turn-<N>/<timestamp>-<toolCallId>.png`
 *
 * The base dir comes from the `browser.screenshotDir` setting; when unset it
 * falls back to the system Pictures directory. Never throws — a failed save
 * only logs a warning so the in-conversation screenshot display is unaffected.
 * Returns the absolute saved path, or null when the save failed (or when no
 * session context was provided).
 */
export function saveScreenshotToDisk(
  data: string,
  opts: { sessionId?: string; turnNumber?: number; toolCallId: string },
): string | null {
  if (!opts.sessionId || !data) return null;
  const baseDir =
    SettingRepo.get(BROWSER_SCREENSHOT_DIR_SETTING_KEY)?.trim() ||
    app.getPath("pictures");
  // Sanitize the session id for use as a directory name (ids are UUIDs, but
  // guard against anything odd anyway).
  const safeSession = opts.sessionId.replace(/[^\w.-]/g, "_");
  const turnDir = join(baseDir, safeSession, `turn-${opts.turnNumber ?? 0}`);
  try {
    mkdirSync(turnDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "-").slice(0, 19);
    // Sanitize the toolCallId for the filename (it may contain characters
    // that are invalid on some filesystems).
    const safeCallId = opts.toolCallId.replace(/[^\w.-]/g, "_");
    const filePath = join(turnDir, `${ts}-${safeCallId}.png`);
    writeFileSync(filePath, Buffer.from(data, "base64"));
    log.info(`browser screenshot saved: ${filePath}`);
    return filePath;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`browser screenshot save failed: ${msg}`);
    return null;
  }
}

/**
 * Save a generated PDF (base64, from CDP printToPDF) to disk — same artifact
 * directory discipline as saveScreenshotToDisk, with two differences: the
 * model may name the file (`fileName`, sanitized to a bare filename — path
 * separators stripped, so it can never escape the managed directory), and
 * without a session context it falls into a `pdf/` subfolder instead of the
 * base dir. Returns the absolute path or null on failure (the tool then
 * reports the error; the PDF data is dropped).
 */
export function savePdfToDisk(
  data: string,
  opts: { fileName?: string; sessionId?: string; turnNumber?: number; toolCallId: string },
): string | null {
  if (!data) return null;
  const baseDir =
    SettingRepo.get(BROWSER_SCREENSHOT_DIR_SETTING_KEY)?.trim() ||
    app.getPath("pictures");
  const stem = (opts.fileName ?? "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .trim()
    .replace(/\.pdf$/i, "");
  const safeName = `${stem || `page-${new Date().toISOString().replace(/[:.]/g, "-").replace("T", "-").slice(0, 19)}`}.pdf`;
  const dir = opts.sessionId
    ? join(baseDir, opts.sessionId.replace(/[^\w.-]/g, "_"), `turn-${opts.turnNumber ?? 0}`)
    : join(baseDir, "pdf");
  try {
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, safeName.replace(/[^\w.\-\u4e00-\u9fff ]/g, "_"));
    writeFileSync(filePath, Buffer.from(data, "base64"));
    log.info(`browser pdf saved: ${filePath}`);
    return filePath;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`browser pdf save failed: ${msg}`);
    return null;
  }
}

/** Allowed URL schemes for `browser_navigate`: http(s) pages and local
 *  `file:` pages (a rendered local file exposes no more than the Read tool
 *  already does). `javascript:` / `data:` stay rejected — unsafe under agent
 *  control. */
function isAllowedUrl(url: string): boolean {
  return /^(https?|file):\/\//i.test(url.trim());
}

/** Canonicalize a file URL: backslashes → forward slashes, and the two-slash
 *  drive-letter form `file://D:/x` (drive parsed as a host → Chromium rejects
 *  with ERR_INVALID_URL) or `file://localhost/x` → the three-slash
 *  `file:///x` that actually loads. UNC hosts (`file://server/share/…`) are
 *  left untouched — the lookahead only matches a drive letter. */
function normalizeFileUrl(url: string): string {
  if (!/^file:\/\//i.test(url)) return url;
  return url
    .replace(/\\/g, "/")
    .replace(/^file:\/\/(?:localhost\/|(?=[A-Za-z]:))/i, "file:///");
}

/** Drop index maps (and the active pointer) for views that no longer exist. */
function pruneDeadBrowserState(liveIds: Set<string>): void {
  for (const id of snapshotIndexMaps.keys()) {
    if (!liveIds.has(id)) snapshotIndexMaps.delete(id);
  }
  if (activeBrowserId && !liveIds.has(activeBrowserId)) activeBrowserId = null;
}

/** Find a browserId to operate on. When the caller passed one, validate it
 *  exists. Otherwise prefer the agent's active view, then the first live
 *  view. Returns `kind:"none"` when no usable view is found, so the caller
 *  can decide whether to auto-create (navigate does; the others surface an
 *  error). */
function resolveBrowserId(browserId?: string):
  | { ok: true; browserId: string }
  | { ok: false; reason: string } {
  const infos = BrowserManager.list();
  pruneDeadBrowserState(new Set(infos.map((i) => i.browserId)));
  if (browserId) {
    if (infos.some((i) => i.browserId === browserId)) return { ok: true, browserId };
    return { ok: false, reason: `browserId "${browserId}" 不存在或已关闭` };
  }
  if (activeBrowserId) {
    if (infos.some((i) => i.browserId === activeBrowserId)) return { ok: true, browserId: activeBrowserId };
  }
  if (infos.length > 0) return { ok: true, browserId: infos[0].browserId };
  return { ok: false, reason: "no-live-browser" };
}

/** Resolve an element handle to a CSS selector: an `index` from the most
 *  recent snapshot of THIS view wins; otherwise the raw `selector` string. */
function resolveSelector(
  browserId: string,
  handle: { index?: unknown; selector?: unknown },
): { ok: true; selector: string } | { ok: false; error: string } {
  if (typeof handle.index === "number" && Number.isFinite(handle.index) && handle.index > 0) {
    const sel = snapshotIndexMaps.get(browserId)?.get(handle.index);
    if (!sel) {
      return {
        ok: false,
        error: `元素索引 ${handle.index} 不在当前快照中(页面可能已变化或尚未 snapshot)。请重新调用 browser_snapshot 获取最新索引。`,
      };
    }
    return { ok: true, selector: sel };
  }
  const sel = typeof handle.selector === "string" ? handle.selector.trim() : "";
  if (sel) return { ok: true, selector: sel };
  return {
    ok: false,
    error: "需要 index(来自最近一次 browser_snapshot)或 selector 参数之一",
  };
}

/** Helper: build a text-only result. */
function text(t: string): ToolResult {
  return { content: [{ type: "text", text: t }] };
}

/** Helper: build an error result (still a normal tool result — the model reads
 *  the text and recovers; we don't throw, which would surface as an
 *  isError tool result). */
function errorResult(msg: string): ToolResult {
  return { content: [{ type: "text", text: `❌ ${msg}` }] };
}

/** Helper: the no-browser error shared by every non-navigating tool. */
function noBrowserError(): ToolResult {
  return errorResult("当前没有打开的浏览器。请先调用 browser_navigate({ url })。");
}

/** `browser_list` — list all live browser views with their current url/title.
 *  Safe to call with no browser open (returns an empty list). */
export function browserList(): ToolResult {
  const infos = BrowserManager.list();
  pruneDeadBrowserState(new Set(infos.map((i) => i.browserId)));
  if (infos.length === 0) {
    return text("当前没有打开的浏览器视图。先调用 browser_navigate({ url }) 打开一个页面。");
  }
  const lines = infos.map((i, idx) => {
    const active = i.browserId === activeBrowserId ? "(agent 当前目标)" : "";
    return `[${idx}] browserId=${i.browserId}${active}\n    url=${i.url || "(about:blank)"}\n    title=${i.title || "(无标题)"}`;
  });
  return text(`当前浏览器视图(${infos.length} 个):\n\n${lines.join("\n\n")}`);
}

/** `browser_navigate` — load a URL. When no browserId is given and none is
 *  live, a new view is created (and shown) so the user sees the agent
 *  browsing; `newTab: true` always opens a fresh view (and makes it the
 *  agent's active view). `projectPath` is required to create a view (it's
 *  bound to a project for consistency with terminal/git). `device` selects
 *  the emulation preset (desktop = full-width PC; iphone/android = phone-sized
 *  column) — applied ONLY on creation. For an existing view the user's
 *  manually-selected device/size is preserved: Chromium emulation persists
 *  across navigations, so re-applying it would only clobber the user's
 *  choice. */
export async function browserNavigate(
  args: { url: string; browserId?: string; device?: AgentDevicePreset; newTab?: boolean },
  projectPath: string,
): Promise<ToolResult> {
  const raw = (args.url ?? "").trim();
  if (!raw) return errorResult("url 不能为空");
  const url = normalizeFileUrl(raw);
  if (!isAllowedUrl(url)) {
    return errorResult(
      `仅支持 http/https/file 协议(收到 "${raw.slice(0, 40)}")。网页用完整 http(s):// 地址;本地文件用 file:/// 绝对路径(Windows 形如 file:///D:/dir/page.html)。`,
    );
  }
  const device = coerceDevice(args.device);

  let browserId: string;
  if (args.newTab === true) {
    // Explicit new tab.
    if (!projectPath) {
      return errorResult("无法创建浏览器:缺少 projectPath。请先指定 browserId。");
    }
    const created = BrowserManager.create(projectPath, device);
    if (!created.ok) return errorResult(created.error ?? "创建浏览器失败");
    browserId = created.browserId;
    log.info(`agent browser created (newTab): ${browserId} project=${projectPath} device=${device}`);
  } else {
    const resolved = resolveBrowserId(args.browserId);
    if (resolved.ok) {
      browserId = resolved.browserId;
    } else if (resolved.reason === "no-live-browser" && !args.browserId) {
      // Auto-create so the user sees the agent browsing. Pass the requested
      // device as initialDevice so emulation is applied at dom-ready (the safe
      // earliest point — applying synchronously crashes the GPU pre-init).
      if (!projectPath) {
        return errorResult("无法自动创建浏览器:缺少 projectPath。请先指定 browserId。");
      }
      const created = BrowserManager.create(projectPath, device);
      if (!created.ok) return errorResult(created.error ?? "创建浏览器失败");
      browserId = created.browserId;
      log.info(`agent browser auto-created: ${browserId} project=${projectPath} device=${device}`);
    } else {
      return resolved.reason === "no-live-browser" ? noBrowserError() : errorResult(resolved.reason);
    }
  }
  // The view the agent just navigated becomes its implicit target.
  activeBrowserId = browserId;

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
 *  Returns url/title, bodyText, and the interactive-element list. Each element
 *  carries a 1-based `index` handle (pass to click/type/select), its form
 *  state (value/checked/disabled/href), an 视口外 marker when it's outside the
 *  viewport, and the fallback CSS selector. */
export async function browserSnapshot(args: { browserId?: string }): Promise<ToolResult> {
  const resolved = resolveBrowserId(args.browserId);
  if (!resolved.ok) {
    return resolved.reason === "no-live-browser" ? noBrowserError() : errorResult(resolved.reason);
  }
  const res = await BrowserManager.snapshot(resolved.browserId);
  if (!res.ok || !res.data) return errorResult(res.error ?? "读取快照失败");

  const d = res.data;
  // Remember the index→selector map for index-addressed click/type/select.
  const map = new Map<number, string>();
  for (const el of d.interactive) map.set(el.index, el.selector);
  snapshotIndexMaps.set(resolved.browserId, map);

  // Display order: in-viewport elements first (what the user sees right now /
  // what a viewport screenshot covers), then the below-the-fold ones. Indices
  // are the collected (DOM-order) handles and stay stable within this
  // snapshot — the sort is only for presentation.
  const inView = d.interactive.filter((el) => el.inView);
  const offView = d.interactive.filter((el) => !el.inView);
  const shown = [...inView, ...offView].slice(0, SNAPSHOT_DISPLAY_CAP);
  const intLines = shown.map((el) => {
    const statePart = el.state.length ? ` ${el.state.join(" ")}` : "";
    const head = `  [${el.index}] <${el.tag}> role="${el.role}" name="${el.name}"${statePart}`;
    const body = [`      selector: ${el.selector}`];
    if (el.text && el.text !== el.name) body.push(`      text: ${el.text}`);
    if (!el.inView) body.push("      (视口外——点击时会自动滚动到位;viewport 截图不含它)");
    return [head, ...body].join("\n");
  });
  const hidden = d.interactive.length - shown.length;
  const summary = [
    `页面快照(browserId=${resolved.browserId})`,
    `URL: ${d.url}`,
    `标题: ${d.title || "(无)"}`,
    `readyState: ${d.readyState}`,
    ``,
    `可交互元素(共 ${d.interactive.length} 个:视口内 ${inView.length} + 视口外 ${offView.length};展示前 ${shown.length} 个。` +
      `[n] 是元素索引,直接传给 browser_click / browser_type / browser_select 的 index 参数):`,
    intLines.join("\n") || "  (未发现可交互元素)",
    hidden > 0 ? `\n(还有 ${hidden} 个元素未展示——用 browser_find 按 selector/文本精确定位,它们同样可以用 [索引] 操作)` : "",
    ``,
    `页面正文(前 ${d.bodyText.length} 字符):`,
    d.bodyText || "(空)",
  ].join("\n");
  return text(summary);
}

/** `browser_click` — click an element by snapshot `index` (preferred) or CSS
 *  selector, or raw viewport coordinates. The click is a real mouse event pair
 *  at the element's center (scrolls it into view first), so hover-sensitive
 *  menus and focus behavior match a user click. Returns post-click url/title
 *  plus an 遮挡 warning when something covered the target. */
export async function browserClick(args: {
  index?: number;
  selector?: string;
  coordinateX?: number;
  coordinateY?: number;
  browserId?: string;
}): Promise<ToolResult> {
  const resolved = resolveBrowserId(args.browserId);
  if (!resolved.ok) {
    return resolved.reason === "no-live-browser" ? noBrowserError() : errorResult(resolved.reason);
  }
  const hasCoords =
    typeof args.coordinateX === "number" &&
    typeof args.coordinateY === "number" &&
    Number.isFinite(args.coordinateX) &&
    Number.isFinite(args.coordinateY);

  let res;
  let handleDesc: string;
  if (hasCoords) {
    res = await BrowserManager.clickAt(resolved.browserId, args.coordinateX as number, args.coordinateY as number);
    handleDesc = `坐标(${args.coordinateX}, ${args.coordinateY})`;
  } else {
    const sel = resolveSelector(resolved.browserId, args);
    if (!sel.ok) return errorResult(sel.error);
    res = await BrowserManager.click(resolved.browserId, sel.selector);
    handleDesc = args.index != null ? `元素 [${args.index}]` : `"${sel.selector}"`;
  }
  if (!res.ok) return errorResult(res.error ?? "点击失败");
  const obscuredNote = res.obscured
    ? `\n⚠️ 目标中心被 <${res.obscured.tag}> "${res.obscured.text}" 覆盖,实际点击到的是它——如非预期,先滚动或关闭遮挡层再重试。`
    : "";
  return text(
    `已点击 ${handleDesc}(browserId=${resolved.browserId})。当前 URL: ${res.url ?? "(未知)"}${
      res.title ? `\n标题: ${res.title}` : ""
    }${obscuredNote}`,
  );
}

/** `browser_type` — fill text into an input/textarea/contenteditable by
 *  snapshot `index` or CSS selector. Works with React/Vue controlled inputs
 *  (native value setter + input/change events). `clear: false` appends; empty
 *  text + clear=true wipes the field. The element ends up focused, so
 *  browser_keys({keys:"Enter"}) can submit afterwards. Returns post-action
 *  url/title. */
export async function browserType(args: {
  index?: number;
  selector?: string;
  text: string;
  clear?: boolean;
  browserId?: string;
}): Promise<ToolResult> {
  const value = (args.text ?? "").toString();
  const resolved = resolveBrowserId(args.browserId);
  if (!resolved.ok) {
    return resolved.reason === "no-live-browser" ? noBrowserError() : errorResult(resolved.reason);
  }
  const sel = resolveSelector(resolved.browserId, args);
  if (!sel.ok) return errorResult(sel.error);
  const res = await BrowserManager.type(resolved.browserId, sel.selector, value, args.clear !== false);
  if (!res.ok) return errorResult(res.error ?? "输入失败");
  const handleDesc = args.index != null ? `元素 [${args.index}]` : `"${sel.selector}"`;
  return text(
    `已向 ${handleDesc} ${args.clear === false ? "追加" : "输入"} "${value}"(browserId=${resolved.browserId})。当前 URL: ${res.url ?? "(未知)"}${
      res.title ? `\n标题: ${res.title}` : ""
    }\n(输入框已聚焦,可用 browser_keys({keys:"Enter"}) 提交表单)`,
  );
}

/** `browser_keys` — press a key or shortcut combo ("Enter", "Escape", "Tab",
 *  "ArrowDown", "PageDown", "Control+a", "Shift+Enter"). Goes through the real
 *  input pipeline, so Enter submits forms and Tab moves focus. One combo per
 *  call. Side-effecting (Enter can submit) → approval flow. */
export async function browserKeys(args: { keys: string; browserId?: string }): Promise<ToolResult> {
  const keys = (args.keys ?? "").trim();
  if (!keys) return errorResult("keys 不能为空,如 \"Enter\" / \"Escape\" / \"Control+a\"");
  const resolved = resolveBrowserId(args.browserId);
  if (!resolved.ok) {
    return resolved.reason === "no-live-browser" ? noBrowserError() : errorResult(resolved.reason);
  }
  const res = await BrowserManager.sendKeys(resolved.browserId, keys);
  if (!res.ok) return errorResult(res.error ?? "按键失败");
  return text(
    `已按下 ${keys}(browserId=${resolved.browserId})。当前 URL: ${res.url ?? "(未知)"}${
      res.title ? `\n标题: ${res.title}` : ""
    }`,
  );
}

/** `browser_scroll` — scroll the page (or an element's scrollable box) up/down
 *  by viewport fractions. Returns the resulting scroll position so the agent
 *  knows whether more content remains. Read-only. */
export async function browserScroll(args: {
  direction: "up" | "down";
  pages?: number;
  selector?: string;
  browserId?: string;
}): Promise<ToolResult> {
  const direction = args.direction === "up" ? "up" : "down";
  const pages = typeof args.pages === "number" && Number.isFinite(args.pages) && args.pages > 0 ? Math.min(args.pages, 10) : 1;
  const resolved = resolveBrowserId(args.browserId);
  if (!resolved.ok) {
    return resolved.reason === "no-live-browser" ? noBrowserError() : errorResult(resolved.reason);
  }
  const selector = (args.selector ?? "").trim() || undefined;
  const res = await BrowserManager.scroll(resolved.browserId, direction, pages, selector);
  if (!res.ok) return errorResult(res.error ?? "滚动失败");
  const remaining = Math.max(0, (res.scrollHeight ?? 0) - (res.scrollY ?? 0) - (res.viewport ?? 0));
  return text(
    `已向${direction === "down" ? "下" : "上"}滚动 ${pages} 页${selector ? `(元素内 ${selector})` : ""}(browserId=${resolved.browserId})。` +
      `scrollY=${res.scrollY}/${res.scrollHeight}(视口 ${res.viewport}px)${direction === "down" ? `,距底部还剩 ${remaining}px` : ""}。` +
      `${remaining > 0 && direction === "down" ? "下方还有内容,可继续滚动。" : "已到达边界。"}`,
  );
}

/** `browser_wait` — wait for an element to appear / text to show up / a fixed
 *  number of seconds, instead of blindly snapshotting too early. Read-only. */
export async function browserWait(args: {
  selector?: string;
  text?: string;
  seconds?: number;
  timeoutSeconds?: number;
  browserId?: string;
}): Promise<ToolResult> {
  const resolved = resolveBrowserId(args.browserId);
  if (!resolved.ok) {
    return resolved.reason === "no-live-browser" ? noBrowserError() : errorResult(resolved.reason);
  }
  const selector = (args.selector ?? "").trim();
  const needle = (args.text ?? "").trim();
  const seconds = typeof args.seconds === "number" && Number.isFinite(args.seconds) && args.seconds > 0 ? args.seconds : 0;
  if (!selector && !needle && seconds <= 0) {
    return errorResult("需要 selector、text、seconds 参数之一");
  }
  if (seconds > 0 && !selector && !needle) {
    await new Promise((r) => setTimeout(r, Math.min(seconds, 30) * 1000));
    return text(`已等待 ${Math.min(seconds, 30)} 秒(browserId=${resolved.browserId})。`);
  }
  // NaN guard matters: an infinite timeoutMs would never trip the loop's
  // deadline check and the tool would poll forever.
  const requestedTimeout =
    typeof args.timeoutSeconds === "number" && Number.isFinite(args.timeoutSeconds) && args.timeoutSeconds > 0
      ? args.timeoutSeconds
      : 10;
  const timeoutMs = Math.min(Math.max(requestedTimeout * 1000, 1000), 30_000);
  const res = await BrowserManager.waitFor(
    resolved.browserId,
    { selector: selector || undefined, text: needle || undefined },
    timeoutMs,
  );
  if (!res.ok) return errorResult(res.error ?? "等待失败");
  const what = selector ? `元素 ${selector}` : `文本 "${needle}"`;
  if (res.found) {
    return text(
      `${what} 已出现(等待 ${(res.elapsedMs ?? 0) / 1000}s,browserId=${resolved.browserId})。当前 URL: ${res.url ?? "(未知)"}${res.title ? `\n标题: ${res.title}` : ""}`,
    );
  }
  return text(
    `等待超时(${timeoutMs / 1000}s):${what} 未出现${res.error ? `(${res.error})` : ""}(browserId=${resolved.browserId})。当前 URL: ${res.url ?? "(未知)"}。可先 browser_snapshot 查看当前状态。`,
  );
}

/** `browser_history` — back / forward / reload. Waits for the page to settle.
 *  Side-effecting (navigation) → approval flow. */
export async function browserHistory(args: {
  action: "back" | "forward" | "reload";
  browserId?: string;
}): Promise<ToolResult> {
  const action = args.action;
  if (action !== "back" && action !== "forward" && action !== "reload") {
    return errorResult('action 必须是 "back" | "forward" | "reload"');
  }
  const resolved = resolveBrowserId(args.browserId);
  if (!resolved.ok) {
    return resolved.reason === "no-live-browser" ? noBrowserError() : errorResult(resolved.reason);
  }
  const res = await BrowserManager.historyAction(resolved.browserId, action);
  if (!res.ok) return errorResult(res.error ?? "导航失败");
  const label = action === "back" ? "后退" : action === "forward" ? "前进" : "刷新";
  return text(
    `已${label}(browserId=${resolved.browserId})。当前 URL: ${res.url ?? "(未知)"}${
      res.title ? `\n标题: ${res.title}` : ""
    }`,
  );
}

/** `browser_select` — pick an option in a native <select> dropdown by value or
 *  exact visible text. On mismatch, returns the option list so the model can
 *  retry with exact spelling. Custom div-dropdowns → use browser_click. */
export async function browserSelect(args: {
  index?: number;
  selector?: string;
  value: string;
  browserId?: string;
}): Promise<ToolResult> {
  const value = (args.value ?? "").toString();
  if (!value.trim()) return errorResult("value 不能为空(选项的 value 或可见文本)");
  const resolved = resolveBrowserId(args.browserId);
  if (!resolved.ok) {
    return resolved.reason === "no-live-browser" ? noBrowserError() : errorResult(resolved.reason);
  }
  const sel = resolveSelector(resolved.browserId, args);
  if (!sel.ok) return errorResult(sel.error);
  const res = await BrowserManager.selectOption(resolved.browserId, sel.selector, value);
  if (!res.ok) {
    const opts = res.options;
    if (opts && opts.length) {
      const lines = opts.map((o) => `  • value=${JSON.stringify(o.value)} text=${JSON.stringify(o.text)}${o.selected ? " ←当前" : ""}`);
      return errorResult(`${res.error}\n可选选项:\n${lines.join("\n")}`);
    }
    return errorResult(res.error ?? "下拉选择失败");
  }
  const handleDesc = args.index != null ? `元素 [${args.index}]` : `"${sel.selector}"`;
  return text(
    `已在 ${handleDesc} 选中 ${JSON.stringify(res.selected?.value ?? value)}(browserId=${resolved.browserId})。当前 URL: ${res.url ?? "(未知)"}`,
  );
}

/** `browser_find` — the cheap probe instead of dumping raw HTML: query
 *  elements by CSS selector (with attribute extraction: href/src/class/…)
 *  and/or search the page text (literal or regex) with context snippets.
 *  Read-only. */
export async function browserFind(args: {
  selector?: string;
  text?: string;
  regex?: boolean;
  caseSensitive?: boolean;
  contextChars?: number;
  maxResults?: number;
  attributes?: string[];
  cssScope?: string;
  browserId?: string;
}): Promise<ToolResult> {
  const resolved = resolveBrowserId(args.browserId);
  if (!resolved.ok) {
    return resolved.reason === "no-live-browser" ? noBrowserError() : errorResult(resolved.reason);
  }
  const selector = (args.selector ?? "").trim();
  const needle = (args.text ?? "").trim();
  if (!selector && !needle) return errorResult("需要 selector 或 text 参数之一");
  const res = await BrowserManager.find(resolved.browserId, {
    selector: selector || undefined,
    text: needle || undefined,
    regex: args.regex === true,
    caseSensitive: args.caseSensitive === true,
    contextChars: typeof args.contextChars === "number" ? args.contextChars : undefined,
    maxResults: typeof args.maxResults === "number" ? args.maxResults : undefined,
    attributes: Array.isArray(args.attributes) ? args.attributes.filter((a): a is string => typeof a === "string") : undefined,
    cssScope: (args.cssScope ?? "").trim() || undefined,
  });
  if (!res.ok) return errorResult(res.error ?? "查找失败");
  const matches = res.matches ?? [];
  const lines = matches.map((m) => {
    if (m.snippet !== undefined) return `  • …${m.snippet}…`;
    const attrs = m.attributes && Object.keys(m.attributes).length
      ? ` ${Object.entries(m.attributes).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ")}`
      : "";
    return `  • <${m.tag}> ${JSON.stringify(m.text ?? "")}${attrs}\n    selector: ${m.selector}`;
  });
  const totalNote = res.total != null && res.total > matches.length ? `(共 ${res.total} 个,展示前 ${matches.length} 个)` : "";
  return text(
    `查找结果:${matches.length} 条${totalNote}(browserId=${resolved.browserId})\n\n${lines.join("\n") || "(无匹配)"}`,
  );
}

/** `browser_switch_tab` — point the agent's implicit target (browserId-less
 *  calls) at another live view. Read-only targeting aid; the panel also
 *  surfaces the tab so the user sees what the agent is working on. */
export async function browserSwitchTab(args: { browserId: string }): Promise<ToolResult> {
  const resolved = resolveBrowserId(args.browserId);
  if (!resolved.ok) {
    return resolved.reason === "no-live-browser" ? noBrowserError() : errorResult(resolved.reason);
  }
  activeBrowserId = resolved.browserId;
  BrowserManager.notifyAgentOpened(resolved.browserId);
  const info = BrowserManager.list().find((i) => i.browserId === resolved.browserId);
  return text(
    `已切换目标到 browserId=${resolved.browserId}。url=${info?.url || "(about:blank)"} title=${info?.title || "(无标题)"}。后续省略 browserId 的调用都作用于此视图。`,
  );
}

/** `browser_close_tab` — close a live view by browserId. Destructive (kills
 *  the page session) → approval flow. */
export async function browserCloseTab(args: { browserId: string }): Promise<ToolResult> {
  const resolved = resolveBrowserId(args.browserId);
  if (!resolved.ok) {
    return resolved.reason === "no-live-browser" ? noBrowserError() : errorResult(resolved.reason);
  }
  const res = BrowserManager.close(resolved.browserId);
  if (!res.ok) return errorResult(res.error ?? "关闭失败");
  snapshotIndexMaps.delete(resolved.browserId);
  if (activeBrowserId === resolved.browserId) activeBrowserId = null;
  const remaining = BrowserManager.list().length;
  return text(`已关闭 browserId=${resolved.browserId}。剩余 ${remaining} 个浏览器视图。`);
}

/** `browser_evaluate` — run arbitrary JS in the page (modify DOM text, styles,
 *  attributes, trigger events — anything the page can do). The script runs in
 *  the page's own context (no Node/Electron access). Returns the script's
 *  return value serialized as text so the model can verify its changes.
 *  Side-effecting: goes through the normal approval flow. */
export async function browserEvaluate(args: {
  script: string;
  browserId?: string;
}): Promise<ToolResult> {
  const script = (args.script ?? "").trim();
  if (!script) return errorResult("script 不能为空");
  const resolved = resolveBrowserId(args.browserId);
  if (!resolved.ok) {
    return resolved.reason === "no-live-browser" ? noBrowserError() : errorResult(resolved.reason);
  }
  const res = await BrowserManager.evaluate(resolved.browserId, script);
  if (!res.ok) return errorResult(res.error ?? "脚本执行失败");
  return text(
    `已执行脚本(browserId=${resolved.browserId})。执行结果:\n${res.result ?? "(无返回值)"}\n当前 URL: ${
      res.url ?? "(未知)"
    }${res.title ? `\n标题: ${res.title}` : ""}`,
  );
}

/** `browser_screenshot` — capture the current page as a PNG. `fullPage: true`
 *  captures the entire scrollable document via the CDP debugger (degrades to
 *  the viewport on failure). Returns an image content block (so the model sees
 *  the screenshot) AND, when `ctx.onImage` is wired (Pi path), emits it for
 *  inline conversation rendering. */
export async function browserScreenshot(
  args: { browserId?: string; fullPage?: boolean },
  ctx: BrowserToolContext & { toolCallId: string },
): Promise<ToolResult> {
  const live = BrowserManager.list();
  log.info(`browserScreenshot called: requestedId=${args.browserId ?? "(none)"} fullPage=${args.fullPage === true} liveCount=${live.length} liveIds=${JSON.stringify(live.map((l) => l.browserId))}`);
  const resolved = resolveBrowserId(args.browserId);
  if (!resolved.ok) {
    log.warn(`browserScreenshot resolveBrowserId failed: ${resolved.reason}`);
    return resolved.reason === "no-live-browser" ? noBrowserError() : errorResult(resolved.reason);
  }
  const res = await BrowserManager.screenshot(resolved.browserId, { fullPage: args.fullPage === true });
  if (!res.ok || !res.data) {
    log.warn(`browserScreenshot BrowserManager.screenshot failed: ${res.error}`);
    return errorResult(res.error ?? "截图失败");
  }

  log.info(`browserScreenshot success: base64Len=${res.data.length}`);
  // Pi path: emit a structured event so the renderer attaches an inline image
  // block keyed off toolCallId. Claude path: the image content block
  // below is parsed by the store from the tool_result.
  ctx.onImage?.({ toolCallId: ctx.toolCallId, data: res.data, mimeType: "image/png" });

  // Save to disk under the configured screenshot dir (per session + turn).
  // Best-effort: a failed save only drops the file, never the inline image.
  const savedPath = saveScreenshotToDisk(res.data, {
    sessionId: ctx.sessionId,
    turnNumber: ctx.turnNumber,
    toolCallId: ctx.toolCallId,
  });

  return {
    content: [
      {
        type: "text",
        text: `已截图(browserId=${resolved.browserId}${args.fullPage === true ? ",整页" : ",可视区域"})。${
          savedPath ? `\n已保存到: ${savedPath}` : ""
        }`,
      },
      { type: "image", data: res.data, mimeType: "image/png" },
    ],
  };
}

/** `browser_save_pdf` — render the page to a PDF file (whole document, the
 *  Ctrl+P output) and save it under the browser artifacts directory. Returns
 *  the absolute path; the model can then attach/read it with file tools.
 *  Writing is confined to the managed directory with sanitized names, so this
 *  is read-only in the same sense as browser_screenshot (which also saves). */
export async function browserSavePdf(
  args: {
    fileName?: string;
    paperFormat?: string;
    landscape?: boolean;
    printBackground?: boolean;
    scale?: number;
    headerFooter?: boolean;
    browserId?: string;
  },
  ctx: { toolCallId: string; sessionId?: string; turnNumber?: number },
): Promise<ToolResult> {
  const resolved = resolveBrowserId(args.browserId);
  if (!resolved.ok) {
    return resolved.reason === "no-live-browser" ? noBrowserError() : errorResult(resolved.reason);
  }
  const res = await BrowserManager.printToPdf(resolved.browserId, {
    paperFormat: args.paperFormat,
    landscape: args.landscape === true,
    printBackground: args.printBackground !== false,
    scale: typeof args.scale === "number" ? args.scale : undefined,
    headerFooter: args.headerFooter === true,
  });
  if (!res.ok || !res.data) return errorResult(res.error ?? "PDF 生成失败");
  const savedPath = savePdfToDisk(res.data, {
    fileName: args.fileName,
    sessionId: ctx.sessionId,
    turnNumber: ctx.turnNumber,
    toolCallId: ctx.toolCallId,
  });
  if (!savedPath) return errorResult("PDF 已生成但保存到磁盘失败(目录不可写?)");
  return text(
    `已保存 PDF(browserId=${resolved.browserId}):\n${savedPath}\n可用 Read 等文件工具查看,或直接把该路径告诉用户。`,
  );
}

/** `browser_upload_file` — attach local files to a page's
 *  `<input type="file">` (index/selector handle). Paths may be absolute or
 *  relative to the project root (resolved server-side). Chromium sets the
 *  files natively, so input/change fire like a real user pick. Definitely
 *  side-effecting (hands user files to a website) → approval flow. */
export async function browserUploadFile(
  args: { index?: number; selector?: string; paths: unknown; browserId?: string },
  projectPath: string,
): Promise<ToolResult> {
  const raw = Array.isArray(args.paths) ? args.paths : [args.paths];
  const paths = raw
    .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
    .map((p) => p.trim());
  if (!paths.length) return errorResult("paths 不能为空(本地文件绝对路径,或相对项目根的路径)");
  const resolved = resolveBrowserId(args.browserId);
  if (!resolved.ok) {
    return resolved.reason === "no-live-browser" ? noBrowserError() : errorResult(resolved.reason);
  }
  // Relative paths resolve against the project root — the only base the
  // agent's file tools speak, so a model that reads a repo file can hand the
  // same relative path straight to the uploader.
  const absolute = paths.map((p) => (isAbsolute(p) ? p : resolve(projectPath || ".", p)));
  const sel = resolveSelector(resolved.browserId, args);
  if (!sel.ok) return errorResult(sel.error);
  const res = await BrowserManager.setFileInputFiles(resolved.browserId, sel.selector, absolute);
  if (!res.ok) return errorResult(res.error ?? "上传设置失败");
  const handleDesc = args.index != null ? `元素 [${args.index}]` : `"${sel.selector}"`;
  return text(
    `已向 ${handleDesc} 设置 ${absolute.length} 个文件:\n${absolute.map((p) => `  • ${p}`).join("\n")}\n(browserId=${resolved.browserId})。页面已收到 input/change 事件,通常还需点击"上传/提交"按钮完成上传。当前 URL: ${res.url ?? "(未知)"}`,
  );
}

/** `browser_downloads` — list recent downloads of the embedded browser (they
 *  auto-save to `<系统下载>/mcode-browser/`, no save dialog). Read-only; after
 *  a completed download the model uses the normal file tools on the path. */
export function browserDownloads(): ToolResult {
  const entries = BrowserManager.listDownloads();
  if (entries.length === 0) {
    return text("暂无下载记录。点击下载链接或导航到文件地址会触发下载,自动保存到 <系统下载>/mcode-browser/。");
  }
  const stateLabel: Record<BrowserDownloadEntry["state"], string> = {
    progressing: "下载中",
    completed: "已完成",
    cancelled: "已取消",
    interrupted: "已中断",
  };
  const lines = entries
    .slice(0, 20)
    .map((d) => {
      const size =
        d.totalBytes > 0
          ? `${Math.round(d.receivedBytes / 1024)}/${Math.round(d.totalBytes / 1024)} KB`
          : `${Math.round(d.receivedBytes / 1024)} KB`;
      return `  • [${stateLabel[d.state] ?? d.state}] ${d.filename}(${size})\n    路径: ${d.path}\n    来源: ${d.url || "(未知)"}`;
    });
  return text(`最近的浏览器下载(${entries.length} 条,展示前 ${Math.min(entries.length, 20)} 条):\n\n${lines.join("\n")}`);
}

/**
 * Shared per-tool spec: the tool `description` (surfaced by ALL providers —
 * Pi's `pi.registerTool`, Claude's in-process MCP server and Codex's
 * dynamicTools) and a one-line `promptSnippet` used to build the system-prompt
 * usage section.
 *
 * Single source of truth: before this table existed the descriptions were
 * copy-pasted verbatim in each provider and had already drifted once. When you
 * add/rename a browser tool, update this table (and the implementations
 * above) — never edit a provider copy.
 */
export interface BrowserToolSpec {
  name: string;
  /** Full tool description shown in the providers' tool registries. */
  description: string;
  /** One-line summary for the system-prompt usage section. */
  promptSnippet: string;
}

export const BROWSER_TOOL_SPECS: Record<string, BrowserToolSpec> = {
  browser_list: {
    name: "browser_list",
    description:
      "列出当前所有打开的浏览器视图及其 URL 和标题,返回每个视图的 browserId。省略 browserId 的工具会作用于 agent 当前目标视图(navigate/switch_tab 设置)或第一个已开视图。",
    promptSnippet: "browser_list(): 列出打开的浏览器视图",
  },
  browser_navigate: {
    name: "browser_navigate",
    description:
      "在应用内浏览器中导航到指定 URL(支持 http/https 网页与 file:/// 本地文件,本地文件 Windows 形如 file:///D:/dir/page.html)。若没有打开的浏览器视图会自动创建并显示一个;newTab=true 强制新开一个标签页。" +
      "device 可选——desktop(桌面全宽,默认)/iphone/android(移动端模拟),测试移动端页面时用后两者(仅新建时生效)。导航后需调用 browser_snapshot 读取页面内容。",
    promptSnippet: "browser_navigate({url, device?, newTab?}): 打开网页或 file:/// 本地文件;device 可选 desktop/iphone/android",
  },
  browser_snapshot: {
    name: "browser_snapshot",
    description:
      "读取当前页面的结构化快照:URL、标题、正文,以及可交互元素列表(链接/按钮/输入框等)。" +
      "每个元素带数字索引 [n] 与表单状态(当前值/勾选/禁用/href),索引可直接传给 browser_click / browser_type / browser_select 的 index 参数;列表还标注视口外元素(需先滚动)。只读——这是理解页面内容、定位元素的主要方式。",
    promptSnippet: "browser_snapshot({browserId?}): 读取页面快照,元素带索引与状态(只读)",
  },
  browser_click: {
    name: "browser_click",
    description:
      "点击页面元素:优先传 index(来自最近一次 browser_snapshot 的 [n] 索引),也可传 CSS selector 或 coordinateX/coordinateY 视口坐标。" +
      "以真实鼠标事件点击(自动滚动元素到视口内),悬停菜单/焦点行为与用户点击一致;若目标被遮挡层覆盖会提示实际点到的是什么。返回点击后的 URL/标题,可判断是否触发了导航。有副作用。",
    promptSnippet: "browser_click({index|selector|coordinateX+Y, browserId?}): 点击元素",
  },
  browser_type: {
    name: "browser_type",
    description:
      "向页面输入框填文本(index 或 selector 定位 input/textarea/contenteditable)。对 React/Vue 受控输入框也生效;clear=false 追加而非清空重填,text 传空串可清空字段。" +
      "输入后元素保持聚焦,可接 browser_keys({keys:\"Enter\"}) 提交表单。有副作用。",
    promptSnippet: "browser_type({index|selector, text, clear?, browserId?}): 向输入框填文本",
  },
  browser_keys: {
    name: "browser_keys",
    description:
      "向页面发送一次按键或组合键:Enter / Escape / Tab / ArrowDown / PageDown / Home / End / Backspace / F1-F12 / 单字符,可加修饰键如 Control+a、Shift+Enter、Alt+ArrowLeft。" +
      "走真实输入管线,Enter 能提交表单、Tab 能移动焦点。作用于当前聚焦元素(先 browser_type 聚焦输入框)。一次一个组合键;输入文本请用 browser_type。有副作用。",
    promptSnippet: "browser_keys({keys, browserId?}): 发送按键/组合键(Enter/Escape/Control+a…)",
  },
  browser_scroll: {
    name: "browser_scroll",
    description:
      "滚动页面:direction=up/down,pages 为滚动量(单位=视口高,默认 1,可为 0.5 或 10=到底部);selector 可选,改为滚动某个元素内部的滚动区。" +
      "返回滚动后的位置与剩余距离。长页面读取超出快照正文上限的内容时用它。只读。",
    promptSnippet: "browser_scroll({direction, pages?, selector?, browserId?}): 滚动页面(只读)",
  },
  browser_wait: {
    name: "browser_wait",
    description:
      "等待条件成立再继续:等元素出现(selector)、等文本出现(text)或固定等待(seconds);timeoutSeconds 可选(默认 10,上限 30)。" +
      "导航/点击后内容未就绪时先等待再 snapshot,避免读到空白页。只读。",
    promptSnippet: "browser_wait({selector|text|seconds, timeoutSeconds?, browserId?}): 等待元素/文本出现(只读)",
  },
  browser_history: {
    name: "browser_history",
    description: "浏览器历史导航:action=back(后退)/forward(前进)/reload(刷新),等待页面加载完成后返回。有副作用。",
    promptSnippet: "browser_history({action: back|forward|reload, browserId?}): 后退/前进/刷新",
  },
  browser_select: {
    name: "browser_select",
    description:
      "选择原生 <select> 下拉框的选项(index 或 selector 定位),value 传选项的 value 或精确可见文本。" +
      "没有匹配时返回全部选项列表供重试。自定义(div 模拟的)下拉组件不支持——用 browser_click 展开后点击选项。有副作用。",
    promptSnippet: "browser_select({index|selector, value, browserId?}): 选择原生下拉选项",
  },
  browser_find: {
    name: "browser_find",
    description:
      "页面内查找,比 evaluate 抓 HTML 便宜得多:selector 模式按 CSS 查询元素(可带 attributes=[\"href\",\"src\"] 提取属性,返回的 selector 可直接点击);" +
      "text 模式在页面文本中做字面/正则搜索并返回上下文片段(regex=true 开启正则,cssScope 限定范围,maxResults 限条数)。只读。",
    promptSnippet: "browser_find({selector|text, attributes?, regex?, browserId?}): 查找元素/搜索文本(只读)",
  },
  browser_switch_tab: {
    name: "browser_switch_tab",
    description:
      "把 agent 的目标浏览器视图切换为指定 browserId(用 browser_list 查看全部)。之后省略 browserId 的调用都作用于它。只读定位操作。",
    promptSnippet: "browser_switch_tab({browserId}): 切换 agent 目标标签页",
  },
  browser_close_tab: {
    name: "browser_close_tab",
    description: "关闭指定 browserId 的浏览器视图(销毁该页面的会话)。有破坏性——先确认不是用户正在看的页面。",
    promptSnippet: "browser_close_tab({browserId}): 关闭浏览器标签页",
  },
  browser_upload_file: {
    name: "browser_upload_file",
    description:
      '向页面的 <input type="file"> 设置本地文件(index 或 selector 定位,paths 为路径数组,绝对路径或相对项目根的路径)。' +
      "Chromium 原生设置文件,input/change 事件正常触发(React/Vue 可感知);设置后通常还需点击\"上传/提交\"按钮。" +
      "会把用户文件交给网站——仅在用户明确要求时使用。有副作用,需用户审批。",
    promptSnippet: "browser_upload_file({index|selector, paths, browserId?}): 向文件输入框设置本地文件",
  },
  browser_save_pdf: {
    name: "browser_save_pdf",
    description:
      "把当前页面渲染为 PDF 并保存(整页,等同 Ctrl+P 输出,不弹对话框)。fileName 自定义文件名;paperFormat 可选 letter/legal/tabloid/a3/a4/a5(默认 a4);" +
      "landscape 横向;scale 缩放 0.1-2;printBackground 默认含背景;headerFooter 加页眉页脚。返回保存路径,可用文件工具读取或把路径给用户。只读。",
    promptSnippet: "browser_save_pdf({fileName?, paperFormat?, landscape?, browserId?}): 页面存为 PDF(只读)",
  },
  browser_downloads: {
    name: "browser_downloads",
    description:
      "列出最近的浏览器下载(自动保存到 <系统下载>/mcode-browser/,无保存对话框)。点击下载链接或导航到文件地址触发下载后,调用本工具查看状态;" +
      "状态为已完成时,用 Read/Grep 等文件工具读取下载文件。只读。",
    promptSnippet: "browser_downloads(): 列出最近的下载(只读)",
  },
  browser_evaluate: {
    name: "browser_evaluate",
    description:
      "在页面中执行任意 JavaScript(页面主世界,无 Node/Electron 权限),可修改 DOM 文字/样式/属性、触发事件。" +
      "返回脚本返回值供确认结果。适用于其它 browser_* 工具做不到的页面修改。有副作用,需用户审批。",
    promptSnippet: "browser_evaluate({script, browserId?}): 在页面执行 JS(改 DOM/文字/样式)",
  },
  browser_screenshot: {
    name: "browser_screenshot",
    description:
      "截取当前页面为 PNG,用于视觉确认布局/样式。默认截可视区域;fullPage=true 截整页(含滚动外内容,走 CDP 渲染)。" +
      "只读,截图同时显示给用户和返回给你。",
    promptSnippet: "browser_screenshot({browserId?, fullPage?}): 截图(只读)",
  },
};

/** Shared flow guidance appended to every browser-tools prompt section and to
 *  the Claude MCP server's `instructions`. */
export const BROWSER_TOOLS_FLOW =
  "browserId 参数全部可选——省略时作用于 agent 当前目标视图(navigate/switch_tab 设置)或第一个已开视图。" +
  "典型流程: navigate → (wait 等内容出现) → snapshot 读内容与元素索引 → 按需 type 填表(接 keys:Enter 提交)/ select 选下拉 / upload_file 传附件 / click 点击 / scroll 翻页 / find 精查 / screenshot 截图 / save_pdf 存档;" +
  "页面超出快照正文上限时用 scroll+snapshot 或 find 检索,避免整页抓取;触发下载后用 downloads 查看进度与保存路径。";

/**
 * Build the system-prompt section teaching the browser tools — one promptSnippet
 * line per tool plus the shared flow. Used by the Pi provider's
 * `before_agent_start` injector; compact by design (injected every turn).
 */
export function browserToolsUsagePrompt(): string {
  const lines = [
    `## 浏览器工具(控制应用内浏览器)`,
    `当需要打开网页、查看页面内容、或与网页交互时使用这组工具:`,
    ...Object.values(BROWSER_TOOL_SPECS).map((s) => `- ${s.promptSnippet}`),
    BROWSER_TOOLS_FLOW,
  ];
  return lines.join("\n");
}
