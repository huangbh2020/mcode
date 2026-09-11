/* ============================================================================
 * 富页面块 —— 无法用通用行表达的部分(主从列表、图表、安装卡、编辑器…)
 * 每个块在 3 个方案下共用同一份内容,只按 plan 调整密度/宽度。
 * ========================================================================= */
import { ico } from "./icons.js";
import { esc, badge, register, registerRow, liRow, codeRow, disc } from "./primitives.js";

const mono = (s) => `<span class="mono">${esc(s)}</span>`;
const chev = (open) => `<span class="cv">${ico("chevR", 14)}</span>`;
const secret = (v) => `
  <div class="scrt"><input class="inp mono grow" value="${esc(v)}" type="password">
    <button class="btn ghost sm icon" title="显示明文">${ico("eye", 14)}</button></div>`;

/* ── 行内块 ───────────────────────────────────────────────── */

registerRow("editorSchemeDark", (r) => schemeRow(r, ["#1a1d24", "#c586c0", "#ce9178", "#b5cea8"], ["Mcode 深色(默认)", "One Dark", "Monokai", "Solarized Dark"]));
registerRow("editorSchemeLight", (r) => schemeRow(r, ["#ffffff", "#7c3aed", "#047857", "#b45309"], ["Mcode 浅色(默认)", "Solarized Light", "GitHub Light"]));

function schemeRow(r, colors, opts) {
  return `<div class="row">
    <div class="row-l"><div class="row-t"><span class="t-row">${esc(r.t)}</span></div>
      ${r.d ? `<div class="t-desc row-d">${esc(r.d)}</div>` : ""}</div>
    <div class="row-c"><div class="sel" style="width:230px">
      <span class="swx" style="background:${colors[0]}"><i style="background:${colors[1]}"></i><i style="background:${colors[2]}"></i><i style="background:${colors[3]}"></i></span>
      ${esc(r.v)}</div></div></div>`;
}

registerRow("gesturePad", () => `
  <div class="row stack">
    <div class="row-l"><div class="row-t"><span class="t-row">手势预览</span>${badge("n", "演示")}</div>
      <div class="t-desc row-d">按住触发键画出箭头序列,松手即执行。方向容差为主方向 ±30°,斜向需要明确拐弯。</div></div>
    <div class="pad">
      <svg width="260" height="70" viewBox="0 0 260 70" fill="none">
        <polyline points="40,14 40,44 92,44" stroke="rgb(5 150 105)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" opacity=".85"/>
        <circle cx="40" cy="14" r="4.5" fill="rgb(5 150 105)"/>
        <circle cx="92" cy="44" r="4.5" fill="rgb(5 150 105)" opacity=".45"/>
        <text x="104" y="49" fill="rgb(113 113 122)" font-size="12" font-family="system-ui">↓→ 关闭当前会话</text>
        <path d="M180 20 L206 20 M180 44 L200 44" stroke="rgb(113 113 122)" stroke-width="2" stroke-linecap="round" opacity=".35"/>
        <text x="214" y="24" fill="rgb(113 113 122)" font-size="11" font-family="system-ui">← → ↑ ↓</text>
        <text x="214" y="48" fill="rgb(113 113 122)" font-size="11" font-family="system-ui">8 方向</text>
      </svg>
      <span class="hintp">实时徽章会跟随指针显示当前序列与命令名</span>
    </div>
  </div>`);

registerRow("notifyTest", () => `
  <div class="row dsub">
    <div class="row-l"><div class="row-t"><span class="t-row">测试通知</span></div>
      <div class="t-desc row-d">发送一条示例通知,用来确认系统权限与展示样式。</div></div>
    <div class="row-c"><button class="btn sm">${ico("bell", 13)} 发送测试通知</button></div>
  </div>`);

registerRow("cmdList", () => `
  <div class="sub">
    <div class="cmd-h"><span class="t-row">命令列表 <span class="badge n">2</span></span>
      <button class="btn ghost sm">${ico("plus", 13)} 添加命令</button></div>
    <ul class="cmds">
      ${[["启动开发", "pnpm dev"], ["运行类型检查", "npx tsc --noEmit -p tsconfig.json"]]
        .map(
          ([n, c]) => `<li class="cmd">
            <span class="cn">${esc(n)}</span><span class="cc mono">${esc(c)}</span>
            <span class="ca"><button class="btn ghost sm icon" title="编辑">${ico("pencil", 13)}</button>
            <button class="btn ghost sm icon" title="删除">${ico("trash", 13)}</button></span></li>`,
        )
        .join("")}
    </ul>
  </div>`);

/* ── 语音模型 ─────────────────────────────────────────────── */
register("voiceModels", () => {
  const rows = [
    { n: "中文 · 小型(约 40 MB)", st: "已下载 · 当前使用", act: `<span class="badge a">${ico("check", 11)} 当前使用</span><button class="btn ghost sm icon" title="删除">${ico("trash", 13)}</button>` },
    { n: "中文 · 中型(约 150 MB)", st: "已下载", act: `<button class="btn sm">使用</button><button class="btn ghost sm icon" title="删除">${ico("trash", 13)}</button>` },
    { n: "中文 · 大型(约 640 MB)", st: "未下载 · 精度更高,首次识别更慢", act: `<button class="btn sm">${ico("download", 13)} 下载</button>` },
  ];
  const downloading = `<div class="row">
    <div class="row-l"><div class="row-t"><span class="t-row">英语 · 小型(约 40 MB)</span></div>
      <div class="t-desc row-d">下载中 62% · 24.8 MB / 40 MB</div></div>
    <div class="row-c" style="min-width:230px"><div class="prog"><i style="width:62%"></i></div>
      <button class="btn ghost sm icon" title="取消下载">${ico("stop", 13)}</button></div></div>`;
  return rows
    .map(
      (m) => `<div class="row">
        <div class="row-l"><div class="row-t"><span class="t-row">${esc(m.n)}</span></div>
          <div class="t-desc row-d">${esc(m.st)}</div></div>
        <div class="row-c">${m.act}</div></div>`,
    )
    .join("") + downloading;
});

