/**
 * In-process MCP server over Streamable HTTP — how Mcode's own tools reach
 * the Claude CLI now that the Agent SDK is gone.
 *
 * The SDK exposed host tools through `createSdkMcpServer`: an MCP server
 * living in this process whose JSON-RPC frames were relayed to the CLI over
 * the control channel (`mcp_message` requests). A raw CLI has no such relay,
 * so the tools are served the way any other MCP server is: a loopback HTTP
 * endpoint the CLI connects to and calls, configured per session through
 * `--mcp-config`. Tool handlers still run right here in the main process —
 * the browser tools need the BrowserManager, which lives here.
 *
 * One server per MCP server name, one per CLI transport: its lifetime is the
 * transport's, and its tools close over that session's context (session id,
 * project path, turn number).
 *
 * Protocol surface (stateless — no session id, no server→client stream):
 *   POST <url>   initialize · notifications/initialized · ping ·
 *                tools/list · tools/call (+ empty resources/prompts lists)
 *   GET  <url>   405 — a stateless server offers no SSE stream
 *   DELETE <url> 204 — nothing to tear down
 *
 * Access control: loopback only, and the path carries a per-server random
 * token (the CLI gets the full URL). Any local process could otherwise drive
 * the in-app browser while a session is open. The Host header is checked
 * too, against DNS rebinding.
 *
 * Pure node + zod (no electron, no `@main/*`) so the CLI protocol probes can
 * bundle it.
 */
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { z } from "zod";

/** What a host tool returns — the MCP `tools/call` result content. */
export interface HostMcpToolResult {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
    | Record<string, unknown>
  >;
  isError?: boolean;
}

export interface HostMcpTool {
  name: string;
  description: string;
  /** zod raw shape (the object's properties) — the single source for both
   *  the advertised JSON Schema and the call-time validation. */
  inputSchema: z.ZodRawShape;
  handler: (args: Record<string, unknown>) => Promise<HostMcpToolResult> | HostMcpToolResult;
}

/** One in-process MCP server as its owner describes it (the provider builds
 *  one per set of host tools). */
export interface HostMcpServerSpec {
  tools: HostMcpTool[];
  instructions?: string;
  alwaysLoad?: boolean;
  version?: string;
}

