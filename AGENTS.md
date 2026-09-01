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
| Pi SDK 接入记录 | [`docs/pi-sdk-integration.md`](docs/pi-sdk-integration.md) |
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
    stores/sessionStore.ts     # ★ Zustand store,ingest RuntimeEvent → ChatMessage(locale 状态也在此)
    lib/i18n/                  # ★ 中英双语文案:core.ts(translate) + index.ts(useI18n) + zh|en/{common,layout,lib,chat-stream,chat-composer,ide,browser,settings,store}.ts
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
- **`@anthropic-ai/claude-agent-sdk` 钉死精确版本 `0.3.238`(不带 `^`;2026-08-27 从 0.3.218 显式升级)**:防止 `^0.3.x` 在普通 `pnpm install` 时静默漂移(2026-08-23 曾意外漂到本版)。注意:本版捆绑 CLI 2.1.238 的 `sdkCompat.testedWrapperVersions` 名单止于 0.3.227、不含 wrapper 自身(该字段仅宿主元数据,`sdk.mjs` 不消费它);本次升级已过 checksum 比对 + 对话框 kind 存在性 + 冒烟(system/init 报 2.1.238)三项验证。升级要显式改版本号,升级前必查:changelog + issues 搜 "Stream closed"/permission;新包 manifest 的 testedWrapperVersions 要含 wrapper 自身;`grep -ac "permission_exit_plan_mode_v2" claude.exe` 确认对话框 kind 没改名;升级后回归计划审批/AskUserQuestion/工具审批/子代理收尾四条链路
- **Claude 的 UI「计划模式」在 provider 层翻译为 SDK `default` + `CLAUDE_PLAN_MODE_NUDGE` 引导模型走 EnterPlanMode 工具**(2026-08-26):CLI 的 plan permission-mode 在"上一轮后台子代理刚完成、新一轮立即 resume"的竞态下会把 ExitPlanMode 的审批请求在规则层秒拒(`toolDenialKind:"permission-rule"`,tool_result 显示 `Tool permission request failed: AbortError: Stream closed`,记入 permission_denials,宿主 canUseTool/onUserDialog 均不会被调用)——2.1.218 与 2.1.238 都复现,与 SDK 版本无关;default 模式下模型自调 EnterPlanMode→ExitPlanMode 的审批链路则一直可靠。安全性由宿主侧保持:ApprovalBridge 仍按配置级 "plan" 判定,所有写操作逐个弹审批(对齐 Pi 侧计划模式的设计)。adapter 已做降级呈现:ExitPlanMode 的通道故障显示琥珀色警告卡(`planApprovalBroken` 词条)
- **CLI 排障入口**:CLI 开了 `--debug`,自写日志按 SDK 会话落在 `~/.mcode/debug/<sessionId>.txt`(权限判定、hook、agent 生命周期都在里面,main.log 看不到的 CLI 内部行为来这里查)

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

### 界面文案 i18n(中英双语,默认中文)
- 语言偏好:`settings` 表 `ui.locale` key(`UI_LOCALE_SETTING_KEY`,`"zh"|"en"`),sessionStore 的 `locale` 状态 + `setLocale` 持久化,启动时进 first-paint `getMany` 批量水合,切换即时生效(组件订阅 `useI18n()` 自动重渲染,并同步 `<html lang>`)
- 组件内:`import { useI18n } from "@renderer/lib/i18n/index.js"` → `const { t } = useI18n()` → `t("area.key")`;插值 `t("key", { n })` 对应词条里的 `{n}`
- 非 React 模块(store、lib 纯函数):用 `lib/i18n/core.ts` 的 `translate(locale, key, params)`(locale 从 `useSessionStore.getState().locale` 取)。**不要从 index.js 导入 translate 到 store/store 相关模块**——index 导入 store,会成环;core.ts 无依赖
- 词典:`lib/i18n/zh/` 与 `en/` 按功能分区(common/layout/lib/chat-stream/chat-composer/ide/browser/settings/store),zh 是源(`MessageId` 由 zh 键派生),en 镜像同一类型——**缺键过不了 typecheck**。新词条 zh/en 同步加,键用分区前缀
- **禁止硬编码新的用户可见中文/英文文案**;只翻 UI 文案,代码注释、console 日志、发给模型的 prompt、持久化标识符不进词典。模块级常量数组存 `labelKey: MessageId`,渲染时 `t()`

