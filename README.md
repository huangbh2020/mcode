# Mcode

![GitHub release](https://img.shields.io/github/v/release/huangbh2020/mcode?style=flat-square)
![GitHub stars](https://img.shields.io/github/stars/huangbh2020/mcode?style=flat-square)
![License: MIT](https://img.shields.io/badge/license-MIT-green.svg?style=flat-square)
![Electron](https://img.shields.io/badge/Electron-33-47848F?style=flat-square)
![React](https://img.shields.io/badge/React-19-61DAFB?style=flat-square)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square)

**Mcode** — *my* Code. A free, open-source **desktop client for Claude Code / coding agents**.

**English** | [简体中文](README.zh-CN.md)

---

### What is Mcode?

Mcode is a **free, open-source desktop GUI for coding agents** — a three-pane IDE that turns **Claude Code** and other agent platforms into a full-featured desktop application. Built on the official **Claude Agent SDK** and the **Pi Coding Agent SDK**, Mcode does **not** reimplement the agent. It provides the complete interaction surface: session management, **real-time token-by-token streaming**, visual **tool-approval** prompts, **plan mode**, and all the **IDE** affordances you expect — file tree, Monaco editor with 30+ languages, **git**, **terminal**, **embedded browser**, and **LSP** language servers — plus a **mobile companion** for remote control from your phone.

> **Search keywords:** Claude Code GUI · Claude desktop app · open-source Claude client · AI coding agent IDE · Agent SDK desktop UI · tool approval UI

![Mcode home - Claude Code desktop client GUI](docs/images/首页.png)

### Key highlights

- 🎛 **Multi-provider** — Claude and Pi in one app; pick the agent before each session starts
- ⚡ **Real-time streaming** — watch every token arrive as the agent works
- ✅ **Tool approval UI** — allow / always-allow / deny with a per-session pending queue
- 📋 **Plan mode** — the agent researches and presents a plan for your approval before executing
- 🗂 **Projects & sessions** — multi-project management, SQLite persistence, resume anytime
- 🧰 **Full IDE** — Monaco editor (30+ languages), diff view, multi-repo git, multi-tab terminal
- 🌐 **Embedded browser** — element picking + agent-driven browser automation
- 🌍 **Language servers (LSP)** — TypeScript, Python, Go, Java — install and enable in one click
- 📱 **Mobile remote control** — watch, chat, approve, and rewind from your phone (LAN or SSH tunnel)
- 🆓 **MIT licensed** — free forever, no tracking, no account required

### Features

#### 🤖 Multi-provider agents

- Built-in **Claude** provider (`@anthropic-ai/claude-agent-sdk`) and **Pi** provider (`@earendil-works/pi-coding-agent`) — pick one in the composer before the first message of a session.
- Each provider declares its own capabilities and the UI adapts automatically: thinking levels, permission modes, built-in models, custom endpoints.
- Per-role model assignment: normal chat, git commit-message generation, and merge-conflict resolution can each use a different model.

![Mcode supports Claude and Pi agent providers](docs/images/支持claude和pi.png)

#### 💬 Real-time conversation & multi-session

- Drives the agent loop through the chosen provider SDK; messages stream in live, token by token, rendered as structured cards (assistant text, thinking, tool calls, tool results, images).
- Tool-use approvals: allow / always-allow / deny, with a per-session pending queue.
- Plan mode: the agent researches first and presents a plan for your approval before executing.
- Per-turn file snapshots with one-click "rewind this turn" — restores the exact files the agent touched, on any historical turn.
- Attach files, paste images, and use slash commands from the composer.
- Sessions persist to SQLite (via sql.js) and can be resumed later (`--resume` semantics); auto-archiving keeps the session list clean.

![Mcode main pane - live streaming rendering of AI conversation](docs/images/主面板数据流显示.png)

#### 🗂 Projects & sessions in the left sidebar

- Multi-project management with grouping, pinning, reordering, archiving; per-project session history with search.

![Mcode left sidebar - project and session management](docs/images/左侧边栏功能.png)

#### 📁 File tree & editor (right panel)

- File tree of the current project with "agent-touched" markers (new / modified this turn).
- Monaco editor with 30+ languages, dirty-state indicators, and find & replace.
- Three file views: **Edit** (Monaco), **Diff** (Monaco DiffEditor side-by-side), **Preview** (Markdown with syntax highlighting & math, images, friendly binary fallback).
- Context menu (reveal in explorer, copy paths, add to chat) and drag-a-file-into-the-conversation.

<table>
  <tr>
    <td><img src="docs/images/右侧边栏-文件树.png" alt="Mcode right sidebar - file tree"/></td>
    <td><img src="docs/images/文件预览和编辑.png" alt="Mcode file preview and editing"/></td>
  </tr>
</table>

#### 🧰 Git management (multi-repo)

- Recursively discovers **multiple repos** inside one project (monorepos, submodules, nested checkouts) — one card per repo.
- Stage / unstage / discard, line-level diffs in Monaco DiffEditor, branch switcher, history view, per-repo operation log.
- ✨ **AI commit message**: reads the diff and drafts a conventional-commit style message; **AI merge-conflict resolution** offers a guided "resolve with AI" flow after a conflicted pull.

![Mcode right sidebar - multi-repo git management](docs/images/右侧边栏-git管理.png)

#### 🖥 Built-in terminal (bottom)

- Multi-tab terminal (xterm.js + node-pty) with status indicators; switching projects never kills background terminals (keep-alive).
- Per-project custom commands: bookmark your frequent commands and run them with one click.

![Mcode built-in multi-tab terminal at the bottom](docs/images/底部终端.png)

#### 🌐 Embedded browser (right panel)

- Multi-tab browser panel on top of the main window; closing the panel keeps pages alive.
- Device presets (desktop / iPhone / Android) with real viewport & touch emulation.
- 🎯 Element picking: hover, click, and send the element's HTML + stable selector straight into the conversation for the agent to work on.
- The agent itself can also drive the browser (list / navigate / snapshot / click / screenshot) through built-in tools.

![Mcode right sidebar - embedded browser panel](docs/images/右侧边栏-浏览器.png)

#### 🌍 Language servers (LSP)

- Installable and toggleable language servers for TypeScript/JavaScript, Python (basedpyright), Go (gopls), and Java (jdtls).
- Definition / references / hover in Monaco, plus live diagnostics markers as you type.

#### 📱 Mobile companion

- **LAN access**: Mcode serves a companion web app over the local network — scan the QR code on your desktop to pair your phone (device-token auth).
- **Remote access from anywhere**: connect through your own VPS via an SSH reverse tunnel — no third-party tunneling service required.
- The phone is a full remote control: watch sessions stream live, send messages, interrupt or rewind turns, approve tool calls, browse files & diffs, and run git operations (including AI commit messages).

<table>
  <tr>
    <td><img src="docs/images/手机端-局域网连接.png" alt="Mcode mobile - LAN QR-code pairing"/></td>
    <td><img src="docs/images/手机端-远程访问.png" alt="Mcode mobile - VPS remote access"/></td>
  </tr>
</table>

#### ⚙️ Rich settings

**General** — session title generation preferences.

![Mcode settings - general](docs/images/设置面板-常规.png)

**Appearance** — theme, density, and font preferences.

![Mcode settings - appearance](docs/images/设置面板-外观.png)

**Shortcuts** — view and record keyboard shortcuts.

![Mcode settings - shortcuts](docs/images/设置面板-快捷键.png)

**Models** — provider & custom model configuration (OpenAI-compatible endpoints supported).

![Mcode settings - models](docs/images/设置-模型配置.png)

**Skills** — manage agent skills with a built-in SKILL.md editor.

![Mcode settings - skills](docs/images/设置-技能.png)

**Notifications** — toggle notifications per category.

![Mcode settings - notifications](docs/images/设置-消息.png)

**Git** — author identity, diff options, and the model used for AI commit messages.

![Mcode settings - git](docs/images/设置-git.png)

**Terminal** — shell override and per-project custom commands.

![Mcode settings - terminal](docs/images/设置-终端.png)

**Browser** — embedded browser preferences.

![Mcode settings - browser](docs/images/设置-浏览器.png)

**Language servers** — install, enable, and disable LSP servers per language.

![Mcode settings - language servers](docs/images/设置-语言服务器.png)

**About** — version, license, repo links, and manual update check.

![Mcode settings - about and updates](docs/images/设置-关于.png)

#### 🔄 Other

- Auto-update via `electron-updater` (pulls `latest*.yml` from GitHub Releases); manual check in **Settings → About**.
- Provider abstraction layer (`AgentProvider`) — Claude and Pi today, easy to extend to other agent platforms.

### FAQ

**Q: Is Mcode free?**
A: Yes — Mcode is open source under the **MIT license**, free to use and modify.

**Q: Does Mcode work on macOS and Windows?**
A: Yes. Pre-built installers are published for macOS (Apple Silicon + Intel) and Windows (x64). See [Download](#download) below.

**Q: Do I need to install the Claude Code CLI separately?**
A: No. The **Claude Agent SDK** bundles its own `claude` binary and the Pi SDK manages its own runtime — no separate CLI required.

**Q: Which models can I use?**
A: The Claude provider uses your **Anthropic API key**; the Pi provider supports **OpenAI-compatible endpoints**, so you can bring your own models.

**Q: Can I control Mcode from my phone?**
A: Yes — scan the QR code for LAN access, or connect through your own VPS via an **SSH reverse tunnel** for remote access from anywhere.

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

If Mcode helps you, please ⭐ star the project and share it with others — every share helps more people discover it.
