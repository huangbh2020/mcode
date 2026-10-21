/**
 * OpenCode (v2) message adapter — global-bus events → RuntimeEvent.
 *
 * ## Wire contract (verified LIVE against CLI 2.1.1 — SDK 1.19.3's v2 event
 * types are STALE; names/fields below come from probe-turn-full.ts runs):
 *
 *   session.text.delta      data {sessionID, assistantMessageID, ordinal, delta}
 *   session.reasoning.delta data {sessionID, assistantMessageID, delta}
 *   session.tool.called     data {sessionID, assistantMessageID, id: "call_…",
 *                            input, executed} — ⚠️ NO tool-name field; the
 *                            name is learned from permission.asked's action
 *                            (shell→bash…) or an input-shape heuristic.
 *   session.tool.progress   data {…, content?} — live output chunks (bash).
 *   session.tool.success    data {…, id, content: [{type:"text",text}],
 *                            metadata: {status, truncated, exit}}
 *   session.tool.failed     data {…, id, error}
 *   session.step.ended      data {…, assistantMessageID, finish, cost,
 *                            tokens{input,output,reasoning,cache{read,write}},
 *                            snapshot, files}
 *   session.usage.updated   data {sessionID, cost, tokens{…}} — cumulative
 *                            session totals; the authoritative usage source.
 *   session.execution.succeeded / .failed / .interrupted — TURN END signal
 *                            (session.idle is kept as a secondary fallback).
 *   session.created         data {sessionID, info: {parentID?}} — subagent
 *                            children join the roster via parentID.
 *   permission.asked / .replied — routed to the ask bridge by the provider.
 *
 * The bus is the server's GLOBAL stream; we filter to this turn's session
 * family (main session + subagent children). The server is private to Mcode,
 * so no foreign session can appear.
 */
import type { V2Event } from "@opencode-ai/sdk/v2/types";
import type { ProviderContext } from "@contracts/provider";
import type {
  RuntimeEvent,
  ContextSnapshot,
  ContextWarning,
  ContextWarningKind,
  SubagentSnapshot,
  SubagentTranscriptBlock,
  BashTaskSnapshot,
  TurnDoneReason,
} from "@contracts/runtime";
import type { FileSnapshot } from "@main/lib/fileSnapshot.js";

const NEAR_WINDOW_RATIO = 0.8;

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function warningFromPct(pct: number): ContextWarning {
  return pct >= 90 ? "critical" : pct >= 70 ? "near-window" : "ok";
}

function warningsFromPct(pct: number): ContextWarningKind[] {
  return pct >= NEAR_WINDOW_RATIO * 100 ? ["near-window"] : [];
}

export interface OpenCodeTokens {
  input: number;
  output: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}

/** Build a display-ready snapshot.
 *
 *  - `stepTokens`: Instantaneous token report from the latest step (session.step.ended).
 *    Occupancy `usedTokens` follows: step.input + step.cache.write + step.cache.read clamped to maxTokens.
 *  - `cumulativeTokens`: Cumulative session totals from session.usage.updated.
 *    Provides `totalProcessedTokens` (throughput / billing) and output/cost.
 */
export function buildOpenCodeTokenSnapshot(
  stepTokens: OpenCodeTokens | undefined,
  cumulativeTokens: OpenCodeTokens | undefined,
  cost: number,
  maxTokens: number,
  model?: string,
): ContextSnapshot {
  // 1. Instantaneous window occupancy (from latest step.ended)
  // Fall back to cumulative tokens if no step report has arrived yet (e.g. at initial startup)
  const occupancyTokens = stepTokens ?? cumulativeTokens;
  const stepCacheRead = occupancyTokens?.cache?.read ?? 0;
  const stepCacheWrite = occupancyTokens?.cache?.write ?? 0;
  const stepInput = occupancyTokens?.input ?? 0;
  const usedRaw = stepInput + stepCacheWrite + stepCacheRead;
  const usedTokens = Math.min(usedRaw, maxTokens);
  const pct = round1(maxTokens > 0 ? Math.min(100, (usedTokens / maxTokens) * 100) : 0);

  // 2. Cumulative throughput / billing
  const cum = cumulativeTokens ?? stepTokens;
  const cumCacheRead = cum?.cache?.read ?? 0;
  const cumCacheWrite = cum?.cache?.write ?? 0;
  const cumInput = cum?.input ?? 0;
  const cumOutput = cum?.output ?? 0;
  const totalProcessedTokens = cumInput + cumOutput + cumCacheRead + cumCacheWrite;

  return {
    usedTokens,
    totalProcessedTokens,
    maxTokens,
    outputTokens: cumOutput,
    cacheReadTokens: stepCacheRead,
    cacheCreationTokens: stepCacheWrite,
    costUsd: cost > 0 ? cost : undefined,
    model,
    pct,
    warning: warningFromPct(pct),
    warnings: warningsFromPct(pct),
  };
}

