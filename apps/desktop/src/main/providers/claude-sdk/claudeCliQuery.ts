/**
 * Launch the user's Claude CLI for one session process and hand back a query
 * object — the replacement for the Agent SDK's `query()`.
 *
 * Everything Mcode used to pass as SDK `Options` is translated here into what
 * the CLI actually takes:
 *
 *   SDK option                →  where it goes
 *   model / effort / resume   →  --model / --effort / --resume=<id>
 *   permissionMode            →  --permission-mode
 *   skills                    →  --allowedTools Skill / Skill(<name>)
 *   tools / maxTurns          →  --tools=<list> / --max-turns
 *   settingSources / debug    →  --setting-sources / --debug
 *   settings                  →  --settings <temp file>   (JSON on a command
 *                                line hits cmd/CreateProcess length limits
 *                                and quoting rules; a file does not)
 *   mcpServers (config)       →  --mcp-config <temp file>
 *   hostMcpServers (in-process tools) → a loopback HTTP MCP server per name,
 *                                listed in the same --mcp-config file
 *   plugins                   →  --plugin-dir / --plugin-dir-no-mcp
 *   canUseTool                →  --permission-prompt-tool=stdio + the
 *                                `can_use_tool` control requests it brings
 *   systemPrompt / supportedDialogKinds → the `initialize` control request
 *
 * The handshake is the SDK's own sequence: the `initialize` request is the
 * first thing on the CLI's stdin (it carries what only the control channel
 * can deliver), prompts follow as one JSON line each, and stdin EOF ends the
 * run gracefully.
 */
import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliTransport, type CliTransportLog, type CliTransportOptions } from "./cliTransport.js";
import { startHostMcpServer, type HostMcpServer, type HostMcpServerSpec } from "./hostMcpHttp.js";
import {
  ControlHandlerError,
  canUseToolContext,
  type CanUseToolRequest,
  type ControlRequest,
  type ElicitationRequest,
  type OnUserDialog,
  type CanUseTool,
  type RequestUserDialogRequest,
} from "./claudeProtocol.js";
import type { ClaudeContextUsageResponse, ClaudeMessage, ClaudeUserInputMessage } from "./claudeStreamTypes.js";
import {
  MIN_CLAUDE_CLI_VERSION,
  compareVersions,
  probeClaudeCliVersion,
  resolveClaudeExecutable,
  type ClaudeExecutable,
} from "@main/lib/claudeExecutable.js";

export type ClaudeCliSystemPrompt =
  | { type: "preset"; preset: "claude_code"; append?: string }
  | { type: "custom"; prompt: string };

/** What a session process is launched with. Field names follow the SDK
 *  options they replace, so the provider's option-building code reads the
 *  same as before. */
export interface ClaudeCliOptions {
  cwd: string;
  abortController: AbortController;
  model?: string;
  effort?: string;
  permissionMode?: string;
  resume?: string;
  includePartialMessages?: boolean;
  forwardSubagentText?: boolean;
  skills?: string[] | "all";
  allowedTools?: string[];
  tools?: string[];
  maxTurns?: number;
  settingSources?: string[];
  /** Flag-tier settings (`--settings`): an object is written to a temp file,
   *  a string is passed through (a path or inline JSON). */
  settings?: Record<string, unknown> | string;
  systemPrompt?: ClaudeCliSystemPrompt;
  /** MCP servers defined by configuration (plugin servers): plain
   *  `{command,args,env}` / `{type,url,headers}` entries for --mcp-config. */
  mcpServers?: Record<string, Record<string, unknown>>;
  /** Mcode's own tools, served from this process over loopback HTTP. */
  hostMcpServers?: Record<string, HostMcpServerSpec>;
  plugins?: Array<{ type: "local"; path: string; skipMcpDiscovery?: boolean }>;
  canUseTool?: CanUseTool;
  onUserDialog?: OnUserDialog;
  supportedDialogKinds?: string[];
  /** The child's whole environment (spread `process.env`). */
  env?: NodeJS.ProcessEnv;
  debug?: boolean;
  stderr?: (data: string) => void;
  /** Forceful kill once the stdin-EOF grace runs out (see CliTransport). */
  hardKill?: CliTransportOptions["hardKill"];
  /** How long the process gets to exit on stdin EOF before `hardKill`. */
  eofGraceMs?: number;
  executable?: ClaudeExecutable;
  extraArgs?: string[];
  log?: CliTransportLog;
}
/** The CLI is missing or too old for the control protocol. The provider
 *  maps it to the "runtime not installed" error card. */
export class ClaudeCliUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeCliUnavailableError";
  }
}

/** The live handle the provider drives a session process through — the slice
 *  of the SDK's `Query` Mcode used. */