/* ── LSP ──────────────────────────────────────────────────── */
register("lsp", () => {
  const stat = (k) =>
    ({ running: badge("a", "运行中", true), installed: badge("n", "已安装"), missing: badge("o", "未安装"), importing: badge("w", "导入中") }[k]);
  const acts = (k) =>
    k === "missing"
      ? `<button class="btn primary sm">${ico("download", 13)} 安装</button>`
      : `<button class="btn ghost sm icon" title="重装">${ico("refresh", 13)}</button>
         <button class="btn ghost sm icon" title="健康检查">${ico("shield", 13)}</button>
         <button class="btn sm">卸载</button>`;

  const log = (lines) => `<div class="fld"><span class="t-desc">安装输出</span>
    <pre class="log">${esc(lines)}</pre>
    <button class="btn ghost sm" style="align-self:flex-start">隐藏安装输出</button></div>`;

  const detail = (o) => `<div class="dt">
      <div class="dtrow"><span class="k">服务器路径</span>
        <span class="v mono">${esc(o.path)}</span>
        <button class="btn ghost sm icon" title="复制">${ico("copy", 13)}</button>
        <button class="btn ghost sm icon" title="在文件夹中显示">${ico("folderOpen", 13)}</button></div>
      <div class="dtrow"><span class="k">下载与逃生通道</span>
        <span class="v" style="display:flex;gap:6px;white-space:normal">
          <button class="btn sm">${ico("download", 13)} 打开下载页</button>
          <button class="btn sm">${ico("fileImport", 13)} 从文件安装</button></span></div>
    </div>
    <div class="fgrid" style="padding:10px 0 0">
      <div class="fld"><span class="t-desc">自定义 server 路径(留空 = 自动探测 PATH)</span><input class="inp mono" placeholder="留空自动探测"></div>
      <div class="fld"><span class="t-desc">额外启动参数(空格分隔)</span><input class="inp mono" placeholder="${esc(o.args || "例如 -Xmx2g")}"></div>
      ${o.jdk ? `<div class="fld"><span class="t-desc">jdtls 运行时 JDK 路径(需 JDK 17+)</span><input class="inp mono" placeholder="留空 = 使用系统 java"></div>` : ""}
    </div>
    ${o.phase ? `<div class="sub t-desc">${esc(o.phase)}</div>` : ""}
    ${log(o.log)}
    <div style="display:flex;justify-content:flex-end"><button class="btn primary sm">保存</button></div>`;

  const row = (o) => `
    <div class="ligroup" data-open="${o.open === true}">
      <div class="li lsp-li">
        <span class="cv" data-act="expand" role="button" title="展开/收起详情">${ico("chevR", 14)}</span>
        <div class="lname">${ico("code", 14)}<span class="t-row">${esc(o.n)}</span>${stat(o.k)}</div>
        <div class="lx"><span class="t-desc">${esc(o.hint)}</span></div>
        <div class="la">${acts(o.k)}<button class="sw" role="switch" aria-checked="${o.k !== "missing" ? "true" : "false"}"></button></div>
      </div>
      <div class="li-detail">${detail(o)}</div>
    </div>`;

  return row({
    n: "TypeScript / JavaScript", k: "running", hint: "typescript-language-server · npm", open: false,
    path: "/opt/homebrew/bin/typescript-language-server",
    log: "$ npm i -g typescript-language-server\nadded 1 package in 2.4s\nhealth check ✓ (--version 5.1.1)",
  }) + row({
    n: "Python", k: "installed", hint: "basedpyright · pip", open: false,
    path: "~/.local/bin/basedpyright-langserver",
    log: "$ pip install basedpyright\nSuccessfully installed basedpyright-1.1.390\nhealth check ✓ (1.1.390)",
  }) + row({
    n: "Go", k: "missing", hint: "gopls · go install", open: false,
    path: "(未安装) 安装后位于 ~/go/bin/gopls",
    log: "尚未安装。点击「安装」后执行:\n$ go install golang.org/x/tools/gopls@latest",
  }) + row({
    n: "Java", k: "importing", hint: "jdtls(自动匹配 JDK 版本)", open: true, jdk: true,
    path: "~/Library/Application Support/Mcode/lsp/java/plugins/org.eclipse.equinox.launcher_1.6.700.jar",
    phase: "项目索引导入中 24% · Importing project mcode-gui。导入期间跳转与补全会等待;每个项目只导入一次,之后启动秒级就绪。",
    log: "$ java -jar jdtls --version\n[Info] Loading Gradle/Maven project…\n[Info] Importing project mcode-gui (24%)\n[Info] Workspace data: ~/Library/Application Support/Mcode/lsp/workspaces/8f2a1c",
  });
});

