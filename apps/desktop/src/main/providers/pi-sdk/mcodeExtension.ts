/**
 * Inline Pi extension — bridges Mcode's host-side approval, AskUserQuestion,
 * and system-prompt capabilities into the Pi agent via the SDK's extension API.
 *
 * ## Why an extension (not customTools wrapping)
 *
 * The previous implementation wrapped `write`/`edit`/`bash` tool definitions
 * via `customTools` same-name override (see `createGuardedFileTools` /
 * `createGuardedBashTool` in the pre-refactor `PiAgentSdkProvider`). That had
 * three limitations the extension model fixes:
 *
 *   1. **Coverage**: customTools only intercept the 3 wrapped tools. The
 *      `tool_call` event fires for *every* tool (bash/read/edit/write/grep/
 *      find/ls + extension-registered), so the path/command guard and the
 *      approval prompt now apply uniformly.
 *   2. **Approval**: Pi's SDK has no `canUseTool` callback. The `tool_call`
 *      event with `{ block: true, reason }` is the equivalent — the agent loop
 *      converts a block into an `isError` tool result the model can react to
 *      (verified: `agent-loop.js` `prepareToolCall` → `createErrorToolResult`).
 *   3. **AskUserQuestion**: the extension registers a native tool the model
 *      calls autonomously; `execute` bridges to the host's
 *      `requestUserInput` IPC. This replaces the sentinel-text fallback.
 *
 * ## Injection
 *
 * The factory is passed as an `InlineExtension` via
 * `DefaultResourceLoader({ extensionFactories })`. The loader calls
 * `factory(pi)` during `getExtensions()` (before `_refreshToolRegistry`), so
 * `pi.registerTool` / `pi.on` are wired before the first turn. Inline
 * extensions survive `session.reload()` — `loadExtensionFactories` runs in
 * both the initial and reload code paths.
 *
 * ## Argument mutation
 *
 * `event.input` is the same object reference as the `validatedArgs` the agent
 * loop will pass to `tool.execute` (verified: `validateToolArguments` returns
 * a `structuredClone`, passed by reference through `beforeToolCall` →
 * `emitToolCall` → handler → `prepared.args`). So in-place mutation of
 * `event.input.path` is the equivalent of Claude's `updatedInput` — the
 * rewritten path reaches the actual tool execution.
 */
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type {
  InlineExtension,
  ExtensionAPI,
  ToolCallEvent,
  ToolCallEventResult,
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
} from "@earendil-works/pi-coding-agent";
import type { ProviderContext } from "@contracts/provider";
import type { PermissionMode } from "@contracts/runtime";
import { normalizeToolFilePath } from "@main/lib/fileSnapshot.js";
import { guardBashCommand, expandTilde } from "./bashWriteGuard.js";
import {
  parseQuestions,
  formatAnswersForModel,
  ASK_SYSTEM_PROMPT,
} from "@main/lib/askQuestion.js";
import {
  browserList,
  browserNavigate,
  browserSnapshot,
  browserClick,
  browserScreenshot,
  type ToolResult,
} from "@main/browser/agentBrowserTools.js";

/** Pi's write/edit tools carry their target path in the `path` field (unlike
 *  Claude's `file_path`). Both schemas are `{ path, ... }`. */
type PathToolParams = { path?: unknown };

/**
 * Guard a file-tool path. Mirrors the Claude provider's canUseTool guard:
 * WSL-style `/mnt/<drive>/...` paths are normalized to native Windows paths
 * (otherwise they'd resolve to a garbage `D:\mnt\...` folder), and writes
 * resolving outside the project working directory are denied except in
 * bypassPermissions/dontAsk, where the user explicitly opted out of all checks.
 *
 * This is the same logic the pre-refactor `guardToolPath` in
 * `PiAgentSdkProvider` implemented — extracted here so the `tool_call` handler
 * and the (still-used) customTools read-wrapper share one implementation.
 */
