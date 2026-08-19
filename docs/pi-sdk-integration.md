# Pi SDK 集成文档

> 本文档记录 Pi SDK(`@earendil-works/pi-coding-agent`)接入 Mcode 的架构决策与实现说明。
> 后续接入其他 SDK 时,参照本文的**可扩展性设计**模式,而非复制实现细节。

## 1. 背景

Mcode 已有 `AgentProvider` 抽象层(`packages/contracts/src/provider.ts`),后端链路
(RuntimeManager / DB / IPC `provider.list`)完全 provider 中立。但接入 Pi SDK 前:

- 前端没有任何 provider 选择 UI(渲染端从不调用 `api.provider.list`)
- 模型设置(model / effort / permissionMode)与 claude 强耦合
- 会话图标全部写死 `SiClaude`

Pi SDK 与 Claude Agent SDK 平行但 API 形态完全不同:

| 维度 | Claude Agent SDK | Pi SDK |
|------|-----------------|--------|
| 入口 | `query()` 返回 async iterator | `createAgentSession()` + `subscribe()` 事件流 |
| 思考级别 | 6 档(low/medium/high/xhigh/max + default 哨兵) | 8 档(多 off/minimal) |
| 权限模式 | 6 种 PermissionMode | 无内置;tools 白名单代替 |
| 模型选择 | 别名 + customModel 端点重定向 | `provider/id` 格式,`ModelRuntime` 自动发现 |
| 凭证 | `ApiConfig` + `buildCustomEnv()` 注入 `ANTHROPIC_*` 环境变量 | `~/.pi/agent/auth.json` + `models.json` + 环境变量 |
| 工具审批 | `canUseTool` 回调 | 无拦截,工具直接执行 |
| 中断 | `AbortController.abort()` | `session.abort()` |
| 会话续传 | `--resume <session_id>` | `SessionManager` JSONL 文件 |

## 2. 核心设计:声明式 Provider 能力

### 2.1 扩展 `ProviderCapabilities`

`packages/contracts/src/provider.ts` 新增声明式能力描述,UI 据此动态渲染,
**第三个 provider 接入时零 UI 改动**:

```typescript
thinkingLevels?:  { value, label, hint? }[]    // 思考级别列表,空则隐藏 effort chip
permissionModes?: { value, label, icon?, color?, hint? }[]  // 权限模式,空则隐藏 chip
builtinModels?:   { id, label, hint? }[]       // 内置模型别名
supportsCustomEndpoint?: boolean               // 是否支持自定义端点配置
```

各 provider 在自己的 `capabilities` 里声明:
- **claude-sdk**: 6 档 thinking + 4 档 permission + 4 个内置模型 + `supportsCustomEndpoint: true`
- **pi-sdk**: 8 档 thinking + 无 permission + 无内置模型 + `supportsCustomEndpoint: false`

### 2.2 `EffortLevel` / `PermissionMode` 改为开放 string

`runtime.ts` 将两个固定枚举改为 `string`,并保留 claude 语义常量
(`CLAUDE_EFFORT_LEVELS` / `CLAUDE_PERMISSION_MODES`)向后兼容。

IPC 层 3 处 `z.enum([...])` 改为 `z.string()`(`ipc.ts` 的 StartSessionSchema /
SendTurnSchema / UpdateSessionSettingsSchema)。DB 的 TEXT 列无需迁移。
Provider 在 `startTurn` 里做防御性校验,非法值 fallback default。

**向后兼容**:现有 claude 会话的 `effort="high"` / `permissionMode="acceptEdits"`
等值在 `string` 类型下完全兼容。

## 3. Pi SDK Provider 实现

### 3.1 文件结构

```
apps/desktop/src/main/providers/pi-sdk/
  PiAgentSdkProvider.ts   # AgentProvider 实现
  PiMessageAdapter.ts     # AgentSessionEvent -> RuntimeEvent 归一化
```

