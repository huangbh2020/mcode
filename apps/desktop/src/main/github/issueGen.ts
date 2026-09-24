/**
 * AI GitHub Issue Generator.
 *
 * Generates professional, standard GitHub-style Issue title and Markdown body
 * based on user prompt, issue kind (bug/feature/general), and project context
 * (package.json metadata, recent git commit history).
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { GitHubGenerateIssueResult, GitHubIssueKind } from "@contracts/ipc";
import { loadClaudeSdk } from "@main/providers/claude-sdk/sdkLoader.js";
import { resolveModelForGitOp, loadSimpleGit } from "@main/ipc/git.js";
import { buildCustomEnv, resolveActiveModel } from "@main/providers/claude-sdk/customEnv.js";
import { resolveSdkBinaryPath } from "@main/providers/claude-sdk/sdkBinaryPath.js";
import { isKnownWorkspaceRoot } from "@main/lib/pathGuard.js";
import { SettingRepo } from "@main/store/repositories.js";
import { UI_TITLE_GEN_MODEL_SETTING_KEY } from "@contracts/ipc";
import { log } from "@main/lib/logger.js";

const ISSUE_GEN_SYSTEM_PROMPT = [
  "你是一个资深的开源软件架构师与 GitHub 顶级项目维护者。",
  "你的职责是：根据用户提供的问题或需求描述，结合当前项目背景，编写一份规范、专业、符合 GitHub 最佳协作实践的 Issue。",
  "",
  "输出规范：",
  "必须严格输出纯 JSON 对象，格式如下（禁止输出 Markdown 代码块标签，不要用 ```json 包裹）：",
  "{",
  '  "title": "规范的 Issue 标题",',
  '  "body": "符合 GitHub 标准 Markdown 格式的完整正文"',
  "}",
  "",
  "内容规范：",
  "1. 标题 (title)：",
  "   - 采用语义化前缀，如：",
  "     - Bug 报告：fix(模块名): 简明问题描述",
  "     - 功能需求：feat(模块名): 简明功能描述",
  "     - 通用改进：refactor(模块名): ... 或 docs: ... / chore: ...",
  "   - 长度在 50 字以内，清晰指出影响的模块与核心现象。",
  "2. 正文 (body)：",
  "   - Bug 报告 (kind=\"bug\") 必须包含：",
  "     ### 🐛 问题描述",
  "     ### 📋 复现步骤 (有序列表 1. 2. 3.)",
  "     ### 🤔 预期行为",
  "     ### 💻 实际行为 / 错误现象",
  "     ### 🔍 补充信息与运行环境",
  "   - 功能需求 (kind=\"feature\") 必须包含：",
  "     ### 🚀 需求背景与痛点",
  "     ### 💡 建议方案",
  "     ### 🔄 备选方案",
  "     ### 📌 补充信息",
  "   - 通用类 (kind=\"general\") 必须包含：",
  "     ### 📌 目标与背景",
  "     ### 📋 详细说明 / 变更清单",
  "     ### 🔍 补充信息",
  "3. 语言：除非用户特别要求英文，默认使用通顺流畅的中文编写；代码标识符与专有名词保持英文原文。",
  "4. 正文排版优美，使用专业的技术语言，紧密契合项目上下文。",
].join("\n");

async function gatherProjectContext(projectPath?: string): Promise<string> {
  if (!projectPath || !isKnownWorkspaceRoot(projectPath)) return "";
  const parts: string[] = [];

  // 1. package.json metadata
  try {
    const pkgPath = path.join(projectPath, "package.json");
    const content = await fs.readFile(pkgPath, "utf8");
    const pkg = JSON.parse(content) as {
      name?: string;
      description?: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    if (pkg.name) parts.push(`- 项目名称: ${pkg.name}`);
    if (pkg.description) parts.push(`- 项目描述: ${pkg.description}`);
    const deps = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ].slice(0, 12);
    if (deps.length > 0) parts.push(`- 主要技术栈/依赖: ${deps.join(", ")}`);
  } catch {
    // optional
  }

  // 2. Recent git commits
  try {
    const git = (await loadSimpleGit())(projectPath);
    const logResult = await git.log({ maxCount: 5 });
    if (logResult.all.length > 0) {
      const commitList = logResult.all.map((c) => `  - ${c.message}`).join("\n");
      parts.push(`- 近期提交历史:\n${commitList}`);
    }
  } catch {
    // optional
  }

  return parts.join("\n");
}

export async function generateIssueContent(opts: {
  projectPath?: string;
  owner: string;
  repo: string;
  prompt: string;
  kind: GitHubIssueKind;
  customModelId?: string | null;
  customModelRole?: string;
}): Promise<GitHubGenerateIssueResult> {
  const context = await gatherProjectContext(opts.projectPath);

  // Model resolution: passed model -> titleGen model fallback -> default
  let modelId = opts.customModelId;
  let modelRole = opts.customModelRole;
  if (!modelId) {
    const fallback = SettingRepo.get(UI_TITLE_GEN_MODEL_SETTING_KEY);
    if (fallback) {
      const idx = fallback.lastIndexOf(":");
      if (idx > 0) {
        modelId = fallback.slice(0, idx);
        modelRole = fallback.slice(idx + 1);
      } else {
        modelId = fallback;
      }
    }
  }

  const { query } = await loadClaudeSdk();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 60_000);

  let releaseBridge: (() => void) | undefined;
  try {
    let model: string | undefined;
    let env: import("@anthropic-ai/claude-agent-sdk").Options["env"];

    if (modelId) {
      const resolved = await resolveModelForGitOp(modelId, modelRole);
      if (resolved.ok) {
        releaseBridge = resolved.releaseBridge;
        const cfg = resolved.config;
        model = resolveActiveModel(cfg);
        env = buildCustomEnv(cfg);
      }
    }

    const binaryPath = resolveSdkBinaryPath();

    const kindLabel =
      opts.kind === "bug"
        ? "Bug 报告 (Bug Report)"
        : opts.kind === "feature"
          ? "功能建议 (Feature Request)"
          : "通用改进 (General Issue)";

    const userPrompt = [
      `请为 GitHub 仓库「${opts.owner}/${opts.repo}」生成一个 ${kindLabel} 类型的规范 Issue。`,
      "",
      `【用户需求与问题描述】:`,
      opts.prompt.trim(),
      "",
      context ? `【项目背景信息】:\n${context}\n` : "",
      "请输出包含 title 与 body 的纯 JSON 对象。",
    ]
      .filter(Boolean)
      .join("\n");

    const q = query({
      prompt: userPrompt,
      options: {
        abortController: ac,
        maxTurns: 1,
        model,
        env,
        systemPrompt: ISSUE_GEN_SYSTEM_PROMPT,
        settingSources: ["project", "local"],
        includePartialMessages: false,
        tools: [],
        ...(binaryPath ? { pathToClaudeCodeExecutable: binaryPath } : {}),
      },
    });

    let rawText = "";
    for await (const m of q) {
      if (m.type === "assistant") {
        const content = (m as { message?: { content?: Array<{ type: string; text?: string }> } }).message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text" && block.text) rawText += block.text;
          }
        }
      }
    }

    // Parse JSON from output
    const jsonMatch = /\{[\s\S]*\}/.exec(rawText);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]) as { title?: string; body?: string };
        if (parsed.title && parsed.body) {
          return {
            title: parsed.title.trim(),
            body: parsed.body.trim(),
          };
        }
      } catch {
        // fallback
      }
    }

    // Fallback if model returned plain text
    return {
      title: opts.prompt.slice(0, 60),
      body: rawText.trim() || opts.prompt,
    };
  } finally {
    clearTimeout(timer);
    releaseBridge?.();
  }
}
