/* ============================================================================
 * 外壳 + 播放器。
 *
 * 播放器把"一次真实运行"演出来:过程块逐个出现(带入场动画)、运行时钟走字、
 * 台头 ticker 跟随当前操作、正文打字机、结束那一刻的两态过渡(折叠 / 变色 / 收光)。
 *
 * 关键实现选择:**时钟驱动,而不是定时器链**。一次性算好整条时间线,再用 33ms
 * 的 interval 按"已过去多久"反推该露到第几个过程块、正文该打到第几个字。
 * 这样即使标签页被浏览器降频(后台标签的 setTimeout/rAF 会被节流甚至停摆),
 * 下一次 tick 也能立刻追上正确进度,不会卡在半路;滚动/切标签回来仍是对的。
 * ========================================================================= */
import { ico } from "./icons.js";
import { esc, md, caret, liveDot } from "./primitives.js";
import { currentTurn, historyTurn } from "./blocks.js";
import { OPS, REPLY, PLANS, SESSION, TURN_STATS } from "./data.js";

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

const STATE = { plan: "a", theme: "light", density: "comfortable" };

/* ───────────────────────── 时间线 ───────────────────────── */

const TICK_MS = 33;
const LEAD_IN = 320;      // 用户消息落地 → 第一个过程块
const CHAR_MS = 9;        // 打字机速度(每字毫秒)
const REPLY_LEAD = 340;   // 最后一个过程块 → 正文开始
const SETTLE_MS = 760;    // 正文写完 → 收束完成
const GAP = { think: 780, say: 620, tool: 480 };

function timeline() {
  let t = LEAD_IN;
  const opAt = OPS.map((op) => {
    const at = t;
    t += GAP[op.kind] ?? GAP.tool;
    return at;
  });
  const replyStart = t + REPLY_LEAD;
  const replyEnd = replyStart + REPLY.length * CHAR_MS;
  return { opAt, replyStart, replyEnd, end: replyEnd + SETTLE_MS };
}

/* ───────────────────────── 窗口外壳 ───────────────────────── */

const SIDE_SESSIONS = [
  { t: "修弱网下登录页一直转圈", live: true },
  { t: "统一超时错误文案", s: "8 分钟前" },
  { t: "左栏双模式切换后不刷新", s: "1 小时前" },
  { t: "codex 子代理模型回落", s: "昨天" },
];

const SIDE_FILES = [
  { n: "Login.tsx", d: "+24 −6", k: "mod" },
  { n: "withTimeout.ts", d: "新建", k: "new" },
  { n: "auth.ts", d: "", k: "" },
  { n: "sessionStore.ts", d: "", k: "" },
];

const shell = () => `
<div class="win">
  <div class="tbar">
    <span class="tl"></span><span class="tl"></span><span class="tl"></span>
    <span class="tt">${esc(SESSION.project)} — ${esc(SESSION.branch)}</span>
    <span class="tr"><b data-plan-name>${esc(PLANS.a.name)}</b></span>
  </div>
  <div class="shell">
    <aside class="sleft">
      <div class="sl-h"><span class="proj">${ico("folder", 13)}${esc(SESSION.project)}</span>
        <button class="mini" type="button">${ico("plus", 12)}</button></div>
      <div class="sl-list">
        ${SIDE_SESSIONS.map(
          (s) => `<div class="sl-row${s.live ? " on" : ""}">
            <div class="sl-t">${esc(s.t)}</div>
            <div class="sl-s">${s.live ? liveDot() + "运行中" : esc(s.s)}</div>
          </div>`,
        ).join("")}
      </div>
    </aside>
    <main class="chat">
      <header class="chat-h">
        <div class="ch-t">${esc(SESSION.title)}</div>
        <div class="ch-r">
          <span class="chip">${ico("fork", 12)}${esc(SESSION.branch)}</span>
          <span class="chip ghost">${esc(SESSION.provider)} · ${esc(SESSION.model)}</span>
        </div>
      </header>
      <div class="stream" data-stream></div>
      <div class="composer" data-composer>
        <div class="cp-ph">继续输入，或按 <kbd>/</kbd> 使用命令…</div>
        <div class="cp-r">
          <span class="chip ghost">${ico("spark", 12)}Sonnet 4.5</span>
          <span class="chip ghost">默认权限</span>
          <button class="cp-send" type="button" data-send>${ico("send", 14)}</button>
        </div>
      </div>
    </main>
    <aside class="sright">
      <div class="sr-tabs"><button class="on" type="button">本轮</button><button type="button">文件</button><button type="button">Git</button></div>
      <div class="sr-body">
        ${SIDE_FILES.map(
          (f) => `<div class="sr-f"><span class="sr-i">${ico("file", 12)}</span><span class="sr-n">${esc(f.n)}</span>
            <span class="sr-d ${f.k}">${esc(f.d)}</span></div>`,
        ).join("")}
      </div>
    </aside>
  </div>
</div>`;

