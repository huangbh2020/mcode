/**
 * Antigravity ACP adapter — translates `session/update` notifications and
 * server-initiated requests (`session/request_permission`, `elicitation/create`)
 * into Mcode's provider-neutral `RuntimeEvent` stream.
 *
 * Incorporates the Antigravity ACP dialect lessons from stablyai/orca:
 *   - `normalizeToolUpdate`: normalizes `CommandLine`/`Cwd`/`combinedOutput`/
 *     `exitCode` variants and maps ACP tool kinds into Mcode's canonical tool
 *     shapes (`Bash`, `Read`, `Edit`, `Write`, `Grep`, `Glob`, `WebFetch`).
 *   - `interaction_` permission asks: always treated as AskUserQuestion rather
 *     than auto-approved tool calls, even in `bypassPermissions` mode.
 *   - `agy.security.warning`: surfaced on approval cards.
 *   - `⚠ Model produced invalid output.`: mapped to `upstream.issue` retry hint
 *     instead of leaking into the assistant prose.
 *   - Turn failure notices (`UNAUTHENTICATED`, `API key not valid`,
 *     `Failed to rebuild agent`, etc.): surfaced as `error` events.
 */
import { randomUUID } from "node:crypto";
import type { ProviderContext } from "@contracts/provider";
import type {
  AskUserQuestionItem,
  ContextSnapshot,
  ContextWarning,
  ContextWarningKind,
  PermissionMode,
  TurnDoneReason,
} from "@contracts/runtime";
import { FileSnapshot, normalizeToolFilePath } from "@main/lib/fileSnapshot.js";
import { guardBashCommand, expandTilde } from "@main/lib/bashWriteGuard.js";
import { guardReadPath } from "@main/lib/readGuard.js";
import { normalizeBashCommand } from "@main/lib/msysPath.js";
import {
  AcpElicitationFormSchema,
  AcpMessageChunkSchema,
  AcpPlanUpdateSchema,
  AcpRequestPermissionSchema,
  AcpSessionNotificationSchema,
  AcpToolCallUpdateSchema,
  AcpUsageUpdateSchema,
  type AcpToolCallUpdate,
} from "./acpProtocol.js";

const RETRY_NOTICE_RE = /^\s*\u26a0 (Model produced invalid output\.)\s*$/;
const TURN_FAILURE_NOTICE_RE =
  /^\s*(?:\u26a0 (?:UNAUTHENTICATED \(code 401\)|agent executor error): [^\n]*|API key not valid\. Please pass a valid API key\.|Agent execution error: failed to create Gemini client: [^\n]*|Agent connection was lost and could not be re-established: Failed to rebuild agent: [\s\S]*)\s*$/;
const REBUILD_FAILED_MARKER = "Failed to rebuild agent: ";
const WARNING_MAX_CHARS = 512;

export interface AntigravityAdapterDeps {
  sessionId: string;
  acpSessionId: string;
  cwd: string;
  model?: string;
  permissionMode?: PermissionMode;
  ctx: ProviderContext;
  snapshot: FileSnapshot;
  abortSignal: AbortSignal;
}

interface TrackedTool {
  toolName: string;
  input: unknown;
  filePath?: string;
  completed: boolean;
}

function asRecord(val: unknown): Record<string, unknown> | null {
  return val != null && typeof val === "object" && !Array.isArray(val)
    ? (val as Record<string, unknown>)
    : null;
}

function firstString(rec: Record<string, unknown> | null, keys: readonly string[]): string | undefined {
  if (!rec) return undefined;
  for (const key of keys) {
    const val = rec[key];
    if (typeof val === "string" && val.length > 0) return val;
  }
  return undefined;
}

function firstInt(rec: Record<string, unknown> | null, keys: readonly string[]): number | undefined {
  if (!rec) return undefined;
  for (const key of keys) {
    const val = rec[key];
    if (typeof val === "number" && Number.isInteger(val)) return val;
  }
  return undefined;
}

