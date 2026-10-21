/**
 * OpenCode (v2) ask-bridges — server-initiated asks answered by the host.
 *
 * The injected server config makes every mutating/networky tool ASK (see
 * opencodeServerManager.buildOpenCodeServerConfig). Each ask arrives as a
 * `permission.v2.asked` event; this module decides and answers via
 * `session.permission.reply`. The decision chain mirrors pi's tool_call
 * handler ordering exactly (guards BEFORE grants, host-side mode
 * interpretation — the server-side config never changes with the UI mode):
 *
 *   ① project-boundary guards (edit paths / bash write targets) — violations
 *      reject WITHOUT any UI, in every mode except bypass/dontAsk;
 *   ② isolated-mode read boundary (read/glob/grep/external asks);
 *   ③ recordPre for edit asks right before an approving reply (rewind
 *      snapshots stay available in EVERY mode, bypass included, precisely
 *      because the ask always surfaces);
 *   ④ mode auto-approve (bypass → everything; acceptEdits/isolated → edit);
 *   ⑤ host always-allow (session/global lists via ctx.isToolAlwaysAllowed);
 *   ⑥ ctx.requestApproval → the Mcode approval card.
 *
 * Replies only ever use "once" / "reject" — NEVER "always": opencode's
 * always persists a server-side pattern whitelist that would let later
 * matching calls skip the ask entirely, i.e. skip the host guards. The
 * host-side always-allow lists are consulted instead (per call, guards
 * still run first).
 *
 * The question bridge maps `question.v2.asked` (opencode's native structured
 * question surface) onto the host's AskUserQuestion card and replies via
 * `session.question.reply` — answers are arrays of selected labels per
 * question, in question order.
 */
import { randomUUID } from "node:crypto";
import type { PermissionMode } from "@contracts/runtime";
import type { ProviderContext, UserInputAnswers } from "@contracts/provider";
import type { AskUserQuestionItem } from "@contracts/runtime";
import { normalizeBashCommand } from "@main/lib/msysPath.js";
import { normalizeToolFilePath } from "@main/lib/fileSnapshot.js";
import { guardBashCommand, expandTilde } from "@main/lib/bashWriteGuard.js";
import { guardReadPath } from "@main/lib/readGuard.js";
import { getFileSnapshot } from "@main/lib/fileSnapshotRegistry.js";
import { log } from "@main/lib/logger.js";

/** Structural shape of a permission.asked payload on CLI 2.1.1 (verified
 *  live): {id: "per_…", sessionID, action: "shell", resources: […],
 *  save?: […], source?: {type: "tool", messageID, id: "call_…"}}. */
export interface PermissionAskData {
  id?: string;
  sessionID?: string;
  action?: string;
  resources?: string[];
  save?: string[];
  source?: { type?: string; messageID?: string; callID?: string; id?: string };
}

/** opencode permission action → the Mcode tool name used on approval cards
 *  and always-allow lists (Claude-style spellings so the user's global
 *  "Bash"/"Edit" grants work across providers). 2.1.1 uses "shell" (not
 *  v1's "bash" — verified live) and "subagent" for dispatch; both spellings
 *  are accepted. */
export function openCodeActionToToolName(action: string): string {
  switch (action) {
    case "edit":
    case "write":
      return "Edit";
    case "bash":
    case "shell":
      return "Bash";
    case "webfetch":
      return "WebFetch";
    case "websearch":
      return "WebSearch";
    case "task":
    case "subagent":
      return "Task";
    case "read":
      return "Read";
    case "glob":
      return "Glob";
    case "grep":
      return "Grep";
    case "list":
      return "LS";
    default:
      return action;
  }
}

/** Actions whose asks mean "about to write a file". */
const EDIT_ACTIONS = new Set(["edit"]);
/** Read-ish actions — asks only fire for sensitive targets (.env rules) or
 *  out-of-directory access (external_directory); approved per mode. */
const READ_ACTIONS = new Set(["read", "glob", "grep", "list", "external_directory"]);

export type OpenCodePermissionChoice =
  | { kind: "approve" }
  | { kind: "reject"; message: string }
  | { kind: "prompt" };

