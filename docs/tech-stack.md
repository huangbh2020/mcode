# 技术栈文档

> Mcode — 基于 Claude Agent SDK 的桌面端 GUI
>
> 本文档记录项目**实际使用**的技术栈与依赖,以及关键的技术决策与踩坑记录。所有版本号来自 `package.json`,与实际安装一致。

---

## 一、整体定位

| 维度 | 选型 |
|------|------|
| 应用形态 | Electron 桌面应用(三栏 IDE 布局) |
| 核心理念 | **不重新实现 agent,只做 Claude 的交互界面**。通过 Agent SDK(封装了 claude 原生的 agent loop)驱动,本项目提供会话管理、流式渲染、工具审批、IDE 能力 |
| 与 Claude 的关系 | 使用 `@anthropic-ai/claude-agent-sdk` 驱动(内部仍 spawn 打包的二进制,由 SDK 管理);项目自身 MIT,可独立开源 |
| 架构参考 | [Synara](https://github.com/Emanuele-web04/synara) 的分层设计(provider adapter、归一化 runtime 事件、IPC 边界),但用**主流 TS**重写(无 effect-ts、无 bun) |
| 扩展性 | 内置 `AgentProvider` 抽象层 + `ProviderRegistry`,后续扩展其他 agent 平台(OpenAI Codex、Gemini CLI 等)只需实现接口并注册

---

## 二、进程架构(三进程分层)

```
┌─────────────────────────────────────────────────────────────┐
│  Renderer 进程 (React 19 + Vite)                            │
│  contextIsolation: true, nodeIntegration: false             │
│  ┌──────────┬───────────────────┬────────────────────────┐  │
│  │ 左栏     │  中栏(聊天)       │  右栏(IDE)             │  │
│  │ 项目/会话│  消息流/输入框     │  文件/git/终端/浏览器   │  │
│  └──────────┴───────────────────┴────────────────────────┘  │
├─────────────────────────────────────────────────────────────┤
│  Preload (contextBridge.exposeInMainWorld)                  │
│  只暴露白名单 RPC 句柄,所有消息经 zod 校验                  │
├─────────────────────────────────────────────────────────────┤
│  Main 进程 (Node.js)                                        │
│  ┌──────────────┬────────────────┬─────────────────────┐   │
│  │RuntimeManager│ SessionManager │  IDE Services        │   │
│  │(持ProviderReg│ (SQLite 持久化)│  terminal/git/diff   │   │
│  │ istry)       │                │                      │   │
│  ├──────────────┴────────────────┴─────────────────────┤   │
│  │ AgentProvider (claude-sdk / codex / gemini / ...)   │   │
│  │ ClaudeAgentSdkProvider: query() → stream → emit     │   │
│  └─────────────────────────────────────────────────────┘   │
│          │ @anthropic-ai/claude-agent-sdk (query)           │
└──────────┼──────────────────────────────────────────────────┘
           ▼
      SDK 内打包的 claude 原生二进制
```

**为什么三进程而非像 Synara 那样再拆出独立 server 进程**:Synara 拆独立 server 是为了支持 9 个 provider 和多客户端。本项目只需 claude 一个 provider,Electron 主进程内直接持有 `ClaudeRuntime` 即可——少一层进程边界 = 少一层 WebSocket = 更简单更快。架构上预留了"可拆出独立 server"的接口,但默认不拆。

---

## 三、技术栈总览

### 3.1 工具链

| 工具 | 版本 | 用途 |
|------|------|------|
| **Node.js** | ≥ 22.13(pnpm 11 要求,本机 v25.9.0) | 运行时 |
| **pnpm** | ≥ 9(本机 11.16.0,经 corepack 启用) | 包管理 + workspace |
| **Turbo** | ^2.9 | monorepo 任务编排(dev/build/test/typecheck 并行) |
| **TypeScript** | ^5.7 | 全量 TS,strict 模式 |

### 3.2 桌面壳层(apps/desktop)

| 依赖 | 版本 | 角色 |
|------|------|------|
| **Electron** | ^33 | 跨平台桌面运行时 |
| **electron-vite** | ^2.3 | 统一 main/preload/renderer 三路构建,HMR |
| **electron-builder** | ^25 | 打包成安装包(P6) |

### 3.3 前端(apps/desktop/src/renderer)

| 依赖 | 版本 | 角色 |
|------|------|------|
| **React** | ^19 | UI 框架 |
| **react-dom** | ^19 | React 渲染器 |
| **Zustand** | ^5.0 | 本地状态管理(会话、消息流、UI 状态) |
| **Vite** | ^6 | 构建 + HMR |
| **@vitejs/plugin-react** | ^4.3 | Vite 的 React 支持(Fast Refresh) |
| **Tailwind CSS** | ^3.4 | 原子化 CSS |
| **autoprefixer** / **postcss** | ^10.4 / ^8.4 | Tailwind 配套 |
| **@base-ui/react** | ^1.5 | 无头 UI 组件库(Radix UI 继任者) |
| **@tabler/icons-react** | ^3.44 | 主图标库(Tabler Icons) |
| **react-icons** | ^5.6 | 辅助图标库(Phosphor/Remix/VS Code/SI 等) |
| **class-variance-authority** | ^0.7 | `cva()` variant 管理 |
| **tailwind-merge** / **clsx** | ^3.6 / ^2.1 | 合并 Tailwind class 的 `cn()` 工具 |

> **TanStack Router / Query、Lexical** 等在总体方案中规划,但**当前尚未安装**。Monaco / xterm / react-markdown / node-pty 已随 P4 引入。组件库(`@base-ui/react`)和图标库(`@tabler/icons-react`)已安装可用。

### 3.4 共享契约(packages/contracts)

| 依赖 | 版本 | 角色 |
|------|------|------|
| **zod** | ^3.24 | 跨进程 IPC 消息的运行时 schema 校验(安全边界) |

`contracts` 是 **source-only workspace 包**(无构建产物),main 和 renderer 都通过 `@contracts/*` 别名直接引源码,类型零漂移。

---

## 四、目录结构

```
mcode/
├── package.json              # workspace 根(turbo + pnpm)
├── pnpm-workspace.yaml       # workspace 包定义 + onlyBuiltDependencies
├── turbo.json                # 任务编排
├── tsconfig.base.json        # 共享 TS 配置(strict, ESNext, bundler)
├── .npmrc                    # 国内 electron 镜像(关键,见踩坑)
├── docs/                     # ← 本文档所在
├── packages/
│   └── contracts/            # 共享类型 + zod schema(无运行时逻辑)
│       └── src/
│           ├── runtime.ts    # RuntimeEvent 联合(provider 中立,claude 流事件归一化)
│           ├── session.ts    # Project / Session / Message 领域类型
│           ├── ipc.ts        # zod schema + IPC 通道常量 + RPC 类型表
│           ├── provider.ts   # AgentProvider 接口 / ProviderContext / TurnHandle
│           └── index.ts
└── apps/
    └── desktop/
        ├── electron.vite.config.ts   # 三路构建配置
        ├── tailwind.config.js
        ├── postcss.config.js
        └── src/
            ├── main/                 # 主进程(Node.js)
            │   ├── index.ts          # app 生命周期 + 单实例锁 + CSP(prod)
            │   ├── window.ts         # 窗口创建 + 控制台转发
            │   ├── utils.ts          # is.dev / uid()
│   ├── lib/logger.ts     # 文件+stderr 日志
│   ├── claude/
│   │   ├── RuntimeManager.ts       # 会话↔provider 映射
│   │   └── ApprovalBridge.ts       # 工具审批/AskUserQuestion IPC 桥接
│   ├── providers/
│   │   ├── registry.ts             # ProviderRegistry 单例
│   │   └── claude-sdk/
	            │   │       ├── ClaudeAgentSdkProvider.ts  # AgentProvider 实现(query 包装)
	            │   │       ├── SdkMessageAdapter.ts       # SDKMessage → RuntimeEvent 归一化
	            │   │       └── index.ts
	            │   ├── ipc/
	            │   │   ├── index.ts      # 注册所有 handler
	            │   │   ├── claude.ts     # 会话/turn/interrupt/approve/healthCheck/provider.list
	            │   │   └── projects.ts   # 项目 CRUD
	            │   └── store/            # SQLite 持久化(sql.js, repositories)
            ├── preload/
            │   └── index.ts          # contextBridge 白名单 API
            └── renderer/             # 前端(React)
                ├── App.tsx
                ├── stores/sessionStore.ts   # Zustand 核心 store
                ├── hooks/useClaudeEvents.ts # 订阅 IPC 事件流
                ├── lib/api.ts               # window.api 类型封装
                └── components/
                    ├── layout/   # ThreePaneLayout/TopBar/LeftBar/RightPanel/StatusBar
                    └── chat/     # ChatPane/MessageBlocks
```

---

## 五、关键技术决策

### 5.1 为什么从 spawn CLI 迁移到 Agent SDK

| 维度 | spawn claude.exe (旧) | Agent SDK (新) |
|------|----------------------|---------------|
| 审批(canUseTool) | ✗ CLI `-p` 非交互模式下形同虚设 | ✅ **原生 async 回调**,可事中拦截 |
| 流协议稳定性 | 🔴 NDJSON 不稳定,需自己 try/catch + 兜底 | ✅ 类型化 `SDKMessage`,无裸 JSON 解析 |
| 进程管理 | 🔴 跨平台找 exe(.cmd/.cjs/.exe)、ENOENT、PATH 解析 | ✅ SDK 自带二进制,`pathToClaudeCodeExecutable` |
| turn 结束判定 | 🔴 看 `result` 行 + `close` 事件兜底 | ✅ generator 自然结束 + `ResultMessage` |
| 计费 | ✅ **能用 Max/Pro 订阅**(不按 token 付费) | ❌ 走 `ANTHROPIC_API_KEY`(按 API key 计费) |
| 安装包大小 | ✅ 0(不打包 claude) | 🔴 SDK + 原生二进制增大安装包 |
| 维护成本 | 🔴 高(追 CLI 版本变动) | 🟡 中(SDK 封装,但底层二进制仍随版本变) |

**迁移决定**:在审批、解析脆弱性、进程管理三大硬伤 vs Max 订阅损失的 trade-off 中,选 SDK。原 spawn 方式的 `ClaudeRuntime.ts` 和 `ClaudePathResolver.ts` 逻辑已迁入 `providers/claude-sdk/` 目录并删除。

### 5.2 为什么不用 Synara 的 effect-ts?

Synara 全栈用 effect-ts(Layer/Service 函数式框架)且依赖**预发布版本**(pkg.pr.new 构建)。这带来高代码质量,但二开门槛陡峭——改任何后端逻辑都要懂 effect。本项目定位"主流、易维护、可协作",坚持用普通 async/await + 事件发射器。

### 5.3 为什么 IPC 用 Electron IPC 而非独立 WebSocket?

Synara 拆独立 server 后用 WebSocket 通信(为多客户端/多 provider)。本项目单 provider + 单窗口,用 Electron 原生 `ipcMain.handle` / `webContents.send` 足矣,少一层协议。所有 IPC 消息经 zod 校验后才放行,防渲染层被攻破后任意 spawn。

---

## 六、踩坑记录(实战)

### 6.1 pnpm 11 忽略构建脚本 → Electron 二进制不下载
**现象**:`pnpm install` 报 `ERR_PNPM_IGNORED_BUILDS: electron, esbuild`,Electron 的 postinstall 不执行,`dist/electron.exe` 缺失,dev 起不来。
**根因**:pnpm 11 默认禁止依赖跑 install 脚本(供应链安全)。
**解决**:在 `pnpm-workspace.yaml` 配 `onlyBuiltDependencies: [electron, esbuild]`。注意 pnpm 11 不再读 package.json 的 `pnpm` 字段,必须放 workspace yaml。

### 6.2 Electron 二进制下载超时(GitHub 被墙)
**现象**:手动跑 `install.js` 报 `connect ETIMEDOUT 20.205.243.166:443`(GitHub releases IP)。
**根因**:Electron postinstall 从 GitHub 下载二进制,国内网络直连超时。
**解决**:`.npmrc` 配 `electron_mirror=https://registry.npmmirror.com/-/binary/electron/`。**已固化**,任何人重装不会踩。

### 6.3 electron-vite 入口路径不匹配
**现象**:`No electron app entry file found: dist-electron/main.js`。
**根因**:electron-vite 默认输出到 `out/main/index.js`,而 package.json `main` 字段写的是 `dist-electron/main.js`。
**解决**:`package.json` 的 `main` 改成 `./out/main/index.js`。

### 6.4 空白屏之一:Zustand 无限渲染循环
**现象**:界面一片空白,控制台 `Maximum update depth exceeded`。
**根因**:ChatPane 的 messages 选择器 `useSessionStore((s) => ... ? s.x ?? [] : [])` 每次渲染返回**新的字面量 `[]`**,Zustand 用 `Object.is` 比较发现引用变化 → 重渲染 → 又返回新 `[]` → 死循环。
**解决**:用模块级常量 `const EMPTY_MESSAGES: ChatMessage[] = []` 保证空数组引用稳定。

### 6.5 空白屏之二:CSP 拦截 Vite HMR
**现象**:React 根本不挂载,`<div id="root">` 永远空。
**根因**:index.html 的严格 CSP `script-src 'self'` 在 dev 模式拦截了 Vite 注入的 inline HMR 脚本。
**解决**:CSP 从 index.html 移到 main 进程,**仅生产模式**用 `onHeadersReceived` 注入;dev 无 CSP。

### 6.6 Windows 上 spawn claude 的 ENOENT 陷阱
**现象**:`spawn claude ENOENT`。
**根因**:Node 的 `child_process.spawn` 在 Windows 不走 PATH 解析 `.cmd` shim。
**解决**:`ClaudePathResolver` 不依赖 PATH,而是定位到真实入口 `cli-wrapper.cjs` 并用 `node` 启动;若只能用 `.cmd` 则 `shell: true`。

---

## 六.x、集成终端 (node-pty + xterm)

- **渲染层**: `@xterm/xterm` + `@xterm/addon-fit`（`TerminalPanel` / `TerminalView`）
- **主进程**: `node-pty` 由 `TerminalManager` 持有；IPC 见 `terminal.create|write|resize|kill|list`，推送 `terminal:data` / `terminal:exit`
- **安全**: create 的 `cwd` 必须落在已知 `Project.path` 内（`pathGuard`）
- **原生模块**: `node-pty` 必须 external，不可打进 main bundle。开发机若 ABI 不匹配，在 `apps/desktop` 执行 `pnpm rebuild:native`（`electron-builder install-app-deps`）。Windows 需对应 Electron ABI 的 prebuild；pnpm 若忽略 build scripts，prebuild 目录仍可用。
- **Shell 默认**: Win `pwsh → powershell → git-bash → cmd`；POSIX `$SHELL → bash → zsh → sh`。可用 settings key `terminal.shell` 覆盖。
- **环境刷新(win32)**: `envRefresh.ts` 的 `buildTerminalEnv()` 在每次创建终端时用 powershell.exe(显式 UTF-8、读原始未展开值)现读 HKLM+HKCU 注册表,按"系统+用户合并、PATH 拼接展开、覆盖快照同名项"重建 PTY env——否则 PTY 继承主进程启动时的冻结快照,启动后才安装的工具(nvm 等)不可见;失败降级纯继承,POSIX 直通(login shell 自带刷新)。`TerminalManager.create` 因此是 async。

## 七、版本与升级注意

- **Electron 主版本锁定** ^33(非 latest)。升级时注意原生模块(node-pty 等,P4 引入)需 `electron-rebuild`。
- **Zustand v5** 的 `create` API 与 v4 一致,但选择器必须返回稳定引用(见 6.4)。
- **React 19** 的 `react-dom/client` `createRoot` + StrictMode;注意 StrictMode 下 effect 执行两次,订阅需保证幂等。
- **Tailwind v3** 而非 v4(v4 配置语法不同,本项目用 `tailwind.config.js` + postcss,属 v3 范式)。
- **@base-ui/react** 是 Radix UI 继任者,本项目用它封装 `components/ui/` 下的可复用组件。新组件使用 `cva()` + `cn()` 管理样式变体,**禁止**手写 template literal 拼接 className。
- **图标**使用 `@tabler/icons-react`(主) + `react-icons`(辅)。统一从 `@renderer/lib/icons.js` 导入,以 `<IconX size={16} />` 形式使用,**禁止**Unicode 字符替代图标。

---

## 七.5、上下文用量统计(token / context-window)

> 实现:[`docs/claude-context-usage-tracking.md`](claude-context-usage-tracking.md) §2-§5。

### 数据流

```
SdkMessageAdapter (路径 A/C)
  │  normalizeClaudeTokenUsage() + decideClaudeContextUsageWarnings()
  ▼  ContextUsageEvent (type: "token-usage.updated", snapshot: ContextSnapshot)
RuntimeManager.emit()
  ├──→ IPC.CLAUDE_EVENT → sessionStore.ingestEvent → latestSnapshot
  │     → StatusBar chip(used / max (pct), 按警告级别染色)
  └──→ SessionRepo.updateSnapshot(sessions.context_snapshot JSON 列)
        └── 会话重载时 sessionStore.selectSession 直接还原快照(无需重算)
```

归一化数学下沉到 adapter,**下游 provider-neutral**:renderer / 持久化只存 `ContextSnapshot`,不碰原始 token 字段。

### 两条 emit 路径

| 路径 | 时机 | 数据源 | 用途 |
|------|------|--------|------|
| **A** | 每次 assistant 响应 | `message.message.usage` | 中途窗口读数,Status bar 在 turn 完成前就更新 |
| **C** | turn 结束 | `result.usage` + `modelUsage`(聚合 fallback + 取 `contextWindow`) | 合并快照,`usedTokens` = max(本次, 路径A);`totalProcessedTokens` 用累积值 |

**路径 B**(`getContextUsage()` 控制信道)在 Agent SDK 的 stream-json 表面不可用 → `usedPercent` 退化为 `usedTokens / maxTokens`,`near-window` 阈值用 `maxTokens * 0.8`(文档 §7.2 列为预期退化)。

### token 数学(`claudeTokenUsage.ts`)

- **usedTokens(窗口占用)** = `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`,clamp 到 `maxTokens`。缓存读取计费低,但**在窗口占用上按相同权重算**(模型仍需读这些 token,文档 §3)。
- **totalProcessedTokens** = `input + output + cache_read + cache_creation`(吞吐量,可超 maxTokens)。
- **maxTokens** 优先取 SDK `modelUsage[model].contextWindow`,回退启发式(Opus→1M,否则 200k);`Math.max(reported, lastKnown)` **永不降级**(1M 模型可能瞬时报 200k,文档 §4)。
- `totalProcessedTokens <= 0`(全 0 / 缺失)时不 emit,避免代理/网关返回 0 时的误导显示。

### 三类警告(doc §5,折叠进 `snapshot.warnings`)

| kind | 触发 | 含义 |
|------|------|------|
| `uncached-ingestion` | 未缓存输入 > 50k,**或** prompt > 20k 且缓存读取比 < 20% | 快速消耗额度(新会话 / resume / 大 context 首轮) |
| `near-window` | prompt > maxTokens * 0.8 | 接近窗口上限 |
| `large-prompt` | prompt > 200k | 大上下文加速额度消耗 |

`warning`(ok / near-window / critical)按 `pct`(>=90 critical / >=70 near-window)派生,驱动 StatusBar 染色。

### 自定义模型:扁平模型列表 + 1M 声明(`customModel.ts` / `customEnv.ts`)

自定义模型配置 = 一个端点(baseUrl + token + authMode)+ **扁平模型列表**(与 Pi 的配置方式一致)。每个模型就是一条 `{ id, supports1m? }`,会话直接选择**模型 id**(如 `deepseek-v4-pro`),没有显示名、没有角色概念。

`buildCustomEnv` 的注入规则:

- `ANTHROPIC_MODEL` = 选中模型 id(声明 1M 时带小写 `[1m]` 后缀,DeepSeek 约定);这是主回合模型的唯一通道(不同时传 `--model`,避免双通道不一致)。
- **后台 tier 环境变量全部镜像选中模型的裸 id**(不带 `[1m]`):`ANTHROPIC_DEFAULT_HAIKU/SONNET/OPUS/FABLE_MODEL`、`CLAUDE_CODE_SUBAGENT_MODEL`(内置 Task 工具用的模型)、`ANTHROPIC_SMALL_FAST_MODEL`(legacy haiku 名,v0.3.218 仍有 37 处引用)、`ANTHROPIC_DEFAULT_SONNET_MODEL_NAME`(DeepSeek 私有约定,永远裸名)。原因:Claude Code 在后台会发**每个** tier 的请求(haiku 用于标题/快速检查、sonnet 用于编码、opus 用于复杂推理…),不镜像的话 tier 回退到内置 `claude-*` 默认模型名 → 第三方网关不认 → 404/"no available channel"。后台请求都是短上下文,所以永不带 `[1m]` 后缀(历史 bug:haiku 通道收到网关不提供的 `deepseek-v4-pro[1m]`)。

**1M 上下文**:不是 env var,也不是 SDK 的 `options.betas`——是模型名上的 `[1m]` 后缀。按模型声明(`CustomModelEntry.supports1m`):选中该模型时 `ANTHROPIC_MODEL` 带后缀;`ClaudeAgentSdkProvider` 用 `resolveActiveModel(...).endsWith("[1m]")` 推导 `configured: "1m"|"200k"` 上下文标签。启用后 SDK 会在 `modelUsage` 报 `contextWindow:1000000`,上面的 token 数学自动正确。

**迁移**(`secretStore.readMeta` 的 `migrateMeta`):两种历史结构在读时透明升级为扁平列表——① 角色绑定表(`roles`):各角色的 `requestModel` 按角色顺序去重后成为模型条目,`supports1m` 在共享同一模型 id 的角色间取 OR;② 最老结构(`models[] + alias{haiku,sonnet,opus}`):先合成角色表再扁平化。旧记录的 `roles` 作为**幽灵字段**保留(不进 `CustomModelMeta` 契约、不透给 renderer),使旧会话 `model` 列里的角色 key(如 `"sonnet"`)仍解析到同一网关模型;用户下次保存配置时幽灵被剥离。`configured?: "1m"` 钩子(`claudeTokenUsage.ts`)仍保留未启用,可作为后续"强制声明"开关。

### 文件索引

| 文件 | 作用 |
|------|------|
| `packages/contracts/src/runtime.ts` | `ContextSnapshot` / `ContextUsageEvent` / `ContextWarning` / `ContextWarningKind` |
| `apps/desktop/src/main/providers/claude-sdk/claudeTokenUsage.ts` | 归一化/窗口/警告的唯一来源 |
| `apps/desktop/src/main/providers/claude-sdk/SdkMessageAdapter.ts` | 路径 A / C emit 点;会话级 `lastKnownTokenUsage` 状态 |
| `apps/desktop/src/main/claude/RuntimeManager.ts` | 拦截 `token-usage.updated` → 持久化 snapshot |
| `apps/desktop/src/renderer/lib/contextWindow.ts` | `fmtTokens` / `warningColor`(类型 re-export) |
| `apps/desktop/src/renderer/stores/sessionStore.ts` | `latestSnapshot` 接收与还原 |
| `apps/desktop/src/renderer/components/layout/StatusBar.tsx` | chip 显示 |

### 不做(超出 §2-§5 范围)

- **§6 持久化/聚合**:不新增 activities 表,不按天聚合 24h/7d/30d。只保留 `sessions.context_snapshot` 列(存归一化快照)。
- **路径 B `getContextUsage()`**:Agent SDK 不暴露控制信道,按 §7.2 退化。
- **账号级 OAuth 配额面板**:与单会话 context 无关,见 §一末注。

---

## 七.6、中间面板 Tab 多开模式(P3.5)

> 实现:`apps/desktop/src/renderer/components/layout/SessionTabs.tsx`、`stores/sessionStore.ts` 扩展字段、`components/settings/DisplayModePanel.tsx`。

### 目标

默认仍是"单会话替换"模式(`displayMode: "single"`);新增 `"tabs"` 模式:

- 点击左栏线程 → 在中间面板顶部追加一个 tab,中间面板显示该线程
- 多个 tab 并列,点击切换显示,**互不干扰**(切走 tab 后 Claude 仍可继续 stream)
- 关闭 tab → tab 消失,**后台 turn 继续运行**(事件照常按 sessionId 入桶,重新打开 tab 可看到最新状态)
- 设置 → 外观 → "中间面板显示模式" 切换,选择持久化

### 数据层改造

| 字段 | 形态 | 原因 |
|------|------|------|
| `openTabs: string[]` | **始终写**,不论模式 | 模式切换不丢已开线程 |
| `displayMode: "single" \| "tabs"` | 持久化到 `settings.ui.displayMode` | `init()` 启动时 `setting.get` 拉取 |
| `pendingQuestionBySession: Record<sid, {questions}>` | 替代原 `pendingQuestion` 单 slot | 多 tab 同时弹 question 互不覆盖 |
| `turnFilesBySession: Record<sid, TurnFileEntry[]>` | 替代原 `turnFiles` 单 slot | 各自 session 的"本轮文件"卡片独立 |
| `pendingApprovals: ApprovalRequestEvent[]` | **保持不变**(本就是数组) | UI 渲染时按 `sessionId` 过滤取 head |

> `runningBySession` / `messagesBySession` / `todosBySession` / `planBySession` / `subagentsBySession` 早就是 per-session 桶,无须改。

### 新增 action

- `openTab(sessionId)` — LeftBar 调它:已开 → 激活;未开 → push + 激活。同 `selectSession` 一样同步 model / effort / permissionMode / customModelId 到全局槽。
- `closeTab(sessionId)` — 从 `openTabs` 移除,**不取消运行 turn**。若关的是当前 active,自动切到前一个(或新尾);空列表则置 `activeSessionId = null`。
- `setDisplayMode(mode)` — 立即更新 store + `setting.set` 持久化。

### 渲染层路由

`App.tsx` 引入 `CenterPane` 组件,按 `displayMode` 选渲染策略:

- `single` → `<ChatPane key={activeSessionId ?? "empty"} sessionId={activeSessionId} />`(等价于旧行为,仅签名多一个 `null` 空态分支)
- `tabs` → `<SessionTabs />` + `<ChatPane key={activeSessionId} sessionId={activeSessionId} />`,只挂载前台 tab,key 变化重挂载(清空本地 useState 草稿/滚动位置)

> 只挂载前台 tab 而不是 `display: none` 全部挂载:tab 多时省订阅;切换重挂载是简单可靠策略;草稿本来就不持久化,UX 上可接受。

### 关键设计权衡

1. **关闭 tab 不取消 turn**:`RuntimeManager.sessions` Map / SDK 子进程 / per-turn `AbortController` 全都天然按 sessionId 隔离,删 UI tab 不影响底层运行。这正是 "用户切走 tab 后 Claude 仍在后台 streaming" 的基础。
2. **不把 4 个 config 槽(model/effort/permissionMode/customModelId)按 sessionId 分桶**:改造成本大;实际语义就是"前台 tab 的配置",`syncConfigFromSession` 切活动时自动同步,符合 tab 模式心智模型。Composer 行为不变。
3. **新会话 (`startSession`) 自动 push 进 `openTabs`**:不论模式,store 总是写完整列表,渲染层决定是否显示 tab 条。

---

## 八、各阶段引入计划(路线图)

| 阶段 | 引入的技术 | 状态 |
|------|-----------|------|
| P0 脚手架 | Electron / React / TS / Tailwind / Vite / Turbo / pnpm | ✅ 完成 |
| P1 端到端 | Zustand / zod IPC | ✅ 完成 |
| P2 会话持久化 | sql.js(纯 JS SQLite) | ✅ 完成 |
| P2.5 SDK 迁移 | @anthropic-ai/claude-agent-sdk / AgentProvider 抽象层 / ProviderRegistry / ApprovalBridge | ✅ 完成 |
| P3 工具审批 | canUseTool 回调 → approval.request/approve IPC 桥(后端已通,前端审批 UI 待 P5 打磨) | ✅ 基础完成 |
| P4 IDE 右栏 | xterm.js + node-pty / simple-git / Monaco | 🟡 文件/Git/终端已实现；Browser 待 P5 |
| P5 体验打磨 | react-markdown + remark / KaTeX / Cmd+K / 审批 UI 完善 | ⬜ |
| P6 发布 | electron-builder / electron-updater / GitHub Actions | ✅ 基础完成 |

---

## 九、发布与自动更新(P6)

> 实现:`apps/desktop/electron-builder.yml`、`apps/desktop/src/main/updater.ts`、`.github/workflows/{ci,release}.yml`。

### 9.1 打包(electron-builder)

- **配置文件**:`apps/desktop/electron-builder.yml`(不在 package.json 的 build 字段,独立 yml)。
- **产物目录**:`apps/desktop/release/`(已 gitignore)。
- **目标平台**:macOS(`dmg` + `zip`,arm64 + x64)、Windows(`nsis`,x64)。Linux 暂未覆盖。
- **native 模块**:`node-pty`(.node)和 `sql.js`(asm.js blob)通过 `asarUnpack` 解包,确保运行时能从磁盘 `require()`。打包前需 `pnpm rebuild:native`(`electron-builder install-app-deps`)让 .node 匹配目标 Electron ABI。
- **图标**:`apps/desktop/build/{icon.icns,icon.ico,icon.png}`,由脚本生成(emerald 渐变 + "C" glyph),electron-builder 按平台自动选用。
- **版本**:读 `apps/desktop/package.json` 的 `version`(起步 `0.1.0`)。
- **暂未签名**:mac 包无 codesign(identity 留空,eon-builder 自动跳过),用户首次打开需右键 > 打开;Win 包无证书,SmartScreen 会提示。后续接入签名时在 yml 加 `mac.identity` / `win.certificateFile`。

### 9.2 自动更新(electron-updater,GitHub Releases 渠道)

```
GitHub Releases(latest-mac.yml / latest.yml)
        ▲ electron-builder 打包时生成,release.yml 上传为 Release Asset
        │
autoUpdater.checkForUpdates()  (main/updater.ts, 仅 prod)
        │
        ├── update-available  -> IPC.UPDATE_AVAILABLE -> renderer(AboutPanel)
        │                        用户点"立即下载"
        ▼
autoUpdater.downloadUpdate()
        │
        └── update-downloaded -> IPC.UPDATE_DOWNLOADED -> renderer
                                  用户点"重启安装" -> autoUpdater.quitAndInstall()
```

- **渠道**:GitHub Releases(`publish.provider: github`),electron-updater 从 Release Assets 拉 `latest-mac.yml` / `latest.yml` 发现新版本。
- **dev 不激活**:`initUpdater()` 用 `is.prod` 守卫--electron-updater 依赖 app.asar 内的 `app-update.yml`,dev 下不存在,所有 RPC 短路返回"已是最新"。
- **autoDownload = false**:发现新版本后不静默下载,由用户在 About 面板点"立即下载"触发。`autoInstallOnAppQuit = true`:下载完成后下次退出自动安装。
- **检查频率**:启动 10s 后首次检查,之后每 4h 一次;用户也可手动点"检查更新"。
- **IPC**:`app.checkForUpdates` / `app.downloadUpdate` / `app.quitAndInstall`(RPC)+ `update:available` / `update:downloaded`(推送,消息体自带 `channel` 字段)。详见 `packages/contracts/src/ipc.ts`。
- **失败隔离**:updater 所有操作 try/catch,失败只 `log.error`,不影响主功能。

### 9.3 CI/CD(GitHub Actions)

- **`ci.yml`**:push 到 master / 任意 PR 触发,跑 `pnpm typecheck`(质量门禁)。
- **`release.yml`**:push tag `v*.*.*` 触发,matrix 构建 macOS + Windows 安装包(`pnpm rebuild:native` + `pnpm package`),用 `softprops/action-gh-release` 上传到 GitHub Release。
  - **`latest*.yml` 必须作为 Asset 上传**--这是 electron-updater 检查更新的依据,漏传则自动更新失效。
  - 用内置 `GITHUB_TOKEN`,无需额外 secret。
- **本地打包**:`pnpm package`(等价 `turbo run package` -> `electron-vite build && electron-builder`)。