/** Map ACP tool metadata + rawInput into Mcode's canonical toolName and input
 *  shape so MessageBlocks renders Bash/Read/Edit/Write/Search cards natively. */
export function normalizeAgyToolCall(update: {
  kind?: string;
  name?: string;
  title?: string;
  rawInput?: unknown;
  locations?: Array<{ path?: string }>;
}): { toolName: string; input: unknown; filePath?: string; isMutation: boolean; isRead: boolean } {
  const raw = asRecord(update.rawInput);
  const command = firstString(raw, ["CommandLine", "command_line", "commandLine", "command", "cmd"]);
  const cwd = firstString(raw, ["Cwd", "WorkingDirectory", "working_dir", "workingDir", "cwd"]);
  const filePath =
    firstString(raw, ["file_path", "filePath", "path", "TargetFile", "target_file", "AbsolutePath"]) ??
    update.locations?.find((l) => typeof l.path === "string" && l.path.length > 0)?.path;
  const oldText = firstString(raw, ["old_string", "oldText", "TargetContent", "old_str"]);
  const newText = firstString(raw, ["new_string", "newText", "ReplacementContent", "new_str"]);
  const writeContent = firstString(raw, ["content", "CodeContent", "text"]);
  const pattern = firstString(raw, ["pattern", "Query", "query", "regex"]);

  const kind = update.kind?.toLowerCase();
  const rawName = (update.name ?? update.title ?? "").toLowerCase();

  if (kind === "execute" || command !== undefined || /\bbash\b|\bshell\b|\bcommand\b/.test(rawName)) {
    return {
      toolName: "Bash",
      input: command !== undefined ? { command, ...(cwd ? { cwd } : {}) } : update.rawInput ?? {},
      isMutation: false,
      isRead: false,
    };
  }

  if (kind === "edit" || (filePath && oldText !== undefined && newText !== undefined)) {
    return {
      toolName: "Edit",
      input:
        filePath !== undefined
          ? {
              file_path: filePath,
              ...(oldText !== undefined ? { old_string: oldText } : {}),
              ...(newText !== undefined ? { new_string: newText } : {}),
            }
          : update.rawInput ?? {},
      filePath,
      isMutation: true,
      isRead: false,
    };
  }

  if (kind === "create" || kind === "write" || (filePath && writeContent !== undefined && oldText === undefined)) {
    return {
      toolName: "Write",
      input:
        filePath !== undefined
          ? { file_path: filePath, ...(writeContent !== undefined ? { content: writeContent } : {}) }
          : update.rawInput ?? {},
      filePath,
      isMutation: true,
      isRead: false,
    };
  }

  if (kind === "read" || /\bview_file\b|\bread_file\b|\bread\b/.test(rawName)) {
    return {
      toolName: "Read",
      input: filePath !== undefined ? { file_path: filePath } : update.rawInput ?? {},
      filePath,
      isMutation: false,
      isRead: true,
    };
  }

  if (kind === "search" || /\bgrep\b|\bsearch\b/.test(rawName)) {
    return {
      toolName: "Grep",
      input: pattern !== undefined ? { pattern, ...(filePath ? { path: filePath } : {}) } : update.rawInput ?? {},
      filePath,
      isMutation: false,
      isRead: true,
    };
  }

  if (kind === "find" || /\bfind_by_name\b|\bglob\b/.test(rawName)) {
    return {
      toolName: "Glob",
      input: pattern !== undefined ? { pattern, ...(filePath ? { path: filePath } : {}) } : update.rawInput ?? {},
      filePath,
      isMutation: false,
      isRead: true,
    };
  }

  if (kind === "fetch" || /\bweb_fetch\b|\bread_url\b/.test(rawName)) {
    return {
      toolName: "WebFetch",
      input: update.rawInput ?? {},
      isMutation: false,
      isRead: false,
    };
  }

  return {
    toolName: update.name ?? update.title ?? update.kind ?? "tool",
    input: update.rawInput ?? {},
    filePath,
    isMutation: false,
    isRead: false,
  };
}

