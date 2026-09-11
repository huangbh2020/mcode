/* ============================================================================
 * 三个方案的回合渲染器。
 *
 * 关键约定(与 app.js 的播放器配合):
 *   - 每个过程块带 data-op="i" data-on="false",播放器按序把 data-on 翻成
 *     "true" —— 元素从 display:none 变为可见会**重新触发**入场动画,所以
 *     "逐个出现"的动效是纯 CSS。
 *   - 回合根节点带 data-phase="running|done";两态差异全部写在
 *     [data-phase="done"] 选择器里,靠 transition 平滑过渡(而不是换 DOM),
 *     这样"跑完那一刻"的折叠/变色/收光是连续的。
 *   - 正文容器带 data-reply,播放器往里注入已渲染的 markdown。
 * ========================================================================= */
import { ico } from "./icons.js";
import { esc, md, monogram, statusGlyph, caret, eq, liveDot, diffStat, actBtn, procBlock } from "./primitives.js";
import { OPS, USER_TEXT, USER_META, HISTORY, TURN_STATS, SESSION } from "./data.js";

/* ───────────────────────── 公共:用户输入 ───────────────────────── */

/** 方案 A:保持现状的右侧气泡,只加圆角方向感与滑入动画。 */
const userBubble = () => `
  <div class="u-row">
    <div class="ubub">
      <div class="ub-t">${esc(USER_TEXT)}</div>
      <div class="ub-f"><span class="tnum">${esc(USER_META.at)}</span></div>
      <div class="ub-acts">${actBtn("copy", "复制")}${actBtn("pencil", "编辑")}</div>
    </div>
  </div>`;

/** 方案 B:指令卡 —— 左侧色条 + 元信息行,内容左对齐成"指令"读法。 */
const userInstr = () => `
  <div class="instr">
    <div class="ins-l">
      <div class="ins-meta">
        <span>指令</span><span class="sep">·</span><span class="tnum">${esc(USER_META.at)}</span>
        <span class="sep">·</span><span class="att">${ico("link", 11)}${esc(USER_META.attach)}</span>
      </div>
      <div class="ins-t">${esc(USER_TEXT)}</div>
    </div>
    <div class="ins-acts">${actBtn("copy", "复制")}${actBtn("pencil", "编辑")}${actBtn("rewind", "回到此处")}</div>
  </div>`;

/** 方案 C:折角指令卡。 */
const userCard = () => `
  <div class="ucard">
    <span class="uc-fold" aria-hidden="true"></span>
    <div class="uc-t">${esc(USER_TEXT)}</div>
    <div class="uc-f">
      <span class="tnum">${esc(USER_META.at)}</span><span class="sep">·</span>
      <span class="att">${ico("link", 11)}1 个附件</span>
      <span class="uc-acts">${actBtn("copy", "复制")}${actBtn("pencil", "编辑")}</span>
    </div>
  </div>`;

/* ───────────────────────── 公共:最终回复正文 ───────────────────────── */

const replyBody = (cls) => `<div class="${cls} md" data-reply></div>`;

/* ═══════════════════════════ 方案 A · 脉络 ═══════════════════════════ */

const A_SUM_LIVE = `
  <span class="ps-live">
    <span class="ps-clock tnum">02:14</span>
    <span class="ps-sep">·</span>
    <span class="ps-dur tnum" data-clock>0.0s</span>
    ${eq()}
    <span class="ps-op" data-ticker>等待模型…</span>
  </span>`;

const A_SUM_DONE = `
  <span class="ps-done">
    <span class="ps-clock tnum">02:14</span>
    <span class="ps-sep">·</span>
    <span class="ps-dur tnum">${esc(TURN_STATS.dur)}</span>
    <span class="ps-sep">·</span>
    <span>${TURN_STATS.steps} 步</span>
    <span class="ps-sep">·</span>
    <span>改 ${TURN_STATS.touched} 个文件</span>
    ${diffStat(TURN_STATS.adds, TURN_STATS.dels)}
  </span>`;