export interface OpenCodePermissionDecision {
  choice: OpenCodePermissionChoice;
  /** Mcode-facing tool name (approval card / always-allow). */
  toolName: string;
  /** Input snapshot for the approval card. */
  approvalInput: unknown;
  /** Normalized absolute path to recordPre before an approving reply. */
  recordPrePath?: string;
}

/** Pure decision core (smoke-tested): action + resources + mode → choice.
 *  `toolInput` is the best-effort input looked up by callID from the adapter
 *  (session.next.tool.called); `resources` is the ask's own payload and is
 *  the primary source (edit → file paths, bash → the command line). */
export function decideOpenCodePermission(input: {
  action: string;
  resources: string[];
  toolInput?: unknown;
  cwd: string;
  mode: PermissionMode | undefined;
}): OpenCodePermissionDecision {
  const { action, resources, toolInput, cwd, mode } = input;
  const toolName = openCodeActionToToolName(action);
  const strict = mode !== "bypassPermissions" && mode !== "dontAsk";
  const isolated = mode === "isolated";

  const firstResource = resources[0];

  /* ⓪ Question guard: questions interact with the user directly, never require tool approval */
  if (action === "question") {
    return { choice: { kind: "approve" }, toolName: "question", approvalInput: {} };
  }

  /* ① Edit guard: project boundary + normalize (WSL / ~ dialects). */
  if (EDIT_ACTIONS.has(action)) {
    const rawPath =
      firstResource ??
      (toolInput as { filePath?: unknown; path?: unknown; file_path?: unknown } | undefined)?.filePath ??
      (toolInput as { path?: unknown } | undefined)?.path ??
      (toolInput as { file_path?: unknown } | undefined)?.file_path;
    const approvalInput =
      typeof rawPath === "string" && rawPath ? { filePath: rawPath } : { resources };
    if (typeof rawPath === "string" && rawPath.length > 0) {
      const norm = normalizeToolFilePath(cwd, expandTilde(rawPath));
      if (norm && !norm.insideProject && strict) {
        return {
          choice: {
            kind: "reject",
            message: `拒绝:目标路径在项目工作目录之外(${norm.absPath})。只允许在项目目录内写入文件,请改用相对路径。`,
          },
          toolName,
          approvalInput,
        };
      }
      const recordPrePath = norm ? norm.absPath : rawPath;
      // ② Mode auto-approve for edits: bypass/dontAsk → everything;
      //    acceptEdits/isolated → edits inside the project (the boundary was
      //    already enforced above).
      if (!strict || mode === "acceptEdits" || mode === "isolated") {
        return { choice: { kind: "approve" }, toolName, approvalInput, recordPrePath };
      }
      return { choice: { kind: "prompt" }, toolName, approvalInput, recordPrePath };
    }
    return { choice: strict ? { kind: "prompt" } : { kind: "approve" }, toolName, approvalInput };
  }

  /* ③ Bash guard: write-target extraction on the normalized command. The
   *  action is "shell" on CLI 2.1.1 (v1 said "bash") — accept both. */
  if (action === "bash" || action === "shell") {
    const rawCommand =
      firstResource ?? (toolInput as { command?: unknown } | undefined)?.command;
    const approvalInput = typeof rawCommand === "string" ? { command: rawCommand } : { resources };
    if (typeof rawCommand === "string" && rawCommand.length > 0) {
      const normalized = normalizeBashCommand(rawCommand);
      const denial = guardBashCommand(cwd, normalized, strict);
      if (denial) {
        return { choice: { kind: "reject", message: denial }, toolName, approvalInput };
      }
    }
    return { choice: strict ? { kind: "prompt" } : { kind: "approve" }, toolName, approvalInput };
  }

  /* ④ Read-ish asks (fires only for .env-like or out-of-directory targets):
   *    isolated enforces the project read boundary; every other mode allows. */
  if (READ_ACTIONS.has(action)) {
    const rawPath = firstResource;
    if (isolated && typeof rawPath === "string" && rawPath.length > 0) {
      const denial = guardReadPath(cwd, rawPath);
      if (denial) {
        return { choice: { kind: "reject", message: denial }, toolName, approvalInput: { path: rawPath } };
      }
    }
    return { choice: { kind: "approve" }, toolName, approvalInput: { path: rawPath } };
  }

  /* Subagent dispatch (task/subagent): auto-approve in every mode — same
   * semantics as pi/Claude's Task tool (派发不审批,子代理自己的工具各自审批;
   * child-session asks still hit this bridge with their own guards). */
  if (action === "task" || action === "subagent") {
    return {
      choice: { kind: "approve" },
      toolName,
      approvalInput: { resources },
    };
  }

  /* webfetch / websearch / unknown: prompt in controlled modes,
   * auto-approve under bypass/dontAsk. */
  return {
    choice: strict ? { kind: "prompt" } : { kind: "approve" },
    toolName,
    approvalInput: resources.length > 0 ? { target: resources[0], resources } : { resources },
  };
}

