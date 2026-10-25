# Mcode Connector(真实 Chrome 接入扩展)

把 Mcode 的 agent 浏览器工具接到**这个 Chrome**——你的真实登录态(邮箱/内网/GitHub…),
而不是 Mcode 内嵌的隔离浏览器。通信走本机回环 WebSocket(Mcode 主进程监听
`127.0.0.1`),命令仅限白名单(导航/求值/截图/标签管理),新域名访问仍会在 Mcode
里逐域弹出审批。

## 安装(开发期,加载已解压扩展)

1. Mcode → 设置 → 浏览器 → 「真实 Chrome」:打开开关,记下**端口**与**配对令牌**。
2. Chrome 打开 `chrome://extensions`,右上角开「开发者模式」。
3. 「加载已解压的扩展程序」→ 选择本目录(`extension/mcode-connector`)。
4. 点击工具栏的 Mcode Connector 图标:
   - 服务地址填 `ws://127.0.0.1:<端口>`
   - 配对令牌粘贴 Mcode 显示的令牌
   - 保存并连接 → 显示「已连接」即成。
5. 在 Mcode 里让 agent 用 `browser_navigate(backend:"chrome")` 试试。

## 注意

- Chrome 顶部会出现「Mcode Connector 已开始调试此浏览器」的横幅——这是
  `chrome.debugger`(CDP)的强制提示,属于正常现象;点「取消」会断开当前标签页的控制。
- 重置令牌(Mcode 设置里)会立即断开连接,需重新粘贴新令牌。
- 一个 Mcode 实例只接受一个扩展连接。

## 文件

- `manifest.json` — MV3 清单(debugger/tabs/storage 权限)
- `background.js` — service worker:WS 客户端 + CDP 命令桥
  (`Target.*` 翻译成 chrome.tabs API,其余经 chrome.debugger 发到指定标签页)
- `popup.html` / `popup.js` — 配对配置与连接状态