`registry.ts` 加一行注册:
```typescript
providerRegistry.register(new PiAgentSdkProvider());
```

### 3.2 startTurn 流程

1. **会话管理**: 首轮 `SessionManager.create(cwd)`;续传 `SessionManager.open(path)`
   (路径来自 `req.resumeProviderSessionId`,即存于 `Session.claudeSessionId` 字段——
   该字段语义已泛化为 "provider session id")
2. **模型**: MVP 不传 model,让 Pi 的 `ModelRegistry` 从 `~/.pi/agent` 自动发现
   (`auth.json` + `models.json` + 环境变量)
3. **思考级别**: `req.effort` 映射为 Pi 的 `thinkingLevel`(8 档,"default" 折叠为 undefined)
4. **权限模式**: Pi 无内置,映射为 tools 白名单:
   - `plan` → `["read", "grep", "find", "ls"]`(只读)
   - 其他 → Pi 默认工具集(read/bash/edit/write)
5. **事件流**: `session.subscribe((e) => adapter.dispatch(e))`
6. **驱动**: `session.prompt(req.prompt)` resolve 即 turn 结束
7. **中断**: `session.abort()`;错误分支发 `error` + `turn.done(reason:"error")`

### 3.3 事件映射

| Pi SDK 事件 | RuntimeEvent |
|-------------|-------------|
| `message_update` (text_delta) | `text.delta` |
| `message_update` (thinking_delta) | `thinking` |
| `tool_execution_start` | `tool.use` |
| `tool_execution_end` | `tool.result` |
| `message_start` / `message_end` | 内部 message id 管理 + `message.complete` |
| `agent_end` | `turn.done` (reason: "end_turn") |
| `compaction_end` | `compact.result` (preTokens=0,MVP 占位) |
| 错误 | `error` + `turn.done` |

### 3.4 已知限制(MVP)

- **无工具审批**: `supportsApproval: false`,工具直接执行。后续可用 Pi 的
  `defineTool` 包装内置工具,在 `execute` 里调 `ctx.requestApproval()` 桥接
- **无 token usage**: Pi 事件不含 usage 字段,MVP 不发 `token-usage.updated`,
  ContextRing 不显示。后续从 `turn_end` 的 toolResults / `agent.state` 提取
- **无 AskUserQuestion**: 后续可用自定义工具实现
- **无子代理快照**: Pi 的 extensions 机制与 claude Task 工具不同,`subagent.update`
  MVP 不发

## 4. 模型设置适配

### 4.1 决策:路线 A(两套配置各自独立)

两套配置体系的**模型概念有本质差异**(claude 网关端点 + 扁平模型列表 vs pi 独立模型列表),
字段无法双向映射(contextWindow / maxTokens / reasoning / thinkingLevelMap / compat)。
强行统一(路线 B)会导致 UI 臃肿且信息丢失。

**采用路线 A**: 两套配置各自独立。CustomModelsPanel 顶部用 Claude / Pi 两个 tab 切换,
tab 内是左供应商列表 + 右表单。

> **端点预设已移除**(2026-08):原先在左栏底部有一层"端点预设"(无凭证的
> name/baseUrl/authMode 模板,存 `SettingRepo` key `endpointPresets`,表单里
> "从预设导入"下拉)。该功能连同 `contracts/endpointPreset.ts`、
> `endpointPresetStore.ts`、`ipc/endpointPreset.ts` 与 `endpointPreset.*`
> IPC 通道整体删除——配置足够简单后不再需要预填模板。历史 settings 表里
> 残留的 `endpointPresets` 数据成为孤儿 key,无副作用。

### 4.3 Dropdown 组件改造

- **EffortDropdown**: 从 `capabilities.thinkingLevels` 动态渲染;空则 `return null`
- **PermissionModeDropdown**: 从 `capabilities.permissionModes` 动态渲染;空则隐藏。
  icon 名("shield" 等)由 renderer 的 `ICON_BY_NAME` 映射,契约只传字符串
