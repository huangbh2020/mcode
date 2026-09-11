/* ============================================================================
 * 交互层:方案 / 页面 / 主题 / 密度 / 搜索的切换,以及稿纸级的设计说明。
 * 纯前端状态,不涉及产品代码。
 * ========================================================================= */
import { PAGES, PAGE_BY_ID, NAV_GROUPS } from "./data.js";
import { renderApp } from "./render.js";

const st = {
  plan: "a",
  pageId: "general",
  theme: "light",
  density: "comfortable",
  q: "",
  tab: undefined,
  closed: {},
  navPinned: false,
};

/* ── 设计说明(随方案切换) ─────────────────────────────── */
const NOTES = {
  a: {
    t: "方案 A · 精修卡片流",
    lead: "信息架构与现在一致,把每一处细节做对:卡片自带头部、行模板统一、变更可追溯。改动最小、风险最低。",
    items: [
      ["分组从「卡外标题 + 卡片」并为「卡片自带头部」", "层级从三层(页面标题 / 分组 / 设置行)降到两层,同样的信息少占约 30px 垂直空间,滚动手感更连贯。"],
      ["一个滚动容器 + 一个固定页头", "页头不再依赖 sticky 与负边距的技巧占位(现实现需要在注释里解释为什么滚动容器不能有 padding-top),分组头也不再需要卡外小标题。"],
      ["行模板统一:标签列 + 控件列", "同一张卡内所有控件共用一条视线;长描述不再把控件挤到第二行;控件宽度按控件的语义给(下拉 240px、开关贴右、路径占满)。"],
      ["开关不再重复写状态词", "「自动归档不活跃会话  [已开启] (开)」—— 开关本身就是状态。状态词只留给描述里真正需要说明的项。"],
      ["改动可追溯", "与默认值不同的行标一个点,hover 出现「恢复默认」;页头显示「本页已改 n 项」并提供「恢复本页默认」。现在用户没有任何办法知道哪些项被改过。"],
      ["系统化落地", "行高、间距、圆角、字号全部来自一套尺度,新增页面不必再发明样式(这正是当前 Skills / 插件 / 模型配置写法各异的根因)。"],
    ],
    cost: "代价:密度基本不变;17 项导航仍然要靠记忆找;宽窗口下 820px 阅读宽度之外仍是空白。",
  },
  b: {
    t: "方案 B · 双栏工作台",
    lead: "把「页面」升级成「工作台」:导航 + 本页索引 + 正文。适合设置项会继续变多的项目,是三个方案里信息密度最高的。",
    items: [
      ["本页索引列(216px)", "列出这一页有哪些分组、各改了几项、各有多少条设置,点击跳转。长页面(模型配置、MCP、Git)不用再靠上下滚动找定位。"],
      ["主从页面的列表搬进索引列", "模型配置与 Skills 现在是「210px 列表 + 详情」两栏,1440 窗口下表单只剩 600 多 px。索引列本来就有空余,合并后详情表单拿回全部宽度。"],
      ["分组头改成 sticky 行,不再画卡片", "只保留发丝线分隔,同样内容高度减少约 25%,观感更接近 IDE/工具而不是网页表单。"],
      ["页头带面包屑与页级动作", "「设置 / 模型配置」+ 本页动作(恢复本页默认、区间预设、页签),页级操作有固定归属。"],
      ["窄窗口自适应", "窗口窄于 1200px 时导航降级为图标轨、索引列收起为下拉,不牺牲正文宽度。"],
    ],
    cost: "代价:两条侧栏合计约 430px;只有一两个分组的页面(如通知)索引列信息量偏低。",
  },
  c: {
    t: "方案 C · 自适应网格 + 全局搜索",
    lead: "用宽度换滚动:导航收成图标轨,正文变成自适应卡片网格,顶部常驻设置搜索。三个方案里「找到某个设置」最快的一个。",
    items: [
      ["58px 图标轨导航", "水平空间还给内容,可随时固定展开。悬停显示名称,分组靠分隔与提示保留。"],
      ["自适应卡片网格", "短分组(字号、缓存、登录状态)在宽窗口并排 2–3 列;长内容(热力图、插件列表、provider 表单、SKILL 编辑器)整行跨列。一屏信息量约翻倍,17 页的总滚动长度明显下降。"],
      ["顶部常驻设置搜索", "输入即过滤:不命中的分组与行直接收起,导航同步过滤,⌘K 聚焦。这是「17 项导航靠记忆」的正解 —— 用户不需要知道「语音识别模型目录」在哪一页。"],
      ["卡片头部带图标与底色", "分组与页面的从属关系更清楚;卡片之间的边界比发丝线更明确,网格排布下不会粘成一片。"],
      ["窄窗口降级", "列数随窗口自适应,1280 以下自动回到单列,等于方案 A 的形态(可以直接拖窄窗口验证)。"],
    ],
    cost: "代价:改动摇杆最大;搜索要见效需要给每条设置补「关键词」字段(i18n 词条现在只有标题与描述);极宽窗口下需要避免卡片被拉得过宽。",
  },
};

