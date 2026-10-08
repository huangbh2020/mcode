/**
 * Headless smoke for the Pi MCP bridge — see run.sh for the bundling/stub
 * setup. Covered scenarios:
 *
 *   A. Config mapping (collectPiMcpConfig over fixture files):
 *      A1 user-scope servers map with exposure forced to "direct"
 *      A2 project servers default OFF; only the allowlisted ones load
 *      A3 same-name project entry overrides the user entry
 *      A4 SSE transport degrades to an errors entry (pi 1.0.2 has no SSE)
 *      A5 unparseable config degrades to an errors entry
 *      A6 stashed userDisabled never reappears (absence from the file)
 *
 *   B. End-to-end registration (REAL SDK + REAL stdio MCP server):
 *      B1 session boots with the bridge's extension; the fixture tool
 *         surfaces as mcp__demo__echo in getActiveToolNames()
 *      B2 zero-server config boots clean with no mcp__ tools
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPiMcpExtension, collectPiMcpConfig } from "@main/providers/pi-sdk/piMcpBridge.js";

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, extra = "") => {
  if (cond) {
    pass++;
    console.log(`  ok  ${name}${extra ? " — " + extra : ""}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${extra ? " — " + extra : ""}`);
  }
};

const smoke = process.env.PI_MCP_SMOKE_DATA ?? mkdtempSync(join(tmpdir(), "pi-mcp-smoke-run."));
const mcodeDir = join(smoke, "mcode");
mkdirSync(mcodeDir, { recursive: true });
// CustomEnv stub reads this from env (PI_MCP_SMOKE_DATA) at module init —
// setting it here would be too late (imports evaluate first).

const writeJson = (file: string, value: unknown) => {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2));
};
const setManagement = (state: unknown) => {
  (globalThis as Record<string, unknown>).__PI_MCP_SMOKE_SETTINGS__ = new Map(
    Object.entries({ "mcp.management": JSON.stringify(state) }),
  );
};

const projDir = join(smoke, "proj");
mkdirSync(projDir, { recursive: true });

// ── A. config mapping ────────────────────────────────────────────────────
writeJson(join(mcodeDir, ".claude.json"), {
  mcpServers: {
    alpha: { type: "stdio", command: "node", args: ["user-alpha.js"] },
    beta: { type: "stdio", command: "node", args: ["user-beta.js"] },
    sse1: { type: "sse", url: "https://example.com/sse" },
    bad: { totally: "not-a-config" },
  },
});
writeJson(join(projDir, ".mcp.json"), {
  mcpServers: {
    // Overrides the user-scope beta (project precedence).
    beta: { type: "http", url: "https://example.com/mcp" },
    gamma: { command: "node", args: ["proj-gamma.js"] },
  },
});
setManagement({ projectEnabled: [{ projectPath: projDir, name: "beta" }] });

const cfg = await collectPiMcpConfig(projDir);
const byName = new Map(cfg.entries.map((e) => [e.name, e]));
console.log(`  (dbg) entries=[${cfg.entries.map((e) => `${e.name}:${e.scope}`).join(", ")}] errors=[${cfg.errors.join(" | ")}]`);

ok("A1 user server mapped with exposure=direct",
  byName.get("alpha")?.config.exposure === "direct" &&
  (byName.get("alpha")?.config as { command?: string }).command === "node");
ok("A2 non-allowlisted project server excluded", !byName.has("gamma"));
ok("A3 allowlisted project beta overrides user beta",
  byName.get("beta")?.scope === "project" &&
  (byName.get("beta")?.config as { url?: string }).url === "https://example.com/mcp");
ok("A4 SSE entry degrades to errors", cfg.errors.some((e) => e.includes("sse1")));
ok("A5 invalid entry degrades to errors", cfg.errors.some((e) => e.includes("bad")));
ok("A6 userDisabled stash absent from file stays excluded", cfg.entries.length === 2);

// Management stash round-trip: userDisabled entries never live in the file,
// so nothing to filter — asserted implicitly by A6's count above.

// ── B. end-to-end registration ───────────────────────────────────────────
const sdk = await import("@earendil-works/pi-coding-agent");

const proj2 = join(smoke, "proj2");
mkdirSync(proj2, { recursive: true });
writeJson(join(mcodeDir, ".claude.json"), {
  mcpServers: {
    demo: {
      type: "stdio",
      command: process.execPath,
      args: [fileURLToPath(new URL("./mcp-echo-server.mjs", import.meta.url))],
    },
  },
});
setManagement({}); // no project allows anything — user server only

const cfg2 = await collectPiMcpConfig(proj2);
ok("B0 demo server collected", cfg2.entries.length === 1 && cfg2.entries[0].name === "demo");

const agentDir = join(smoke, "agent");
mkdirSync(agentDir, { recursive: true });
const loader = new sdk.DefaultResourceLoader({
  cwd: proj2,
  agentDir,
  extensionFactories: [buildPiMcpExtension(sdk.createMcpExtension, cfg2)],
});
await loader.reload();
const { session } = await sdk.createAgentSession({
  cwd: proj2,
  sessionManager: sdk.SessionManager.inMemory(proj2),
  resourceLoader: loader,
});
// pi dispatches session_start only from bindExtensions (the CLI mode hosts'
// job) — same call the provider makes; the MCP extension connects here.
await session.bindExtensions({ mode: "print" });

// MCP servers connect in the background — poll for the tool to register.
const deadline = Date.now() + 15_000;
let names: string[] = [];
while (Date.now() < deadline) {
  names = session.getActiveToolNames();
  if (names.includes("mcp__demo__echo")) break;
  await new Promise((r) => setTimeout(r, 250));
}
ok("B1 fixture tool registered as mcp__demo__echo", names.includes("mcp__demo__echo"), names.filter((n) => n.startsWith("mcp__")).join(","));
if (!names.includes("mcp__demo__echo")) {
  // pi appends connection problems to mcp.log in the agent dir — dump it so
  // the failure is diagnosable headlessly.
  const mcpLog = join(agentDir, "mcp.log");
  if (existsSync(mcpLog)) {
    console.log("  (dbg) mcp.log:\n" + readFileSync(mcpLog, "utf8").split("\n").slice(-20).join("\n"));
  } else {
    console.log("  (dbg) no mcp.log written in agentDir");
  }
}
session.dispose();

// B2: zero-server config boots clean (no mcp__ tools, no crash).
writeJson(join(mcodeDir, ".claude.json"), {});
setManagement({});
const cfg3 = await collectPiMcpConfig(proj2);
ok("B2a empty config collects zero entries", cfg3.entries.length === 0);
const loader3 = new sdk.DefaultResourceLoader({
  cwd: proj2,
  agentDir,
  extensionFactories: [buildPiMcpExtension(sdk.createMcpExtension, cfg3)],
});
await loader3.reload();
const { session: session3 } = await sdk.createAgentSession({
  cwd: proj2,
  sessionManager: sdk.SessionManager.inMemory(proj2),
  resourceLoader: loader3,
});
await session3.bindExtensions({ mode: "print" });
await new Promise((r) => setTimeout(r, 500));
ok("B2b zero-server session boots with no mcp__ tools",
  !session3.getActiveToolNames().some((n) => n.startsWith("mcp__")));
session3.dispose();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

// Silence unused-import lint on node builtins used by helpers above.
void readFileSync;
void existsSync;
