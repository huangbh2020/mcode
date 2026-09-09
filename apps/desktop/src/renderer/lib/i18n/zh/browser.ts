/**
 * browser area messages. Keys follow the area's prefix convention.
 * zh is the source of truth for `MessageId`.
 */
export const zh = {
  /* ── tab strip ── */
  "browser.newTab": "新标签页",
  "browser.createTab": "新建标签页",
  "browser.closeTabAria": "关闭标签页",

  /* ── toolbar ── */
  "browser.backToWorkspace": "返回工作台",
  "browser.switchToSidebar": "切换到侧边栏",
  "browser.expandFullscreen": "展开为 PC 全屏",
  "browser.back": "后退",
  "browser.forward": "前进",
  "browser.addressPlaceholder": "输入网址、本地文件路径或搜索…",
  "browser.history": "历史记录",
  "browser.removeHistoryEntry": "删除该记录",
  "browser.clearHistory": "清空历史记录…",
  "browser.exitPick": "退出元素选择",
  "browser.pickElement": "选择页面元素",
  "browser.collapseDeviceToolbar": "收起设备工具栏",
  "browser.deviceToolbar": "设备工具栏 (切换尺寸)",
  "browser.moreMenu": "更多",
  "browser.bookmarks": "收藏",
  "browser.bookmarkPage": "收藏此页",
  "browser.unbookmarkPage": "取消收藏此页",
  "browser.bookmarkEmpty": "暂无收藏",
  "browser.removeBookmark": "删除该收藏",
  "browser.historyEmpty": "暂无历史记录",
  "browser.openInNewTab": "在新标签页打开",
  "browser.today": "今天",
  "browser.yesterday": "昨天",
  "browser.earlier": "更早",
  "browser.downloads": "下载",
  "browser.downloadActive": "{n} 项下载中",
  "browser.privacy": "隐私与缓存",
  "browser.clearCache": "清除浏览缓存…",
  "browser.clearCookies": "清除登录状态(Cookie)…",
  "browser.clearCookiesConfirm": "将退出所有网站的登录状态,并清空记忆的登录信息,重启后不会恢复。确定继续?",

  /* ── panel ── */
  "browser.selectProjectFirst": "请先选择一个项目",
  "browser.pickSidebarHint": "点击页面元素直接添加到输入框 · 按 Esc 退出",
  "browser.pickOverlayHint": "点击页面元素以添加到输入框 · 按 Esc 退出",
  "browser.addedToInput": "已添加到输入框",
  "browser.pickedToList": "已拾取到列表",

  /* ── basic auth prompt ── */
  "browser.authTitle": "需要登录 — {host}",
  "browser.authDesc": "站点 {origin} 请求用户名和密码（HTTP Basic Auth）。",
  "browser.username": "用户名",
  "browser.password": "密码",
  "browser.signIn": "登录",

  /* ── device toolbar ── */
  "browser.device": "设备",
  "browser.desktopDevice": "桌面端",
  "browser.customDevice": "自定义",
  "browser.fullWidth": "全宽",
  "browser.deviceTitle": "设备: {label} {dims}",
  "browser.customWidthTitle": "自定义宽度 (px)",
  "browser.customWidthAria": "自定义宽度",
  "browser.customHeightTitle": "自定义高度 (px)",
  "browser.customHeightAria": "自定义高度",
  "browser.rotateToPortrait": "切换为竖屏",
  "browser.rotateToLandscape": "切换为横屏",
  "browser.collapse": "收起",

  /* ── picked elements bar ── */
  "browser.pickedCount": "已拾取 {n} 个元素",
  "browser.clearPickedHint": "清空拾取列表",
  "browser.clear": "清空",
  "browser.add": "添加",
  "browser.addAndReturn": "添加到输入框并返回主面板",

  /* ── download bar ── */
  "browser.downloadBarLabel": "下载",
  "browser.downloadStateProgressing": "下载中",
  "browser.downloadStateCompleted": "已完成",
  "browser.downloadStateCancelled": "已取消",
  "browser.downloadStateInterrupted": "已中断",
  "browser.downloadOpenFile": "打开文件",
  "browser.downloadRevealFolder": "在文件夹中显示",
  "browser.downloadDismiss": "移除",
} as const;