export function guardToolPath(
  cwd: string,
  rawPath: string,
  strict: boolean,
): { denied: true; message: string } | { denied: false; path: string } {
  const norm = normalizeToolFilePath(cwd, expandTilde(rawPath));
  if (!norm) return { denied: false, path: rawPath };
  if (!norm.insideProject && strict) {
    return {
      denied: true,
      message: `拒绝:目标路径在项目工作目录之外(${norm.absPath})。只允许在项目目录内写入文件,请改用相对路径。`,
    };
  }
  // Rewrite to the normalized absolute path so the write lands where the user
  // expects — an in-project `/mnt/d/...` path would otherwise resolve to a
  // garbage `D:\mnt\...` folder on Windows.
  return { denied: false, path: norm.absPath };
}

/** Pi's read-only built-in tools — auto-approved in every mode (including plan). */
const PI_READONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);

/** Mcode browser tools that are purely read-only (they can't mutate the page or
 *  navigate) — auto-approved in every mode, never routed through the approval
 *  prompt. `browser_navigate` / `browser_click` have side effects and DO go
 *  through approval (the user can still "always allow" them per session). */
const MCODE_BROWSER_READONLY = new Set(["browser_list", "browser_snapshot", "browser_screenshot"]);

/**
 * Decide whether a Pi tool should be auto-approved (skip the prompt) based on
 * the session's CURRENT permission mode. Mirrors the Claude provider's
 * `shouldAutoApprove`, but uses Pi's lowercase tool names
 * (`write`/`edit` not `Write`/`Edit`).
 *
 *   - bypassPermissions / dontAsk → everything auto-approved
 *   - acceptEdits                  → file-editing tools auto-approved
 *   - plan                         → read-only tools auto-approved, writes prompt
 *   - default / auto               → prompt the user (return false)
 */
function shouldAutoApproveForPi(mode: PermissionMode | undefined, toolName: string): boolean {
  if (!mode) return false;
  // Read-only tools never need approval — they can't change anything.
  if (PI_READONLY_TOOLS.has(toolName)) return true;
  if (mode === "bypassPermissions" || mode === "dontAsk") return true;
  if (mode === "acceptEdits") return toolName === "write" || toolName === "edit";
  return false;
}

export interface CreateMcodeExtensionOptions {
  /** The host provider context — carries the IPC bridges for approval /
   *  user-input / permission-mode / always-allow checks. */
  ctx: ProviderContext;
  /** Project working directory. */
  cwd: string;
  /** Strict in-project policy: deny writes outside cwd. False in
   *  bypassPermissions/dontAsk (user opted out of all checks). */
  strict: boolean;
  /** The Mcode session id — needed for all emit() calls (plan.update /
   * mode.change / plan.approval_request events carry it). */
  sessionId: string;
  /** Project root path — bound to auto-created browser views (for consistency
   *  with terminal/git). Passed through to the shared browser tools. */
  projectPath: string;
}

/**
 * Build the inline Mcode extension. Returned as an `InlineExtension` (named
 * form) so it shows up as `<inline:mcode>` in Pi's startup Extensions list —
 * useful for debugging whether the extension loaded.
 */
/**
 * Build the inline Mcode extension. Returned as an `InlineExtension` (named
 * form) so it shows up as `<inline:mcode>` in Pi's startup Extensions list —
 * useful for debugging whether the extension loaded.
 */
export function createMcodeExtension(opts: CreateMcodeExtensionOptions): InlineExtension {
  const { ctx, cwd, strict, sessionId, projectPath } = opts;

  // ── Plan mode state (per-turn, in-process) ──────────────────────────
  // Tracked here rather than via ctx.getPermissionMode() because the latter
  // updates through an async IPC round-trip (renderer → updateSettings →
  // setPermissionMode) that can't be relied on to land before the next
  // tool_call handler runs. This boolean is synchronous: EnterPlanMode's
  // execute sets it before returning, so the next tool_call handler sees it.
  //
  // The extension is recreated every turn (createMcodeExtension is called in
  // each startTurn), so this doesn't persist across turns — which matches
  // Claude's semantics (plan mode is a turn-internal state).
  const planMode = { active: false };

  return {
    name: "mcode",
    factory: (pi: ExtensionAPI) => {
      registerToolCallGuard(pi, { ctx, cwd, strict, planMode });
      registerAskUserQuestionTool(pi, ctx);
      registerBrowserTools(pi, { ctx, sessionId, projectPath });
      registerPlanModeTools(pi, { ctx, sessionId, planMode });
      registerSystemPromptInjector(pi);
    },
  };
}

