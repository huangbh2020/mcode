/* 稿子自检 + 截图:headless Chrome 里逐页 × 四种主题组合渲染一遍,断言:
 *   ① 文本里没有 undefined / NaN / [object Object](模板串拼错最常见的症状)
 *   ② 每页的关键骨架节点存在(页头 / 卡片 / 主从双列…)
 *   ③ 点一遍交互(导航切页、家族页签、供应商切换、折叠、开关、skill 切换、说明)
 * 并把每页每种主题的截图落到 .shots/,方便肉眼评审。
 *
 *   node prototypes/settings-pages-redesign/check.mjs
 *   CHROME=/path/to/chrome node ...   # Chrome 不在默认路径时
 *   SHOT_DIR=/tmp/xxx node ...        # 换截图目录
 *
 * 自起 Chrome + CDP,无第三方依赖(Node ≥ 22 自带 fetch / WebSocket)。
 */
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const PAGE_URL = "file://" + join(here, "..", "settings-pages-redesign.html");
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.CDP_PORT || 9333);
const PROFILE = join(here, ".cdp-profile");
const SHOTS = process.env.SHOT_DIR || join(here, ".shots");
const W = 1440, H = 1400;

if (!existsSync(CHROME)) {
  console.error(`找不到 Chrome:${CHROME}\n用 CHROME=/path/to/chrome 指定。`);
  process.exit(2);
}
mkdirSync(SHOTS, { recursive: true });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check",
  `--window-size=${W},${H}`, `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, PAGE_URL,
], { stdio: "ignore" });

let cleaned = false;
const cleanup = () => {
  if (cleaned) return; cleaned = true;
  try { chrome.kill("SIGKILL"); } catch {}
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}
};
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(130); });

let target = null;
for (let i = 0; i < 50 && !target; i++) {
  await wait(250);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    target = list.find((t) => t.type === "page" && t.url.startsWith("file://"));
  } catch {}
}
if (!target) { console.error("Chrome 调试端口未就绪。"); process.exit(2); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let seq = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) =>
  new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });

await send("Runtime.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });

/** 在页面里求值;异常直接抛出(自检脚本不该静默吞错) */
const evalJs = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text + " :: " + expr);
  return r.result?.result?.value;
};
const shot = async (name) => {
  const r = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(SHOTS, name + ".png"), Buffer.from(r.result.data, "base64"));
};

/* ── 断言池 ───────────────────────────────────────────────────────────── */
const results = [];
const check = (ok, label, detail) => results.push({ ok: !!ok, label, detail: detail || "" });

/* 页面 × 主题矩阵 */
const PAGES = [
  { id: "custom-models", name: "模型配置", must: [".phead", ".rail", ".detail", ".mtable", ".dfoot", ".sseg"] },
  { id: "appearance", name: "外观", must: [".phead", ".card", ".row", ".swatch", ".sseg", ".stepper"] },
  { id: "notifications", name: "通知", must: [".phead", ".card", ".row", ".sw"] },
  { id: "mcp", name: "MCP 服务器", must: [".phead", ".card", ".row", ".badge", ".mono"] },
  { id: "skills", name: "Skills", must: [".phead", ".rail", ".detail", ".code", ".dfoot"] },
];
const THEMES = [
  { theme: "light", style: "classic", name: "浅色-经典" },
  { theme: "dark", style: "classic", name: "深色-经典" },
  { theme: "light", style: "sketch", name: "浅色-手绘纸面" },
  { theme: "dark", style: "sketch", name: "深色-牛皮纸" },
];

for (const p of PAGES) {
  for (const t of THEMES) {
    await evalJs(`state.page=${JSON.stringify(p.id)};state.theme=${JSON.stringify(t.theme)};state.style=${JSON.stringify(t.style)};state.open={adv:false,model:-1};render();`);
    await wait(120);
    const label = `${p.name} · ${t.name}`;
    const txt = await evalJs("document.body.innerText");
    const bad = ["undefined", "NaN", "[object Object]"].filter((s) => txt.includes(s));
    check(bad.length === 0, `${label} · 无渲染垃圾`, bad.join(","));
    const missing = [];
    for (const sel of p.must) {
      const n = await evalJs(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
      if (!n) missing.push(sel);
    }
    check(missing.length === 0, `${label} · 骨架节点齐`, missing.join(","));
    // 页面横向不溢出(设计稿最容易犯的错)
    const overflow = await evalJs("document.documentElement.scrollWidth - document.documentElement.clientWidth");
    check(overflow <= 0, `${label} · 无横向溢出`, "overflow=" + overflow);
    await shot(`${p.id}__${t.theme}-${t.style}`);
  }
}

/* ── 主题兼容:文字阶梯的对比度实测 ─────────────────────────────────────
 * 这是本稿的硬指标之一:四套主题下 desc / 元信息 这一层都要能读。测量结果
 * 计入报告(低于 4.5:1 标 ⚠),因为它衡量的是产品令牌本身,不只是稿子。 */
const measured = [];
for (const t of THEMES) {
  await evalJs(`state.page="notifications";state.theme=${JSON.stringify(t.theme)};state.style=${JSON.stringify(t.style)};render();`);
  await wait(80);
  const r = await evalJs(`(() => {
    const lum = (c) => {
      const p = (c.match(/[\\d.]+/g) || ['0','0','0']).slice(0, 3).map(Number).map((v) => {
        v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
    };
    const ratio = (fg, bg) => { const a = lum(fg), b = lum(bg); const hi = Math.max(a, b), lo = Math.min(a, b); return (hi + 0.05) / (lo + 0.05); };
    const cs = (sel) => getComputedStyle(document.querySelector(sel));
    const bg = cs('.card').backgroundColor;
    return {
      bg,
      title: cs('.rt').color,
      desc: cs('.rd').color,
      titleR: ratio(cs('.rt').color, bg),
      descR: ratio(cs('.rd').color, bg),
    };
  })()`);
  measured.push({ theme: t.name, ...r });
  check(r.titleR >= 7, `${t.name} · 行标题对比度 ≥ 7:1`, `实测 ${r.titleR.toFixed(2)}:1`);
}

/* ── 手绘专属:形状配方真的生效了 ─────────────────────────────────────── */
// 注意必须 dsf=2 下测:1.5px 描边在 dsf=1 会被吸附到 1px,读出来的 computed
// 值就退化成 1px(样式其实是对的,是测量精度问题)。
await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 2, mobile: false });
await evalJs('state.page="custom-models";state.theme="light";state.style="sketch";render();');
await wait(120);
const sketchProbe = await evalJs(`(() => {
  const detail = document.querySelector('.detail');
  const rail = document.querySelector('.rail');
  const inp = document.querySelector('.inp');
  const cs = (el) => getComputedStyle(el);
const rules = Array.from(document.styleSheets[0].cssRules);
const rule = (sel) => { const r = rules.find((x) => x.selectorText === sel); return r ? r.style : null; };
return {
    // 注意:不能用 getComputedStyle 的 borderTopWidth 验 1.5px —— Chromium 把
    // border-width 向下取整到整数 CSS px(实测 1.5→1、2.5→2,dsf=1/2/3 一致),
    // 所以这里读 CSSOM 里的声明值,再用 border-radius 证明选择器确实命中了。
    inkDeclared: (rule('html.sketch .detail') || {}).borderWidth || '',
    inkMatchedRadius: cs(detail).borderTopLeftRadius,
    cardBorder: cs(detail).borderTopWidth,
    cardRadius: cs(detail).borderTopLeftRadius,
    railRadius: cs(rail).borderTopLeftRadius,
    inpRadius: cs(inp).borderTopLeftRadius,
    font: cs(document.body).fontFamily,
    grain: getComputedStyle(document.body, '::after').content !== 'none',
    iconFilter: cs(document.querySelector('.phead svg.i')).filter,
    htmlClass: document.documentElement.className,
    sketchRules: rules.filter((r) => r.selectorText && r.selectorText.indexOf('html.sketch') === 0).length,
  };
})()`);
check(sketchProbe.inkDeclared === "1.5px", "手绘 · 声明了 1.5px 墨线(计算值被引擎取整,见下)",
  `声明=${sketchProbe.inkDeclared} 命中半径=${sketchProbe.inkMatchedRadius} sketch规则=${sketchProbe.sketchRules}`);
check(sketchProbe.cardRadius.includes("95px"), "手绘 · 选择器命中(容器半径=--sk-r-md)", sketchProbe.cardRadius);
check(sketchProbe.railRadius.includes("95px"), "手绘 · 轨=--sk-r-md(95/9)", sketchProbe.railRadius);
check(sketchProbe.inpRadius.includes("30px"), "手绘 · 控件=--sk-r-sm(30/7)", sketchProbe.inpRadius);
check(/Kai|WenKai|楷/.test(sketchProbe.font), "手绘 · 正文字体走手写栈", sketchProbe.font.slice(0, 40));
check(sketchProbe.grain, "手绘 · 纸纹伪元素在", String(sketchProbe.grain));
check(sketchProbe.iconFilter !== "none", "手绘 · 图标挂了抖动滤镜", sketchProbe.iconFilter);
const classicProbe = await evalJs(`(() => { state.style='classic'; render();
  const cs = getComputedStyle(document.querySelector('.detail'));
  return { border: cs.borderTopWidth, radius: cs.borderTopLeftRadius, filter: getComputedStyle(document.querySelector('.phead svg.i')).filter };
})()`);
check(classicProbe.radius === "8px" && classicProbe.filter === "none",
  "经典 · 回到 8px 圆角 / 无滤镜", `${classicProbe.radius} / ${classicProbe.filter}`);
await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });

/* ── 字号:em 派生,改基准整页等比缩放 ────────────────────────────────── */
const fsProbe = await evalJs(`(() => {
  state.style='classic'; state.fs=14; render();
  const a = parseFloat(getComputedStyle(document.querySelector('.flabel')).fontSize);
  const ah = document.querySelector('.inp').getBoundingClientRect().height;
  state.fs=20; render();
  const b = parseFloat(getComputedStyle(document.querySelector('.flabel')).fontSize);
  const bh = document.querySelector('.inp').getBoundingClientRect().height;
  state.fs=14; render();
  return { a, b, ah, bh };
})()`);
check(fsProbe.b > fsProbe.a * 1.3, "字号 · 行标签随基准等比放大", `${fsProbe.a}→${fsProbe.b}`);
check(fsProbe.bh >= fsProbe.ah, "字号 · 控件高度随之增长(无 px 断裂)", `${fsProbe.ah}→${fsProbe.bh}`);

/* ── 交互 ─────────────────────────────────────────────────────────────── */
await evalJs('state.page="custom-models";state.theme="light";state.style="classic";state.family="claude";state.provider="官方中转";render();');
await wait(80);
const clickSel = async (sel) => { const ok = await evalJs(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`); await wait(80); return ok; };

