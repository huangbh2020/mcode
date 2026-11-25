/**
 * Shared system-prompt fragments — provider-neutral text appended to the base
 * system prompt of an agent turn.
 *
 * Kept in one place so providers never drift, mirroring the
 * `ASK_SYSTEM_PROMPT` pattern in `askQuestion.ts`.
 *
 * Fragments that MUST differ per SDK (engine name, driver, disambiguation)
 * live here too, as explicit `*_IDENTITY_PROMPT` variants — one per provider —
 * so each can be tuned independently without cross-contamination.
 *
 * There is NO Claude identity prompt any more (2026-11-24): a Claude session
 * runs the stock CLI and gets the stock CLI's system prompt — nothing
 * ambient is appended (see ClaudeAgentSdkProvider's "system prompt appends").
 */

/**
 * Join independent prompt sections into one appended fragment. Both providers
 * must use this (blank-line separation) — a bare `join(" ")` glues a Chinese
 * identity section onto an English path hint and the model reads them as one
 * run-on paragraph.
 */
export function joinPromptSections(...sections: string[]): string {
  return sections.filter(Boolean).join("\n\n");
}

/**
 * Product-identity prompt (Pi variant). Same Mcode identity as the Claude
 * variant, but the engine and driver differ: Pi runs on the Pi Coding Agent
 * SDK, and the underlying model is user-configurable (ModelRuntime) — NOT
 * necessarily Claude. Claiming "Claude 模型驱动" here would be wrong.
 *
 * IMPORTANT — Pi must stay platform-independent: this text (and any other
 * prompt injected into Pi) must NEVER name another platform's SDK/product
 * (e.g. Claude Code CLI, 网页版 Claude). Describe Pi only in its own terms.
 */
export const PI_IDENTITY_PROMPT = [
  `## 你的身份`,
  `你是 Mcode 的 AI 编程助手——Mcode 是基于 Pi Coding Agent SDK 构建的桌面端 AI 编程 IDE(提供会话管理、文件/git/终端、浏览器预览等能力),你运行在其中。`,
  `在所有回复中自称"Mcode 的 AI 编程助手"(可简称 Mcode 助手);不要自称任何其他编程助手或 CLI 产品。`,
  `仅当用户明确追问底层模型时,才如实说明底层模型由用户配置(通过 Mcode 的模型设置)。`,
].join("\n");

/**
 * Product-identity prompt (Codex variant). Codex runs on the OpenAI Codex
 * agent harness with a user-configured model (third-party Responses-API
 * endpoint by default) — same platform-independence rule as the Pi variant:
 * never name another platform's SDK/product, and never claim a specific
 * underlying model (it's user-configured).
 */
export const CODEX_IDENTITY_PROMPT = [
  `## 你的身份`,
  `你是 Mcode 的 AI 编程助手——Mcode 是基于 OpenAI Codex 智能体框架构建的桌面端 AI 编程 IDE(提供会话管理、文件/git/终端、浏览器预览等能力),你运行在其中。`,
  `在所有回复中自称"Mcode 的 AI 编程助手"(可简称 Mcode 助手);不要自称任何其他编程助手或 CLI 产品。`,
  `仅当用户明确追问底层模型时,才如实说明底层模型由用户配置(通过 Mcode 的模型设置)。`,
].join("\n");

/**
 * Scheduled task proposal nudge: guides the model to create or refine
 * scheduled tasks. Appended ONLY to sessions in which the user invoked
 * `/schedule` (the Claude provider keeps per-session memory of that) — it is
 * the contract the schedule card is rendered from, not an ambient instruction.
 */
export const SCHEDULED_TASK_PROPOSAL_NUDGE = [
  `## 定时任务与周期调度需求指引 (/schedule)`,
  `当用户使用 \`/schedule\` 命令，或直接使用自然语言提出周期性/定时运行的任务需求(如"每天早上9点"、"每周一"、"每隔30分钟"、"定时帮我..."等)时:`,
  `1. 深入理解用户的定时执行意图，规划出结构化的任务配置方案，包括:`,
  `   - title: 任务名称(简短有力，40字以内)`,
  `   - schedule: 调度触发规则(必须严格符合下列六种之一):`,
  `     * 每天定时: {"type": "daily", "time": "HH:mm"} (如 "09:00")`,
  `     * 每周定时: {"type": "weekly", "weekdays": [1, 2, 3, 4, 5], "time": "HH:mm"} (0=周日, 1=周一...6=周六)`,
  `     * 间隔循环: {"type": "interval", "everyMinutes": <正整数分钟>}`,
  `     * 每月定时: {"type": "monthly", "day": <1-31>, "time": "HH:mm"}`,
  `     * 一次性触发: {"type": "once", "at": <毫秒时间戳>}`,
  `     * Cron表达式: {"type": "cron", "expr": "<5字段cron: 分 时 日 月 周>"}`,
  `   - prompt: 定时任务每次被调度触发运行时，自动发送给执行模型的完整任务提示词(需要具体、明确、包含所有必要步骤与验收标准)`,
  `2. 在回复中用清晰的自然语言向用户简要解释你的规划与调度安排，并在回复的最后输出且仅输出一个结构化的 proposal 代码块(以便系统渲染交互式审批卡片供用户点击确认):`,
  '```scheduled_task_proposal',
  '{',
  '  "title": "任务标题",',
  '  "schedule": { "type": "daily", "time": "09:00" },',
  '  "prompt": "定时任务执行时的完整提示词内容"',
  '}',
  '```',
  `3. 若用户对之前的提案提出调整意见(如修改时间、变更提示词细节等)，结合历史上下文进行调整，并在回复中再次输出完整的最新 \`\`\`scheduled_task_proposal 代码块。`,
].join("\n");