/* ── 用量统计 ─────────────────────────────────────────────── */
register("summaryCards", () => {
  const cards = [
    ["对话轮次", "1,284"], ["涉及会话", "63"], ["总 Tokens", "42.8M"],
    ["子代理 Tokens", "6.1M"], ["输出 Tokens", "3.4M"], ["缓存读取", "31.2M"], ["缓存写入", "2.8M"],
  ];
  return `<div class="sumgrid">${cards
    .map(([k, v]) => `<div class="sum"><b class="num">${v}</b><span>${esc(k)}</span></div>`)
    .join("")}</div>`;
});

register("heatmap", () => {
  let seed = 20260910;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const weeks = 30;
  let cells = "";
  for (let w = 0; w < weeks; w++) {
    for (let d = 0; d < 7; d++) {
      const weekend = d === 5 || d === 6;
      const r = rnd() * (weekend ? 0.35 : 1) * (w > weeks - 6 ? 1.25 : 1);
      const l = r > 0.82 ? 4 : r > 0.6 ? 3 : r > 0.38 ? 2 : r > 0.16 ? 1 : 0;
      cells += `<i data-l="${l}" title="${(w * 7 + d) % 30 + 1} 日 · ${l * 3 + 1} 轮"></i>`;
    }
  }
  const months = ["6 月", "7 月", "8 月", "9 月"];
  return `<div class="sub">
    <div class="heat" style="--cell:12px;--hgap:3px">
      <div class="hl"><span>一</span><span></span><span>三</span><span></span><span>五</span><span></span><span>日</span></div>
      <div class="hm">
        <div class="hm-month">${months.map((m) => `<span style="width:${7 * 15 - 3}px">${m}</span>`).join("")}</div>
        <div class="hm-grid">${cells}</div>
      </div>
    </div>
    <div class="heat-foot"><span class="t-meta">少</span>
      ${[0, 1, 2, 3, 4].map((l) => `<i class="lg" data-l="${l}"></i>`).join("")}
      <span class="t-meta">多</span>
      <span class="t-meta" style="margin-left:auto">共 1,284 轮 · 连续打卡 12 天</span></div>
  </div>`;
});

register("modelBars", () => {
  const rows = [
    ["DS", "DeepSeek 中转", "deepseek-chat", "18.4M", "742 轮", 100],
    ["MO", "Moonshot 中转", "kimi-k2", "12.1M", "318 轮", 66],
    ["OL", "本地 Ollama", "qwen3-coder", "7.2M", "164 轮", 39],
    ["CO", "Codex 端点", "gpt-5.6-sol", "5.1M", "60 轮", 28],
  ];
  return rows
    .map(
      ([av, v, m, tk, tu, pct]) => `<div class="li mbar">
        <div class="av">${esc(av)}</div>
        <div class="lx">
          <div class="l1"><span class="t-row">${esc(v)}</span><span class="t-meta">${esc(m)}</span></div>
          <div class="prog" style="margin-top:6px"><i style="width:${pct}%"></i></div>
        </div>
        <div class="la t-meta">${esc(tk)} tokens · ${esc(tu)}</div></div>`,
    )
    .join("");
});

/* ── 关于 ─────────────────────────────────────────────────── */
register("about", () => `
  <div class="about">
    <div class="card">
      <div class="hero">
        <div class="logo">${ico("layers", 26)}</div>
        <div>
          <div class="t-page">Mcode</div>
          <div class="t-desc" style="margin-top:3px">基于 Claude Agent SDK 构建的桌面端 GUI。不重新实现 agent,只做 Claude 的交互界面。</div>
          <div class="t-meta" style="margin-top:6px">v0.9.4(build 20260910)</div>
        </div>
      </div>
    </div>
    <div class="card">
      <div class="rows">
        <div class="row"><div class="row-l"><div class="row-t"><span class="t-row">版本</span></div></div>
          <div class="row-c t-meta">v0.9.4</div></div>
        <div class="row"><div class="row-l"><div class="row-t"><span class="t-row">许可证</span></div></div>
          <div class="row-c t-meta">MIT</div></div>
        <div class="row"><div class="row-l"><div class="row-t"><span class="t-row">运行环境</span></div>
          <div class="t-desc row-d">Electron 38 · Node.js 22.13 · Chromium 140 · macOS arm64</div></div>
          <div class="row-c"><button class="btn ghost sm icon" title="复制版本信息">${ico("copy", 13)}</button></div></div>
      </div>
    </div>
    <div class="card up">
      <div class="upb">
        <div class="ci">${ico("download", 15)}</div>
        <div class="lx">
          <div class="t-row">发现新版本 v0.9.5</div>
          <div class="t-desc">包含设置页重设计与 12 项修复,约 96 MB。</div>
          <div class="prog" style="margin-top:8px;max-width:320px"><i style="width:38%"></i></div>
          <div class="t-meta" style="margin-top:5px">正在下载更新… 38% · 36 MB / 96 MB</div>
        </div>
        <button class="btn sm">取消</button>
      </div>
    </div>
    <div class="row-c" style="justify-content:flex-start;gap:8px">
      <button class="btn">${ico("check", 13)} 复制版本信息</button>
      <button class="btn">${ico("ext", 13)} GitHub 仓库</button>
      <button class="btn">${ico("refresh", 13)} 检查更新</button>
    </div>
    <div class="snote" style="border:1px solid rgb(var(--edge));border-radius:var(--r-card);background:rgb(var(--surface))">
      ${ico("info", 13)} <span class="t-desc">Mcode 是 MIT 许可的开源项目,不收集任何遥测数据。会话与配置保存在本机应用数据目录。</span></div>
  </div>`);