/** Extract tool output text from ACP `ToolCallUpdate.content` or `rawOutput`. */
export function extractAgyToolOutput(update: AcpToolCallUpdate): unknown {
  const texts = (update.content ?? [])
    .filter((item) => item.type === "content" && item.content?.type === "text" && typeof item.content.text === "string")
    .map((item) => item.content!.text!);
  if (texts.length > 0) return texts.join("\n");

  const diffItems = (update.content ?? []).filter(
    (item) => item.type === "diff" && typeof item.path === "string",
  );
  if (diffItems.length > 0 && update.rawOutput === undefined) {
    return diffItems.map((d) => `Updated ${d.path}`).join("\n");
  }

  if (update.rawOutput === undefined) return "";
  if (typeof update.rawOutput === "string") return update.rawOutput;

  const rec = asRecord(update.rawOutput);
  if (rec) {
    const combined = firstString(rec, ["combinedOutput", "combined_output"]);
    if (combined !== undefined) {
      const exitCode = firstInt(rec, ["exitCode", "exit_code"]);
      return exitCode !== undefined && exitCode !== 0 ? `${combined}\n[exit code: ${exitCode}]` : combined;
    }
    const stdout = firstString(rec, ["stdout"]);
    const stderr = firstString(rec, ["stderr"]);
    if (stdout !== undefined || stderr !== undefined) {
      return [stdout, stderr].filter(Boolean).join("\n");
    }
  }

  return update.rawOutput;
}

export class AntigravityMessageAdapter {
  private readonly tools = new Map<string, TrackedTool>();
  private currentTextMsgId: string | null = null;
  private currentThinkingMsgId: string | null = null;
  private emittedPlan = false;
  private retryAttempt = 0;
  private failureMessage: string | null = null;
  private sessionLostNoticeSeen = false;
  private finalized = false;

  constructor(private readonly deps: AntigravityAdapterDeps) {}

  get hasSessionLostNotice(): boolean {
    return this.sessionLostNoticeSeen;
  }

  get lastFailureMessage(): string | null {
    return this.failureMessage;
  }

  /** Handle one `session/update` notification from `agy acp`. */
  handleSessionNotification(rawParams: unknown): void {
    if (this.finalized) return;
    const envelope = AcpSessionNotificationSchema.safeParse(rawParams);
    if (!envelope.success) return;
    if (envelope.data.sessionId !== this.deps.acpSessionId) return;
    // Ignore history replays during `session/load` — Mcode already holds persisted messages.
    if (envelope.data._meta?.isReplay === true) return;

    const rawUpdate = envelope.data.update;
    const kind = rawUpdate.sessionUpdate;

    if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
      const parsed = AcpMessageChunkSchema.safeParse(rawUpdate);
      if (!parsed.success || parsed.data.content.type !== "text") return;
      const text = parsed.data.content.text ?? "";
      if (!text) return;

      if (kind === "agent_thought_chunk") {
        this.currentTextMsgId = null;
        if (!this.currentThinkingMsgId) {
          this.currentThinkingMsgId = parsed.data.messageId
            ? `${parsed.data.messageId}:thinking`
            : `agy-think-${randomUUID()}`;
        }
        this.deps.ctx.emit({
          type: "thinking",
          sessionId: this.deps.sessionId,
          messageId: this.currentThinkingMsgId,
          text,
        });
        return;
      }

      // Check for Antigravity retry notice (`⚠ Model produced invalid output.`)
      const retryMatch = RETRY_NOTICE_RE.exec(text);
      if (retryMatch) {
        this.retryAttempt += 1;
        this.deps.ctx.emit({
          type: "upstream.issue",
          sessionId: this.deps.sessionId,
          kind: "retry",
          cause: retryMatch[1]!,
          attempt: this.retryAttempt,
          attempts: Math.max(this.retryAttempt, 3),
        });
        return;
      }

      // Check for Antigravity turn-failure notice
      if (TURN_FAILURE_NOTICE_RE.test(text)) {
        const trimmed = text.trim();
        this.failureMessage = trimmed;
        if (trimmed.includes(REBUILD_FAILED_MARKER)) {
          this.sessionLostNoticeSeen = true;
        }
        this.deps.ctx.emit({
          type: "error",
          sessionId: this.deps.sessionId,
          message: trimmed,
        });
        return;
      }

      if (this.retryAttempt > 0) {
        this.retryAttempt = 0;
        this.deps.ctx.emit({
          type: "upstream.issue",
          sessionId: this.deps.sessionId,
          kind: "ok",
          cause: "",
          attempt: 1,
          attempts: 1,
        });
      }

      this.currentThinkingMsgId = null;
      if (parsed.data.messageId) {
        this.currentTextMsgId = `${parsed.data.messageId}:assistant`;
      } else if (!this.currentTextMsgId) {
        this.currentTextMsgId = `agy-msg-${randomUUID()}`;
      }

      this.deps.ctx.emit({
        type: "text.delta",
        sessionId: this.deps.sessionId,
        messageId: this.currentTextMsgId,
        text,
      });
      return;
    }