### claude 解析(SdkMessageAdapter)
- `SdkMessageAdapter.dispatch()` 将 SDK 的 `SDKMessage` 归一化为 `RuntimeEvent`
- 流是按 `message.type` 分发的 if/else 链,未知 type 静默忽略(向前兼容)
- stream_event 的 text/thinking 增量**只在 delta 渲染**;assistant 完整消息只补全 tool_use,不重发 text(避免重复)
- turn 结束判定:收到 `result` 消息时,**仅当没有运行中的子代理、也没有后台任务**才立即发 `turn.done`(CLI v2.1.198+ 子代理默认后台运行,主 agent 回合结束会先发一条中间 `result`,此时 turn 并未真正结束,后续会恢复继续流式);否则推迟到 `flushFinal()` 在 generator 真正结束时补发(reason 取最后一条 result)。`emitTurnDone` 去重,每 turn 恰好发一次。后台任务跟踪同时消费 SDK 的 `background_tasks_changed` 水平信号,避免漏掉 task_started 边沿事件
- **prompt 用不结束的 AsyncIterable 占住 stdin(settle 门控,2026-08-26)**:`buildPromptInput` 始终返回"yield 用户消息后 await 门控"的迭代器——SDK 对字符串 prompt(及一次性迭代器)会在**第一条 result 后关闭 stdin**(`isSingleUserTurn`/`streamInput` 的 endInput),CLI 进程随即退出,还在跑的后台子代理被孤儿化、独立继续写共享会话文件;下一轮在 ~300ms 窗口内 resume 会读到撕裂状态,此时**所有权限询问瞬时失败**(`Tool permission request failed: AbortError: Stream closed`,AskUserQuestion/ExitPlanMode 全灭,2.1.218/2.1.238 皆然)。占住 stdin 让 CLI 进程活到后台代理全部完成。**settle 条件(关键,踩过坑)**:result 已到 + 无 running 子代理 + 无后台任务 + **result 晚于最后一次代理活动边沿**(`lastResultAt > lastAgentActivityAt`)——CLI 有 task-notification 恢复机制:代理完成后注入合成 user 消息并**继续主循环**(更多工具/询问/可能再开代理),恢复相位的 result 只出现在相位末尾;若只看"result+代理空闲"就释放,第一段恢复相位期间 stdin 被关、其内所有 ask 全灭(2026-08-26 实测)。边沿时间戳在 handleResult/flushSubagents/handleBackgroundTasksChanged 打点,`maybeSettle` 三处复查,`setSettleGate` 释放 + 1.5s 宽限(`SETTLE_GRACE_MS`,覆盖会话落盘滞后)。兜底:`PROMPT_SETTLE_FALLBACK_MS`(5 分钟)超时强制释放(退化为旧行为而非死锁)+ done 的 finally 防御性释放;迭代器内部与 abort signal 竞速,用户停止不会卡住 streamInput。每轮打 `claude turn start: uiMode/sdkMode/settleGate` 与 `claude turn settled` 日志锚点,排障先看这两行
- **回合末 context-usage 快照不占 turn.done 关键路径**:`handleResult` 对 `emitTurnEndSnapshot` 是 fire-and-forget(turn.done 由 flushFinal 立即发,快照事后补发),内部把 kickoff 的 `getContextUsage()` promise 与 3s 超时竞速(`CONTEXT_USAGE_PATH_B_TIMEOUT_MS`),超时/不可信(总量 < 累计 input 的 10%)即回退 path C——第三方网关的控制通道曾观测 17-36s 才应答且返回垃圾值,直接 await 会拖住整轮结束。`RuntimeManager` 的每轮用量历史随之改为 `pendingTurnEnd` 延迟落盘:turn.done 只记 endedAt/durationMs,等 turn-end 快照到达再写 `usageHistory`(下一轮 `sendTurn` 兜底 flush)
- **网关空响应截断检测(`turn.incomplete`)**:`flushFinal()` 在发 turn.done 前跑 `maybeEmitTurnIncomplete()`——第三方网关(OpenAI 协议桥)会用**空补全**应答最后一次 tool_result,CLI 把它当正常收尾发 `result{subtype:"success"}`,用户侧表现为"任务跑一半停了、还弹'回合完成'"(2026-08-20 实测:回合死在 Read tool_use 之后,无 tool_result、无最终文本)。检测条件刻意收窄:last result 必须是 success(error 子类型已有 error 卡片)、非用户中断、有 tool_use 没等到 tool_result(`dangling-tools`,排除 Task 工具——后台子代理合法地活过父流)或 有工具调用但整轮无文本(`empty-response`,排除 EnterPlanMode/ExitPlanMode/AskUserQuestion 交互回合——它们本来就常无叙述文本)。事件在 turn.done **前**发,renderer 的 `turnIncompleteBySession` 旗标让 turn.done 跳过误导性的"回合完成" toast,改为琥珀色警告卡片 + toast 提示"发送「继续」可恢复";adapter 同时打 `turn incomplete (gateway likely returned an empty final response)` WARN 进 main.log 便于事后取证。Pi 侧未接入本检测(`PiMessageAdapter` 已把终态 `agent_end` 的 `stopReason:"error"` 呈现为 error 块;若实测发现 Pi 也有静默空回合,再按同一事件补)
- **子代理名单只收 agent 类任务**:`task_started` 带 `task_type`(实测 CLI 2.1.x 二进制:`local_agent`=Task 工具子代理、`local_bash`=被 CLI 当任务跟踪的 bash 命令、`local_workflow`=脚本工作流、`remote_agent`),adapter 的 `NON_AGENT_TASK_TYPES` 把 `local_bash`/`local_workflow` 挡在名单外(否则 `sleep` 等待命令会以"运行中"假子代理堆在胶囊里——CLI 不会为它们发收尾 task_updated,状态卡到 turn 结束),忽略的 task_id 记进 `ignoredTaskIds`(`task_progress`/`task_updated` 不带 task_type,防止 progress 的合成分支把已忽略任务加回来);未知/缺省 task_type 放行(老版本 CLI 兼容)。renderer 的 `hydrateCapsule` 另有 `sanitizeSubagentRoster`:水合持久化名单时丢弃 `running` 且非后台的条目(干净数据里静止名单不可能有这种条目,是修复前脏数据的特征),防止旧会话复活假子代理
- **canUseTool 审批回调由 `ClaudeAgentSdkProvider` 在 `query()` options 里注册**,不在 adapter 里处理
- **文件写入守卫(严格项目内)**:所有 provider 统一拦截 `Write`/`Edit`/`MultiEdit`/`NotebookEdit` 的写入路径:① 把 WSL 式 `/mnt/<drive>/...` 路径修正为 Windows 原生路径(否则 Windows 上会解析成 `D:\mnt\...` 垃圾目录);② 把 `~`/`~/...` 展开为 `homedir()`(`bashWriteGuard.ts` 的 `expandTilde`,所有路径检查共用;`node:path.resolve` 不认 `~`,不展开会被误判为项目内的字面 `~` 目录);③ 目标路径解析后**超出项目工作目录一律拒绝**(提示模型改用相对路径),仅 `bypassPermissions`/`dontAsk` 例外。Claude:在 `ClaudeAgentSdkProvider` 的 `canUseTool` 里实现(工具集 `FILE_MUTATING_TOOLS` 定义在 `fileSnapshot.ts`),归一化路径经 `updatedInput` 回传 SDK;`SdkMessageAdapter` 的"撤销本轮"快照(`recordPre`)用同一助手,保证卡片与实际写入位置一致。Pi:用**内联 Extension**(`mcodeExtension.ts` 的 `createMcodeExtension`,经 `DefaultResourceLoader({ extensionFactories })` 注入)的 `tool_call` 事件 handler 实现——SDK 的 `agent-loop.js` 在 `beforeToolCall` 里 `await emitToolCall(event)`,handler 返回 `{ block: true, reason }` 时执行体把它转成 `createErrorToolResult(reason)` + `isError: true`(模型可见,等同 Claude 的 `behavior: "deny"`)。路径归一化靠原地修改 `event.input`(`event.input` 与最终执行参数 `validatedArgs`/`prepared.args` 是同一引用,等同 Claude 的 `updatedInput`)。同一个 `tool_call` handler 还负责权限审批(读 `ctx.getPermissionMode()` + `ctx.isToolAlwaysAllowed()` + `ctx.requestApproval()` IPC 桥)。bash 守卫读 `params.command`,经 `bashWriteGuard.ts` 的 `guardBashCommand` 提取写重定向目标 `>`/`>>`/`>&`/`tee`/`dd of=`/`sed -i` 后逐一过 `expandTilde` + 路径检查;含 `$`/反引号的目标无法静态展开直接放行,`cp`/`mv`/heredoc/管道目标不覆盖——**非沙箱**,目的是堵住"模型无意识在项目外建脚本文件"的常见模式。win32 下 Claude/Pi 的 systemPrompt 按**实际 bash 环境**附加路径提示(`lib/bashEnv.ts` 的 `detectBashEnv` + `bashPathHintFor`:镜像各 SDK 的 bash 解析逻辑——Pi 按 `settings shellPath` → `Program Files\Git\bin\bash.exe` → `where bash.exe` 首项,Claude 优先 Git Bash(git 安装根推导)再退 WSL;探测出 WSL bash 时提示"bash 跑在 WSL,命令内用 /mnt/... 路径",否则提示"勿用 /mnt 路径")。Bash 重定向写文件不在 canUseTool 守卫范围内,靠该提示缓解;Pi 的 `before_agent_start` 事件 handler 注入 AskUserQuestion 使用说明 + 同一提示文本
- **Pi Extension 架构**(`mcodeExtension.ts`):Pi SDK 无 `canUseTool` 回调、无 system prompt 扩展点、无原生 AskUserQuestion/计划工具——这些全部由一个内联 Extension 补齐,经 `buildPiSkillLoader` 的 `extensionFactories` 参数注入(`DefaultResourceLoader` 在 `getExtensions()` 阶段执行 factory,先于 `_refreshToolRegistry`,所以 `pi.registerTool`/`pi.on` 在首个 turn 前就绑定;reload 时 `loadExtensionFactories` 也会重跑)。六块逻辑:① `tool_call` handler = 权限审批 + 路径/bash 守卫 + plan mode 只读门禁(覆盖**所有**工具);② `registerTool("AskUserQuestion")` = 原生工具,`execute` 桥接 `ctx.requestUserInput`;③ `registerTool("EnterPlanMode")`/`registerTool("ExitPlanMode")` = 计划模式工具,发 `mode.change` + `plan.update` 事件,ExitPlanMode 的 `execute` 里 `await ctx.requestPlanApproval()` 阻塞 agent loop 等用户审批(agent-loop.js `await tool.execute` 确认可阻塞);④ `before_agent_start` handler = 追加 system prompt(Mcode 身份提示 `PI_IDENTITY_PROMPT` + AskUserQuestion + 计划工具使用说明)。**Pi 的提示词必须平台独立:不得出现任何其他平台 SDK/产品字眼**(如 Claude Code CLI、网页版 Claude),身份/驱动描述只讲 Mcode + Pi Coding Agent 自身——Pi 底层模型由用户配置,不保证是 Claude。身份变体 `PI_IDENTITY_PROMPT` 与 Claude 的 `CLAUDE_IDENTITY_PROMPT` 同放 `lib/systemPrompt.ts`,各自独立调词,互不引用;⑤ plan mode 状态用进程内 `planMode.active` 布尔跟踪(**不**用 `ctx.getPermissionMode()`——后者经 IPC 往返有延迟,不能保证下一个 tool_call 前到达);⑥ `tool_call` 守卫的 write/edit 分支在路径守卫通过后 `await getFileSnapshot(sessionId).recordPre(cwd, 规范化绝对路径)`(本轮修改文件快照,与 Claude 共用 `FileSnapshot`;turn 结束由 `PiMessageAdapter.flushFinal()` `freeze()` 后 `ctx.emit({type:"turn.files"})`,provider 的 `done()` 成功/中断路径调用,错误路径跳过——对齐 Claude)。`capabilities.supportsApproval`/`supportsAskUserQuestion` 现为 `true`,`permissionModes` 暴露 Claude 的 4 档。win32 的 read `/mnt` 归一化仍用 `createMntNormalizingReadTool` customTools(只读、无安全风险,不进 `tool_call` 守卫)。plan 模式的 `tools` 白名单显式包含 AskUserQuestion + EnterPlanMode + ExitPlanMode。共享的 `parseQuestions` / `formatAnswersForModel` / `ASK_SYSTEM_PROMPT` 在 `lib/askQuestion.ts`,Claude 和 Pi provider 共用
- **Pi 计划模式(Plan Mode)**:完全复用 Claude 的前端计划卡片体系(`PlanStreamBlock`/`PlanViewer`/`PlanApprovalPrompt` + sessionStore 的 `plan.update`/`plan.approval_request` reducer + `respondPlanApproval` IPC),零前端改动。Pi 的计划能力由 Extension 注册的两个工具驱动:模型调 `EnterPlanMode()` → `execute` 设 `planMode.active=true`,发 `mode.change{plan}` + `plan.update{drafting}`(空文本,卡片不显示,只更新 composer chip);模型只读调研后调 `ExitPlanMode({plan})` → `execute` 发 `plan.update{ready}`(卡片出现)→ `await ctx.requestPlanApproval()`(阻塞 agent loop)→ 用户批准则发 `mode.change{default}` + `planMode.active=false`(工具门禁解除),拒绝则发 `plan.update{drafting}`(留在计划模式)。中断时 ExitPlanMode execute 的 catch 发 `plan.update{cleared}` 清理。plan mode 是 per-turn 状态(Extension 每 turn 重建)。**与 Claude 的差异:plan mode 下允许写文件/执行命令做验证**,但每个修改操作都弹审批框(`shouldAutoApproveForPi` 在 plan 模式返回 false → 走 `ctx.requestApproval`)——模型可以在计划阶段实验验证,用户逐个审批把关。**工具集不用 `tools` 白名单限制**:Pi 没有 SDK 内建 plan mode 状态机(Claude 的 ExitPlanMode 批准后 SDK 自己恢复工具集),`tools` 白名单在 `createAgentSession` 时固化——如果在 plan 模式用白名单排除 write/edit/bash,审批通过后它们仍然不可用(模型报"没有编辑工具")。所以所有工具始终全部可用,plan mode 的权限控制完全靠 `tool_call` handler + `shouldAutoApproveForPi` 动态审批