/* ── Agent 运行时 ─────────────────────────────────────────── */
register("runtimes", (sec, page, plan) => {
  const row = (o) => `
    <div class="ligroup" data-open="${o.open === true}">
      <div class="li">
        <span class="cv" data-act="expand" role="button" title="展开/收起详情">${ico("chevR", 14)}</span>
        <div class="lname">${ico(o.ic, 14)}<span class="t-row">${esc(o.n)}</span>${o.badge}</div>
        <div class="lx"><span class="t-desc">${esc(o.detail)}</span></div>
        <div class="la">${o.actions}</div>
      </div>
      <div class="li-detail">${o.body || ""}</div>
    </div>`;

  const detail = (o) => `
    <div class="dt">
      ${[["来源", o.src], ["版本", o.ver], ["磁盘占用", o.size], ["加载路径", o.path]]
        .map(
          ([k, v], i) => `<div class="dtrow"><span class="k">${k}</span>
            ${i === 3 ? `<span class="v mono">${esc(v)}</span>
              <button class="btn ghost sm icon" title="复制">${ico("copy", 13)}</button>
              <button class="btn ghost sm icon" title="在文件夹中显示">${ico("folderOpen", 13)}</button>`
            : `<span class="v">${esc(v)}</span>`}</div>`,
        )
        .join("")}
    </div>`;

  const prog = (pct, txt) => `<div class="dt"><div class="dtrow"><span class="k">进度</span>
    <span class="v" style="display:flex;align-items:center;gap:8px;white-space:normal">
      <span class="prog"><i style="width:${pct}%"></i></span>
      <span class="t-meta" style="flex:none">${esc(txt)}</span></span></div></div>`;

  return row({
    n: "Claude", ic: "robot", open: true, badge: badge("a", "已安装", true),
    detail: "独立安装副本 v2.1.238 · 209 MB",
    actions: `<button class="btn primary sm">更新到 2.1.240</button>
      <button class="btn ghost sm icon" title="重新安装">${ico("refresh", 13)}</button>
      <button class="btn sm">卸载</button>
      <button class="btn ghost sm icon" title="从本地目录或 .tgz 包安装">${ico("fileImport", 13)}</button>`,
    body: detail({ src: "独立安装副本(应用数据目录)", ver: "v2.1.238", size: "209 MB", path: "~/Library/Application Support/Mcode/runtimes/claude/2.1.238" }),
  }) + row({
    n: "Codex", ic: "terminal", open: false, badge: badge("n", "开发依赖"), detail: "开发依赖 v0.153.4",
    actions: `<button class="btn ghost sm icon" title="重新安装">${ico("refresh", 13)}</button>
      <button class="btn sm">卸载</button>
      <button class="btn ghost sm icon" title="从本地目录或 .tgz 包安装">${ico("fileImport", 13)}</button>`,
    body: detail({ src: "开发依赖(node_modules,仅开发环境)", ver: "v0.153.4", size: "378 MB", path: "node_modules/@openai/codex" }),
  }) + row({
    n: "Pi", ic: "sparkles", open: true, badge: badge("i", "安装中"), detail: "正在解包 @mcode/runtime-pi@0.83.0",
    actions: `<button class="btn sm">取消</button>`,
    body: prog(62, "62% · 14 MB / 22 MB"),
  }) + row({
    n: "Claude 备用副本", ic: "box", open: false, badge: badge("o", "未安装"), detail: "期望版本 v2.1.240 · 未检测到可用副本",
    actions: `<button class="btn primary sm">${ico("download", 13)} 安装</button>
      <button class="btn ghost sm icon" title="从本地目录或 .tgz 包安装">${ico("fileImport", 13)}</button>`,
    body: `<span class="t-desc">尚未安装。应用更新后会期望新版本,点「安装」从镜像下载并校验 sha512 后落位。</span>`,
  });
});

