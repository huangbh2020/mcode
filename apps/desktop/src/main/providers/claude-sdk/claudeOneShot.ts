/**
 * One-shot Claude CLI prompt for Mcode's own utility calls: session titles,
 * commit messages, scheduled-task intent parsing, GitHub issue drafts, and
 * the custom-endpoint connection probe.
 *
 * These have nothing to do with a chat session — no approval UI, no
 * transcript in the sidebar — they are "ask the model once, read the reply".
 * They run the user's Claude CLI through the same transport as chat turns
 * (claudeCliQuery.ts), so whatever the user installed and configured for
 * sessions is what answers here too.
 *
 * The run ends at the first `result` frame (or, for the connection probe, at
 * `system/init`); stdin is then closed and the process reaped.
 */
import { runClaudeCliQuery, type ClaudeCliOptions } from "./claudeCliQuery.js";
import type {
  ClaudeAssistantMessage,
  ClaudeResultMessage,
  ClaudeSystemInitMessage,
  ClaudeUserInputMessage,
} from "./claudeStreamTypes.js";

export interface ClaudeOneShotOptions {
  /** The one user turn. */
  prompt: string;
  /** Fixed system prompt — it REPLACES the CLI's own, so the reply is shaped
   *  by the caller's instructions alone. Omitted: the CLI's default prompt. */
  systemPrompt?: string;
  cwd?: string;
  model?: string;
  env?: ClaudeCliOptions["env"];
  /** Built-in tools the model may use. Default: none (`--tools=`) — a hard
   *  guarantee that nothing in the prompt can drive file / shell / network
   *  actions from a utility call. `"default"` keeps the CLI's own tool set. */
  tools?: string[] | "default";
  /** Agentic turns the model gets. Default 1: one reply, no follow-up. */
  maxTurns?: number;
  /** Settings files the CLI loads. Default project + local (CLAUDE.md and
   *  project settings apply; the user-level file is skipped so a gateway
   *  switched there cannot redirect the call). */
  settingSources?: string[];
  abortController: AbortController;
  /** Stop as soon as the session's `system/init` arrives (the connection
   *  probe: proof that the CLI booted and the endpoint answered). */
  stopAtInit?: boolean;
  /** Which CLI to run. Default: the user's (lib/claudeExecutable.ts). */
  executable?: ClaudeCliOptions["executable"];
  log?: ClaudeCliOptions["log"];
}

export interface ClaudeOneShotResult {
  /** Every assistant text block of the run, in order, joined by newlines. */
  text: string;
  /** Text of the LAST assistant message — what a single-reply call wants. */
  lastText: string;
  /** The session's init frame, when one arrived before the run ended. */
  init: ClaudeSystemInitMessage | null;
  /** True once any assistant message arrived — a backend that answers but
   *  skips the init frame still proved the endpoint works. */
  assistantSeen: boolean;
  /** The final result frame, when the run went that far. */
  result: ClaudeResultMessage | null;
}

/** How long a finished CLI process gets to exit on its own before it is
 *  closed (stdin EOF → grace → kill) so the caller is never left waiting. */
const EXIT_WAIT_MS = 2_000;
/** Upper bound on waiting for a process closed by `stopAtInit` to be gone. */
const CLOSE_WAIT_MS = 4_000;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function assistantText(message: ClaudeAssistantMessage): string {
  const { content } = message.message;
  if (typeof content === "string") return content;
  return content
    .filter((block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

/** Run one prompt and read the reply. Rejects with the CLI's own error text
 *  when the run failed ("Claude Code returned an error result: …"), and
 *  with a CliAbortedError when the abort signal fired (a caller timeout). */
export async function runClaudeOneShot(opts: ClaudeOneShotOptions): Promise<ClaudeOneShotResult> {
  // stdin stays open until the run is over (as the Agent SDK did for a
  // single-turn prompt): a control response still needs a way in — e.g. the
  // refusal for a tool ask nobody can approve here. Closing it right after
  // the prompt would strand that ask, and the turn with it.
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const feed = (async function* (): AsyncIterable<ClaudeUserInputMessage> {
    yield {
      type: "user",
      message: { role: "user", content: opts.prompt },
      parent_tool_use_id: null,
    };
    await held;
  })();
  const tools = opts.tools === "default" ? undefined : (opts.tools ?? []);
  const query = await runClaudeCliQuery(feed, {
    abortController: opts.abortController,
    tools,
    maxTurns: opts.maxTurns ?? 1,
    settingSources: opts.settingSources ?? ["project", "local"],
    // A probe stopped at init has nothing worth waiting for: kill soon.
    eofGraceMs: opts.stopAtInit ? 300 : undefined,
    includePartialMessages: false,
    ...(opts.cwd ? { cwd: opts.cwd } : { cwd: process.cwd() }),
    ...(opts.executable ? { executable: opts.executable } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.systemPrompt === undefined ? {} : { systemPrompt: { type: "custom" as const, prompt: opts.systemPrompt } }),
    ...(opts.log ? { log: opts.log } : {}),
  });

  let text = "";
  let lastText = "";
  let init: ClaudeSystemInitMessage | null = null;
  let assistantSeen = false;
  let result: ClaudeResultMessage | null = null;
  try {
    for await (const message of query) {
      // The union's catch-all member keeps `type` open, so the discriminant
      // checks below narrow nothing on their own — hence the casts.
      if (message.type === "system") {
        const system = message as ClaudeSystemInitMessage;
        if (system.subtype === "init") {
          init = system;
          if (opts.stopAtInit) break;
        }
      } else if (message.type === "assistant") {
        assistantSeen = true;
        lastText = assistantText(message as ClaudeAssistantMessage);
        text += (text ? "\n" : "") + lastText;
      } else if (message.type === "result") {
        result = message as ClaudeResultMessage;
        break;
      }
    }
  } finally {
    release();
    if (opts.stopAtInit) {
      // Stopped mid-turn: the CLI is busy with a model request and will not
      // exit on stdin EOF by itself. Close (EOF, a short grace, kill) and
      // wait for it to be gone — the caller must not leave a process behind
      // that is still talking to the endpoint.
      query.transport.close();
      await Promise.race([query.transport.closed, sleep(CLOSE_WAIT_MS)]);
    } else {
      // Let the process exit on its own (stdin EOF), then make sure it does.
      query.transport.endInput();
      await Promise.race([query.transport.closed, new Promise((r) => setTimeout(r, EXIT_WAIT_MS))]);
      query.transport.close();
    }
  }
  return { text, lastText, init, assistantSeen, result };
}