export const turnA = (st) => `
  <section class="turn turn-a" data-phase="running">
    ${userBubble()}
    <div class="a-row">
      <div class="spine" aria-hidden="true">
        <span class="spine-track"></span>
        <span class="spine-fill"></span>
        <span class="spine-ticks"></span>
      </div>
      <div class="a-body">
        <div class="proc" data-open="true">
          <button class="proc-sum">
            <span class="ps-chev">${ico("chevD", 13)}</span>
            ${A_SUM_LIVE}${A_SUM_DONE}
          </button>
          <div class="proc-clip"><div class="pb-in">
            ${OPS.map((op, i) => procBlock(op, i)).join("")}
          </div></div>
        </div>
        <div class="reply">
          <div class="rp-mark"><span class="rp-line"></span><span class="rp-txt">回复</span></div>
          ${replyBody("rp-md")}
        </div>
        <div class="a-acts">${actBtn("copy", "复制")}${actBtn("bookmark", "收藏")}</div>
      </div>
    </div>
  </section>`;

/* ═══════════════════════════ 方案 B · 台账 ═══════════════════════════ */

const B_LROW = (op, i) => {
  if (op.kind === "think" || op.kind === "say") return "";
  const created = op.created ? `<span class="tag new">新建</span>` : "";
  const note = op.note ? `<span class="tag note">${esc(op.note)}</span>` : "";
  return `<div class="lrow" data-op="${i}" data-status="running" data-on="false">
      <span class="lc-ic">${ico(op.icon, 13)}</span>
      <span class="lc-name">${esc(op.name)}</span>
      <span class="lc-tgt" title="${esc(op.target)}">${esc(op.target)}</span>
      <span class="lc-meta">${created}${note}${op.adds || op.dels ? diffStat(op.adds, op.dels) : ""}
        <span class="dur">${esc(op.dur || "")}</span>${statusGlyph()}</span>
      <span class="lc-bar" aria-hidden="true"></span>
    </div>`;
};

/** 台账里非工具的过程(思考 / 旁白)用一行细述呈现,不占列。 */
const B_NOTE = (op, i) => `<div class="lnote" data-op="${i}" data-on="false">
    <span class="ln-i">${ico(op.kind === "think" ? "think" : "arrowR", 11)}</span>
    <span class="ln-t">${esc(op.text)}</span>
  </div>`;

export const turnB = () => `
  <section class="turn turn-b" data-phase="running">
    ${userInstr()}
    <div class="ledger">
      <div class="lg-head">
        <span class="lh-live">${liveDot()}<b>运行中</b><span class="tnum lh-clock" data-clock>0.0s</span>
          <span class="sep">·</span><span class="lh-op" data-ticker>等待模型…</span></span>
        <span class="lh-done">${ico("check", 13)}<b>已完成</b>
          <span class="tnum">${esc(TURN_STATS.dur)}</span><span class="sep">·</span>
          <span>${TURN_STATS.steps} 步</span><span class="sep">·</span>
          <span>改 ${TURN_STATS.touched} 个文件</span>
          ${diffStat(TURN_STATS.adds, TURN_STATS.dels)}
          <span class="sep">·</span><span class="tnum">${esc(TURN_STATS.tokens)} tokens</span></span>
        <span class="lh-count tnum" data-stepcount>0 步</span>
        <button class="lh-toggle" data-toggle-ledger aria-label="展开明细">${ico("chevD", 13)}</button>
      </div>
      <div class="lg-clip"><div class="lg-body">
        ${OPS.map((op, i) => (op.kind === "tool" ? B_LROW(op, i) : B_NOTE(op, i))).join("")}
      </div></div>
      <span class="lg-scan" aria-hidden="true"></span>
    </div>
    <div class="rcard" data-on="false">
      <header class="rc-h">
        ${monogram(SESSION.providerShort, "sm")}
        <div class="rc-hx"><b>${esc(SESSION.model)}</b><span class="rc-sub">Mcode · ${esc(SESSION.clock)}</span></div>
        <span class="rc-badge live">${liveDot()}运行中</span>
        <span class="rc-badge done">${ico("check", 11)}已完成</span>
      </header>
      ${replyBody("rc-b")}
      <footer class="rc-f">
        <button class="fb">${ico("copy", 13)}复制</button>
        <button class="fb">${ico("rewind", 13)}回滚本轮</button>
        <button class="fb">${ico("bookmark", 13)}收藏</button>
        <span class="fb-sp"></span>
        <span class="fb-meta tnum">${esc(TURN_STATS.tokens)} tokens · ${esc(TURN_STATS.dur)}</span>
      </footer>
    </div>
  </section>`;

/* ═══════════════════════════ 方案 C · 卡片流 ═══════════════════════════ */