/* ── 插件:已安装 ─────────────────────────────────────────── */
register("pluginsInstalled", (sec, page, plan, st) => {
  const chip = (t, n, w) => `<span class="chip${w ? " w" : ""}">${esc(t)}${n ? ` <span class="num">${n}</span>` : ""}</span>`;

  const detail = (o) => `
    <div class="pdet">
      <div class="dt">
        <div class="dtrow"><span class="k">来源</span><span class="v">${esc(o.src)}</span></div>
        <div class="dtrow"><span class="k">安装于</span><span class="v">${esc(o.at)}</span></div>
        <div class="dtrow"><span class="k">路径</span><span class="v mono">${esc("~/.mcode/plugins/" + o.name + "/" + o.ver)}</span></div>
      </div>
      <div class="mx">
        <span class="t-desc">组件支持</span>
        ${o.cmp.skills ? `<span class="chip">Skills:Claude · Codex · Pi</span>` : ""}
        ${o.cmp.mcp ? `<span class="chip">MCP:Claude · Codex</span>` : ""}
        ${o.cmp.commands ? `<span class="chip">Commands:仅 Claude</span>` : ""}
        ${o.cmp.hooks ? `<span class="chip w">Hooks:当前不执行</span>` : ""}
      </div>
      <div class="cdet">
        ${o.cmp.skills ? `<div class="cdh">Skills <span class="badge n">${o.cmp.skills.length}</span></div>
          <ul class="cdl">${o.cmp.skills.map(([n, d]) => `<li><span class="mono">${esc(n)}</span><span class="t-desc">${esc(d)}</span></li>`).join("")}</ul>` : ""}
        ${o.cmp.commands ? `<div class="cdh">Commands <span class="badge n">${o.cmp.commands.length}</span></div>
          <ul class="cdl">${o.cmp.commands.map(([n, d]) => `<li><span class="mono">/${esc(n)}</span><span class="t-desc">${esc(d)}</span></li>`).join("")}</ul>` : ""}
        ${o.cmp.mcp ? `<div class="cdh">MCP 服务器 <span class="badge n">${o.cmp.mcp.length}</span></div>
          <ul class="cdl">${o.cmp.mcp.map(([n, k, d]) => `<li><span class="mono">${esc(n)}</span>${badge("o", k)}<span class="t-desc">${esc(d)}</span></li>`).join("")}</ul>` : ""}
      </div>
      ${o.cmp.hooks ? `<div class="warnbox">${ico("alert", 14)}
        <div><b>已声明 ${o.cmp.hooks.length} 条 hooks —— 当前版本不执行,相关自动化不会生效。</b>
          <ul class="cdl" style="margin-top:5px">${o.cmp.hooks.map(([e, m, c]) => `<li><span class="mono">${esc(e)}</span><span class="t-desc">matcher: ${esc(m)} → <span class="mono">${esc(c)}</span></span></li>`).join("")}</ul></div>
      </div>` : ""}
    </div>`;

  const row = (o) => `
    <div class="ligroup" data-open="${o.open === true}">
      <div class="li pl">
        <span class="cv" data-act="expand" role="button" title="展开/收起详情">${ico("chevR", 14)}</span>
        <div class="av${o.on ? " on" : ""}">${esc(o.name[0].toUpperCase())}</div>
        <div class="lx">
          <div class="l1"><span class="t-row">${esc(o.name)}</span><span class="t-meta mono">v${esc(o.ver)}</span>
            ${o.chips.join("")}</div>
          <div class="l2">${esc(o.desc)}</div>
        </div>
        <div class="la"><button class="sw" role="switch" aria-checked="${o.on ? "true" : "false"}"></button>
          <button class="btn ghost sm icon" title="卸载">${ico("trash", 13)}</button></div>
      </div>
      <div class="li-detail">${detail(o)}</div>
    </div>`;

  const plugins = [
    {
      name: "security-audit", ver: "1.0.2", on: true, open: true, src: "插件市场 · 官方市场", at: "2026-09-08 14:32",
      desc: "依赖与密钥审查:扫描依赖树、查找硬编码密钥并生成可提交的报告。",
      chips: [chip("Skills", 3), chip("MCP", 1), chip("Hooks", 2, true)],
      cmp: {
        skills: [["audit-deps", "扫描依赖树中的已知漏洞"], ["audit-secrets", "在改动中查找硬编码密钥"], ["audit-report", "汇总为可提交的审查报告"]],
        mcp: [["security-audit__osv", "http", "https://api.osv.dev/mcp"]],
        hooks: [["PostToolUse", "Write|Edit", "node ~/.mcode/plugins/security-audit/scan.js"], ["Stop", "*", "node ~/.mcode/plugins/security-audit/report.js"]],
      },
    },
    {
      name: "code-review", ver: "1.2.0", on: true, src: "插件市场 · 官方市场", at: "2026-09-07 09:14",
      desc: "按团队清单审查改动,输出可执行的修改建议。",
      chips: [chip("Skills", 2), chip("Commands", 1)],
      cmp: { skills: [["review-diff", "按清单逐条核对改动"], ["review-summary", "把意见汇总为 PR 评论"]], commands: [["review", "对当前改动发起一轮审查"]] },
    },
    {
      name: "postgres-toolkit", ver: "0.4.1", on: true, src: "Git · https://github.com/acme/pg-toolkit", at: "2026-09-05 18:02",
      desc: "MCP 形式暴露的 Postgres 查询与 schema 检查工具。",
      chips: [chip("MCP", 2)],
      cmp: { mcp: [["postgres-toolkit__pg", "stdio", "npx -y @mcode/pg-mcp"], ["postgres-toolkit__schema", "stdio", "npx -y @mcode/pg-schema"]] },
    },
    {
      name: "figma-bridge", ver: "0.1.0", on: false, src: "本地目录 · ~/dev/figma-bridge", at: "2026-09-03 11:26",
      desc: "读取 Figma 文件的结构与样式变量。",
      chips: [chip("MCP", 1)],
      cmp: { mcp: [["figma-bridge__figma", "http", "https://mcp.figma.local/sse"]] },
    },
  ];

  return `<div class="toolbar">
      <div class="ts">${ico("search", 13)}<input class="inp" placeholder="搜索插件或组件…" value="${esc(st.q || "")}" data-act="topq"></div>
      <div class="seg"><button aria-selected="true">全部 <span class="num">4</span></button><button aria-selected="false">已启用 <span class="num">3</span></button></div>
      <button class="btn sm">${ico("plus", 13)} 安装 ${ico("chevD", 12)}</button>
    </div>
    <div class="plist">${plugins.map(row).join("")}</div>`;
});