export interface CliQuery extends AsyncIterable<ClaudeMessage> {
  readonly transport: CliTransport;
  /** The `initialize` reply (commands, models, CLI version…). Never throws
   *  unhandled — callers that care await it and catch. */
  readonly initialization: Promise<Record<string, unknown>>;
  getContextUsage(): Promise<ClaudeContextUsageResponse>;
  stopTask(taskId: string): Promise<void>;
}

/** Translate options into the CLI's argument vector (everything except the
 *  two file-backed flags — see `runClaudeCliQuery`). */
export function buildCliArgs(o: ClaudeCliOptions): string[] {
  const args = ["--output-format", "stream-json", "--verbose", "--input-format", "stream-json"];
  if (o.includePartialMessages) args.push("--include-partial-messages");
  if (o.effort) args.push("--effort", o.effort);
  if (o.maxTurns !== undefined) args.push("--max-turns", String(o.maxTurns));
  if (o.model) args.push("--model", o.model);
  if (o.permissionMode) args.push("--permission-mode", o.permissionMode);
  if (o.debug) args.push("--debug");
  // Without a host permission callback there is nobody to answer an ask;
  // with one, the CLI routes every ask over the control channel.
  if (o.canUseTool) args.push("--permission-prompt-tool=stdio");
  if (o.resume) args.push(`--resume=${o.resume}`);
  const allowed = [...(o.allowedTools ?? [])];
  if (o.skills !== undefined) {
    allowed.push(...(o.skills === "all" ? ["Skill"] : o.skills.map((name) => `Skill(${name})`)));
  }
  if (allowed.length > 0) args.push("--allowedTools", allowed.join(","));
  if (o.tools !== undefined) args.push(`--tools=${o.tools.join(",")}`);
  if (o.settingSources && o.settingSources.length > 0) {
    args.push("--setting-sources", o.settingSources.join(","));
  }
  if (o.forwardSubagentText) args.push("--forward-subagent-text");
  for (const plugin of o.plugins ?? []) {
    args.push(plugin.skipMcpDiscovery ? "--plugin-dir-no-mcp" : "--plugin-dir", plugin.path);
  }
  args.push(...(o.extraArgs ?? []));
  return args;
}

/** Build the `initialize` control request: what only the control channel can
 *  deliver at launch. */
export function buildInitializeRequest(o: ClaudeCliOptions): ControlRequest {
  const request: ControlRequest = { subtype: "initialize" };
  if (o.systemPrompt) {
    if (o.systemPrompt.type === "custom") request.systemPrompt = [o.systemPrompt.prompt];
    else if (o.systemPrompt.append) request.appendSystemPrompt = o.systemPrompt.append;
  }
  if (o.supportedDialogKinds && o.supportedDialogKinds.length > 0) {
    request.supportedDialogKinds = o.supportedDialogKinds;
  }
  return request;
}

/** Make sure `executable` can speak the control protocol Mcode uses: throws
 *  {@link ClaudeCliUnavailableError} when it is older than
 *  {@link MIN_CLAUDE_CLI_VERSION}. An unreadable version (probe failed)
 *  passes — a CLI that cannot even answer `--version` fails loudly on spawn. */
export async function assertClaudeCliUsable(executable: ClaudeExecutable): Promise<ClaudeExecutable> {
  const version = await probeClaudeCliVersion(executable).catch(() => null);
  if (version && compareVersions(version, MIN_CLAUDE_CLI_VERSION) < 0) {
    throw new ClaudeCliUnavailableError(
      `Claude CLI 版本过旧(${version} < ${MIN_CLAUDE_CLI_VERSION}),审批与计划对话框无法工作。请升级:npm install -g @anthropic-ai/claude-code@latest`,
    );
  }
  return executable;
}

/** Spawn the CLI, start its tool servers, send the handshake and begin
 *  feeding it prompts. Throws {@link ClaudeCliUnavailableError} when no
 *  usable CLI is installed. */