/**
 * `tool_call` handler — the Pi equivalent of Claude's `canUseTool`.
 *
 * Runs before every tool execution. Responsibilities, in order:
 *   1. Path/command guard (write/edit/bash) — replaces the old customTools
 *      wrapping. Denials return `{ block: true, reason }`; path normalization
 *      mutates `event.input` in place (same-ref → reaches execution).
 *   2. Plan tools bypass — EnterPlanMode/ExitPlanMode/AskUserQuestion handle
 *      their own logic in execute(); never route through approval.
 *   3. Host approval — permission-mode auto-approve, always-allow, then the
 *      IPC approval prompt. In plan mode, shouldAutoApproveForPi returns false
 *      for everything, so every mutating tool (write/edit/bash) triggers an
 *      approval dialog — the model can experiment during planning, but the user
 *      approves each action.
 */
function registerToolCallGuard(
  pi: ExtensionAPI,
  deps: { ctx: ProviderContext; cwd: string; strict: boolean; planMode: { active: boolean } },
): void {
  const { ctx, cwd, strict, planMode } = deps;

  pi.on("tool_call", async (event: ToolCallEvent): Promise<ToolCallEventResult | void> => {
    const { toolName } = event;

    // ① Path guard for write/edit.
    //    `event.input` is a shared reference with the args the agent will pass
    //    to execute, so mutating it in place is equivalent to Claude's
    //    `updatedInput` round-trip.
    if (toolName === "write" || toolName === "edit") {
      const input = event.input as PathToolParams;
      const raw = input.path;
      if (typeof raw === "string" && raw.length > 0) {
        const checked = guardToolPath(cwd, raw, strict);
        if (checked.denied) {
          return { block: true, reason: checked.message };
        }
        if (checked.path !== raw) {
          input.path = checked.path;
        }
      }
    }

    // ② Bash write-target guard. Same scope/limits as the pre-refactor
    //    createGuardedBashTool — NOT a sandbox, just blocks the common
    //    "write a helper script outside the project" pattern.
    if (toolName === "bash") {
      const input = event.input as { command?: unknown };
      const command = input.command;
      if (typeof command === "string" && command.length > 0) {
        const denial = guardBashCommand(cwd, command, strict);
        if (denial) {
          return { block: true, reason: denial };
        }
      }
    }

    // ③ Plan tools + AskUserQuestion — their own execute() handles the IPC
    //    bridging; never route through the approval prompt or the plan-mode
    //    read-only gate.
    if (toolName === "EnterPlanMode" || toolName === "ExitPlanMode" || toolName === "AskUserQuestion") {
      return;
    }
    //    Read-only browser tools (list/snapshot/screenshot) can't mutate the
    //    page or navigate, so they're safe to auto-approve in every mode.
    //    `browser_navigate` / `browser_click` DO have side effects and fall
    //    through to the normal approval flow below.
    if (MCODE_BROWSER_READONLY.has(toolName)) {
      return;
    }

    // ④ Plan-mode: write tools allowed but require approval.
    //    Unlike Claude's plan mode (strictly read-only), Pi's plan mode lets the
    //    model write files / run commands to verify hypotheses during planning —
    //    but every mutating tool goes through the approval prompt (step ⑤).
    //    planMode.active doesn't block tools here; it only means
    //    shouldAutoApproveForPi returns false for everything, so the user gets
    //    an approval dialog for each write/edit/bash. The model can experiment
    //    safely while the user retains control.

    // ⑤ Permission-mode auto-approve (reads the LIVE mode so a mid-turn flip
    //    applies to the next tool immediately). In plan mode, nothing is
    //    auto-approved — every tool hits the approval prompt below.
    const mode = ctx.getPermissionMode?.();
    if (shouldAutoApproveForPi(mode, toolName)) {
      return;
    }
    if (ctx.isToolAlwaysAllowed?.(toolName)) {
      return;
    }

    // ⑥ Host-moderated approval via IPC. When no bridge is wired, fall open
    //    (fail-open matches the Claude provider's behavior when requestApproval
    //    is undefined).
    const requestApproval = ctx.requestApproval;
    if (!requestApproval) {
      return;
    }
    const r = await requestApproval({
      requestId: randomUUID(),
      toolName,
      input: event.input,
    });
    return r.allow ? undefined : { block: true, reason: r.reason ?? "Denied by user" };
  });
}