### 「撤销本轮」文件回滚(rewind)
- **不使用 SDK 内建 `enableFileCheckpointing`**:该机制要求 `permissionMode: "acceptEdits"`,会绕过上面的 `canUseTool` 守卫与工具审批 UI,直接废掉核心安全资产。改为自研「记录/恢复解耦」方案,保留路径守卫。
- **记录**:`FileSnapshot`(`apps/desktop/src/main/lib/fileSnapshot.ts`)只负责捕获——`recordPre(cwd, path)` 在 `SdkMessageAdapter` 每个 `FILE_MUTATING_TOOLS` 的 `tool_use` 上读盘存 `before`(首调生效);`freeze()` 在回合结束读盘算 `adds/dels/before`,产出 `TurnFileEntry[]`,并**过滤净零条目**(`adds===0 && dels===0`:回合内建了又删的文件、从未落盘的写入、逐字节相同的重写——对审查和恢复都无意义;2026-08-28 起,此前"创建 12 · 修改 1"卡片里 12 行「无变化」噪音即源于此)。净零条目同时从内存 Map 剔除,保证卡片路径集与 `hasPaths`/`restore` 一致。renderer 侧兜底:`upsertLiveTurnFilesBlock` 与水合 `fromRecords` 都剪除 0/0 条目(历史会话已落库的脏卡片重开后同样干净;全噪声块整块移除,消息因此变空则整条丢弃——**不能只在卡片组件层滤**,`turn.rewound` 按 block 路径集全等匹配,渲染层过滤会让 targetFiles 对不上)。记录逻辑与 `canUseTool` 守卫**共用 `normalizeToolFilePath`**,路径口径一致。**Pi 侧接入**:工具名小写(`write`/`edit`,字段 `input.path`),`recordPre` 挂在 `mcodeExtension.ts` 的 `tool_call` 守卫 write/edit 分支(路径守卫通过后 `await`,保证 before 先于工具执行);回合收尾 `PiMessageAdapter.flushFinal()`(provider `done()` 的成功/中断路径,错误路径跳过——对齐 Claude)里 `freeze()` + `ctx.emit({type:"turn.files"})`(同一 freeze 过滤,Pi 自动受益)。`turn.files` 晚于 `turn.done` 是常态(agent_end 已先发 turn.done),renderer 的 `turn.files` reducer 专为该顺序而写。**其余链路(rewind IPC、RuntimeManager 持久化、前端卡片)完全复用 Claude 的实现,零改动**——`RuntimeManager` 的 `sendTurn` 开头清快照、`rewindTurn`、`turn.rewound` 持久化全部 provider 中立。
- **恢复(统一入口)**:模块级 `restoreFiles(cwd, entries)` 是恢复的唯一实现——遍历 entries,`modified` 写回 `before`、`created` unlink(ENOENT 容忍),每条过 `safeResolveOk` 拒绝逃逸 cwd 的路径。`FileSnapshot.restore()` 内部把内存 Map 转成 entries 后委托它。
- **`RuntimeManager.rewindTurn(sessionId, files, targetFiles)`** 接收显式 `TurnFileEntry[]`,与内存快照脱钩——所以**会话重开后、以及任意历史轮次**都能撤回(数据来自 DB 持久化的 `before` 字段,而非易失的内存 Map)。cwd 解析优先 `rt.lastCwd`,缺失时(会话重开未发新轮次)回退 `SessionRepo` → `ProjectRepo` 取项目路径。仅当传入路径集合 === 内存快照 keys(`hasPaths`)时才 `clear()`(避免误清其他轮次的内存记录)。
- **撤回痕迹(统一形态)**:最新/历史轮次撤回走**同一** `turn.rewound` 事件,`targetFiles`(请求路径集)**必填**。renderer 按**路径集合**匹配消息流中的 `turn-files` block 标记 `rewound: true`——卡片**永不删除**,降透明度 + 「已撤销」徽章,在数据流中留下"曾经撤回过"的痕迹(对齐 SDK「文件回滚不回滚对话」语义)。仅当被标记卡片是 live 卡(`isLatestTurn`)时才清 `turnFilesBySession`(文件树点标记/diff 来源不再视其为本轮改动)。main 侧 `turn.rewound` 持久化同理:仅当 `targetFiles` 匹配 DB 里最新 `turn_files` 路径集时才清列,历史撤回不动最新轮次数据。
- **UI**:`TurnFilesCard` 每个**未撤销**的卡片都显示「撤销本轮」(历史卡片点击前 `confirm` 警告可能影响后续轮次);`rewound` block 的 `rewound` 字段在 `turn-files` case 上(block 联合类型新增,向后兼容)。`store.rewindTurn(files, targetFiles)` 由调用方显式传 files + targetFiles(必填),不乐观清状态(等 `turn.rewound` 事件)。
- **契约**:`RewindTurnSchema` 含 `files`(内联 zod)+ 必填 `targetFiles`;`TurnRewoundEvent` 带必填 `targetFiles`。

