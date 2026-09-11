/* ============================================================================
 * 组合层:导航 / 页面头 / 三种布局 / 页体
 * 三个方案共享同一份页体内容与同一套原语,差异只有:导航形态、是否有本页索引、
 * 分组卡片的呈现方式、以及内容宽度策略。
 * ========================================================================= */
import { ico } from "./icons.js";
import { PAGES, PAGE_BY_ID, NAV_GROUPS } from "./data.js";
import { esc, hl, badge, renderSection, secHit, BLOCKS } from "./primitives.js";
import "./blocks.js";

const PAGE_ICON = Object.fromEntries(PAGES.map((p) => [p.id, p.icon]));

export function pageMatches(page, q) {
  if (!q) return true;
  const k = q.toLowerCase();
  if (`${page.label} ${page.desc}`.toLowerCase().includes(k)) return true;
  return (page.sections || []).some((s) => secHit(s, q));
}

/* ───────────────────────── 导航 ───────────────────────── */
export function renderNav(st) {
  const rail = st.plan === "c" && !st.navPinned;
  const items = NAV_GROUPS.map((g) => {
    const vis = g.ids.filter((id) => pageMatches(PAGE_BY_ID[id], st.q));
    if (!vis.length) return "";
    return `<div class="grp" data-closed="${st.closed[g.label] ? "true" : "false"}" data-group="${esc(g.label)}">
      <b><span class="cv">${ico("chevD", 12)}</span><span class="lb">${esc(g.label)}</span></b>
      ${vis
        .map((id) => {
          const p = PAGE_BY_ID[id];
          const chg = (p.sections || []).reduce((n, s) => n + (s.rows || []).filter((r) => r.chg).length, 0);
          return `<button class="ni" data-page="${id}" ${id === st.pageId ? 'aria-current="page"' : ""} title="${esc(p.label)}">
            <span class="ico">${ico(PAGE_ICON[id], rail ? 17 : 16)}</span>
            <span class="lb">${hl(p.label, st.q)}</span>
            ${chg ? `<span class="cnt" title="本页已修改 ${chg} 项">${chg}</span>` : ""}
          </button>`;
        })
        .join("")}
    </div>`;
  }).join("");

  return `<nav class="snav${rail ? " rail" : ""}" style="width:${rail ? 58 : st.plan === "b" ? 212 : 236}px">
    ${rail ? "" : `<div class="nav-search"><div class="ns">${ico("search", 13)}<input class="inp" placeholder="搜索设置…" value="${esc(st.q || "")}" data-act="navq"></div></div>`}
    <div class="nav-in">${items || `<div class="t-desc" style="padding:14px 10px">没有匹配的设置项。</div>`}</div>
    <div class="nav-foot">
      <span class="badge n">v0.9.4</span>
      <span class="lg t-meta">简体中文</span>
      <button class="btn ghost sm icon" style="margin-left:auto" title="${st.navPinned ? "收起导航" : "固定导航"}" data-act="pin">${ico(st.navPinned ? "chevR" : "list", 13)}</button>
    </div>
  </nav>`;
}

/* ───────────────────────── 页面头 ───────────────────────── */
export function renderPageHeader(page, st) {
  const acts = [];
  if (page.ranges) {
    acts.push(`<div class="seg tinted">${page.ranges
      .map((r, i) => `<button aria-selected="${i === 1}">${esc(r)}</button>`).join("")}</div>`);
  }
  if (page.tabs) {
    acts.push(`<div class="seg">${page.tabs
      .map((t, i) => `<button aria-selected="${(st.tab || page.tabs[0]) === t}" data-act="tab" data-tab="${esc(t)}">${esc(t)}
        ${page.id === "plugins" ? `<span class="num">${i ? 292 : 4}</span>` : i === 0 ? `<span class="num">2</span>` : i === 1 ? `<span class="num">1</span>` : `<span class="num">3</span>`}</button>`)
      .join("")}</div>`);
  }
  if (page.kind === "kbd" || page.kind === "gest") {
    acts.push(`<div class="ts" style="width:200px">${ico("search", 13)}<input class="inp" placeholder="搜索命令…"></div>`);
  }
  if (page.headerAction === "resetAll") acts.push(`<button class="btn ghost sm">${ico("refresh", 13)} 恢复全部默认</button>`);
  if (page.headerAction === "refreshProbe") acts.push(`<button class="btn sm">${ico("refresh", 13)} 重新探测</button>`);

  const changed = (page.sections || []).reduce((n, s) => n + (s.rows || []).filter((r) => r.chg).length, 0);
  if (changed) {
    acts.unshift(`<span class="badge a">${ico("check", 11)} 本页已改 ${changed} 项</span>
      <button class="btn ghost sm">恢复本页默认</button>`);
  }

  const showIcon = st.plan !== "c";
  return `<header class="phead">
    ${showIcon ? `<span class="ico-page">${ico(page.icon, 17)}</span>` : ""}
    <div class="pt">
      <div class="t-page">${esc(page.label)}</div>
      <div class="t-desc">${hl(page.desc, st.q)}</div>
    </div>
    <div class="pacts">${acts.join("")}</div>
  </header>`;
}