/**
 * Register a native `AskUserQuestion` tool. The model calls it autonomously;
 * `execute` bridges to the host's `requestUserInput` IPC (the same one the
 * Claude provider's canUseTool uses), and returns the user's answers as a
 * text tool result the model reads as its reply.
 *
 * This replaces the sentinel-text fallback (model emits
 * `<<<ASK_USER_QUESTION>>>` JSON that the adapter scans for). The native tool
 * is more reliable — no format drift, the model gets a structured result
 * back, and the question panel opens deterministically.
 */
function registerAskUserQuestionTool(pi: ExtensionAPI, ctx: ProviderContext): void {
  pi.registerTool({
    name: "AskUserQuestion",
    label: "Ask User Question",
    description:
      "Ask the user a question when you need information or a decision. " +
      "Provide a clear question and 2-4 options the user can choose from. " +
      "After calling this tool, STOP and wait for the user's answer.",
    promptSnippet: "AskUserQuestion: ask the user a question with selectable options",
    parameters: Type.Object({
      questions: Type.Array(
        Type.Object({
          header: Type.String({ description: "A short label for the question" }),
          question: Type.String({ description: "The full question text" }),
          multiSelect: Type.Boolean({
            description: "Whether the user can select multiple options",
          }),
          options: Type.Array(
            Type.Object({
              label: Type.String({ description: "The option label" }),
              description: Type.Optional(
                Type.String({ description: "Why this option, or its consequence" }),
              ),
            }),
          ),
        }),
      ),
    }),
    async execute(toolCallId, params) {
      const requestUserInput = ctx.requestUserInput;
      if (!requestUserInput) {
        throw new Error("User input not available");
      }
      const questions = parseQuestions(params);
      if (questions.length === 0) {
        throw new Error("Malformed AskUserQuestion input: no valid questions");
      }
      const requestId = randomUUID();
      const decision = await requestUserInput({
        requestId,
        toolUseId: toolCallId,
        questions,
      });
      return {
        content: [
          { type: "text", text: formatAnswersForModel(decision.answers, questions) },
        ],
        details: {},
      };
    },
  });
}

/**
 * Register the `browser_*` tools that drive the app's embedded browser (the
 * same `BrowserManager` `WebContentsView` the browser panel uses). The actual
 * operations live in `agentBrowserTools.ts` (shared with the Claude provider);
 * here we only define the typebox parameter schemas + bridge screenshots to
 * `ctx.emit` so the renderer can render them inline.
 *
 * Read-only tools (list/snapshot/screenshot) are auto-approved by the
 * `tool_call` guard (see `MCODE_BROWSER_READONLY`); `navigate`/`click` have
 * side effects and go through the normal approval prompt.
 */