function normalizeToolName(name: string): string {
  if (name.startsWith("mcp__")) return name;
  const lower = name.toLowerCase();
  if (lower === "shell") return "bash";
  if (lower === "subagent") return "task";
  return lower;
}

/** Best-effort tool-name guess for tool.called events (which carry no name
 *  on 2.1.1): permission asks teach the real name (action shell→bash);
 *  otherwise fall back to an input-shape heuristic. */
export function guessToolName(input: unknown): string {
  if (input != null && typeof input === "object") {
    const rec = input as Record<string, unknown>;
    // 1. Bash / Shell command execution
    if (typeof rec["command"] === "string") return "bash";
    // 2. Web search & fetch
    if (typeof rec["url"] === "string") return "webfetch";
    if (
      typeof rec["query"] === "string" &&
      typeof rec["path"] !== "string" &&
      typeof rec["filePath"] !== "string" &&
      typeof rec["file_path"] !== "string"
    ) {
      return "websearch";
    }
    // 3. Grep & Glob patterns (must precede pure path inspection so grep with path doesn't fall through)
    if (typeof rec["glob"] === "string") return "glob";
    if (typeof rec["pattern"] === "string" || typeof rec["regex"] === "string") return "grep";
    // 4. Directory listing
    if (typeof rec["dir"] === "string" || typeof rec["directory"] === "string") return "ls";
    // 5. File mutations vs. read
    if (typeof rec["path"] === "string" || typeof rec["filePath"] === "string" || typeof rec["file_path"] === "string") {
      // Edit: partial string replacements or patch diffs
      if (
        rec["oldString"] != null ||
        rec["old_string"] != null ||
        rec["newString"] != null ||
        rec["new_string"] != null ||
        rec["edits"] != null ||
        rec["patch"] != null
      ) {
        return "edit";
      }
      // Write: whole-file content payload (supports empty string content as well)
      if (
        typeof rec["content"] === "string" ||
        typeof rec["contents"] === "string" ||
        typeof rec["file_text"] === "string" ||
        typeof rec["text"] === "string"
      ) {
        return "write";
      }
      // Read: path specified without mutation content (e.g. { path }, { path, offset, limit })
      return "read";
    }
    // 6. Subagent / Task
    if (typeof rec["prompt"] === "string" || typeof rec["task"] === "string") return "task";
    // 7. Todo
    if (rec["todos"] != null) return "TodoWrite";
  }
  return "tool";
}

export interface OpencodeAdapterDeps {
  ctx: ProviderContext;
  /** Mcode session id (every RuntimeEvent carries it). */
  sessionId: string;
  /** The opencode session id this adapter renders. */
  opencodeSessionId: string;
  /** Project working directory for path resolution / pre-mutation snapshots. */
  cwd?: string;
  /** Context-window ceiling for the usage ring (model-list value). */
  contextWindow?: number;
  /** Active model id ("providerID/modelId") for snapshots. */
  model?: string;
  /** Rewind snapshot — freeze()d at turn end into turn.files. */
  snapshot: FileSnapshot;
}

interface ChildSessionState {
  sessionID: string;
  toolUseId?: string;
  description?: string;
  subagentType?: string;
  status: "running" | "completed" | "failed";
  blocks: SubagentTranscriptBlock[];
}

interface PendingTaskCall {
  callID: string;
  description: string;
  subagentType?: string;
}

function extractToolFilePath(input: unknown): string | null {
  if (input != null && typeof input === "object") {
    const rec = input as Record<string, unknown>;
    if (typeof rec["path"] === "string") return rec["path"];
    if (typeof rec["filePath"] === "string") return rec["filePath"];
    if (typeof rec["file_path"] === "string") return rec["file_path"];
  }
  return null;
}

