# Mcode

**English** | [中文](#中文)

---

## English

**Mcode** — *my* Code. A desktop GUI for coding agents: a three-pane IDE built on top of agent SDKs ([Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk) and [Pi Coding Agent](https://pi.dev/)). It does **not** reimplement the agent — it provides the interaction surface: session management, real-time streaming, tool approvals, and full IDE affordances (files, git, terminal, browser), plus a phone companion for remote access.

![首页](docs/images/首页.png)

### Features

#### 🤖 Multi-provider agents

- Built-in **Claude** provider (`@anthropic-ai/claude-agent-sdk`) and **Pi** provider (`@earendil-works/pi-coding-agent`) — pick one in the composer before the first message of a session.
- Each provider declares its own capabilities and the UI adapts automatically: thinking levels, permission modes, built-in models, custom endpoints.
- Per-role model assignment: normal chat, git commit-message generation, and merge-conflict resolution can each use a different model.

![支持claude和pi](docs/images/支持claude和pi.png)

#### 💬 Real-time conversation & multi-session

- Drives the agent loop through the chosen provider SDK; messages stream in live, token by token, rendered as structured cards (assistant text, thinking, tool calls, tool results, images).
- Tool-use approvals: allow / always-allow / deny, with a per-session pending queue.
- Plan mode: the agent researches first and presents a plan for your approval before executing.
- Per-turn file snapshots with one-click "rewind this turn" — restores the exact files the agent touched, on any historical turn.
- Attach files, paste images, and use slash commands from the composer.
- Sessions persist to SQLite (via sql.js) and can be resumed later (`--resume` semantics); auto-archiving keeps the session list clean.

![主面板数据流显示](docs/images/主面板数据流显示.png)

#### 🗂 Projects & sessions in the left sidebar

- Multi-project management with grouping, pinning, reordering, archiving; per-project session history with search.

![左侧边栏功能](docs/images/左侧边栏功能.png)

#### 📁 File tree & editor (right panel)

- File tree of the current project with "agent-touched" markers (new / modified this turn).
- Monaco editor with 30+ languages, dirty-state indicators, and find & replace.
- Three file views: **Edit** (Monaco), **Diff** (Monaco DiffEditor side-by-side), **Preview** (Markdown with syntax highlighting & math, images, friendly binary fallback).
- Context menu (reveal in explorer, copy paths, add to chat) and drag-a-file-into-the-conversation.

<table>
  <tr>
    <td><img src="docs/images/右侧边栏-文件树.png" alt="右侧边栏-文件树"/></td>
    <td><img src="docs/images/文件预览和编辑.png" alt="文件预览和编辑"/></td>
  </tr>
</table>

#### 🧰 Git management (multi-repo)

- Recursively discovers **multiple repos** inside one project (monorepos, submodules, nested checkouts) — one card per repo.
- Stage / unstage / discard, line-level diffs in Monaco DiffEditor, branch switcher, history view, per-repo operation log.
- ✨ **AI commit message**: reads the diff and drafts a conventional-commit style message; **AI merge-conflict resolution** offers a guided "resolve with AI" flow after a conflicted pull.

![右侧边栏-git管理](docs/images/右侧边栏-git管理.png)

#### 🖥 Built-in terminal (bottom)

- Multi-tab terminal (xterm.js + node-pty) with status indicators; switching projects never kills background terminals (keep-alive).
- Per-project custom commands: bookmark your frequent commands and run them with one click.

![底部终端](docs/images/底部终端.png)

#### 🌐 Embedded browser (right panel)

- Multi-tab browser panel on top of the main window; closing the panel keeps pages alive.
- Device presets (desktop / iPhone / Android) with real viewport & touch emulation.
- 🎯 Element picking: hover, click, and send the element's HTML + stable selector straight into the conversation for the agent to work on.
- The agent itself can also drive the browser (list / navigate / snapshot / click / screenshot) through built-in tools.

![右侧边栏-浏览器](docs/images/右侧边栏-浏览器.png)

#### 🌍 Language servers (LSP)

- Installable and toggleable language servers for TypeScript/JavaScript, Python (basedpyright), Go (gopls), and Java (jdtls).
- Definition / references / hover in Monaco, plus live diagnostics markers as you type.

#### 📱 Mobile companion

- **LAN access**: Mcode serves a companion web app over the local network — scan the QR code on your desktop to pair your phone (device-token auth).
- **Remote access from anywhere**: connect through your own VPS via an SSH reverse tunnel — no third-party tunneling service required.
- The phone is a full remote control: watch sessions stream live, send messages, interrupt or rewind turns, approve tool calls, browse files & diffs, and run git operations (including AI commit messages).

<table>
  <tr>
    <td><img src="docs/images/手机端-局域网连接.png" alt="手机端-局域网连接"/></td>
    <td><img src="docs/images/手机端-远程访问.png" alt="手机端-远程访问"/></td>
  </tr>
</table>

#### ⚙️ Rich settings

**General** — session title generation preferences.

![设置面板-常规](docs/images/设置面板-常规.png)

**Appearance** — theme, density, and font preferences.

![设置面板-外观](docs/images/设置面板-外观.png)

**Shortcuts** — view and record keyboard shortcuts.

![设置面板-快捷键](docs/images/设置面板-快捷键.png)

**Models** — provider & custom model configuration (OpenAI-compatible endpoints supported).

![设置-模型配置](docs/images/设置-模型配置.png)

**Skills** — manage agent skills with a built-in SKILL.md editor.

![设置-技能](docs/images/设置-技能.png)

**Notifications** — toggle notifications per category.

![设置-消息](docs/images/设置-消息.png)

**Git** — author identity, diff options, and the model used for AI commit messages.

![设置-git](docs/images/设置-git.png)

**Terminal** — shell override and per-project custom commands.

![设置-终端](docs/images/设置-终端.png)

**Browser** — embedded browser preferences.

![设置-浏览器](docs/images/设置-浏览器.png)

**Language servers** — install, enable, and disable LSP servers per language.

![设置-语言服务器](docs/images/设置-语言服务器.png)

**About** — version, license, repo links, and manual update check.

![设置-关于](docs/images/设置-关于.png)

#### 🔄 Other

- Auto-update via `electron-updater` (pulls `latest*.yml` from GitHub Releases); manual check in **Settings → About**.
- Provider abstraction layer (`AgentProvider`) — Claude and Pi today, easy to extend to other agent platforms.

### Requirements

- Node.js ≥ 22.13 (pnpm 11 requires it)
- pnpm ≥ 9 (`corepack enable && corepack prepare pnpm@latest --activate`)
- **Claude provider**: an Anthropic API key (`ANTHROPIC_API_KEY`) — the Agent SDK bills per API key, not via a Max/Pro subscription.
- **Pi provider**: configure at least one provider/model through **Settings → Models** (equivalent to editing `~/.pi/agent/models.json`). API keys entered there are encrypted with Electron `safeStorage`; no env vars required.

> **Note:** The Claude Agent SDK bundles its own `claude` binary, and the Pi SDK manages its own runtime — you don't need to install any CLI separately.

### Getting started

```bash
pnpm install
pnpm dev
```

### Build & package

```bash
# Type-check
pnpm typecheck

# Build (electron-vite)
pnpm build

# Package installers (macOS dmg/zip + Windows nsis) -> apps/desktop/release/
pnpm package
```

### Download

Pre-built binaries are published on [GitHub Releases](https://github.com/huangbh2020/mcode/releases):

- **macOS**: `.dmg` (arm64 + x64)
- **Windows**: `.exe` NSIS installer (x64)

> ⚠️ **Not code-signed.** Mcode is a free MIT project without a paid Apple Developer ID or a Windows code-signing certificate, so the installers are ad-hoc signed (macOS) / unsigned (Windows). Your OS will warn on first launch — this is expected and safe. See the workarounds below.

#### First-launch notes

**macOS** — Gatekeeper blocks the app with *"Mcode cannot be opened because Apple cannot check it for malicious software"* / *"cannot verify the developer"*:

- **macOS 15 (Sequoia) and earlier**: right-click the app → **Open** → confirm in the dialog.
- **macOS 26+**: right-click → Open no longer works. Open **System Settings → Privacy & Security**, scroll down, and click **Open Anyway**.
- **Terminal (works on all versions)**:
  ```bash
  xattr -dr com.apple.quarantine /Applications/Mcode.app
  ```
- **Homebrew (no warning at all)**: `brew install --cask mcode` — the cask strips the quarantine attribute at install time.

**Windows** — SmartScreen shows *"Windows protected your PC"* / *"Unknown publisher"*:

- Click **More info** → **Run anyway**.
- The installer (NSIS) is per-user and can be installed without administrator rights.

### Tech stack

| Layer | Technology |
|-------|-----------|
| Shell | Electron 33, electron-vite, electron-builder 25 |
| Frontend | React 19, Zustand 5, Tailwind CSS 3, @base-ui/react, @tabler/icons |
| Editor / Terminal | Monaco Editor, xterm.js + node-pty |
| Agent | @anthropic-ai/claude-agent-sdk, @earendil-works/pi-coding-agent |
| Persistence | sql.js (SQLite in pure WASM) |
| Contracts | zod (cross-process IPC validation) |
| Tooling | pnpm 11, Turbo, TypeScript 5 (strict) |

### License

MIT. This project does not redistribute or bundle any agent binary — each SDK manages its own bundled runtime internally (Claude's Agent SDK and Pi's coding-agent SDK both manage their own).

---

## 中文

**Mcode** — *my* Code。基于 Agent SDK 构建的**多 agent 桌面端 GUI**——一个三栏 IDE。目前已接入 **Claude**([Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk))与 **Pi**([Pi Coding Agent](https://pi.dev/))两个 agent 后端。本应用**不重新实现 agent**,只提供交互界面:会话管理、实时流式渲染、工具审批、IDE 能力(文件、Git、终端、浏览器),以及手机端远程访问。

![首页](docs/images/首页.png)

### 功能特性

#### 🤖 多 Agent Provider

- 内置 **Claude**(基于 `@anthropic-ai/claude-agent-sdk`)与 **Pi**(基于 `@earendil-works/pi-coding-agent`)两个 provider,会话首条消息前可在输入框选择。
- 每个 provider 声明自己的能力,UI 自动适配:思考级别、权限模式、内置模型、自定义端点支持。
- 按角色分配模型:普通对话、提交信息生成、合并冲突解决可分别使用不同的模型。

![支持claude和pi](docs/images/支持claude和pi.png)

#### 💬 实时对话与多会话

- 通过所选 provider 的 SDK 驱动 agent loop,消息按 token 实时流式渲染;assistant 消息、思考过程、工具调用、工具结果、图片以**结构化卡片**展示。
- 工具审批:允许 / 始终允许 / 拒绝,每个会话独立维护待审批队列。
- 计划模式(Plan Mode):agent 先只读调研、给出计划等你批准,再动手执行。
- 每轮文件快照 + 一键「撤销本轮」——精确回滚 agent 本轮改过的文件,历史轮次也能撤。
- 输入框支持附加文件、粘贴图片、斜杠命令。
- 会话持久化到 SQLite(基于 sql.js),支持后续续传(`--resume` 语义);自动归档保持会话列表整洁。

![主面板数据流显示](docs/images/主面板数据流显示.png)

#### 🗂 左侧边栏:项目与会话管理

- 多项目管理:分组、置顶、排序、归档;每个项目独立维护会话历史,支持搜索。

![左侧边栏功能](docs/images/左侧边栏功能.png)

#### 📁 右侧边栏:文件树与编辑器

- 当前项目的文件树,带"agent 改动"标记(本轮新建 / 修改的文件一目了然)。
- Monaco 编辑器:30+ 语言支持、脏标记、查找替换。
- 三态文件视图:**编辑**(Monaco)、**Diff**(Monaco DiffEditor 并排对比)、**预览**(Markdown 语法高亮 + 数学公式、图片预览、二进制文件友好提示)。
- 右键菜单(在资源管理器中显示、复制路径、添加到聊天)+ 拖拽文件直接送入对话。

<table>
  <tr>
    <td><img src="docs/images/右侧边栏-文件树.png" alt="右侧边栏-文件树"/></td>
    <td><img src="docs/images/文件预览和编辑.png" alt="文件预览和编辑"/></td>
  </tr>
</table>

#### 🧰 Git 管理(多仓库)

- 递归扫描自动发现一个项目里的**多个仓库**(monorepo、子模块、嵌套工程),每个仓库一张独立卡片。
- 暂存 / 取消暂存 / 丢弃、Monaco 行级 diff、分支切换器、提交历史、每仓操作日志。
- ✨ **AI 生成提交信息**:读取 diff 起草符合 conventional commit 风格的 message;**AI 解决合并冲突**:pull 冲突后提供引导式的"用 AI 解决"流程。

![右侧边栏-git管理](docs/images/右侧边栏-git管理.png)

#### 🖥 底部内置终端

- 多 tab 终端(xterm.js + node-pty),带状态指示灯;切换项目不杀后台终端(keep-alive)。
- 项目级自定义命令:把常用命令存成书签,一键执行。

![底部终端](docs/images/底部终端.png)

#### 🌐 右侧边栏:内置浏览器

- 主窗口之上的多 tab 浏览器面板;关闭面板页面保持存活。
- 设备尺寸模拟(桌面 / iPhone / Android),真实视口 + 触摸仿真。
- 🎯 元素拾取:悬停高亮、点击选中,把元素的 HTML + 稳定选择器直接送入对话交给 agent。
- agent 自己也能驱动浏览器(列出 / 导航 / 快照 / 点击 / 截图)完成网页端调试。

![右侧边栏-浏览器](docs/images/右侧边栏-浏览器.png)

#### 🌍 语言服务器(LSP)

- 可安装、可启停的 TS/JS、Python(basedpyright)、Go(gopls)、Java(jdtls)语言服务器。
- Monaco 内的定义跳转 / 引用 / 悬停,以及实时诊断波浪线。

#### 📱 手机端伴侣

- **局域网连接**:Mcode 在本地网络起一个伴侣 Web 服务,桌面端扫二维码(或手机扫码)完成配对(设备令牌认证)。
- **远程访问**:通过你自己的 VPS 建立 SSH 反向隧道,在任何网络下都能连回桌面端,无需第三方穿透服务。
- 手机是完整的遥控器:实时观看会话流式输出、发送消息、中断或撤销本轮、审批工具调用、浏览文件与 diff、执行 Git 操作(含 AI 生成提交信息)。

<table>
  <tr>
    <td><img src="docs/images/手机端-局域网连接.png" alt="手机端-局域网连接"/></td>
    <td><img src="docs/images/手机端-远程访问.png" alt="手机端-远程访问"/></td>
  </tr>
</table>

#### ⚙️ 丰富的设置

**常规** —— 会话标题生成配置。

![设置面板-常规](docs/images/设置面板-常规.png)

**外观** —— 主题、密度、字体偏好。

![设置面板-外观](docs/images/设置面板-外观.png)

**快捷键** —— 查看与录制键盘快捷键。

![设置面板-快捷键](docs/images/设置面板-快捷键.png)

**模型配置** —— provider 与自定义模型配置(支持 OpenAI 协议端点)。

![设置-模型配置](docs/images/设置-模型配置.png)

**技能** —— 管理 agent 技能,内置 SKILL.md 编辑器。

![设置-技能](docs/images/设置-技能.png)

**消息通知** —— 按类别开关消息通知。

![设置-消息](docs/images/设置-消息.png)

**Git** —— 作者身份、diff 选项、AI 生成提交信息所用模型。

![设置-git](docs/images/设置-git.png)

**终端** —— Shell 覆盖与项目级自定义命令。

![设置-终端](docs/images/设置-终端.png)

**浏览器** —— 内置浏览器偏好设置。

![设置-浏览器](docs/images/设置-浏览器.png)

**语言服务器** —— 按语言安装、启用、停用 LSP 服务器。

![设置-语言服务器](docs/images/设置-语言服务器.png)

**关于** —— 版本、许可证、仓库链接、手动检查更新。

![设置-关于](docs/images/设置-关于.png)

#### 🔄 其他

- 自动更新:通过 `electron-updater` 从 GitHub Releases 拉 `latest*.yml`;也可在**设置 → 关于**手动检查。
- Provider 抽象层(`AgentProvider`)——目前内置 Claude 与 Pi,易于扩展其他 agent 平台。

### 环境要求

- Node.js ≥ 22.13(pnpm 11 要求)
- pnpm ≥ 9(`corepack enable && corepack prepare pnpm@latest --activate`)
- **Claude provider**:Anthropic API key(`ANTHROPIC_API_KEY`)——Agent SDK 按 API key 计费,不能使用 Max/Pro 订阅。
- **Pi provider**:通过**设置 → 模型配置**至少配置一个 provider/模型(等价于编辑 `~/.pi/agent/models.json`)。在 GUI 中填写的 API key 使用 Electron `safeStorage` 加密存储,无需设置环境变量。

> **注意**:Claude Agent SDK 自带 `claude` 二进制,Pi SDK 也自行管理其运行时,均无需单独安装 CLI。

### 快速开始

```bash
pnpm install
pnpm dev
```

### 构建与打包

```bash
# 类型检查
pnpm typecheck

# 构建(electron-vite)
pnpm build

# 打包安装包(macOS dmg/zip + Windows nsis)-> apps/desktop/release/
pnpm package
```

### 下载

预编译二进制发布在 [GitHub Releases](https://github.com/huangbh2020/mcode/releases):

- **macOS**:`.dmg`(arm64 + x64)
- **Windows**:`.exe` NSIS 安装包(x64)

> ⚠️ **未代码签名。** Mcode 是免费的 MIT 开源项目,没有付费的 Apple Developer ID 证书,也没有 Windows 代码签名证书,因此安装包仅做了 ad-hoc 签名(macOS)/未签名(Windows)。首次启动时系统会弹出安全提示,属正常现象,可放心使用。下面是首次启动的处理方法。

#### 首次启动注意事项

**macOS** —— Gatekeeper 会拦截并提示 *"无法打开 Mcode,因为无法验证开发者"* / *"Apple 无法检查其是否包含恶意软件"*:

- **macOS 15(Sequoia)及更早版本**:右键点击应用 → **打开** → 在弹窗中确认。
- **macOS 26 及以上**:右键 → 打开已失效。请打开 **系统设置 → 隐私与安全性**,滚动到底部,点击 **仍要打开**。
- **终端命令(所有版本通用)**:
  ```bash
  xattr -dr com.apple.quarantine /Applications/Mcode.app
  ```
- **Homebrew(完全不提示)**:`brew install --cask mcode` —— cask 在安装时会自动去除 quarantine 属性。

**Windows** —— SmartScreen 会提示 *"Windows 已保护你的电脑"* / *"未知发布者"*:

- 点击 **更多信息** → **仍要运行**。
- 安装包(NSIS)为每用户安装,无需管理员权限。

### 技术栈

| 层 | 技术 |
|----|------|
| 壳层 | Electron 33、electron-vite、electron-builder 25 |
| 前端 | React 19、Zustand 5、Tailwind CSS 3、@base-ui/react、@tabler/icons |
| 编辑器/终端 | Monaco Editor、xterm.js + node-pty |
| Agent | @anthropic-ai/claude-agent-sdk、@earendil-works/pi-coding-agent |
| 持久化 | sql.js(纯 WASM 的 SQLite) |
| 契约 | zod(跨进程 IPC 校验) |
| 工具链 | pnpm 11、Turbo、TypeScript 5(strict) |

### 许可证

MIT。本项目不重新分发或内嵌任何 agent 二进制——各 SDK 自行管理其运行时(Claude Agent SDK 与 Pi coding-agent SDK 均如此)。