/* ───────────────────────── 播放器 ───────────────────────── */

let ticker = null;
let t0 = 0;
let tl = null;
let curTurn = null;
let shownOps = 0;
let typed = 0;
let settled = false;

const fmtDur = (ms) => (ms / 1000).toFixed(1) + "s";
const VERB = { Read: "读取", Grep: "检索", Edit: "修改", Write: "写入", Bash: "执行", Glob: "扫描", Task: "派发子代理" };
const setOn = (el, on) => el && el.setAttribute("data-on", on ? "true" : "false");
const opEl = (i) => $('[data-op="' + i + '"]', curTurn);

/** 点亮/熄灭一个过程块;方案 C 的连接线随其后的 chip 一起亮。 */
function setOpOn(i, on) {
  const el = opEl(i);
  if (el) setOn(el, on);
  const lnk = $('[data-lnk-for="' + i + '"]', curTurn);
  if (lnk) setOn(lnk, on);
  return el;
}

const opLabel = (i) => {
  const op = OPS[i];
  if (!op) return "收尾…";
  if (op.kind === "think") return "正在推理…";
  if (op.kind === "say") return "整理结论…";
  return `正在${VERB[op.name] || "执行"} ${op.target.split("/").pop()}`;
};

/** 方案 A 的脊线刻度:按已可见过程块的真实位置打点(直接量,不依赖 rAF)。 */
function markSpine() {
  const ar = $(".a-row", curTurn);
  const ticks = $(".spine-ticks", curTurn);
  if (!ar || !ticks) return;
  const base = ar.getBoundingClientRect().top;
  let lastY = 0;
  $$("[data-op][data-on='true']", ar).forEach((op) => {
    const i = op.getAttribute("data-op");
    if (ticks.querySelector('[data-tick="' + i + '"]')) return;
    const r = op.getBoundingClientRect();
    const y = Math.max(6, r.top - base + Math.min(r.height / 2, 16));
    lastY = Math.max(lastY, y);
    const t = document.createElement("i");
    t.className = "spine-tick";
    t.setAttribute("data-tick", i);
    t.style.top = y + "px";
    ticks.appendChild(t);
  });
  // 最新一个点是"活的";脊线填充跟着长到那里
  const all = $$(".spine-tick", ticks);
  all.forEach((x) => x.classList.remove("is-live"));
  if (!settled && all.length) all[all.length - 1].classList.add("is-live");
  const fill = $(".spine-fill", curTurn);
  if (fill && !settled && lastY) fill.style.height = lastY + "px";
}

/** 把已渲染的 markdown 注入正文,并把光标挂到最深一块文本的尾部。 */
function paintReply(text, live) {
  const el = $("[data-reply]", curTurn);
  if (!el) return;
  el.innerHTML = md(text);
  if (live) {
    let t = el;
    while (t.lastElementChild) t = t.lastElementChild;
    t.insertAdjacentHTML("beforeend", caret());
  }
}

function setCounters() {
  const n = OPS.slice(0, shownOps).filter((o) => o.kind === "tool").length;
  const sc = $("[data-stepcount]", curTurn);
  if (sc) sc.textContent = n + " 步";
}

