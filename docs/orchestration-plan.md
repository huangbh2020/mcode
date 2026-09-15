# Agent 编排功能规划（Orchestration Plan）

> 状态：设计稿 v2（2026-09-15）
> 参考：Orca Inter-Agent Orchestration 的语义模型（所有权二分 / 完成权威 / decision gate / 运行纪律），传输层按 Mcode 结构化架构重设计。

## 1. 背景与目标

Mcode 目前具备编排所需的全部地基，但没有任何编排能力：

- **多 provider 抽象**：`packages/contracts/src/provider.ts` 的 `AgentProvider` 接口 + `main/providers/registry.ts`（claude-sdk / pi-sdk / codex-sdk），每会话独立 providerId/model/effort → 跨厂商、跨价位的 worker 天然可行
- **subagent 只读观测层**：`SubagentSnapshot` / `subagent.update` / `subagent.transcript`（`packages/contracts/src/runtime.ts:472-551`）+ `TurnFlowPanel` 的 fork/join 泳道 → 编排视图有现成骨架
- **worktree 隔离**：`main/lib/worktreeOps.ts`（detached / branch 两形态）→ 并行写不冲突
- **审批桥**：`main/claude/ApprovalBridge.ts`（canUseTool 网关 + plan 审批 + 结构化问答）→ gate 的交互可复用
- **todo / usage 持久化**：session 行 JSON 列 → 任务状态与成本统计有落库位置

**目标**：让用户把一个大任务拆给多个不同角色/模型/厂商的 agent 并行或流水线执行，同时保住三个约束——成本可控、质量可控（生成/审查分离）、过程可观测可干预。

## 2. 应用场景

| # | 场景 | 说明 |
|---|------|------|
| 1 | 大任务并行拆解 | 多个不相关子任务 fan-out 给多个 agent 同时做 |
| 2 | 成本分层 | 规划/审查用高阶模型，实现/跑量用低阶模型 |
| 3 | 能力差异化 | 文案走 claude，画图走 codex，代码跑量走 glm 等 |
| 4 | 生成与审查分离 | 实现 agent 写码，独立高阶 reviewer 审查，审不过打回重做 |
| 5 | 上下文保护 | 调研/大范围搜索丢给 worker，只回传结论，不污染主会话上下文 |
| 6 | 流水线模板 | 规划→实现→测试→审查→修复 固定链路，可保存复用 |
| 7 | 多方案竞争 | 同一任务 2 个 agent 各出一版，评审/用户择优 |
| 8 | 后台长任务 | 耗时任务移交后台，完成后通知，主会话继续干别的 |

## 3. 核心语义模型（来自 Orca 的关键修正）

### 3.1 编排层是"哑"基础设施，智能在协调者

Runtime 只提供：任务表（DAG + 状态机）、消息总线、决策门、派发器、阻塞等待。谁当协调者、怎么拆任务、怎么分配 agent，由高阶模型决定——**Mcode 不内置一个独立的 planner 服务**，而是把协调能力做成工具交给主会话 agent，外加一个面向普通用户的"内置编排向导"皮套（见 §5）。

### 3.2 监督派发 vs 完全移交（两种语义，协议层就分开）

| | 监督编排（Supervised） | 完全移交（Handoff） |
|---|---|---|
| 所有权 | 协调者持有 DAG，持续等待结果 | 一次性转移，原会话不再监控 |
| 任务记录 | 建 Task/Dispatch 行 | **不建任务行** |
| 生命周期义务 | worker 必须上报 worker_done/心跳/ask | 无，不注入派发上下文 |
| 典型触发语 | "拆开同时做"、"等我结果"、"汇总给我" | "交给 XX 做掉"、"另开会话/worktree 搞定" |
| Mcode 形态 | worker = 带派发上下文的子会话 | worker = 普通新会话（按需 worktree） |

判定由主模型对用户意图分类（见 §6），结果对用户可见（卡片上标"移交 / 编排中"）。

### 3.3 完成权威（Completion Authority）

一次派发的完成凭证 = `runId + taskId + dispatchId + coordinatorSessionId`：

- worker 子会话的元数据显式携带该结构（结构化注入，非 prose preamble）
- worker **精确发一次** `worker_done`（失败也发，标注 failed），payload 含 `filesModified[] / reportPath / summary`
- **心跳 ≠ 完成**：调度器只凭 worker_done / escalation 判定完成；活动流有输出只说明活着
- 等待超时是**检查点不是失败**：查任务表 + 活动流活性，不盲目重跑
- **点对点纪律**：生命周期消息必须定向协调者会话，禁止广播；仅 status 类广播允许多播
- **所有权卫生**：会话恢复时校验 coordinatorSessionId 存活性，防止幽灵上报（Orca 靠 prose 规则防陈旧 preamble，Mcode 靠结构化校验，问题在协议层消失）