/** 步骤链:工具折成横向 chip;思考/旁白另起一行低调呈现。
 *  连接线不能复用 data-op(chip 与线都按 OPS 下标标记,querySelector 会命中
 *  排在前面的线,导致后面的 chip 永远不被点亮),所以线用 data-lnk-for。 */
const C_STEPS = () => {
  let out = "";
  let first = true;
  for (let i = 0; i < OPS.length; i++) {
    if (OPS[i].kind !== "tool") continue;
    const op = OPS[i];
    if (!first) out += `<i class="lnk" data-lnk-for="${i}" data-on="false"></i>`;
    out += `<span class="step" data-op="${i}" data-status="running" data-on="false">
        <span class="ch-i">${ico(op.icon, 12)}</span><span class="ch-n">${esc(op.name)}</span>
        <span class="ch-t">${esc(shortTarget(op.target))}</span>
        <span class="ch-live">${ico("check", 10)}</span>
      </span>`;
    first = false;
  }
  return `<div class="steps">${out}<span class="step-more" data-more hidden>… <b>+<span data-more-n>0</span></b></span></div>`;
};

const C_NOTES = () =>
  OPS.map((op, i) =>
    op.kind === "tool"
      ? ""
      : `<div class="cnarr" data-op="${i}" data-on="false">
           <span class="cn-i">${ico(op.kind === "think" ? "think" : "arrowR", 11)}</span>
           <span class="cn-t">${esc(op.text)}</span>
         </div>`,
  ).join("");

export const turnC = () => `
  <section class="turn turn-c" data-phase="running">
    ${userCard()}
    <div class="dcard" data-on="false">
      <header class="dc-h">
        ${monogram(SESSION.providerShort, "lg")}
        <div class="dc-hx"><b>${esc(SESSION.model)}</b><span>Mcode · ${esc(SESSION.clock)}</span></div>
        <span class="dc-badge live">${liveDot()}运行中</span>
        <span class="dc-badge done">${ico("check", 11)}已完成</span>
      </header>
      <div class="dc-proc">
        ${C_STEPS()}
        ${C_NOTES()}
      </div>
      ${replyBody("dc-b")}
      <footer class="dc-f">
        <button class="fb">${ico("copy", 13)}复制</button>
        <button class="fb">${ico("rewind", 13)}回滚本轮</button>
        <button class="fb">${ico("bookmark", 13)}收藏</button>
        <span class="fb-sp"></span>
        <span class="fb-meta tnum" data-clock>0.0s</span>
      </footer>
    </div>
  </section>`;

/** chip 上的目标只显示文件名 —— 路径中段截断("…derer/pages/…")在 chip 里不可读。 */
const shortTarget = (t) => (t.includes("/") ? t.split("/").pop() : t);

/* ═══════════════════════════ 历史回合(已折叠态) ═══════════════════════════ */

const histOps = () =>
  HISTORY.ops
    .map(
      (op, i) => `<div class="trow hrow" data-op="${i}" data-status="done" data-on="true">
        <span class="ti">${ico(op.icon, 13)}</span>
        <span class="tn">${esc(op.name)}</span>
        <span class="tt">${esc(op.target)}</span>
        <span class="tm">${op.adds || op.dels ? diffStat(op.adds, op.dels) : ""}</span>
      </div>`,
    )
    .join("");

const histSummary = (cls) => `
  <button class="${cls}">
    <span class="ps-chev">${ico("chevR", 13)}</span>
    <span class="tnum">02:07</span><span class="sep">·</span>
    <span class="tnum">${esc(HISTORY.dur)}</span><span class="sep">·</span>
    <span>${HISTORY.steps} 步</span><span class="sep">·</span>
    <span>改 ${HISTORY.touched} 个文件</span>
    ${diffStat(HISTORY.adds, HISTORY.dels)}
  </button>`;

const histReply = (cls) => `<div class="${cls} md">${md(HISTORY.reply)}</div>`;