export interface OpenCodeBridgeDeps {
  ctx: ProviderContext;
  /** Mcode session id. */
  sessionId: string;
  /** Project root (guard base). */
  cwd: string;
  /** Authenticated raw fetch to the embedded server (serverManager handle).
   *  Used where SDK request shapes lag the installed CLI — the 2.1.1
   *  permission reply takes {decision} (SDK sends {reply}); verified live. */
  fetchRaw: (path: string, init?: RequestInit) => Promise<Response>;
  /** Adapter's callID → tool-call lookup (input enrichment). */
  getToolCall: (callID: string) => { tool: string; input: unknown } | undefined;
  /** Teach the adapter the callID's real tool name (asked actions carry it
   *  — tool.called events on 2.1.1 do not). */
  noteToolName: (callID: string, toolName: string) => void;
}

/** Handle one permission ask (`permission.asked` on CLI 2.1.1; the SDK type
 *  still names it permission.v2.asked — the event is read structurally).
 *  Decide → recordPre → reply. Errors are logged, never thrown (the server
 *  would hang on an unanswered ask — a failed reply attempt at least
 *  unblocks it if the HTTP call went through). */
export async function handleOpenCodePermissionAsked(
  ev: { type: string; data?: PermissionAskData },
  deps: OpenCodeBridgeDeps,
): Promise<void> {
  const data = ((ev as { data?: PermissionAskData }).data ?? {}) as PermissionAskData;
  const sessionID = data.sessionID;
  const requestID = data.id;
  const action = data.action ?? "";
  const resources = data.resources ?? [];
  const source = data.source;
  if (!sessionID || !requestID) return;
  // 2.1.1's source carries the call id under `id` (the SDK type says callID).
  const rawSource = (source ?? {}) as { type?: string; callID?: string; id?: string };
  const callID = rawSource.type === "tool" ? (rawSource.callID ?? rawSource.id) : undefined;
  const toolCall = callID ? deps.getToolCall(callID) : undefined;
  if (callID && action) {
    deps.noteToolName(callID, openCodeActionToToolName(action));
  }
  const decision = decideOpenCodePermission({
    action,
    resources,
    toolInput: toolCall?.input,
    cwd: deps.cwd,
    mode: deps.ctx.getPermissionMode?.(),
  });

  const reply = async (r: "once" | "reject", message?: string) => {
    try {
      // Verified live on 2.1.1: POST …/permission/{id}/reply {decision} → 204.
      const res = await deps.fetchRaw(
        `/api/session/${sessionID}/permission/${requestID}/reply`,
        {
          method: "POST",
          body: JSON.stringify({ decision: r, ...(message ? { message } : {}) }),
        },
      );
      if (!res.ok && res.status !== 204) {
        log.warn(
          `opencode permission reply failed (${action} ${r}): ${res.status} ${(await res.text()).slice(0, 200)}`,
        );
      }
    } catch (err) {
      log.warn(`opencode permission reply failed (${action} ${r}): ${(err as Error).message}`);
    }
  };

  if (decision.choice.kind === "reject") {
    await reply("reject", decision.choice.message);
    return;
  }
  if (decision.choice.kind === "approve") {
    if (decision.recordPrePath) {
      await getFileSnapshot(deps.sessionId).recordPre(deps.cwd, decision.recordPrePath);
    }
    await reply("once");
    return;
  }

  /* prompt path — host always-allow, then the approval card. */
  if (deps.ctx.isToolAlwaysAllowed?.(decision.toolName)) {
    if (decision.recordPrePath) {
      await getFileSnapshot(deps.sessionId).recordPre(deps.cwd, decision.recordPrePath);
    }
    await reply("once");
    return;
  }
  const requestApproval = deps.ctx.requestApproval;
  if (!requestApproval) {
    // Fail-open mirrors pi's no-bridge behavior.
    if (decision.recordPrePath) {
      await getFileSnapshot(deps.sessionId).recordPre(deps.cwd, decision.recordPrePath);
    }
    await reply("once");
    return;
  }
  const r = await requestApproval({
    requestId: randomUUID(),
    toolName: decision.toolName,
    input: decision.approvalInput,
  });
  if (r.allow) {
    if (decision.recordPrePath) {
      await getFileSnapshot(deps.sessionId).recordPre(deps.cwd, decision.recordPrePath);
    }
    await reply("once");
  } else {
    await reply("reject", r.reason ?? "Denied by user");
  }
}

