/**
 * Claude provider — drives the USER'S Claude CLI and implements the
 * AgentProvider interface from @contracts/provider.
 *
 * No Agent SDK package sits in the path. The provider spawns the `claude` the
 * user installed (lib/claudeExecutable.ts) through cliTransport.ts /
 * claudeCliQuery.ts, which speak the CLI's own headless protocol (stream-json
 * frames + control requests). Mcode hosts the CLI rather than reshaping it:
 * it renders what the CLI emits — approval, question and plan dialogs are the
 * CLI's own control requests, answered from the renderer — and enforces the
 * permission rails. Nothing AMBIENT is appended to the CLI's system prompt;
 * the only fragments are ones the user switched on themselves (see the
 * system-prompt appends in startTurn).
 *
 * The file and class keep their historical names: the provider id
 * "claude-sdk" is persisted in SQLite, and the docs and smoke scripts refer
 * to these names.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  AgentProvider,
  StartTurnRequest,
  ProviderContext,
  TurnHandle,
  ProviderCapabilities,
  UserInputAnswers,
} from "@contracts/provider";
import { effortLevelValuesForModel } from "@contracts/customModel";
import type { AskUserQuestionItem, PermissionMode } from "@contracts/runtime";
import { SdkMessageAdapter, parseQuestions, type AdapterCarryover } from "./SdkMessageAdapter.js";
import {
  buildCustomEnv,
  MCODE_CONFIG_DIR,
  resolveActiveModel,
} from "./customEnv.js";
import { buildShadowingSettingsEnv } from "@main/lib/claudeSettingsSync.js";
import type { ClaudeContextWindowTag } from "./claudeTokenUsage.js";
import type { ClaudeUserInputMessage } from "./claudeStreamTypes.js";
import type { CanUseTool, OnUserDialog } from "./claudeProtocol.js";
import {
  assertClaudeCliUsable,
  ClaudeCliUnavailableError,
  runClaudeCliQuery,
  type ClaudeCliOptions,
  type CliQuery,
} from "./claudeCliQuery.js";
import type { HostMcpServerSpec } from "./hostMcpHttp.js";
import { SCHEDULED_TASK_PROPOSAL_NUDGE, joinPromptSections } from "@main/lib/systemPrompt.js";
import { resolveAgentSkillInjections } from "@main/lib/agentSkills.js";
import { getFileSnapshot } from "@main/lib/fileSnapshotRegistry.js";
import {
  FILE_MUTATING_TOOLS,
  FILE_READING_TOOLS,
  FileSnapshot,
  getToolFilePath,
  getToolReadPath,
  normalizeToolFilePath,
} from "@main/lib/fileSnapshot.js";
import { guardBashCommand } from "@main/lib/bashWriteGuard.js";
import { guardReadPath } from "@main/lib/readGuard.js";
import {
  MIN_CLAUDE_CLI_VERSION,
  compareVersions,
  probeClaudeCliVersion,
  resolveClaudeExecutable,
} from "@main/lib/claudeExecutable.js";
import { killProcessTree } from "@main/lib/procTree.js";
import { resolveGitBash } from "@main/lib/binaryResolve.js";
import { samePath } from "@main/lib/pathGuard.js";
import { getMcpManagement, readProjectMcpServers } from "@main/lib/mcpConfig.js";
import { getOutputStyleSetting } from "@main/lib/outputStyleConfig.js";
import { join } from "node:path";
import { unlinkSync } from "node:fs";
import {
  loadTranscript,
  alignPrompts,
  positionalPromptRow,
  planTailCut,
  serializeTranscript,
  rewriteTranscriptFile,
  countSdkPromptRows,
} from "@main/lib/claudeTranscript.js";
import { findClaudeProjectDir } from "@main/lib/claudeCli.js";
import type { ProviderReviseInput } from "@contracts/provider";
import { getCustomPromptSetting } from "@main/lib/customPrompt.js";
import { getEnabledPlugins, getPluginMcpServers } from "@main/plugins/pluginManager.js";
import { resolveSubagentModelValue } from "@main/lib/subagentModel.js";
import { normalizeBashCommand } from "@main/lib/msysPath.js";
import {
  ORCH_PLAN_MCP_SERVER,
  buildOrchPlanHostServer,
  buildOrchPlanNudge,
  isOrchPlanTool,
} from "@main/orchestrator/planTool.js";
import {
  browserList,
  browserNavigate,
  browserSnapshot,
  browserClick,
  browserType,
  browserKeys,
  browserScroll,
  browserWait,
  browserHistory,
  browserSelect,
  browserFind,
  browserSwitchTab,
  browserCloseTab,
  browserUploadFile,
  browserSavePdf,
  browserDownloads,
  browserEvaluate,
  browserScreenshot,
  BROWSER_TOOL_SPECS,
  BROWSER_TOOLS_FLOW,
  browserScript,
} from "@main/browser/agentBrowserTools.js";
import { gateBrowserNavigation } from "@main/browser/domainGate.js";

/** Anthropic image content-block media-type allowlist — mirrors
 *  SendTurnImageSchema.mimeType (the zod enum already restricts to this set). */
type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

/** A queue-backed prompt feed: the provider pushes one user message per
 *  LOGICAL turn, and the transport keeps writing them to the CLI's stdin for
 *  the lifetime of the CLI process (each message is one stdin line = the
 *  CLI's next user turn). The iterable ends when `close()` is called, which
 *  is what lets the CLI process exit: the provider closes the feed when the
 *  turn is over AND the process has nothing left to babysit (no running
 *  subagents, no live background bash commands — a lingering dev server keeps
 *  the process and the feed alive, and follow-up turns keep riding it). */
interface PromptFeed {
  push(m: ClaudeUserInputMessage): void;
  close(): void;
  iterable: AsyncIterable<ClaudeUserInputMessage>;
}

function makePromptFeed(): PromptFeed {
  const queue: ClaudeUserInputMessage[] = [];
  let ended = false;
  let wake: (() => void) | null = null;
  const iterable: AsyncIterable<ClaudeUserInputMessage> = (async function* () {
    while (true) {
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }
      if (ended) return;
      await new Promise<void>((r) => {
        wake = r;
      });
    }
  })();
  return {
    push(m) {
      if (ended) return;
      queue.push(m);
      wake?.();
      wake = null;
    },
    close() {
      if (ended) return;
      ended = true;
      wake?.();
      wake = null;
    },
    iterable,
  };
}

/**
 * Build the stdin user message for one logical turn: a text block (with the
 * `/schedule` natural-language rewrite — the CLI treats a leading slash as an
 * internal command and would exit on an unrecognized one) plus any inline
 * base64 image blocks (the same inline-encoding the Claude Code CLI uses for
 * user-attached images). Image-only turns send no text block (the images
 * still reach the model).
 */
function buildTurnUserMessage(req: StartTurnRequest): ClaudeUserInputMessage {
  const content: (
    | { type: "text"; text: string }
    | { type: "image"; source: { type: "base64"; media_type: ImageMediaType; data: string } }
  )[] = [];
  if (req.prompt.trim()) {
    let text = req.prompt;
    // Claude CLI interprets leading slash in prompt as an internal CLI command.
    // Unrecognized slash commands (like /schedule) are treated as CLI commands,
    // resulting in immediate exit with 0 tokens and no model output.
    // Rewrite leading /schedule to an explicit natural language instruction so it reaches the model safely.
    if (/^\/schedule\b/i.test(text.trim())) {
      const body = text.trim().replace(/^\/schedule\s*/i, "");
      text = `请为我创建或调整以下定时任务（/schedule）：\n${body}`;
    }
    content.push({ type: "text", text });
  }
  for (const img of req.images ?? []) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: img.mimeType as ImageMediaType, data: img.data },
    });
  }
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
  } satisfies ClaudeUserInputMessage;
}

/** Per-logical-turn completion tracker. The TurnHandle's `done` resolves when
 *  the ADAPTER's logical end fires (result seen, subagents idle, bash
   *  patience respected) — NOT when the CLI process exits. The process may keep
   *  running for a long time after the turn is over (a dev server it started);
   *  the message stream keeps draining in the background so late roster edges
   *  and post-turn resume content still land. */
interface TurnTracker {
  promise: Promise<void>;
  /** Idempotent resolve. */
  resolve(): void;
  isEnded(): boolean;
}

function makeTurnTracker(): TurnTracker {
  let resolveInner!: () => void;
  let ended = false;
  const promise = new Promise<void>((r) => {
    resolveInner = () => {
      if (ended) return;
      ended = true;
      r();
    };
  });
  return { promise, resolve: resolveInner, isEnded: () => ended };
}

/** One CLI process serving a session across logical turns (the persistent
 *  transport). The process outlives individual turns whenever background
 *  work runs (a dev server keeps it — and the stdin feed — alive; the CLI
 *  ignores stdin EOF while it babysits background tasks, so closing the feed
 *  early would only strand it process-side with follow-ups unable to ride
 *  it). Follow-up turns push into the live feed instead of spawning a second
 *  CLI on the same session file — two writers on one session is the torn
 *  state every permission-ask failure here has ever traced back to. */
interface LiveTransport {
  sessionId: string;
  /** Kills the CLI process (user stop / reap / dispose). Shared by every
   *  TurnHandle issued over this transport. */
  ac: AbortController;
  feed: PromptFeed;
  feedClosed: boolean;
  /** The live query; replaced by the transport-retry loop. stopTask routes
   *  here so per-task stop works across (and after) logical turns. */
  query: CliQuery;
  /** Everything the CLI process bakes in at spawn (model, env, mode, cwd…).
   *  A follow-up whose fingerprint differs reaps the process and respawns —
   *  per-process options can't change mid-flight. */
  fingerprint: string;
  /** Current logical turn's adapter. Swapped per follow-up; the drain loop
   *  always dispatches here. */
  adapter: SdkMessageAdapter;
  /** Mutable turn number for the browser MCP server's screenshot paths. */
  turnNumberBox: { n: number | undefined };
  /** The background drain; resolves when the generator closes (process
   *  exit) — which may be long after every turn it served is done. */
  drain: Promise<void>;
  done: boolean;
}

/** Stable string describing everything the CLI process bakes in at spawn.
 *  Two turns with equal fingerprints can share one process; a difference
 *  means the old process must be reaped (its background tasks die with it —
 *  model/mode/config changes are deliberate user acts). NOTE `resume` is
 *  deliberately excluded: turn 1 of a fresh session spawns with no CLI
 *  session id and turn 2 resumes with one — same process identity either
 *  way (follow-ups never re-resume; fresh spawns use the current binding). */
function transportFingerprint(req: StartTurnRequest, options: ClaudeCliOptions): string {
  return JSON.stringify({
    cwd: req.cwd,
    model: options.model ?? null,
    effort: options.effort ?? null,
    permissionMode: options.permissionMode ?? null,
    skills: options.skills ?? null,
    orchestration: req.orchestration === true,
    binary: options.executable?.command ?? null,
    env: options.env ?? null,
    mcp: [
      ...Object.keys(options.mcpServers ?? {}),
      ...Object.keys(options.hostMcpServers ?? {}),
    ].sort(),
    settings: options.settings ?? null,
    systemAppend: options.systemPrompt?.type === "preset" ? options.systemPrompt.append ?? "" : "",
  });
}

