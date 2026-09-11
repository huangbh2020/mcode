/* 交互自检:用 CDP 真的点一遍稿子(导航切页、页签、展开、开关、折叠、搜索过滤、
 * 索引跳转、导航固定、主题与密度),避免"静态渲染没问题、点一下就废"。
 *
 *   node prototypes/settings-redesign/check-interactions.mjs
 *
 * 自己起 Chrome(--headless + 远程调试端口)并在结束时收掉,无第三方依赖
 * (Node ≥ 22 自带全局 WebSocket 与 fetch)。Chrome 不在默认路径时用
 * CHROME=/path/to/chrome 覆盖。
 */
import { spawn } from "node:child_process";
import { rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const PAGE_URL = "file://" + join(here, "..", "settings-redesign.html");
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.CDP_PORT || 9223);
const PROFILE = join(here, ".cdp-profile");

if (!existsSync(CHROME)) {
  console.error(`找不到 Chrome:${CHROME}\n用 CHROME=/path/to/chrome 指定。`);
  process.exit(2);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(
  CHROME,
  ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
   "--window-size=1440,1020", `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, PAGE_URL],
  { stdio: "ignore", detached: false },
);

const cleanup = () => { try { chrome.kill("SIGKILL"); } catch { /* noop */ } try { rmSync(PROFILE, { recursive: true, force: true }); } catch { /* noop */ } };
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(130); });

/* 等调试端口就绪并拿到页面目标 */
let target = null;
for (let i = 0; i < 40 && !target; i++) {
  await wait(250);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    target = list.find((t) => t.type === "page" && t.url.startsWith("file://"));
  } catch { /* 端口还没起来 */ }
}
if (!target) { console.error("Chrome 调试端口未就绪。"); process.exit(2); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) =>
  new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  const ex = r.result?.exceptionDetails;
  return ex ? "EXC: " + (ex.exception?.description || ex.text) : r.result?.result?.value;
};

const results = [];
const check = (name, ok, detail) => results.push([ok ? "✓" : "✗", name, detail]);

/* ── 用例 ───────────────────────────────────────────────── */
await evalJs("location.hash='#a/general'"); await wait(350);
check("初始加载", (await evalJs("document.querySelectorAll('.row').length")) > 10,
  "设置行 " + (await evalJs("document.querySelectorAll('.row').length")));

await evalJs(`document.querySelector('[data-page="plugins"]').click()`); await wait(300);
check("导航切页 → 插件", (await evalJs("document.querySelector('.t-page').textContent")) === "插件");

await evalJs(`[...document.querySelectorAll('[data-tab]')].find(b=>b.dataset.tab==='插件市场').click()`); await wait(300);
check("页签切换(两面板保活)", (await evalJs("JSON.stringify([...document.querySelectorAll('[data-pane]')].map(p=>!p.hidden))")) === "[false,true]");
await evalJs(`[...document.querySelectorAll('[data-tab]')].find(b=>b.dataset.tab==='已安装').click()`); await wait(250);

const dBefore = await evalJs("getComputedStyle(document.querySelectorAll('.plist .ligroup')[1].querySelector('.li-detail')).display");
await evalJs("document.querySelectorAll('.plist .ligroup')[1].querySelector('[data-act=expand]').click()"); await wait(250);
const dAfter = await evalJs("getComputedStyle(document.querySelectorAll('.plist .ligroup')[1].querySelector('.li-detail')).display");
check("展开/收起列表详情", dBefore === "none" && dAfter === "block", `${dBefore} → ${dAfter}`);

const swBefore = await evalJs("document.querySelectorAll('.plist .sw')[3].getAttribute('aria-checked')");
await evalJs("document.querySelectorAll('.plist .sw')[3].click()"); await wait(150);
check("开关可切换", (await evalJs("document.querySelectorAll('.plist .sw')[3].getAttribute('aria-checked')")) !== swBefore);

await evalJs("location.hash='#a/custom-models'"); await wait(350);
await evalJs("document.querySelector('.form .disc .disc-h').click()"); await wait(200);
check("折叠展开(高级选项)", (await evalJs("getComputedStyle(document.querySelector('.form .disc .disc-b')).display")) === "block");
await evalJs(`[...document.querySelectorAll('[data-tab]')].find(b=>b.dataset.tab==='Pi').click()`); await wait(300);
check("页签切换 provider 表单", await evalJs("document.body.innerHTML.includes('openai-completions')"));

await evalJs("location.hash='#c/general'"); await wait(400);
const rowsAll = await evalJs("document.querySelectorAll('.row').length");
await evalJs(`(()=>{const i=document.querySelector('[data-act=topq]');i.value='归档';i.dispatchEvent(new Event('input',{bubbles:true}));})()`); await wait(400);
const rowsHit = await evalJs("[...document.querySelectorAll('.row')].filter(r=>getComputedStyle(r).display!=='none').length");
check("搜索过滤当前页", rowsHit < rowsAll, `${rowsAll} → ${rowsHit} 行可见`);
check("搜索同时过滤导航", (await evalJs("document.querySelectorAll('.snav .ni').length")) === 1);
check("命中高亮", (await evalJs("document.querySelectorAll('mark').length")) > 0);
await evalJs(`(()=>{const i=document.querySelector('[data-act=topq]');i.value='';i.dispatchEvent(new Event('input',{bubbles:true}));})()`); await wait(350);

await evalJs("location.hash='#b/mcp'"); await wait(400);
const sc0 = await evalJs("document.querySelector('.pbody').scrollTop");
await evalJs("document.querySelectorAll('.index [data-anchor]')[3].click()"); await wait(500);
check("索引列跳转分组", (await evalJs("document.querySelector('.pbody').scrollTop")) > sc0, `scrollTop ${sc0} → ${await evalJs("document.querySelector('.pbody').scrollTop")}`);

await evalJs("location.hash='#b/plugins'"); await wait(400);
await evalJs("[...document.querySelectorAll('.index .ii')].find(b=>b.textContent.includes('插件市场')).click()"); await wait(350);
check("索引列切页签", (await evalJs("JSON.stringify([...document.querySelectorAll('[data-pane]')].map(p=>!p.hidden))")) === "[false,true]");

await evalJs("location.hash='#c/general'"); await wait(400);
const railW = await evalJs("document.querySelector('.snav').getBoundingClientRect().width");
await evalJs("document.querySelector('[data-act=navPinned]').click()"); await wait(400);
check("方案 C 导航可固定展开", railW < 70 && (await evalJs("document.querySelector('.snav').getBoundingClientRect().width")) > 200,
  `${railW}px → ${await evalJs("document.querySelector('.snav').getBoundingClientRect().width")}px`);

await evalJs("document.querySelector('[data-tool=theme] button[data-theme=dark]').click()"); await wait(250);
check("深色主题", (await evalJs("document.documentElement.dataset.theme")) === "dark");
await evalJs("document.querySelector('[data-tool=density] button[data-density=compact]').click()"); await wait(250);
check("紧凑密度", (await evalJs("document.documentElement.dataset.density")) === "compact");

/* ── 输出 ───────────────────────────────────────────────── */
const fails = results.filter((r) => r[0] === "✗").length;
for (const [s, n, d] of results) console.log(`${s} ${n}${d ? "  (" + d + ")" : ""}`);
console.log(`\n${results.length - fails}/${results.length} 通过`);
ws.close();
cleanup();
process.exit(fails ? 1 : 0);