export interface HostMcpServerOptions {
  /** MCP server name as the CLI sees it (tools become `mcp__<name>__<tool>`). */
  name: string;
  version?: string;
  /** Server instructions, surfaced to the model as an MCP instructions block. */
  instructions?: string;
  tools: HostMcpTool[];
  /** Keep every tool in the prompt instead of deferring it behind tool
   *  search — the CLI honours `_meta["anthropic/alwaysLoad"]` on a tool. */
  alwaysLoad?: boolean;
  /** Cap on one request body (tool arguments can carry file paths, not files). */
  maxBodyBytes?: number;
  log?: { info(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void };
}

export interface HostMcpServer {
  /** The `--mcp-config` entry for this server. */
  config: { type: "http"; url: string };
  close(): Promise<void>;
}

/** Latest protocol revision this server is written against; a client asking
 *  for another dated revision gets its own echoed back (the surface above is
 *  stable across them). */
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;

/* ─── zod (v3) raw shape → JSON Schema, for the subset the tools use ───── */

type JsonSchema = Record<string, unknown>;

/** Description sits on the outer wrapper (`z.string().optional().describe(…)`
 *  and `.describe(…).optional()` are both in use), the type on the inner one. */
function withDescription(outer: z.ZodTypeAny, base: JsonSchema): JsonSchema {
  const description = outer.description;
  if (typeof description === "string" && description) return { ...base, description };
  return base;
}

/** True when the schema accepts an absent value (`.optional()` anywhere in a
 *  optional/nullable wrapper chain). */
function hasOptional(schema: z.ZodTypeAny): boolean {
  let current = schema;
  while (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
    if (current instanceof z.ZodOptional) return true;
    current = current.unwrap();
  }
  return false;
}

function zodToJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    return withDescription(schema, zodToJsonSchema(schema.unwrap()));
  }
  if (schema instanceof z.ZodString) return withDescription(schema, { type: "string" });
  if (schema instanceof z.ZodNumber) return withDescription(schema, { type: "number" });
  if (schema instanceof z.ZodBoolean) return withDescription(schema, { type: "boolean" });
  if (schema instanceof z.ZodLiteral) return withDescription(schema, { type: typeof schema.value, const: schema.value });
  if (schema instanceof z.ZodEnum) {
    return withDescription(schema, { type: "string", enum: [...(schema.options as string[])] });
  }
  if (schema instanceof z.ZodNativeEnum) {
    return withDescription(schema, { type: "string", enum: Object.values(schema.enum as Record<string, unknown>) });
  }
  if (schema instanceof z.ZodArray) {
    // v3 stores minItems/maxItems as { value } | null checks on the def.
    const def = schema._def as { minLength?: { value: number } | null; maxLength?: { value: number } | null };
    return withDescription(schema, {
      type: "array",
      items: zodToJsonSchema(schema.element as z.ZodTypeAny),
      ...(def.minLength ? { minItems: def.minLength.value } : {}),
      ...(def.maxLength ? { maxItems: def.maxLength.value } : {}),
    });
  }
  if (schema instanceof z.ZodUnion) {
    return withDescription(schema, {
      anyOf: (schema.options as z.ZodTypeAny[]).map((option: z.ZodTypeAny) => zodToJsonSchema(option)),
    });
  }
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(value);
      // Only `.optional()` makes a key absent-able; `.nullable()` keeps the
      // key required (with null allowed).
      if (!hasOptional(value)) required.push(key);
    }
    const passthrough = (schema._def as { unknownKeys?: string }).unknownKeys === "passthrough";
    return withDescription(schema, {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
      ...(passthrough ? { additionalProperties: true } : {}),
    });
  }
  // Anything else (any/unknown/record/intersection…): accept any value.
  return withDescription(schema, {});
}

/** Object schema for one tool's arguments: the declared properties plus any
 *  the model adds (ignored rather than rejected — the handlers read by name). */
function toolArgValidator(tool: HostMcpTool): z.ZodObject<z.ZodRawShape> {
  return z.object(tool.inputSchema).passthrough();
}

/* ─── JSON-RPC ──────────────────────────────────────────────────────── */

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