/**
 * Build the host MCP server that exposes the `browser_*` tools to Claude (the
 * counterpart of Pi's `pi.registerTool`; served to the CLI over loopback
 * HTTP — see hostMcpHttp.ts). Each tool's handler delegates to the shared
 * `agentBrowserTools` implementation so both providers drive the browser
 * identically.
 *
 * The CLI surfaces each tool to canUseTool as `mcp__mcode-browser__<name>`;
 * the read-only ones (list/snapshot/screenshot) are auto-approved by
 * `shouldAutoApprove`, while navigate/click go through the normal approval
 * prompt. Screenshots return an image content block that the store parses
 * from the tool_result to render inline.
 */
function buildBrowserMcpTools(
  projectPath: string,
  sessionId: string,
  /** Resolved at CALL time, not construction time: the server lives as long
   *  as the CLI process (the persistent transport), which serves several
   *  logical turns — a statically captured turn number would pin every
   *  follow-up turn's screenshots into the first turn's directory. */
  getTurnNumber: () => number | undefined,
): HostMcpServerSpec {
  return {
    version: "1.0.0",
    instructions: "Mcode 应用内浏览器控制工具。" + BROWSER_TOOLS_FLOW,
    alwaysLoad: true,
    tools: [
      {
        name: "browser_list",
        description: BROWSER_TOOL_SPECS.browser_list.description,
        inputSchema: {},
        handler: async () => browserList(),
      },
      {
        name: "browser_navigate",
        description: BROWSER_TOOL_SPECS.browser_navigate.description,
        inputSchema: {
          url: z.string().describe("目标 URL,http(s):// 网页或 file:/// 本地文件"),
          browserId: z.string().optional().describe("目标浏览器视图 id;省略则自动复用当前目标视图或新建"),
          device: z
            .enum(["desktop", "iphone", "android"])
            .optional()
            .describe("打开方式:desktop(PC 全宽,默认)/iphone(移动端)/android(移动端),仅新建视图时生效"),
          newTab: z.boolean().optional().describe("true=强制新开一个标签页再导航"),
          backend: z
            .enum(["chrome"])
            .optional()
            .describe("true=在用户真实 Chrome 中打开(需先在设置里连接 mcode-connector 扩展;仅允许已信任域名/localhost)"),
        },
        handler: async (args: Record<string, unknown>) =>
          browserNavigate(
            {
              url: args.url as string,
              browserId: args.browserId as string | undefined,
              backend: args.backend === "chrome" ? "chrome" : undefined,
              device: args.device as "desktop" | "iphone" | "android" | undefined,
              newTab: args.newTab === true,
            },
            projectPath,
            { sessionId },
          ),
      },
      {
        name: "browser_snapshot",
        description: BROWSER_TOOL_SPECS.browser_snapshot.description,
        inputSchema: {
          backend: z.enum(["chrome"]).optional().describe("true=读取用户真实 Chrome 的当前标签页"),
          browserId: z.string().optional().describe("目标浏览器视图 id;省略则用当前目标视图"),
        },
        handler: async (args: Record<string, unknown>) =>
          browserSnapshot({ browserId: args.browserId as string | undefined, backend: args.backend === "chrome" ? "chrome" : undefined }),
      },
      {
        name: "browser_click",
        description: BROWSER_TOOL_SPECS.browser_click.description,
        inputSchema: {
          index: z.number().optional().describe("要点击元素的索引(来自最近一次 browser_snapshot 的 [n]),优先使用"),
          selector: z.string().optional().describe("要点击元素的 CSS selector(index 的替代写法)"),
          coordinateX: z.number().optional().describe("视口坐标点击的 X(canvas 等无 selector 元素用)"),
          coordinateY: z.number().optional().describe("视口坐标点击的 Y"),
          browserId: z.string().optional().describe("目标浏览器视图 id;省略则用当前目标视图"),
        },
        handler: async (args: Record<string, unknown>) =>
          browserClick({
            index: typeof args.index === "number" ? args.index : undefined,
            selector: typeof args.selector === "string" ? args.selector : undefined,
            coordinateX: typeof args.coordinateX === "number" ? args.coordinateX : undefined,
            coordinateY: typeof args.coordinateY === "number" ? args.coordinateY : undefined,
            browserId: args.browserId as string | undefined,
          }),
      },
      {
        name: "browser_type",
        description: BROWSER_TOOL_SPECS.browser_type.description,
        inputSchema: {
          index: z.number().optional().describe("目标输入元素的索引(来自最近一次 browser_snapshot),优先使用"),
          selector: z.string().optional().describe("目标输入元素的 CSS selector(index 的替代写法)"),
          text: z.string().describe("要输入的文本内容;空串=清空字段"),
          clear: z.boolean().optional().describe("true(默认)=清空后输入;false=追加到现有内容之后"),
          browserId: z.string().optional().describe("目标浏览器视图 id;省略则用当前目标视图"),
        },
        handler: async (args: Record<string, unknown>) =>
          browserType({
            index: typeof args.index === "number" ? args.index : undefined,
            selector: typeof args.selector === "string" ? args.selector : undefined,
            text: typeof args.text === "string" ? args.text : "",
            clear: args.clear !== false,
            browserId: args.browserId as string | undefined,
          }),
      },
      {
        name: "browser_keys",
        description: BROWSER_TOOL_SPECS.browser_keys.description,
        inputSchema: {
          keys: z.string().describe('按键或组合键,如 "Enter" / "Escape" / "Tab" / "ArrowDown" / "Control+a" / "Shift+Enter"'),
          browserId: z.string().optional().describe("目标浏览器视图 id;省略则用当前目标视图"),
        },
        handler: async (args: Record<string, unknown>) =>
          browserKeys({
            keys: typeof args.keys === "string" ? args.keys : "",
            browserId: args.browserId as string | undefined,
          }),
      },
      {
        name: "browser_scroll",
        description: BROWSER_TOOL_SPECS.browser_scroll.description,
        inputSchema: {
          direction: z.enum(["up", "down"]).describe("滚动方向"),
          pages: z.number().optional().describe("滚动量(单位=视口高,默认 1;10≈滚到底)"),
          selector: z.string().optional().describe("改为滚动该元素内部的滚动区"),
          browserId: z.string().optional().describe("目标浏览器视图 id;省略则用当前目标视图"),
        },
        handler: async (args: Record<string, unknown>) =>
          browserScroll({
            direction: args.direction === "up" ? "up" : "down",
            pages: typeof args.pages === "number" ? args.pages : undefined,
            selector: typeof args.selector === "string" ? args.selector : undefined,
            browserId: args.browserId as string | undefined,
          }),
      },
      {
        name: "browser_wait",
        description: BROWSER_TOOL_SPECS.browser_wait.description,
        inputSchema: {
          selector: z.string().optional().describe("等待该 CSS selector 元素出现"),
          text: z.string().optional().describe("等待该文本出现在页面中"),
          seconds: z.number().optional().describe("固定等待秒数"),
          timeoutSeconds: z.number().optional().describe("等待超时(默认 10,上限 30)"),
          browserId: z.string().optional().describe("目标浏览器视图 id;省略则用当前目标视图"),
        },
        handler: async (args: Record<string, unknown>) =>
          browserWait({
            selector: typeof args.selector === "string" ? args.selector : undefined,
            text: typeof args.text === "string" ? args.text : undefined,
            seconds: typeof args.seconds === "number" ? args.seconds : undefined,
            timeoutSeconds: typeof args.timeoutSeconds === "number" ? args.timeoutSeconds : undefined,
            browserId: args.browserId as string | undefined,
          }),
      },
      {
        name: "browser_history",
        description: BROWSER_TOOL_SPECS.browser_history.description,
        inputSchema: {
          action: z.enum(["back", "forward", "reload"]).describe("后退/前进/刷新"),
          browserId: z.string().optional().describe("目标浏览器视图 id;省略则用当前目标视图"),
        },
        handler: async (args: Record<string, unknown>) =>
          browserHistory({
            action: args.action as "back" | "forward" | "reload",
            browserId: args.browserId as string | undefined,
          }),
      },
      {
        name: "browser_select",
        description: BROWSER_TOOL_SPECS.browser_select.description,
        inputSchema: {
          index: z.number().optional().describe("下拉框元素的索引(来自最近一次 browser_snapshot),优先使用"),
          selector: z.string().optional().describe("下拉框元素的 CSS selector(index 的替代写法)"),
          value: z.string().describe("选项的 value 或精确可见文本"),
          browserId: z.string().optional().describe("目标浏览器视图 id;省略则用当前目标视图"),
        },
        handler: async (args: Record<string, unknown>) =>
          browserSelect({
            index: typeof args.index === "number" ? args.index : undefined,
            selector: typeof args.selector === "string" ? args.selector : undefined,
            value: typeof args.value === "string" ? args.value : "",
            browserId: args.browserId as string | undefined,
          }),
      },
      {
        name: "browser_find",
        description: BROWSER_TOOL_SPECS.browser_find.description,
        inputSchema: {
          selector: z.string().optional().describe("按 CSS 查询元素(与 text 二选一)"),
          text: z.string().optional().describe("在页面文本中搜索(与 selector 二选一)"),
          regex: z.boolean().optional().describe("text 按正则解释(默认字面)"),
          caseSensitive: z.boolean().optional().describe("区分大小写(默认不区分)"),
          contextChars: z.number().optional().describe("文本匹配的上下文字符数(默认 150)"),
          maxResults: z.number().optional().describe("最多返回条数(默认 25)"),
          attributes: z.array(z.string()).optional().describe('selector 模式下要提取的属性,如 ["href","src"]'),
          cssScope: z.string().optional().describe("把查找范围限定在该 CSS selector 内"),
          browserId: z.string().optional().describe("目标浏览器视图 id;省略则用当前目标视图"),
        },
        handler: async (args: Record<string, unknown>) =>
          browserFind({
            selector: typeof args.selector === "string" ? args.selector : undefined,
            text: typeof args.text === "string" ? args.text : undefined,
            regex: args.regex === true,
            caseSensitive: args.caseSensitive === true,
            contextChars: typeof args.contextChars === "number" ? args.contextChars : undefined,
            maxResults: typeof args.maxResults === "number" ? args.maxResults : undefined,
            attributes: Array.isArray(args.attributes) ? (args.attributes as unknown[]).filter((a): a is string => typeof a === "string") : undefined,
            cssScope: typeof args.cssScope === "string" ? args.cssScope : undefined,
            browserId: args.browserId as string | undefined,
          }),
      },
      {
        name: "browser_switch_tab",
        description: BROWSER_TOOL_SPECS.browser_switch_tab.description,
        inputSchema: {
          browserId: z.string().describe("要切换到的浏览器视图 id(browser_list 查询)"),
        },
        handler: async (args: Record<string, unknown>) =>
          browserSwitchTab({ browserId: args.browserId as string }),
      },
      {
        name: "browser_close_tab",
        description: BROWSER_TOOL_SPECS.browser_close_tab.description,
        inputSchema: {
          browserId: z.string().describe("要关闭的浏览器视图 id"),
        },
        handler: async (args: Record<string, unknown>) =>
          browserCloseTab({ browserId: args.browserId as string }),
      },
      {
        name: "browser_upload_file",
        description: BROWSER_TOOL_SPECS.browser_upload_file.description,
        inputSchema: {
          index: z.number().optional().describe("文件输入框元素的索引(来自最近一次 browser_snapshot),优先使用"),
          selector: z.string().optional().describe('文件输入框元素的 CSS selector(index 的替代写法)'),
          paths: z.array(z.string()).describe("要上传的本地文件路径数组(绝对路径,或相对项目根的路径)"),
          browserId: z.string().optional().describe("目标浏览器视图 id;省略则用当前目标视图"),
        },
        handler: async (args: Record<string, unknown>) =>
          browserUploadFile(
            {
              index: typeof args.index === "number" ? args.index : undefined,
              selector: typeof args.selector === "string" ? args.selector : undefined,
              paths: args.paths,
              browserId: args.browserId as string | undefined,
            },
            projectPath,
          ),
      },
      {
        name: "browser_save_pdf",
        description: BROWSER_TOOL_SPECS.browser_save_pdf.description,
        inputSchema: {
          fileName: z.string().optional().describe("保存的文件名(不含路径;省略则按时间戳命名)"),
          paperFormat: z.enum(["letter", "legal", "tabloid", "a3", "a4", "a5"]).optional().describe("纸张格式,默认 a4"),
          landscape: z.boolean().optional().describe("横向(默认纵向)"),
          printBackground: z.boolean().optional().describe("是否打印背景色/图(默认 true)"),
          scale: z.number().optional().describe("缩放 0.1-2(默认 1)"),
          headerFooter: z.boolean().optional().describe("显示页眉页脚(默认 false)"),
          browserId: z.string().optional().describe("目标浏览器视图 id;省略则用当前目标视图"),
        },
        handler: async (args: Record<string, unknown>) =>
          browserSavePdf(
            {
              fileName: typeof args.fileName === "string" ? args.fileName : undefined,
              paperFormat: typeof args.paperFormat === "string" ? args.paperFormat : undefined,
              landscape: args.landscape === true,
              printBackground: args.printBackground !== false,
              scale: typeof args.scale === "number" ? args.scale : undefined,
              headerFooter: args.headerFooter === true,
              browserId: args.browserId as string | undefined,
            },
            {
              toolCallId: randomUUID(),
              sessionId,
              turnNumber: getTurnNumber(),
            },
          ),
      },
      {
        name: "browser_downloads",
        description: BROWSER_TOOL_SPECS.browser_downloads.description,
        inputSchema: {},
        handler: async () => browserDownloads(),
      },
      {
        name: "browser_evaluate",
        description: BROWSER_TOOL_SPECS.browser_evaluate.description,
        inputSchema: {
          script: z.string().describe("要在页面中执行的 JavaScript 代码(可访问 document/window 等页面对象)"),
          browserId: z.string().optional().describe("目标浏览器视图 id;省略则用当前目标视图"),
        },
        handler: async (args: Record<string, unknown>) =>
          browserEvaluate({
            script: args.script as string,
            browserId: args.browserId as string | undefined,
          }),
      },
      {
        name: "browser_script",
        description: BROWSER_TOOL_SPECS.browser_script.description,
        inputSchema: {
          steps: z
            .array(z.object({ op: z.string() }).passthrough())
            .min(1)
            .max(40)
            .describe(
              "顺序执行的操作数组,每项 { op, ...参数 };op 可选 navigate/click/type/keys/scroll/select/wait/find/evaluate/snapshot,参数与同名工具一致",
            ),
          browserId: z.string().optional().describe("目标浏览器视图 id;省略则用当前目标视图"),
          finalScreenshot: z.boolean().optional().describe("true=末尾追加整页截图"),
        },
        handler: async (args: Record<string, unknown>) =>
          browserScript(
            {
              steps: (args.steps as unknown[]) ?? [],
              browserId: args.browserId as string | undefined,
              finalScreenshot: args.finalScreenshot === true,
            },
            projectPath,
            // The final-screenshot image flows back through the tool_result
            // content (same round-trip as browser_screenshot — no separate
            // browser.image emit on the Claude path).
            { toolCallId: randomUUID(), sessionId, turnNumber: getTurnNumber() },
          ),
      },
      {
        name: "browser_screenshot",
        description: BROWSER_TOOL_SPECS.browser_screenshot.description,
        inputSchema: {
          browserId: z.string().optional().describe("目标浏览器视图 id;省略则用当前目标视图"),
          fullPage: z.boolean().optional().describe("true=截整页(含滚动外内容)"),
          backend: z.enum(["chrome"]).optional().describe("true=截用户真实 Chrome 的当前标签页"),
        },
        handler: async (args: Record<string, unknown>) => {
          // The returned image content block flows back to the model via the
          // CLI and is also surfaced to the user: the claude binary round-
          // trips the tool_result content (including the image) back as a user
          // message, which SdkMessageAdapter transparently forwards as a
          // ToolResultEvent; the store then extracts the image (in Anthropic
          // {source:{data,media_type}} or MCP {data,mimeType} form) and
          // attaches an inline image block. No separate browser.image emit is
          // needed here — unlike the Pi path, the toolCallId isn't available
          // in the MCP handler's extra, so we rely solely on the tool_result.
          return browserScreenshot(
            {
              browserId: args.browserId as string | undefined,
              fullPage: args.fullPage === true,
              backend: args.backend === "chrome" ? "chrome" : undefined,
            },
            {
              toolCallId: randomUUID(),
              sessionId,
              turnNumber: getTurnNumber(),
            },
          );
        },
      },
    ],
  };
}