### 中间面板 Tab 模式(P3.5)
- **显示模式偏好**持久化在 `settings` 表的 `ui.displayMode` key(`DISPLAY_MODE_SETTING_KEY`),`init()` 启动时 `setting.get` 拉取,`setDisplayMode()` 写回。
- `openTabs: string[]` 是已开 tab 的 sessionId 有序列表;**不论 single / tabs 模式都写**,切模式不丢已开线程。
- `closeTab()` **不取消运行中的 turn**,只从 tab 列表移除;事件流继续按 sessionId 入桶,重新打开 tab 可看到最新状态。
- 单 slot 字段(原 `pendingQuestion` / `turnFiles`)已改为 per-session 桶(`pendingQuestionBySession` / `turnFilesBySession`),多 tab 并发不会互相覆盖。
- `ChatPane` 接受 `sessionId: string | null` prop,所有 per-session 选择器都按 prop 读;`null` 走空态(`EmptyCenterPane`)。
- `CenterPane`(在 `App.tsx`)按 `displayMode` 决定:**`tabs` 模式挂 `UnifiedTabbedPane`** —— 顶部一条 `UnifiedTabsBar`(`components/layout/UnifiedTabsBar.tsx`,复用 SessionTabs 的 `SortableSessionTab` + OpenTabsBar 的 `SortableFileTab`/`FileTabContextMenu`/`useDirtyFiles`,同一 DndContext 内两个 SortableContext,跨类型拖放忽略),**会话 tab 与文件 tab(+计划伪 tab)混排一条栏、不分组**;内容由 store 的 `centerTabFocus: "chat"|"editor"` 决定:会话 tab 激活 → 全宽 ChatPane(所有 openTabs 的 pane 常挂、非前台 `hidden` 保活草稿/滚动),文件/计划 tab 激活 → 全宽 `EditorColumn`(传 `hideTabsBar`,避免与统一栏重复)。**没有 chat|editor 分栏**,激活视图独占整个中间宽度。**`single` 模式挂 `SplitCenterPane`**,保持旧的"聊天列 | 编辑列"分栏(编辑列内自带 `OpenTabsBar`),wide 模式(`WidePanelSplit`)仍用旧 `ChatColumn`(只有 SessionTabs,无编辑列)。
- **`centerTabFocus` 焦点流转**(UI-only,不持久化;渲染端对 "editor" 做兜底——无 activeFile 且无激活计划 tab 时视同 "chat"):置 "chat" = `selectSession`/`openTab`/`startSession`/`enqueueChatFile`/`clearIdeActiveFile`(隐藏编辑器语义);置 "editor" = `openFileInIde`/`setIdeActiveFile`/`setPlanTabActive(true)`/`openPlanDrawer`(均 **gate 在 tabs 模式**,single 模式不写,保证切回 tabs 时落在聊天);`closeTab` 仅在被关的是**激活 tab** 时移动焦点(关后台会话 tab 不拉走编辑器),关最后一个会话 tab 时若有 activeFile 则落到编辑器;`closeFileInIde`/`closeFilesUnderDir`/`closeAllFilesInIde` 在"无剩余文件且无激活计划 tab"时回落 "chat";`closePlanDrawer` 有可回退文件则保持焦点,否则回 "chat"。Titlebar 的 `EditorColumnToggle` 在 tabs 模式按 `centerTabFocus` 判显隐。
- 4 个全局 config 槽(model / effort / permissionMode / customModelId)保持不变——它们表达"前台 tab 的配置",`syncConfigFromSession` 在 `selectSession` / `openTab` / `closeTab` 切活动时自动同步,Composer 立即反映。

