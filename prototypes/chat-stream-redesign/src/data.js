/* ============================================================================
 * 内容数据:一条历史回合(已折叠) + 当前回合(用户输入 / 过程 / 最终回复)。
 * 文案刻意贴着真实开发场景写,便于判断"过程 / 回复"的层级是否清楚。
 * ========================================================================= */

export const SESSION = {
  project: "cc-gui",
  branch: "fix/login-loading",
  model: "Claude Sonnet 4.5",
  provider: "Claude",
  providerShort: "CL",
  clock: "02:14",
  title: "修弱网下登录页一直转圈",
};

/** 上一条历史回合(已结束、过程已折叠)—— 用来看"跑完很久之后"的观感。 */
export const HISTORY = {
  user: "顺便帮我把超时的错误文案统一一下，中英都要。",
  ops: [
    { kind: "tool", name: "Grep", icon: "search", target: "timeout", dur: "0.2s" },
    { kind: "tool", name: "Read", icon: "read", target: "lib/i18n/zh/common.ts", dur: "0.3s" },
    { kind: "tool", name: "Edit", icon: "edit", target: "lib/i18n/zh/common.ts", dur: "0.4s", adds: 6, dels: 2 },
    { kind: "tool", name: "Edit", icon: "edit", target: "lib/i18n/en/common.ts", dur: "0.4s", adds: 6, dels: 2 },
  ],
  reply:
    "文案已统一成「请求超时，请稍后重试」/「Request timed out. Please try again.」，`withTimeout` 抛出的 `TimeoutError` 会走这一条，网络断开仍走原来的「请检查网络」。",
  dur: "8.4s",
  steps: 4,
  adds: 12,
  dels: 4,
  touched: 2,
};

/** 当前回合的用户输入。 */
export const USER_TEXT = "登录页在弱网下会一直转圈，帮我看下原因并修掉。别改接口协议。";

export const USER_META = { at: "02:14", attach: "粘贴了 1 段控制台日志" };

/** 当前回合的过程序列。status 由播放器推进(最后一条 visible = running)。 */
export const OPS = [
  { kind: "think", text: "先看登录页的提交链路，重点找 loading 状态被置位之后没有复位的那条路径。" },
  { kind: "say", text: "先定位登录页的提交逻辑。" },
  { kind: "tool", name: "Read", icon: "read", target: "apps/desktop/src/renderer/pages/Login.tsx", dur: "0.3s" },
  { kind: "tool", name: "Grep", icon: "search", target: "setSubmitting", dur: "0.2s" },
  { kind: "tool", name: "Read", icon: "read", target: "src/renderer/lib/auth.ts", dur: "0.2s" },
  { kind: "think", text: "catch 分支只写了 error state，没有复位 submitting——请求超时抛错时按钮就永久停在 loading。" },
  { kind: "tool", name: "Edit", icon: "edit", target: "src/renderer/pages/Login.tsx", dur: "0.4s", adds: 24, dels: 6 },
  { kind: "tool", name: "Write", icon: "write", target: "src/renderer/lib/withTimeout.ts", dur: "0.3s", adds: 18, created: true },
  { kind: "tool", name: "Bash", icon: "terminal", target: "pnpm typecheck", dur: "3.1s" },
  { kind: "tool", name: "Bash", icon: "terminal", target: "pnpm test:auth", dur: "1.8s", note: "12 passed" },
];

/** 当前回合的最终回复(markdown 子集)。 */
export const REPLY = [
  "找到原因了：`Login.tsx` 的 `catch` 分支只把错误写进 state，没有复位 `submitting`。弱网下请求超时抛错，按钮就永久停在 loading。",
  "",
  "改动三处：",
  "",
  "- 新增 `withTimeout()`，8s 后抛 `TimeoutError`，不再让 fetch 无限等",
  "- 提交流程改成 `try/finally`，任何异常都会复位按钮",
  "- 超时与网络错误分开提示，不再一律显示「请检查网络」",
  "",
  "```ts",
  "try {",
  "  setSubmitting(true)",
  "  await withTimeout(api.login(form), 8000)",
  "} finally {",
  "  setSubmitting(false)",
  "}",
  "```",
  "",
  "要我把超时阈值做成设置项吗？默认 8s。",
].join("\n");

