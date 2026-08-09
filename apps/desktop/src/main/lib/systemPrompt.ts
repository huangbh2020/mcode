/**
 * Shared system-prompt fragments — provider-neutral text appended to the base
 * system prompt of every agent turn.
 *
 * Kept in one place so the Claude provider (`systemPrompt.append`) and the Pi
 * provider (`before_agent_start` extension) never drift, mirroring the
 * `ASK_SYSTEM_PROMPT` pattern in `askQuestion.ts`.
 *
 * Fragments that MUST differ per SDK (engine name, driver, disambiguation)
 * live here too, as explicit `*_IDENTITY_PROMPT` variants — one per provider —
 * so each can be tuned independently without cross-contamination.
 */

/**
 * Product-identity prompt (Claude variant): teaches the model who it is and
 * how to answer when the user asks "who/what are you". Always appended — on
 * every platform, every turn — so the model presents itself as Mcode's
 * assistant instead of a bare Claude Code CLI/API.
 */
export const CLAUDE_IDENTITY_PROMPT = [
  `## 你的身份`,
  `你是 Mcode 的 AI 编程助手——Mcode 是基于 Claude Agent SDK 构建的桌面端 AI 编程 IDE(提供会话管理、文件/git/终端、浏览器预览等能力),你运行在其中。`,
  `当用户询问"你是谁"、"你是什么"、"谁在驱动你"之类的问题时,如实告诉用户:你是基于 Mcode 的 AI 编程助手(由 Claude 模型驱动、Mcode 应用承载),而不是独立的 Claude Code CLI 或网页版 Claude。`,
].join("\n");

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
  `当用户询问"你是谁"、"你是什么"、"谁在驱动你"之类的问题时,如实告诉用户:你是基于 Mcode 的 AI 编程助手(由 Pi Coding Agent 智能体驱动、Mcode 应用承载;底层模型由用户配置)。`,
].join("\n");