// 家族页签 → Pi 表单(Pi 独有「最大输出」列与展开键)
check(await clickSel('[data-act="family"][data-v="pi"]'), "交互 · 家族页签可点");
let probe = await evalJs('({fam: state.family, head: document.querySelector(".mhead").innerText, cols: getComputedStyle(document.querySelector(".mrow")).gridTemplateColumns})');
check(probe.fam === "pi" && /最大输出/.test(probe.head), "交互 · 切到 Pi 出现「最大输出」列", probe.head.replace(/\n/g, " "));
check(probe.cols.split(" ").length === 4, "交互 · Pi 模型表 4 列", probe.cols);

// 模型行展开
check(await clickSel('.mrow [data-act="mexp"]'), "交互 · Pi 模型行可展开");
probe = await evalJs('({open: state.open.model, exp: !!document.querySelector(".mexp"), map: document.querySelectorAll(".mexp .frow").length})');
check(probe.open === 0 && probe.exp && probe.map >= 4, "交互 · 展开区含思考级别映射", `rows=${probe.map}`);

// 供应商切换 → 详情头跟着变
await clickSel('[data-act="family"][data-v="claude"]');
check(await clickSel('.rail [data-act="prov"][data-v="备用网关"]'), "交互 · 供应商项可点");
probe = await evalJs('({dt: document.querySelector(".dhead .dt").innerText, dm: document.querySelector(".dhead .dm").innerText, on: document.querySelectorAll(".ritem[data-on]").length})');
check(/备用网关/.test(probe.dt), "交互 · 详情头跟随选中供应商", probe.dt.replace(/\n/g, " "));
check(/经本地翻译/.test(probe.dt), "交互 · OpenAI 协议出协议徽标");
check(probe.on === 1, "交互 · 轨内只有一个选中项", String(probe.on));