const SHARED = {
  t: "三个方案共有的系统层改动",
  lead: "以下这些与布局无关,三个方案都会做 —— 它们是当前设置面板最不一致的地方。",
  items: [
    ["一套原语替掉按页手写的实现", "开关、下拉、路径选择、色板、步进、折叠、徽标、空态、确认弹窗各只有一种写法。现在空态至少三种(虚线框 / 纯文字 / admonition)、折叠三种(高级选项 / LSP 语言行 / 运行时行)、徽标三套(chips / KindBadge / StatusBadge)。"],
    ["破坏性操作统一确认", "runtime 卸载与 LSP 卸载不再用原生 window.confirm(样式不受控、无法说明影响),改走与插件/技能一致的确认弹窗。「卸载 Agent 运行时会让该 Agent 不可用」这类后果要在弹窗里写清楚。"],
    ["保存语义显式区分", "开关 / 下拉 / 色板即改即生效,行内给一次淡淡的「已保存」;只有多字段表单(provider、Skill)才用底部动作条。现在同一个面板里两种模式混用,用户要猜。"],
    ["列表页统一提供过滤", "快捷键、手势、插件、MCP 列表都在页头同一位置放过滤框;插件页的搜索同时匹配组件名(搜 postgres 能命中 MCP server)。"],
    ["状态色只有五档", "中性 / 强调 / 警告 / 危险 / 信息,各有实心与描边两态,尺寸统一 18px。斜体、彩色圆点、大写英文不再混用。"],
    ["键盘可达", "行可聚焦、开关空格切换、折叠 Enter 展开、Esc 退出设置;搜索框与页签遵循标准的 Tab 顺序。"],
  ],
  cost: "",
};

const RECOMMEND = {
  t: "落地建议(我的推荐)",
  lead: "不建议三选一后一步到位。系统层与布局可以分两步走,风险与收益都更可控:",
  items: [
    ["第一步(1–2 天,低风险)", "落「系统层」:原语组件(SettingRow / SettingsSection / Badge / EmptyState / Disclosure / ConfirmDialog / PathField / ListEditor)、变更标记与恢复默认、页头结构。三个方案都会用到,且不改变现有信息架构 —— 做完这一步,A 方案就完成了 80%。"],
    ["第二步(按页面推进)", "把导航 + 本页索引按 B 实现(B 对长页面收益最大,且模型配置/Skills 的重复列表能顺势删掉一层),再按 C 给短分组铺自适应网格与全局搜索。两者不冲突:B 的索引列 + C 的网格可以共存。"],
    ["先不做的", "暂不改信息架构本身(17 个页面的分组是合理的),也不改导航分组的措辞;等接了设置搜索再观察哪些页面几乎没人进,再考虑合并。"],
  ],
  cost: "",
};

/* ── 渲染 ───────────────────────────────────────────────── */
const stage = document.getElementById("stage");
const notesEl = document.getElementById("notes");

/** 深链:#方案/页面(如 #b/plugins),方便直接分享或截图某一页。 */
function readHash() {
  const m = /^#([abc])\/([a-z-]+)(?:\/(dark|light))?$/.exec(location.hash || "");
  if (!m) return;
  if (NOTES[m[1]]) st.plan = m[1];
  if (PAGE_BY_ID[m[2]]) { st.pageId = m[2]; st.tab = undefined; }
  if (m[3]) st.theme = m[3];
}

function writeHash() {
  const h = `#${st.plan}/${st.pageId}${st.theme === "dark" ? "/dark" : ""}`;
  if (location.hash !== h) history.replaceState(null, "", h);
}

function draw() {
  document.documentElement.dataset.plan = st.plan;
  document.documentElement.dataset.theme = st.theme;
  document.documentElement.dataset.density = st.density;
  stage.innerHTML = renderApp(st);
  syncTools();
  writeHash();
}

function syncTools() {
  document.querySelectorAll('[data-tool="plan"] button').forEach((b) => b.setAttribute("aria-selected", b.dataset.plan === st.plan));
  document.querySelectorAll('[data-tool="theme"] button').forEach((b) => b.setAttribute("aria-selected", b.dataset.theme === st.theme));
  document.querySelectorAll('[data-tool="density"] button').forEach((b) => b.setAttribute("aria-selected", b.dataset.density === st.density));
  const sel = document.querySelector('[data-tool="page"]');
  if (sel.value !== st.pageId) sel.value = st.pageId;
  document.querySelector('[data-act="navPinned"]').textContent = st.navPinned ? "收起导航" : "固定导航";
}