- **ModelDropdown**: `BUILTIN_MODELS` 写死改为从 `capabilities.builtinModels` 读取;
  `supportsCustomEndpoint` 控制"添加/管理模型"入口
- **StatusBar**: 权限模式 chip 改为从 provider capabilities 读 label/icon/color,
  未知值回退原始字符串 + 中性盾牌图标(修复了枚举改 string 后的潜在崩溃)

### 4.4 Pi 模型配置面板(`~/.pi/agent/models.json` 可视化维护)

设置页"Pi 模型"面板提供 models.json 的表单化编辑器(非原始 JSON),仿
CustomModelsPanel 双栏布局。Pi SDK **没有**写 models.json 的 API(仅内存态
`registerProvider`),且每次 startTurn 都重新 `ModelRuntime.create()` 读取该文件
——所以 GUI 写入后**无需重启即生效**。

```
packages/contracts/src/piModel.ts           # models.json 的 TS 类型 + 常量
apps/desktop/src/main/lib/piModelsStore.ts  # 读写 ~/.pi/agent/models.json + 加密 key 存储
apps/desktop/src/main/ipc/piModels.ts       # IPC handlers(list/save/delete/getApiKey)
apps/desktop/src/renderer/components/settings/PiModelsPanel.tsx  # 双栏表单
```

**设计决策**:
- **API Key 在 GUI 设置中直接维护**: 用户在面板填明文 key,Mcode 用
  `safeStorage.encryptString` 加密后存 settings 表的 `piProviderKeys` 键
  (同 `customModelKeys` 模式)。turn 开始时 `PiAgentSdkProvider` 创建
  `ModelRuntime` 并对每个已配 key 的 provider 调 `setRuntimeApiKey(name, key)`,
  注入到 Pi 进程。`setRuntimeApiKey` 是 Pi SDK 凭证解析链路的第 1 优先级,
  覆盖 `~/.pi/agent/auth.json` 和环境变量。**密钥永远不出 Node 进程**,
  models.json 不含 apiKey 字段。
- **编辑时留空 = 保留旧 key**: 面板 form 提交时若 `apiKey` 为空字符串,
  store 端保留原 ciphertext 不动,避免误删。删除 provider 才一并清理
  models.json 条目和加密 key。
- **仅管理自定义 provider**: 面板只管 models.json 里用户新增的 provider
  (deepseek / one-api 网关等),不管理内置 provider 的 modelOverrides。
- **写入 merge 保留未知字段**: `readModelsFile()` 读取现有文件 → 浅合并
  provider 条目(保留 headers / compat / modelOverrides 等 UI 不管的字段)
  → 按 id 浅合并 models(保留每模型的 compat / cost / input 等)
  → 写回。不整体覆盖,避免毁掉手写的高级配置。apiKey 字段在写入前**被剥离**。
- **表单字段**: name / baseUrl / api(4 选 1: openai-completions · openai-responses ·
  anthropic-messages · google-generative-ai) / apiKey(密码框,创建时必填) /
  authHeader / models[](id / name / contextWindow / maxTokens / reasoning /
  thinkingLevelMap)。
- **thinkingLevelMap 编辑**: 6 个 key(off/minimal/low/medium/high/xhigh,无 max),
  每档三态: 默认(省略) / 不支持(null) / 映射值(string)。
- **校验**(主进程 store + 面板双重): name/baseUrl/api 必填、至少一个模型、
  每模型 id 必填、contextWindow/maxTokens > 0、创建时 apiKey 必填。

## 5. 输入框 SDK 选择

`apps/desktop/src/renderer/components/chat/ProviderDropdown.tsx`:
- 挂在 `ComposerToolbar` 最前(`<ProviderDropdown />` 在 `<ModelDropdown />` 之前)
- `providers.length <= 1` 时隐藏
- **发送后不可更改**: 会话已有消息时 chip 变只读(锁图标),不弹菜单。
  空会话(刚创建未发消息)可切换