/** 按"已经过去多久"把画面推到该有的样子(幂等)。 */
function apply(elapsed) {
  // 1) 过程块逐个露出;除最后一个之外都落成 done
  while (shownOps < OPS.length && tl.opAt[shownOps] <= elapsed) {
    const i = shownOps;
    if (i === 0) {
      const d = $(".dcard", curTurn); // 方案 C:文档卡随第一个过程块出现
      if (d) setOn(d, true);
    }
    const prev = opEl(i - 1);
    if (prev) prev.setAttribute("data-status", "done");
    const el = setOpOn(i, true);
    el.setAttribute("data-status", "running");
    shownOps++;
    const tk = $("[data-ticker]", curTurn);
    if (tk) tk.textContent = opLabel(i);
    setCounters();
    markSpine();
  }

  const inReply = elapsed >= tl.replyStart;
  if (inReply && shownOps === OPS.length && !typed) {
    curTurn.setAttribute("data-reply-on", "true"); // 方案 A:回复标线随正文出现
    const last = opEl(OPS.length - 1);
    if (last) last.setAttribute("data-status", "done");
    const rcard = $(".rcard", curTurn); // 方案 B:回复卡随正文出现
    if (rcard) setOn(rcard, true);
    const tk = $("[data-ticker]", curTurn);
    if (tk) tk.textContent = "正在撰写回复…";
  }

  // 2) 正文打字机
  if (inReply) {
    const want = Math.min(REPLY.length, Math.max(0, Math.floor((elapsed - tl.replyStart) / CHAR_MS)));
    if (want !== typed) {
      typed = want;
      paintReply(REPLY.slice(0, want), true);
    }
  }

  // 3) 收束
  if (elapsed >= tl.replyEnd && !settled) finish();
}

function finish() {
  settled = true;
  paintReply(REPLY, false);
  curTurn.setAttribute("data-phase", "done");
  collapseProc();
  $$(".spine-tick", curTurn).forEach((x) => x.classList.remove("is-live"));
  const fill = $(".spine-fill", curTurn);
  const ar = $(".a-row", curTurn);
  if (fill && ar) fill.style.height = ar.clientHeight + "px";
  foldSteps();
  syncComposer(false);
}

/** 收起过程面:A 是折叠的过程脊,B 是台账明细(都收,幂等)。 */
function collapseProc() {
  const proc = $(".proc", curTurn);
  if (proc) proc.setAttribute("data-open", "false");
  const ledger = $(".ledger", curTurn);
  if (ledger) ledger.setAttribute("data-open", "false");
}

/** 方案 C:结束后把超出 4 枚的步骤折成 "… +N"。 */
function foldSteps() {
  const steps = $$(".steps .step[data-op]", curTurn);
  if (steps.length <= 4) return;
  steps.slice(4).forEach((s) => (s.hidden = true));
  $$(".steps .lnk", curTurn).forEach((l, i) => {
    if (i >= 3) l.hidden = true;
  });
  const more = $(".step-more", curTurn);
  if (more) {
    more.hidden = false;
    $("[data-more-n]", more).textContent = String(steps.length - 4);
  }
}

function clockTo(txt) {
  $$("[data-clock]", curTurn).forEach((e) => (e.textContent = txt));
}

export function play() {
  stop();
  const stream = $("[data-stream]");
  if (!stream) return;
  stream.innerHTML = historyTurn(STATE.plan) + currentTurn(STATE.plan);
  curTurn = $(".turn:not(.hist)", stream);
  $("[data-plan-name]").textContent = PLANS[STATE.plan].name;

  tl = timeline();
  shownOps = 0;
  typed = 0;
  settled = false;
  paintReply("", false);
  syncComposer(true);

  t0 = Date.now();
  ticker = setInterval(() => {
    const elapsed = Date.now() - t0;
    clockTo(fmtDur(Math.min(elapsed, tl.replyEnd)));
    apply(elapsed);
    if (elapsed >= tl.end) stop();
  }, TICK_MS);
  apply(0);
}