/** 回合统计(结束后回执用)。 */
export const TURN_STATS = {
  dur: "12.3s",
  steps: OPS.filter((o) => o.kind === "tool").length,
  touched: 3,
  adds: 42,
  dels: 6,
  tokens: "18.4k",
};

/** 三个方案的自述,用于底部说明区。 */
export const PLANS = {
  a: {
    id: "a",
    name: "方案 A · 脉络",
    tag: "精修",
    lead: "结构与现在 1:1 对齐，只重绘视觉与动效。风险最低，可直接落地。",
    points: [
      ["识别骨架", "用户消息保持右侧气泡，助手正文无容器——只在左侧加一条「生命线」竖脊，过程节点挂在脊上，一眼看出哪几步属于这次运行。"],
      ["运行中", "脊线用渐变向下生长、末端节点带呼吸光环；过程摘要行左对齐贴在脊上（不再用居中胶囊），右侧跟实时操作 ticker；正文末尾是一枚闪烁光标，替代现在的转圈小图标。"],
      ["运行结束", "整条过程脊折叠成一行摘要（`12.3s · 7 步 · 改 3 个文件 +42 −6`），脊线由 accent 渐变为中性灰，刻度点整体淡出；最终回复留在脊线末端并标「回复」。"],
      ["动效", "块入场上浮 + 逐项错峰 30ms；工具状态 running→done 时图标交叉淡换成对勾并轻微回弹；折叠用 grid-rows 0fr↔1fr；气泡从右侧滑入。"],
      ["改动面", "ChatPane 的 MessageRow + MessageBlocks 的 TurnPanel/工具卡；styles.css 加约 8 组关键帧。不动消息切分逻辑。"],
    ],
  },
  b: {
    id: "b",
    name: "方案 B · 台账",
    tag: "信息密度最高",
    lead: "把「过程」做成一张有台头 / 明细 / 回执的运行台账，回复独立成卡。两态差异最大。",
    points: [
      ["用户输入", "从气泡变成「指令卡」：左侧色条 + 浅底 + 顶部元信息行（时间 · 附件）。hover 时右上角浮出复制 / 编辑。"],
      ["运行中", "台账顶部是实时台头：呼吸圆点 + `运行中 00:12` + 正在执行的操作名，右侧 `10 步`。下面按列对齐的明细行（工具｜目标｜耗时），当前行高亮并带左侧进度条，底部一条扫描光带表示还在继续。"],
      ["运行结束", "台头收成一行回执：`✓ 完成 · 12.3s · 10 步 · 改 3 个文件 +42 −6`，数字向上滚动计数；明细收进折叠区，需要时才展开。"],
      ["回复区", "最终回复升级为独立卡：头部是 provider 缩写徽标 + 模型名 + 时间 + 完成徽章，正文行高放宽，底部常驻一条低对比操作栏（复制 / 回滚 / 书签），hover 才提亮。"],
      ["改动面", "需要新增两个组件（TurnLedger / ReplyCard）并改 ChatPane 的 renderItem 分支，比 A 大一档；好处是过程与回复的语义边界最清楚。"],
    ],
  },
  c: {
    id: "c",
    name: "方案 C · 卡片流",
    tag: "视觉变化最大",
    lead: "弱化气泡、强化卡片与分组：用户侧是指令卡，助手侧是文档卡，过程折成横向步骤链。",
    points: [
      ["用户输入", "折角指令卡，accent 淡染底 + 等宽字形（用户输入多为指令/粘贴内容），底部一条元信息行，hover 从右侧滑出操作。"],
      ["助手输出", "文档卡：头部 provider 渐变徽标 + 名称 + 时间 + 状态徽章；正文；底部常驻操作栏。卡片以 `scale(.985) + 上浮` 弹簧入场。"],
      ["过程", "横向步骤链（面包屑）：每个工具一枚 chip，运行中最后一枚是「活」的——accent 描边 + 旋转圆弧 + 呼吸，chip 之间连接线流动；超过 4 枚折叠成 `… +N`；结束后全部退成灰描边虚线。"],
      ["运行结束", "整卡执行一次 settle：边框由 accent 收成中性、阴影收紧，状态徽章由「运行中」翻成「已完成」，步骤链淡化并静态化。"],
      ["改动面", "改动量最大（卡片容器 + chip 链 + 卡片头部），但对话节奏感最强，适合把过程彻底降为背景信息的用户。"],
    ],
  },
};
