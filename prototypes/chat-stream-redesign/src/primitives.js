/* ============================================================================
 * 原语层:三个方案共用的最小件 —— 转义、mini markdown、状态图标、工具行内件。
 * 差异只在排布方式,原子件刻意做成同一套,保证"同一设计系统"。
 * ========================================================================= */
import { ico } from "./icons.js";

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* ───────────────────────── mini markdown ─────────────────────────
 * 原型只需要渲染 REPLY 里的那几种语法(段落 / 列表 / 围栏代码 / 行内代码 /
 * 粗体),而且要容忍"流式中途"的未闭合围栏,所以手写一个最小实现,不引依赖。 */

export function md(src) {
  const lines = String(src).split("\n");
  const out = [];
  let i = 0;
  let inFence = false;
  let fence = [];
  let list = [];

  const flushList = () => {
    if (!list.length) return;
    out.push(`<ul>${list.map((t) => `<li>${inline(t)}</li>`).join("")}</ul>`);
    list = [];
  };

  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line.trim())) {
      if (!inFence) {
        flushList();
        inFence = true;
        fence = [];
        const lang = line.trim().slice(3).trim();
        if (lang) fence.lang = lang;
      } else {
        out.push(codeBlock(fence.join("\n"), fence.lang));
        inFence = false;
      }
      i++;
      continue;
    }
    if (inFence) {
      fence.push(line);
      i++;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      list.push(line.replace(/^\s*[-*]\s+/, ""));
      i++;
      continue;
    }
    flushList();
    if (line.trim() === "") {
      i++;
      continue;
    }
    out.push(`<p>${inline(line)}</p>`);
    i++;
  }
  // 流式未完:未闭合的围栏先按代码块渲染,避免"内容突然跳格式"。
  if (inFence) out.push(codeBlock(fence.join("\n"), fence.lang));
  flushList();
  return out.join("");
}

const inline = (s) =>
  esc(s)
    .replace(/`([^`]+)`/g, '<code class="ic">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

const codeBlock = (body, lang) => {
  const head = lang
    ? `<div class="cb-h"><span class="cb-lang">${esc(lang)}</span><button class="cb-cp">${ico("copy", 12)}</button></div>`
    : "";
  return `<div class="cb">${head}<pre><code>${esc(body)}</code></pre></div>`;
};

/* ───────────────────────── 原子件 ───────────────────────── */

/** provider 渐变徽标。 */
export const monogram = (txt, cls) => `<span class="mono-av${cls ? " " + cls : ""}">${esc(txt)}</span>`;

/** 状态图标:running 圆弧 / done 对勾 / error 叉。交叉淡换由 CSS 驱动。 */
export const statusGlyph = () =>
  `<span class="st">
     <span class="st-run">${ico("clock", 11)}</span>
     <span class="st-done">${ico("check", 11)}</span>
     <span class="st-err">${ico("x", 11)}</span>
   </span>`;

/** 运行中光标。 */
export const caret = () => `<span class="caret" aria-hidden="true"></span>`;

/** 运行中三个跳动的均衡器条。 */
export const eq = () => `<span class="eq" aria-hidden="true"><i></i><i></i><i></i></span>`;

/** 呼吸圆点。 */
export const liveDot = () => `<span class="live-dot" aria-hidden="true"></span>`;

/** 涨跌统计。 */
export const diffStat = (adds, dels) =>
  `<span class="dst">${adds ? `<b class="up">+${adds}</b>` : ""}${dels ? `<b class="dn">−${dels}</b>` : ""}</span>`;

/** 操作栏按钮。 */
export const actBtn = (icon, label, cls) =>
  `<button class="ab${cls ? " " + cls : ""}" title="${esc(label)}" aria-label="${esc(label)}">${ico(icon, 13)}</button>`;

/** 工具行 —— 三方案的公共内核,排布由外层容器决定。 */
export function toolRow(op, idx, opts) {
  const o = opts || {};
  const created = op.created ? `<span class="tag new">新建</span>` : "";
  const note = op.note ? `<span class="tag note">${esc(op.note)}</span>` : "";
  const right = o.right === "dur" && op.dur ? `<span class="dur">${esc(op.dur)}</span>` : "";
  const showStat = o.stat !== false && (op.adds || op.dels);
  return `<div class="trow" data-op="${idx}" data-status="running" data-on="false">
    <span class="ti">${ico(op.icon, o.iconSize || 13)}</span>
    <span class="tn">${esc(op.name)}</span>
    <span class="tt" title="${esc(op.target)}">${esc(op.target)}</span>
    ${created}${note}
    <span class="tm">${showStat ? diffStat(op.adds, op.dels) : ""}${o.status === false ? "" : statusGlyph()}${right}</span>
  </div>`;
}

/** 思考块(折叠成一行摘要)。 */
export function thinkRow(op, idx, opts) {
  const o = opts || {};
  return `<div class="thinkr" data-op="${idx}" data-on="false">
    <span class="th-i">${ico("think", o.iconSize || 13)}</span>
    <span class="th-t">${esc(op.text)}</span>
  </div>`;
}

/** 过程旁白(模型在工具之间说的话)。 */
export function sayRow(op, idx, opts) {
  const o = opts || {};
  return `<div class="sayr" data-op="${idx}" data-on="false"><span class="sy-b"></span>${esc(op.text)}${
    o.caret ? caret() : ""
  }</div>`;
}

/** 中间过程块的统一分发。 */
export function procBlock(op, idx, opts) {
  if (op.kind === "think") return thinkRow(op, idx, opts);
  if (op.kind === "say") return sayRow(op, idx, opts);
  return toolRow(op, idx, opts);
}
