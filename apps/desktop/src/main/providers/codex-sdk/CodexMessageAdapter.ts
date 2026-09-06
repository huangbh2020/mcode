/**
 * Codex app-server notification → RuntimeEvent normalization engine.
 *
 * Wire facts calibrated live against codex 0.153.4 (protocol v2):
 *   - `turn/start` RESPONDS IMMEDIATELY with `{turn: {id, status:"inProgress"}}`
 *     — turn completion is notification-driven (`turn/completed` carries the
 *     final Turn with status completed|interrupted|failed).
 *   - Failures arrive as the `error` notification `{error, willRetry}` (an
 *     intermediate error with willRetry=true is followed by an internal
 *     retry — turn.done must NOT fire on it).
 *   - Item payloads are camelCase (`aggregatedOutput` / `exitCode` / …);
 *     statuses are inProgress|completed|failed(declined).
 *   - Reasoning streams via `item/reasoning/textDelta` +
 *     `item/reasoning/summaryTextDelta`; agent messages via
 *     `item/agentMessage/delta`.
 *   - Native plan tracking (`turn/plan/updated` steps) maps onto our
 *     todo.update; PlanThreadItem is codex's todo analogue.
 *   - Token usage arrives on `thread/tokenUsage/updated`
 *     `{tokenUsage: {last, total, modelContextWindow}}` — `last` is the
 *     final request's context size (the honest occupancy read),
 *     `modelContextWindow` the model's real window when known.
 *   - Image items: `imageGeneration` {result(b64), savedPath, revisedPrompt,
 *     status, failure} renders as a synthetic tool card + inline image via
 *     `browser.image`; `imageView` {path} (view_image tool) as a path card.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { RuntimeEvent, TurnDoneReason, ContextUsageEvent } from "@contracts/runtime";
import type { ProviderContext } from "@contracts/provider";
import type { NotificationFrame } from "./CodexAppServerClient.js";
import type { CodexFileSnapshot } from "./CodexFileSnapshot.js";
import { buildCodexTokenSnapshot, type CodexUsage } from "./codexTokenUsage.js";

export class CodexMessageAdapter {
  /** Set when the user interrupts; late notifications are dropped. */
  private aborted = false;
  private turnEnded = false;
  /** Resolved when the turn reaches a terminal state (drives the provider's
   *  done promise — turn/start returns before the turn completes). */
  private turnDoneResolve: ((reason: TurnDoneReason) => void) | null = null;
  /** Terminal error text for the current turn (surfaced once). */
  private lastUsage: CodexUsage | null = null;
  private modelContextWindow: number | null = null;
  /** Occupancy fallback when the server never reports modelContextWindow —
   *  the user-configured per-model context window (or undefined to use the
   *  token-snapshot's static default). */
  private readonly contextWindowFallback: number | undefined;
  /** Per-item thinking message ids (text vs summary channels). */
  private reasoningTextIds = new Map<string, string>();
  private reasoningSummaryIds = new Map<string, string>();
  /** Image items (imageGeneration / imageView) whose synthetic tool-use card
   *  has been emitted — item/started may be skipped for them, so the
   *  completed handler re-checks before emitting image + result. */
  private imageItemsSeen = new Set<string>();

  constructor(
    private readonly ctx: ProviderContext,
    private readonly sessionId: string,
    private readonly snapshots: CodexFileSnapshot,
    contextWindowFallback?: number,
  ) {
    this.contextWindowFallback = contextWindowFallback;
  }

  markAborted(): void {
    this.aborted = true;
  }

  /** Resolves with the turn's end reason when the turn reaches a terminal
   *  state. Never rejects — transport failures surface through the provider's
   *  request-promise rejection instead. */
  waitTurnDone(): Promise<TurnDoneReason> {
    if (this.turnEnded) return Promise.resolve("end_turn");
    return new Promise<TurnDoneReason>((resolve) => {
      this.turnDoneResolve = resolve;
    });
  }

  handleNotification(frame: NotificationFrame): void {
    const p = (frame.params ?? {}) as Record<string, unknown>;
    switch (frame.method) {
      case "item/agentMessage/delta": {
        if (this.aborted) return;
        const delta = p.delta as string | undefined;
        const itemId = p.itemId as string | undefined;
        if (delta && itemId) {
          this.emit({ type: "text.delta", sessionId: this.sessionId, messageId: itemId, text: delta });
        }
        break;
      }
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta": {
        if (this.aborted) return;
        const delta = p.delta as string | undefined;
        const itemId = p.itemId as string | undefined;
        if (!delta || !itemId) return;
        const map = frame.method === "item/reasoning/textDelta" ? this.reasoningTextIds : this.reasoningSummaryIds;
        let messageId = map.get(itemId);
        if (!messageId) {
          messageId = randomUUID();
          map.set(itemId, messageId);
        }
        this.emit({ type: "thinking", sessionId: this.sessionId, messageId, text: delta });
        break;
      }
      case "item/started":
        this.handleItem((p.item as ThreadItem | undefined), false);
        break;
      case "item/completed":
        this.handleItem((p.item as ThreadItem | undefined), true);
        break;
      case "turn/plan/updated": {
        // Native plan steps → our todo card. status: pending|inProgress|completed.
        const steps = p.plan as Array<{ step?: string; status?: string }> | undefined;
        if (Array.isArray(steps)) {
          this.emit({
            type: "todo.update",
            sessionId: this.sessionId,
            todos: steps.map((s) => ({
              content: s.step ?? "",
              status: s.status === "completed" ? "completed" : s.status === "inProgress" ? "in_progress" : "pending",
              priority: "medium" as const,
            })),
          });
        }
        break;
      }
      case "item/plan/delta":
        // Plan text streaming — the structured turn/plan/updated carries the
        // authoritative steps; the raw text stream adds nothing to our UI.
        break;
      case "turn/diff/updated": {
        const diff = p.diff as string | undefined;
        if (typeof diff === "string") this.snapshots.setTurnDiff(diff);
        break;
      }
      case "thread/tokenUsage/updated": {
        const tu = p.tokenUsage as
          | { last?: CodexUsage & { totalTokens?: number }; modelContextWindow?: number | null }
          | undefined;
        if (tu?.last) this.lastUsage = tu.last;
        if (typeof tu?.modelContextWindow === "number" && tu.modelContextWindow > 0) {
          this.modelContextWindow = tu.modelContextWindow;
        }
        break;
      }
      case "error": {
        // {error: {message, ...}, willRetry} — intermediate (retrying) vs
        // terminal. Terminal errors also flip turn/completed.status to
        // "failed", which drives turn.done; here we surface the message.
        const willRetry = p.willRetry === true;
        const err = p.error as { message?: string } | undefined;
        if (!willRetry && err?.message) {
          this.emit({ type: "error", sessionId: this.sessionId, message: err.message, code: "CODEX_TURN_FAILED" });
        } else {
          this.ctx.log.info(`codex: retryable turn error: ${err?.message ?? "unknown"}`);
        }
        break;
      }
      case "warning": {
        const message = p.message as string | undefined;
        if (message) this.ctx.log.warn(`codex: ${message}`);
        break;
      }
      case "turn/completed": {
        const turn = p.turn as { id?: string; status?: string } | undefined;
        const status = turn?.status ?? "completed";
        this.emitTurnEndSnapshot();
        const reason: TurnDoneReason =
          status === "failed" ? "error" : status === "interrupted" ? "interrupted" : "end_turn";
        this.finishTurn(reason);
        break;
      }
      // thread/started, turn/started, thread/status/changed, item/* output
      // deltas (command output streams — the completed item carries the
      // aggregated output), serverRequest/resolved, model/*, account/*, …
      // are silently ignored (forward compatible).
      default:
        break;
    }
  }

  /* ── item handling ── */

  private handleItem(item: ThreadItem | undefined, completed: boolean): void {
    if (!item || this.aborted) return;
    switch (item.type) {
      case "agentMessage":
        if (completed) {
          this.emit({ type: "message.complete", sessionId: this.sessionId, messageId: item.id });
        }
        break;
      case "reasoning":
        // Full-text fallback for transports that skip deltas; completed
        // reasoning items may carry summary[] — join as one block.
        if (completed && Array.isArray(item.summary) && item.summary.length > 0 && !this.reasoningSummaryIds.has(item.id)) {
          const messageId = randomUUID();
          this.reasoningSummaryIds.set(item.id, messageId);
          this.emit({
            type: "thinking",
            sessionId: this.sessionId,
            messageId,
            text: item.summary.filter((s) => typeof s === "string").join("\n"),
          });
        }
        break;
      case "commandExecution":
        if (!completed) {
          this.emitToolUse(item.id, "Bash", { command: item.command ?? "", ...(item.cwd ? { cwd: item.cwd } : {}) });
        } else {
          const failed = item.status === "failed" || (typeof item.exitCode === "number" && item.exitCode !== 0);
          this.emit({
            type: "tool.result",
            sessionId: this.sessionId,
            toolCallId: item.id,
            isError: failed,
            content: item.aggregatedOutput ?? "",
          });
        }
        break;
      case "mcpToolCall":
        if (!completed) {
          this.emitToolUse(item.id, `mcp__${item.server ?? "unknown"}__${item.tool ?? "unknown"}`, {});
        } else {
          this.emit({
            type: "tool.result",
            sessionId: this.sessionId,
            toolCallId: item.id,
            isError: item.status === "failed" || item.error != null,
            content: item.error != null
              ? stringifyResult(item.error)
              : stringifyResult(item.result),
          });
        }
        break;
      case "webSearch":
        if (!completed) {
          this.emitToolUse(item.id, "WebSearch", { query: item.query ?? "" });
        } else {
          this.emit({
            type: "tool.result",
            sessionId: this.sessionId,
            toolCallId: item.id,
            isError: false,
            content: item.query ?? "",
          });
        }
        break;
      case "fileChange":
        if (!completed) {
          this.emitToolUse(item.id, "file_change", {
            changes: (item.changes ?? []).map((c) => ({ path: c.path, kind: changeKind(c.kind) })),
          });
        } else {
          this.emit({
            type: "tool.result",
            sessionId: this.sessionId,
            toolCallId: item.id,
            isError: item.status === "failed" || item.status === "declined",
            content: (item.changes ?? []).map((c) => ({ path: c.path, kind: changeKind(c.kind) })),
          });
        }
        break;
      case "imageGeneration":
        this.handleImageGeneration(item, completed);
        break;
      case "imageView":
        // Model viewed a local image (codex view_image tool). Lightweight
        // card with the path only — viewed ≠ generated, and the same file
        // may already be visible elsewhere in the conversation.
        if (!completed) {
          this.imageItemsSeen.add(item.id);
          this.emitToolUse(item.id, "view_image", { path: item.path ?? "" });
        } else {
          this.ensureImageCard(item.id, "view_image", { path: item.path ?? "" });
          this.emit({
            type: "tool.result",
            sessionId: this.sessionId,
            toolCallId: item.id,
            isError: false,
            content: item.path ?? "",
          });
        }
        break;
      case "dynamicToolCall":
        // Mcode's host-side tools (ask_user_question / plan / browser_*).
        // Rendered as a regular tool card so dynamic tool usage is visible
        // and auditable like Claude/Pi tool calls — and so the inline-image
        // path has a card to attach to (browser_screenshot's browser.image
        // event is keyed by callId; the card from item/started covers the
        // item.id spelling, the store dedupes when both coincide).
        if (!completed) {
          this.emitToolUse(item.id, item.tool ?? "dynamic_tool", item.arguments ?? {});
        } else {
          this.emitDynamicToolResult(item);
        }
        break;
      case "plan":
        if (completed && typeof item.text === "string" && item.text.trim()) {
          // PlanThreadItem fallback when turn/plan/updated never fired.
          this.emit({
            type: "todo.update",
            sessionId: this.sessionId,
            todos: parsePlanTextTodos(item.text),
          });
        }
        break;
      case "error":
        this.emit({
          type: "error",
          sessionId: this.sessionId,
          message: (item as { message?: string }).message ?? "codex item error",
          code: "CODEX_ITEM_ERROR",
        });
        break;
      // userMessage (input echo),collab_agent_tool_call, sub_agent_activity,
      // sleep, review markers, context_compaction — ignored.
      default:
        break;
    }
  }

  /** Codex-native image generation (schema-calibrated 0.153.4): item shape is
   *  {result: string, status, revisedPrompt?, savedPath?, failure?}. The
   *  generated image is attached inline via the shared `browser.image` path
   *  (store splices it right after the synthetic tool-use card); the card's
   *  result text carries the revised prompt / failure. Reads are synchronous
   *  to keep emission order intact inside the notification pump. */
  private handleImageGeneration(
    item: Extract<ThreadItem, { type: "imageGeneration" }>,
    completed: boolean,
  ): void {
    if (!completed) {
      this.imageItemsSeen.add(item.id);
      this.emitToolUse(item.id, "image_generation", item.revisedPrompt ? { revisedPrompt: item.revisedPrompt } : {});
      return;
    }
    this.ensureImageCard(item.id, "image_generation", item.revisedPrompt ? { revisedPrompt: item.revisedPrompt } : {});
    const failure = item.failure;
    if (failure) {
      this.emit({
        type: "tool.result",
        sessionId: this.sessionId,
        toolCallId: item.id,
        isError: true,
        content:
          failure.type === "usageLimitExceeded"
            ? `image generation usage limit exceeded (limit ${failure.limitId ?? "unknown"})`
            : `image generation failed (${failure.type ?? item.status ?? "unknown"})`,
      });
      return;
    }
    const img = resolveGeneratedImage(item);
    if (img) {
      this.emit({
        type: "browser.image",
        sessionId: this.sessionId,
        toolCallId: item.id,
        data: img.data,
        mimeType: img.mimeType,
      });
    }
    this.emit({
      type: "tool.result",
      sessionId: this.sessionId,
      toolCallId: item.id,
      isError: !img,
      content:
        item.revisedPrompt ??
        (img ? item.status ?? "" : typeof item.result === "string" && item.result.length <= 200 ? item.result : item.status ?? ""),
    });
  }

  /** Emit the synthetic tool-use card for an image item if `item/started`
   *  never carried it (the card must exist before image/result can attach). */
  private ensureImageCard(id: string, toolName: string, input: unknown): void {
    if (this.imageItemsSeen.has(id)) return;
    this.imageItemsSeen.add(id);
    this.emitToolUse(id, toolName, input);
  }

  /** dynamicToolCall completed → tool.result. Text contentItems join into
   *  the result text; inputImage contentItems (e.g. browser_screenshot's
   *  round-tripped image) emit as `browser.image` keyed by the item id so
   *  the store splices them inline under this card. */
  private emitDynamicToolResult(
    item: Extract<ThreadItem, { type: "dynamicToolCall" }>,
  ): void {
    const items = Array.isArray(item.contentItems) ? item.contentItems : [];
    const texts: string[] = [];
    for (const ci of items) {
      const obj = (ci ?? {}) as { type?: string; text?: unknown; imageUrl?: unknown };
      if (obj.type === "inputImage" && typeof obj.imageUrl === "string") {
        const img = parseDataUrlImage(obj.imageUrl);
        if (img) {
          this.emit({
            type: "browser.image",
            sessionId: this.sessionId,
            toolCallId: item.id,
            data: img.data,
            mimeType: img.mimeType,
          });
        }
      } else if (typeof obj.text === "string") {
        texts.push(obj.text);
      }
    }
    this.emit({
      type: "tool.result",
      sessionId: this.sessionId,
      toolCallId: item.id,
      isError: item.success === false || item.status === "failed",
      content: texts.join("\n"),
    });
  }

  private emitToolUse(toolCallId: string, toolName: string, input: unknown): void {
    this.emit({
      type: "tool.use",
      sessionId: this.sessionId,
      toolCallId,
      toolName,
      input,
      requiresApproval: false,
    });
  }

  /* ── turn lifecycle ── */

  private finishTurn(reason: TurnDoneReason): void {
    if (this.turnEnded) return;
    this.turnEnded = true;
    this.emit({ type: "turn.done", sessionId: this.sessionId, reason });
    this.turnDoneResolve?.(reason);
    this.turnDoneResolve = null;
  }

  /** Transport-level abort finalization (process died / user interrupted
   *  before turn/completed). Emits turn.done exactly once. */
  finalizeAborted(): void {
    this.finishTurn("interrupted");
  }

  finalizeError(): void {
    this.finishTurn("error");
  }

  /** End-of-turn finalization (the Claude/Pi flushFinal analogue): freeze
   *  the diff-fed file snapshot and emit `turn.files`. Called by the
   *  provider on success, abort, AND error — writes that already landed
   *  must always surface on the card. */
  async flushFinal(): Promise<void> {
    const files = await this.snapshots.freeze();
    if (files.length > 0) {
      this.emit({ type: "turn.files", sessionId: this.sessionId, files });
    }
  }

  get hasTurnEnded(): boolean {
    return this.turnEnded;
  }

  private emitTurnEndSnapshot(): void {
    const snapshot = buildCodexTokenSnapshot(
      this.lastUsage,
      this.modelContextWindow ?? this.contextWindowFallback,
    );
    if (!snapshot) return;
    this.emit({ type: "token-usage.updated", sessionId: this.sessionId, snapshot });
  }

  private emit(e: RuntimeEvent): void {
    this.ctx.emit(e);
  }
}