export class OpencodeMessageAdapter {
  private readonly deps: OpencodeAdapterDeps;
  /** Child subagent sessions (roster + transcript source). */
  private readonly children = new Map<string, ChildSessionState>();
  /** Queue of pending Task tool calls waiting to associate with child sessions. */
  private readonly pendingTaskCalls: PendingTaskCall[] = [];
  /** callID → tool name (learned from permission asks / input heuristic). */
  private readonly toolNames = new Map<string, string>();
  /** callID → tool input (guards/approvals + rendering). */
  private readonly toolInputs = new Map<string, unknown>();
  /** Bash-tool roster (REPLACE semantics on flush). */
  private readonly bashTasks = new Map<string, BashTaskSnapshot>();
  /** Open assistant messages (assistantMessageID) — sealed by step.ended. */
  private readonly openMessages = new Set<string>();
  /** Last step's token report (instantaneous context-window occupancy). */
  private lastStepTokens?: OpenCodeTokens;
  /** Cumulative session tokens (total processed throughput). */
  private cumulativeTokens?: OpenCodeTokens;
  private cumulativeCost = 0;
  private turnEnded = false;
  private sawActivity = false;
  private turnDoneResolve: ((reason: TurnDoneReason) => void) | null = null;
  private readonly turnDonePromise: Promise<TurnDoneReason>;

  constructor(deps: OpencodeAdapterDeps) {
    this.deps = deps;
    this.turnDonePromise = new Promise<TurnDoneReason>((resolve) => {
      this.turnDoneResolve = resolve;
    });
  }

  get hasTurnEnded(): boolean {
    return this.turnEnded;
  }

  /** Resolves when the turn ends (execution terminal / idle / finalize). */
  waitTurnDone(): Promise<TurnDoneReason> {
    return this.turnDonePromise;
  }

  /** callID lookups for the permission bridge (input enrichment + the
   *  name it learns from asks). */
  getToolCall(callID: string): { tool: string; input: unknown } | undefined {
    return { tool: this.toolNames.get(callID) ?? "tool", input: this.toolInputs.get(callID) };
  }

  /** Teach the adapter a callID's real tool name (from permission asks). */
  noteToolName(callID: string, toolName: string): void {
    this.toolNames.set(callID, toolName);
  }

  private publishTokenSnapshot(): void {
    const maxTokens =
      this.deps.contextWindow && this.deps.contextWindow > 0 ? this.deps.contextWindow : 200_000;
    const snapshot = buildOpenCodeTokenSnapshot(
      this.lastStepTokens,
      this.cumulativeTokens,
      this.cumulativeCost,
      maxTokens,
      this.deps.model,
    );
    this.emit({
      type: "token-usage.updated",
      sessionId: this.deps.sessionId,
      snapshot,
    });
  }

  /** The provider routes global-bus events here. Unknown event types are
   *  ignored (forward compatibility — the 2.1.x bus is chatty by design and
   *  its vocabulary already drifted once between SDK releases). */
  dispatch(ev: V2Event): void {
    try {
      this.handle(ev);
    } catch (err) {
      this.deps.ctx.log.error(`opencode adapter: ${ev.type} failed: ${(err as Error).message}`);
    }
  }

  private sessionIDOf(ev: V2Event): string | undefined {
    return (ev as { data?: { sessionID?: string } }).data?.sessionID;
  }

  private ensureChildSession(sessionID: string, parentID?: string): ChildSessionState | null {
    if (sessionID === this.deps.opencodeSessionId) return null;
    if (parentID && parentID !== this.deps.opencodeSessionId) return null;
    const existing = this.children.get(sessionID);
    if (existing) return existing;
    const task = this.pendingTaskCalls.shift();
    const child: ChildSessionState = {
      sessionID,
      toolUseId: task?.callID,
      description: task?.description ?? `opencode subagent ${sessionID.slice(0, 8)}`,
      subagentType: task?.subagentType,
      status: "running",
      blocks: [],
    };
    this.children.set(sessionID, child);
    this.emitRoster();
    return child;
  }