export const historyTurn = (plan) => {
  if (plan === "b") {
    return `<section class="turn turn-b hist" data-phase="done" data-reply-on="true">
      <div class="instr">
        <div class="ins-l">
          <div class="ins-meta"><span>指令</span><span class="sep">·</span><span class="tnum">02:07</span></div>
          <div class="ins-t">${esc(HISTORY.user)}</div>
        </div>
        <div class="ins-acts">${actBtn("copy", "复制")}${actBtn("pencil", "编辑")}</div>
      </div>
      <div class="ledger">
        <div class="lg-head">
          <span class="lh-done">${ico("check", 13)}<b>已完成</b>
            <span class="tnum">${esc(HISTORY.dur)}</span><span class="sep">·</span>
            <span>${HISTORY.steps} 步</span><span class="sep">·</span>
            <span>改 ${HISTORY.touched} 个文件</span>
            ${diffStat(HISTORY.adds, HISTORY.dels)}</span>
          <span class="lh-count tnum">${HISTORY.steps} 步</span>
          <button class="lh-toggle" data-toggle-ledger aria-label="展开明细">${ico("chevD", 13)}</button>
        </div>
        <div class="lg-clip"><div class="lg-body">
          ${HISTORY.ops.map((op, i) => B_LROW(op, i)).join("")}
        </div></div>
      </div>
      <div class="rcard rcard-h">
        <header class="rc-h">
          ${monogram(SESSION.providerShort, "sm")}
          <div class="rc-hx"><b>${esc(SESSION.model)}</b><span class="rc-sub">Mcode · 02:07</span></div>
          <span class="rc-badge done">${ico("check", 11)}已完成</span>
        </header>
        ${histReply("rc-b")}
        <footer class="rc-f">
          <button class="fb">${ico("copy", 13)}复制</button>
          <button class="fb">${ico("rewind", 13)}回滚本轮</button>
          <span class="fb-sp"></span><span class="fb-meta tnum">4.2k tokens · ${esc(HISTORY.dur)}</span>
        </footer>
      </div>
    </section>`;
  }

  if (plan === "c") {
    return `<section class="turn turn-c hist" data-phase="done" data-reply-on="true">
      <div class="ucard">
        <span class="uc-fold" aria-hidden="true"></span>
        <div class="uc-t">${esc(HISTORY.user)}</div>
        <div class="uc-f"><span class="tnum">02:07</span><span class="uc-acts">${actBtn("copy", "复制")}${actBtn("pencil", "编辑")}</span></div>
      </div>
      <div class="dcard">
        <header class="dc-h">
          ${monogram(SESSION.providerShort, "lg")}
          <div class="dc-hx"><b>${esc(SESSION.model)}</b><span>Mcode · 02:07</span></div>
          <span class="dc-badge done">${ico("check", 11)}已完成</span>
        </header>
        <div class="dc-proc">
          <div class="steps">
            ${HISTORY.ops
              .map((op, i) => {
                const chip = `<span class="step" data-status="done" data-on="true">
                    <span class="ch-i">${ico(op.icon, 12)}</span><span class="ch-n">${esc(op.name)}</span>
                    <span class="ch-t">${esc(shortTarget(op.target))}</span></span>`;
                return (i ? `<i class="lnk" data-on="true"></i>` : "") + chip;
              })
              .join("")}
          </div>
        </div>
        ${histReply("dc-b")}
        <footer class="dc-f">
          <button class="fb">${ico("copy", 13)}复制</button>
          <button class="fb">${ico("rewind", 13)}回滚本轮</button>
          <span class="fb-sp"></span><span class="fb-meta tnum">4.2k tokens · ${esc(HISTORY.dur)}</span>
        </footer>
      </div>
    </section>`;
  }

  return `<section class="turn turn-a hist" data-phase="done" data-reply-on="true">
    <div class="u-row">
      <div class="ubub">
        <div class="ub-t">${esc(HISTORY.user)}</div>
        <div class="ub-f"><span class="tnum">02:07</span></div>
        <div class="ub-acts">${actBtn("copy", "复制")}${actBtn("pencil", "编辑")}</div>
      </div>
    </div>
    <div class="a-row">
      <div class="spine" aria-hidden="true">
        <span class="spine-track"></span><span class="spine-fill"></span><span class="spine-ticks"></span>
      </div>
      <div class="a-body">
        <div class="proc" data-open="false">
          ${histSummary("proc-sum")}
          <div class="proc-clip"><div class="pb-in">${histOps()}</div></div>
        </div>
        <div class="reply">
          <div class="rp-mark"><span class="rp-line"></span><span class="rp-txt">回复</span></div>
          ${histReply("rp-md")}
        </div>
        <div class="a-acts">${actBtn("copy", "复制")}${actBtn("bookmark", "收藏")}</div>
      </div>
    </div>
  </section>`;
};

export const currentTurn = (plan) => (plan === "b" ? turnB() : plan === "c" ? turnC() : turnA());
