# OpenAI 协议翻译层（Anthropic ↔ OpenAI Bridge）

让 Claude Agent SDK 驱动 **OpenAI 格式**的模型端点（OpenAI 官方 / Azure OpenAI / vLLM / Ollama / one-api / OpenRouter 等），同时完整保留 Claude 的 agent 能力（工具调用、审批、MCP、plan mode、token 统计）。

---

## 1. 为什么需要翻译层

`@anthropic-ai/claude-agent-sdk` 内部封装了一个 claude 二进制，**只发 Anthropic 的 `/v1/messages` 协议**，没有 provider 切换接口（`Options` 里没有 `provider`/`apiProvider` 字段，只有 `env` 能注入环境变量）。所以 SDK 无法直接驱动 OpenAI 格式端点。

项目此前的"自定义模型"功能（`buildCustomEnv` 注入 `ANTHROPIC_BASE_URL`）要求对端实现 Anthropic 协议（如 DeepSeek 的 `/anthropic` 端点）。**纯 OpenAI 格式端点**（标准 `/v1/chat/completions`）走不通。

**翻译层方案**：在 main 进程内起一个本地 HTTP server，伪装成 Anthropic `/v1/messages` 端点。Claude 二进制通过 `ANTHROPIC_BASE_URL` 指向它；它把 Anthropic 协议请求翻译成 OpenAI 格式转发给真实端点，响应再反向翻译成 Anthropic SSE 流回二进制。这样**复用 Claude 二进制的全部 agent 能力**，无需重写 agent loop，也无外部运行时依赖。

```
Claude 二进制 ──Anthropic /v1/messages──▶ 本地翻译层(127.0.0.1:<port>)
                                            │ ① 请求翻译: content blocks→messages, tools→functions
                                            │ ② fetch 真实 OpenAI 端点
                                            │ ③ 响应翻译: OpenAI SSE chunks→Anthropic SSE 事件
                                            ▼
                                   OpenAI / Azure / vLLM / 聚合网关
```

---

## 2. 核心设计：对现有链路透明

关键洞察：`customEnv.ts` 已把 tier→真实模型名映射好（`ANTHROPIC_MODEL` 等），翻译层收到的请求 `model` 字段就是用户配的真实模型名（如 `gpt-4o`）。所以**翻译层只做协议格式翻译，不做模型名改写**，透传 `model` —— 唯一例外：剥离末尾的 `[1m]` 上下文后缀（这是 Anthropic wire 上 DeepSeek 式网关的私有约定，OpenAI 的 chat-completions 协议没有对应物，`model[1m]` 会被网关当成不存在的模型名而回 401/404）。

在 `RuntimeManager.sendTurn` 解密 `apiConfig` 后，若 `cfg.protocol === "openai"`：
1. 启动/复用本地翻译层 server（按 `customModelId` 复用，引用计数）
2. 把 `apiConfig` 改写为 `{ baseUrl: "http://127.0.0.1:<port>", ...原配置 }`
3. 下游 `buildCustomEnv` / `settingSources` / `[1m]` / 诊断日志**全部原样工作**，无需改 `customEnv.ts`

翻译层对 Claude 二进制、`ClaudeAgentSdkProvider`、`SdkMessageAdapter` 都是**不可见的**——它们只看到一个普通的 Anthropic 兼容 localhost 端点。

---

## 3. 模块结构

```
apps/desktop/src/main/providers/bridge/
  types.ts                  # Anthropic/OpenAI 协议的局部类型（不依赖任一 SDK 包）
  requestTranslator.ts      # anthropicToOpenAI(req) — 纯函数
  responseTranslator.ts     # OpenAiToAnthropicSse 状态机类
  bridgeServer.ts           # 本地 HTTP server（http.createServer）+ startBridge()
  bridgeRegistry.ts         # 按 customModelId 复用 server 的注册表（单例，引用计数）
```