/** "Plan text" (markdown checkbox lines) → todo rows (PlanThreadItem path). */
function parsePlanTextTodos(text: string): Array<{ content: string; status: "pending" | "in_progress" | "completed"; priority: "medium" }> {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[-*]\s*\[.\]/.test(l) || /^[-*]\s/.test(l))
    .map((l) => {
      const checked = /\[x\]/i.test(l);
      const content = l.replace(/^[-*]\s*\[.\]\s*/, "").replace(/^[-*]\s*/, "");
      return { content, status: checked ? ("completed" as const) : ("pending" as const), priority: "medium" as const };
    });
}

/** MCP tool result/error → display text. Objects/arrays stringify (a raw
 *  String() would render "[object Object]"); strings and primitives pass
 *  through; null/undefined collapse to "". */
function stringifyResult(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") {
    try {
      return JSON.stringify(v, null, 2);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

/** PatchChangeKind tagged-union → simple string for the card input. */
function changeKind(kind: unknown): string {
  if (kind && typeof kind === "object") {
    const t = (kind as Record<string, unknown>).type;
    if (typeof t === "string") return t;
  }
  return typeof kind === "string" ? kind : "update";
}

const IMAGE_MIME_BY_EXT: Record<string, "image/png" | "image/jpeg" | "image/webp" | "image/gif"> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/** data URL (data:image/png;base64,...) → inline image payload, or null when
 *  the URL isn't a base64 image data URL we can render. */
function parseDataUrlImage(
  url: string,
): { data: string; mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif" } | null {
  const m = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(url.trim());
  if (!m) return null;
  return { mimeType: `image/${m[1]}` as "image/png" | "image/jpeg" | "image/webp" | "image/gif", data: m[2].replace(/[\r\n]/g, "") };
}

/** Result strings below this length are treated as status text, not image
 *  data — real base64 payloads are kilobytes at minimum. */
const BASE64_MIN_LENGTH = 1024;

/** imageGeneration item → inline image (base64 + mime). Prefers savedPath
 *  (exact bytes + true mime); falls back to the `result` string when it
 *  looks like base64 image data. Returns null when neither yields an image
 *  (the card then surfaces the status text as a failed result). */
function resolveGeneratedImage(
  item: Extract<ThreadItem, { type: "imageGeneration" }>,
): { data: string; mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif" } | null {
  if (item.savedPath) {
    try {
      const data = readFileSync(item.savedPath);
      const ext = item.savedPath.slice(item.savedPath.lastIndexOf(".")).toLowerCase();
      return { data: data.toString("base64"), mimeType: IMAGE_MIME_BY_EXT[ext] ?? "image/png" };
    } catch {
      // savedPath unreadable (deleted between generation and display) —
      // fall through to the result-string heuristic.
    }
  }
  const result = item.result;
  if (typeof result === "string" && result.length >= BASE64_MIN_LENGTH && /^[A-Za-z0-9+/=\r\n]+$/.test(result)) {
    return { data: result.replace(/[\r\n]/g, ""), mimeType: "image/png" };
  }
  return null;
}

/* ── app-server payload shapes (calibrated against 0.153.4 live + schema) ── */

type ThreadItem =
  | { type: "agentMessage"; id: string; text?: string }
  | { type: "reasoning"; id: string; content?: unknown[]; summary?: unknown[] }
  | { type: "commandExecution"; id: string; command?: string; aggregatedOutput?: string | null; exitCode?: number | null; status?: string; cwd?: string | null }
  | { type: "fileChange"; id: string; changes?: Array<{ path: string; kind?: unknown; diff?: string }>; status?: string }
  | { type: "mcpToolCall"; id: string; server?: string; tool?: string; result?: unknown; error?: unknown; status?: string }
  | { type: "webSearch"; id: string; query?: string }
  | { type: "plan"; id: string; text?: string }
  | { type: "userMessage"; id: string }
  | { type: "error"; id: string; message?: string }
  | {
      type: "dynamicToolCall";
      id: string;
      tool?: string;
      namespace?: string | null;
      status?: string;
      success?: boolean | null;
      arguments?: unknown;
      /** Response contentItems echoed back by the server — inputText for
       *  text results, inputImage (data URL) for e.g. browser_screenshot. */
      contentItems?: Array<{ type?: string; text?: unknown; imageUrl?: unknown } | unknown> | null;
    }
  | {
      type: "imageGeneration";
      id: string;
      /** Base64 image data per the schema — used as fallback when savedPath
       *  is absent (OpenAI image_generation_call carries b64 here). */
      result?: string;
      status?: string;
      revisedPrompt?: string | null;
      savedPath?: string | null;
      failure?: { type?: string; limitId?: string; resetsAt?: number | null } | null;
    }
  | { type: "imageView"; id: string; path?: string };

export const newCodexRequestId = randomUUID;