## 4. 概念与数据结构

```
AgentProfile（用户定义的"角色"模板）
├─ id / name / icon / color
├─ providerId + model + effort        ← claude / glm / codex ...
├─ systemPrompt（角色指令）
├─ allowedTools[] / permissionMode    ← 低信任 agent 收缩权限
├─ defaultWorktree: active | new | none
├─ tags[]: planning | coding | writing | image | review  ← 路由匹配用
└─ costPerMtok（展示用，可从模型推算）

OrchestrationRun（一次编排运行，作用域 = 父会话，非全局）
├─ id / parentSessionId / status
├─ TaskGraph
│   节点 Task = { id, spec(任务简报), deps[], assignee: AgentProfile,
│                status: pending|ready|dispatched|completed|failed|blocked,
│                artifacts[], result, failureCount }
│   边 = 依赖（fan-out 并行 / 串行 pipeline / 汇合 merge）
├─ Dispatch = { taskId, workerSessionId, dispatchId, injectedAt }
└─ Gate = { id, taskId?, question, options[], status, resolution }

LifecycleMessage：worker_done | heartbeat | ask(→自动产 gate) | escalation | status
```

内置角色模板：规划者（高阶）/ 实现者（低阶 + new worktree）/ 文案（claude）/ 画图（codex）/ 审查者（高阶 + 只读）。

## 5. 架构

```
packages/contracts/src/orchestration.ts     # Task / Dispatch / Gate / LifecycleMessage zod 契约
packages/contracts/src/ipc.ts               # +ORCH_CREATE / ORCH_APPROVE_PLAN / ORCH_NODE_CTRL / ...

main/orchestrator/                          # 哑基础设施（不含规划智能）
├─ OrchestratorService.ts                   # Run 生命周期、状态持久化（挂 session 行）
├─ taskStore.ts                             # 任务表 + 依赖调度 + 熔断
├─ messageBus.ts                            # 生命周期消息收发 + 完成权威校验
├─ gateStore.ts                             # 决策门创建/解决；ask 自动产 gate
├─ dispatcher.ts                            # 创建 worker 子会话（复用 sessionStart.ts）
│                                           #   注入 profile 的 model/prompt/tools/permission
│                                           #   + 派发上下文 {runId,taskId,dispatchId,coordinatorSessionId}
├─ waiter.ts                                # 事件驱动阻塞等待（非轮询）+ 心跳超时判定
└─ worktreePlanner.ts                       # active vs new worktree 决策表（§7）

协调者（二选一，共享同一套状态，UI 都能看）：
A. 内置编排向导  ← 普通用户：plan 卡片（拆解→改派→确认→运行→汇总），
                   由高阶模型驱动但强制走确认卡片，隐藏工具细节
B. 主会话 agent 当协调者 ← 把 task/dispatch/gate/wait 暴露为工具集（MCP 形式），
                   高阶模型自己拆解、派发、check-wait、仲裁
```

worker = 结构化子会话（`kind: 'orch-worker'`，记 parentSessionId），复用 Session 持久化、resume、usage、transcript——断点续跑近乎免费。跨 provider 由 `providerRegistry.resolve(profile.providerId)` 直接达成。

上下文传递：节点间只传"任务简报 + 产物文件路径"（blackboard 模式，产物放固定目录），不传完整对话，禁止节点间自由串话——一切经过协调者。

## 6. 触发与模式分类

主模型先对用户意图做**模式分类**，再决定行为：

| 用户意图信号 | 判定 | 行为 |
|---|---|---|
| "交给 XX agent 做掉"、"另开一个会话/worktree" | 移交 | 新建会话（按需 worktree）+ 简报注入；不建任务、不追踪、不回告 |
| "拆开同时做"、"等我结果"、"汇总给我" | 监督编排 | 建 DAG、注入派发上下文、等 worker_done、汇总 |
| 普通单任务 | 不编排 | 原地执行（可走 in-process subagent） |
| "做完先审查再 PR"等链式意图 | 编排 + gate | 审查节点产出 findings，修复默认派回原实现者，协调者不亲自改文件 |

编排触发三档（设置项，默认"询问我"）：

1. **显式**：Composer `@agent` 选择器（@多个 = 明确并行）、编排模式开关、`/orchestrate`
2. **半自动（默认）**：启发条件命中（≥3 个不相关模块 / 明确并列子任务 / 预估 token 超阈值 / 命中流水线模板）→ 弹"建议编排"卡片确认，不直接执行
3. **自动**（P3 可选）：命中即编排

## 7. 运行纪律（调度器必须编码的规则）