**生命周期**：翻译层 server 按 `customModelId` 复用（多会话/turn 共享一个实例，因为同一 turn 内 SDK 还会发后台 tier 请求如 Task 子代理）。`RuntimeManager.sendTurn` 在首次使用时 acquire，`dispose` 时 release；`app.before-quit` 调 `BridgeRegistry.disposeAll()` 关闭所有 server。端口用 `listen(0)` 让 OS 分配空闲端口。

---

## 4. 翻译规格

### 4.1 请求翻译（Anthropic → OpenAI）

| Anthropic | OpenAI |
|---|---|
| `model` | `model`（透传，但剥离 `[1m]` 后缀——OpenAI wire 无此约定，见 §2） |
| `system`（string 或 TextBlock[]） | 首条 `{role:"system", content}` |
| `messages[].content`（string 或 block 数组） | 统一展开为数组再映射 |
| `text` block | content 拼接 |
| `tool_use` block（assistant） | `tool_calls[].{id, type:"function", function:{name, arguments: JSON.stringify(input)}}` |
| `tool_result` block（user） | 拆成独立 `{role:"tool", tool_call_id, content}` 消息（`is_error` 塞进 content 前缀 `[ERROR]`） |
| `max_tokens` | `max_tokens` |
| `temperature` / `top_p` | 透传 |
| `stop_sequences` | `stop` |
| `tools[].{name,description,input_schema}` | `tools[].{type:"function", function:{name,description,parameters:input_schema}}` |
| `tool_choice` auto/any/tool/none | `"auto"` / `"required"` / `{type:"function",function:{name}}` / `"none"` |
| `thinking` | **丢弃**（OpenAI 无对应） |
| `cache_control` | 丢弃（OpenAI 自动 cache） |

### 4.2 响应翻译（OpenAI SSE → Anthropic SSE）状态机

| OpenAI chunk | Anthropic SSE 输出 |
|---|---|
| 第一个 chunk（含 role） | `message_start`（usage 全 0） |
| `delta.content` 首次 | `content_block_start`(text) |
| `delta.content` 后续 | `content_block_delta`(text_delta) |
| `delta.tool_calls[].id` + `name` 首次 | 关闭前块 + `content_block_start`(tool_use) |
| `delta.tool_calls[].function.arguments`（增量） | `content_block_delta`(input_json_delta, partial_json) |
| `finish_reason` | 关闭所有块 + `message_delta`(stop_reason + usage) + `message_stop` |
| `usage`（末尾 chunk） | `message_delta.usage` |

**stop_reason 映射**：`stop`→`end_turn`，`tool_calls`/`function_call`→`tool_use`，`length`→`max_tokens`，`content_filter`→`refusal`，其他→`end_turn`。

**不发 `ping` 事件**（SDK 客户端 `Stream.fromSSEResponse` 直接丢弃）。

**usage 字段**：OpenAI 的 `prompt_tokens`/`completion_tokens` → `input_tokens`/`output_tokens`；cache 字段填 0。

### 4.3 thinking 块策略

OpenAI 不暴露 reasoning 签名，无法真实合成 Anthropic 的 `signature`。策略：**请求丢弃 thinking 配置，响应不合成 thinking 块**。这样不存在多轮续接 thinking 的 signature 校验问题。代价：扩展思考在 OpenAI 模型上不可用（GPT-4o 等本就不支持 Anthropic 式 interleaved thinking）。

### 4.4 认证

翻译层忽略 Claude 二进制发来的内部标识头（route token），用用户配置的真实 token 向 OpenAI 端点发：
- 标准 OpenAI / OpenAI 兼容：`Authorization: Bearer <token>`（`authMode` 的 auth_token / api_key 在 OpenAI 协议里都是 Bearer）
- Azure：按 baseUrl 含 `azure.com` 判断，加 `?api-version=2024-10-21` query 参数，header 用 `api-key: <token>`

---

## 5. 使用方式（用户侧）

1. 设置 → 模型配置 → 新增供应商
2. **API 格式**下拉选 `OpenAI`
3. 填 Base URL（如 `https://api.openai.com/v1`，无需带 `/chat/completions`，翻译层自动补全）
4. 填 Token / API Key
5. 模型列表：添加网关侧的模型 id（如 `gpt-4o`）；后台请求（Haiku/Subagent tier）会自动镜像选中模型的裸 id，无需额外配置
6. 测试连接（两种协议都走完整真实链路，见 §6）
7. 保存 → 在 composer 的模型下拉里选该配置