function drawNotes() {
  const plan = NOTES[st.plan];
  const cards = [plan, SHARED, RECOMMEND];
  notesEl.innerHTML = `<div class="nb">${cards
    .map(
      (c, i) => `<div class="ncard"${i === 0 ? ' style="flex:1 1 460px;border-color:rgb(var(--accent)/.45)"' : ""}>
        <b>${c.t}</b>
        <p style="margin:0 0 8px">${c.lead}</p>
        <ul class="nl">${c.items.map(([t, d]) => `<li><b>${t}</b><span>${d}</span></li>`).join("")}</ul>
        ${c.cost ? `<p style="margin:8px 0 0;color:rgb(var(--content-subtle))">${c.cost}</p>` : ""}
      </div>`,
    )
    .join("")}</div>`;
}

/* ── 页面下拉 ───────────────────────────────────────────── */
function fillPageSelect() {
  const sel = document.querySelector('[data-tool="page"]');
  sel.innerHTML = NAV_GROUPS.map(
    (g) => `<optgroup label="${g.label}">${g.ids
      .map((id) => `<option value="${id}">${PAGE_BY_ID[id].label}</option>`).join("")}</optgroup>`,
  ).join("");
  sel.value = st.pageId;
}

/* ── 事件 ───────────────────────────────────────────────── */
document.addEventListener("click", (e) => {
  const t = e.target;

  const planBtn = t.closest('[data-tool="plan"] button');
  if (planBtn) { st.plan = planBtn.dataset.plan; st.q = ""; draw(); drawNotes(); return; }

  const thBtn = t.closest('[data-tool="theme"] button');
  if (thBtn) { st.theme = thBtn.dataset.theme; draw(); return; }

  const dBtn = t.closest('[data-tool="density"] button');
  if (dBtn) { st.density = dBtn.dataset.density; draw(); return; }

  if (t.closest('[data-act="navPinned"]')) { st.navPinned = !st.navPinned; draw(); return; }

  /* —— 窗内 —— */
  const ni = t.closest("[data-page]");
  if (ni) { st.pageId = ni.dataset.page; st.q = ""; st.tab = undefined; draw(); return; }

  const gb = t.closest(".grp > b");
  if (gb) { const g = gb.parentElement.dataset.group; st.closed[g] = !st.closed[g]; draw(); return; }

  const tab = t.closest("[data-tab]");
  if (tab) { st.tab = tab.dataset.tab; draw(); return; }

  const anchor = t.closest("[data-anchor]");
  if (anchor) {
    const el = document.getElementById(anchor.dataset.anchor);
    if (el) el.scrollIntoView({ block: "start" });
    document.querySelectorAll(".index .ii").forEach((x) => { if (x.dataset.on !== undefined) x.dataset.on = "false"; });
    anchor.dataset.on = "true";
    return;
  }

  const sw = t.closest(".sw");
  if (sw) {
    sw.setAttribute("aria-checked", sw.getAttribute("aria-checked") === "true" ? "false" : "true");
    return;
  }

  const dh = t.closest(".disc-h");
  if (dh) { const d = dh.parentElement; d.dataset.open = d.dataset.open === "true" ? "false" : "true"; return; }

  const exp = t.closest("[data-act='expand']");
  if (exp) { const g = exp.closest(".ligroup"); if (g) g.dataset.open = g.dataset.open === "true" ? "false" : "true"; return; }

  const mi = t.closest(".mi, .index .ii");
  if (mi) {
    const box = mi.closest(".mlist, .index");
    if (box) box.querySelectorAll(".mi,.ii").forEach((x) => { if (x.dataset.on) x.dataset.on = "false"; });
    mi.dataset.on = "true";
  }
});

document.addEventListener("input", (e) => {
  const f = e.target;
  const act = f.dataset && f.dataset.act;
  if (act === "navq" || act === "topq") {
    st.q = f.value.trim();
    const caret = f.selectionStart;
    draw();
    const next = stage.querySelector(`[data-act="${act}"]`);
    if (next) { next.focus(); try { next.setSelectionRange(caret, caret); } catch { /* noop */ } }
  }
});

document.addEventListener("change", (e) => {
  if (e.target.dataset && e.target.dataset.tool === "page") { st.pageId = e.target.value; st.q = ""; st.tab = undefined; draw(); }
});

document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
  if (e.key === "1" || e.key === "2" || e.key === "3") {
    st.plan = { 1: "a", 2: "b", 3: "c" }[e.key]; st.q = ""; draw(); drawNotes();
  }
  const ids = PAGES.map((p) => p.id);
  const i = ids.indexOf(st.pageId);
  if (e.key === "[") { st.pageId = ids[(i - 1 + ids.length) % ids.length]; st.q = ""; draw(); }
  if (e.key === "]") { st.pageId = ids[(i + 1) % ids.length]; st.q = ""; draw(); }
});

readHash();
fillPageSelect();
draw();
drawNotes();
window.addEventListener("hashchange", () => { readHash(); draw(); drawNotes(); });