function registerBrowserTools(
  pi: ExtensionAPI,
  deps: { ctx: ProviderContext; sessionId: string; projectPath: string },
): void {
  const { ctx, sessionId, projectPath } = deps;

  // Convert a shared ToolResult into Pi's execute() return shape. They're
  // structurally identical (content[] + details), so this is effectively an
  // identity — but spelling it out keeps the return type tied to ToolResult's
  // TextBlock|ImageBlock union, which satisfies Pi's (TextContent|ImageContent)[].
  const toPiResult = (r: ToolResult) => ({
    content: r.content,
    details: (r.details ?? {}) as Record<string, unknown>,
  });

  pi.registerTool({
    name: "browser_list",
    label: "Browser List",
    description:
      "列出当前所有打开的浏览器视图及其 URL 和标题,返回每个视图的 browserId。" +
      "调用其他 browser_* 工具时可用 browserId 参数指定目标;省略时自动复用第一个已开视图。",
    promptSnippet: "browser_list(): 列出打开的浏览器视图",
    parameters: Type.Object({}),
    async execute() {
      return toPiResult(browserList());
    },
  });

  pi.registerTool({
    name: "browser_navigate",
    label: "Browser Navigate",
    description:
      "在应用内浏览器中导航到指定 URL(仅 http/https)。若没有打开的浏览器视图会自动创建并显示一个。" +
      "browserId 可选——省略时自动复用或新建。导航后需调用 browser_snapshot 读取页面内容。",
    promptSnippet: "browser_navigate({url, browserId?}): 导航到 URL",
    parameters: Type.Object({
      url: Type.String({ description: "目标 URL,必须含 http:// 或 https://" }),
      browserId: Type.Optional(
        Type.String({ description: "目标浏览器视图 id;省略则自动复用第一个已开视图或新建" }),
      ),
    }),
    async execute(_toolCallId, params) {
      const { url, browserId } = params as { url: string; browserId?: string };
      return toPiResult(await browserNavigate({ url, browserId }, projectPath));
    },
  });

  pi.registerTool({
    name: "browser_snapshot",
    label: "Browser Snapshot",
    description:
      "读取当前页面的结构化快照:URL、标题、readyState、页面正文,以及可交互元素列表(链接/按钮/输入框/标题等)。" +
      "每个可交互元素带 role/name/tag/selector/text——其中的 selector 可直接传给 browser_click。" +
      "只读,无副作用。这是理解页面内容、定位要操作的元素的主要方式。",
    promptSnippet: "browser_snapshot({browserId?}): 读取页面结构化快照(只读)",
    parameters: Type.Object({
      browserId: Type.Optional(Type.String({ description: "目标浏览器视图 id;省略则用第一个已开视图" })),
    }),
    async execute(_toolCallId, params) {
      const { browserId } = params as { browserId?: string };
      return toPiResult(await browserSnapshot({ browserId }));
    },
  });

  pi.registerTool({
    name: "browser_click",
    label: "Browser Click",
    description:
      "按 CSS selector 点击页面元素。selector 应来自 browser_snapshot 返回的可交互元素列表。" +
      "返回点击后的 URL 和标题,可用于判断是否触发了导航。有副作用(会触发页面的点击行为)。",
    promptSnippet: "browser_click({selector, browserId?}): 点击元素",
    parameters: Type.Object({
      selector: Type.String({ description: "要点击元素的 CSS selector(来自 browser_snapshot)" }),
      browserId: Type.Optional(Type.String({ description: "目标浏览器视图 id;省略则用第一个已开视图" })),
    }),
    async execute(_toolCallId, params) {
      const { selector, browserId } = params as { selector: string; browserId?: string };
      return toPiResult(await browserClick({ selector, browserId }));
    },
  });

  pi.registerTool({
    name: "browser_screenshot",
    label: "Browser Screenshot",
    description:
      "截取当前页面的可视区域,返回 PNG 图片。用于需要视觉确认页面布局/样式的场景。" +
      "只读,无副作用。截图会同时显示给用户和返回给你。",
    promptSnippet: "browser_screenshot({browserId?}): 截图(只读)",
    parameters: Type.Object({
      browserId: Type.Optional(Type.String({ description: "目标浏览器视图 id;省略则用第一个已开视图" })),
    }),
    async execute(toolCallId, params) {
      const { browserId } = params as { browserId?: string };
      const r = await browserScreenshot({ browserId }, {
        toolCallId,
        onImage: (info) => {
          // Emit a structured event so the renderer attaches an inline image
          // block (Pi path). Claude's image surfacing happens via the
          // tool_result content instead.
          ctx.emit({
            type: "browser.image",
            sessionId,
            toolCallId: info.toolCallId,
            data: info.data,
            mimeType: info.mimeType,
          });
        },
      });
      return toPiResult(r);
    },
  });
}

/**
 * Register `EnterPlanMode` and `ExitPlanMode` tools, bridging to the host's
 * plan-mode UI (the same `plan.update` / `mode.change` / `plan.approval_request`
 * RuntimeEvents that Claude's SdkMessageAdapter emits). The frontend plan
 * card system (`PlanStreamBlock` / `PlanViewer` / `PlanApprovalPrompt`) is
 * provider-neutral — it reacts to those events regardless of source, so Pi
 * reuses the entire Claude plan UI with zero renderer changes.
 *
 * ## State tracking
 *
 * `planMode.active` is an in-process boolean (closure-captured), NOT
 * `ctx.getPermissionMode()`. The latter updates via an async IPC round-trip
 * (renderer → updateSettings → setPermissionMode) that races with the next
 * tool_call. The boolean is synchronous: EnterPlanMode sets it before
 * returning, so the tool_call handler's read-only gate (above) is immediately
 * enforced.
 *
 * ## ExitPlanMode blocking
 *
 * ExitPlanMode's `execute` awaits `ctx.requestPlanApproval()` — a Deferred
 * that resolves when the user approves/rejects via the IPC bridge. This blocks
 * the agent loop (verified: `agent-loop.js` awaits `tool.execute`), so the
 * model pauses until the user decides. This is the Pi equivalent of Claude's
 * `canUseTool`/`onUserDialog` blocking on ExitPlanMode.
 */