### 语言服务器 LSP(P4.5)
- **可安装、可启停**:设置页"语言服务器"面板,每种语言(TS/JS、Python、Go、Java)一张卡片。安装走包管理器(`npm`/`pip`/`go`/`brew`),Java win/linux 走直接下载 tar.gz 解压到 `userData/lsp/java`。
- **配置持久化**:`settings` 表 `lsp.servers` key(JSON 数组 `LspServerConfig[]`),每语言一个条目(`enabled` + 可选 `serverPath`/`args`)。
- **主进程 `LspManager`**(单例,`apps/desktop/src/main/lsp/LspManager.ts`):按 `(workspacePath, language)` 懒启动 stdio JSON-RPC 子进程;手写 Content-Length 分帧 + JSON-RPC 收发;`initialize` 握手后才放行 `request`;`textDocument/publishDiagnostics` / `window/logMessage` 推送到 renderer(`lsp:event`);`before-quit` 调 `disposeAll()` 杀全部子进程。
- **语言规格**:`apps/desktop/src/main/lsp/languageSpecs.ts` 是扩展点--新增语言加一个 `LanguageServerSpec` 即可,`LspManager` 自动获得安装/探测/启动/同步行为。
- **二进制探测**:`which()` 抽到 `apps/desktop/src/main/lib/binaryResolve.ts`(terminal 的 shellResolve 也共用)。Windows 额外探 `%APPDATA%/npm`(npm 全局 bin)。
- **Monaco 桥接**(renderer):`apps/desktop/src/renderer/lib/lspProviders.ts` 手写 `registerDefinitionProvider` / `registerReferenceProvider` / `registerHoverProvider`,每个 provider 通过 `api.lsp.request` RPC 转发到 main。**不引入 `monaco-languageclient`**(最小依赖)。跨文件跳转在 definition provider 内直接调 `openFileInIde(path, line, col)` 并返回 null,同文件则返回 Location 让 Monaco 原生导航。
- **文档同步**:`EditPane` 的 `onMount` 发 `didOpen`,`onChange` debounce 300ms 发 `didChange`,`handleSave` 成功后发 `didSave`,卸载时发 `didClose`。`openDocument` 在 didOpen 后**后台预热**:fire-and-forget 发一次 `textDocument/documentSymbol`(typescript-language-server 等在首个工作区查询才懒加载项目,不预热的话用户第一次 F12/Ctrl+F12 要吃整个项目加载延迟;错误吞掉,60s 请求超时兜底)。
- **跳转交互反馈**(`lspProviders.ts` 的 `lspGotoTracker` + `FileEditor` 的 `GotoActivityPill`):definition/implementation/references 三个 provider 把每次查询登记进模块级 pub/sub(同 `ideDirtyTracker` 模式),EditPane 底部中央显示浮动 pill——pending >250ms 显示"正在查找{定义/实现/引用}…"(≥3s 附耗时秒数),结束短暂显示"未找到{kind}"或失败原因(如"语言服务器未启用",hover 看详情)后 ~1.8s 自动消失;hover 不追踪(太频繁)。`lspRequest` 失败从返回 null 改为 throw,由调用方决定是否呈现。
- **诊断 markers**:`useLspDiagnostics` hook 订阅 `lsp:event`,按 `uri` 过滤后 `monaco.editor.setModelMarkers`。
- **跳转定位**:`openFileInIde` 扩展了 `opts.line`/`opts.column`,写入 `idePendingReveal` + bump `ideRevealNonce`;`EditPane` 的 `useEffect([nonce])` 消费后 `revealLineInCenter` + `setPosition` + `clearIdePendingReveal`。
- **TS worker 去重**:TS LSP 启用时,`monacoSetup.ts` 的 `setTsWorkerDiagnosticsEnabled(false)` 关掉内置 tsWorker 诊断,避免双份波浪线。由 `reloadLspLanguages` 在水合后驱动。
- **安全**:所有 `workspacePath` 过 `isKnownProjectPath`,`filePath` 过 `findContainingProject`,只允许已知项目内的文件进 LSP。
- **崩溃恢复**:`proc.on("exit")` 非主动关闭时从 Map 移除 + 推 `stateChanged{running:false}`;下次 `request` 自动 `ensureServer` 重启。
- **jdtls 工作区损坏自愈**:Equinox 退出码 13 = `-data` 工作区打不开(典型:`SaveManager.restore` 抛 `ObjectNotFoundException`,Maven `target/` 生成文件在服务器保存后被 `mvn clean` 等外部删除所致;损坏的是落盘元数据,每次启动必崩)。`ensureServer` 的 initialize 失败路径检测到 java + exitCode 13 时,把 `workspaces/<hash>` 轮换为 `.corrupt-<时间戳>`(rename 失败退回 rmSync)并**自动重试一次**(递归传 `allowWorkspaceRecovery=false` 防循环,重试前清该 key 崩溃计数);新工作区会重新导入项目。健康检查同理:jdtls 无 `--version` 模式(参数会被转发给 Equinox 起完整服务器且永不退出),`healthCheck` 对 java 走静态检查(launcher jar 存在性),通用 `--version` 探测加 10s 超时 + win32 `taskkill /T` 杀树兜底。
- **Java 首次导入:预热 + 进度可视化**(jdtls 无"分批导入" API,导入是整体后台任务,只能把时机提前 + 让等待可解释):① **预热**——渲染层在项目激活时(`selectProject`/启动水合/新建项目,以及设置页启用 Java 后的 `reloadLspLanguages`)调 `lsp.prewarm` IPC,main 侧 `LspManager.prewarm` 校验已知项目 + java 已启用 + 根目录有 pom/gradle 标记文件后 fire-and-forget `ensureServer`(幂等,活句柄复用不重启),把一次性导入藏进用户浏览项目的时间窗,而不是卡在第一次打开 .java 文件;只预热 java(其它语言秒级启动,无需隐藏),不预热无构建文件的目录(避免白烧 1GB JVM)。② **importing 相位**——探针实证 jdtls 1.37 通过 `language/status` 持续下发 `{type:"Starting", message:"24% Starting Java Language Server - Importing project xxx"}`,`LspStateChangedPayload.phase` 增加 `"importing"` + `detail` 字段,onMessage 把 Starting+百分比消息映射为 `stateChanged{importing, detail:"24% · Importing project xxx"}`,ServiceReady/Started 映射回 running;编辑器 pill(`FileEditor`)显示"{name} 项目导入中… 24% · Importing project xxx",取代神秘超时。③ java 功能请求超时 180s(`JAVA_REQUEST_TIMEOUT_MS`),`sendRequest` 超时打 WARN 进 main.log + java 超时消息附导入提示。工作区 data 目录按项目持久化,导入一次后续启动走恢复路径,秒级就绪。

