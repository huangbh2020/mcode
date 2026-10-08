/**
 * Fixture MCP server over stdio (newline-delimited JSON-RPC 2.0) — the
 * minimal surface the official SDK client exercises: initialize handshake,
 * tools/list with one `echo` tool, tools/call echoing its input. Logs go to
 * stderr; stdout carries ONLY protocol frames.
 */
import { createInterface } from "node:readline";

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

const SERVER = { name: "echo-fixture", version: "1.0.0" };

createInterface({ input: process.stdin }).on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let frame;
  try {
    frame = JSON.parse(trimmed);
  } catch {
    return;
  }
  const { id, method, params } = frame;
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        // Echo the client's requested version — always acceptable.
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: SERVER,
      },
    });
    return;
  }
  if (method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        tools: [
          {
            name: "echo",
            description: "Echo the provided input back",
            inputSchema: {
              type: "object",
              properties: { input: { type: "string", description: "Text to echo" } },
              required: ["input"],
            },
          },
        ],
      },
    });
    return;
  }
  if (method === "tools/call") {
    const input = params?.arguments?.input ?? "";
    send({
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: `echo:${input}` }],
        isError: false,
      },
    });
    return;
  }
  if (method === "ping") {
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  // Notifications (notifications/initialized etc.) and unknown methods.
  if (id !== undefined) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
});
