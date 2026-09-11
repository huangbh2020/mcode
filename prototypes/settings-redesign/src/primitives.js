/* ============================================================================
 * 原语层:设置行 / 分组卡 / 小控件。三个方案共用同一套原语 —— 差异只在布局,
 * 这正是"统一设计风格"的落点。
 * ========================================================================= */
import { ico } from "./icons.js";

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** 搜索命中高亮(仅当有查询词)。 */
export function hl(text, q) {
  const s = esc(text);
  if (!q) return s;
  const i = String(text).toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return s;
  const raw = String(text);
  return esc(raw.slice(0, i)) + "<mark>" + esc(raw.slice(i, i + q.length)) + "</mark>" + esc(raw.slice(i + q.length));
}

/** 一行是否被查询命中(标题 + 描述)。 */
export const rowHit = (r, q) => !q || `${r.t || ""} ${r.d || ""} ${r.v || ""}`.toLowerCase().includes(q.toLowerCase());

export const badge = (kind, text, dot) =>
  `<span class="badge ${kind}">${dot ? '<i class="bdot"></i>' : ""}${esc(text)}</span>`;

const resetBtn = () => `<button class="btn ghost sm icon rst" title="恢复默认">${ico("refresh", 13)}</button>`;

/* ───────────────────────── 行控件 ───────────────────────── */

const CTRL = {
  sw: (r) =>
    `<button class="sw" role="switch" aria-checked="${r.v ? "true" : "false"}" aria-label="${esc(r.t)}"></button>`,

  sel: (r, plan, st) =>
    `<div class="sel${r.wide ? " wide" : r.sm ? " sm" : ""}" style="${r.wide ? "width:100%" : r.w ? `width:${r.w}px` : ""}">${hl(r.v, st.q)}</div>`,

  num: (r) => `<input class="inp num" value="${esc(r.v)}" style="width:92px;text-align:right">
    <span class="t-meta">${esc(r.unit || "")}</span>`,

  inp: (r) => `<input class="inp${r.mono ? " mono" : ""} grow" value="${esc(r.v)}" placeholder="${esc(r.ph || "")}">`,

  ta: (r) => `<textarea class="ta${r.mono ? " mono" : ""}" rows="${r.rows || 4}">${esc(r.v)}</textarea>`,

  pal: (r) => `
    <div class="sw-row">
      ${r.opts
        .map(
          (c, i) =>
            `<button class="sw-dot" aria-pressed="${r.cur === i}" title="${esc(r.names[i])}" style="background:${c}"></button>`,
        )
        .join("")}
      <button class="sw-dot" title="自定义颜色" style="background:conic-gradient(#ef4444,#eab308,#22c55e,#06b6d4,#6366f1,#ec4899,#ef4444)"></button>
      <span class="t-meta" style="margin-left:2px">${esc(r.v)}</span>
      <button class="btn ghost sm" ${r.cur === -1 ? "disabled" : ""}>${ico("refresh", 13)} 恢复默认</button>
    </div>`,

  step: (r) => `
    <div class="stepper">
      <button title="减小">−</button>
      <span class="num">${esc(r.v)}</span>
      <button title="增大">＋</button>
    </div>`,

  path: (r) => `
    <div class="row-c" style="width:100%">
      <div class="pathv grow">${ico("folder", 14)}<span class="mono">${esc(r.v || r.empty || "")}</span></div>
      ${(r.actions || []).map((a, i) => `<button class="btn${i === (r.actions.length - 1) && i > 0 ? " primary" : ""} sm">${esc(a)}</button>`).join("")}
      ${r.reset ? resetBtn() : ""}
    </div>`,

  btns: (r) => `
    <div class="row-c">
      ${(r.btns || []).map((b) => `<button class="btn ${b.kind || ""} sm">${esc(b.lbl)}</button>`).join("")}
      ${r.result ? badge(r.result.kind, r.result.text, true) : ""}
    </div>`,

  kbd: (r, plan, st) => {
    if (r.state === "conflict")
      return `<span class="t-desc" style="color:rgb(var(--warning))">已被「${esc(r.conflict)}」占用</span>
        <button class="btn sm">取消</button><button class="btn primary sm">${ico("check", 12)} 覆盖</button>`;
    const keys = r.keys && r.keys.length
      ? r.keys.map((k) => `<span class="kbd${r.state === "override" ? " on" : ""}">${esc(k)}</span>`).join("")
      : `<span class="t-desc">未绑定</span>`;
    return `${keys}
      <button class="btn sm">${r.state === "recording" ? "按下组合键…" : "修改"}</button>
      ${r.state === "override" ? `<button class="btn ghost sm icon rst" title="恢复默认">${ico("refresh", 13)}</button>` : ""}`;
  },

  gest: (r) => {
    const arrows = { D: "↓", U: "↑", L: "←", R: "→" };
    const seq = r.seq && r.seq.length
      ? `<span class="gseq"${r.state === "recording" ? ' data-rec="true"' : ""}>${r.seq.map((s) => arrows[s]).join("")}</span>`
      : `<span class="t-desc">未绑定</span>`;
    return `${seq}<button class="btn sm">${r.state === "recording" ? "画出手势…" : "修改"}</button>
      ${r.seq && r.seq.length ? `<button class="btn ghost sm icon rst" title="恢复默认">${ico("refresh", 13)}</button>` : ""}`;
  },
};