---

## 6. 测试连接（单一真实链路）

**两种协议统一走 live-turn 的完整链路**（`buildCustomEnv` + `settingSources` + claude 二进制发一条 "hi"），"测得过就能用"：

- **Anthropic 端点**：SDK query 直连用户配置的 baseUrl
- **OpenAI 端点**：SDK query 指向一个**临时 bridge 实例**（`BridgeRegistry.acquire` 用合成 id `probe:<uuid>` 拉起，探测完 release 关闭）——与 `RuntimeManager.sendTurn` 对 live turn 的改写完全一致，测试同时验证了协议翻译、鉴权、模型路由

> 历史：OpenAI 端点曾用"绕过二进制直接 fetch `/v1/chat/completions`"的捷径。它不走桥，把 `resolveActiveModel` 拼出的 `model[1m]` 后缀名原样发到 OpenAI wire 上，网关把带后缀的模型名当成不存在/无权限而回 401——明明 Token 正确却报"认证失败"，且测试结果与 live 行为脱钩。已废弃。

---

## 7. 改动清单

**新增**：
- `providers/bridge/`（5 个文件）
- `contracts/customModel.ts`：`Protocol` 类型 + `resolveProtocol` + 各 interface 的 `protocol?` 字段
- `ipc.ts`：`ProtocolSchema` + Save/Test schema 加 `protocol`

**改动**：
- `secretStore.ts`：`resolveProtocol`、listPublic/save/resolveApiConfig 透传、`migrateMeta` 兼容旧数据（default `"anthropic"`）
- `RuntimeManager.ts`：`sendTurn` 加 OpenAI bridge 分支（acquire + 改写 apiConfig）；`dispose` 加 release；SessionRuntime 加 `bridgeConfigId`/`bridgeHandle`
- `ipc/customModel.ts`：probe 加 OpenAI 分支 + `probeOpenAiEndpoint`
- `index.ts`：`before-quit` 加 `BridgeRegistry.disposeAll()`
- `CustomModelsPanel.tsx`：API 格式下拉 + OpenAI 提示 + 一键填充按钮
- `ModelDropdown.tsx`：OpenAI 配置加 badge

**不需改**：`customEnv.ts`、`ClaudeAgentSdkProvider.ts`、`preload`、`SdkMessageAdapter.ts`、`sessionStore.ts`、IPC 通道常量、`CustomModelEntry` schema。

---

## 8. 风险与已知限制

| 项 | 说明 |
|---|---|
| **tool_calls 流式分片拼接** | OpenAI 把一个 tool call 的 arguments 分多个 chunk 发。翻译层用 `oaiToolIndex → anthropicBlockIndex` 状态机保证分片落到同一块。已用单元测试覆盖（含真实分片拼接回归） |
| **Azure 形态差异** | `api-version` query + `api-key` header，按 host 判断分支 |
| **扩展思考不可用** | OpenAI 模型上 thinking 被丢弃（见 4.3） |
| **模型对 Claude 风格工具的适配** | Claude 二进制的 system prompt / 工具定义是 Claude 风格的，发给 GPT-4o 后模型能否按预期调工具是模型能力问题非架构问题；GPT-4o 系列对 function calling 适配良好 |
| **并发** | 多会话共用同一 OpenAI 配置时，bridge 按 configId 复用 + 引用计数，不会冲突 |

---

## 9. 待联调项（实施后）

- [ ] OpenAI 官方端点（gpt-4o / gpt-4o-mini）：纯对话 + 工具调用 + 多轮
- [ ] Azure OpenAI：`api-version` / `api-key` 分支
- [ ] 聚合网关（one-api / OpenRouter）：连通性
- [ ] 并发：多会话共用同一 OpenAI 配置（验证 bridge 复用 + 引用计数）