    if (kind === "tool_call" || kind === "tool_call_update") {
      const parsed = AcpToolCallUpdateSchema.safeParse(rawUpdate);
      if (!parsed.success) return;
      this.handleToolUpdate(parsed.data);
      return;
    }

    if (kind === "plan") {
      const parsed = AcpPlanUpdateSchema.safeParse(rawUpdate);
      if (!parsed.success) return;
      const planMarkdown = parsed.data.entries
        .map(
          (entry) =>
            `- [${entry.status === "completed" ? "x" : entry.status === "in_progress" ? "~" : " "}] ${entry.content}`,
        )
        .join("\n");
      this.emittedPlan = true;
      this.deps.ctx.emit({
        type: "plan.update",
        sessionId: this.deps.sessionId,
        plan: planMarkdown,
        phase: "drafting",
      });
      return;
    }

    if (kind === "usage_update") {
      const parsed = AcpUsageUpdateSchema.safeParse(rawUpdate);
      if (!parsed.success) return;
      const used = parsed.data.used ?? 0;
      const size = parsed.data.size && parsed.data.size > 0 ? parsed.data.size : 1_000_000;
      const pct = Math.min(100, Math.max(0, Math.round((used / size) * 100)));
      const warning: ContextWarning = pct >= 90 ? "critical" : pct >= 70 ? "near-window" : "ok";
      const warnings: ContextWarningKind[] = warning === "ok" ? [] : ["near-window"];
      const snapshot: ContextSnapshot = {
        usedTokens: Math.min(used, size),
        totalProcessedTokens: used,
        maxTokens: size,
        outputTokens: 0,
        costUsd: parsed.data.cost?.amount,
        model: this.deps.model,
        pct,
        warning,
        warnings,
      };
      this.deps.ctx.emit({
        type: "token-usage.updated",
        sessionId: this.deps.sessionId,
        snapshot,
      });
    }
  }

  private handleToolUpdate(update: AcpToolCallUpdate): void {
    // Seal current text/thinking message boundary so subsequent prose starts a fresh block.
    this.currentTextMsgId = null;
    this.currentThinkingMsgId = null;

    const existing = this.tools.get(update.toolCallId);
    const norm = normalizeAgyToolCall({
      kind: update.kind,
      name: update.name,
      title: update.title,
      rawInput: update.rawInput,
      locations: update.locations,
    });

    const toolName = existing ? existing.toolName : norm.toolName;
    const input = update.rawInput !== undefined ? norm.input : existing?.input ?? norm.input;
    const filePath = norm.filePath ?? existing?.filePath;

    if (!existing) {
      if (norm.isMutation && filePath) {
        void this.deps.snapshot.recordPre(this.deps.cwd, filePath);
      }
      const requiresApproval = update.status === "pending";
      this.tools.set(update.toolCallId, {
        toolName,
        input,
        filePath,
        completed: false,
      });
      this.deps.ctx.emit({
        type: "tool.use",
        sessionId: this.deps.sessionId,
        toolCallId: update.toolCallId,
        toolName,
        input,
        requiresApproval,
      });
    }

    // Forward inline images from tool content if any.
    for (const item of update.content ?? []) {
      if (
        item.type === "content" &&
        item.content?.type === "image" &&
        typeof item.content.data === "string" &&
        typeof item.content.mimeType === "string"
      ) {
        const mime = item.content.mimeType;
        if (mime === "image/png" || mime === "image/jpeg" || mime === "image/webp" || mime === "image/gif") {
          this.deps.ctx.emit({
            type: "browser.image",
            sessionId: this.deps.sessionId,
            toolCallId: update.toolCallId,
            data: item.content.data,
            mimeType: mime,
          });
        }
      }
    }

    if (update.status === "completed" || update.status === "failed") {
      const tracked = this.tools.get(update.toolCallId);
      if (tracked && !tracked.completed) {
        tracked.completed = true;
        // Also record diff items' paths if mutation wasn't caught earlier.
        for (const item of update.content ?? []) {
          if (item.type === "diff" && item.path) {
            void this.deps.snapshot.recordPre(this.deps.cwd, item.path);
          }
        }
        const output = extractAgyToolOutput(update);
        this.deps.ctx.emit({
          type: "tool.result",
          sessionId: this.deps.sessionId,
          toolCallId: update.toolCallId,
          isError: update.status === "failed",
          content: output,
        });
      }
    }
  }

  /** Handle `session/request_permission` from `agy acp`. */
  async handlePermissionRequest(
    rawParams: unknown,
    signal: AbortSignal,
  ): Promise<{ outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" } }> {
    const parsed = AcpRequestPermissionSchema.safeParse(rawParams);
    if (!parsed.success || parsed.data.sessionId !== this.deps.acpSessionId) {
      return { outcome: { outcome: "cancelled" } };
    }
    const { toolCall, options } = parsed.data;

    // 1. Formless `interaction_*` questions: always ask the user (never auto-approve).
    if (toolCall.toolCallId.startsWith("interaction_")) {
      return this.handleInteractionQuestion(toolCall.title ?? "Question", options, signal);
    }

    const norm = normalizeAgyToolCall({
      kind: toolCall.kind,
      title: toolCall.title,
      rawInput: toolCall.rawInput,
      locations: toolCall.locations,
    });

    // Record pre-turn snapshot for file mutations before approval resolves.
    if (norm.isMutation && norm.filePath) {
      await this.deps.snapshot.recordPre(this.deps.cwd, norm.filePath);
    }

    const mode = this.deps.permissionMode ?? "default";
    const strict = mode !== "bypassPermissions" && mode !== "dontAsk";
    const isolated = mode === "isolated";

    // 2. Host boundary guards (mirroring Opencode / Pi guards)
    if (strict && norm.isMutation && norm.filePath) {
      const resolved = normalizeToolFilePath(this.deps.cwd, expandTilde(norm.filePath));
      if (resolved && !resolved.insideProject) {
        return pickRejectOption(options);
      }
    }
    if (strict && norm.toolName === "Bash") {
      const cmd = (norm.input as { command?: string } | undefined)?.command;
      if (cmd) {
        const guard = guardBashCommand(this.deps.cwd, normalizeBashCommand(cmd), strict);
        if (guard) return pickRejectOption(options);
      }
    }
    if (isolated && norm.isRead && norm.filePath) {
      const guard = guardReadPath(this.deps.cwd, norm.filePath);
      if (guard) return pickRejectOption(options);
    }

    // 3. Mode-level or session-level auto-approval
    if (
      !strict ||
      ((mode === "acceptEdits" || isolated) && norm.isMutation) ||
      this.deps.ctx.isToolAlwaysAllowed?.(norm.toolName)
    ) {
      return pickAllowOption(options, false);
    }

    if (!this.deps.ctx.requestApproval || signal.aborted) {
      return { outcome: { outcome: "cancelled" } };
    }

    const securityWarning = extractSecurityWarning(options);
    const description = securityWarning
      ? `${toolCall.title ?? norm.toolName}\n\n⚠ ${securityWarning}`
      : toolCall.title;

    const decision = await this.deps.ctx.requestApproval({
      requestId: randomUUID(),
      toolName: norm.toolName,
      input: norm.input,
      description,
    });

    if (signal.aborted || this.deps.abortSignal.aborted) {
      return { outcome: { outcome: "cancelled" } };
    }
    if (decision.allow) {
      return pickAllowOption(options, Boolean(decision.persist));
    }
    return pickRejectOption(options);
  }

  private async handleInteractionQuestion(
    questionText: string,
    options: Array<{ optionId: string; name: string }>,
    signal: AbortSignal,
  ): Promise<{ outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" } }> {
    if (!this.deps.ctx.requestUserInput || signal.aborted) {
      return { outcome: { outcome: "cancelled" } };
    }
    const item: AskUserQuestionItem = {
      header: "Question",
      question: questionText,
      multiSelect: false,
      options: options.map((o) => ({ label: o.name })),
    };
    const decision = await this.deps.ctx.requestUserInput({
      requestId: randomUUID(),
      questions: [item],
    });
    if (decision.dismissed || signal.aborted) {
      return { outcome: { outcome: "cancelled" } };
    }
    const chosenLabel = decision.answers[item.question];
    const labelStr = Array.isArray(chosenLabel) ? chosenLabel[0] : chosenLabel;
    const matched = options.find((o) => o.name === labelStr);
    if (!matched) {
      return { outcome: { outcome: "cancelled" } };
    }
    return { outcome: { outcome: "selected", optionId: matched.optionId } };
  }

  /** Handle `elicitation/create` (`mode: "form"`) from `agy acp`. */
  async handleElicitationRequest(
    rawParams: unknown,
    signal: AbortSignal,
  ): Promise<{ action: "accept"; content: Record<string, unknown> } | { action: "decline" } | { action: "cancel" }> {
    const parsed = AcpElicitationFormSchema.safeParse(rawParams);
    if (!parsed.success || !this.deps.ctx.requestUserInput || signal.aborted) {
      return { action: "decline" };
    }

    const { message, requestedSchema } = parsed.data;
    const entries = Object.entries(requestedSchema.properties);
    if (entries.length === 0) return { action: "decline" };

    const fieldMeta: Array<{
      key: string;
      propType: "string" | "boolean" | "array";
      question: AskUserQuestionItem;
      labelToValue: Map<string, string>;
    }> = [];

    for (const [key, prop] of entries) {
      const labelToValue = new Map<string, string>();
      const opts: Array<{ label: string; description?: string }> = [];

      if (prop.type === "boolean") {
        opts.push({ label: "Yes" }, { label: "No" });
        labelToValue.set("Yes", "true");
        labelToValue.set("No", "false");
      } else {
        const oneOf = prop.type === "array" ? prop.items?.anyOf : prop.oneOf;
        const enumVals = prop.type === "array" ? prop.items?.enum : prop.enum;
        if (oneOf) {
          for (const choice of oneOf) {
            const label = choice.title || choice.const;
            opts.push({ label, ...(choice.description ? { description: choice.description } : {}) });
            labelToValue.set(label, choice.const);
          }
        } else if (enumVals) {
          for (const v of enumVals) {
            opts.push({ label: v });
            labelToValue.set(v, v);
          }
        }
      }

      const ownText = [prop.title, prop.description].filter(Boolean);
      const header = prop.title || key;
      const qText =
        ownText.length > 0
          ? ownText.join("\n\n")
          : message || key;

      fieldMeta.push({
        key,
        propType: prop.type,
        question: {
          header,
          question: qText,
          multiSelect: prop.type === "array",
          options: opts,
        },
        labelToValue,
      });
    }

    const decision = await this.deps.ctx.requestUserInput({
      requestId: randomUUID(),
      questions: fieldMeta.map((f) => f.question),
    });
    if (decision.dismissed || signal.aborted) {
      return { action: "cancel" };
    }

    const content: Record<string, unknown> = {};
    for (const meta of fieldMeta) {
      const rawAns = decision.answers[meta.question.question];
      if (rawAns == null) continue;
      if (meta.propType === "boolean") {
        const s = Array.isArray(rawAns) ? rawAns[0] : rawAns;
        content[meta.key] = s === "Yes" || s === "true";
      } else if (meta.propType === "array") {
        const arr = Array.isArray(rawAns) ? rawAns : [rawAns];
        content[meta.key] = arr.map((lbl) => meta.labelToValue.get(lbl) ?? lbl);
      } else {
        const s = Array.isArray(rawAns) ? rawAns[0] : rawAns;
        if (s !== undefined) {
          content[meta.key] = meta.labelToValue.get(s) ?? s;
        }
      }
    }

    return { action: "accept", content };
  }

  /** Freeze snapshots and emit terminal `turn.files` + `turn.done` events. */
  async finalize(reason: TurnDoneReason): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;

    if (this.emittedPlan) {
      this.deps.ctx.emit({
        type: "plan.update",
        sessionId: this.deps.sessionId,
        plan: "",
        phase: "cleared",
      });
    }

    try {
      const files = await this.deps.snapshot.freeze();
      if (files.length > 0) {
        this.deps.ctx.emit({
          type: "turn.files",
          sessionId: this.deps.sessionId,
          files,
        });
      }
    } catch {
      /* snapshot freeze errors must not prevent turn.done */
    }

    this.deps.ctx.emit({
      type: "turn.done",
      sessionId: this.deps.sessionId,
      reason,
    });
  }
}