/** Tools that mutate files on disk — auto-approved under `acceptEdits`
 *  mode without prompting the user. Mirrors Claude Code's own grouping. */
const FILE_EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** The MCP server name under which the browser tools are registered (a host
 *  MCP server served over loopback HTTP — see buildBrowserMcpTools). The CLI
 *  surfaces each tool to canUseTool as `mcp__<server>__<tool>`, so the
 *  composed prefix is `mcp__mcode-browser__`. */
const BROWSER_MCP_SERVER = "mcode-browser";
const BROWSER_MCP_PREFIX = `mcp__${BROWSER_MCP_SERVER}__`;

/** Read-only browser tools (can't mutate the page, navigate, or submit) —
 *  auto-approved in every mode, like the Pi provider's MCODE_BROWSER_READONLY
 *  set. scroll/wait/find are pure reading aids; save_pdf writes only into the
 *  managed artifacts dir with sanitized names (same class as screenshot's
 *  best-effort save). The side-effecting navigate/click/type/keys/select/
 *  upload_file/history/close_tab go through approval. */
const BROWSER_READONLY_SUFFIXES = new Set([
  "browser_list",
  "browser_snapshot",
  "browser_screenshot",
  "browser_find",
  "browser_scroll",
  "browser_wait",
  "browser_switch_tab",
  "browser_save_pdf",
  "browser_downloads",
]);

/** True for a canUseTool toolName that names one of our read-only browser MCP
 *  tools (i.e. `mcp__mcode-browser__browser_snapshot` etc). */
function isReadOnlyBrowserTool(toolName: string): boolean {
  if (!toolName.startsWith(BROWSER_MCP_PREFIX)) return false;
  return BROWSER_READONLY_SUFFIXES.has(toolName.slice(BROWSER_MCP_PREFIX.length));
}

/** Decide whether a tool should be auto-approved (skip the prompt) based on
 *  the session's CURRENT permission mode. This runs in canUseTool on every
 *  call, so a mid-turn mode flip applies to the next tool immediately.
 *  - bypassPermissions / dontAsk → everything auto-approved
 *  - acceptEdits / isolated      → file-editing tools auto-approved (isolated
 *                                  is acceptEdits INSIDE the project; the
 *                                  out-of-project boundary is denied earlier
 *                                  in canUseTool, before this gate runs)
 *  - default / plan / auto       → prompt the user (return false) */
function shouldAutoApprove(mode: PermissionMode | undefined, toolName: string): boolean {
  // 编排规划工具是纯数据提交(结构化输出契约,handler 只钳制建卡不执行),
  // 任何模式免审批 —— 必须排在 `if (!mode)` 之前:default 档传来的 mode 是
  // undefined。真正有风险的动作发生在 worker 会话,各自带权限模式与审批桥。
  if (isOrchPlanTool(toolName)) return true;
  if (!mode) return false;
  if (mode === "bypassPermissions" || mode === "dontAsk") return true;
  // Read-only browser tools never need approval — they can't change anything.
  if (isReadOnlyBrowserTool(toolName)) return true;
  if (mode === "acceptEdits" || mode === "isolated") return FILE_EDIT_TOOLS.has(toolName);
  return false;
}

/** Max provider-level retries for a TRANSPORT failure (stdio break, binary
 *  crash, network timeout). API-level transient errors (429 / overloaded /
 *  5xx) are retried separately by the CLI itself — surfaced via `api_retry`
 *  system messages the adapter now logs — and do NOT consume this budget,
 *  because those end the iterator cleanly with a `result{subtype:"error"}`
 *  rather than throwing. This wrapper only catches the thrown-exception case
 *  the CLI's own retry loop doesn't cover. */
const CLAUDE_MAX_TRANSPORT_RETRIES = 3;

/** True for a thrown error that warrants a transport-level retry. Covers
 *  stream/stdio breaks, network failures, timeouts, and HTTP 429/5xx that
 *  escape the CLI's retry loop and surface as a thrown exception (possible on
 *  non-Anthropic gateways). AbortError is excluded (it's a user stop, handled
 *  separately). Auth/config errors are excluded (retrying won't help). The
 *  transport's errors aren't strongly typed, so this is a message-based
 *  heuristic — intentionally permissive on the side of retrying transient-
 *  sounding failures. */
function isRetryableTransportError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (!msg) return false;
  // User-initiated stop — never retry.
  if (/abort/.test(msg)) return false;
  // Stream / stdio / transport breaks.
  if (/stream closed|stream.*closed|connection|econnreset|socket|hang up|epipe|\bpipe\b|transport/.test(msg)) return true;
  // Timeouts.
  if (/timeout|etimedout|timed out/.test(msg)) return true;
  // Network / DNS / fetch.
  if (/network|enotfound|getaddrinfo|fetch failed|failed to fetch/.test(msg)) return true;
  // EOF / premature close.
  if (/eof|premature|unexpected end|closed before/.test(msg)) return true;
  // HTTP 429 / 5xx that escaped the CLI's retry (rare; custom gateways).
  if (/429|rate limit|overloaded|too many requests|5\d{2}|server error|service unavailable|bad gateway|gateway timeout/.test(msg)) return true;
  return false;
}