- **熔断**：同任务连败 3 次 → 标记 failed + 升级为 gate 等人决策
- **重试三档**：节点级重试(1 次) → 降级换模型 → 人工接管
- **DAG 约束**：深度 ≤3-4；并发上限可配；按 `ready` 队列波次派发
- **worktree 决策表**（`worktreePlanner`）：
  - 依赖未提交状态 / 需验证当前分支 → 留在 active worktree
  - 独立工作 → 新 worktree（复用 `worktreeOps.ts`）
  - lineage（父/顶层）与 git base（基分支）是两个独立决策
- **审查者不越权**：review 型 worker_done 只报 findings，不授权协调者改文件；修复派回原实现者或新节点
- **循环上限**：reviewer 打回硬上限 N=3 轮，超限升级人工
- **成本控制**：会话预算上限；每节点预估 vs 实时对比；超限暂停询问（走 gate）
- **合并仲裁**：新 worktree 节点完成后经 `WorktreeMergeBack` 审 diff 合并；冲突可选派高阶 agent 解决

Agent 分配三层优先级：用户显式 @ 指定 > 协调者模型分配（计划卡片可改派）> profile tags 路由表兜底。**模型提案、用户审批**——与现有 Plan 模式（planDraft + PlanApprovalPrompt）同一交互范式。

## 8. UI 规划

| 模块 | 位置 | 内容 |
|---|---|---|
| Agents 管理页 | 设置新增 `AgentsPanel.tsx`（仿 CustomModelsPanel） | 角色列表 + 模板一键创建；模型下拉复用 ModelDropdown，权限复用 EffortPermissionControl，工具白名单勾选 |
| Composer 触发 | `ComposerEditor.tsx` 工具条 | @agent 芯片（彩色 icon）、编排开关 |
| 计划确认卡片 | 聊天流内嵌（仿 PlanApprovalPrompt） | DAG 缩略图 + 每节点 agent/模型/预估成本/产物；确认 / 改派 / 追加指令 / 取消 |
| 任务面板 | 扩展 `TurnFlowPanel.tsx` | DAG + 状态机色标 + 心跳活性指示 + 熔断标记；节点级暂停/终止/重试/换模型重跑；实时成本 |
| 收件箱 Inbox | RightPanel 新 tab | 聚合 worker 的 ask / escalation / 待决策 gate，复用 QuestionPrompt 交互解决 |
| 派发动作 | 消息/任务上下文菜单 | "**派发并跟踪**" vs "**移交**" 两个入口，移交的不进任务面板 |
| 运行详情 | worker 节点详情 | worker_done 报告结构化展示（filesModified/reportPath），接 worktree merge-back diff 审查 |
| 审批 | 复用 `ApprovalPrompt.tsx` | 子 agent 敏感操作仍走 ApprovalBridge，带 agent 名字标识；profile 的 permissionMode 为子会话默认档 |

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| 并行写冲突 | 写码节点默认 new worktree；merger 统一合；冲突派高阶模型解 |
| 上下文损耗 | 简报模板化：目标/约束/产物路径/验收标准；节点间只传产物不传对话 |
| 幽灵上报/陈旧义务 | 派发上下文结构化 + coordinatorSessionId 存活校验 |
| 失败与降级 | 重试三档 + 熔断 + DAG checkpoint 从失败节点续跑 |
| 成本失控 | 预算上限 + 实时对比 + 超限 gate |
| 质量参差（低阶跑量） | 生成/审查分离是纪律而非可选；测试通过才算节点完成 |
| 可观测性 | 子会话全量 transcript 落库（复用现有），运行可整体回放 |

## 10. 分期路线

- **P0（地基）**：`orchestration.ts` 契约 + `AgentsPanel` + AgentProfile 持久化 + 两种派发动作（监督/移交）+ taskStore/messageBus + Inbox。不含自动拆解
- **P1（最小编排闭环）**：协调者工具集（主 agent 当协调者）+ DAG 面板 + check-wait 等待语义 + 熔断 + 内置编排向导皮套。覆盖场景 1/2/5/8
- **P2（能力差异化 + 流水线）**：gate 接审批 UI、审查-打回循环（fixes 派回原实现者）、成本面板、worktree 决策表自动化、codex 图片节点、pipeline 模板保存复用。覆盖场景 3/4/6
- **P3（自动化）**：自动触发启发 + 分配学习（记录改派行为）、多方案竞争、终端 CLI worker 逃生舱（复用 terminal 模块，兼容任意 agent CLI）、run 模板市场。覆盖场景 7

## 11. Mcode 相对 Orca 的结构性优势（设计红线）

Orca 的 skill 大量篇幅在防它自己的架构病：TUI 抓屏竞态（tui-idle 等待）、preamble 经终端历史继承导致陈旧义务、CLI 文本协议导致群发误伤。Mcode 用**结构化子会话 + zod 类型化契约 + 事件总线**，这一整类问题在协议层消失——派发上下文是结构体不是 prose，完成凭证是事件不是文本消息。**学 Orca 的语义模型（所有权二分、完成权威、gate、运行纪律），不学它的传输形态。**