/** Map the host's answer record to opencode's per-question label arrays. */
export function mapUserInputAnswersToOpenCode(
  questions: AskUserQuestionItem[],
  answers: UserInputAnswers,
): Array<Array<string>> {
  return questions.map((q) => {
    const a = answers[q.question];
    if (a == null) return [];
    return Array.isArray(a) ? a : [a];
  });
}

/** Handle one structured question ask. NOTE: on CLI 2.1.1 the question
 *  surface moved to `session.form.*` (payload shape not yet captured live);
 *  this bridge still answers the question.v2-shaped event should it appear.
 *  Dismiss/skip → reject so the turn never blocks forever. */
export async function handleOpenCodeQuestionAsked(
  ev: { type: string; data?: QuestionAskData },
  deps: OpenCodeBridgeDeps,
): Promise<void> {
  const data = ((ev as { data?: QuestionAskData }).data ?? {}) as QuestionAskData;
  const { sessionID, id: requestID, questions: raw, tool } = data;
  const questions: AskUserQuestionItem[] = (raw ?? []).map((q) => ({
    header: (q.header || q.question).slice(0, 30),
    question: q.question,
    multiSelect: q.multiple ?? false,
    options: (q.options ?? []).map((o) => ({
      label: o.label,
      ...(o.description ? { description: o.description } : {}),
    })),
  }));
  if (!sessionID || !requestID) return;
  if (questions.length === 0) {
    await rejectQuestion(deps.fetchRaw, sessionID, requestID);
    return;
  }
  const requestUserInput = deps.ctx.requestUserInput;
  if (!requestUserInput) {
    await rejectQuestion(deps.fetchRaw, sessionID, requestID);
    return;
  }
  const decision = await requestUserInput({
    requestId: randomUUID(),
    questions,
    ...(tool?.callID ?? tool?.id ? { toolUseId: (tool?.callID ?? tool?.id) as string } : {}),
  });
  try {
    if (decision.dismissed) {
      await rejectQuestion(deps.fetchRaw, sessionID, requestID);
      return;
    }
    const res = await deps.fetchRaw(`/api/session/${sessionID}/question/${requestID}/reply`, {
      method: "POST",
      body: JSON.stringify({
        answers: mapUserInputAnswersToOpenCode(questions, decision.answers),
      }),
    });
    if (!res.ok && res.status !== 204) {
      log.warn(`opencode question reply failed: ${res.status}`);
    }
  } catch (err) {
    log.warn(`opencode question reply failed: ${(err as Error).message}`);
  }
}

/** Handle structured form creation on CLI 2.1.1 (the native `question` tool
 *  triggers `form.created`). Bridges to host's AskUserQuestion card and replies
 *  via `/api/session/:sessionID/form/:formID/reply`. */