/** Read a request body as text, refusing anything over the cap. */
function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** A JSON-RPC-level failure (bad params, unknown method). */
class RpcFailure extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/** Start one in-process MCP server on an ephemeral loopback port. */
export async function startHostMcpServer(opts: HostMcpServerOptions): Promise<HostMcpServer> {
  const token = randomBytes(24).toString("hex");
  const path = `/mcp/${token}`;
  const version = opts.version ?? "1.0.0";
  const maxBody = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  const listTools = (): Array<Record<string, unknown>> =>
    opts.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: zodToJsonSchema(toolArgValidator(tool)),
      ...(opts.alwaysLoad ? { _meta: { "anthropic/alwaysLoad": true } } : {}),
    }));

  const callTool = async (params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const name = params["name"];
    const tool = typeof name === "string" ? opts.tools.find((t) => t.name === name) : undefined;
    if (!tool) throw new RpcFailure(-32602, `Unknown tool: ${String(name)}`);
    const args = (params["arguments"] ?? {}) as Record<string, unknown>;
    const parsed = toolArgValidator(tool).safeParse(args);
    if (!parsed.success) {
      const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
      return { content: [{ type: "text", text: `Invalid arguments for ${tool.name}: ${detail}` }], isError: true };
    }
    try {
      return (await tool.handler(parsed.data as Record<string, unknown>)) as unknown as Record<string, unknown>;
    } catch (err) {
      // A tool that throws is a tool error, not a protocol error: the model
      // reads the message and can recover.
      const message = err instanceof Error ? err.message : String(err);
      opts.log?.warn(`host mcp ${opts.name}: tool ${tool.name} failed: ${message}`);
      return { content: [{ type: "text", text: `Tool ${tool.name} failed: ${message}` }], isError: true };
    }
  };

  /** Handle one JSON-RPC message; null for notifications (no reply). */
  const dispatch = async (msg: JsonRpcRequest): Promise<Record<string, unknown> | null> => {
    const { id, method } = msg;
    const isNotification = id === undefined || id === null;
    const params = (msg.params ?? {}) as Record<string, unknown>;
    if (method === "initialize") {
      const requested = params["protocolVersion"];
      const protocolVersion =
        typeof requested === "string" && /^\d{4}-\d{2}-\d{2}$/.test(requested)
          ? requested
          : DEFAULT_PROTOCOL_VERSION;
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: opts.name, version },
        ...(opts.instructions ? { instructions: opts.instructions } : {}),
      });
    }
    if (typeof method === "string" && method.startsWith("notifications/")) return null;
    if (isNotification) return null;
    if (method === "ping") return rpcResult(id, {});
    if (method === "tools/list") return rpcResult(id, { tools: listTools() });
    if (method === "tools/call") return rpcResult(id, await callTool(params));
    if (method === "resources/list") return rpcResult(id, { resources: [] });
    if (method === "resources/templates/list") return rpcResult(id, { resourceTemplates: [] });
    if (method === "prompts/list") return rpcResult(id, { prompts: [] });
    throw new RpcFailure(-32601, `Method not found: ${String(method)}`);
  };

  let server: Server;
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const reply = (status: number, body: unknown): void => {
      if (res.writableEnded) return;
      if (body === undefined) {
        res.writeHead(status);
        res.end();
        return;
      }
      const payload = JSON.stringify(body);
      res.writeHead(status, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
        "cache-control": "no-store",
      });
      res.end(payload);
    };

    if (req.url?.split("?")[0] !== path) {
      // Wrong path (no token, or a scan): look like nothing is here.
      reply(404, undefined);
      return;
    }
    const host = req.headers.host ?? "";
    const expected = `127.0.0.1:${port}`;
    if (host !== expected && host !== `localhost:${port}`) {
      reply(403, undefined);
      return;
    }
    if (req.method === "GET") {
      // A stateless server has no server→client stream.
      res.setHeader("allow", "POST, DELETE");
      reply(405, undefined);
      return;
    }
    if (req.method === "DELETE") {
      reply(204, undefined);
      return;
    }
    if (req.method !== "POST") {
      res.setHeader("allow", "POST, DELETE");
      reply(405, undefined);
      return;
    }

    let body: unknown;
    try {
      body = JSON.parse(await readBody(req, maxBody));
    } catch (err) {
      opts.log?.warn(`host mcp ${opts.name}: unreadable request body: ${(err as Error).message}`);
      reply(400, undefined);
      return;
    }
    const messages: JsonRpcRequest[] = Array.isArray(body) ? (body as JsonRpcRequest[]) : [body as JsonRpcRequest];
    if (messages.some((m) => !m || typeof m !== "object")) {
      reply(400, rpcError(null, -32600, "Invalid Request"));
      return;
    }
    const responses: Array<Record<string, unknown>> = [];
    for (const message of messages) {
      try {
        const response = await dispatch(message);
        if (response) responses.push(response);
      } catch (err) {
        if (err instanceof RpcFailure) {
          responses.push(rpcError(message.id ?? null, err.code, err.message));
        } else {
          opts.log?.error(`host mcp ${opts.name}: internal error: ${(err as Error).message}`);
          responses.push(rpcError(message.id ?? null, -32603, "Internal error"));
        }
      }
    }
    // Notifications get no body; a batch of only notifications is a 202.
    if (responses.length === 0) {
      reply(202, undefined);
      return;
    }
    reply(200, Array.isArray(body) ? responses : responses[0]);
  };

  let port = 0;
  server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      opts.log?.error(`host mcp ${opts.name}: request failed: ${(err as Error).message}`);
      if (!res.writableEnded) {
        res.writeHead(500);
        res.end();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  port = typeof address === "object" && address ? address.port : 0;
  const url = `http://127.0.0.1:${port}${path}`;
  opts.log?.info(`host mcp: serving ${opts.name} (${opts.tools.length} tools) on 127.0.0.1:${port}`);

  return {
    config: { type: "http", url },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
