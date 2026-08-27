/**
 * lib area messages. Keys follow the area's prefix convention.
 * zh is the source of truth for `MessageId`.
 */
export const zh = {
  /* ── shared ── */
  "lib.untitledSession": "无标题会话",

  /* ── lib/commands.ts (command palette labels) ── */
  "lib.commands.closeTab": "关闭当前标签页",
  "lib.commands.openPalette": "打开命令面板",
  "lib.commands.displaySingle": "显示模式：单会话",
  "lib.commands.displayTabs": "显示模式：标签页",
  "lib.commands.displayToggle": "切换显示模式",
  "lib.commands.rightPanelFiles": "右栏：文件",
  "lib.commands.searchFiles": "搜索文件",
  "lib.commands.rightPanelGit": "右栏：Git",
  "lib.commands.rightPanelTurns": "右栏：轮次流程",
  "lib.commands.openSettings": "打开设置",
  "lib.commands.navBack": "编辑器：返回上一处",
  "lib.commands.navForward": "编辑器：前往下一处",
  "lib.commands.focusComposer": "聚焦聊天输入框",
  "lib.commands.voiceDictation": "语音输入(按住说话 / 连按开关)",
  "lib.commands.toggleLeft": "切换左侧栏",
  "lib.commands.toggleRight": "切换右侧栏",
  "lib.commands.toggleTerminal": "切换底部终端",
  "lib.commands.toggleBrowser": "切换浏览器面板",
  "lib.commands.openSideChat": "快速问答（不影响当前会话）",
  "lib.commands.toggleWide": "切换宽屏模式 (聊天+面板)",
  "lib.commands.themeLight": "主题：浅色",
  "lib.commands.themeDark": "主题：深色",
  "lib.commands.themeToggle": "切换深/浅主题",
  "lib.commands.switchToSession": "切换到会话：{title}",

  /* ── lib/contextWindow.ts ── */
  "lib.context.title": "上下文占用",
  "lib.context.input": "输入",
  "lib.context.cacheRead": "缓存读取",
  "lib.context.cacheHit": "缓存命中率",
  "lib.context.output": "输出",
  "lib.context.processed": "本轮处理",

  /* ── lib/time.ts ── */
  "lib.time.justNow": "刚刚",
  "lib.time.minutesAgo": "{n} 分钟前",
  "lib.time.hoursAgo": "{n} 小时前",
  "lib.time.daysAgo": "{n} 天前",
  "lib.time.monthsAgo": "{n} 个月前",
  "lib.time.yearsAgo": "{n} 年前",

  /* ── lib/slashCommands.ts (built-in / commands shown in the picker) ── */
  "lib.slash.compact": "压缩对话历史(总结并释放上下文)",
  "lib.slash.init": "生成项目说明文件 AGENTS.md",
  "lib.slash.browser": "用应用内浏览器打开网页(导航/快照/点击/截图)",
  "lib.slash.sidechat": "打开侧边栏快速问答(不影响当前会话)",

  /* ── lib/imageResize.ts (send-time errors surfaced as toasts) ── */
  "lib.image.invalidData": "{name}: 不是有效的图片数据",
  "lib.image.decodeFailed": "{name}: 图片解码失败",
  "lib.image.canvasFailed": "{name}: 无法创建画布",
  "lib.image.compressFailed": "{name}: 图片压缩失败",
  "lib.image.stillTooLarge": "{name}: 压缩后仍然过大,请换一张更小的图片",

  /* ── lib/webApi.ts (phone-side errors) ── */
  "lib.web.pairFailed": "配对失败 ({status})",
  "lib.web.notPaired": "未配对 — 请先在电脑端生成二维码完成配对",
  "lib.web.deviceRevoked": "设备已被电脑端移除 — 请重新配对",
  "lib.web.rpcFailed": "RPC 失败 ({status})",
  "lib.web.timeout": "请求超时（{sec} 秒）— 电脑端可能正在重启或网络不稳定，请稍后重试",
  "lib.web.unavailable": "api.{name} 在移动端不可用",
  "lib.web.pickerFailed": "无法打开文件选择器",
  "lib.web.pasteUnsupported": "移动端不支持粘贴外部文件,仅支持图片",
} as const;
