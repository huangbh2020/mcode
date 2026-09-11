/* ============================================================================
 * 页面数据 —— 设置面板全部 17 个页面 + 4 个内嵌块
 * 字段逐条对齐 apps/desktop/src/renderer/components/settings/ 现状,
 * 以便评审时"哪里改了什么"可逐行对照。
 *
 * 行类型(k): sw 开关 / sel 下拉 / inp 输入 / num 数字 / ta 多行 / pal 色板
 *            step 步进 / path 路径 / btns 按钮组 / kbd 快捷键 / gest 手势
 *            note 卡片内说明 / sub 从属行(缩进,用于开关的依赖项)
 * 富内容:section.render 指向 render.js 里的专用渲染器
 * chg:true 表示该行与默认值不同(稿子里用点标记 + hover 恢复默认演示该能力)
 * ========================================================================= */

const sw  = (t, d, v, o = {}) => ({ k: "sw", t, d, v, ...o });
const sel = (t, d, v, opt, o = {}) => ({ k: "sel", t, d, v, o: opt, ...o });
const inp = (t, d, v, o = {}) => ({ k: "inp", t, d, v, ...o });
const ta  = (t, d, v, o = {}) => ({ k: "ta", t, d, v, ...o });
const path = (t, d, v, o = {}) => ({ k: "path", t, d, v, ...o });
const kbd = (t, keys, o = {}) => ({ k: "kbd", t, keys, ...o });
const gest = (t, seq, o = {}) => ({ k: "gest", t, seq, ...o });

export const MODEL_OPTIONS = ["DeepSeek 中转 → deepseek-chat", "Moonshot 中转 → kimi-k2", "本地 Ollama → qwen3-coder"];

/* ───────────────────────── 导航分组 ───────────────────────── */
export const NAV_GROUPS = [
  { label: "通用", ids: ["general", "appearance"] },
  { label: "AI 能力", ids: ["custom-models", "runtimes", "plugins", "skills", "mcp"] },
  { label: "输入与提醒", ids: ["voice", "shortcuts", "gestures", "notifications"] },
  { label: "工作台", ids: ["git", "terminal", "browser", "lsp-languages"] },
  { label: "系统", ids: ["usage", "about"] },
];