/** Promise-based sleep that rejects early if the signal aborts, so a user
 *  stop during a retry backoff doesn't wait out the full delay. The rejecting
 *  path is how the retry loop detects an abort mid-backoff and bails out. */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** System prompt injected when the environment lacks native AskUserQuestion tool.
 * Now imported from the shared @main/lib/askQuestion module (single source of
 * truth, shared with the Pi provider's before_agent_start extension). */

/** Project-level drop-in skill roots `.agent/skills` + `.agents/skills`
 *  (the skills.list "agent" source — see lib/agentSkills.ts): the CLI adopts
 *  each dir as a local plugin, skills register as `<ns>:<dirName>` (ns = dir
 *  basename), and picked names that resolve in a root are qualified in the
 *  allowlist below. */

export class ClaudeAgentSdkProvider implements AgentProvider {
  readonly id = "claude-sdk";
  readonly displayName = "Claude";
  /** Live CLI processes keyed by GUI session id. A transport survives its
   *  turns while background work runs (services); follow-up turns ride the
   *  same process instead of spawning a second CLI on the session file. */
  private transports = new Map<string, LiveTransport>();
  /** Sessions in which the user invoked `/schedule`: once they did, every
   *  later turn carries the scheduled-task proposal instructions (see the
   *  system-prompt appends in startTurn). In-memory, app lifetime. */
  private scheduleSessions = new Set<string>();
  readonly capabilities: ProviderCapabilities = {
    supportsApproval: true,
    supportsResume: true,
    supportsStreaming: true,
    supportsMcp: true,
    supportsAskUserQuestion: true, // optimistic; may be negated at runtime
    // Declarative descriptors for the renderer's dynamic dropdowns.
    thinkingLevels: [
      { value: "default", label: "Auto", hint: "让 Claude 自选" },
      { value: "low", label: "Low", hint: "最快,少思考" },
      { value: "medium", label: "Med", hint: "平衡" },
      { value: "high", label: "High", hint: "更多思考" },
      { value: "xhigh", label: "XHigh", hint: "深度思考" },
      { value: "max", label: "Max", hint: "最充分,最慢" },
    ],
    permissionModes: [
      { value: "default", label: "Default", icon: "shield", hint: "标准行为,工具按规则触发审批" },
      { value: "acceptEdits", label: "Edit Auto", icon: "shieldCheck", color: "text-warning", hint: "工作目录内的文件编辑自动放行" },
      { value: "plan", label: "Plan", icon: "shieldHalf", color: "text-info", hint: "只读探索,所有写操作都需审批" },
      // Project isolation: acceptEdits-like auto-approve INSIDE the project,
      // hard boundary at the project root — out-of-project reads/writes and
      // bash write-targets are denied host-side (see the canUseTool guards).
      // NOT a sandbox: bash commands have plenty of non-file ways to reach
      // the outside world (network etc.); the guard fences the filesystem
      // mistakes, not adversarial escapes.
      { value: "isolated", label: "Isolated", icon: "lock", color: "text-success", hint: "项目隔离:读写与文件操作仅限当前项目目录" },
      { value: "bypassPermissions", label: "Bypass", icon: "shieldLock", color: "text-danger", hint: "跳过所有权限检查(慎用)" },
    ],
    builtinModels: [
      { id: "default", label: "Auto", hint: "让 Claude 自选" },
      { id: "sonnet", label: "Sonnet", hint: "claude-sonnet" },
      { id: "opus", label: "Opus", hint: "claude-opus" },
      { id: "fable", label: "Fable", hint: "claude-fable" },
    ],
    supportsCustomEndpoint: true,
    // Conversation-level revision (edit/retract of sent messages): the CLI's
    // transcript is a local jsonl under CLAUDE_CONFIG_DIR that Mcode can
    // rewrite (see lib/claudeTranscript.ts), so the revision surgery keeps
    // the model's context in sync with the GUI view. Pi/codex don't declare
    // this (yet) — their UI falls back to the legacy tail-only edit.
    supportsConversationRevision: true,
  };

  /**
   * Conversation-level revision, claude-sdk implementation: truncate the
   * CLI's own transcript jsonl at the target message's prompt row. The file
   * (~/.mcode/projects/<encoded-cwd>/<providerSessionId>.jsonl) IS the
   * model's context — every turn `--resume`s it — so a tail cut there is
   * the only edit/retract that actually reaches the model. See
   * lib/claudeTranscript.ts for the row taxonomy and alignment; the host
   * runs this BEFORE the DB row surgery, so a throw here refuses the whole
   * revision with nothing changed. A revision that empties the file of every
   * real prompt deletes it — an empty transcript is not a resumable
   * conversation, and the next turn starts a fresh CLI session (the host's
   * providerSessionId slot is cleared via input-provider hooks below).
   */
  async reviseConversation(input: ProviderReviseInput): Promise<{ cleared?: boolean }> {
    // A live CLI process holds the conversation IN MEMORY — a transcript
    // truncation on disk wouldn't reach it, and its next task-notification
    // resume would write the old context back into the (now edited) session
    // file. Tear the transport down first so the next turn respawns from the
    // revised file. Background tasks die with it — revision is a destructive
    // act by definition.
    const live = this.transports.get(input.sessionId);
    if (live) {
      await this.reapTransport(live, "conversation revised", input.log);
    }
    const providerSessionId = input.providerSessionId;
    if (!providerSessionId) {
      // No CLI session ever ran — nothing to rewind host-side.
      input.log.info("claude revise: no provider session id, skipping transcript surgery");
      return {};
    }
    const dir = input.cwd
      ? findClaudeProjectDir(join(MCODE_CONFIG_DIR, "projects"), input.cwd)
      : null;
    const file = dir ? join(dir, `${providerSessionId}.jsonl`) : null;
    const rows = file ? loadTranscript(file) : null;
    if (!file || !rows) {
      // Missing transcript (config dir moved / cwd resolution failed):
      // PROCEED (the host still does DB surgery) but say so — the model's
      // context will keep the removed turns, and the log should show why.
      input.log.warn(
        `claude revise: transcript not found (dir=${dir ?? "unresolved"}); provider context keeps the removed turns`,
      );
      return {};
    }

    const guiIndex = input.guiUserRows.findIndex((r) => r.id === input.target.id);
    const rowIdx =
      (guiIndex >= 0 ? alignPrompts(input.guiUserRows, rows).get(guiIndex) : undefined) ??
      positionalPromptRow(input.guiUserRows.length, Math.max(guiIndex, 0), rows);
    if (rowIdx == null) {
      // Refuse rather than guess a cut point: a wrong truncation corrupts
      // the model's context in ways the user can't see.
      throw new Error("cannot locate the message's prompt entry in the CLI transcript");
    }

    const next = planTailCut(rows, rowIdx);
    if (countSdkPromptRows(next) === 0) {
      // Wiped back to the pre-first-message state: delete the file and say
      // so on the log — the persisted session id must be cleared too so the
      // next turn starts fresh (the host's DB row keeps its GUI identity).
      try {
        unlinkSync(file);
      } catch (err) {
        input.log.warn(`claude revise: failed to delete emptied transcript: ${(err as Error).message}`);
      }
      input.log.info("claude revise: transcript emptied — next turn starts a fresh CLI session");
      return { cleared: true };
    } else {
      rewriteTranscriptFile(file, serializeTranscript(next));
    }
    return {};
  }

  async startTurn(req: StartTurnRequest, ctx: ProviderContext): Promise<TurnHandle> {
    const ac = new AbortController();
    // Mutable turn number for the browser MCP server's screenshot paths —
    // the server instance lives as long as the CLI process (persistent
    // transport), so the value must be read at call time, not captured.
    const turnNumberBox: { n: number | undefined } = { n: req.turnNumber };

    // Look up the session's snapshot via the module-scope registry.
    // The runtime creates it lazily on first sendTurn and clears it
    // between turns; the provider only reads. No-op fallbacks if the
    // snapshot is missing (e.g. startTurn called without a preceding
    // sendTurn, which shouldn't happen but we don't want a crash).
    const snapshot = getFileSnapshot(req.sessionId);

    // OpenAI-protocol bridge turn: the effort level must NOT go through the
    // binary — the binary would render it as an Anthropic `thinking` budget,
    // which the OpenAI-protocol endpoint can't read (and many reject). Instead
    // it rides Mcode's internal request header to the local bridge, which
    // translates it into the endpoint's native field (`reasoning_effort` /
    // `enable_thinking`) per the selected model's thinking declaration. The
    // level is also gated against that declaration, so a stale persisted value
    // (the model row was re-declared since) is dropped rather than sent.
    const isOpenAiBridge = req.apiConfig?.protocol === "openai";
    const bridgeCfg = isOpenAiBridge ? req.apiConfig : undefined;
    let bridgeThinkingEffort: string | undefined;
    if (bridgeCfg && req.effort && req.effort !== "default") {
      const entry =
        bridgeCfg.models.find((m) => m.id === bridgeCfg.selectedModel) ?? bridgeCfg.models[0];
      if (effortLevelValuesForModel(entry, bridgeCfg.baseUrl).includes(req.effort)) {
        bridgeThinkingEffort = req.effort;
      } else {
        ctx.log.warn(
          `thinking effort ${JSON.stringify(req.effort)} not valid for model ${JSON.stringify(bridgeCfg.selectedModel)} on ${bridgeCfg.baseUrl}; dropping`,
        );
      }
    }

    // Project-level drop-in skill roots `.agent/skills` + `.agents/skills`
    // (see resolveAgentSkillInjections): one readdir per root per turn,
    // consumed twice — the skills allowlist qualification below and the
    // plugin injection further down.
    const agentSkills = await resolveAgentSkillInjections(req.cwd);

    // Sessions that already ran a `/schedule` request: from then on every
    // turn carries the scheduled-task proposal instructions, so a follow-up
    // ("把时间改到十点") can still produce a proposal card. In-memory for the
    // app's lifetime — after a restart the model falls back on the format it
    // sees in its own earlier replies in the transcript.
    if (/^\/schedule\b/i.test(req.prompt.trim())) this.scheduleSessions.add(req.sessionId);

    const options: ClaudeCliOptions = {
      abortController: ac,
      cwd: req.cwd,
      model: req.model && req.model !== "default" ? req.model : undefined,
      // Per-turn reasoning effort. "default" collapses to `undefined` (don't
      // pass the flag). Only the levels the UI's capabilities.thinkingLevels
      // list offers reach the wire (`--effort`).
      // See https://platform.claude.com/docs/en/build-with-claude/effort
      // EXCEPT on OpenAI-protocol bridge turns, where the level takes the
      // internal-header path instead (see isOpenAiBridge above) — passing it
      // here would make the binary emit an Anthropic `thinking` budget.
      effort:
        !isOpenAiBridge && req.effort && req.effort !== "default" ? req.effort : undefined,
      // Permission mode. The UI's "plan" is the CLI's own native `plan` mode
      // — Mcode adds no steering prompt; ExitPlanMode's approval arrives as
      // the CLI's `request_user_dialog` (see onUserDialog below). The UI
      // "isolated" mode (project isolation) runs the CLI under acceptEdits —
      // the boundary itself is enforced host-side in canUseTool (reads
      // confined, writes/bash write-targets denied outside cwd), which the
      // CLI's mode knows nothing about.
      permissionMode: req.permissionMode === "isolated" ? "acceptEdits" : req.permissionMode,
      resume: req.resumeProviderSessionId ?? undefined,
      includePartialMessages: true,
      // Forward the subagents' full conversation (text/thinking included, not
      // just tool_use/tool_result) as assistant/user messages carrying the
      // spawning Task tool_use id in `parent_tool_use_id`. The adapter routes
      // those to the per-subagent transcript channel (subagent.transcript)
      // for the side-panel subagent viewer — they never enter the main
      // message stream (see SdkMessageAdapter's parent_tool_use_id guards).
      forwardSubagentText: true,
      // Skills: when the user picked specific skills in the composer, pass them
      // as an explicit allowlist so the model's `Skill` tool can actually reach
      // them. This is REQUIRED because the CLI runs with
      // `--input-format stream-json`, under which it does NOT re-parse
      // `/name` slash commands from the prompt text — the `/name` literals the
      // composer inlines are display-only and would never trigger the Skill
      // tool on their own. With no picks, fall back to 'all' so the model can
      // still self-discover/autoloader skills (the allowlist rides
      // `--allowedTools Skill` / `Skill(<name>)`).
      //
      // `.agent/skills` / `.agents/skills` skills reach the CLI through the
      // plugin loader, which registers them under the `<ns>:<dirName>`
      // namespace (ns = the injected dir's basename) — a picked name that
      // resolves in a drop-in root must be qualified or the allowlist entry
      // matches nothing. Names from `.claude/skills` / global stay bare
      // (native discovery).
      skills:
        req.skills && req.skills.length > 0
          ? req.skills.map((n) => agentSkills?.qualifiedNames.get(n) ?? n)
          : "all",
      // On Windows a timing/buffering race in the CLI's stdio control channel
      // caused "Tool permission request failed: AbortError: Tool permission
      // stream closed before response received" for subagent/MCP tools
      // (WebSearch, WebFetch, etc.). `--debug` makes the CLI flush that
      // channel synchronously and eliminates the race — a CLI-side property,
      // so it applies the same with Mcode's own transport.
      // See https://github.com/anthropics/claude-agent-sdk-typescript/issues/359
      debug: process.platform === "win32" ? true : undefined,
    };

    // The runtime is the user's own Claude CLI (PATH / native installer) —
    // nothing is bundled. Resolve it here so a missing or too-old CLI
    // surfaces as the friendly "not installed / update it" card before
    // anything else is set up.
    const executable = resolveClaudeExecutable();
    if (!executable) {
      throw new ClaudeCliUnavailableError(
        "未检测到 Claude CLI。请先安装:npm install -g @anthropic-ai/claude-code,或到 设置 → Agent 安装(Claude CLI not found on PATH).",
      );
    }
    options.executable = await assertClaudeCliUsable(executable);

    // Plan files location: the bundled CLI forces the model to write its plan
    // to a file before calling ExitPlanMode (the tool errors with "No plan file
    // found ... Please write your plan to this file before calling ExitPlanMode"
    // if the file is missing). The plan directory is resolved by the CLI from
    // the `plansDirectory` setting (must be within project root), defaulting to
    // ~/.claude/plans/ when unset. Without this, plan files leak into the
    // GLOBAL ~/.claude/plans/ directory instead of staying project-scoped.
    //
    // We set it to ".claude/plans" (relative to cwd = project root) via the
    // flag-settings layer (`--settings`), which has the highest
    // user-controlled priority and applies regardless of `settingSources`.
    // Add ".claude/plans/" to .gitignore to keep these ephemeral drafts out of
    // version control. It is a path preference, not an instruction: the model
    // is told nothing it would not be told by the stock CLI.
    options.settings = { plansDirectory: ".claude/plans" };

    // Always redirect the claude binary's user-level config root to Mcode's
    // own directory (~/.mcode) via CLAUDE_CONFIG_DIR. This decouples Mcode from
    // the user's Claude Code CLI installation: tools like "cc switch" that
    // overwrite ~/.claude/settings.json no longer affect Mcode's turns, and
    // user-level skills are loaded from ~/.mcode/skills/ (where Mcode's import
    // feature places them). Applied to BOTH the standard and custom-endpoint
    // paths so behavior is consistent.
    //
    // The child's env REPLACES the inherited environment entirely, so we
    // always spread process.env first - otherwise PATH/HOME disappear and
    // the CLI can't boot.
    if (req.apiConfig) {
      // Custom endpoint: buildCustomEnv layers on auth, per-tier model bindings,
      // gateway request headers, and CLAUDE_CONFIG_DIR on top of process.env.
      // We ALSO shadow any managed env keys written into ~/.mcode/settings.json
      // via flag-tier `--settings.env`, so concurrent GUI sessions on different
      // providers/models never get overwritten by the synced disk file.
      options.env = buildCustomEnv(req.apiConfig, {
        sessionId: req.sessionId,
        thinkingEffort: bridgeThinkingEffort,
      });
      options.settings = {
        ...(typeof options.settings === "object" ? options.settings : {}),
        env: buildShadowingSettingsEnv(req.apiConfig, {
          sessionId: req.sessionId,
          thinkingEffort: bridgeThinkingEffort,
        }),
      };
    } else {
      // Standard Anthropic endpoint: still redirect the config root so Mcode
      // manages its own skills/settings, but no auth/model overrides needed.
      options.env = {
        ...process.env,
        CLAUDE_CONFIG_DIR: MCODE_CONFIG_DIR,
      };
    }

    // Subagent model pin (tierModels.subagent / legacy subagentModel):
    // layered AFTER the block above so the pin overrides any fallback.
    const pinnedSubagentModel = resolveSubagentModelValue(req.apiConfig);
    if (pinnedSubagentModel) {
      options.env = { ...options.env, CLAUDE_CODE_SUBAGENT_MODEL: pinnedSubagentModel };
    }

    // Bash tool shell: force Git Bash when one is resolvable. claude.exe's own
    // Windows bash detection can fall back to WSL's System32\bash.exe (or
    // PowerShell), neither of which understands the `/d/...`, `/mnt/d/...`, or
    // `D:\...` paths the model emits. Git Bash's MSYS runtime converts them
    // natively, and the canUseTool Bash branch below normalizes the remaining
    // dialects to `D:/...` form. Only set when a real Git Bash is found;
    // otherwise leave the CLI's default resolution untouched.
    if (process.platform === "win32") {
      const gitBash = resolveGitBash();
      if (gitBash) {
        options.env = { ...options.env, CLAUDE_CODE_GIT_BASH_PATH: gitBash };
      }
    }

    // NOTE: we do NOT set `settingSources` here. The default
    // ["user","project","local"] is safe because CLAUDE_CONFIG_DIR points at
    // ~/.mcode - the cc-switch-controlled ~/.claude/settings.json is never
    // read (the config root moved). The "user" source now resolves to
    // ~/.mcode/settings.json (which Mcode controls), and user-level skills
    // under ~/.mcode/skills/ are discovered by the CLI's auto-load. The
    // previous settingSources:["project","local"] workaround is no longer
    // needed and was actively harmful: it disabled user-level skill discovery.

    // Diagnostic: dump the effective env actually handed to the CLI
    // process, so model-routing failures against third-party gateways can
    // be triaged without a packet capture. Only the Anthropic-* / Claude-*
    // vars matter for routing; PATH/HOME/etc are filtered out for brevity.
    // Mask the auth token (keep first 2 / last 4) - never log cleartext.
    if (req.apiConfig) {
      const diagEnv: Record<string, string | undefined> = {};
      const diagKeys = [
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_FABLE_MODEL",
        "CLAUDE_CODE_SUBAGENT_MODEL",
        "ANTHROPIC_SMALL_FAST_MODEL",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
        "API_TIMEOUT_MS",
      ];
      const e = options.env as Record<string, string | undefined>;
      for (const k of diagKeys) {
        if (e[k] !== undefined) diagEnv[k] = e[k];
      }
      const tok = e.ANTHROPIC_AUTH_TOKEN ?? e.ANTHROPIC_API_KEY;
      diagEnv.__authTokenMasked = tok ? `${tok.slice(0, 2)}***${tok.slice(-4)} (mode=${e.ANTHROPIC_API_KEY ? "api_key" : "auth_token"})` : "(none)";
      ctx.log.info(
        `claude custom env: selectedModel=${req.apiConfig.selectedModel} env=${JSON.stringify(diagEnv)}`,
      );
    }

    // --- canUseTool bridge ---
    // Three kinds of tool calls arrive here as the CLI's `can_use_tool` control
    // requests:
    //  (a) AskUserQuestion — BLOCKS via ctx.requestUserInput (Deferred). The
    //      user's answers go back as `updatedInput.answers`, the CLI hands
    //      them to the model, and the SAME turn continues. Returning
    //      null here (the old behavior) left the tool blocked indefinitely
    //      while onUserDialog cancelled it, ending the turn prematurely.
    //  (b) ExitPlanMode — BLOCKS via ctx.requestPlanApproval (Deferred). The
    //      model has drafted a plan in plan mode and needs user approval to
    //      proceed. Allow → the CLI exits plan mode for this turn; deny → stays
    //      in plan mode and the model can revise.
    //  (c) every other tool — standard host-moderated approval via
    //      ctx.requestApproval.
    const requestApproval = ctx.requestApproval;
    const requestUserInput = ctx.requestUserInput;
    const requestPlanApproval = ctx.requestPlanApproval;

    const canUseTool: CanUseTool = async (toolName, input, opts) => {
      if (toolName === "AskUserQuestion") {
        // AskUserQuestion only fires here when the native tool is available
        // (capabilities.supportsAskUserQuestion). Sentinel fallback path
        // doesn't reach canUseTool.
        if (!requestUserInput) {
          // No host bridge wired — fall back to deny so the model isn't stuck.
          return { behavior: "deny", message: "User input not available" };
        }
        const questions = parseQuestions(input);
        if (questions.length === 0) {
          return { behavior: "deny", message: "Malformed AskUserQuestion input" };
        }
        const requestId = randomUUID();
        const decision = await requestUserInput({
          requestId,
          toolUseId: opts.toolUseID,
          questions,
        });
        // User closed the question card without answering: deny the tool so
        // the CLI surfaces it to the model as a clear error and the SAME
        // turn continues (the model decides how to proceed).
        if (decision.dismissed) {
          return { behavior: "deny", message: "用户关闭了提问,未提供答案,请继续当前任务" };
        }
        // Build the answers map the CLI expects: { [question.text]: label }.
        // The CLI accepts a string (single label or comma-joined) per question.
        const sdkAnswers: Record<string, string> = {};
        for (const q of questions) {
          const v = decision.answers[q.question];
          if (v == null) continue;
          sdkAnswers[q.question] = Array.isArray(v) ? v.join(", ") : v;
        }
        return {
          behavior: "allow",
          updatedInput: { questions: input.questions, answers: sdkAnswers },
        };
      }

      if (toolName === "ExitPlanMode") {
        // Fallback path: the CLI routes ExitPlanMode approval through
        // onUserDialog (request_user_dialog) instead of canUseTool, so this
        // branch is typically NOT reached. It's kept as a defensive fallback
        // for CLI code paths that still use can_use_tool. The real
        // handling lives in onUserDialog above.
        ctx.log.info("canUseTool: ExitPlanMode fallback path hit (expected to be handled by onUserDialog)");
        // Plan mode: the model has drafted a plan and is asking the user to
        // approve it before execution. The plan text arrives in input.plan
        // (the tool's documented input omits it, but it's present at
        // runtime). Allow → the CLI exits plan mode for this turn; deny → the CLI
        // stays in plan mode and the model can revise. See
        // https://docs.snowflake.com/en/user-guide/cortex-code-agent-sdk/user-input
        if (!requestPlanApproval) {
          return { behavior: "deny", message: "Plan approval not available" };
        }
        const plan = typeof (input as { plan?: unknown })?.plan === "string"
          ? ((input as { plan: string }).plan)
          : "";
        const requestId = randomUUID();
        const decision = await requestPlanApproval({
          requestId,
          plan,
          toolUseId: opts.toolUseID,
        });
        if (decision.approved) {
          const finalPlan = decision.editedPlan ?? plan;
          return {
            behavior: "allow",
            updatedInput: { ...input, plan: finalPlan, message: "Plan approved by user" },
          };
        }
        return {
          behavior: "deny",
          message: decision.reason ?? "Plan rejected by user",
        };
      }

      // --- File-write path guard (strict in-project policy) ---
      // Claude sometimes emits WSL-style `/mnt/<drive>/...` paths even on
      // native Windows (a training-data artifact). On Windows those resolve
      // to a garbage root-relative folder (e.g. `D:\mnt\d\...`), and nothing
      // used to stop the write — acceptEdits auto-approved them silently, so
      // files landed outside the project. Here we (1) normalize such paths
      // to native Windows paths and (2) deny writes that resolve outside the
      // project working directory in EVERY permission mode except
      // bypassPermissions/dontAsk (the user explicitly opted out of all
      // checks there). The normalized path rides back to the CLI via
      // `updatedInput` so the actual write lands at the corrected location.
      // The strict deny runs BEFORE the always-allowed gate below — the
      // project boundary wins over a per-tool grant.
      let effectiveInput: Record<string, unknown> | undefined;
      if (FILE_MUTATING_TOOLS.has(toolName)) {
        const raw = getToolFilePath(toolName, input);
        if (raw) {
          const norm = normalizeToolFilePath(req.cwd, raw);
          if (norm) {
            const pathKey = toolName === "NotebookEdit" ? "notebook_path" : "file_path";
            effectiveInput = { ...input, [pathKey]: norm.absPath };
            const mode = ctx.getPermissionMode?.();
            const bypass = mode === "bypassPermissions" || mode === "dontAsk";
            if (!norm.insideProject && !bypass) {
              ctx.log.info(
                `denied out-of-project ${toolName}: ${norm.absPath} (cwd=${req.cwd})`,
              );
              return {
                behavior: "deny",
                message: `拒绝:目标路径在项目工作目录之外(${norm.absPath})。只允许在项目目录内写入文件,请改用相对路径。`,
              };
            }
          }
        }
      }

      // --- Project-isolation read guard ("isolated" mode only) ---
      // Reads are confined to the project when the user picked the isolated
      // mode. In-project reads never reach here (the CLI auto-allows file
      // access inside the working directory); out-of-project access falls
      // through the CLI's rules to a permission prompt, which is exactly when
      // canUseTool fires — so this deterministically catches ../ escapes and
      // absolute paths outside cwd. Reads in every other mode stay free
      // (reading docs/config elsewhere is often legitimate).
      if (ctx.getPermissionMode?.() === "isolated" && FILE_READING_TOOLS.has(toolName)) {
        const raw = getToolReadPath(toolName, input);
        if (raw) {
          const denial = guardReadPath(req.cwd, raw);
          if (denial) {
            ctx.log.info(
              `denied out-of-project read ${toolName}: ${raw} (cwd=${req.cwd}, isolated mode)`,
            );
            return { behavior: "deny", message: denial };
          }
        }
      }

      // --- Bash command path-dialect normalization ---
      // The model emits Git Bash `/d/...` and WSL `/mnt/d/...` paths inside
      // bash commands. Only Git Bash understands `/d/...` (MSYS conversion);
      // neither dialect works in PowerShell or WSL bash. Rewrite both to
      // native `D:/...` form so the command succeeds in whatever shell the
      // CLI resolves. The normalized command rides back via `updatedInput`
      // (same mechanism as the file-path guard above) — the approval dialog
      // also shows the corrected command. Backslash-native paths (`D:\...`)
      // are left alone; those are fixed by steering the shell to Git Bash
      // (CLAUDE_CODE_GIT_BASH_PATH, see startTurn).
      if (toolName === "Bash") {
        const raw = (input as { command?: unknown }).command;
        if (typeof raw === "string" && raw.length > 0) {
          const normalized = normalizeBashCommand(raw);
          if (normalized !== raw) {
            effectiveInput = { ...input, command: normalized };
          }
          // --- Bash write-target guard (same shared module as the Pi side) ---
          // Block shell redirections whose target resolves outside the project
          // (the same strict/not-bypass policy as the file-write guard above,
          // and running BEFORE the always-allowed / mode gates so the project
          // boundary wins over a per-tool grant). NOT a sandbox — see
          // bashWriteGuard.ts for the deliberately-recognized forms.
          const bashMode = ctx.getPermissionMode?.();
          const bashStrict = bashMode !== "bypassPermissions" && bashMode !== "dontAsk";
          const denial = guardBashCommand(req.cwd, normalized, bashStrict);
          if (denial) {
            ctx.log.info(
              `denied out-of-project bash write target: ${normalized.slice(0, 120)} (cwd=${req.cwd})`,
            );
            return { behavior: "deny", message: denial };
          }
        }
      }

      // --- Browser-navigation domain gate ---
      // browser_navigate is approved per DOMAIN, not per call: localhost/file
      // origins and already-trusted hosts pass silently, a new host raises a
      // domain-kind approval card (its always-grant records the domain, never
      // the tool name — see domainGate.ts). This branch REPLACES the generic
      // approval for this tool, so there is never a double prompt; a denied
      // domain returns here without falling through to the request below.
      if (toolName === `${BROWSER_MCP_PREFIX}browser_navigate`) {
        const url = (input as { url?: unknown }).url;
        if (typeof url === "string" && url.length > 0 && requestApproval) {
          const gate = await gateBrowserNavigation(url, {
            sessionId: req.sessionId,
            mode: ctx.getPermissionMode?.(),
            requestApproval,
          });
          if (gate.allowed) {
            return effectiveInput
              ? { behavior: "allow", updatedInput: effectiveInput }
              : { behavior: "allow" };
          }
          ctx.log.info(`denied browser navigation: ${url}`);
          return { behavior: "deny", message: gate.reason ?? "Denied by user" };
        }
      }

      // Standard tool approval. Before prompting the user, check two
      // host-side gates so the change takes effect immediately:
      //  (1) "always allow" — the user previously granted this tool with
      //      the always checkbox; skip the prompt for the rest of the session.
      //  (2) permission mode — bypassPermissions/dontAsk auto-allows every
      //      tool; acceptEdits auto-allows file-editing tools. The CLI's own
      //      permissionMode option is fixed at query() start, but our host
      //      gate reads the LIVE value so a mid-turn flip applies to the
      //      next tool right away. Out-of-project writes never reach these
      //      gates — they were denied above.
      if (ctx.isToolAlwaysAllowed?.(toolName)) {
        return effectiveInput
          ? { behavior: "allow", updatedInput: effectiveInput }
          : { behavior: "allow" };
      }
      const mode = ctx.getPermissionMode?.();
      if (shouldAutoApprove(mode, toolName)) {
        return effectiveInput
          ? { behavior: "allow", updatedInput: effectiveInput }
          : { behavior: "allow" };
      }

      if (!requestApproval) {
        return effectiveInput
          ? { behavior: "allow", updatedInput: effectiveInput }
          : { behavior: "allow" };
      }
      const r = await requestApproval({
        requestId: randomUUID(),
        toolName,
        input: effectiveInput ?? input,
      });
      return r.allow
        ? {
            behavior: "allow" as const,
            updatedInput: (r.updatedInput ?? effectiveInput) as
              | Record<string, unknown>
              | undefined,
          }
        : { behavior: "deny" as const, message: r.reason ?? "Denied by user" };
    };
    options.canUseTool = canUseTool;

    // --- onUserDialog bridge ---
    // ExitPlanMode's user-approval step arrives as a `request_user_dialog`
    // control request (dialogKind-based), NOT through canUseTool. The CLI is
    // fail-closed: it only emits a dialog kind declared in
    // `supportedDialogKinds` - without the declaration the flow degrades to
    // its no-dialog behavior (the turn aborts with "Tool permission request
    // failed: AbortError: Stream closed") and the approval UI never shows.
    //
    // The real dialogKind for ExitPlanMode is `permission_exit_plan_mode_v2`,
    // confirmed by analyzing the claude.exe v2.1.218 binary: the
    // ExitPlanMode tool (var `oz`, name "ExitPlanMode") is mapped to dialog
    // `fcr` whose `.kind` is "permission_exit_plan_mode_v2" in the LBy routing
    // table (KUe({matches:(e)=>e===oz, dialog:fcr, build:qZu})). The CLI gates
    // emission on `ewt() && (twt() ?? []).includes(dialogKind)`, so a mismatch
    // silently suppresses the dialog. The legacy guesses below are kept as
    // defensive fallbacks in case the CLI renames the kind.
    const EXIT_PLAN_DIALOG_KINDS = new Set([
      "permission_exit_plan_mode_v2", // real value (claude.exe v2.1.218)
      "exit_plan_mode", // legacy guess - defensive
      "ExitPlanMode", // legacy guess - defensive
      "plan_approval", // legacy guess - defensive
    ]);
    const onUserDialog: OnUserDialog = async (request, opts) => {
      ctx.log.info(
        `onUserDialog: dialogKind=${request.dialogKind} toolUseID=${request.toolUseID ?? "n/a"} payloadKeys=${JSON.stringify(Object.keys(request.payload ?? {}))}`,
      );
      // ExitPlanMode plan approval: route to the existing plan-approval bridge
      // (renderer shows <PlanApprovalPrompt>). The model's plan text lives in
      // payload.plan (the qZu build fn sets {requestId, toolName,
      // permissionResult, plan, planFilePath, usage}); fall back to the older
      // payload.input.plan shape for CLI versions that nested it there.
      if (EXIT_PLAN_DIALOG_KINDS.has(request.dialogKind) || typeof (request.payload as { plan?: unknown })?.plan === "string") {
        if (!requestPlanApproval) {
          return { behavior: "cancelled" as const };
        }
        const p = request.payload as { plan?: unknown; input?: { plan?: unknown } };
        const plan = typeof p.plan === "string" ? p.plan
          : typeof p.input?.plan === "string" ? p.input.plan
          : "";
        const requestId = request.toolUseID ?? randomUUID();
        const decision = await requestPlanApproval({
          requestId,
          plan,
          toolUseId: request.toolUseID,
        });
        if (decision.approved) {
          const finalPlan = decision.editedPlan ?? plan;
          // User's adjustment feedback (typed into the approval sheet) rides
          // along in the dialog result message so the model reads it right
          // after approval and incorporates it during execution. Without
          // feedback the message stays the stock approval text.
          const feedback = decision.feedback?.trim();
          const message = feedback
            ? `计划已批准。用户调整意见:${feedback}`
            : "Plan approved by user";
          return {
            behavior: "completed" as const,
            result: { approved: true, plan: finalPlan, message },
          };
        }
        return {
          behavior: "completed" as const,
          result: { approved: false, reason: decision.reason ?? "Plan rejected by user" },
        };
      }
      // Unrecognized dialog kind — `cancelled` makes the CLI apply its default
      // behavior for that dialog.
      return { behavior: "cancelled" as const };
    };
    options.onUserDialog = onUserDialog;
    options.supportedDialogKinds = Array.from(EXIT_PLAN_DIALOG_KINDS);

    // --- system prompt appends ---
    // The model gets the CLI's OWN system prompt. Nothing ambient is layered
    // on top — no product identity, no task-tracking or path-dialect coaching,
    // no plan-mode steering (the UI's "plan" is the CLI's native plan mode):
    // a Claude session here is told exactly what the stock CLI tells it. The
    // only fragments are ones the user switched on themselves, and each one
    // is the working part of a Mcode feature that cannot exist without it:
    //  (1) `/schedule` — the user invoked it in this session: the proposal
    //      block contract the schedule card is rendered from.
    //  (2) orchestration — the user turned 自动编排 on for this turn: the
    //      planner brief for the orch_submit_plan tool mounted below.
    //  (3) the user's own custom prompt (设置 → 编排) — their words, not ours.
    // Because the append is baked into the process, it is part of the
    // transport fingerprint: a turn whose append differs respawns.
    const appends: string[] = [];
    if (this.scheduleSessions.has(req.sessionId)) {
      appends.push(SCHEDULED_TASK_PROPOSAL_NUDGE);
    }
    if (req.orchestration) {
      try {
        const planNudge = await buildOrchPlanNudge(req.sessionId);
        if (planNudge) appends.push(planNudge);
      } catch (err) {
        ctx.log.warn(`orchestration planner nudge unavailable: ${(err as Error).message}`);
      }
    }
    if (appends.length > 0) {
      options.systemPrompt = {
        type: "preset",
        preset: "claude_code",
        append: joinPromptSections(...appends),
      };
    }

    // --- Host MCP server: browser tools ---
    // Exposes `browser_*` tools (navigate/snapshot/click/screenshot/list) as
    // an MCP server running in this process and served to the CLI over
    // loopback HTTP (see hostMcpHttp.ts). The CLI surfaces each tool to
    // canUseTool as `mcp__mcode-browser__<name>`; read-only tools are
    // auto-approved (see shouldAutoApprove). Mcode's own feature — the stock
    // CLI has no in-app browser — and switched off from the settings panel's
    // MCP section (browserDisabled). User-scope servers (~/.mcode/.claude.json
    // mcpServers) need no injection here — the CLI loads them via the "user"
    // setting source; disabled ones are simply absent from the file. Project
    // .mcp.json servers are governed per-turn by the explicit approval lists
    // below, which replace the CLI's first-use approval dialog (our
    // onUserDialog bridge cancels unknown kinds, so an unlisted server would
    // never load anyway).
    // --- Per-turn host-side config reads (parallelized) ---
    // Everything below used to be awaited one after another, putting the sum
    // of several settings/file reads (+ the plugin tree scan) on the critical
    // path before the CLI can even be spawned. They're mutually independent,
    // so they run as one Promise.all batch; the only ordering that matters is
    // where results land on `options` afterwards (settings ← MCP lists →
    // outputStyle → plugin hooks). One scan feeds both plugin consumers: the
    // plugins option below and the plugin-MCP merge (which accepts a
    // precomputed set to avoid a second directory scan).
    const enabledPluginsPromise = getEnabledPlugins();
    const [mcpState, projectMcpRecord, outputStyle, customPrompt, enabledPlugins, pluginMcp] =
      await Promise.all([
        getMcpManagement(),
        readProjectMcpServers(req.cwd),
        getOutputStyleSetting(),
        getCustomPromptSetting(),
        enabledPluginsPromise,
        enabledPluginsPromise.then((plugins) => getPluginMcpServers(plugins)),
      ]);

    if (!mcpState.browserDisabled) {
      options.hostMcpServers = {
        [BROWSER_MCP_SERVER]: buildBrowserMcpTools(req.cwd, req.sessionId, () => turnNumberBox.n),
      };
    }
    // 会话内编排拆解:挂 orch_submit_plan 工具(宿主 MCP,纯数据提交)。
    // 模型提交后 main 侧钳制建卡,渲染端经 plan.proposed 事件挂画布 ——
    // 见 orchestrator/planTool.ts。普通回合不挂,零上下文开销。
    if (req.orchestration) {
      options.hostMcpServers = {
        ...options.hostMcpServers,
        [ORCH_PLAN_MCP_SERVER]: buildOrchPlanHostServer(req.sessionId),
      };
    }
    const projectMcpNames = Object.keys(projectMcpRecord);
    if (projectMcpNames.length > 0) {
      const enabledSet = new Set(
        (mcpState.projectEnabled ?? [])
          .filter((e) => samePath(e.projectPath, req.cwd))
          .map((e) => e.name),
      );
      // These approval lists are settings (they ride `--settings`).
      options.settings = {
        ...(typeof options.settings === "object" ? options.settings : {}),
        enabledMcpjsonServers: projectMcpNames.filter((n) => enabledSet.has(n)),
        disabledMcpjsonServers: projectMcpNames.filter((n) => !enabledSet.has(n)),
      };
    }

    // Output style (settings panel): a setting, like the
    // MCP lists above. The CLI reads the style once at session start and has
    // no runtime switch control request, so the selection only shapes NEW
    // turns — which is exactly the per-turn granularity Mcode wants (every
    // turn is a fresh query). Never-configured (null) keeps the CLI default
    // and injects nothing.
    if (outputStyle) {
      options.settings = {
        ...(typeof options.settings === "object" ? options.settings : {}),
        outputStyle,
      };
    }

    // User's custom prompt (settings → 编排): the user's own words, appended as
    // the LAST section so it reads as the highest-priority instruction, after
    // the feature fragments above. The appends array + systemPrompt assignment
    // above run before the parallel read batch, so merge onto
    // options.systemPrompt here rather than pushing onto `appends`.
    if (customPrompt) {
      const sp = options.systemPrompt;
      if (sp && sp.type === "preset") {
        sp.append = joinPromptSections(sp.append ?? "", customPrompt);
      } else {
        options.systemPrompt = {
          type: "preset",
          preset: "claude_code",
          append: joinPromptSections(customPrompt),
        };
      }
    }

    // --- Plugins (settings → Plugins; docs/plugin-feasibility.md v1) ---
    // Enabled plugins ride the CLI's native loader (`--plugin-dir`):
    // skills/commands/agents are assembled by the CLI engine per turn (zero
    // host-side copying). Two host-side rails:
    //  1. skipMcpDiscovery — Mcode owns plugin MCP connections and puts them
    //     into the --mcp-config file below under "<plugin>__<server>"
    //     (session-level granularity; the MCP panel lists/toggles them).
    //  2. disableAllHooks — v1 runs NO plugin hooks. Hooks would otherwise
    //     be executed natively by the CLI engine; they are parsed + shown in
    //     the panel, never run (per-hook review is the v1.5 plan).
    //
    // The project's drop-in skill dirs (when they carry skills) ride the same
    // loader — see resolveAgentSkillInjections. Hook presence in either dir
    // gates disableAllHooks together with the enabled plugins' own hooks.
    const agentPlugins = (agentSkills?.plugins ?? []).map((p) => ({
      type: "local" as const,
      path: p.dir,
      skipMcpDiscovery: true,
    }));
    if (enabledPlugins.length > 0 || agentPlugins.length > 0) {
      options.plugins = [
        ...enabledPlugins.map((p) => ({
          type: "local" as const,
          path: p.rootDir,
          skipMcpDiscovery: true,
        })),
        ...agentPlugins,
      ];
      if (enabledPlugins.some((p) => p.hasHooks) || agentSkills?.hasHooks) {
        options.settings = {
          ...(typeof options.settings === "object" ? options.settings : {}),
          disableAllHooks: true,
        };
      }
      if (pluginMcp.length > 0) {
        const servers = { ...(options.mcpServers ?? {}) };
        for (const [name, config] of pluginMcp) {
          // The contracts' McpServerConfig is already the CLI's --mcp-config
          // entry shape (stdio / http / sse); passthrough extras ride along.
          servers[name] = config as unknown as Record<string, unknown>;
        }
        options.mcpServers = servers;
      }
    }

    // Resolve the user-declared context-window tag from the selected model's
    // `supports1m` flag. `resolveActiveModel` appends a `[1m]` suffix exactly
    // when the selected model declares 1M, so its presence signals a 1M
    // window. For a custom endpoint this is authoritative (a non-1M config →
    // "200k" overrides the model-name heuristic, so a gateway model
    // coincidentally named "*opus*" without supports1m resolves to 200k as
    // the user intended). `undefined` (official Anthropic endpoint) lets the
    // heuristic decide.
    const configured: ClaudeContextWindowTag | undefined = req.apiConfig
      ? resolveActiveModel(req.apiConfig)?.toLowerCase().endsWith("[1m]")
        ? "1m"
        : "200k"
      : undefined;

    // ── Persistent transport: ride the LIVE CLI process when one exists ──
    // A process whose background service keeps it alive serves follow-up
    // turns directly (streaming-input multi-turn). Spawning a second CLI on
    // the same session file would mean two writers — the torn state behind
    // every "permission ask dies instantly" incident. A fingerprint
    // difference (model / mode / env / config changed) reaps the old
    // process first: per-process options can't change mid-flight.
    const fingerprint = transportFingerprint(req, options);
    const existing = this.transports.get(req.sessionId);
    if (
      existing &&
      !existing.done &&
      !existing.feedClosed &&
      !existing.ac.signal.aborted &&
      existing.fingerprint === fingerprint
    ) {
      return this.startFollowupTurn(req, ctx, existing, configured);
    }
    if (existing) {
      // feedClosed (process exiting after idle) counts as stale too: a push
      // into a closed feed would silently drop the user's message.
      await this.reapTransport(
        existing,
        existing.fingerprint !== fingerprint ? "process options changed (model/mode/config)" : "stale or exiting transport",
        ctx.log,
      );
    }

    // ── Fresh transport: spawn the CLI process for this turn ──
    const feed = makePromptFeed();
    const q = await this.spawnQuery(feed, options, ctx);
    const turn = makeTurnTracker();
    const transport: LiveTransport = {
      sessionId: req.sessionId,
      ac,
      feed,
      feedClosed: false,
      query: q,
      fingerprint,
      adapter: null!,
      turnNumberBox,
      drain: Promise.resolve(),
      done: false,
    };
    transport.adapter = this.createTurnAdapter(req, ctx, transport, turn, configured, snapshot);
    this.transports.set(req.sessionId, transport);
    transport.drain = this.runDrain(req, ctx, transport, options, turn, configured, snapshot);
    feed.push(buildTurnUserMessage(req));
    ctx.log.info(
      `claude turn start: session=${req.sessionId} uiMode=${req.permissionMode} cliMode=${options.permissionMode ?? "default"} transport=fresh`,
    );

    return {
      done: turn.promise,
      interrupt: () => ac.abort(),
      isRunning: () => !turn.isEnded() && !ac.signal.aborted,
      // Per-task stop (the CLI's `stop_task` control request): kills ONE
      // running CLI task — a long-running bash command (a dev server) —
      // without aborting the turn. Valid while the CLI PROCESS is alive,
      // including after the turn's logical end (the process lingers,
      // babysitting background work; the 运行命令 panel's stop button must
      // keep working there). NOTE we deliberately do NOT declare
      // `perTaskStopAffordance` — without the declaration an interrupt kills
      // background tasks too (the CLI's fail-closed rule), which keeps
      // Mcode's stop button meaning "stop everything".
      stopTask: async (taskId: string) => {
        if (transport.done || transport.ac.signal.aborted) {
          throw new Error("回合已结束,无法停止任务(turn already finished)");
        }
        await transport.query.stopTask(taskId);
      },
    };
  }

  /** Spawn a fresh CLI process for one transport — the first turn, or a
   *  transport-level retry: same launch options, a new prompt feed. The
   *  kill is a process-TREE kill: on win32 a bare SIGKILL reaches only the
   *  CLI itself and orphans whatever it started (a dev server the model
   *  launched). */
  private spawnQuery(feed: PromptFeed, options: ClaudeCliOptions, ctx: ProviderContext): Promise<CliQuery> {
    return runClaudeCliQuery(feed.iterable, {
      ...options,
      log: ctx.log,
      hardKill: (child) => {
        if (typeof child.pid === "number") void killProcessTree(child.pid);
      },
    });
  }

  /** Build a per-logical-turn adapter wired to the transport's controls:
   *  the adapter's logical end resolves that turn's TurnTracker, and its
   *  idle signal closes the feed (letting the CLI process exit). Follow-up
   *  adapters inherit the previous adapter's roster so late lifecycle edges
   *  of turn N's background tasks still reconcile while turn M is current. */
  private createTurnAdapter(
    req: StartTurnRequest,
    ctx: ProviderContext,
    transport: LiveTransport,
    turn: TurnTracker,
    configured: ClaudeContextWindowTag | undefined,
    snapshot: FileSnapshot,
    carryover?: AdapterCarryover,
  ): SdkMessageAdapter {
    return new SdkMessageAdapter(
      ctx,
      req.sessionId,
      this.capabilities.supportsAskUserQuestion,
      req.cwd,
      snapshot,
      transport.ac.signal,
      transport.query,
      req.initialTodos ?? [],
      configured,
      !req.apiConfig,
      {
        carryover,
        hooks: {
          onLogicalEnd: () => turn.resolve(),
          requestFeedClose: () => this.closeTransportFeed(transport, ctx.log),
        },
      },
    );
  }

  /** Background drain for one transport: consumes the CLI's message stream
   *  until the process exits (feed closed at idle, user abort, crash),
   *  dispatching to the CURRENT logical turn's adapter. This used to BE the
   *  turn — turn.done waited for it — which is exactly what pinned sessions
   *  in "running" forever when a background service kept the process alive.
   *  Now the turn ends at the adapter's logical end; this loop only shepherds
   *  the stream and finalizes whatever turn is current when the process dies.
   *
   *  Transport-level retry loop: the CLI already retries API-level transient
   *  errors (429 / overloaded / 5xx) internally — surfaced via `api_retry`
   *  system messages the adapter logs — and those close the stream cleanly
   *  with a `result{subtype:"error"}` (handled by handleResult, not this
   *  catch). This wrapper catches only the THROWN-exception case the CLI
   *  doesn't cover: stdio breaks, process crashes, network timeouts — and
   *  only retries when NO assistant content has streamed yet (recreating
   *  later would orphan the partial output). */
  private async runDrain(
    req: StartTurnRequest,
    ctx: ProviderContext,
    transport: LiveTransport,
    options: ClaudeCliOptions,
    turn: TurnTracker,
    configured: ClaudeContextWindowTag | undefined,
    snapshot: FileSnapshot,
  ): Promise<void> {
    let activeQuery = transport.query;
    let attempt = 0;
    try {
      while (true) {
        try {
          for await (const m of activeQuery) {
            await transport.adapter.dispatch(m);
          }
          // Generator closed — the CLI process is exiting (feed closed at
          // idle, abort, or crash). Finalize the current turn with the full
          // flush (kill-nets included: anything still "running" dies with
          // the process, and that's the honest verdict here).
          await transport.adapter.flushFinal();
          return;
        } catch (err) {
          // A user stop (ac.abort()) makes the iterator throw AbortError.
          // That's not an error — finalize (marks running rosters killed,
          // reflecting the user's stop intent) and exit with interrupted.
          if (transport.ac.signal.aborted) {
            await transport.adapter.flushFinal();
            return;
          }
          // Retryable transport error before any content streamed → retry.
          if (
            !transport.adapter.hasEmittedContent() &&
            attempt < CLAUDE_MAX_TRANSPORT_RETRIES &&
            isRetryableTransportError(err)
          ) {
            attempt += 1;
            const delayMs = Math.min(1000 * 2 ** (attempt - 1), 8000);
            ctx.log.warn(
              `claude: transport error, retry ${attempt}/${CLAUDE_MAX_TRANSPORT_RETRIES} in ${delayMs}ms: ${(err as Error).message}`,
            );
            // Abortable backoff: a user stop during the sleep must NOT
            // turn into another retry attempt.
            try {
              await abortableSleep(delayMs, transport.ac.signal);
            } catch {
              // Aborted during backoff — treat as a user interrupt.
              await transport.adapter.flushFinal();
              return;
            }
            // Fresh feed + process + adapter for the retry.
            // options.abortController (the transport's ac) is shared, so a
            // user stop still cancels the retried attempt. options.resume
            // re-attaches to the same CLI session so the conversation context
            // carries over. The retry re-sends the user message (the
            // abandoned process never answered) and inherits the roster.
            transport.feed.close();
            const retryFeed = makePromptFeed();
            activeQuery = await this.spawnQuery(retryFeed, options, ctx);
            transport.feed = retryFeed;
            transport.feedClosed = false;
            transport.query = activeQuery;
            transport.adapter = this.createTurnAdapter(req, ctx, transport, turn, configured, snapshot, transport.adapter.exportCarryover());
            retryFeed.push(buildTurnUserMessage(req));
            continue;
          }
          // Non-retryable, content already started, or retries exhausted.
          ctx.log.error(`claude cli error: ${(err as Error).message}`);
          ctx.emit({
            type: "error",
            sessionId: req.sessionId,
            message: (err as Error).message,
            code: "SDK_ERROR",
          });
          // Finalize through flushFinal (NOT a bare turn.done emit): the
          // turn may have already written files before the stream broke,
          // and the user still needs the "本轮修改" card to see (and
          // rewind) what landed on disk. flushFinal also runs the plan
          // collapse + roster cleanup safety nets, and emits the closing
          // turn.done{reason:"error"} exactly once via its own guard.
          await transport.adapter.flushFinal("error");
          return;
        }
      }
    } finally {
      transport.done = true;
      // Backstop: never leave a handle pending (the adapter's logical end
      // normally resolved it already; crash paths land here instead).
      turn.resolve();
      if (this.transports.get(req.sessionId) === transport) {
        this.transports.delete(req.sessionId);
      }
      ctx.log.info(`claude transport closed: session=${req.sessionId}`);
    }
  }

  /** Follow-up turn on a LIVE transport: push the user message into the
   *  running CLI's stdin (each stdin line is the CLI's next user turn of the
   *  same process) and swap in a fresh per-turn adapter. No spawn, no
   *  --resume, no second writer on the session file. */
  private startFollowupTurn(
    req: StartTurnRequest,
    ctx: ProviderContext,
    transport: LiveTransport,
    configured: ClaudeContextWindowTag | undefined,
  ): TurnHandle {
    const turn = makeTurnTracker();
    const snapshot = getFileSnapshot(req.sessionId);
    transport.adapter = this.createTurnAdapter(
      req,
      ctx,
      transport,
      turn,
      configured,
      snapshot,
      transport.adapter.exportCarryover(),
    );
    transport.turnNumberBox.n = req.turnNumber;
    transport.feed.push(buildTurnUserMessage(req));
    ctx.log.info(
      `claude turn start: session=${req.sessionId} uiMode=${req.permissionMode} transport=follow-up(live CLI)`,
    );
    return {
      done: turn.promise,
      interrupt: () => transport.ac.abort(),
      isRunning: () => !turn.isEnded() && !transport.ac.signal.aborted,
      stopTask: async (taskId: string) => {
        if (transport.done || transport.ac.signal.aborted) {
          throw new Error("回合已结束,无法停止任务(turn already finished)");
        }
        await transport.query.stopTask(taskId);
      },
    };
  }

  /** Tear a live transport down: abort the CLI (graceful — it kills its
   *  background tasks on the way out, same as a user stop), wait briefly
   *  for the drain to finish, and unregister. Used when the fingerprint
   *  changed, the conversation was revised, or the entry is stale. */
  private async reapTransport(t: LiveTransport, reason: string, log: ProviderContext["log"]): Promise<void> {
    log.info(`claude transport: reaping live CLI (${reason}) — background tasks stop with the process`);
    t.ac.abort();
    await Promise.race([t.drain.catch(() => {}), new Promise((r) => setTimeout(r, 3_000))]);
    if (this.transports.get(t.sessionId) === t) {
      this.transports.delete(t.sessionId);
    }
  }

  /** Close the prompt feed (adapter's idle signal: turn over, nothing left
   *  to babysit). Ending stdin lets the CLI process exit and the drain's
   *  flushFinal runs the exit-path safety nets. Idempotent. */
  private closeTransportFeed(t: LiveTransport, log: ProviderContext["log"]): void {
    if (t.feedClosed || t.done || t.ac.signal.aborted) return;
    t.feedClosed = true;
    log.info("claude transport: feed closed (turn over, process idle) — CLI can exit");
    t.feed.close();
  }

  /** Is the user's Claude CLI there and new enough? `--version` only — it
   *  proves as much as the old probe did (a session `system/init` says
   *  nothing about auth either) without starting a session, calling a model
   *  or leaving a transcript behind. */
  async healthCheck(): Promise<{ ok: boolean; version?: string; error?: string }> {
    try {
      const executable = resolveClaudeExecutable();
      if (!executable) {
        return { ok: false, error: "Claude CLI not found on PATH" };
      }
      const version = await probeClaudeCliVersion(executable);
      if (!version) {
        return { ok: false, error: "claude --version returned nothing" };
      }
      if (compareVersions(version, MIN_CLAUDE_CLI_VERSION) < 0) {
        return { ok: false, version, error: `Claude CLI ${version} is older than ${MIN_CLAUDE_CLI_VERSION}` };
      }
      return { ok: true, version };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
}