- store 新增 `providerId` / `providers` 字段 + `setProvider` / `reloadProviders`
  action;`startSession` 补传 `providerId`;`syncConfigFromSession` 同步 `providerId`

保证不可更改的机制:
- `UpdateSessionSettingsSchema` **不含** providerId,会话建好后无法通过 updateSettings 改
- `ProviderDropdown` 在 `messagesBySession[activeSessionId]` 非空时只读

## 6. 会话图标按 Provider 区分

`apps/desktop/src/renderer/lib/providerIcon.tsx`:

```typescript
getProviderIcon(providerId): { Icon, color }
// "claude-sdk" -> SiClaude + #D97757(橙色)
// "pi-sdk"     -> IconTerminal + #7C3AED(紫色,无品牌图标时的占位)
// 未知        -> IconTerminal + 中性色
```

替换 5 处写死的 `SiClaude`:
- `LeftBar.tsx` SessionRow(944) + 归档行(602)
- `SessionTabs.tsx` SortableTab(321)
- `Titlebar.tsx` ActiveThreadTitle(291,需补取 providerId)
- `CommandPalette.tsx` SessionRowContent(603)

## 7. 实施清单

| 阶段 | 文件 | 改动 |
|------|------|------|
| P1 契约层 | `runtime.ts` | `EffortLevel`/`PermissionMode` 改 string + 语义常量 |
| P1 | `provider.ts` | `ProviderCapabilities` 加 4 个声明式字段 |
| P1 | `ipc.ts` | 3 处 `z.enum` → `z.string`;`ProviderInfo` 类型 |
| P1 | `ClaudeAgentSdkProvider.ts` | 补全 capabilities 声明 |
| P2 Pi 后端 | `pnpm add @earendil-works/pi-coding-agent` | 安装依赖 |
| P2 | `pi-sdk/PiMessageAdapter.ts` | 事件归一化 |
| P2 | `pi-sdk/PiAgentSdkProvider.ts` | AgentProvider 实现 |
| P2 | `registry.ts` | +1 行注册 |
| P3 前端 | `sessionStore.ts` | providerId/providers + action + startSession/syncConfig |
| P3 | `EffortDropdown.tsx` / `PermissionModeDropdown.tsx` / `ModelDropdown.tsx` | 动态渲染 |
| P3 | `StatusBar.tsx` | 权限 chip 动态化 + 崩溃修复 |
| P4 SDK 选择 | `ProviderDropdown.tsx` + `ComposerToolbar.tsx` | 新组件 + 挂载 |
| P4 图标 | `providerIcon.tsx` + 5 处替换 | 按 provider 区分图标 |
| P5 预设 | `endpointPreset.ts` / `endpointPresetStore.ts` / `ipc/endpointPreset.ts` / preload | 端点预设 CRUD |
| P5 | `CustomModelsPanel.tsx` | 预设管理 + 从预设导入 |

## 8. 验证清单

- [ ] `npx tsc --noEmit -p tsconfig.json` 全量通过
- [ ] claude 会话无回归(创建 / 发送 / 续传 / 审批 / 自定义模型)
- [ ] pi 会话: 选 pi → 发送 → 流式渲染 → 工具执行 → turn 结束
- [ ] pi 续传(重开 App 后恢复对话)+ 中断(abort)
- [ ] ProviderDropdown: 空会话可切换,发送后只读(锁图标)
- [ ] 图标: claude 会话橙色 Claude 图标,pi 会话紫色终端图标
- [ ] 设置适配: claude 显 6 档 effort + 4 档 permission + 内置模型 + 自定义入口;
      pi 显 8 档 thinking + 无 permission + 无自定义入口
- [ ] 端点预设: 创建 → 供应商表单"从预设导入"自动填 baseUrl/authMode