function registerPlanModeTools(
  pi: ExtensionAPI,
  deps: { ctx: ProviderContext; sessionId: string; planMode: { active: boolean } },
): void {
  const { ctx, sessionId, planMode } = deps;

  pi.registerTool({
    name: "EnterPlanMode",
    label: "Enter Plan Mode",
    description:
      "进入计划模式。在计划模式中你可以进行只读探索(读文件、搜索)来调研问题,也可以写文件/执行命令做验证——" +
      "但每个修改操作都需要用户审批。充分调研后,调用 ExitPlanMode 提交你的执行计划给用户审批。" +
      "适用于复杂任务或涉及重要修改的场景。",
    promptSnippet: "EnterPlanMode: 进入计划模式,调研+验证(写操作需审批),完成后用 ExitPlanMode 提交",
    parameters: Type.Object({}),
    async execute() {
      planMode.active = true;
      // Notify the frontend: sync the composer chip to "plan" + show drafting
      // state in the activity capsule. The plan text is empty (drafting) so no
      // plan card appears yet — only the chip + capsule update.
      ctx.emit({ type: "mode.change", sessionId, mode: "plan", source: "model" });
      ctx.emit({ type: "plan.update", sessionId, plan: "", phase: "drafting" });
      return {
        content: [
          {
            type: "text",
            text: "已进入计划模式。你可以使用 read/grep/find/ls 等只读工具调研,也可以写文件或执行命令做验证(每个修改操作需用户审批)。调研完成后,调用 ExitPlanMode 提交你的计划。",
          },
        ],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "ExitPlanMode",
    label: "Exit Plan Mode",
    description:
      "提交你的执行计划给用户审批。用户可以批准(退出计划模式开始执行)、拒绝(留在计划模式修改计划)或编辑计划内容。" +
      "调用此工具后会暂停等待用户决策。计划应为结构化的 Markdown 文本,包含目标、步骤和影响范围。",
    promptSnippet: "ExitPlanMode({plan}): 提交计划给用户审批,批准后退出计划模式",
    parameters: Type.Object({
      plan: Type.String({ description: "完整的执行计划(Markdown 格式),包含目标、步骤、影响范围" }),
    }),
    async execute(toolCallId, params) {
      const plan = (params as { plan?: string }).plan ?? "";
      // Phase "ready" → the plan card appears in the message stream with the
      // full plan text (PlanStreamBlock renders it as an inline card).
      ctx.emit({ type: "plan.update", sessionId, plan, phase: "ready" });

      try {
        // Bridge to the host's approval UI. This awaits a Deferred that
        // resolves when the user clicks approve/reject in the
        // PlanApprovalPrompt. The agent loop is blocked here (same-turn).
        const requestPlanApproval = ctx.requestPlanApproval;
        if (!requestPlanApproval) {
          // No bridge wired — fail open (exit plan mode without approval).
          planMode.active = false;
          ctx.emit({ type: "mode.change", sessionId, mode: "default", source: "model" });
          return {
            content: [{ type: "text", text: "计划审批不可用,已自动退出计划模式。" }],
            details: {},
          };
        }
        const decision = await requestPlanApproval({
          requestId: randomUUID(),
          plan,
          toolUseId: toolCallId,
        });

        if (decision.approved) {
          const finalPlan = decision.editedPlan ?? plan;
          planMode.active = false;
          // Exit plan mode → the composer chip returns to default, and the
          // tool_call handler's read-only gate is lifted (next write/edit/bash
          // passes through). The plan card stays as a frozen historical card
          // (frontend turn.done freezes ready+nonempty plan blocks).
          ctx.emit({ type: "mode.change", sessionId, mode: "default", source: "model" });
          return {
            content: [{ type: "text", text: `计划已批准,开始执行:\n\n${finalPlan}` }],
            details: {},
          };
        }

        // Rejected — stay in plan mode so the model can revise and resubmit.
        // Flip the plan back to "drafting" so the card reflects the ongoing
        // revision cycle (the frontend keeps the card but updates the badge).
        const reason = decision.reason ?? "用户未提供理由";
        ctx.emit({ type: "plan.update", sessionId, plan, phase: "drafting" });
        return {
          content: [
            {
              type: "text",
              text: `计划被用户拒绝。原因:${reason}。你仍处于计划模式,请修改计划后重新调用 ExitPlanMode 提交。`,
            },
          ],
          details: {},
        };
      } catch (err) {
        // Interrupted (user abort / session dispose) — clean up plan mode
        // state so a stale read-only gate doesn't linger. Re-throw so the
        // agent loop records the tool as failed.
        planMode.active = false;
        ctx.emit({ type: "plan.update", sessionId, plan: "", phase: "cleared" });
        ctx.emit({ type: "mode.change", sessionId, mode: "default", source: "model" });
        throw err;
      }
    },
  });
}

/**
 * System-prompt text teaching the model how to use the plan-mode tools.
 * Appended (alongside the AskUserQuestion hint) via `before_agent_start`.
 */
const PLAN_MODE_PROMPT = [
  `## 计划模式工具`,
  `当任务复杂或涉及重要修改时,先制定计划再执行:`,
  `1. 调用 EnterPlanMode 进入计划模式`,
  `2. 使用 read/grep/find/ls 等只读工具充分调研;如需验证可写文件/执行命令,但每个修改操作都需用户审批`,
  `3. 调用 ExitPlanMode({plan: "你的详细计划"}) 提交计划给用户审批`,
  `4. 用户批准后退出计划模式开始执行;拒绝则留在计划模式修改计划`,
  `计划文本应为结构化的 Markdown,包含目标、步骤、影响范围。`,
].join("\n");

/**
 * System-prompt text teaching the model how to use the browser tools. Appended
 * (alongside AskUserQuestion + plan-mode hints) via `before_agent_start`.
 */
const BROWSER_TOOLS_PROMPT = [
  `## 浏览器工具(控制应用内浏览器)`,
  `当需要打开网页、查看页面内容、或与网页交互时使用这组工具:`,
  `1. browser_navigate({ url }): 打开一个网页(仅 http/https)。没有打开的浏览器时会自动创建一个`,
  `2. browser_snapshot({ browserId? }): 读取页面结构化快照——可交互元素列表带可直接传给 browser_click 的 selector(只读)`,
  `3. browser_click({ selector, browserId? }): 按 selector 点击元素(selector 来自 snapshot)`,
  `4. browser_screenshot({ browserId? }): 截图,用于视觉确认布局/样式(只读)`,
  `5. browser_list(): 列出所有打开的浏览器视图及其 browserId`,
  `browserId 参数全部可选——省略时自动复用第一个已开视图。典型流程: navigate → snapshot 读内容 → 按需 click/screenshot。`,
].join("\n");

/**
 * `before_agent_start` handler — injects the AskUserQuestion usage hint AND
 * the plan-mode tool usage guide into the system prompt. The event fires each
 * turn before the agent loop starts; returning `systemPrompt` overrides
 * `agent.state.systemPrompt` for the turn.
 *
 * The AskUserQuestion text is the same `ASK_SYSTEM_PROMPT` the Claude provider
 * uses — kept in one place (`@main/lib/askQuestion`) to avoid drift.
 */
function registerSystemPromptInjector(pi: ExtensionAPI): void {
  pi.on(
    "before_agent_start",
    async (event: BeforeAgentStartEvent): Promise<BeforeAgentStartEventResult | void> => {
      const base = event.systemPrompt ?? "";
      const injected = `${ASK_SYSTEM_PROMPT}\n\n${PLAN_MODE_PROMPT}\n\n${BROWSER_TOOLS_PROMPT}`;
      const next = base ? `${base}\n\n${injected}` : injected;
      return { systemPrompt: next };
    },
  );
}