/* ── 插件:市场 ───────────────────────────────────────────── */
register("pluginsMarket", (sec, page, plan, st) => {
  const entry = (o) => `
    <div class="li">
      <div class="lx"><div class="l1"><span class="t-row">${esc(o.n)}</span><span class="t-meta mono">v${esc(o.v)}</span></div>
        <div class="l2">${esc(o.d)}</div></div>
      <div class="la">${o.installed ? `<span class="badge a">${ico("check", 11)} 已安装</span>` : `<button class="btn sm">安装</button>`}</div>
    </div>`;
  return `<div class="toolbar">
      <div class="ts">${ico("search", 13)}<input class="inp" placeholder="搜索插件…"></div>
      <span class="t-meta">292 个插件</span>
      <button class="btn ghost sm icon" title="刷新全部">${ico("refresh", 13)}</button>
    </div>
    <div class="seg mktabs">
      <button aria-selected="true">官方市场 <span class="num">292</span></button>
      <button aria-selected="false">团队私有 <span class="num">12</span></button>
      <button aria-selected="false" title="添加插件市场">${ico("plus", 12)}</button>
    </div>
    <div class="card mpcard">
      <div class="ch"><div class="ci">${ico("git", 14)}</div>
        <div class="ct"><div class="t-card">官方市场 <span class="badge n">内置</span></div>
          <div class="t-desc mono">https://github.com/anthropics/claude-plugins</div></div>
        <div class="cm"><span class="t-meta">292 个插件</span>
          <button class="btn ghost sm icon" title="刷新">${ico("refresh", 13)}</button></div>
      </div>
      ${entry({ n: "security-audit", v: "1.0.2", d: "依赖与密钥审查:扫描依赖树、查找硬编码密钥并生成可提交的报告。", installed: true })}
      ${entry({ n: "pr-reviewer", v: "2.1.0", d: "按仓库规范自动审查 PR 改动并给出意见。" })}
      ${entry({ n: "schema-guard", v: "0.9.3", d: "迁移文件与 schema 定义的一致性检查。" })}
    </div>`;
});

/* ── MCP 各作用域 ─────────────────────────────────────────── */
const mcpRow = (o) => `
  <div class="row">
    <div class="row-l"><div class="row-t">${mono(o.name)}${badge("o", o.kind)}${o.auth || ""}</div>
      <div class="t-desc row-d mono">${esc(o.detail)}</div></div>
    <div class="row-c">${o.acts || ""}<button class="sw" role="switch" aria-checked="${o.on ? "true" : "false"}"></button>
      ${o.del ? `<button class="btn ghost sm icon" title="删除此 server">${ico("trash", 13)}</button>` : ""}</div>
  </div>`;

register("mcpUser", () => `
  ${mcpRow({ name: "github", kind: "http", detail: "https://api.githubcopilot.com/mcp/ · OAuth", on: true, del: true, auth: badge("a", "已授权") })}
  ${mcpRow({ name: "filesystem", kind: "stdio", detail: "npx -y @modelcontextprotocol/server-filesystem ~/workspace", on: true, del: true })}
  ${mcpRow({ name: "postgres", kind: "stdio", detail: "npx -y @modelcontextprotocol/server-postgres postgresql://localhost:5432/app", on: false, del: true,
    acts: `${badge("w", "待授权")}<button class="btn sm">去授权</button>` })}
  <div class="sub" style="display:flex;gap:8px">
    <button class="btn ghost sm">${ico("fileImport", 13)} 从 Claude CLI 导入</button>
    <button class="btn sm">${ico("plus", 13)} 新增 MCP Server</button>
  </div>`);

register("mcpProject", () => `
  <div class="row"><div class="row-l"><div class="row-t"><span class="t-row">项目</span></div>
    <div class="t-desc row-d">切换项目可查看各自的 .mcp.json 条目。</div></div>
    <div class="row-c"><div class="sel" style="width:220px">mcode-gui(当前工作区)</div></div></div>
  ${mcpRow({ name: "playwright", kind: "stdio", detail: "npx -y @playwright/mcp@latest", on: true })}
  ${mcpRow({ name: "local-index", kind: "sse", detail: "http://127.0.0.1:8848/sse · 默认关闭,确认来源后开启", on: false, acts: badge("w", "默认关闭") })}
  <div class="sub t-desc">${ico("info", 13)} 项目级 server 不提供删除入口,请直接编辑项目中的 .mcp.json。</div>`);

register("mcpPlugin", () => `
  ${mcpRow({ name: "security-audit__osv", kind: "http", detail: "https://api.osv.dev/mcp · 来自插件 security-audit", on: true })}
  ${mcpRow({ name: "postgres-toolkit__pg", kind: "stdio", detail: "npx -y @mcode/pg-mcp · 来自插件 postgres-toolkit", on: false })}
  <div class="sub t-desc">${ico("info", 13)} 插件 MCP 的主开关是插件自身的启用状态;这里的开关用于单独阻断某个 server。</div>`);

register("mcpBuiltin", () => mcpRow({ name: "browser", kind: "内置", detail: "应用内浏览器控制(截图、导航、点击)", on: true, acts: badge("n", "随应用提供") }));