/* ───────────────────────── 方案 C 顶栏 ───────────────────────── */
function renderCTop(page, st) {
  return `<div class="ctop">
    <span class="ico-page">${ico(page.icon, 17)}</span>
    <div class="pt" style="display:flex;flex-direction:column;gap:2px;min-width:0">
      <div class="t-page">${esc(page.label)}</div>
      <div class="t-desc">${esc(page.desc)}</div>
    </div>
    <div class="bigsearch">${ico("search", 15)}
      <input class="inp" placeholder="搜索设置项…(试试「归档」「超时」「token」)" value="${esc(st.q || "")}" data-act="topq">
      <span class="kbd">⌘K</span>
    </div>
    <div class="pacts">${page.ranges ? `<div class="seg tinted">${page.ranges.map((r, i) => `<button aria-selected="${i === 1}">${esc(r)}</button>`).join("")}</div>` : ""}
      ${page.tabs ? `<div class="seg">${page.tabs.map((t, i) => `<button aria-selected="${(st.tab || page.tabs[0]) === t}" data-act="tab" data-tab="${esc(t)}">${esc(t)} <span class="num">${page.id === "plugins" ? (i ? 292 : 4) : i === 0 ? 2 : i === 1 ? 1 : 3}</span></button>`).join("")}</div>` : ""}
      ${page.headerAction === "resetAll" ? `<button class="btn ghost sm">${ico("refresh", 13)} 恢复全部默认</button>` : ""}
    </div>
  </div>`;
}

/* ───────────────────────── 方案 B 本页索引 ───────────────────────── */
function renderIndex(page, st) {
  if (page.kind === "split") {
    const tab = st.tab || page.tabs?.[0] || "";
    const list = page.entities[tab] || [];
    return `<aside class="index">
      <div class="ih">${esc(page.masterTitle || page.label)}</div>
      <div class="il">
        ${list.map((e, i) => `<button class="ii" data-on="${i === 0}"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(e.t)}</span></button>`).join("")}
        <button class="ii" style="color:rgb(var(--accent-strong))">${ico("plus", 13)} ${esc(page.entityAddLabel[tab])}</button>
      </div>
      <div class="if"><button class="btn sm" style="width:100%">${ico("plus", 13)} 新增</button></div>
    </aside>`;
  }
  const secs = (page.sections || []).filter((s) => s.t);
  const total = secs.reduce((n, s) => n + (s.rows || []).length, 0);
  /* 页签页(插件)的索引列直接切页签,其余页面点击滚动定位 —— 索引项永远是活的 */
  const isTabs = !!page.tabs && secs.length === page.tabs.length;
  const active = isTabs ? Math.max(0, page.tabs.indexOf(st.tab || page.tabs[0])) : 0;
  return `<aside class="index">
    <div class="ih">${isTabs ? "视图" : "本页目录"}</div>
    <div class="il">
      ${secs
        .map((s, i) => {
          const chg = (s.rows || []).filter((r) => r.chg).length;
          return `<button class="ii" data-on="${i === active}" ${isTabs ? `data-tab="${esc(page.tabs[i])}"` : `data-anchor="sec-${i}"`}>
            <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(isTabs ? page.tabs[i] : s.t)}</span>
            ${chg ? `<span class="im" style="color:rgb(var(--accent-strong))">${chg}</span>` : s.rows ? `<span class="im">${s.rows.length}</span>` : ""}
          </button>`;
        })
        .join("")}
    </div>
    <div class="if"><span class="t-meta">${secs.length} 个${isTabs ? "视图" : "分组"}${total ? ` · ${total} 项设置` : ""}</span></div>
  </aside>`;
}

/* ───────────────────────── 页体 ───────────────────────── */
function renderBody(page, st) {
  if (page.render && page.kind !== "split") return `<div class="wrap">${BLOCKS[page.render]({ t: page.label, d: page.desc }, page, st.plan, st)}</div>`;

  if (page.kind === "split") {
    const html = BLOCKS[page.render]({ t: page.label, d: page.desc }, page, st.plan, st);
    return st.plan === "c" ? `<div class="wrap"><div class="splitwrap">${html}</div></div>` : `<div class="wrap wide">${html}</div>`;
  }

  const secs = page.sections || [];
  const activeTab = page.tabs ? Math.max(0, page.tabs.indexOf(st.tab || page.tabs[0])) : -1;
  /* 页签内容两个都渲染、非活动的用 hidden 保活 —— 与产品一致:切回来时
     搜索词、过滤、展开中的行都还在,不会因为切了一次页签就重置。 */
  const inner = secs
    .map((s, i) => {
      const html = renderSection(s, page, st.plan, st, i);
      if (activeTab < 0 || secs.length !== page.tabs.length) return html;
      return `<div data-pane="${i}"${i === activeTab ? "" : " hidden"}>${html}</div>`;
    })
    .join("");
  const note = page.note ? `<div class="snote">${ico("info", 13)}<span class="t-desc">${esc(page.note)}</span></div>` : "";
  const hit = st.q ? secs.filter((s) => secHit(s, st.q)).length : 0;
  const hint = st.q ? `<div class="t-meta" style="margin-bottom:2px">${hit} 个分组匹配「${esc(st.q)}」</div>` : "";
  return `<div class="wrap">${hint}${inner}${note}</div>`;
}

/* ───────────────────────── 整窗 ───────────────────────── */
export function renderApp(st) {
  const page = PAGE_BY_ID[st.pageId];
  return `<div class="win">
    <div class="tbar">
      <span class="tl"></span><span class="tl"></span><span class="tl"></span>
      <span class="tt">Mcode — 设置</span>
      <span class="tr"><span>${st.plan === "a" ? "方案 A · 精修卡片流" : st.plan === "b" ? "方案 B · 双栏工作台" : "方案 C · 自适应网格"}</span></span>
    </div>
    <div class="shell">
      ${renderNav(st)}
      ${st.plan === "b" ? renderIndex(page, st) : ""}
      <div class="main"><div class="col">
        ${st.plan === "c" ? renderCTop(page, st) : renderPageHeader(page, st)}
        <div class="pbody">${renderBody(page, st)}</div>
      </div></div>
    </div>
  </div>`;
}