// 高级选项折叠
check(await clickSel('[data-act="adv"]'), "交互 · 高级选项可展开");
probe = await evalJs('({open: state.open.adv, body: !!document.querySelector(".discbody"), hdr: (document.querySelector(".discbody .inp") || {}).value})');
check(probe.open && probe.body, "交互 · 折叠区渲染");
check(/opencode-session/.test(await evalJs('document.querySelector(".discbody").innerText')), "交互 · 折叠区含自定义请求头");

// 开关
probe = await evalJs('(() => { const b = document.querySelector("[data-act=\\"sw\\"][data-k=\\"telemetry\\"]"); const a0 = b.getAttribute("aria-checked"); b.click(); return { a0, a1: document.querySelector("[data-act=\\"sw\\"][data-k=\\"telemetry\\"]").getAttribute("aria-checked") }; })()');
check(probe.a0 === "false" && probe.a1 === "true", "交互 · 开关状态切换", `${probe.a0}→${probe.a1}`);

// Skills:切换 skill → 头部路径与代码井跟着变
await evalJs('state.page="skills"; state.skill="code-review"; render();');
await wait(80);
const before = await evalJs('({dm: document.querySelector(".dhead .dm").innerText, code: document.querySelector(".code").innerText.length})');
check(await clickSel('.rail [data-act="skill"][data-v="pdf"]'), "交互 · skill 项可点");
const after = await evalJs('({dm: document.querySelector(".dhead .dm").innerText, code: document.querySelector(".code").innerText.length})');
check(/~\/\.mcode\/skills\/pdf/.test(after.dm) && after.dm !== before.dm, "交互 · 全局 skill 路径随之切换", after.dm);
check(after.code > 0 && after.code < before.code, "交互 · 代码井内容随之切换", `${before.code}→${after.code}`);