/* ───────────────────────── 页面 ───────────────────────── */
export const PAGES = [
  /* ══ 1 常规 ══ */
  {
    id: "general", label: "常规", icon: "sliders", kind: "form",
    desc: "语言、界面密度、长文本折叠与归档策略。",
    sections: [
      {
        t: "基础", icon: "sliders",
        rows: [
          sel("界面语言", "界面文字与日期格式的显示语言。", "简体中文", ["简体中文", "English"]),
          sel("中间面板显示模式", "标签模式可同时打开多个会话与文件。", "Tab 标签模式", ["单会话模式", "Tab 标签模式"]),
          sel("对话紧凑度", "控制消息之间的垂直间距。", "舒适", ["紧凑", "舒适", "宽松"]),
          { k: "num", t: "长文本折叠阈值", d: "超过该长度的粘贴内容在对话中折叠显示(50–2000)。", v: 300, unit: "字符" },
        ],
      },
      {
        t: "会话自动归档", icon: "box",
        d: "不活跃的会话会自动移入归档区,可对单个项目设置例外。",
        rows: [
          sw("自动归档不活跃会话", "关闭后所有会话都留在活跃列表,需要手动归档。", true),
          sel("默认不活跃天数", "超过该天数没有新消息即归档。", "30 天", ["7 天", "14 天", "30 天", "60 天", "90 天"]),
          sel("mcode-gui", "该项目的归档规则,覆盖上面的默认值。", "永不归档", ["永不归档", "7 天", "30 天", "90 天"], { inline: "remove" }),
          sel("api-gateway", "该项目的归档规则,覆盖上面的默认值。", "90 天", ["永不归档", "7 天", "30 天", "90 天"], { inline: "remove" }),
          sel("添加项目覆盖", "为某个项目单独指定归档规则。", "选择项目…", ["mcode-gui", "api-gateway", "docs-site"]),
        ],
      },
      {
        t: "会话标题生成", icon: "sparkles",
        d: "开启后,在用户发送第一条消息时后台自动调用模型生成简短标题。",
        rows: [
          sw("自动生成", "标题生成失败时会退回使用首条消息摘要。", true),
          sel("生成模型", "选择用于生成标题的模型。", MODEL_OPTIONS[0], MODEL_OPTIONS),
        ],
      },
      {
        t: "输出风格", icon: "pencil",
        d: "决定模型如何组织回复。仅 Claude 会话生效。",
        rows: [
          { k: "sel", t: "回复风格", d: "自定义风格以 ~/.mcode/output-styles 下的文件为准,点击刷新即可加载。", v: "默认", o: ["默认", "讲解型", "学习型", "简洁型"], refresh: true, wide: true },
        ],
      },
    ],
  },

  /* ══ 2 外观 ══ */
  {
    id: "appearance", label: "外观", icon: "palette", kind: "form",
    desc: "主题、编辑器配色、品牌色与字号。",
    sections: [
      {
        t: "主题与颜色", icon: "palette",
        rows: [
          sel("界面主题", "跟随系统时随操作系统的浅色/深色切换。当前:浅色", "跟随系统", ["浅色", "深色", "跟随系统"]),
          { k: "custom", key: "editorSchemeDark", t: "编辑器配色 · 深色模式", d: "深色主题下代码编辑器的配色方案。", v: "Mcode 深色" },
          { k: "custom", key: "editorSchemeLight", t: "编辑器配色 · 浅色模式", d: "浅色主题下代码编辑器的配色方案。", v: "Mcode 浅色" },
          { k: "pal", t: "用户消息背景色", d: "影响聊天中用户消息气泡的背景色调。", v: "主题默认色(灰色)", cur: 0, opts: ["#52525b", "#059669", "#0284c7", "#4f46e5", "#7c3aed", "#e11d48", "#d97706"], names: ["灰", "翠绿", "天蓝", "靛蓝", "紫罗兰", "玫瑰红", "琥珀"] },
          { k: "pal", t: "品牌强调色", d: "影响按钮、链接、选中态与输入框聚焦边框。", v: "主题默认色(翠绿)", cur: 1, opts: ["#059669", "#0284c7", "#4f46e5", "#0891b2", "#7c3aed", "#db2777", "#d97706", "#ea580c"], names: ["翠绿", "天蓝", "靛蓝", "青色", "紫罗兰", "樱粉", "琥珀", "橙色"] },
        ],
      },
      {
        t: "字号", icon: "code",
        d: "影响整个应用界面(左栏、右栏、设置页与聊天区)。",
        rows: [
          { k: "step", t: "全局字体大小", d: "应用界面基准字号(12–18px)。", v: "14px" },
          { k: "step", t: "聊天字体大小", d: "对话正文基准字号(12–20px)。", v: "14px", chg: true },
        ],
        note: "主题与字号切换整窗即时生效,无需重启。",
      },
    ],
  },

  /* ══ 3 通知 ══ */
  {
    id: "notifications", label: "通知", icon: "bell", kind: "form",
    desc: "选择哪些事件通过系统通知提醒。",
    sections: [
      {
        t: "系统通知", icon: "bell",
        d: "总开关关闭后不再发送任何系统通知,下面的细分项一并停用。",
        rows: [
          sw("允许发送系统通知", "由操作系统弹出横幅或通知中心条目。", true),
          sw("阻塞类事件", "工具审批、问题询问等待你操作的事件。", true, { sub: true }),
          sw("回合完成", "一轮对话结束时提醒。", true, { sub: true }),
          sw("错误", "会话出错或被中断时提醒。", true, { sub: true }),
          sw("后台任务", "后台子代理或长命令结束时提醒。", false, { sub: true, chg: true }),
        ],
        sub: { key: "notifyTest" },
        note: "macOS 首次发送时需在「系统设置 → 通知」中允许 Mcode;窗口处于前台时不重复弹通知。",
      },
    ],
  },

  /* ══ 4 语音 ══ */
  {
    id: "voice", label: "语音", icon: "mic", kind: "form",
    desc: "本地语音识别模型与麦克风设置。",
    sections: [
      {
        t: "语音识别模型", icon: "box", render: "voiceModels",
        d: "模型在本地运行,音频不会离开本机。",
      },
      {
        t: "模型存储位置", icon: "folder",
        rows: [
          path("模型目录", "留空使用应用数据目录下的 models/voice。", "~/Library/Application Support/Mcode/models/voice", { custom: true, actions: ["更改…"], reset: true, stack: true }),
        ],
      },
      {
        t: "麦克风", icon: "mic",
        rows: [
          sel("识别语言", "语言需与所选模型匹配,否则识别率会明显下降。", "中文 (zh-CN)", ["中文 (zh-CN)", "英语 (en-US)"]),
        ],
      },
    ],
  },

  /* ══ 5 快捷键 ══ */
  {
    id: "shortcuts", label: "快捷键", icon: "keyboard", kind: "kbd",
    desc: "点击右侧组合键即可重新录制;与其他命令冲突时会即时提示。",
    headerAction: "resetAll",
    sections: [
      {
        t: "会话", icon: "list",
        rows: [
          kbd("新建会话", ["⌘", "N"]),
          kbd("关闭当前会话", ["⌘", "W"]),
          kbd("打开命令面板", ["⌘", "K"]),
        ],
      },
      {
        t: "视图与导航", icon: "globe",
        rows: [
          kbd("搜索文件", ["⌘", "P"]),
          kbd("聚焦聊天输入框", ["⌘", "L"]),
          kbd("打开设置", ["⌘", ","], { state: "override", chg: true }),
          kbd("语音输入", [], { state: "unset" }),
        ],
      },
      {
        t: "布局与面板", icon: "layers",
        rows: [
          kbd("切换左侧栏", ["⌘", "B"]),
          kbd("切换右侧栏", ["⌘", "⇧", "B"]),
          kbd("切换底部终端", ["⌘", "J"]),
          kbd("切换显示模式", ["⌘", "⇧", "T"]),
        ],
      },
      {
        t: "编辑器", icon: "code",
        rows: [
          kbd("保存文件", ["⌘", "S"], { state: "conflict", conflict: "系统:保存网页" }),
          kbd("关闭当前标签页", ["⌘", "⇧", "W"]),
        ],
      },
      {
        t: "外观与主题", icon: "palette",
        rows: [
          kbd("切换深/浅主题", ["⌘", "⇧", "L"]),
        ],
        note: "录制中按 Esc 取消;恢复默认会把该命令清回内置组合键。",
      },
    ],
  },

  /* ══ 6 鼠标手势 ══ */
  {
    id: "gestures", label: "鼠标手势", icon: "hand", kind: "gest",
    desc: "按住触发键画出箭头序列,松手即执行对应命令。",
    headerAction: "resetAll",
    sections: [
      {
        t: "通用", icon: "hand",
        rows: [
          sw("启用鼠标手势", "关闭后不再识别任何手势。", true),
          sel("触发按键", "中键触发时会同时禁用浏览器的自动滚动。", "右键", ["右键", "中键"]),
          sw("显示手势轨迹", "绘制过程中在当前窗口显示轨迹与命令名。", true),
          { k: "custom", key: "gesturePad" },
        ],
      },
      {
        t: "会话", icon: "list",
        rows: [
          gest("关闭当前会话", ["D", "R"]),
          gest("新建会话", ["D", "L"]),
        ],
      },
      {
        t: "布局与面板", icon: "layers",
        rows: [
          gest("切换底部终端", ["D"]),
          gest("切换左侧栏", ["L"]),
          gest("切换右侧栏", ["R"]),
        ],
      },
      {
        t: "视图与导航", icon: "globe",
        rows: [
          gest("打开设置", [], { state: "unset" }),
          gest("打开命令面板", [], { state: "unset" }),
        ],
        note: "终端内的右键仍是原生复制/粘贴;弹窗与内嵌浏览器不响应手势。",
      },
    ],
  },

  /* ══ 7 Git ══ */
  {
    id: "git", label: "Git", icon: "git", kind: "form",
    desc: "差异查看方式、提交信息生成与合并冲突解决。",
    sections: [
      {
        t: "差异打开方式", icon: "layers",
        d: "点击 Git 面板中的修改文件时,差异查看器的打开位置。",
        rows: [
          sel("打开方式", "主编辑区会复用中间的编辑列;弹窗编辑器支持同时打开多个标签。", "主编辑区", ["主编辑区", "弹窗编辑器(可多标签)"]),
        ],
      },
      {
        t: "提交信息生成", icon: "sparkles",
        d: "配置用于自动生成提交信息的模型和提示词。",
        rows: [
          sel("生成模型", "留空则不提供生成按钮。", MODEL_OPTIONS[0], ["未选择", ...MODEL_OPTIONS], { wide: true }),
          ta("格式与语言偏好", "会作为系统提示附加在生成请求中。", "使用中文,一句话概括改动,不超过 50 字,不要以句号结尾。", { stack: true, rows: 4 }),
        ],
      },
      {
        t: "冲突解决", icon: "git",
        d: "当 git pull 产生合并冲突时,由该模型协助分析并给出解决建议。",
        rows: [
          sel("解决模型", "留空则冲突面板只提供手动编辑器。", "未选择", ["未选择", ...MODEL_OPTIONS], { wide: true }),
        ],
      },
      {
        t: "工作树", icon: "folderMove",
        d: "托管工作树的存放位置,新建工作树时会在此目录下创建 checkout。",
        rows: [
          path("工作树根目录", "默认放在应用数据目录下,可改到磁盘空间更充裕的位置。", "", { empty: "默认(应用数据目录)", actions: ["浏览…", "恢复默认"], stack: true }),
        ],
      },
    ],
  },

  /* ══ 8 终端 ══ */
  {
    id: "terminal", label: "终端", icon: "terminal", kind: "form",
    desc: "集成终端的 Shell 与按项目保存的自定义命令。",
    sections: [
      {
        t: "终端 Shell", icon: "terminal",
        d: "留空时使用系统默认 Shell(登录 Shell,会加载你的 profile)。",
        rows: [
          { k: "inp", t: "Shell 路径", d: "例如 /bin/zsh、/opt/homebrew/bin/fish。", v: "", ph: "留空使用系统默认", mono: true, stack: true, save: true, saved: "已保存。新建终端将使用此 Shell。" },
        ],
      },
      {
        t: "自定义命令", icon: "list",
        d: "命令按项目保存,可在终端工具栏的一键运行菜单中调用。",
        rows: [
          sel("选择项目", "不同项目的命令互不影响。", "mcode-gui (当前工作区)", ["mcode-gui (当前工作区)", "api-gateway", "docs-site"]),
          { k: "custom", key: "cmdList" },
        ],
      },
    ],
  },

  /* ══ 9 浏览器 ══ */
  {
    id: "browser", label: "浏览器", icon: "globe", kind: "form",
    desc: "截图与浏览器数据的存放位置、登录状态与缓存。",
    sections: [
      {
        t: "存储位置", icon: "folder",
        rows: [
          path("截图目录", "留空时使用系统图片目录。", "~/Pictures/Mcode", { actions: ["选择目录…", "保存"], stack: true, saved: "已保存。后续截图将保存到此目录。" }),
          path("数据目录", "留空时使用应用默认位置。", "", { empty: "应用默认位置(~/Library/…/browser)", actions: ["选择目录…", "保存"], stack: true, note: "修改后需重启应用生效。" }),
        ],
      },
      {
        t: "登录状态", icon: "key",
        rows: [
          sw("记住网站登录状态", "开启后 Cookie 与本地存储会随浏览器数据目录持久化。", true),
        ],
      },
      {
        t: "缓存", icon: "trash",
        d: "清理浏览器缓存可以解决页面显示异常,不影响登录状态。",
        rows: [
          { k: "btns", t: "清除缓存数据", d: "将清除 HTTP 缓存、Service Worker 与 IndexedDB。", btns: [{ lbl: "清除缓存", kind: "danger" }], result: { kind: "a", text: "已清除,登录状态已保留。" } },
        ],
      },
      {
        t: "代理", icon: "globe",
        rows: [
          sw("使用系统代理", "跟随操作系统的代理设置访问网页。", true),
          inp("自定义 User-Agent", "留空使用内置 Chromium 默认值。", "", { ph: "可选", mono: true }),
        ],
      },
    ],
  },

  /* ══ 10 LSP ══ */
  {
    id: "lsp-languages", label: "LSP", icon: "code", kind: "list",
    desc: "语言服务器的安装、启用与路径覆盖。",
    headerAction: "refreshProbe",
    sections: [
      { t: "服务器列表", icon: "code", render: "lsp", d: "语言服务器按项目工作区独立启动,同一语言可多项目并行。" },
    ],
    note: "Java 首次打开会后台导入项目索引,导入期间其余功能可用。",
  },

  /* ══ 11 用量统计 ══ */
  {
    id: "usage", label: "用量统计", icon: "chart", kind: "usage",
    desc: "对话轮次、Token 消耗与模型分布。",
    ranges: ["今天", "最近 7 天", "最近 30 天", "全部"],
    sections: [
      { t: "", render: "summaryCards" },
      { t: "每日用量热力图", icon: "chart", render: "heatmap", d: "按天统计的对话轮次,颜色越深表示当天用得越多。" },
      { t: "模型用量", icon: "robot", render: "modelBars", d: "按 Token 消耗排序,含子代理产生的用量。" },
    ],
    note: "统计来自本地会话数据库,不会上传到任何服务器。",
  },

  /* ══ 12 关于 ══ */
  {
    id: "about", label: "关于", icon: "info", kind: "about",
    desc: "版本、运行环境与更新。",
    render: "about",
  },

  /* ══ 13 模型配置 ══ */
  {
    id: "custom-models", label: "模型配置", icon: "robot", kind: "split",
    desc: "管理各 Agent 引擎的端点、密钥与模型清单。",
    tabs: ["Claude", "Codex", "Pi"],
    entities: {
      Claude: [
        { t: "官方中转", s: "3 个模型 · Bearer", on: true },
        { t: "备用网关", s: "2 个模型 · x-api-key" },
      ],
      Codex: [{ t: "deepseek", s: "1 个模型 · 已配置 Key", on: true }],
      Pi: [
        { t: "deepseek", s: "2 个模型 · openai-completions", on: true },
        { t: "moonshot", s: "1 个模型 · openai-completions" },
        { t: "本地 Ollama", s: "无模型 · 未配置 Key" },
      ],
    },
    entityAddLabel: { Claude: "新建 Claude 端点", Codex: "新建 Codex 端点", Pi: "新建 Pi Provider" },
    masterTitle: "供应商",
    render: "providerForm",
    note: "密钥经系统安全存储加密保存,不会写入配置文件。",
  },

  /* ══ 14 Agent 运行时 ══ */
  {
    id: "runtimes", label: "Agent", icon: "box", kind: "list",
    desc: "Claude / Codex / Pi 运行时的安装来源与版本。",
    sections: [
      { t: "Claude / Codex / Pi", icon: "box", render: "runtimes", d: "运行时按需下载,存放在应用数据目录;开发环境下会优先使用 node_modules 中的副本。" },
    ],
    note: "卸载运行时会让对应 Agent 不可用,直到重新安装。",
  },

  /* ══ 15 插件 ══ */
  {
    id: "plugins", label: "插件", icon: "grid", kind: "list",
    desc: "浏览插件市场,安装并审查插件的组件。",
    tabs: ["已安装", "插件市场"],
    sections: [
      { t: "已安装", icon: "grid", render: "pluginsInstalled" },
      { t: "插件市场", icon: "download", render: "pluginsMarket" },
    ],
    note: "插件启用后自下一回合生效;hooks 当前版本只做展示,不会执行。",
  },

  /* ══ 16 Skills ══ */
  {
    id: "skills", label: "Skills", icon: "sparkles", kind: "split",
    desc: "项目级与全局 Skill 的创建、编辑与导入。",
    entities: {
      "": [
        { t: "commit-message", s: "项目 · 生成规范的提交信息", on: true },
        { t: "pr-review", s: "项目 · 按清单审查改动" },
        { t: "explain-code", s: "全局 · 逐段解释代码意图" },
      ],
    },
    entityAddLabel: { "": "新建 Skill" },
    masterTitle: "Skills",
    render: "skillEditor",
    topBar: "project",
  },

  /* ══ 17 MCP ══ */
  {
    id: "mcp", label: "MCP 服务器", icon: "plug", kind: "list",
    desc: "各作用域下的 MCP 服务器与授权状态。",
    sections: [
      {
        t: "用户级", icon: "plug",
        d: "保存在 Mcode 自己的 Claude 配置(~/.mcode/.claude.json)中,对所有项目生效。",
        render: "mcpUser",
      },
      {
        t: "项目级", icon: "folder",
        d: "来自项目目录下的 .mcp.json,出于安全考虑默认关闭,确认来源后可逐个开启。",
        render: "mcpProject",
      },
      {
        t: "插件", icon: "grid",
        d: "由启用中的插件声明,关闭插件即随之失效。",
        render: "mcpPlugin",
      },
      {
        t: "内置", icon: "shield",
        d: "随应用提供,不可删除。",
        render: "mcpBuiltin",
      },
    ],
    note: "OAuth 授权信息由 MCP 服务器自身管理,取消授权只清除本地令牌。",
  },
];

export const PAGE_BY_ID = Object.fromEntries(PAGES.map((p) => [p.id, p]));