### 集成终端环境刷新(win32,2026-08-31)

- **问题**:PTY 环境此前是主进程 `process.env` 的冻结快照,启动链路丢失、或 app 启动后才安装的工具(nvm/java/sdkman)在集成终端里不可见——典型症状 `nvm list` 报 `ERROR open \settings.txt`(nvm-windows 靠 `NVM_HOME` 定位,进程里缺这个变量)。系统 PowerShell 正常是因为它由 Explorer 用"当前注册表合并值"启动。POSIX 无此问题:`shellResolve` 用 `-l` login shell,每次建终端都重 source profile。
- **修复**(`main/terminal/envRefresh.ts` 的 `buildTerminalEnv`,`TerminalManager.create` 已 async 化):win32 下每次创建终端时用一次 powershell.exe 现读 HKLM `Session Manager\Environment` + HKCU\Environment(**不用 `reg.exe`**——管道输出是 OEM 代码页,中文 PATH 条目会乱码;PS 里显式 UTF-8),值取**原始未展开**形态(`DoNotExpandEnvironmentNames`,否则会用过期 env 预展开),再按 Windows 构建新进程 env 的语义合并:用户值覆盖系统值、PATH = 系统+用户拼接后展开 `%VAR%`(查找顺序注册表优先、process.env 兜底——USERPROFILE 这类 volatile 变量不在注册表键里)、注册表值大小写不敏感覆盖快照同名项、快照里注册表没有的 PATH 条目去重后**追加回尾部**(保住 `pnpm dev` 等启动链注入的路径)。结果 10s TTL + in-flight 缓存(终端成对创建只读一次注册表),~300ms 冷启动开销。
- **失败策略**:任何失败(PS 缺失/超时 8s/解析不出)降级为纯继承 env 并打 WARN,终端创建永不因刷新而失败。非 win32 平台是 no-op 直通。

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
| P3.5 中间面板 Tab 模式 | ✅ | 中间面板显示模式偏好(单/tab);tabs 模式 = `UnifiedTabsBar` 统一 tab 栏(会话+文件混排,激活视图全宽),single 模式 = 旧分栏布局;关闭 tab 后台 turn 继续运行 |
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

