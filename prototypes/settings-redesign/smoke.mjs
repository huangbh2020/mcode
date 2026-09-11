/* 回归自检:把 src/ 拼成模块后,对「全部页面 × 三个方案 × 带查询词」跑一遍渲染,
 * 断言没有 undefined / NaN / 空下拉 / 输出过短。改动 data.js / blocks.js 后先跑它。
 *   node prototypes/settings-redesign/smoke.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
const read = (f) => readFileSync(new URL(`./src/${f}`, import.meta.url), "utf8");
const strip = (c) => c.replace(/^\s*import\s+[^;]*?;\s*$/gm,"").replace(/^\s*import\s+"[^"]*";\s*$/gm,"")
  .replace(/^export\s+(const|let|function|class)\b/gm,"$1").replace(/^export\s*\{[^}]*\};?\s*$/gm,"");
const code = ["icons.js","data.js","primitives.js","blocks.js","render.js"].map((f) => strip(read(f))).join("\n");
const mod = await import("data:text/javascript;base64," + Buffer.from(code + "\nexport { PAGES, renderApp };\n").toString("base64"));
let bad = 0, rows = 0;
for (const plan of ["a","b","c"]) {
  for (const p of mod.PAGES) {
    const st = { plan, pageId: p.id, theme: "light", density: "comfortable", q: "", tab: p.tabs?.[0], closed: {}, navPinned: false };
    let html;
    try { html = mod.renderApp(st); } catch (e) { console.log(`✗ ${plan}/${p.id}: ${e.message}`); bad++; continue; }
    const issues = [];
    if (html.length < 500) issues.push("输出过短");
    for (const pat of ["undefined","NaN","[object Object]"]) if (html.includes(pat)) issues.push(`含 ${pat}`);
    if (/class="sel"[^>]*>\s*<\/div>/.test(html)) issues.push("空下拉");
    rows += (html.match(/class="row/g) || []).length;
    if (issues.length) { console.log(`✗ ${plan}/${p.id}: ${issues.join(", ")}`); bad++; }
    else process.stdout.write(`✓${plan}:${p.id}(${html.length}) `);
  }
  process.stdout.write("\n");
}
/* 带查询词的过滤也要跑一遍 */
for (const plan of ["a","b","c"]) {
  for (const p of mod.PAGES) {
    const st = { plan, pageId: p.id, theme:"dark", density:"compact", q: "归档", tab: p.tabs?.[0], closed:{}, navPinned:false };
    try { mod.renderApp(st); } catch (e) { console.log(`✗ filter ${plan}/${p.id}: ${e.message}`); bad++; }
  }
}
console.log(`\n页面×方案 = ${mod.PAGES.length*3},设置行合计 ${rows},失败 ${bad}`);