export async function runClaudeCliQuery(
  prompt: AsyncIterable<ClaudeUserInputMessage>,
  options: ClaudeCliOptions,
): Promise<CliQuery> {
  const log = options.log;
  const executable = options.executable ?? resolveClaudeExecutable();
  if (!executable) {
    throw new ClaudeCliUnavailableError(
      "未检测到 Claude CLI。请先安装:npm install -g @anthropic-ai/claude-code(或到 设置 → Agent 安装)。Claude CLI not found on PATH.",
    );
  }
  await assertClaudeCliUsable(executable);
  const version = await probeClaudeCliVersion(executable).catch(() => null);

  const tempFiles: string[] = [];
  const hostServers: HostMcpServer[] = [];
  const cleanup = (): void => {
    for (const file of tempFiles) {
      try {
        rmSync(file, { force: true });
      } catch {
        /* best effort — the OS temp cleaner gets the rest */
      }
    }
    tempFiles.length = 0;
    for (const server of hostServers) void server.close();
    hostServers.length = 0;
  };
  const writeTempJson = (value: unknown): string => {
    const file = join(tmpdir(), `mcode-claude-${randomUUID()}.json`);
    // 0o600 where the OS honours it: MCP configs carry server credentials.
    writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
    tempFiles.push(file);
    return file;
  };

  try {
    // Host MCP servers first: their URLs go into the same --mcp-config file
    // as the config-defined ones.
    const mcpServers: Record<string, Record<string, unknown>> = { ...(options.mcpServers ?? {}) };
    for (const [name, spec] of Object.entries(options.hostMcpServers ?? {})) {
      const server = await startHostMcpServer({
        name,
        version: spec.version,
        instructions: spec.instructions,
        tools: spec.tools,
        alwaysLoad: spec.alwaysLoad,
        log,
      });
      hostServers.push(server);
      mcpServers[name] = { ...server.config };
    }

    const args = buildCliArgs(options);
    if (options.settings) {
      args.push(
        "--settings",
        typeof options.settings === "string" ? options.settings : writeTempJson(options.settings),
      );
    }
    if (Object.keys(mcpServers).length > 0) {
      args.push("--mcp-config", writeTempJson({ mcpServers }));
    }

    const transport = new CliTransport({
      command: executable.command,
      args: [...executable.preArgs, ...args],
      cwd: options.cwd,
      env: { ...(options.env ?? process.env), ...executable.env },
      shell: executable.shell,
      abortController: options.abortController,
      hardKill: options.hardKill,
      eofGraceMs: options.eofGraceMs,
      stderr: options.stderr,
      log,
      onControlRequest: async (request, ctx) => {
        switch (request.subtype) {
          case "can_use_tool": {
            if (!options.canUseTool) {
              throw new ControlHandlerError("canUseTool callback is not provided", "no_permission_handler");
            }
            const result = await options.canUseTool(
              (request as CanUseToolRequest).tool_name,
              (request as CanUseToolRequest).input ?? {},
              canUseToolContext(request as CanUseToolRequest, ctx),
            );
            // null = the consumer answered out-of-band; stay silent.
            if (result === null) return undefined;
            return { ...result, toolUseID: (request as CanUseToolRequest).tool_use_id };
          }
          case "request_user_dialog": {
            const dialog = request as unknown as RequestUserDialogRequest;
            if (!options.onUserDialog) return undefined;
            const result = await options.onUserDialog(
              { dialogKind: dialog.dialog_kind, payload: dialog.payload ?? {}, toolUseID: dialog.tool_use_id },
              ctx,
            );
            return result ?? undefined;
          }
          case "elicitation":
            // Mcode renders no MCP elicitation form: decline, as the SDK did
            // when no handler was registered.
            log?.info(
              `claude cli: declining MCP elicitation from ${(request as unknown as ElicitationRequest).mcp_server_name}`,
            );
            return { action: "decline" };
          default:
            throw new ControlHandlerError(
              `Unsupported control request subtype: ${request.subtype}`,
              "unsupported_request",
            );
        }
      },
    });
    log?.info(
      `claude cli: spawned ${executable.command} (v${version ?? "?"}, ${executable.source}) pid=${transport.pid}`,
    );

    // Whatever was created for this process goes away with it.
    void transport.closed.then(cleanup);

    const initialization = transport
      .request<Record<string, unknown>>(buildInitializeRequest(options))
      .catch((err: unknown) => {
        log?.warn(`claude cli: initialize failed: ${(err as Error).message}`);
        throw err;
      });
    void initialization.catch(() => {});

    // Prompts: one stdin line each; the iterable ending is the graceful stop.
    void (async () => {
      try {
        for await (const message of prompt) {
          if (!transport.writeLine(message)) break;
        }
      } catch (err) {
        log?.warn(`claude cli: prompt feed failed: ${(err as Error).message}`);
      } finally {
        transport.endInput();
      }
    })();

    return {
      transport,
      initialization,
      getContextUsage: async () =>
        (await transport.request({ subtype: "get_context_usage" })) as unknown as ClaudeContextUsageResponse,
      stopTask: async (taskId: string) => {
        await transport.request({ subtype: "stop_task", task_id: taskId });
      },
      [Symbol.asyncIterator]: () => transport.readMessages()[Symbol.asyncIterator](),
    };
  } catch (err) {
    cleanup();
    throw err;
  }
}

/** Warm the resolver + version probe so the first message of a session does
 *  not pay for them. Errors are swallowed — the real start path surfaces
 *  them through the normal turn error path. */
export function preloadClaudeCli(): void {
  setTimeout(() => {
    const executable = resolveClaudeExecutable();
    if (executable) void probeClaudeCliVersion(executable).catch(() => {});
  }, 3_000);
}