  private handle(ev: V2Event): void {
    const e = ev as unknown as { type: string; data?: Record<string, unknown>; properties?: Record<string, unknown> };
    const data = (e.data ?? e.properties ?? {}) as Record<string, unknown>;
    switch (e.type) {
      /* ── session lifecycle / roster ── */
      case "session.created": {
        const rawSid = data["sessionID"] ?? data["id"] ?? e.properties?.sessionID ?? (e.properties?.info as Record<string, unknown> | undefined)?.id;
        const sid = typeof rawSid === "string" ? rawSid : undefined;
        const rawInfo = (data["info"] ?? data ?? e.properties?.info) as Record<string, unknown> | undefined;
        const parentID = (typeof rawInfo?.parentID === "string" ? rawInfo.parentID : undefined) ??
          (typeof e.properties?.parentID === "string" ? (e.properties.parentID as string) : undefined);
        if (sid && sid !== this.deps.opencodeSessionId) {
          if (!parentID || parentID === this.deps.opencodeSessionId) {
            this.ensureChildSession(sid, parentID);
          }
        }
        return;
      }
      case "session.execution.started": {
        const sid = this.sessionIDOf(ev);
        if (sid === this.deps.opencodeSessionId) this.sawActivity = true;
        return;
      }
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted": {
        const sid = this.sessionIDOf(ev);
        if (sid === this.deps.opencodeSessionId) {
          if (e.type === "session.execution.succeeded") this.finalizeTurn("end_turn");
          else if (e.type === "session.execution.interrupted") this.finalizeTurn("interrupted");
          else {
            const message =
              (data["error"] as { message?: string } | undefined)?.message ?? "OpenCode 回合执行失败";
            this.emit({
              type: "error",
              sessionId: this.deps.sessionId,
              message,
              code: "OPENCODE_EXECUTION_FAILED",
            });
            this.finalizeTurn("error");
          }
        } else if (sid != null && this.children.has(sid)) {
          this.markChildDone(sid, e.type.endsWith("succeeded") ? "completed" : "failed");
        }
        return;
      }
      case "session.idle": {
        // Secondary fallback — execution.* is the primary terminal signal
        // (verified live); idle alone only ends the turn after activity.
        const sid = this.sessionIDOf(ev);
        if (sid === this.deps.opencodeSessionId) {
          if (this.sawActivity) this.finalizeTurn("end_turn");
        } else if (sid != null && this.children.has(sid)) {
          this.markChildDone(sid, "completed");
        }
        return;
      }
      case "session.error": {
        if (!this.isMain(ev)) return;
        const message =
          (data["error"] as { message?: string } | undefined)?.message ?? "OpenCode 会话错误";
        this.emit({ type: "error", sessionId: this.deps.sessionId, message, code: "OPENCODE_SESSION_ERROR" });
        this.finalizeTurn("error");
        return;
      }
      case "session.usage.updated": {
        if (!this.isMain(ev)) return;
        const tokens = data["tokens"] as OpenCodeTokens | undefined;
        if (!tokens) return;
        this.cumulativeTokens = tokens;
        this.cumulativeCost = (data["cost"] as number) ?? 0;
        this.publishTokenSnapshot();
        return;
      }
      case "session.compaction.ended": {
        if (!this.isMain(ev)) return;
        this.emit({
          type: "compact.result",
          sessionId: this.deps.sessionId,
          trigger: "auto",
          preTokens: ((data["tokens"] as { input?: number } | undefined)?.input ?? 0),
        });
        return;
      }
      /* ── streaming (main session renders; children feed transcripts) ── */
      case "session.text.delta": {
        this.sawActivity = true;
        const sessionID = data["sessionID"] as string;
        const assistantMessageID = data["assistantMessageID"] as string;
        const delta = data["delta"] as string;
        if (sessionID === this.deps.opencodeSessionId) {
          this.openMessages.add(assistantMessageID);
          this.emit({ type: "text.delta", sessionId: this.deps.sessionId, messageId: assistantMessageID, text: delta });
        } else {
          this.ensureChildSession(sessionID);
          this.appendChildText(sessionID, "text", delta);
        }
        return;
      }
      case "session.reasoning.delta": {
        this.sawActivity = true;
        const sessionID = data["sessionID"] as string;
        const assistantMessageID = data["assistantMessageID"] as string;
        const delta = data["delta"] as string;
        if (sessionID === this.deps.opencodeSessionId) {
          this.emit({ type: "thinking", sessionId: this.deps.sessionId, messageId: assistantMessageID, text: delta });
        } else {
          this.ensureChildSession(sessionID);
          this.appendChildText(sessionID, "thinking", delta);
        }
        return;
      }
      case "session.tool.called": {
        this.sawActivity = true;
        const sessionID = data["sessionID"] as string;
        const assistantMessageID = data["assistantMessageID"] as string;
        const callID = (data["id"] ?? data["callID"]) as string;
        const input = data["input"];
        const explicitTool =
          (typeof data["tool"] === "string" && data["tool"].trim()) ||
          (typeof data["toolName"] === "string" && data["toolName"].trim()) ||
          (typeof data["name"] === "string" && data["name"].trim()) ||
          undefined;
        const rawToolName = explicitTool ?? this.toolNames.get(callID) ?? guessToolName(input);
        const toolName = normalizeToolName(rawToolName);
        this.toolNames.set(callID, toolName);
        this.toolInputs.set(callID, input);
        if (sessionID === this.deps.opencodeSessionId) {
          this.openMessages.add(assistantMessageID);
          this.emit({
            type: "tool.use",
            sessionId: this.deps.sessionId,
            toolCallId: callID,
            toolName,
            input,
            requiresApproval: false,
            messageId: assistantMessageID,
          });
          const lowerName = toolName.toLowerCase();
          if (lowerName === "bash" || lowerName === "shell") {
            const command = (input as { command?: unknown } | undefined)?.command;
            this.bashTasks.set(callID, {
              taskId: callID,
              toolUseId: callID,
              description: typeof command === "string" ? command : `bash (${callID})`,
              status: "running",
              startedAt: Date.now(),
            });
            this.emitBashTasks();
          }
          if (lowerName === "edit" || lowerName === "write") {
            const fp = extractToolFilePath(input);
            if (fp) {
              void this.deps.snapshot.recordPre(this.deps.cwd ?? process.cwd(), fp);
            }
          }
          if (lowerName === "task" || lowerName === "subagent") {
            const rec = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
            const desc =
              typeof rec["description"] === "string"
                ? rec["description"]
                : typeof rec["prompt"] === "string"
                ? rec["prompt"].slice(0, 80)
                : `task (${callID})`;
            const subType =
              typeof rec["subagent_type"] === "string"
                ? rec["subagent_type"]
                : typeof rec["agent"] === "string"
                ? rec["agent"]
                : undefined;
            this.pendingTaskCalls.push({ callID, description: desc, subagentType: subType });
          }
        } else {
          this.ensureChildSession(sessionID);
          this.appendChildTool(sessionID, callID, toolName, input);
        }
        return;
      }
      case "session.tool.progress": {
        // Live output chunks (observed on bash runs). Defensive: only the
        // content's text parts feed the bash roster's rolling output.
        const sessionID = data["sessionID"] as string;
        const callID = (data["id"] ?? data["callID"]) as string;
        if (sessionID !== this.deps.opencodeSessionId) return;
        const task = this.bashTasks.get(callID);
        if (!task) return;
        const text = toolContentText(data["content"] ?? data["structured"]);
        if (text) {
          this.bashTasks.set(callID, {
            ...task,
            output: `${task.output ?? ""}${text}`.slice(-64 * 1024),
          });
          this.emitBashTasks();
        }
        return;
      }
      case "session.tool.success": {
        const sessionID = data["sessionID"] as string;
        const callID = (data["id"] ?? data["callID"]) as string;
        const content = data["content"];
        if (sessionID === this.deps.opencodeSessionId) {
          this.emit({
            type: "tool.result",
            sessionId: this.deps.sessionId,
            toolCallId: callID,
            isError: false,
            content,
          });
          const task = this.bashTasks.get(callID);
          if (task) {
            this.bashTasks.set(callID, {
              ...task,
              status: "completed",
              endedAt: Date.now(),
              ...(toolContentText(content) ? { output: toolContentText(content)!.slice(-64 * 1024) } : {}),
            });
            this.emitBashTasks();
          }
          for (const [sid, child] of this.children) {
            if (child.toolUseId === callID && child.status === "running") {
              this.markChildDone(sid, "completed");
            }
          }
        } else {
          this.settleChildTool(sessionID, callID, "done", content);
        }
        return;
      }
      case "session.tool.failed": {
        const sessionID = data["sessionID"] as string;
        const callID = (data["id"] ?? data["callID"]) as string;
        const message =
          (data["error"] as { message?: string } | undefined)?.message ??
          (typeof data["error"] === "string" ? data["error"] : "tool failed");
        if (sessionID === this.deps.opencodeSessionId) {
          this.emit({
            type: "tool.result",
            sessionId: this.deps.sessionId,
            toolCallId: callID,
            isError: true,
            content: message,
          });
          const task = this.bashTasks.get(callID);
          if (task) {
            this.bashTasks.set(callID, { ...task, status: "failed", endedAt: Date.now(), error: message });
            this.emitBashTasks();
          }
          for (const [sid, child] of this.children) {
            if (child.toolUseId === callID && child.status === "running") {
              this.markChildDone(sid, "failed");
            }
          }
        } else {
          this.settleChildTool(sessionID, callID, "error", message);
        }
        return;
      }
      case "session.step.ended": {
        const sessionID = data["sessionID"] as string;
        const assistantMessageID = data["assistantMessageID"] as string;
        if (sessionID !== this.deps.opencodeSessionId) return;
        this.openMessages.delete(assistantMessageID);
        this.emit({ type: "message.complete", sessionId: this.deps.sessionId, messageId: assistantMessageID });
        // Tokens on session.step.ended represent the instantaneous context window occupancy for this step.
        const tokens = data["tokens"] as OpenCodeTokens | undefined;
        if (tokens) {
          this.lastStepTokens = tokens;
          if (typeof data["cost"] === "number" && data["cost"] > this.cumulativeCost) {
            this.cumulativeCost = data["cost"];
          }
          this.publishTokenSnapshot();
        }
        return;
      }
      case "session.step.failed": {
        if (!this.isMain(ev)) return;
        const message =
          (data["error"] as { message?: string } | undefined)?.message ?? "OpenCode step failed";
        this.emit({ type: "error", sessionId: this.deps.sessionId, message, code: "OPENCODE_STEP_FAILED" });
        return;
      }
      case "permission.asked":
      case "permission.replied":
        // Handled by the provider's ask bridge (it owns the reply path);
        // asks are also a turn-activity signal.
        if (this.isMain(ev)) this.sawActivity = true;
        return;
      default:
        // Unknown/irrelevant (installation, pty, lsp, *.updated meta, …).
        return;
    }
  }

  private isMain(ev: V2Event): boolean {
    return this.sessionIDOf(ev) === this.deps.opencodeSessionId;
  }

  /* ── child (subagent) transcript helpers ── */

  private appendChildText(sessionID: string, kind: "text" | "thinking", delta: string): void {
    const child = this.children.get(sessionID);
    if (!child) return;
    const last = child.blocks[child.blocks.length - 1];
    if (last && last.kind === kind) {
      child.blocks[child.blocks.length - 1] = { kind, text: (last.text ?? "") + delta };
    } else {
      child.blocks.push({ kind, text: delta });
    }
    this.emitTranscript(sessionID);
  }

  private appendChildTool(sessionID: string, callID: string, tool: string, input: unknown): void {
    const child = this.children.get(sessionID);
    if (!child) return;
    child.blocks.push({ kind: "tool_use", toolCallId: callID, toolName: tool, input, status: "running" });
    this.emitTranscript(sessionID);
  }

  private settleChildTool(sessionID: string, callID: string, status: "done" | "error", result: unknown): void {
    const child = this.children.get(sessionID);
    if (!child) return;
    for (let i = child.blocks.length - 1; i >= 0; i--) {
      const b = child.blocks[i];
      if (b.kind === "tool_use" && b.toolCallId === callID) {
        child.blocks[i] = { ...b, status, result };
        break;
      }
    }
    this.emitTranscript(sessionID);
  }

  private markChildDone(sessionID: string, status: "completed" | "failed"): void {
    const child = this.children.get(sessionID);
    if (!child || child.status !== "running") return;
    child.status = status;
    this.emitRoster();
  }

  private emitRoster(): void {
    const agents: SubagentSnapshot[] = [];
    for (const child of this.children.values()) {
      const toolBlock = [...child.blocks].reverse().find((b) => b.kind === "tool_use");
      agents.push({
        taskId: child.sessionID,
        toolUseId: child.toolUseId,
        description: child.description ?? `opencode subagent ${child.sessionID.slice(0, 8)}`,
        subagentType: child.subagentType,
        status: child.status,
        lastToolName: toolBlock && toolBlock.kind === "tool_use" ? toolBlock.toolName : undefined,
      });
    }
    this.emit({ type: "subagent.update", sessionId: this.deps.sessionId, agents });
  }

  private emitTranscript(sessionID: string): void {
    const child = this.children.get(sessionID);
    if (!child) return;
    this.emit({
      type: "subagent.transcript",
      sessionId: this.deps.sessionId,
      parentToolUseId: child.toolUseId ?? sessionID,
      blocks: child.blocks,
    });
  }

  /* ── bash roster ── */

  private emitBashTasks(): void {
    this.emit({
      type: "bash-tasks.update",
      sessionId: this.deps.sessionId,
      tasks: [...this.bashTasks.values()],
    });
  }

  /* ── turn finalization ── */

  /** Seal the turn. Emits turn.done exactly once; still-open assistant
   *  messages are completed first so the renderer's delta flusher drains. */
  finalizeTurn(reason: TurnDoneReason): void {
    if (this.turnEnded) return;
    this.turnEnded = true;
    for (const messageId of this.openMessages) {
      this.emit({ type: "message.complete", sessionId: this.deps.sessionId, messageId });
    }
    this.openMessages.clear();
    // Settle still-running bash entries — the turn is over.
    for (const [callID, task] of this.bashTasks) {
      if (task.status === "running") {
        this.bashTasks.set(callID, {
          ...task,
          status: reason === "error" ? "failed" : "completed",
          endedAt: Date.now(),
        });
      }
    }
    this.emitBashTasks();
    // Settle still-running child subagents
    for (const [sid, child] of this.children) {
      if (child.status === "running") {
        this.markChildDone(sid, reason === "error" ? "failed" : "completed");
      }
    }
    if (this.lastStepTokens || this.cumulativeTokens) {
      this.publishTokenSnapshot();
    }
    this.emit({ type: "turn.done", sessionId: this.deps.sessionId, reason });
    this.turnDoneResolve?.(reason);
  }

  /** Error finalization for transport failures (server death mid-turn). */
  finalizeError(message?: string): void {
    if (message) {
      this.emit({ type: "error", sessionId: this.deps.sessionId, message, code: "OPENCODE_TURN_ERROR" });
    }
    this.finalizeTurn("error");
  }

  /** Abort finalization (user stop). */
  finalizeAborted(): void {
    this.finalizeTurn("interrupted");
  }

  /** Freeze the rewind snapshot and emit turn.files (pi/Claude's flushFinal
   *  ordering: may arrive after turn.done — the store handles that). */
  async flushFinal(): Promise<void> {
    try {
      const files = await this.deps.snapshot.freeze();
      if (files.length > 0) {
        this.emit({ type: "turn.files", sessionId: this.deps.sessionId, files });
      }
    } catch (err) {
      this.deps.ctx.log.error(`opencode freeze failed: ${(err as Error).message}`);
    }
  }

  private emit(e: RuntimeEvent): void {
    this.deps.ctx.emit(e);
  }
}

/** Pull a printable string from a tool content array / structured object
 *  (2.1.1 shape: content: [{type:"text", text}] — verified live). */
function toolContentText(content: unknown): string | undefined {
  if (content == null) return undefined;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((c) => (c != null && typeof c === "object" ? (c as { type?: string; text?: unknown }) : null))
      .filter((c): c is { type?: string; text?: unknown } => !!c && (c.type ? c.type === "text" : true))
      .map((c) => (typeof c.text === "string" ? c.text : ""))
      .filter((s) => s.length > 0);
    return parts.length > 0 ? parts.join("\n") : undefined;
  }
  if (typeof content === "object") {
    const out = (content as { output?: unknown }).output;
    return typeof out === "string" ? out : undefined;
  }
  return undefined;
}