function extractSecurityWarning(
  options: Array<{ _meta?: Record<string, unknown> }>,
): string | undefined {
  for (const opt of options) {
    const meta = opt._meta?.["agy.security.warning"];
    const rec = asRecord(meta);
    const msg = firstString(rec, ["message", "title"]);
    if (msg) return msg.trim().slice(0, WARNING_MAX_CHARS);
  }
  return undefined;
}

function pickAllowOption(
  options: Array<{ optionId: string; kind?: string }>,
  preferAlways: boolean,
): { outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" } } {
  const preferredKinds = preferAlways ? ["allow_always", "allow_once"] : ["allow_once", "allow_always"];
  for (const kind of preferredKinds) {
    const hit = options.find((o) => o.kind === kind);
    if (hit) return { outcome: { outcome: "selected", optionId: hit.optionId } };
  }
  const fallback = options.find((o) => !o.kind?.startsWith("reject"));
  return fallback
    ? { outcome: { outcome: "selected", optionId: fallback.optionId } }
    : { outcome: { outcome: "cancelled" } };
}

function pickRejectOption(
  options: Array<{ optionId: string; kind?: string }>,
): { outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" } } {
  const hit = options.find((o) => o.kind === "reject_once" || o.kind === "reject_always");
  return hit
    ? { outcome: { outcome: "selected", optionId: hit.optionId } }
    : { outcome: { outcome: "cancelled" } };
}
