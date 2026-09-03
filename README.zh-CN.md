# Mcode

![GitHub release](https://img.shields.io/github/v/release/huangbh2020/mcode?style=flat-square)
![GitHub stars](https://img.shields.io/github/stars/huangbh2020/mcode?style=flat-square)
![License: MIT](https://img.shields.io/badge/license-MIT-green.svg?style=flat-square)
![Electron](https://img.shields.io/badge/Electron-33-47848F?style=flat-square)
![React](https://img.shields.io/badge/React-19-61DAFB?style=flat-square)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square)

**Mcode** — *my* Code. 免费开源的 **Claude Code / 编程 Agent 桌面客户端**。

[English](README.md) | **简体中文**

---

### Mcode 是什么？

**Mcode** 是一款免费开源的 **AI 编程助手桌面客户端**——一个基于 Agent SDK 构建的**三栏 IDE**，把 **Claude Code** 与 **Pi** 等 agent 平台放进一个完整的桌面应用。Mcode 依托官方的 [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk) 与 [Pi Coding Agent](https://pi.dev/)，**不重新实现 agent**，只提供完整的交互界面：会话管理、**实时流式渲染**、可视化**工具审批**、**计划模式**，以及文件树、Monaco 编辑器（30+ 语言）、**Git**、**终端**、**内置浏览器**、**语言服务器（LSP）**等全套 IDE 能力，并支持**手机端远程控制**。

> **搜索关键词：** Claude Code 桌面版 · Claude 客户端 · 开源 AI IDE · AI 编程助手 · Agent SDK 桌面应用 · 工具审批 UI

![Mcode 首页 - AI 编程助手桌面客户端主界面](docs/images/首页.png)

### 核心亮点

- 🎛 **多 Agent 支持** —— Claude 与 Pi 二合一，会话前自由切换
- ⚡ **实时流式输出** —— agent 的每一个 token 实时呈现
- ✅ **工具审批界面** —— 允许 / 始终允许 / 拒绝，按会话维护待审批队列
- 📋 **计划模式** —— 先只读调研、给出计划等你批准，再动手执行
- 🗂 **项目与多会话** —— 多项目管理、SQLite 持久化、随时续传
- 🧰 **全套 IDE** —— Monaco 编辑器（30+ 语言）、diff 对比、多仓库 Git、多标签终端
- 🌐 **内置浏览器** —— 元素拾取 + agent 自动驱动浏览器
- 🌍 **语言服务器（LSP）** —— TypeScript / Python / Go / Java 一键安装启用
- 📱 **手机端遥控** —— 手机上看会话、发消息、审批、撤销（局域网 / SSH 隧道）
- 🆓 **MIT 开源** —— 永久免费，无追踪、无账号

### 功能特性

#### 🤖 多 Agent Provider

- 内置 **Claude**（基于 `@anthropic-ai/claude-agent-sdk`）与 **Pi**（基于 `@earendil-works/pi-coding-agent`）两个 provider，会话首条消息前可在输入框选择。
- 每个 provider 声明自己的能力，UI 自动适配：思考级别、权限模式、内置模型、自定义端点支持。
- 按角色分配模型：普通对话、提交信息生成、合并冲突解决可分别使用不同的模型。

![Mcode 支持 Claude 与 Pi 双 agent 后端](docs/images/支持claude和pi.png)

#### 💬 实时对话与多会话

- 通过所选 provider 的 SDK 驱动 agent loop，消息按 token 实时流式渲染；assistant 消息、思考过程、工具调用、工具结果、图片以**结构化卡片**展示。
- 工具审批：允许 / 始终允许 / 拒绝，每个会话独立维护待审批队列。
- 计划模式（Plan Mode）：agent 先只读调研、给出计划等你批准，再动手执行。
- 每轮文件快照 + 一键「撤销本轮」——精确回滚 agent 本轮改过的文件，历史轮次也能撤。
- 输入框支持附加文件、粘贴图片、斜杠命令。
- 会话持久化到 SQLite（基于 sql.js），支持后续续传（`--resume` 语义）；自动归档保持会话列表整洁。

![Mcode 主面板 - AI 对话实时流式数据渲染](docs/images/主面板数据流显示.png)

#### 🗂 左侧边栏：项目与会话管理

- 多项目管理：分组、置顶、排序、归档；每个项目独立维护会话历史，支持搜索。

![Mcode 左侧边栏 - 项目与会话管理](docs/images/左侧边栏功能.png)

#### 📁 右侧边栏：文件树与编辑器

- 当前项目的文件树，带"agent 改动"标记（本轮新建 / 修改的文件一目了然）。
- Monaco 编辑器：30+ 语言支持、脏标记、查找替换。
- 三态文件视图：**编辑**（Monaco）、**Diff**（Monaco DiffEditor 并排对比）、**预览**（Markdown 语法高亮 + 数学公式、图片预览、二进制文件友好提示）。
- 右键菜单（在资源管理器中显示、复制路径、添加到聊天）+ 拖拽文件直接送入对话。

<table>
  <tr>
    <td><img src="docs/images/右侧边栏-文件树.png" alt="Mcode 右侧边栏-文件树"/></td>
    <td><img src="docs/images/文件预览和编辑.png" alt="Mcode 文件预览和编辑"/></td>
  </tr>
</table>

#### 🧰 Git 管理（多仓库）

- 递归扫描自动发现一个项目里的**多个仓库**（monorepo、子模块、嵌套工程），每个仓库一张独立卡片。
- 暂存 / 取消暂存 / 丢弃、Monaco 行级 diff、分支切换器、提交历史、每仓操作日志。
- ✨ **AI 生成提交信息**：读取 diff 起草符合 conventional commit 风格的 message；**AI 解决合并冲突**：pull 冲突后提供引导式的"用 AI 解决"流程。

![Mcode 右侧边栏 - 多仓库 Git 管理界面](docs/images/右侧边栏-git管理.png)

#### 🖥 底部内置终端

- 多 tab 终端（xterm.js + node-pty），带状态指示灯；切换项目不杀后台终端（keep-alive）。
- 项目级自定义命令：把常用命令存成书签，一键执行。

![Mcode 底部内置多标签终端](docs/images/底部终端.png)

#### 🌐 右侧边栏：内置浏览器

- 主窗口之上的多 tab 浏览器面板；关闭面板页面保持存活。
- 设备尺寸模拟（桌面 / iPhone / Android），真实视口 + 触摸仿真。
- 🎯 元素拾取：悬停高亮、点击选中，把元素的 HTML + 稳定选择器直接送入对话交给 agent。
- agent 自己也能驱动浏览器（列出 / 导航 / 快照 / 点击 / 截图）完成网页端调试。

![Mcode 右侧边栏 - 内置浏览器面板](docs/images/右侧边栏-浏览器.png)

#### 🌍 语言服务器（LSP）

- 可安装、可启停的 TS/JS、Python（basedpyright）、Go（gopls）、Java（jdtls）语言服务器。
- Monaco 内的定义跳转 / 引用 / 悬停，以及实时诊断波浪线。

#### 📱 手机端伴侣

- **局域网连接**：Mcode 在本地网络起一个伴侣 Web 服务，桌面端扫码（或手机扫码）完成配对（设备令牌认证）。
- **远程访问**：通过你自己的 VPS 建立 SSH 反向隧道，在任何网络下都能连回桌面端，无需第三方穿透服务。
- 手机是完整的遥控器：实时观看会话流式输出、发送消息、中断或撤销本轮、审批工具调用、浏览文件与 diff、执行 Git 操作（含 AI 生成提交信息）。

<table>
  <tr>
    <td><img src="docs/images/手机端-局域网连接.png" alt="Mcode 手机端 - 局域网扫码连接"/></td>
    <td><img src="docs/images/手机端-远程访问.png" alt="Mcode 手机端 - VPS 远程访问"/></td>
  </tr>
</table>

#### ⚙️ 丰富的设置

**常规** —— 会话标题生成配置。

![Mcode 设置面板 - 常规设置](docs/images/设置面板-常规.png)

**外观** —— 主题、密度、字体偏好。

![Mcode 设置面板 - 外观主题](docs/images/设置面板-外观.png)

**快捷键** —— 查看与录制键盘快捷键。

![Mcode 设置面板 - 快捷键设置](docs/images/设置面板-快捷键.png)

**模型配置** —— provider 与自定义模型配置（支持 OpenAI 协议端点）。

![Mcode 设置 - 模型配置](docs/images/设置-模型配置.png)

**技能** —— 管理 agent 技能，内置 SKILL.md 编辑器。

![Mcode 设置 - 技能管理](docs/images/设置-技能.png)

**消息通知** —— 按类别开关消息通知。

![Mcode 设置 - 消息通知](docs/images/设置-消息.png)

**Git** —— 作者身份、diff 选项、AI 生成提交信息所用模型。

![Mcode 设置 - Git 配置](docs/images/设置-git.png)

**终端** —— Shell 覆盖与项目级自定义命令。

![Mcode 设置 - 终端配置](docs/images/设置-终端.png)

**浏览器** —— 内置浏览器偏好设置。

![Mcode 设置 - 浏览器配置](docs/images/设置-浏览器.png)

**语言服务器** —— 按语言安装、启用、停用 LSP 服务器。

![Mcode 设置 - 语言服务器 LSP 配置](docs/images/设置-语言服务器.png)

**关于** —— 版本、许可证、仓库链接、手动检查更新。

![Mcode 设置 - 关于与更新](docs/images/设置-关于.png)

#### 🔄 其他

- 自动更新：通过 `electron-updater` 从 GitHub Releases 拉 `latest*.yml`；也可在**设置 → 关于**手动检查。
- Provider 抽象层（`AgentProvider`）——目前内置 Claude 与 Pi，易于扩展其他 agent 平台。

### 常见问题

**Q：Mcode 免费吗？**
A：免费。Mcode 采用 **MIT 开源协议**，可自由使用和修改。

**Q：支持 macOS 和 Windows 吗？**
A：支持。已发布 macOS（Apple Silicon + Intel）与 Windows（x64）安装包，见下方[下载](#下载)。

**Q：需要单独安装 Claude Code CLI 吗？**
A：不需要。**Claude Agent SDK** 自带 `claude` 二进制，Pi SDK 也自行管理运行时，无需单独安装 CLI。

**Q：可以用哪些模型？**
A：Claude provider 使用你的 **Anthropic API key**；Pi provider 支持 **OpenAI 协议端点**，可以接入自有模型。

**Q：手机能控制 Mcode 吗？**
A：可以。局域网内扫码即可连接；也可以用自己的 VPS 建立 **SSH 反向隧道**，实现任何网络下的远程访问。

### 环境要求

- Node.js ≥ 22.13（pnpm 11 要求）
- pnpm ≥ 9（`corepack enable && corepack prepare pnpm@latest --activate`）
- **Claude provider**：Anthropic API key（`ANTHROPIC_API_KEY`）——Agent SDK 按 API key 计费，不能使用 Max/Pro 订阅。
- **Pi provider**：通过**设置 → 模型配置**至少配置一个 provider/模型（等价于编辑 `~/.pi/agent/models.json`）。在 GUI 中填写的 API key 使用 Electron `safeStorage` 加密存储，无需设置环境变量。

> **注意**：Claude Agent SDK 自带 `claude` 二进制，Pi SDK 也自行管理其运行时，均无需单独安装 CLI。

### 快速开始

```bash
pnpm install
pnpm dev
```

### 构建与打包

```bash
# 类型检查
pnpm typecheck

# 构建（electron-vite）
pnpm build

# 打包安装包（macOS dmg/zip + Windows nsis）-> apps/desktop/release/
pnpm package
```

### 下载

预编译二进制发布在 [GitHub Releases](https://github.com/huangbh2020/mcode/releases)：

- **macOS**：`.dmg`（arm64 + x64）
- **Windows**：`.exe` NSIS 安装包（x64）

> ⚠️ **未代码签名。** Mcode 是免费的 MIT 开源项目，没有付费的 Apple Developer ID 证书，也没有 Windows 代码签名证书，因此安装包仅做了 ad-hoc 签名（macOS）/ 未签名（Windows）。首次启动时系统会弹出安全提示，属正常现象，可放心使用。下面是首次启动的处理方法。

#### 首次启动注意事项

**macOS** —— Gatekeeper 会拦截并提示 *"无法打开 Mcode，因为无法验证开发者"* / *"Apple 无法检查其是否包含恶意软件"*：

- **macOS 15（Sequoia）及更早版本**：右键点击应用 → **打开** → 在弹窗中确认。
- **macOS 26 及以上**：右键 → 打开已失效。请打开 **系统设置 → 隐私与安全性**，滚动到底部，点击 **仍要打开**。
- **终端命令（所有版本通用）**：
  ```bash
  xattr -dr com.apple.quarantine /Applications/Mcode.app
  ```
- **Homebrew（完全不提示）**：`brew install --cask mcode` —— cask 在安装时会自动去除 quarantine 属性。

**Windows** —— SmartScreen 会提示 *"Windows 已保护你的电脑"* / *"未知发布者"*：

- 点击 **更多信息** → **仍要运行**。
- 安装包（NSIS）为每用户安装，无需管理员权限。

### 技术栈

| 层 | 技术 |
|----|------|
| 壳层 | Electron 33、electron-vite、electron-builder 25 |
| 前端 | React 19、Zustand 5、Tailwind CSS 3、@base-ui/react、@tabler/icons |
| 编辑器/终端 | Monaco Editor、xterm.js + node-pty |
| Agent | @anthropic-ai/claude-agent-sdk、@earendil-works/pi-coding-agent |
| 持久化 | sql.js（纯 WASM 的 SQLite） |
| 契约 | zod（跨进程 IPC 校验） |
| 工具链 | pnpm 11、Turbo、TypeScript 5（strict） |

### 许可证

MIT。本项目不重新分发或内嵌任何 agent 二进制——各 SDK 自行管理其运行时（Claude Agent SDK 与 Pi coding-agent SDK 均如此）。

### 交流群

欢迎加入 Mcode 微信交流群——使用疑问、问题反馈、功能讨论都可以在群里聊，微信扫码即可加入：

![Mcode 微信交流群二维码](docs/images/沟通群二维码.png)

> 群二维码有时效，如提示已过期或已满员，请提 [issue](https://github.com/huangbh2020/mcode/issues) 联系我们。

---

如果 Mcode 帮到了你，欢迎 ⭐ Star 这个项目，并把链接分享给需要的人——你的每一次分享都是在帮开源项目被更多人发现。