// 代码井里的 frontmatter 尖括号没有被 HTML 吞掉
probe = await evalJs('(() => { state.skill="code-review"; render(); return document.querySelector(".code").innerText.includes("<path or PR number>"); })()');
check(probe, "交互 · 代码井正确转义尖括号(<path or PR number>)");

// 说明抽屉
check(await clickSel('.tools [data-act="notes"]'), "交互 · 设计说明可开");
probe = await evalJs('({hidden: document.getElementById("notes").classList.contains("hide"), has: /主题硬约束/.test(document.getElementById("notes").innerText)})');
check(!probe.hidden && probe.has, "交互 · 说明内容按页生成(含主题约束)");
await clickSel('.tools [data-act="notes"]');
check(await evalJs('document.getElementById("notes").classList.contains("hide")'), "交互 · 说明可关");

// 未出稿页给的是说明而不是空白
await evalJs('state.page="usage"; render();');
await wait(80);
probe = await evalJs('({empty: !!document.querySelector(".empty"), txt: document.querySelector(".empty").innerText.slice(0, 20), todo: document.querySelectorAll(".nav .todo").length})');
check(probe.empty && probe.todo === 12, "交互 · 未出稿页有占位说明 + 导航标注 12 项", `todo=${probe.todo}`);

// 全部 17 个导航项都能点、都不炸
await evalJs('state.page="custom-models"; render();');
const navIds = await evalJs('Array.from(document.querySelectorAll(".nav .ni")).map(function (b) { return b.dataset.v; })');
let navErr = "";
for (const id of navIds) {
  try { await evalJs(`state.page=${JSON.stringify(id)}; render(); document.body.innerText.length;`); }
  catch (e) { navErr += id + " "; }
}
check(navIds.length === 17 && !navErr, "交互 · 17 个导航项全部可渲染", navErr ? "失败:" + navErr : navIds.length + " 项");

/* ── 收尾:留几张高倍图给肉眼评审 ─────────────────────────────────────── */
await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 2, mobile: false });
for (const [page, theme, style, name] of [
  ["custom-models", "light", "sketch", "zoom-模型配置-纸面"],
  ["custom-models", "dark", "sketch", "zoom-模型配置-牛皮纸"],
  ["custom-models", "dark", "classic", "zoom-模型配置-深色"],
  ["mcp", "light", "sketch", "zoom-MCP-纸面"],
]) {
  await evalJs(`state.page=${JSON.stringify(page)};state.theme=${JSON.stringify(theme)};state.style=${JSON.stringify(style)};state.family="claude";state.provider="官方中转";render();`);
  await wait(140);
  await shot(name);
}

/* ── 报告 ─────────────────────────────────────────────────────────────── */
const fail = results.filter((r) => !r.ok);
for (const r of results) {
  if (!r.ok) console.log(`  FAIL  ${r.label}${r.detail ? "  ← " + r.detail : ""}`);
}
console.log(`\n${results.length - fail.length}/${results.length} 通过${fail.length ? ` · ${fail.length} 失败` : ""}`);

console.log("\n文字阶梯对比度(实测,阈值 4.5:1 为 WCAG AA 正文):");
for (const m of measured) {
  const flag = m.descR >= 4.5 ? "ok  " : "⚠   ";
  console.log(`  ${flag} ${m.theme.padEnd(12)} 标题 ${m.titleR.toFixed(2)}:1   描述/元信息 ${m.descR.toFixed(2)}:1`);
}
const weak = measured.filter((m) => m.descR < 4.5);
if (weak.length) {
  console.log(`  ⚠ ${weak.map((m) => m.theme).join(" / ")} 的 --content-subtle 落在 4.5:1 以下 ——`);
  console.log("    这是产品令牌层面的问题(不是稿子画错):设计说明里已记建议(该主题下把设置面板的");
  console.log("    --content-subtle 降到 --content-muted 那一档,或 desc 层直接改用 content-muted)。");
}
console.log(`截图:${SHOTS}`);
cleanup();
process.exit(fail.length ? 1 : 0);
