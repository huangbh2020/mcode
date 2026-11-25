# 接入 Claude CLI 技术文档(学习 / 面试用)

> 记录 Mcode 是如何**不依赖 Agent SDK、直接驱动用户本机的 Claude CLI**,并把它的输出渲染成带审批 / 提问 / 计划弹框的图形界面的。
>
> 适用对象:想搞懂"一个 GUI 怎么托管 Claude Code"的人;想在面试里把这个项目讲清楚的人。
>
> 验证基线:Claude Code CLI **2.1.303**(npm 全局安装)、Agent SDK **0.3.327** 的 `sdk.d.ts` / `sdk.mjs` 源码。文中每条结论都标了来源,见 §8.3 的"验证状态表"——**面试时只讲自己验证过的那一档**。
>
> 相关文档:[`claude-stream-json.md`](claude-stream-json.md)(CLI 输出的真实 dump,基于 2.1.186)、[`tech-stack.md`](tech-stack.md) §5.1(两次转向的决策记录)。

---

## 目录

1. [一句话概括](#1-一句话概括)
2. [背景:为什么要从 Agent SDK 转向直连 CLI](#2-背景为什么要从-agent-sdk-转向直连-cli)
3. [基础:Claude CLI 的无头模式](#3-基础claude-cli-的无头模式)
4. [协议详解](#4-协议详解)
5. [关键时序](#5-关键时序)
6. [工程架构](#6-工程架构)
7. [设计要点与踩坑](#7-设计要点与踩坑)
8. [测试与验证](#8-测试与验证)
9. [方案对比](#9-方案对比)
10. [面试问答](#10-面试问答)
11. [一页速记](#11-一页速记)
12. [参考资料](#12-参考资料)

---

## 1. 一句话概括

> **把 Claude Code CLI 当成一个"子进程服务":用两条管道(stdin / stdout)和它说一套 JSON 协议。模型的输出是一条流,审批、提问、计划是 CLI 主动发来的"控制请求"——宿主只负责把它们画成弹框、把用户的选择翻译回去。**

三个面试时必须能脱口而出的要点:

- **协议是 CLI 自己的,不是我们发明的。** 官方 Agent SDK 就是这套协议的一个薄客户端(读它的源码可以证实)。
- **agent loop 完全在 CLI 里。** 宿主不调模型 API、不拼系统提示词、不实现工具——只做进程托管、协议解析、界面渲染。
- **最难的不是解析 JSON,是进程生命周期。** 什么时候算回合结束、什么时候能关 stdin、什么时候必须强杀,这些决定了界面会不会"永远转圈"。

---

## 2. 背景:为什么要从 Agent SDK 转向直连 CLI

### 2.1 改造前的状态

| 方面 | 改造前 |
|------|--------|
| 驱动方式 | `@anthropic-ai/claude-agent-sdk` 的 `query()`;SDK 内部 spawn 它自带(或 Mcode 托管下载)的 `claude` 二进制 |
| 二进制来源 | Mcode 从 npm 下载平台包到 `userData/runtimes`,与用户终端里的 `claude` 是两个版本、两套配置 |
| 提示词 | Mcode 在 CLI 原厂系统提示词之后追加:产品身份("自称 Mcode 助手")、任务拆解引导、定时任务引导、Windows 路径提示、计划模式引导 |
| 计划模式 | 不用 CLI 原生的 `plan` 档,而是跑在 `default` 档 + 一段引导提示词 |

### 2.2 诉求

用户(项目所有者)的原话:"为了保证有和官方 claude cli 的体验,我们不要做任何的加工……直接使用 claude cli,我们只是在这个基础上,对 cli 输出的内容进行页面的展示,包括:审批、计划、问题等的弹框。"

拆成两个目标:

1. **体验一致**——模型拿到的系统提示词、工具集、权限语义,和用户在终端里敲 `claude` 时完全一样;用的是用户自己安装、自己升级的 CLI。
2. **去掉 SDK 依赖**——只依赖外部 CLI,自己解析输出。

### 2.3 一个关键的认知校正

"去掉 SDK"和"不做加工"是**两件事**:

- SDK 包本身**不加任何提示词**。读它的源码(`sdk.mjs`)可以看到:它做的只是拼命令行参数、spawn 二进制、把调用方给它的选项翻译成 CLI 参数和一条 `initialize` 控制请求、在两个方向之间转发控制帧。
- 所谓"加工"全部写在 Mcode 自己的 provider 代码里——是 Mcode 把提示词交给了 SDK。

所以结论是:**只要自己实现这个薄客户端,就能在不损失任何能力的前提下,把 SDK 包和"加工"一起去掉。** 这也是为什么这次改造的核心风险不在"功能能不能做",而在"薄客户端的行为能不能对齐"。

---

## 3. 基础:Claude CLI 的无头模式

### 3.1 三种输出格式

`claude -p`(print,非交互)配合 `--output-format`:

| 取值 | 输出 | 适用 |
|------|------|------|
| `text`(默认) | 纯文本 | 脚本里一次性拿答案 |
| `json` | 单个 JSON(`result`、`session_id`、用量等) | 需要结构化结果但不需要过程 |
| `stream-json` | **NDJSON**,一行一个 JSON 对象,实时推送 | 需要流式渲染、过程事件、双向交互 |

官方文档明确:`stream-json` 的**最后一行是 `result` 消息**,带最终回复文本、成本和会话元数据;进程成功退出码为 0,失败为非零;运行期失败(比如没登录)会作为 `result` 打到 stdout。

### 3.2 双向模式:stream-json 输入

加上 `--input-format stream-json` 后,stdin 也变成 NDJSON:

- 宿主往 stdin 写的每一行是一个 **user 消息**,代表下一个用户回合;
- stdin **保持打开**,就能在一个进程里连续跑多个回合;
- **stdin 关闭(EOF)= 优雅停止信号**。

这一点是整套方案的地基:单次调用是"发一条、读到底",而 GUI 需要的是"随时发、随时问、随时停"。

### 3.3 审批宿主

无头模式没有终端可以弹 `y/n`,那工具审批谁来答?CLI 的设计是把"谁来回答权限询问"做成可插拔的:

| 方式 | 说明 |
|------|------|
| `--permission-prompt-tool stdio` | CLI 把审批请求作为控制帧发到 stdout,宿主在 stdin 上应答。**Agent SDK 的 `canUseTool` 回调走的就是这条路** |
| `--permission-prompt-tool <mcp 工具名>` | 把审批请求转成对某个 MCP 工具的调用 |
| `--permission-prompts none` | 不等宿主,凡是需要询问的一律拒绝(官方文档:2.1.259 起可用) |
| 都不给 | 没人能回答,等同于无人值守 |

官方 `--help` 里对 `--permission-prompts` 的解释很到位:*"Who answers permission prompts with --print: `host` (the SDK host or --permission-prompt-tool) or `none`"*——**打印模式下,"宿主"是一个明确的一等概念。**

### 3.4 常用启动参数

```
claude
  --output-format stream-json          # stdout: NDJSON 消息流
  --verbose                            # 官方示例与 Agent SDK 的启动参数都带着它
  --input-format  stream-json          # stdin: NDJSON,可多回合
  --permission-prompt-tool=stdio       # 审批/提问走 stdio 控制协议
  --include-partial-messages           # 带 token 级 stream_event
  --resume=<session_id>                # 续接会话
  --model <id>  --effort <level>       # 模型与思考强度
  --permission-mode <mode>             # default / acceptEdits / plan / dontAsk / bypassPermissions / auto
  --max-turns <n>  --tools=<list>      # 限制循环次数、限定/禁用工具
  --setting-sources project,local      # 加载哪些配置文件
  --settings <file-or-json>            # 追加一层设置
  --mcp-config <file-or-json>          # MCP 服务器配置
  --forward-subagent-text              # 把子代理的文字以带 parent_tool_use_id 的消息转发出来
```

实测备注(2.1.303):

- **不带 `-p` 也能工作**:给了 `--input-format stream-json` 就是无头模式。Agent SDK 的启动参数里同样没有 `-p`。
- `--permission-prompt-tool` 在 `--help` 里**没有独立条目**,只出现在 `--permission-prompts` 的说明里——它是偏内部的开关,这也是"官方 SDK 走的路"比"自己翻文档"更可靠的原因之一。

---

## 4. 协议详解

### 4.1 全景:一条管道上跑三类东西

```
            宿主(Mcode)                                claude CLI
 stdout ◀── ① 消息流  system / stream_event / assistant / user / result
 stdout ◀── ② 控制帧  control_request(CLI → 宿主)
 stdout ◀──             control_response(对宿主请求的应答)
   stdin ── ③ 控制帧  control_request(宿主 → CLI)/ control_response / control_cancel_request
   stdin ── ① 用户消息 user
```

判断规则只有一条:**先看 `type` 是不是控制帧,剩下的才是会话消息。** 控制帧被传输层吃掉,永远不进渲染层。

### 4.2 stdout 消息流

| `type` | `subtype` | 作用 |
|--------|-----------|------|
| `system` | `init` | 会话元信息:`session_id`、`model`、`tools`、`mcp_servers`、`permissionMode`、`claude_code_version`、`capabilities` |
| `system` | `task_started` / `task_updated` / `task_notification` | 后台任务与子代理的生命周期(`task_type` 区分 `local_agent` / `local_bash` / …) |
| `system` | `background_tasks_changed` | 当前所有后台任务的**全量快照**(水平信号) |
| `system` | `api_retry` | API 请求失败重试(状态码、重试间隔) |
| `system` | `compact_boundary` | 上下文压缩 |
| `stream_event` | — | Anthropic 原生流式事件增量(token 级) |
| `assistant` | — | 完整的 assistant 消息(文本 / 思考 / `tool_use` 块) |
| `user` | — | `tool_result` 的载体;子代理转发的消息 |
| `result` | — | **回合终结**:最终文本、用量、成本、`permission_denials` |

几个容易踩的细节:

- **`tool_result` 不独立成行**,而是包在 `user` 消息的 `content` 数组里;用 `tool_use_id` 和 `tool_use` 块配对。
- **流式阶段与完整消息的分工**:`stream_event` 里的 `text_delta` / `thinking_delta` 用来逐字渲染;随后的完整 `assistant` 消息**不要**再渲染一遍文本(会重复),它的用途是拿到完整的 `tool_use.input`(流式阶段的 `input_json_delta` 只是 JSON 字符串片段)。
- **子代理的消息带 `parent_tool_use_id`**(非 null),用来把子代理的内容路由到独立的转录面板,而不是混进主对话。
- `system/init` 是在**处理第一条用户消息时**发出的,不是进程一启动就发。实测:只拉起进程、不发用户消息,收不到 `init`。

一条 `stream_event` 长这样(文本增量):

```json
{ "type": "stream_event",
  "event": { "type": "content_block_delta", "index": 1,
             "delta": { "type": "text_delta", "text": "my-claude-gui" } },
  "parent_tool_use_id": null, "session_id": "…", "uuid": "…" }
```

### 4.3 控制协议的信封

两个方向共用同一种信封,靠 `request_id` 关联:

```jsonc
// 请求(任一方向发出)。request_id 由发送方生成,在未完成的请求中唯一
{ "type": "control_request",  "request_id": "r1", "request": { "subtype": "…", … } }

// 成功应答。response 是该 subtype 约定的负载,可以省略
{ "type": "control_response", "response": { "subtype": "success", "request_id": "r1", "response": { … } } }

// 失败应答
{ "type": "control_response", "response": { "subtype": "error", "request_id": "r1", "error": "…", "error_code": "…" } }

// 撤回自己发出、尚未应答的请求(没有应答)
{ "type": "control_cancel_request", "request_id": "r1" }
```

这套设计是"单条复用流上的请求 / 应答":没有连接、没有握手加密,全靠 `request_id` 做关联。面试时可以点出它的本质——**在一条有序字节流上做应用层的多路复用**。

### 4.4 握手:`initialize`

宿主 → CLI 的**第一个**控制请求,必须排在任何用户消息之前:

```jsonc
{ "type": "control_request", "request_id": "init-1",
  "request": {
    "subtype": "initialize",
    "appendSystemPrompt": "…",                              // 在原厂系统提示词之后追加
    "supportedDialogKinds": ["permission_exit_plan_mode_v2"] // 声明宿主能渲染哪些工具对话框
  } }
```

应答里是会话的能力面:`commands`(斜杠命令)、`models`、`account`、`claude_code_version`、`current_permission_mode`、`capabilities`(协议能力列表,用来做特性探测而不是猜版本号)。

为什么要单独说它:

- **有些东西只能走这条通道。** `supportedDialogKinds` 没有对应的命令行参数。而 CLI 对它的处理是 fail-closed:没声明的对话框种类**根本不会发过来**——不声明,计划审批弹框就永远不出现。
- **发送顺序有讲究。** Agent SDK 的做法是先写入 `initialize`,再开始写用户消息(源码里 `streamInput` 开头先等 `initializeWritten`)。
- **不需要等应答再发消息。** SDK 默认不等(只有通过握手下发插件 / MCP / 设置等"启动字段"时才加 `--await-initialize` 并等待)。实测 2.1.303:握手约 0.7–1.3 秒应答。

### 4.5 工具审批:`can_use_tool`

模型要执行一个工具,权限规则没能自动裁决,CLI 就来问宿主:

```jsonc
// CLI → 宿主
{ "type": "control_request", "request_id": "ask-1",
  "request": {
    "subtype": "can_use_tool",
    "tool_name": "Bash",
    "input": { "command": "npm test" },
    "tool_use_id": "toolu_01…",          // 关联到 assistant 消息里的 tool_use 块
    "title": "Run npm test",             // CLI 生成的展示文案
    "decision_reason": "…",              // 为什么升级到询问
    "permission_suggestions": [ … ]      // "不再询问"对应的规则变更
  } }

// 宿主 → CLI:允许(可以在执行前改写入参)
{ "type": "control_response", "response": { "subtype": "success", "request_id": "ask-1",
  "response": { "behavior": "allow", "updatedInput": { "command": "npm test" } } } }

// 或拒绝:message 会作为工具错误返回给模型
{ "type": "control_response", "response": { "subtype": "success", "request_id": "ask-1",
  "response": { "behavior": "deny", "message": "用户拒绝了此操作" } } }
```

要点:

- **`updatedInput` 是改写工具入参的合法通道。** Mcode 用它把 Windows 上的 `/mnt/d/…` 之类路径方言归一化后再执行。
- **拒绝不是报错,是给模型的一条消息。** 模型看到 deny 的原因后,可以换一种做法继续——回合不会因此中断。
- **不应答 = 工具一直被阻塞。** 这种请求没有超时,所以宿主如果没有能力回答,必须显式回一个错误,而不是沉默。

### 4.6 提问:`AskUserQuestion`

这是官方 SDK 文档专门强调的一个坑点。`AskUserQuestion` 是一个**工具**,所以它的审批同样走 `can_use_tool`,只是 `tool_name` 是 `AskUserQuestion`。用户的答案不是走别的通道,而是通过 `updatedInput.answers` 塞回去:

```jsonc
// 宿主 → CLI
{ "type": "control_response", "response": { "subtype": "success", "request_id": "ask-2",
  "response": { "behavior": "allow",
    "updatedInput": { "questions": [ /* 原样带回 */ ],
                      "answers": { "用哪个颜色?": "蓝色" } } } } }   // 键 = 问题原文,值 = 选项标签
```

关键在"**这是让对话继续下去的唯一途径**":工具被允许并拿到答案后,同一个回合会接着跑。如果宿主只是把问题渲染出来、却回了一个取消,回合会提前结束。

### 4.7 计划审批:`request_user_dialog`

某些工具在执行时需要弹一个阻塞式的对话框,CLI 把它抽象成通用的 `request_user_dialog`,用 `dialog_kind` 区分种类。目前 Mcode 用到的只有计划批准:

```jsonc
// CLI → 宿主
{ "type": "control_request", "request_id": "dlg-1",
  "request": { "subtype": "request_user_dialog",
               "dialog_kind": "permission_exit_plan_mode_v2",
               "payload": { "plan": "1. …\n2. …" },
               "tool_use_id": "toolu_02…" } }

// 批准
{ "type": "control_response", "response": { "subtype": "success", "request_id": "dlg-1",
  "response": { "behavior": "completed", "result": { "approved": true, "plan": "…", "message": "…" } } } }

// 否决(可带原因,模型会据此修订)
{ "type": "control_response", "response": { "subtype": "success", "request_id": "dlg-1",
  "response": { "behavior": "completed", "result": { "approved": false, "reason": "范围太大" } } } } }
```

两个语义陷阱:

- **`{ "behavior": "cancelled" }` 是一种真实结算**,含义是"用户关闭了对话框",CLI 会执行该对话框的默认行为。它**不能**拿来当"我不认识这个 kind"的兜底。
- **收到没声明过的 kind,正确做法是不应答**(CLI 自己的截止时间会接管),而不是回一个错误或取消。

### 4.8 其它控制请求

| 方向 | subtype | 用途 |
|------|---------|------|
| CLI → 宿主 | `elicitation` | MCP 服务器要向用户要输入(表单 / URL 授权)。Mcode 不渲染,统一回 decline |
| CLI → 宿主 | `hook_callback` / `mcp_message` | 宿主经 SDK 注册了 hook 或进程内 MCP 服务器时才会出现 |
| 宿主 → CLI | `interrupt` | 中断当前回合(应答里有 `still_queued`:中断后仍会执行的排队消息) |
| 宿主 → CLI | `stop_task` | 只停一个后台任务,回合继续 |
| 宿主 → CLI | `set_permission_mode` | 运行时切换权限模式 |
| 宿主 → CLI | `get_context_usage` | 上下文窗口占用(相当于 `/context` 的结构化版本) |
| 任一方向 | 未知 subtype | Agent SDK 的做法:回 `error` + `error_code: "unsupported_request"` |

---

## 5. 关键时序

### 5.1 启动、握手、首轮、审批

```
 宿主                                                  claude CLI
 │  spawn(--output-format stream-json
 │        --input-format stream-json
 │        --permission-prompt-tool=stdio)
 │── control_request: initialize ─────────────────────▶│   stdin 的第一帧
 │◀─ control_response: success ────────────────────────│   commands / models / capabilities …
 │── user: "帮我跑一下测试" ────────────────────────────▶│
 │◀─ system/init ──────────────────────────────────────│   session_id / tools / model
 │◀─ stream_event: content_block_delta(text_delta) ×N ─│   "我来运行测试…"
 │◀─ assistant: { tool_use: Bash } ────────────────────│
 │◀─ control_request: can_use_tool ────────────────────│
 │                                                     │
 │   ┌─ 审批卡 ─────────────────┐                       │   工具在此处被阻塞,
 │   │ 运行 npm test?  [允许][拒绝] │                       │   等宿主的应答
 │   └──────────────────────────┘                       │
 │── control_response: allow ─────────────────────────▶│
 │◀─ user: { tool_result } ────────────────────────────│
 │◀─ assistant: { text } ──────────────────────────────│
 │◀─ result { subtype: "success" } ────────────────────│   回合结束
```

### 5.2 计划审批

```
 │◀─ control_request: request_user_dialog ─────────────│   dialog_kind = permission_exit_plan_mode_v2
 │                                                     │   payload.plan = 计划正文
 │   ┌─ 计划审批卡 ───────────────┐                      │
 │   │ 计划正文   [批准][否决(+意见)] │                      │
 │   └────────────────────────────┘                      │
 │── control_response: completed { approved } ─────────▶│
```

### 5.3 停止

```
 │  用户点击停止
 │── abort: 关闭 stdin(EOF) ───────────────────────────▶│
 │                                                     │   CLI 优雅收尾并退出
 │   (宽限期 2s 内没退出)
 │────────────────────── kill(Windows 上杀整棵进程树) ──▶│
 │◀─ stdout 关闭 → 进程退出 ────────────────────────────│
 │  回合以"已中断"收尾,运行中的任务标记为已终止
```

### 5.4 常驻进程:一个进程服务多个回合

```
 │── user: 第 1 条 ────────────────────────────────────▶│
 │◀─ … result ─────────────────────────────────────────│   回合 1 结束
 │        (stdin 不关;进程因为后台任务继续存活)
 │── user: 第 2 条 ────────────────────────────────────▶│   直接复用同一个进程
 │◀─ … result ─────────────────────────────────────────│   回合 2 结束
 │        (回合结束且没有任何后台任务 → 关闭 stdin)
 │── EOF ─────────────────────────────────────────────▶│   CLI 退出
```

---

## 6. 工程架构

```
┌───────────────────────────────────────────────────────────────────────────┐
│ Renderer(React)                                                           │
│   聊天流 / 审批卡 / 提问卡 / 计划审批卡  ◀── 只消费归一化后的 RuntimeEvent     │
└───────────────────────────────▲───────────────────────────────────────────┘
                                │ Electron IPC(zod 校验)
┌───────────────────────────────┴───────────────────────────────────────────┐
│ Main(Node.js)                                                             │
│                                                                           │
│  RuntimeManager ──▶ ClaudeAgentSdkProvider(历史命名)                      │
│                      │  组装启动选项、权限守卫、审批桥、常驻传输管理           │
│                      ▼                                                    │
│                   claudeCliQuery ──▶ hostMcpHttp  宿主自带工具的 MCP 服务器  │
│                      │  选项 → 命令行参数 / initialize 负载 / 控制请求映射     │
│                      ▼                                                    │
│                   cliTransport ──▶ claudeExecutable  定位本机 CLI          │
│                      │  spawn、NDJSON 读取、控制帧路由、退出与强杀            │
│                      ▼                                                    │
│                   claude 进程(用户自己安装的 CLI)                          │
│                                                                           │
│  SdkMessageAdapter ── CLI 消息 → RuntimeEvent(逻辑未变,只换了类型来源)       │
│  claudeOneShot ────── 标题 / 提交信息 / 意图识别 / 端点探测 的单轮执行器       │
└───────────────────────────────────────────────────────────────────────────┘
```

| 模块 | 职责 | 关键设计 |
|------|------|----------|
| `claudeExecutable.ts` | 找到能直接 spawn 的可执行文件 | PATH → `~/.local/bin`;沿 npm 垫片跟到原生二进制;`--version` 探测 + 最低版本门槛 |
| `cliTransport.ts` | 一个进程一个实例 | stdout 逐行读;控制帧按 `request_id` 分发;stdin EOF → 宽限 → 强杀;进程结局 → 错误类型 |
| `claudeProtocol.ts` | 控制协议的类型与帧构造 | 纯类型 + 纯函数,零依赖 |
| `claudeStreamTypes.ts` | CLI 输出消息的结构类型 | 只描述读到的那部分字段,其余容忍未知 |
| `claudeCliQuery.ts` | `runClaudeCliQuery(prompt, options)` | 选项翻译;启动宿主工具服务器;握手;把提示词流喂进 stdin |
| `claudeOneShot.ts` | `runClaudeOneShot(...)` | 单轮、无工具、停在首个 `result`;端点探测拿到 `init` 即止 |
| `hostMcpHttp.ts` | 把宿主自己的工具暴露给模型 | 回环地址上的无状态 Streamable-HTTP MCP 服务器 |
| `SdkMessageAdapter.ts` | 消息归一化 | 逻辑不动——它本来就是从"解析 NDJSON"的旧实现移植来的 |

**"薄客户端"到底有多薄**:上面前五个模块加起来,做的事情和 Agent SDK 的 `query()` 一一对应。改造中适配器的归一化逻辑零改动,只是把 `import type … from "@anthropic-ai/claude-agent-sdk"` 换成了本地的 `claudeStreamTypes.ts`。

---

## 7. 设计要点与踩坑

每一条都按"问题 → 做法 → 为什么"来写,可以直接当作面试的素材。

### 7.1 Windows 上怎么拉起一个 npm 安装的 CLI

**问题**:`which claude` 找到的是 `claude.cmd`(或无扩展名的 sh 脚本)。`child_process.spawn` 无法直接执行 `.cmd`(CreateProcess 只认可执行文件);开 `shell: true` 又等于把所有参数交给 `cmd.exe` 解析——带空格的路径、JSON 里的引号都会出问题,而且拿不到真实的 CLI 进程 pid。

**做法**:把垫片当作"指针"而不是"程序"。读垫片文本,找出它转发的目标(当前布局是包内的原生 `claude.exe`),直接 spawn 那个文件;读取文件头几个字节确认它是原生二进制(PE / ELF / Mach-O)。找不到目标时才退回到 shell 方式。实测本机:`which` 给的是无扩展名的 sh 垫片,最终被解析到 `…\@anthropic-ai\claude-code\bin\claude.exe`。

**为什么**:直连原生二进制 = 没有中间 shell 进程 → pid 就是 CLI 自己 → 杀进程树、服务扫描(靠命令行签名认进程)都准确。

### 7.2 配置怎么交给 CLI:哪些走命令行,哪些走握手,哪些走文件

**问题**:SDK 的 `Options` 里有几十个字段,直连后每个都要找一个去处。

**做法**:

| 能力 | 去处 |
|------|------|
| 模型、思考强度、续接会话、权限模式、循环上限、工具集 | 公开命令行参数 |
| `settings`、`mcp-config` | 写入 **0600 权限的临时文件**,传文件路径;进程退出即删 |
| 系统提示词追加、可渲染的对话框种类 | `initialize` 控制请求 |
| 宿主进程内的工具 | 回环 HTTP MCP 服务器 + `--mcp-config` |
| 技能白名单 | `--allowedTools Skill(<name>)` |

**为什么 JSON 不放命令行**:Windows 命令行有长度上限(约 32K 字符),而且经过任何一层 shell 都有转义风险;MCP 配置里还有凭据,放在命令行上会被进程列表看到。

### 7.3 stdin 的生命周期:整个方案里最微妙的地方

**问题**:stdin 同时承担三种角色——用户消息的入口、控制应答的入口、优雅停止的信号。关早了会掐断正在进行的对话,关晚了进程永远不退。

**做法与规则**:

1. **一个用户回合进行中,stdin 必须开着。** 否则 CLI 随后发来的审批请求无处应答,回合卡死。这是改造中真实踩到的:单轮执行器"发完提示词就关 stdin",一旦模型调了工具就挂住——修法是保持打开直到拿到 `result`。
2. **回合结束且进程空闲时再关。** EOF 让 CLI 自然退出。
3. **CLI 在有后台任务时会无视 EOF 继续存活**(项目早期实测:关闭 stdin 9.5 分钟后进程仍在跑,因为它在照看模型启动的 dev server)。所以"关了 stdin"不等于"进程会退"。

**为什么**:把 stdin 的三个角色分清楚,才能推出"什么时候能关"。

### 7.4 回合结束 ≠ 进程退出

**问题**:如果"回合结束"被定义为"进程退出",那么模型启动了一个开发服务器之后,回合永远不会结束,输入框永远锁着。这是项目真实出现过的事故。

**做法**:把两件事解耦。**逻辑结束**的判定是:`result` 已到 + 没有运行中的子代理 + 后台命令只等一个有限的时间窗(60 秒)。满足即发 `turn.done`,进程可以继续活着;它退出时再做一次收尾(把仍在"运行中"的条目标记为已终止)。

**为什么**:界面的"忙 / 不忙"应该反映"模型还有没有话要说",而不是"操作系统里还有没有这个进程"。

### 7.5 一个会话一个进程:"两个写者"问题

**问题**:每个回合都新起一个进程去 `--resume` 同一个会话文件,听起来更简单。

**做法与教训**:同一个会话文件**永远只让一个进程写**。后续回合的用户消息直接写进存活进程的 stdin;只有当进程级选项(模型、模式、配置)变了,才先优雅地终止旧进程再起新的。判定"能不能复用"靠一个指纹(cwd、模型、模式、环境变量、MCP 名单、系统提示词追加内容……),指纹不同就重启。

**为什么**:项目历史上所有"审批请求瞬间失败"的事故,根因都是两个进程写同一个会话文件导致的撕裂状态。

### 7.6 进程结局怎么映射成错误

**问题**:`result` 之后进程以非零码退出、进程崩溃、用户中止、二进制不存在——对界面来说含义完全不同。

**做法**:

| 情形 | 结果 |
|------|------|
| 正常完成,退出码 0 | 流正常结束 |
| 用户中止(abort 信号) | 抛"已中止"——界面按"被用户停止"收尾,**不**当成错误 |
| 写了错误 `result` 之后非零退出 | 抛 `Claude Code returned an error result: <result 里的原文>` |
| 其它非零退出 / 被信号杀死 | 抛"以退出码 N 退出 / 被信号 X 终止",附 stderr 尾部 |
| 可执行文件不存在 | 抛"spawn 失败",而不是挂起 |

**为什么要有"错误结果原文替换退出码"**:CLI 的原话("API error 401: …")比"退出码 1"信息量大得多,而且上层(端点探测)靠匹配这段文本里的 401 / 403 / 503 来给用户友好提示。这是从 Agent SDK 的行为里逐项对齐来的。

### 7.7 停止与强杀

**问题**:用户点"停止"之后进程不一定立刻退;Windows 上直接杀 CLI 自己,它会启动的子进程(包管理器、dev server)会变成孤儿。

**做法**:先关 stdin 给 2 秒宽限期;没退再强杀。强杀时在 Windows 上**杀整棵进程树**,而不是只杀 CLI。

**为什么**:优雅退出时 CLI 会自己收拾后台任务;强杀则不会,所以补上树杀。

### 7.8 宿主自己的工具怎么给模型用

**问题**:Mcode 有应用内浏览器,想让模型能操作它。Agent SDK 提供 `createSdkMcpServer`——一个跑在宿主进程里、通过控制通道转发的 MCP 服务器。直连后没有这个通道。

**做法**:改成标准的 MCP 服务器,只是传输层用 **HTTP 而不是 stdio**。每个会话进程起一个监听 `127.0.0.1` 随机端口的 Streamable-HTTP MCP 服务器,以 `{ type: "http", url }` 的形式写进 `--mcp-config`。

**为什么是 HTTP 而不是再起一个 stdio 子进程**:工具的处理函数需要访问主进程里的浏览器管理器。走 HTTP 就能在主进程里直接处理;走 stdio 则需要一个中间子进程再转发回主进程。

**安全**:这是本机上任何进程都能访问的端口,而工具能操作用户的浏览器——所以 URL 路径里放一个随机 token(没有 token 一律 404),并校验 `Host` 头防 DNS 重绑定。

**实测**:真实 CLI 2.1.303 启动即连上,`system/init.mcp_servers` 里显示 `connected`,工具出现在工具清单里。

### 7.9 没有 SDK 包了,类型和兼容性怎么办

**问题**:SDK 的 `sdk.d.ts` 事实上是这套协议的文档。包删掉以后,类型从哪来?CLI 自己升级了怎么办?

**做法**:

- **类型**:把实际读到的字段整理成本地的结构类型。只描述用到的部分,其余字段容忍未知;联合类型里保留一个兜底成员。
- **向前兼容**:未知消息类型、未知控制子类型、未知字段——一律忽略(或回 `unsupported_request`),绝不因为不认识而崩。
- **版本门槛**:启动前 `--version` 探测,低于最低版本直接拒绝并提示升级(而不是带着残缺功能跑)。门槛的依据是具体的协议特性:stdio 权限通道、计划对话框的种类名。
- **只用公开或实测过的命令行参数**,逐个在真实 CLI 上验证过不报错。
- **用假 CLI 把协议固化成测试**(见 §8.2)。

**为什么**:版本不再由自己钉死(用户自己升级 CLI),兼容性只能靠"保守解析 + 回归测试"来守。

### 7.10 "不做加工"的边界

**问题**:"与官方体验一致"说得容易,但一个 GUI 难道什么都不加吗?

**做法**:画一条线——**凡是会改变"模型看到什么"的,都是加工。**

| 类别 | 处理 |
|------|------|
| 常驻的系统提示词(身份、行为引导、路径提示) | 全部移除 |
| 额外开启的非官方工具(为了让任务进度胶囊有数据而开的任务工具) | 移除 |
| 计划模式:把 CLI 原生 `plan` 档换成 `default` + 引导提示词 | 改回原生 `plan` 档 |
| 用户自己触发的功能所必需的提示(用户打了 `/schedule`;用户打开了自动编排开关;用户在设置里填的自定义提示词) | 保留——它们是功能本身的工作原理,不是环境性的加工 |
| 不影响模型指令的宿主功能(权限守卫、自定义端点、MCP 配置、应用内浏览器工具) | 保留 |

**为什么**:用户的诉求是"模型的表现和官方一样"。凡是模型看不见的宿主逻辑,不影响这个目标;凡是模型看得见的,都要有用户的明确意图作为依据。

### 7.11 健康检查的误区

**问题**:想知道"CLI 能不能用",原来的做法是起一个会话、设置循环上限为 0,等 `init` 消息。

**发现**:循环上限为 0 **并不阻止 CLI 发起模型请求**。实测它照样调用 API,还会在用户的会话历史里留下一条记录。

**做法**:改成直接探测 `--version`。它证明的事情和原来一样多(`init` 本身并不验证鉴权),但零副作用。

### 7.12 流式渲染的不重复、不乱序

- **文本只在增量里渲染**,完整的 `assistant` 消息只用来补全 `tool_use`。
- 渲染端的增量缓冲**按真实到达顺序**应用(项目早期踩过坑:一个渲染帧窗口跨越"正文 ↔ 思考"边界时,固定先正文后思考,会把块对调)。
- 纯空白的文本块会被丢弃(模型在思考段前后常输出裸换行)。

---

## 8. 测试与验证

### 8.1 分层

| 层 | 对象 | 成本 | 覆盖什么 |
|----|------|------|----------|
| 真实 CLI 探测 | 本机 `claude`,隔离配置目录 | 零(不调模型) | 拉起、握手、`system/init`、MCP 连接、退出与强杀 |
| 假 CLI 进程冒烟 | 一个讲同一套协议的 Node 脚本 | 毫秒级 | 所有控制请求的往返、失败形态、进程管理 |
| 既有冒烟回归 | 项目的 35 个冒烟脚本 | 分钟级 | 改造有没有碰坏别处 |

### 8.2 假 CLI:为什么需要,怎么设计

**为什么**:审批、提问这些往返只有真实的子进程 + 真实的管道才能测出来;而真实 CLI 需要模型配合才会发出这些请求。所以写一个 `fake-claude.mjs`,它:

- 讲同一套协议:读 stdin 的控制帧和用户消息,往 stdout 写 `init` / `assistant` / `user` / `result` / 控制请求;
- 用用户消息的首词决定场景(`TOOL` 发出审批请求、`PLAN` 发出计划对话框、`CRASH` 模拟崩溃、`HANG` 模拟挂起……);
- 把自己拿到的 `--settings` / `--mcp-config` 文件内容转储出来,供断言。

**它真实抓到的问题**(都是靠它才发现的):

1. 单轮执行器"发完提示词就关 stdin"→ 应答送不进去(§7.3)。
2. 假 CLI 自己的一处不忠实:一看到 stdin 关闭就退出,而真实 CLI 会把进行中的回合跑完——这反过来提醒了"EOF 语义"必须精确。

**规模**:139 条断言,覆盖参数翻译、握手、双回合复用、审批允许 / 拒绝、提问、计划批准 / 否决 / 无人应答、取消、上下文用量、单任务停止、错误结果、崩溃、中止、超时强杀、HTTP MCP 服务器(34 条)、CLI 定位夹具、版本门槛、单轮执行器。

### 8.3 验证状态表

面试时按这个表来决定一句话能不能说"我验证过"。

| 结论 | 状态 |
|------|------|
| Agent SDK 是薄客户端:同样的启动参数、`initialize` 负载、控制请求分发 | ✅ 读 SDK 0.3.327 源码实证 |
| 直接 spawn 的原生 `claude.exe` 能正常拉起并进入无头模式 | ✅ 实测 2.1.303 |
| `initialize` 握手约 0.7–1.3 秒应答,返回命令 / 模型 / 版本 / 能力表 | ✅ 实测 |
| 所有启动参数形态被 CLI 接受 | ✅ 实测(含未写进 `--help` 的 `--plugin-dir-no-mcp`) |
| 回环 HTTP MCP 服务器在启动时被 CLI 连上并列入工具清单 | ✅ 实测 |
| stdin EOF 后进程退出;无视 EOF 的进程在宽限期后被强杀 | ✅ 实测 |
| 循环上限为 0 不阻止模型请求 | ✅ 实测(以及上游返回 503 时的重试行为) |
| 各控制请求的往返(审批、提问、计划、取消、停止、用量) | ✅ 假 CLI 进程 + 真实管道;⚠️ **未在真实模型上跑**(改造时上游端点持续 503) |
| HTTP MCP 的 `tools/call` 经真实 CLI 调用 | ⚠️ 只验证了连接与工具清单;调用本身由 HTTP 层冒烟覆盖 |
| CLI 原生 `plan` 档下的计划审批 | ⚠️ 未在真实模型上回归 |
| 控制帧的 JSON 格式 | 📖 没有独立的官方文档页(headless、permissions 两页都没有给出);以 SDK 类型声明与源码为准 |

### 8.4 既有冒烟回归的结果

35 个脚本:29 个通过。其余 6 个逐个判定如下(判定方法:看失败日志 + 查相关文件的 git 历史 + 确认这些文件在工作区里未被改动):

| 脚本 | 判定 |
|------|------|
| `github-smoke` | 存量问题:`GitHubClient.ts` 在 9 月 23 日后续提交里引入了 `electron` 导入,冒烟没跟着补桩。已修(补桩后 42 条通过) |
| `runtime-update-smoke` | 存量问题:安装器在 10 月 20 日把"有更新"的判定从"不等于钉版"改成"严格低于钉版",冒烟断言没跟着改 |
| `mobile-pair-auth-smoke` | 存量问题:脚本在 Git Bash 下用 `/tmp/...` 路径拼 `file://` URL,Windows 上的 Node 不认 |
| `model-anchor-smoke` | 33 条检查全过,但进程结束后不退出(渲染端 store 的句柄) |
| `shell-reveal-smoke` | 存量问题:它的 electron 桩缺 `app` 导出 |
| `sqlite-migration-smoke` | 预期状态:它要求原生模块是 Node ABI,而每次 `pnpm install` 的 postinstall 都会换成 Electron ABI(应用运行所需) |

**面试可以讲的点**:回归发现失败时,先判断"是不是我引起的"再动手——依据是 git 历史和工作区状态,而不是直觉。

---

## 9. 方案对比

| 方案 | 体验一致性 | 审批 / 提问 / 计划 | 版本耦合 | 复杂度 | 适用 |
|------|:---:|:---:|---|---|------|
| **直连 CLI + stdio 控制协议**(本方案) | 完全一致 | ✅ 结构化,可事中拦截 | 跟用户的 CLI 走,需要兼容性回归 | 中:进程管理、协议解析 | 要做完整图形界面的宿主 |
| Agent SDK | 一致 | ✅ 同上(内部就是同一套协议) | SDK 与 CLI 需成对版本 | 低 | 不介意多一个依赖、由自己钉版本的宿主 |
| CLI + `--permission-prompt-tool <mcp 工具>` | 一致 | ✅ 审批变成对 MCP 工具的调用 | 同上 | 中:要另起一个 MCP 服务器来接审批 | 已经用 MCP 做宿主集成的场景 |
| CLI + `--permission-prompts none` / `dontAsk` | 一致 | ❌ 一律拒绝,无人值守 | 同上 | 低 | 定时任务、批处理 |
| PTY 终端(伪终端里跑交互式 CLI) | **界面也一致** | CLI 自己画,但宿主拿不到结构化数据 | 低(TUI 是 CLI 承诺兼容的接口) | 低:只负责终端仿真 | "最新版 CLI 的原生体验";**不适合**做审批卡等结构化界面 |
| 直接调模型 API,自己实现 agent loop | 不一致 | 自己实现 | — | 极高 | 不推荐(重新发明 CLI) |

Mcode 实际上同时用了两端:聊天会话走直连协议(结构化),另有"终端会话"走 PTY(原生界面)。

---

## 10. 面试问答

> 每题给出"30 秒答法"和可能的"追问"。

**Q1. 为什么不用官方的 Agent SDK?**

答:两个原因。一是产品诉求:要和官方 CLI 的体验完全一致,用用户自己安装、自己升级的 CLI。二是技术判断:读完 SDK 源码后发现它是个薄客户端——拼参数、spawn 二进制、转发控制帧,没有不可替代的东西。所以自己实现这一层是可行的,成本在于要把它的行为逐项对齐。

追问:*那 SDK 存在的意义是什么?* —— 它把协议类型化了,并且和 CLI 成对发布、成对测试。自己实现等于把"版本成对"的责任接了过来,所以要用保守解析、版本门槛和回归测试来补。

**Q2. 无头模式下工具审批是怎么做的?**

答:启动时加 `--permission-prompt-tool=stdio`。模型要执行一个规则没能自动裁决的工具时,CLI 不会自己决定,而是往 stdout 发一条 `can_use_tool` 控制请求,然后阻塞。宿主把它画成审批卡,用户选择后,宿主往 stdin 写 `control_response`:允许的话还可以通过 `updatedInput` 改写入参;拒绝的话带一段 `message`,它会作为工具错误返回给模型,模型可以换种方式继续。

追问:*宿主一直不回会怎样?* —— 工具无限期阻塞,这种请求没有超时。所以宿主没能力回答时必须显式回错误。

**Q3. 怎么判断一个回合结束了?**

答:协议层面是 `result` 消息——CLI 保证每个回合恰好发一条。但产品层面要再进一步:`result` 之后可能还有子代理在跑,或后台命令在跑。所以"逻辑结束"的条件是 `result` 已到、没有运行中的子代理、后台命令只等一个有限时间窗。进程本身可以继续活着。

追问:*为什么不直接等进程退出?* —— 模型启动一个开发服务器之后进程永远不退,界面就会永远显示"运行中"。这是项目真实出过的事故。

**Q4. 用户点"停止"之后发生了什么?**

答:关闭 stdin。对 CLI 来说 EOF 是优雅停止信号,它会中断当前回合并退出;宿主给 2 秒宽限期,没退就强杀,Windows 上杀整棵进程树(否则模型启动的子进程会变孤儿)。界面侧收到的是"已中止",不按错误处理。

追问:*能只停某一个后台任务吗?* —— 能,发 `stop_task` 控制请求,回合不中断,CLI 随后会发一条 `task_notification` 通知该任务已停止。

**Q5. 怎么把宿主程序自己的能力暴露给模型?**

答:做成 MCP 服务器。CLI 原生支持 MCP,宿主只需要在 `--mcp-config` 里声明。我选了 HTTP 传输而不是 stdio:工具的处理函数要访问主进程里的状态,走 HTTP 可以直接在主进程里处理;走 stdio 就得再起一个中间进程转发。因为工具能操作用户的浏览器,服务器监听回环地址,URL 里带随机 token,并校验 Host 头。

追问:*为什么 Agent SDK 里不用这么麻烦?* —— 它有一个进程内 MCP 服务器的机制,靠控制通道转发。直连后没有这个通道,所以换成标准的 HTTP MCP。

**Q6. CLI 是用户自己升级的,它变了怎么办?**

答:三道防线。第一,保守解析:未知类型、未知字段一律忽略,协议本身是增量演进的。第二,版本门槛:启动前探测版本,低于已知可用的最低版本直接拒绝,而不是带着残缺功能跑——比如计划审批依赖的对话框种类名是某个版本之后才有的。第三,把协议固化成测试:用一个讲同一套协议的假 CLI 进程,跑真实的管道,覆盖所有往返。

追问:*怎么知道某个版本可不可用?* —— 优先用 `system/init` 里的 `capabilities` 做特性探测;其次是读 SDK 的类型声明(它是协议的事实文档);最后是在真实 CLI 上实测。

**Q7. Windows 上启动一个 npm 全局安装的命令行工具有什么坑?**

答:三个。一是 npm 生成的是 `.cmd` 垫片,`spawn` 不能直接执行;二是开 `shell: true` 能跑,但参数要过 `cmd.exe` 的解析,带空格的路径和 JSON 都容易出问题,而且拿到的 pid 是 shell 的;三是配置类的 JSON 不能放命令行——有长度上限,还有凭据泄露到进程列表的风险。我的做法:读垫片找到它真正转发的原生可执行文件,直接 spawn 它;配置写临时文件。

**Q8. 一个会话跑多个回合,是每个回合起一个进程,还是共用一个?**

答:共用。每个回合起新进程去续接同一个会话文件,意味着可能有多个进程同时写一个文件——项目历史上所有"审批瞬间失败"的事故都源于此。共用进程的做法是:后续消息直接写进存活进程的 stdin。只有进程级的选项变了(模型、模式、配置)才重启,靠一个指纹来判断能不能复用。

**Q9. 这套控制协议如果让你来设计,关键点是什么?**

答:我会说四个。一是关联:在一条有序流上做多路复用,必须有请求 id,并且要有"撤回请求"的机制,否则一轮中断后对方会永久等待。二是 fail-closed:宿主没声明能渲染的对话框,就不要发过来;不认识的请求回错误而不是沉默——宁可明确地不做,也不含糊地乱做。三是能力协商:`initialize` 交换能力表,让双方按对方支持的特性行事,而不是靠猜版本号。四是生命周期:流的关闭(EOF)要有明确语义。

**Q10. 用户反馈"审批弹框不出现"或"界面一直转圈",你怎么排查?**

答:按链路从外往里查。进程活着吗(命令行签名能找到 CLI 进程吗)→ 握手成功了吗(日志里有 initialize 的应答吗)→ 声明对话框种类了吗(没声明计划审批就不会发)→ 控制请求到了吗(日志里有没有 `can_use_tool`)→ 应答写出去了吗(stdin 是不是已经关了)→ 回合结束了吗(`result` 到了之后卡在哪个条件:子代理、后台命令、还是进程没退)。项目里每一环都有日志锚点,CLI 自己的调试日志在另一个文件里。

**Q11. 这次改造最大的风险是什么?**

答:如实说——有两处没有在真实模型上验证。改造当天上游端点一直返回 503,所以审批、提问、计划这几条链路只通过假 CLI 验证了协议往返,没有跑过真实的模型对话;CLI 原生 `plan` 档下的计划审批也是同理。另外有一个设计上的历史包袱:之前不用原生 `plan` 档是因为它在某个竞态下会丢审批请求,现在前提条件已经变了(后续回合不再续接会话),但需要真实环境再确认。

**Q12. 这个项目里你觉得最有含金量的一点是什么?**(开放题,参考答法)

答:把"进程生命周期"和"产品语义"对齐。举一个例子:直觉上"回合结束"等于"进程退出",但只要模型启动了一个常驻服务,这个等式就不成立了,界面会永远转圈。解决方案是把两者解耦——用协议信号(`result` 加任务名单)定义逻辑结束,让进程的存活只负责"还能不能继续对话"。这类问题的难点不在代码量,在于想清楚每个信号到底代表什么。

### 讲述这个项目的模板

- **30 秒**:我做了一个 Claude Code 的图形界面宿主。它不依赖官方 SDK,直接把用户本机的 `claude` 当子进程拉起来,通过 stdin / stdout 上的 JSON 协议通信。模型的输出渲染成聊天流,审批、提问、计划这些是 CLI 发来的控制请求,由界面画成弹框再翻译回去。
- **2 分钟**:在 30 秒版基础上加三点——① 为什么能不用 SDK(读源码确认它是薄客户端);② 最难的部分(回合结束与进程存活解耦、stdin 的生命周期);③ 怎么保证质量(假 CLI 进程冒烟 + 真实 CLI 探测 + 既有回归),以及哪些还没验证。

---

## 11. 一页速记

**命令**

```
claude --output-format stream-json --verbose --input-format stream-json \
       --permission-prompt-tool=stdio --include-partial-messages [--resume=<id>]
```

**stdin 写什么**

```
{"type":"control_request","request_id":"…","request":{"subtype":"initialize", …}}   ← 必须第一帧
{"type":"user","message":{"role":"user","content":"…"},"parent_tool_use_id":null}
{"type":"control_response","response":{"subtype":"success","request_id":"…","response":{…}}}
{"type":"control_request","request_id":"…","request":{"subtype":"interrupt"}}
```

**stdout 读什么**

```
system/init · stream_event · assistant · user(tool_result) · result          ← 会话消息,进渲染层
control_request(can_use_tool / request_user_dialog / elicitation)             ← 控制帧,传输层处理
control_response                                                               ← 应答宿主的请求
```

**三个应答模板**

```
审批允许: {"behavior":"allow","updatedInput":{…}}
审批拒绝: {"behavior":"deny","message":"…"}
提问作答: {"behavior":"allow","updatedInput":{"questions":[…],"answers":{"问题":"答案"}}}
对话框:   {"behavior":"completed","result":{…}}   |   {"behavior":"cancelled"}(= 用户关闭,慎用)
```

**五条铁律**

1. `initialize` 先于一切;要计划审批就必须声明 `supportedDialogKinds`。
2. 回合进行中 stdin 不能关——控制应答要从这里进。
3. 不认识的对话框不应答;没能力回答的审批要显式拒绝。
4. 一个会话文件只有一个写者。
5. 回合结束看协议信号,不看进程是否退出。

---

## 12. 参考资料

**本仓库**

| 文件 | 内容 |
|------|------|
| `apps/desktop/src/main/providers/claude-sdk/cliTransport.ts` | 传输层:spawn、NDJSON、控制帧路由、退出与强杀 |
| `apps/desktop/src/main/providers/claude-sdk/claudeCliQuery.ts` | 启动器:选项 → 参数 / 握手 / 控制请求映射 |
| `apps/desktop/src/main/providers/claude-sdk/claudeProtocol.ts` | 控制协议类型与帧构造 |
| `apps/desktop/src/main/providers/claude-sdk/claudeStreamTypes.ts` | CLI 输出消息的结构类型 |
| `apps/desktop/src/main/providers/claude-sdk/hostMcpHttp.ts` | 回环 HTTP MCP 服务器 |
| `apps/desktop/src/main/lib/claudeExecutable.ts` | 定位本机 CLI |
| `apps/desktop/scripts/claude-cli-transport-smoke/` | 假 CLI 冒烟(`fake-claude.mjs` + `run.sh`) |
| [`docs/claude-stream-json.md`](claude-stream-json.md) | CLI 输出的真实 dump 与字段说明 |
| `AGENTS.md`「claude 解析」节 | 行为细节与历次事故记录 |

**官方文档**

- 无头模式:https://code.claude.com/docs/en/headless
- 权限与规则:https://code.claude.com/docs/en/permissions
- 权限模式:https://code.claude.com/docs/en/permission-modes
- CLI 参数参考:https://code.claude.com/docs/en/cli-reference
- Agent SDK(TypeScript):https://code.claude.com/docs/en/agent-sdk/typescript
- SDK 流式输出:https://code.claude.com/docs/en/agent-sdk/streaming-output
- SDK 用户输入与权限宿主:https://code.claude.com/docs/en/agent-sdk/user-input

> 阅读提醒:CLI 迭代很快。本文的实测基于 2.1.303;面试引用时以官方文档和你自己的实测为准。

---

## 附:术语表

| 术语 | 含义 |
|------|------|
| 无头模式(headless / print) | 没有终端界面的运行方式,`-p` 或 stream-json 输入 |
| NDJSON | 一行一个 JSON 对象的流式格式 |
| 控制协议 | 宿主与 CLI 之间的请求 / 应答帧,和会话消息共用 stdout / stdin |
| `initialize` | 会话握手,宿主声明能力、CLI 返回能力面 |
| 宿主(host) | 拉起 CLI 并回答其权限询问的程序,这里是 Mcode 主进程 |
| 逻辑回合 | 用户发一条消息到模型最终作答的一个周期 |
| 常驻传输 | 一个 CLI 进程服务多个逻辑回合 |
| MCP | Model Context Protocol,给模型挂载外部工具的标准协议 |
| PTY | 伪终端,让程序以为自己连着真实终端 |