function stop() {
  if (ticker) clearInterval(ticker);
  ticker = null;
}

/** 定格到某一态(不播动画,用于快速对比排版)。 */
export function jumpTo(phase) {
  stop();
  const stream = $("[data-stream]");
  if (!stream) return;
  stream.innerHTML = historyTurn(STATE.plan) + currentTurn(STATE.plan);
  curTurn = $(".turn:not(.hist)", stream);
  $("[data-plan-name]").textContent = PLANS[STATE.plan].name;
  // 方案 C:文档卡在两个态里都在场,差别只是边框/阴影/徽章
  const dcard = $(".dcard", curTurn);
  if (dcard) setOn(dcard, true);

  const done = phase === "done";
  OPS.forEach((op, i) => {
    const el = setOpOn(i, true);
    if (!el) return;
    el.setAttribute("data-status", !done && i === OPS.length - 1 ? "running" : "done");
  });
  shownOps = OPS.length;
  setCounters();

  if (done) {
    settled = true;
    typed = REPLY.length;
    paintReply(REPLY, false);
    curTurn.setAttribute("data-reply-on", "true");
    const rcard = $(".rcard", curTurn);
    if (rcard) setOn(rcard, true);
    curTurn.setAttribute("data-phase", "done");
    collapseProc();
    markSpine();
    const fill = $(".spine-fill", curTurn);
    const ar = $(".a-row", curTurn);
    if (fill && ar) fill.style.height = ar.clientHeight + "px";
    foldSteps();
    clockTo(TURN_STATS.dur);
    syncComposer(false);
    return;
  }

  // 运行中定格:露出到第 6 个过程块,正文已流了一半,光标还在
  settled = false;
  const upto = 5;
  OPS.forEach((op, i) => setOpOn(i, i <= upto));
  shownOps = upto + 1;
  const el5 = opEl(upto);
  if (el5) el5.setAttribute("data-status", "running");
  const tk = $("[data-ticker]", curTurn);
  if (tk) tk.textContent = opLabel(upto);
  setCounters();
  const d = $(".dcard", curTurn);
  if (d) setOn(d, true);
  const rcard = $(".rcard", curTurn);
  if (rcard) setOn(rcard, true);
  typed = 150;
  curTurn.setAttribute("data-reply-on", "true");
  paintReply(REPLY.slice(0, typed), true);
  markSpine();
  clockTo("4.8s");
  syncComposer(true);
}

const syncComposer = (running) => {
  const cp = $("[data-composer]");
  if (!cp) return;
  cp.setAttribute("data-running", running ? "true" : "false");
  const ph = $(".cp-ph", cp);
  if (ph) ph.innerHTML = running ? "模型运行中… 可以继续追加指令（会排队）" : "继续输入，或按 <kbd>/</kbd> 使用命令…";
};

/* ───────────────────────── 控制条 & 说明 ───────────────────────── */

const bar = () => `
<div class="ctrlbar">
  <div class="cg">
    <label>方案</label>
    <div class="seg" data-tool="plan">
      <button type="button" data-plan="a" aria-selected="true">A · 脉络</button>
      <button type="button" data-plan="b" aria-selected="false">B · 台账</button>
      <button type="button" data-plan="c" aria-selected="false">C · 卡片流</button>
    </div>
  </div>
  <span class="sep"></span>
  <div class="cg">
    <label>状态</label>
    <div class="seg" data-tool="play">
      <button type="button" data-act="play">${ico("spark", 13)} 重播动效</button>
      <button type="button" data-act="run">运行中</button>
      <button type="button" data-act="done">已完成</button>
    </div>
  </div>
  <span class="sep"></span>
  <div class="cg">
    <label>主题</label>
    <div class="seg" data-tool="theme">
      <button type="button" data-theme="light" aria-selected="true">浅色</button>
      <button type="button" data-theme="dark" aria-selected="false">深色</button>
    </div>
  </div>
  <div class="cg">
    <label>密度</label>
    <div class="seg" data-tool="density">
      <button type="button" data-density="comfortable" aria-selected="true">舒适</button>
      <button type="button" data-density="compact" aria-selected="false">紧凑</button>
    </div>
  </div>
  <span class="grow"></span>
  <span class="t-meta">快捷键 1 / 2 / 3 切方案 · 空格重播</span>
</div>`;

