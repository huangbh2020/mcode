# AGENTS.md

本文件指导 AI agent(含本项目自身用 Claude Code 开发时)如何理解并参与 Mcode 的开发。先读本文,再动手。

---

## 项目是什么

**Mcode**(*my* Code)- 基于 Claude Agent SDK 构建的**桌面端 GUI**(Electron 三栏 IDE)。

核心理念:**不重新实现 agent,只做 Claude 的交互界面**。通过 Agent SDK 驱动 claude agent loop;本应用负责会话管理、实时渲染、工具审批、IDE 能力(文件/git/终端)。

- 使用 `@anthropic-ai/claude-agent-sdk`,内部管理 claude 二进制(项目不直接 spawn)
- 项目 MIT,可独立开源
- 架构受 [Synara](https://github.com/Emanuele-web04/synara) 启发,但用主流 TS 重写(无 effect-ts、无 bun)
- 内置 `AgentProvider` 抽象层,后续可扩展其他 agent 平台(OpenAI Codex、Gemini CLI 等)

---

## 权威文档(动手前必读)

| 主题 | 文档 |
|------|------|
| 技术栈、架构、踩坑记录 | [`docs/tech-stack.md`](docs/tech-stack.md) |
| claude stream-json 数据格式(旧 CLI 方式的 dump 记录,SDK 的 SDKMessage 与此对应) | [`docs/claude-stream-json.md`](docs/claude-stream-json.md) |
| Claude Agent SDK 参考 | https://code.claude.com/docs/en/agent-sdk |

改 `SdkMessageAdapter` 或涉及 SDK 输出解析时,**必须**先读 stream-json 文档——SDK 的 `SDKMessage` 类型本质上是对 CLI stream-json 的类型化封装,字段语义一一对应。

---

## 进程架构(三进程)

```
Renderer (React 19, contextIsolation:true, nodeIntegration:false)
        ↕  Electron IPC(preload contextBridge + zod 校验)
Main (Node.js)
  ├── RuntimeManager      持 ProviderRegistry,构造 ProviderContext
  │     └── AgentProvider  ClaudeAgentSdkProvider(→ query() → SDKMessage → RuntimeEvent)
  ├── SessionManager      会话生命周期(SQLite via sql.js)
  └── IDE Services        terminal / git / checkpoint(P4)
        ↕  @anthropic-ai/claude-agent-sdk (query)
     claude 二进制(SDK 内打包,项目不直接 spawn)
```

**安全边界**:renderer 不能 `require()` 任何 Node 模块。通往 Node 的唯一桥梁是 preload 暴露的 `window.api`,所有消息经 zod 校验后才放行。新增 IPC 通道时,必须在 `packages/contracts/src/ipc.ts` 定义 schema + 通道常量,并在 preload 白名单注册。

---

## 目录地图

```
packages/contracts/src/        # 跨进程共享(无运行时逻辑)
  runtime.ts                   # RuntimeEvent 联合 — provider 中立的归一化事件
  session.ts                   # Project / Session / Message 领域类型
  ipc.ts                       # zod schema + IPC 通道常量 + RPC 类型表
  provider.ts                  # AgentProvider 接口 / ProviderContext / TurnHandle

apps/desktop/src/
  main/                        # 主进程
    claude/
      RuntimeManager.ts        # ★ 会话↔provider 映射,构造 ProviderContext
      ApprovalBridge.ts        # 工具审批/AskUserQuestion 的 IPC 异步桥
    providers/
      registry.ts              # ProviderRegistry 单例(启动时注册所有 provider)
      claude-sdk/
        ClaudeAgentSdkProvider.ts  # AgentProvider 实现(query() 包装 + canUseTool 桥)
        SdkMessageAdapter.ts       # ★ SDKMessage → RuntimeEvent 归一化(改前读 SDK 文档)
      pi-sdk/
        PiAgentSdkProvider.ts      # AgentProvider 实现(createAgentSession 包装 + 内联 Extension 注入)
        mcodeExtension.ts          # ★ 内联 Pi Extension:tool_call 权限/路径守卫 + AskUserQuestion 工具 + system prompt
        PiMessageAdapter.ts        # Pi SDK 事件 → RuntimeEvent 归一化
    ipc/{claude,projects}.ts   # IPC handler
    lib/
      logger.ts                # 文件+stderr 日志(userData/logs/main.log)
      askQuestion.ts           # ★ 共享:parseQuestions / formatAnswersForModel / ASK_SYSTEM_PROMPT(Claude + Pi 共用)
    store/{db,repositories}.ts # SQLite 持久化(sql.js)
  preload/index.ts             # contextBridge 白名单 API
  renderer/                    # 前端(React)
    stores/sessionStore.ts     # ★ Zustand store,ingest RuntimeEvent → ChatMessage
    hooks/useClaudeEvents.ts   # 订阅 IPC 事件流
    components/{layout,chat}/  # UI
```

---

## 开发命令

```bash
# 启动开发(electron-vite,HMR)
cd D:\00-huangbh-project\my-claude-gui
pnpm dev

# 类型检查(改完代码先跑这个,最快定位问题)
cd apps/desktop && npx tsc --noEmit -p tsconfig.json

# 构建
pnpm build
```

### ⚠️ 启动前注意
异常退出后,5173 端口可能残留(TIME_WAIT)。若窗口没弹出,先在任务管理器结束所有 `electron.exe`,或等约 30 秒端口释放。

---

## 环境

- Node.js ≥ 22.13(pnpm 11 要求,本机 v25.9.0)
- pnpm ≥ 9(经 `corepack enable` 启用,本机 11.16.0)
- Claude Code CLI(本机装在 `D:\soft\nodejs\node_global`,非默认路径——`ClaudePathResolver` 已处理)
- `.npmrc` 配了国内 electron 镜像(直连 GitHub 会超时),任何人重装不会踩

---

## 编码约定

### TypeScript
- **strict 模式**,全量类型,禁 `any`(必要时用 `unknown` + 收窄)
- 工作区包用别名导入:`@contracts/*`、`@main/*`、`@renderer/*`
- 文件间用 `.js` 扩展名的相对导入(nodeNext 兼容):`import { x } from "./y.js"`
- 改完代码**先 typecheck**:`npx tsc --noEmit -p tsconfig.json`

### Zustand(renderer 状态)
- 选择器**必须返回稳定引用**。禁止 `useStore((s) => arr ?? [])`——每次渲染返回新 `[]` 会触发无限循环(已踩过)。用模块级常量:`const EMPTY: T[] = []`
- 动作(actions)放 store 内,组件只读 + 调用

### IPC
- 新通道:先在 `contracts/ipc.ts` 加 zod schema + `IPC` 常量 → preload 白名单注册 → main handler 用 `Schema.parse(raw)` 校验入参
- main→renderer 推送用 `sendToRenderer(IPC.XXX, msg)`,renderer 用 `api.on.xxx` 订阅

### claude 解析(SdkMessageAdapter)
- `SdkMessageAdapter.dispatch()` 将 SDK 的 `SDKMessage` 归一化为 `RuntimeEvent`
- 流是按 `message.type` 分发的 if/else 链,未知 type 静默忽略(向前兼容)
- stream_event 的 text/thinking 增量**只在 delta 渲染**;assistant 完整消息只补全 tool_use,不重发 text(避免重复)
- turn 结束判定:收到 `result` 消息时,**仅当没有运行中的子代理、也没有后台任务**才立即发 `turn.done`(CLI v2.1.198+ 子代理默认后台运行,主 agent 回合结束会先发一条中间 `result`,此时 turn 并未真正结束,后续会恢复继续流式);否则推迟到 `flushFinal()` 在 generator 真正结束时补发(reason 取最后一条 result)。`emitTurnDone` 去重,每 turn 恰好发一次。后台任务跟踪同时消费 SDK 的 `background_tasks_changed` 水平信号,避免漏掉 task_started 边沿事件
- **canUseTool 审批回调由 `ClaudeAgentSdkProvider` 在 `query()` options 里注册**,不在 adapter 里处理
- **文件写入守卫(严格项目内)**:所有 provider 统一拦截 `Write`/`Edit`/`MultiEdit`/`NotebookEdit` 的写入路径:① 把 WSL 式 `/mnt/<drive>/...` 路径修正为 Windows 原生路径(否则 Windows 上会解析成 `D:\mnt\...` 垃圾目录);② 把 `~`/`~/...` 展开为 `homedir()`(`bashWriteGuard.ts` 的 `expandTilde`,所有路径检查共用;`node:path.resolve` 不认 `~`,不展开会被误判为项目内的字面 `~` 目录);③ 目标路径解析后**超出项目工作目录一律拒绝**(提示模型改用相对路径),仅 `bypassPermissions`/`dontAsk` 例外。Claude:在 `ClaudeAgentSdkProvider` 的 `canUseTool` 里实现(工具集 `FILE_MUTATING_TOOLS` 定义在 `fileSnapshot.ts`),归一化路径经 `updatedInput` 回传 SDK;`SdkMessageAdapter` 的"撤销本轮"快照(`recordPre`)用同一助手,保证卡片与实际写入位置一致。Pi:用**内联 Extension**(`mcodeExtension.ts` 的 `createMcodeExtension`,经 `DefaultResourceLoader({ extensionFactories })` 注入)的 `tool_call` 事件 handler 实现——SDK 的 `agent-loop.js` 在 `beforeToolCall` 里 `await emitToolCall(event)`,handler 返回 `{ block: true, reason }` 时执行体把它转成 `createErrorToolResult(reason)` + `isError: true`(模型可见,等同 Claude 的 `behavior: "deny"`)。路径归一化靠原地修改 `event.input`(`event.input` 与最终执行参数 `validatedArgs`/`prepared.args` 是同一引用,等同 Claude 的 `updatedInput`)。同一个 `tool_call` handler 还负责权限审批(读 `ctx.getPermissionMode()` + `ctx.isToolAlwaysAllowed()` + `ctx.requestApproval()` IPC 桥)。bash 守卫读 `params.command`,经 `bashWriteGuard.ts` 的 `guardBashCommand` 提取写重定向目标 `>`/`>>`/`>&`/`tee`/`dd of=`/`sed -i` 后逐一过 `expandTilde` + 路径检查;含 `$`/反引号的目标无法静态展开直接放行,`cp`/`mv`/heredoc/管道目标不覆盖——**非沙箱**,目的是堵住"模型无意识在项目外建脚本文件"的常见模式。win32 下 Claude 的 systemPrompt 附加"勿用 /mnt 路径"提示(Bash 重定向写文件不在 canUseTool 守卫范围内,靠该提示缓解);Pi 的 `before_agent_start` 事件 handler 注入 AskUserQuestion 使用说明 + 同一提示文本
- **Pi Extension 架构**(`mcodeExtension.ts`):Pi SDK 无 `canUseTool` 回调、无 system prompt 扩展点、无原生 AskUserQuestion/计划工具——这些全部由一个内联 Extension 补齐,经 `buildPiSkillLoader` 的 `extensionFactories` 参数注入(`DefaultResourceLoader` 在 `getExtensions()` 阶段执行 factory,先于 `_refreshToolRegistry`,所以 `pi.registerTool`/`pi.on` 在首个 turn 前就绑定;reload 时 `loadExtensionFactories` 也会重跑)。六块逻辑:① `tool_call` handler = 权限审批 + 路径/bash 守卫 + plan mode 只读门禁(覆盖**所有**工具);② `registerTool("AskUserQuestion")` = 原生工具,`execute` 桥接 `ctx.requestUserInput`;③ `registerTool("EnterPlanMode")`/`registerTool("ExitPlanMode")` = 计划模式工具,发 `mode.change` + `plan.update` 事件,ExitPlanMode 的 `execute` 里 `await ctx.requestPlanApproval()` 阻塞 agent loop 等用户审批(agent-loop.js `await tool.execute` 确认可阻塞);④ `before_agent_start` handler = 追加 system prompt(AskUserQuestion + 计划工具使用说明);⑤ plan mode 状态用进程内 `planMode.active` 布尔跟踪(**不**用 `ctx.getPermissionMode()`——后者经 IPC 往返有延迟,不能保证下一个 tool_call 前到达);⑥ `tool_call` 守卫的 write/edit 分支在路径守卫通过后 `await getFileSnapshot(sessionId).recordPre(cwd, 规范化绝对路径)`(本轮修改文件快照,与 Claude 共用 `FileSnapshot`;turn 结束由 `PiMessageAdapter.flushFinal()` `freeze()` 后 `ctx.emit({type:"turn.files"})`,provider 的 `done()` 成功/中断路径调用,错误路径跳过——对齐 Claude)。`capabilities.supportsApproval`/`supportsAskUserQuestion` 现为 `true`,`permissionModes` 暴露 Claude 的 4 档。win32 的 read `/mnt` 归一化仍用 `createMntNormalizingReadTool` customTools(只读、无安全风险,不进 `tool_call` 守卫)。plan 模式的 `tools` 白名单显式包含 AskUserQuestion + EnterPlanMode + ExitPlanMode。共享的 `parseQuestions` / `formatAnswersForModel` / `ASK_SYSTEM_PROMPT` 在 `lib/askQuestion.ts`,Claude 和 Pi provider 共用
- **Pi 计划模式(Plan Mode)**:完全复用 Claude 的前端计划卡片体系(`PlanStreamBlock`/`PlanViewer`/`PlanApprovalPrompt` + sessionStore 的 `plan.update`/`plan.approval_request` reducer + `respondPlanApproval` IPC),零前端改动。Pi 的计划能力由 Extension 注册的两个工具驱动:模型调 `EnterPlanMode()` → `execute` 设 `planMode.active=true`,发 `mode.change{plan}` + `plan.update{drafting}`(空文本,卡片不显示,只更新 composer chip);模型只读调研后调 `ExitPlanMode({plan})` → `execute` 发 `plan.update{ready}`(卡片出现)→ `await ctx.requestPlanApproval()`(阻塞 agent loop)→ 用户批准则发 `mode.change{default}` + `planMode.active=false`(工具门禁解除),拒绝则发 `plan.update{drafting}`(留在计划模式)。中断时 ExitPlanMode execute 的 catch 发 `plan.update{cleared}` 清理。plan mode 是 per-turn 状态(Extension 每 turn 重建)。**与 Claude 的差异:plan mode 下允许写文件/执行命令做验证**,但每个修改操作都弹审批框(`shouldAutoApproveForPi` 在 plan 模式返回 false → 走 `ctx.requestApproval`)——模型可以在计划阶段实验验证,用户逐个审批把关。**工具集不用 `tools` 白名单限制**:Pi 没有 SDK 内建 plan mode 状态机(Claude 的 ExitPlanMode 批准后 SDK 自己恢复工具集),`tools` 白名单在 `createAgentSession` 时固化——如果在 plan 模式用白名单排除 write/edit/bash,审批通过后它们仍然不可用(模型报"没有编辑工具")。所以所有工具始终全部可用,plan mode 的权限控制完全靠 `tool_call` handler + `shouldAutoApproveForPi` 动态审批

### 「撤销本轮」文件回滚(rewind)
- **不使用 SDK 内建 `enableFileCheckpointing`**:该机制要求 `permissionMode: "acceptEdits"`,会绕过上面的 `canUseTool` 守卫与工具审批 UI,直接废掉核心安全资产。改为自研「记录/恢复解耦」方案,保留路径守卫。
- **记录**:`FileSnapshot`(`apps/desktop/src/main/lib/fileSnapshot.ts`)只负责捕获——`recordPre(cwd, path)` 在 `SdkMessageAdapter` 每个 `FILE_MUTATING_TOOLS` 的 `tool_use` 上读盘存 `before`(首调生效);`freeze()` 在回合结束读盘算 `adds/dels/before`,产出 `TurnFileEntry[]`。记录逻辑与 `canUseTool` 守卫**共用 `normalizeToolFilePath`**,路径口径一致。**Pi 侧接入**:工具名小写(`write`/`edit`,字段 `input.path`),`recordPre` 挂在 `mcodeExtension.ts` 的 `tool_call` 守卫 write/edit 分支(路径守卫通过后 `await`,保证 before 先于工具执行);回合收尾 `PiMessageAdapter.flushFinal()`(provider `done()` 的成功/中断路径,错误路径跳过——对齐 Claude)里 `freeze()` + `ctx.emit({type:"turn.files"})`。`turn.files` 晚于 `turn.done` 是常态(agent_end 已先发 turn.done),renderer 的 `turn.files` reducer 专为该顺序而写。**其余链路(rewind IPC、RuntimeManager 持久化、前端卡片)完全复用 Claude 的实现,零改动**——`RuntimeManager` 的 `sendTurn` 开头清快照、`rewindTurn`、`turn.rewound` 持久化全部 provider 中立。
- **恢复(统一入口)**:模块级 `restoreFiles(cwd, entries)` 是恢复的唯一实现——遍历 entries,`modified` 写回 `before`、`created` unlink(ENOENT 容忍),每条过 `safeResolveOk` 拒绝逃逸 cwd 的路径。`FileSnapshot.restore()` 内部把内存 Map 转成 entries 后委托它。
- **`RuntimeManager.rewindTurn(sessionId, files, targetFiles)`** 接收显式 `TurnFileEntry[]`,与内存快照脱钩——所以**会话重开后、以及任意历史轮次**都能撤回(数据来自 DB 持久化的 `before` 字段,而非易失的内存 Map)。cwd 解析优先 `rt.lastCwd`,缺失时(会话重开未发新轮次)回退 `SessionRepo` → `ProjectRepo` 取项目路径。仅当传入路径集合 === 内存快照 keys(`hasPaths`)时才 `clear()`(避免误清其他轮次的内存记录)。
- **撤回痕迹(统一形态)**:最新/历史轮次撤回走**同一** `turn.rewound` 事件,`targetFiles`(请求路径集)**必填**。renderer 按**路径集合**匹配消息流中的 `turn-files` block 标记 `rewound: true`——卡片**永不删除**,降透明度 + 「已撤销」徽章,在数据流中留下"曾经撤回过"的痕迹(对齐 SDK「文件回滚不回滚对话」语义)。仅当被标记卡片是 live 卡(`isLatestTurn`)时才清 `turnFilesBySession`(文件树点标记/diff 来源不再视其为本轮改动)。main 侧 `turn.rewound` 持久化同理:仅当 `targetFiles` 匹配 DB 里最新 `turn_files` 路径集时才清列,历史撤回不动最新轮次数据。
- **UI**:`TurnFilesCard` 每个**未撤销**的卡片都显示「撤销本轮」(历史卡片点击前 `confirm` 警告可能影响后续轮次);`rewound` block 的 `rewound` 字段在 `turn-files` case 上(block 联合类型新增,向后兼容)。`store.rewindTurn(files, targetFiles)` 由调用方显式传 files + targetFiles(必填),不乐观清状态(等 `turn.rewound` 事件)。
- **契约**:`RewindTurnSchema` 含 `files`(内联 zod)+ 必填 `targetFiles`;`TurnRewoundEvent` 带必填 `targetFiles`。

### 中间面板 Tab 模式(P3.5)

### 中间面板 Tab 模式(P3.5)
- **显示模式偏好**持久化在 `settings` 表的 `ui.displayMode` key(`DISPLAY_MODE_SETTING_KEY`),`init()` 启动时 `setting.get` 拉取,`setDisplayMode()` 写回。
- `openTabs: string[]` 是已开 tab 的 sessionId 有序列表;**不论 single / tabs 模式都写**,切模式不丢已开线程。
- `closeTab()` **不取消运行中的 turn**,只从 tab 列表移除;事件流继续按 sessionId 入桶,重新打开 tab 可看到最新状态。
- 单 slot 字段(原 `pendingQuestion` / `turnFiles`)已改为 per-session 桶(`pendingQuestionBySession` / `turnFilesBySession`),多 tab 并发不会互相覆盖。
- `ChatPane` 接受 `sessionId: string | null` prop,所有 per-session 选择器都按 prop 读;`null` 走空态(`EmptyCenterPane`)。
- `CenterPane`(在 `App.tsx`)按 `displayMode` 决定:`single` 直接挂 `<ChatPane>`;`tabs` 先挂 `<SessionTabs />` 再挂 `<ChatPane key={activeSessionId} />`(只挂载前台 tab,key 变化重挂载)。
- 4 个全局 config 槽(model / effort / permissionMode / customModelId)保持不变——它们表达"前台 tab 的配置",`syncConfigFromSession` 在 `selectSession` / `openTab` / `closeTab` 切活动时自动同步,Composer 立即反映。

### 语言服务器 LSP(P4.5)
- **可安装、可启停**:设置页"语言服务器"面板,每种语言(TS/JS、Python、Go、Java)一张卡片。安装走包管理器(`npm`/`pip`/`go`/`brew`),Java win/linux 走直接下载 tar.gz 解压到 `userData/lsp/java`。
- **配置持久化**:`settings` 表 `lsp.servers` key(JSON 数组 `LspServerConfig[]`),每语言一个条目(`enabled` + 可选 `serverPath`/`args`)。
- **主进程 `LspManager`**(单例,`apps/desktop/src/main/lsp/LspManager.ts`):按 `(workspacePath, language)` 懒启动 stdio JSON-RPC 子进程;手写 Content-Length 分帧 + JSON-RPC 收发;`initialize` 握手后才放行 `request`;`textDocument/publishDiagnostics` / `window/logMessage` 推送到 renderer(`lsp:event`);`before-quit` 调 `disposeAll()` 杀全部子进程。
- **语言规格**:`apps/desktop/src/main/lsp/languageSpecs.ts` 是扩展点--新增语言加一个 `LanguageServerSpec` 即可,`LspManager` 自动获得安装/探测/启动/同步行为。
- **二进制探测**:`which()` 抽到 `apps/desktop/src/main/lib/binaryResolve.ts`(terminal 的 shellResolve 也共用)。Windows 额外探 `%APPDATA%/npm`(npm 全局 bin)。
- **Monaco 桥接**(renderer):`apps/desktop/src/renderer/lib/lspProviders.ts` 手写 `registerDefinitionProvider` / `registerReferenceProvider` / `registerHoverProvider`,每个 provider 通过 `api.lsp.request` RPC 转发到 main。**不引入 `monaco-languageclient`**(最小依赖)。跨文件跳转在 definition provider 内直接调 `openFileInIde(path, line, col)` 并返回 null,同文件则返回 Location 让 Monaco 原生导航。
- **文档同步**:`EditPane` 的 `onMount` 发 `didOpen`,`onChange` debounce 300ms 发 `didChange`,`handleSave` 成功后发 `didSave`,卸载时发 `didClose`。
- **诊断 markers**:`useLspDiagnostics` hook 订阅 `lsp:event`,按 `uri` 过滤后 `monaco.editor.setModelMarkers`。
- **跳转定位**:`openFileInIde` 扩展了 `opts.line`/`opts.column`,写入 `idePendingReveal` + bump `ideRevealNonce`;`EditPane` 的 `useEffect([nonce])` 消费后 `revealLineInCenter` + `setPosition` + `clearIdePendingReveal`。
- **TS worker 去重**:TS LSP 启用时,`monacoSetup.ts` 的 `setTsWorkerDiagnosticsEnabled(false)` 关掉内置 tsWorker 诊断,避免双份波浪线。由 `reloadLspLanguages` 在水合后驱动。
- **安全**:所有 `workspacePath` 过 `isKnownProjectPath`,`filePath` 过 `findContainingProject`,只允许已知项目内的文件进 LSP。
- **崩溃恢复**:`proc.on("exit")` 非主动关闭时从 Map 移除 + 推 `stateChanged{running:false}`;下次 `request` 自动 `ensureServer` 重启。

### 前端组件与图标

#### 组件库
- **`@base-ui/react` ^1.5.0** — Radix UI 原班人马开发的新一代无头 UI 组件库。项目中的可复用 UI 组件基于 base-ui 封装,位于 `src/renderer/components/ui/` 目录。
- **辅助**:`class-variance-authority` ^0.7.1 — 用 `cva()` 管理组件 variant/size;`tailwind-merge` ^3.6.0 — 用 `twMerge` + `clsx` 暴露 `cn()` 工具函数。

#### 图标库
- **主图标库**:**`@tabler/icons-react` ^3.44.0**。图标统一以 `<IconX size={16} />` 形式使用。
- **辅助图标库**:**`react-icons` ^5.6.0** — Tabler 未覆盖的特殊图标集(Phosphor `Pi*`、Remix `Ri*`、Simple Icons `Si*`、VS Code `Vsc*`)。
- **适配层**:`src/renderer/lib/icons.tsx` 集中 re-export 所有可用图标,附带常用图标的简写别名(如 `SettingsIcon = IconSettings`)。

#### 使用规范(新代码必须遵守)
1. **class 合并**:**必须**使用 `cn()`(从 `@renderer/lib/cn.js` 导入)替代 template literal 拼接。旧代码可保持原样,新代码一律用 `cn()`。
2. **基础 UI 组件**:优先从 `@renderer/components/ui/index.js` 导入 `<Button>` / `<Input>` / `<Dialog>` / `<Select>` 等封装组件,不直接写原始 `<button>` + inline className。
3. **variant 管理**:用 `cva()` 定义组件的 variant/size 变体,不手写条件 className。
4. **图标**:使用 `@tabler/icons-react` 的 `<IconX>` 组件替代 Unicode 字符(✦▶✕⚙等)。需从 `@renderer/lib/icons.js` 导入。
5. **语义 Token**:所有 Tailwind class 使用现有的语义颜色 token(`bg-surface` / `text-content` / `border-edge` / `text-accent` / `text-content-muted` / `text-content-subtle` 等),不使用原始 Tailwind 颜色值。

---

## 当前进度

| 阶段 | 状态 | 说明 |
|------|------|------|
| P0 脚手架 | ✅ | 三进程、三栏布局、IPC 契约 |
| P1 端到端 | ✅ | claude stream-json + 流式渲染 + 输入框 |
| P2 会话持久化 | ✅ | sql.js(SQLite)、`--resume` 续传、会话列表 |
| P2.5 SDK 迁移 | ✅ | @anthropic-ai/claude-agent-sdk + AgentProvider 抽象层 + ProviderRegistry |
| P3 工具审批 | ✅ 基础 | canUseTool 桥 → approval.request/approve IPC(后端已通,前端审批 UI 待 P5) |
| P3.5 中间面板 Tab 模式 | ✅ | 中间面板显示模式偏好(单/tab),`openTabs` + `SessionTabs` 标签条;关闭 tab 后台 turn 继续运行 |
| P4 IDE 右栏 | ✅ | 文件树、git、终端(xterm+node-pty)、Monaco 编辑器 + diff |
| P4.5 LSP 语言服务器 | ✅ | 设置页可安装/启停 TS/Python/Go/Java 语言服务器;`LspManager`(main)管理 stdio JSON-RPC 子进程;Monaco 手写 Provider(definition/references/hover)+ 诊断 markers + 跳转定位 |
| P5 体验打磨 | 🟡 | ✅ 浏览器预览(agent 驱动应用内浏览器);⬜ checkpoint 时间线、Cmd+K、审批 UI |
| P6 发布 | ✅ 基础 | electron-builder(mac/win 安装包)、electron-updater(GitHub Releases 渠道)、CI(typecheck + tag 自动发布)。mac 包已接 ad-hoc 签名(无 Apple 付费证书,dmg 直下首次启动需 `xattr -dr com.apple.quarantine` 或系统设置"仍要打开";brew cask 安装无此问题);真实 Developer ID 签名+公证未做,未含 Vitest |

详见 `docs/tech-stack.md` 第八节。

### Agent 浏览器工具(P5)
- **架构**:复用应用内嵌入式浏览器(`BrowserManager` 的 `WebContentsView`,与右侧浏览器面板同一套 view)。不引入 Playwright/Puppeteer/CDP 等外部浏览器自动化依赖——零新二进制,打包/签名不受影响。
- **底层能力**(`apps/desktop/src/main/browser/BrowserManager.ts`):在已有 `loadUrl`/`show`/`hide`/`setPickMode` 等面板方法基础上,新增 agent 专用的 `list()`(发现 browserId)、`snapshot()`(`executeJavaScript` 注入只读快照脚本,返回结构化页面数据 + 可交互元素 selector)、`click()`(按 selector 程序化点击,selector 经双重 JSON 编码注入,不拼进 script 源码)、`screenshot()`(`capturePage().toPNG()` → base64)。注入脚本是固定常量(`snapshotScript.ts`),selector 只用于 `querySelector`,无注入风险。
- **共享工具实现**(`apps/desktop/src/main/browser/agentBrowserTools.ts`):Pi 和 Claude provider 共用。5 个函数 `browserList/browserNavigate/browserSnapshot/browserClick/browserScreenshot`,返回 MCP 兼容的 `{content: [TextBlock|ImageBlock]}`。**browserId 寻址**:所有工具的 `browserId` 可选——省略时自动复用第一个已开 view;无 view 时 `navigate` 自动 `create`+`show`(让用户看到 agent 在浏览),其他工具返回"请先 navigate"。
- **Pi 侧**(`mcodeExtension.ts` 的 `registerBrowserTools`):用 `pi.registerTool`(typebox schema)注册 5 个工具。**审批分级**:`MCODE_BROWSER_READONLY = {browser_list, browser_snapshot, browser_screenshot}` 在 `tool_call` 守卫的 ③ 步硬编码白名单放行(永不审批);`browser_navigate`/`browser_click` 有副作用,走正常审批(支持 always-allow)。screenshot 的 execute 里 `ctx.emit({type:"browser.image"})` 发结构化事件给 renderer 内联渲染(Pi path)。
- **Claude 侧**(`ClaudeAgentSdkProvider.ts` 的 `buildBrowserMcpServer`):用 SDK 的 `createSdkMcpServer({name:"mcode-browser", tools:[...]})` 挂**进程内 MCP server**(无子进程),放进 `options.mcpServers`。inputSchema 用 zod。Claude 不能 `registerTool`(SDK 不支持),in-process MCP server 是唯一路径。工具名呈现为 `mcp__mcode-browser__<name>`,`shouldAutoApprove` 里 `isReadOnlyBrowserTool()` 放行只读后缀。screenshot 的 image 通过 tool_result content 透传(SDK 原生支持 image block),store 从 `ToolResultEvent.content` 解析(Claude path)。
- **图片渲染**(双路径汇聚到同一 store reducer):`RuntimeEvent` 新增 `browser.image`(Pi emit);`Block` union 新增 `kind:"image"`(base64 + mimeType)。`sessionStore` 的 `tool.result` reducer 检测 content 含 image block 时追加 image block(Claude path),`browser.image` reducer 按 toolCallId 追加(Pi path),两者按 toolCallId 去重。`MessageBlocks.tsx` 的 `BlockView` 新增 `case "image"` 渲染 `<img>`;`GenericToolCard` 的 result 预览(`resultPreview`)剥离 image block 避免把 base64 当文本 dump。图片随消息持久化(toRecords 透传 blocks 数组,不区分 kind)。

---

## 关键提醒

1. **改 ClaudeRuntime 前先读 stream-json 文档**。schema 来自真实 dump,字段名不要猜。
2. **不要打包 claude.exe**。License 合规:只调用用户已装的,不内嵌二进制。
3. **新增 IPC 必走 zod 校验**。这是 renderer→Node 的唯一安全边界。
4. **本机的 superpowers 插件 hook 是坏的**(SessionStart 报 ParserError),与本项目无关——claude 会跳过它,日志里看到不要当成我们的 bug。
5. **空白屏调试**:main 进程已把 renderer 的 `console-message` 转发到 stderr,不用开 DevTools 就能从启动日志看渲染层报错。