export async function handleOpenCodeFormCreated(
  ev: { type: string; data?: unknown },
  deps: OpenCodeBridgeDeps,
): Promise<void> {
  const rawData = (ev as { data?: unknown }).data;
  const form = (rawData && typeof rawData === "object" && "form" in rawData
    ? (rawData as { form?: unknown }).form
    : rawData) as {
    id?: string;
    sessionID?: string;
    title?: string;
    metadata?: { kind?: string; tool?: { messageID?: string; id?: string; callID?: string } };
    fields?: Array<{
      key: string;
      title?: string;
      description?: string;
      type?: string;
      options?: Array<{ value: string; label?: string; description?: string }>;
      custom?: boolean;
    }>;
  } | null;

  const sessionID = form?.sessionID;
  const formID = form?.id;
  if (!sessionID || !formID) return;

  const fields = form.fields ?? [];
  const questions: AskUserQuestionItem[] = fields.map((f, i) => {
    const qText = f.description || f.title || `Question ${i + 1}`;
    const header = (f.title || f.description || `Question ${i + 1}`).slice(0, 30);
    const multiSelect = f.type === "multiselect";
    const options = (f.options ?? []).map((o) => ({
      label: o.label || o.value,
      ...(o.description ? { description: o.description } : {}),
    }));
    return { header, question: qText, multiSelect, options };
  });

  if (questions.length === 0) {
    await cancelForm(deps.fetchRaw, sessionID, formID, "No questions in form");
    return;
  }

  const requestUserInput = deps.ctx.requestUserInput;
  if (!requestUserInput) {
    await cancelForm(deps.fetchRaw, sessionID, formID, "User input not available");
    return;
  }

  const tool = form.metadata?.tool;
  const decision = await requestUserInput({
    requestId: randomUUID(),
    questions,
    ...(tool?.id ?? tool?.callID ? { toolUseId: (tool?.id ?? tool?.callID) as string } : {}),
  });

  try {
    if (decision.dismissed) {
      await cancelForm(deps.fetchRaw, sessionID, formID, "用户关闭了提问,未提供答案,请继续当前任务");
      return;
    }

    const answer: Record<string, string | string[]> = {};
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      const qText = questions[i].question;
      const userAns = decision.answers[qText];
      if (userAns != null) {
        answer[f.key] = userAns;
      } else {
        answer[f.key] = f.type === "multiselect" ? [] : "";
      }
    }

    const res = await deps.fetchRaw(`/api/session/${sessionID}/form/${formID}/reply`, {
      method: "POST",
      body: JSON.stringify({ answer }),
    });
    if (!res.ok && res.status !== 204) {
      log.warn(`opencode form reply failed: ${res.status}`);
    }
  } catch (err) {
    log.warn(`opencode form reply failed: ${(err as Error).message}`);
  }
}

async function cancelForm(
  fetchRaw: (path: string, init?: RequestInit) => Promise<Response>,
  sessionID: string,
  formID: string,
  message?: string,
): Promise<void> {
  try {
    const query = message ? `?message=${encodeURIComponent(message)}` : "";
    await fetchRaw(`/api/session/${sessionID}/form/${formID}/cancel${query}`, { method: "POST" });
  } catch (err) {
    log.warn(`opencode form cancel failed: ${(err as Error).message}`);
  }
}

/** Structural shape of a question ask payload (question.v2 era; forms on
 *  2.1.1 are not yet wired — see the note above). */
export interface QuestionAskData {
  id?: string;
  sessionID?: string;
  questions?: Array<{
    question: string;
    header?: string;
    multiple?: boolean;
    options?: Array<{ label: string; description?: string }>;
  }>;
  tool?: { messageID?: string; callID?: string; id?: string };
}

async function rejectQuestion(
  fetchRaw: (path: string, init?: RequestInit) => Promise<Response>,
  sessionID: string,
  requestID: string,
): Promise<void> {
  try {
    await fetchRaw(`/api/session/${sessionID}/question/${requestID}/reject`, { method: "POST" });
  } catch (err) {
    log.warn(`opencode question reject failed: ${(err as Error).message}`);
  }
}