/* ── 模型配置:主从 + 表单 ───────────────────────────────── */
register("providerForm", (sec, page, plan, st) => {
  const tab = st.tab || "Claude";
  const entities = page.entities[tab] || [];
  const master = plan === "b" ? "" : `
    <div class="mlist">
      <div class="mh">${esc(page.masterTitle)} <span class="badge n">${entities.length}</span></div>
      ${entities.map((e, i) => `<button class="mi" data-on="${i === 0}"><span class="mt">${esc(e.t)}</span><span class="ms">${esc(e.s)}</span></button>`).join("")}
      <button class="mi add">${ico("plus", 13)} ${esc(page.entityAddLabel[tab])}</button>
      <div class="mf"><button class="btn sm" style="width:100%">${ico("plus", 13)} ${esc(page.entityAddLabel[tab])}</button></div>
    </div>`;

  const fld = (label, ctrl, hint) =>
    `<div class="fld"><label>${esc(label)}</label>${ctrl}${hint ? `<span class="hint">${esc(hint)}</span>` : ""}</div>`;

  const modelRow = (id, extra, tags) => `
    <div class="mrow"><input class="inp mono grow" value="${esc(id)}"><span class="space"></span>${tags || ""}
      <button class="btn ghost sm icon" title="用该模型测试连接">${ico("plug", 13)}</button>
      <button class="btn ghost sm icon" title="删除模型">${ico("trash", 13)}</button></div>`;

  const forms = {
    Claude: `
      <div class="fgrid">
        ${fld("API 格式", `<div class="sel">Anthropic(原生 /v1/messages)</div>`, "OpenAI 格式会经本地协议翻译转发,支持大多数第三方网关。")}
        ${fld("名称", `<input class="inp" value="官方中转">`)}
      </div>
      ${fld("Base URL", `<input class="inp mono" value="https://api.example.com">`)}
      <div class="fgrid">
        ${fld("Token / API Key", secret("sk-ant-••••••••••••••••"), "仅保存在本机,不会写入配置文件。")}
        ${fld("认证方式", `<div class="sel">Bearer</div>`)}
      </div>
      <div class="fld"><label>模型列表 <span class="badge n">3</span></label>
        ${modelRow("claude-sonnet-4-5", "", `<label class="tagsw">${'1M'} <button class="sw sm" role="switch" aria-checked="false"></button></label>`)}
        ${modelRow("claude-opus-4-1", "", `<label class="tagsw">1M <button class="sw sm" role="switch" aria-checked="true"></button></label>`)}
        ${modelRow("deepseek-chat", "", `<label class="tagsw">1M <button class="sw sm" role="switch" aria-checked="true"></button></label>`)}
        <button class="btn ghost sm" style="align-self:flex-start">${ico("plus", 13)} 添加模型</button>
      </div>
      ${fld("子代理模型", `<div class="sel">跟随主会话</div>`, "子代理默认继承主会话模型;指定后所有 Task 子代理都用该模型。")}
      ${disc(`${chev(false)}<span class="t-row">高级选项</span><span class="t-desc" style="margin-left:6px">超时 · 遥测 · 自定义请求头</span>`,
        `<div class="fgrid" style="padding:12px 0 0">
          ${fld("超时(ms)", `<input class="inp num" value="3000000">`)}
          ${fld("禁用遥测", `<label class="tagsw"><button class="sw sm" role="switch" aria-checked="true"></button> 不发送使用统计</label>`)}
        </div>
        <div class="fld" style="padding-top:12px"><label>自定义请求头 <span class="badge n">1</span></label>
          <div class="hrow"><input class="inp mono" value="x-opencode-session"><input class="inp mono" value="mcode-session"><button class="btn ghost sm icon" title="删除">${ico("trash", 13)}</button></div>
          <button class="btn ghost sm" style="align-self:flex-start">${ico("plus", 13)} 添加</button>
          <span class="hint">会随每次请求发送,可用于网关要求的额外鉴权或会话头。</span></div>`, false)}
      <div class="actions"><span class="badge a">${ico("check", 11)} 连接成功 · 812ms</span><span class="sp"></span>
        <button class="btn danger sm">删除</button><button class="btn sm">取消</button><button class="btn primary sm">保存</button></div>`,

    Codex: `
      <div class="fgrid">
        ${fld("Provider ID", `<input class="inp mono" value="deepseek" disabled>`, "创建后不可修改;仅限字母、数字、连字符和下划线。")}
        ${fld("Provider 名称", `<input class="inp" value="DeepSeek">`)}
      </div>
      ${fld("Base URL", `<input class="inp mono" value="https://api.deepseek.com/v1">`, "端点必须支持 OpenAI Responses API;仅支持 chat-completions 的端点无法使用。")}
      ${fld("API Key", secret("sk-••••••••••••••••"), "留空表示保持现有 Key 不变。")}
      <div class="fcard"><div><div class="t-row">支持生图</div>
        <div class="t-desc">为端点开启 imagegen 工具;需要网关支持 OpenAI images 接口。</div></div>
        <button class="sw" role="switch" aria-checked="false"></button></div>
      <div class="fld"><label>模型列表 <span class="badge n">1</span></label>
        ${modelRow("deepseek-chat", "", `<label class="tagsw">1M <button class="sw sm" role="switch" aria-checked="true"></button></label>`)}
        <button class="btn ghost sm" style="align-self:flex-start">${ico("plus", 13)} 添加模型</button></div>
      <div class="actions"><span class="sp"></span><button class="btn danger sm">删除</button><button class="btn sm">取消</button><button class="btn primary sm">保存</button></div>`,

    Pi: `
      <div class="fgrid">
        ${fld("Provider 名称", `<input class="inp" value="deepseek">`)}
        ${fld("API 类型", `<div class="sel">openai-completions</div>`)}
      </div>
      ${fld("Base URL", `<input class="inp mono" value="https://api.deepseek.com/v1">`)}
      ${fld("API Key", secret("sk-••••••••••••••••"))}
      <label class="tagsw"><button class="sw" role="switch" aria-checked="true"></button> 自动添加 Authorization: Bearer 请求头</label>
      <div class="fld"><label>模型列表 <span class="badge n">2</span></label>
        <div class="mcard">
          <div class="mrow"><input class="inp mono grow" value="deepseek-chat"><span class="space"></span>
            <input class="inp num" value="8192" style="width:84px" title="最大输出 token">
            <label class="tagsw">1M <button class="sw sm" role="switch" aria-checked="true"></button></label>
            ${chev(true)}<button class="btn ghost sm icon" title="删除模型">${ico("trash", 13)}</button></div>
          <div class="mexp">
            <div class="fgrid">
              <label class="tagsw"><button class="sw sm" role="switch" aria-checked="true"></button> 支持推理</label>
              <label class="tagsw"><button class="sw sm" role="switch" aria-checked="false"></button> 支持图片输入</label>
            </div>
            <div class="fld"><label>显示名(可选)</label><input class="inp" placeholder="例如 DeepSeek Chat"></div>
            <div class="fld"><span class="hint">思考级别映射 —— 把 Pi 的思考档位映射到该模型实际支持的参数。</span>
              <div class="tmap">
                ${["off", "minimal", "low", "medium"].map((k) => `<span class="tk">${k}</span><div class="sel sm">默认</div>`).join("")}
              </div></div>
          </div>
        </div>
        <div class="mcard">
          <div class="mrow"><input class="inp mono grow" value="deepseek-reasoner"><span class="space"></span>
            <input class="inp num" value="16384" style="width:84px" title="最大输出 token">
            <label class="tagsw">1M <button class="sw sm" role="switch" aria-checked="false"></button></label>
            ${chev(false)}<button class="btn ghost sm icon" title="删除模型">${ico("trash", 13)}</button></div>
        </div>
        <button class="btn ghost sm" style="align-self:flex-start">${ico("plus", 13)} 添加模型</button></div>
      <div class="actions"><span class="sp"></span><button class="btn danger sm">删除</button><button class="btn sm">取消</button><button class="btn primary sm">保存</button></div>`,
  };

  return `<div class="split master">${master}<div class="card">${plan === "b" ? "" : ""}<div class="form">${forms[tab]}</div></div></div>`;
});