### Worktree 隔离会话(P5.7,2026-09-01,简化单向生命周期)
- **场景**:用户在 develop 上,两个需求并行——各开一个会话、在输入框把「工作环境」切到隔离,首条消息创建 detached worktree,各改各的互不干扰;完成后「合并回」本地分支,删工作树。**刻意裁剪**了完整 playbook(所有权标记/操作台账/状态机/环境切换/初始化脚本/保留策略)——本流程是单向的(local→worktree→merge back→end),安全性靠"合并或删除前必处理未提交改动 + 运行中会话闸 + 补丁导出"三道便宜得多的闸。
- **数据模型**:sessions 表加 `env_mode`(默认 local,老行零迁移)+ `worktree_path`(物化后回填)。**目录可多会话共享**:`StartSessionSchema.worktreePath` 让新会话 BIND 到一个已被其他会话引用的托管目录(main 校验其 ∈ `SessionRepo.listWorktreeRoots()`,任意路径拒绝)——LeftBar 的 worktree 会话行 hover「在此工作树中新建会话」(fork 图标,`startSession(projectId,{worktreePath})`)复用同一 checkout 及其依赖开新线程;绑定即视为物化(目录已存在,首条消息直接使用,resolveSessionCwd 零改动)。**⚠️ 新行路径 bind 后必须回读(2026-09-01 踩坑)**:`applyWorktreeBind` 直接写 DB,`createOrReuseSession` 新建行若继续广播/返回构造时的内存对象(其 `worktreePath` 还是 null),渲染端就把会话归进平铺区而非工作树分组(bind 日志成功、DB 有值、UI 却不挂组)——两条路径都要 `SessionRepo.get(id)` 回读后再 broadcast/return(fresh 复用路径原本就回读,新行路径曾漏)。**意图先行**:composer chip 只写 envMode(`StartSessionSchema.envMode` / `UpdateSessionSettingsSchema.envMode`);**物化在 sendTurn**(`ipc/claude.ts` 的 `resolveSessionCwd`):`envMode=worktree` 且无路径 → `createDetachedWorktree`(base=用户视角 checkout 的 HEAD,先 `rev-parse` 验证)→ **先落库再发 turn**(崩溃后 resume 仍指向 worktree)→ cwd=worktreePath。**cwd 派生是全案枢纽**:写入守卫/bash 守卫/MCP 注入全部吃 `req.cwd` 参数,隔离边界零改动成立。sentinel 追问路径 `cwd: session.worktreePath ?? project.path` 同步。
- **托管目录**:默认 `userData/worktrees/<repo名>/<sessionId尾12>`,**可在设置页改根目录**(settings key `worktree.root`,`worktreeOps.managedWorktreeRoot` 每次创建时现读——只影响未来的 worktree,已物化会话的落库路径不变)。**在所有项目根之外**是铁律。
- **IDE 面板跟环境走(P5.8,2026-09-01)**:`pathGuard` 新增 workspace 根二级合法域——`isKnownWorkspaceRoot` / `findContainingWorkspaceRoot`(项目根优先,**`SessionRepo.listWorktreeRoots()`(sessions.worktree_path 去重)兜底**)。files(listDir/readFile/readBinary/search/grep/writeFile/mkdir/delete/rename/copy)、git(findContainingProject 委托 workspace 版 + discoverRepos 的 known 检查)、terminal、LSP(`assertWorkspace`)四类守卫全部切换。renderer 侧 `sessionStore.selectActiveEnvPath(s)` selector(激活会话的 worktreePath ?? 项目根)驱动 **FilesPanel(文件树,随 envPath remount)/ GitPanel(worktree 会话看到自己仓库的 status/commit/合并冲突)/ TerminalPanel(终端开进隔离 checkout,独立分组桶)/ lspProviders.workspacePath(编辑 worktree 文件时按其根起 LSP——jdtls 是全新导入,故 java prewarm 仍锚定项目根不跟 env)**。「本轮修改」卡片的 worktree 路径点击查看随 readFile 守卫放行而恢复可用。
- **detached 而非带分支**:git 禁止同分支双 checkout;分支名是用户决定,merge 时才落。合并回(`worktreeOps.mergeBackWorktree`):worktree 脏 → `add -A` + auto-commit(仓库无 user.name/email 时 `-c` 内联身份 fallback)→ 本地 `merge --no-edit <worktree HEAD SHA>`(detached commit 直接按 SHA merge 合法);up-to-date 防御;冲突返回 conflictedFiles 走现有 AI 解冲突 UI。**⚠️ simple-git 3.36 的 `raw()` 吞非零退出码(2026-09-01 实测两处)**:`merge-base --is-ancestor` 的"否"(exit 1、stderr 空)与 `git merge` 的冲突(exit 1)**都不抛异常、promise 正常 resolve**——旧代码靠 try/catch 判定,导致 ① `isAncestor` 永远 true →「已合并防御」每次早退:返回 ok 却从不合并、无日志、对话框报成功(用户侧"合并了但文件没回分支",日志里零 merge-back 记录是佐证);② merge 冲突被当成功上报。**修复原则:判定一律不依赖 throw**——`isAncestor` 改用 `merge-base <commit> <ref>` 输出与 commit 全 SHA 比较(祖先 ⇔ 最佳公共祖先就是它本身);merge 后用 `status().conflicted` 判冲突、用修好的 `isAncestor` 探针验证合并真的落地(HEAD 未动且未包含 → 报"合并未生效"错误而不是假成功)。`listWorktrees` 的 `merged` 徽标同因修好。写任何 `raw(["merge-base","--is-ancestor",...])` 式探针前先想这坑。
- **删除与防堆积**(`removeWorktree`):三道闸——①引用该路径的会话有 running turn 拒删(`runtimeManager.runningSessionIds()` ∩ `SessionRepo.listByWorktreePath`);②非 force 时脏拒删;③`exportPatch` 可先把 `git diff --binary --full-index HEAD` 落 `userData/worktree-snapshots/`(遗照,非备份)。目录被手删 → `worktree prune` 自愈。删除后引用会话 `clearWorktreePath` 退化回 local(历史保留)+ broadcast。**常态防堆积**:合并成功默认引导删工作树;**兜底**:Git 面板新增「工作树」子页签(`WorktreeManagerPanel`)——按仓库分组列出 linked worktree,徽标 已合并(`merge-base --is-ancestor`)/无会话引用(孤儿)/脏/目录缺失,删除带 force/导出补丁选项。
- **UI(2026-09-01 调整)**:三处入口分工——① `WorktreeModeChip`(**composer 卡片左上角**的简约文本下拉,11px 触发器)只承担**新建阶段的环境选择**:无仓库项目整体不渲染(`discoverRepos` 带 **`rootOnly: true` 只查项目根本层 `.git`**——worktree 只能在项目根物化,子目录有仓库不算数;项目切换时重探)、非 fresh 会话不渲染(`session.title === "New session"` 占位判定,与后端 fresh-row 复用同规则);**已物化会话渲染成静态 accent 徽标(无下拉)**——环境终身锁定,无可切换。**语义**:chip 显示"当前会话(无会话则新建默认)的生效环境";选择经 `setWorktreeMode` 路由——任何未物化会话在前景时直接编辑该会话的 envMode(双向,`UpdateSessionSettingsSchema.envMode` + patchSessionInCache 本地回写——首版曾把 local→worktree 误路由到全局默认,导致"点了没反应",这是修复要点);空态编辑持久化的新建默认(settings key `session.worktreeDefault`,first-paint 水合)。② **合并回迁到 Titlebar 工具栏**(`WorktreeMergeToolbarButton`,components/chat/WorktreeMergeBack.tsx,排在分支 pill 右侧):仅当激活会话已物化**且**工作树有未合并内容(dirty 或 `!merged`,worktreeList 判定)才渲染,12s 慢轮询 + 会话切换/对话框关闭即刷新。③ **左栏工作树分组**(ProjectNode 按 `normWorktreeKey(worktreePath)` 分桶,`WorktreeGroupNode` 可折叠目录节点 + hover「+」在同一 checkout 新建会话;显示名可重命名,存 settings key `worktree.names`,sessionStore 的 `worktreeNames`/`expandedWorktrees`;激活/新建 worktree 会话自动展开分组):分组右键菜单 = 新建会话 / **合并回本地分支(全量——同组所有会话共享一个 checkout,一次 merge 覆盖全部)** / 重命名。`WorktreeMergeBackDialog` 也是同文件共享组件(preview 用 `git.mergePreview` 传 SHA,**按归一化路径匹配 worktreeList 结果**——porcelain 正斜杠 vs 库存反斜杠,严格相等永远 miss;**"有无可合并" = 新提交 或 工作树脏**——`rev-list` 看不见未提交改动,纯 upToDate 不能禁用合并按钮;冲突留 worktree 重试)。会话列表 SessionRow 标题旁 fork 徽标(session.worktreePath)。
- **依赖安装不自动**:新 worktree 无 node_modules,agent 首轮自理(pnpm 硬链接秒级);Java 是新 jdtls 工作区(分钟级导入)。