function renderNotes() {
  const p = PLANS[STATE.plan];
  $("#notes").innerHTML = `
    <div class="ncard">
      <div class="n-h"><b>${esc(p.name)}</b><span class="badge a">${esc(p.tag)}</span></div>
      <p class="n-lead">${esc(p.lead)}</p>
      <ol class="n-list">
        ${p.points.map(([t, d]) => `<li><b>${esc(t)}</b><span>${esc(d)}</span></li>`).join("")}
      </ol>
    </div>
    <div class="ncard quiet">
      <div class="n-h"><b>三个方案共享的东西</b></div>
      <ul class="n-list">
        <li><b>过程 / 回复的边界不变</b><span>仍然以「最后一个 tool_use」为界：之前的一切是过程，之后的文本是给用户的回复。三个方案只改这件事怎么被看见。</span></li>
        <li><b>动效曲线统一</b><span>位移用 <code>cubic-bezier(.22,1,.36,1)</code>，出场回弹用 <code>cubic-bezier(.34,1.56,.64,1)</code>；入场 320ms、折叠 260ms，逐项错峰 30ms。尊重 <code>prefers-reduced-motion</code>。</span></li>
        <li><b>两态差异全靠属性切换</b><span>所有「结束态」样式写在 <code>[data-phase="done"]</code> 下，靠 transition 过渡而不是换 DOM —— 跑完那一刻是连续收束，不是闪一下。</span></li>
        <li><b>状态语义沿用现有 token</b><span>运行中 = accent，已完成 = 中性 + 对勾，失败 = danger，不引入新色系。</span></li>
        <li><b>播放器是时钟驱动的</b><span>整条时间线一次算好，靠「已过去多久」反推进度；切到后台再回来会自动追上，不会卡在半路。</span></li>
      </ul>
    </div>`;
}

/* ───────────────────────── 绑定 ───────────────────────── */

function bind() {
  document.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    const seg = b.closest("[data-tool]");
    const tool = seg ? seg.getAttribute("data-tool") : null;

    if (tool === "plan") {
      STATE.plan = b.getAttribute("data-plan");
      $$("[data-tool='plan'] button").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
      renderNotes();
      play();
    } else if (tool === "theme") {
      STATE.theme = b.getAttribute("data-theme");
      document.documentElement.setAttribute("data-theme", STATE.theme);
      $$("[data-tool='theme'] button").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    } else if (tool === "density") {
      STATE.density = b.getAttribute("data-density");
      document.documentElement.setAttribute("data-density", STATE.density);
      $$("[data-tool='density'] button").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    } else if (tool === "play") {
      const act = b.getAttribute("data-act");
      if (act === "play") play();
      else jumpTo(act);
    } else if (b.hasAttribute("data-toggle-ledger")) {
      const lg = b.closest(".ledger");
      if (lg) lg.setAttribute("data-open", lg.getAttribute("data-open") === "true" ? "false" : "true");
    } else if (b.hasAttribute("data-send")) {
      play();
    }
  });

  document.addEventListener("keydown", (e) => {
    const plan = { 1: "a", 2: "b", 3: "c" }[e.key];
    if (plan) {
      STATE.plan = plan;
      $$("[data-tool='plan'] button").forEach((x) => x.setAttribute("aria-selected", String(x.getAttribute("data-plan") === plan)));
      renderNotes();
      play();
    } else if (e.code === "Space") {
      e.preventDefault();
      play();
    }
  });
}

/* ───────────────────────── 启动 ───────────────────────── */

export function boot() {
  $("#stage").innerHTML = bar() + shell();
  renderNotes();
  bind();
  play();
}