/* ── Skills 编辑器 ───────────────────────────────────────── */
register("skillEditor", (sec, page, plan, st) => {
  const list = page.entities[""];
  const master = plan === "b" ? "" : `
    <div class="mlist">
      <div class="mh">Skills <span class="badge n">3</span></div>
      <button class="mi" data-on="true"><span class="mt">commit-message <span class="badge a">项目</span></span><span class="ms">生成规范的提交信息</span></button>
      <button class="mi"><span class="mt">pr-review <span class="badge a">项目</span></span><span class="ms">按清单审查改动</span></button>
      <button class="mi"><span class="mt">explain-code <span class="badge n">全局</span></span><span class="ms">逐段解释代码意图</span></button>
      <button class="mi add">${ico("plus", 13)} 新建 Skill</button>
      <div class="mf" style="display:flex;gap:6px"><button class="btn sm" style="flex:1">${ico("plus", 13)} 新建</button>
        <button class="btn sm" style="flex:1">${ico("download", 13)} 导入</button></div>
    </div>`;

  return `<div class="split master">${master}
    <div class="card">
      <div class="ch"><div class="ci">${ico("sparkles", 14)}</div>
        <div class="ct"><div class="t-card">commit-message <span class="badge a">项目</span></div>
          <div class="t-desc">生成规范的提交信息 · <span class="mono">.claude/skills/commit-message/SKILL.md</span></div></div>
        <div class="cm"><button class="btn ghost sm">${ico("download", 13)} 导出</button></div>
      </div>
      <div class="form" style="gap:10px">
        <div class="fld"><label>SKILL.md 原文</label>
          <textarea class="ta mono" rows="${plan === "b" ? 14 : 12}">---
name: commit-message
description: 按 Conventional Commits 生成中文提交信息
---

# 提交信息生成

当用户要求生成提交信息时:

1. 先看 \`git diff --staged\`;若为空则看 \`git status --short\`。
2. 用一句话概括改动**意图**(不是文件清单)。
3. 输出格式: \`<type>(<scope>): <subject>\`,type 取值 feat/fix/refactor/docs/test/chore。
4. subject 用中文,不超过 50 字,不以句号结尾。
5. 有破坏性改动时补 \`BREAKING CHANGE:\` 段落。
</textarea>
        <span class="hint">保存后下一次发起会话时生效;项目级 Skill 会被提交到仓库,团队共享。</span></div>
        <div class="actions"><button class="btn danger sm">删除</button><span class="sp"></span>
          <button class="btn sm">取消</button><button class="btn primary sm">保存</button></div>
      </div>
    </div></div>`;
});