/** 单行。plan 决定布局细节;st 携带查询词等交互态。 */
export function renderRow(r, plan, st) {
  if (r.k === "custom") return BLOCK_ROWS[r.key] ? BLOCK_ROWS[r.key](r, plan, st) : "";

  const stack = r.stack || r.k === "pal" || r.k === "ta" || r.k === "inp" || r.k === "path" || r.k === "btns";
  const cls = ["row", stack ? "stack" : "", r.chg ? "chg" : "", r.sub ? "dsub" : ""].filter(Boolean).join(" ");
  const fn = CTRL[r.k] || (() => "");
  const desc = r.d ? `<div class="t-desc row-d">${hl(r.d, st.q)}</div>` : "";
  const extra = r.note ? `<div class="t-meta" style="margin-top:4px">${ico("info", 12)} ${esc(r.note)}</div>` : "";
  const saved = r.saved ? `<div class="saved">${ico("check", 12)} ${esc(r.saved)}</div>` : "";
  const rst = r.chg && r.k !== "kbd" && r.k !== "gest" ? resetBtn() : "";

  return `<div class="${cls}" data-hit="${rowHit(r, st.q) ? "true" : "false"}">
    <div class="row-l">
      <div class="row-t"><span class="t-row">${hl(r.t, st.q)}</span>${r.tag ? badge("o", r.tag) : ""}</div>
      ${desc}${extra}${saved}
    </div>
    <div class="row-c">${rst}${fn(r, plan, st)}</div>
  </div>`;
}

/* ───────────────────────── 分组卡 ───────────────────────── */

export function renderSectionBodies(sec, page, plan, st) {
  const rows = (sec.rows || []).map((r) => renderRow(r, plan, st)).join("");
  const rich = sec.render ? BLOCKS[sec.render](sec, page, plan, st) : "";
  const sub = sec.sub ? BLOCK_ROWS[sec.sub.key](sec.sub, plan, st) : "";
  const note = sec.note ? `<div class="snote">${ico("info", 13)}<span class="t-desc">${esc(sec.note)}</span></div>` : "";
  return `<div class="rows">${rows}${rich}${sub}</div>${note}`;
}

const chgCount = (sec) => (sec.rows || []).filter((r) => r.chg).length;
const metaFor = (sec) => {
  const n = chgCount(sec);
  return n ? badge("a", `已改 ${n}`) : "";
};

/** 一个功能分组。三种壳:方案 A 卡片头 / 方案 B 粘性组头 + 面板 / 方案 C 紧凑卡头。 */
export function renderSection(sec, page, plan, st, idx) {
  if (!sec.t) return `<div class="bare">${renderSectionBodies(sec, page, plan, st)}</div>`;
  const bodies = renderSectionBodies(sec, page, plan, st);
  const icon = sec.icon ? ico(sec.icon, plan === "c" ? 14 : 15) : "";
  const anchor = idx === undefined ? "" : ` id="sec-${idx}"`;

  if (plan === "b") {
    return `<section${anchor} data-hit="${secHit(sec, st.q) ? "true" : "false"}">
      <div class="sec-h">
        <span class="ct">${hl(sec.t, st.q)}</span>
        ${sec.d ? `<span class="cd">${hl(sec.d, st.q)}</span>` : ""}
        <span class="cm">${metaFor(sec)}</span>
      </div>
      <div class="sec-b">${bodies}</div>
    </section>`;
  }

  const head = plan === "c"
    ? `<div class="ch">
        ${icon ? `<div class="ci">${icon}</div>` : ""}
        <div class="ct"><div class="t-card">${hl(sec.t, st.q)}</div>
          ${sec.d ? `<div class="t-desc cd">${hl(sec.d, st.q)}</div>` : ""}</div>
        <div class="cm">${metaFor(sec)}</div>
      </div>`
    : `<div class="ch">
        ${icon ? `<div class="ci">${icon}</div>` : ""}
        <div class="ct"><div class="t-card">${hl(sec.t, st.q)}</div>
          ${sec.d ? `<div class="t-desc">${hl(sec.d, st.q)}</div>` : ""}</div>
        <div class="cm">${metaFor(sec)}</div>
      </div>`;

  const span = sec.render || (sec.rows || []).length >= 6 ? " full" : "";
  return `<section${anchor} class="card${span}" data-hit="${secHit(sec, st.q) ? "true" : "false"}">${head}${bodies}</section>`;
}

export const secHit = (sec, q) =>
  !q || `${sec.t} ${sec.d || ""} ${(sec.rows || []).map((r) => `${r.t} ${r.d || ""}`).join(" ")}`.toLowerCase().includes(q.toLowerCase());

/* 富内容渲染器在两处注册:整段(sec.render)与行内(row.k==='custom') */
export const BLOCKS = {};
export const BLOCK_ROWS = {};
export const register = (key, fn) => { BLOCKS[key] = fn; };
export const registerRow = (key, fn) => { BLOCK_ROWS[key] = fn; };

/* 通用小组件 */
export const liRow = (o) => `
  <div class="li">
    ${o.av ? `<div class="av${o.on ? " on" : ""}">${esc(o.av)}</div>` : ""}
    <div class="lx">
      <div class="l1">${o.l1}</div>
      ${o.l2 ? `<div class="l2">${o.l2}</div>` : ""}
    </div>
    ${o.actions ? `<div class="la">${o.actions}</div>` : ""}
  </div>`;

export const codeRow = (o) => `
  <div class="li">
    <div class="lx">
      <div class="l1"><span class="mono" style="font-size:.929em;font-weight:600">${esc(o.name)}</span>${o.tag || ""}</div>
      <div class="l2 mono">${esc(o.detail)}</div>
    </div>
    <div class="la">${o.actions || ""}</div>
  </div>`;

export const disc = (summary, body, open) => `
  <div class="disc" data-open="${open ? "true" : "false"}">
    <div class="disc-h">${summary}</div>
    <div class="disc-b">${body}</div>
  </div>`;