### MCP 服务器管理(设置页)
- **三类来源**(`contracts/ipc.ts` "MCP management" 段 + `main/lib/mcpConfig.ts`):① 用户级 = `~/.mcode/.claude.json` 的 `mcpServers`(CLI 原生 user 级位置,`CLAUDE_CONFIG_DIR` 已重定向,settingSources 默认含 user → **binary 自动加载,provider 零注入**;文件即开关);② 项目级 = 项目根 `.mcp.json`(**只读**,永不写项目文件);③ 内置 = 进程内 `mcode-browser` server。
- **开关状态**存 settings 表单 key `mcp.management`(`MCP_MANAGEMENT_SETTING_KEY`,JSON):`userDisabled`(关闭的用户级 server 全量配置暂存,关闭=配置移出文件、开启=移回——SDK options 没有"禁用 user 级 server"的声明式入口,移出文件是唯一可靠手段)、`projectEnabled`(项目 .mcp.json server 的**允许名单**——项目级默认关闭,面板开关替代 CLI 首次审批弹窗,因 `onUserDialog` 对未知 kind 返回 cancelled)、`browserDisabled`。**不向 .claude.json 写自定义 key**(CLI 频繁整体回写该文件,自定义 key 会被冲掉);写文件一律 read-modify-write 保留其它 key + 原子写,不认识的配置条目原样保留(只是不可管理)。
- **provider 注入**(`ClaudeAgentSdkProvider.startTurn` MCP 段):读 `getMcpManagement()`,`browserDisabled` 时不构建 browserServer;cwd 有 `.mcp.json` 时按允许名单算出 `enabledMcpjsonServers`/`disabledMcpjsonServers` **合并进 `options.settings`**(这两个字段在 SDK 的 `Settings` 接口上,不在顶层 `Options`!)。改动下一轮生效(每轮重建 options)。
- **IPC**:`mcp.*` namespace(list/toggle/save/remove/scanImport/import),handler 在 `main/ipc/mcp.ts`(skills.ts 模板:zod parse + findKnownProject 校验 + `{ok,error}` 返回)。`scanImport` 只读扫 `~/.claude.json`(全局 + 各 project 条目,带 origin 标签)——Mcode 因配置重定向**看不到**用户真实 CLI 的 MCP,导入是唯一复用方式。
- **UI**:`McpPanel.tsx`(SkillsPanel/BrowserPanel 模板):用户级(开关+删除+新增表单 dialog:stdio/http/sse 三类型)+ 项目级(managedProjectId Select 切换、只开关)+ 内置(单开关)。`VscMcp` 图标经 `icons.tsx` 的 `McpIcon` 适配层包装(react-icons 的 `stroke` 类型与 TablerIconProps 不兼容,不能直接进 `ComponentType<TablerIconProps>` 槽位)。仅 Claude 会话生效(Pi 走 extension,`supportsMcp:false`),面板 desc 有注明。

---

## 关键提醒

1. **改 ClaudeRuntime 前先读 stream-json 文档**。schema 来自真实 dump,字段名不要猜。
2. **不要打包 claude.exe**。License 合规:只调用用户已装的,不内嵌二进制。
3. **新增 IPC 必走 zod 校验**。这是 renderer→Node 的唯一安全边界。
4. **本机的 superpowers 插件 hook 是坏的**(SessionStart 报 ParserError),与本项目无关——claude 会跳过它,日志里看到不要当成我们的 bug。
5. **空白屏调试**:main 进程已把 renderer 的 `console-message` 转发到 stderr,不用开 DevTools 就能从启动日志看渲染层报错。
