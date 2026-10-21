/**
 * END-TO-END probe: drive the REAL OpencodeProvider.startTurn against the
 * user's real opencode CLI (free Zen model) with a bash-forcing prompt.
 * Exercises the full production path: server spawn → session create → flat
 * prompt → global bus → adapter (text/reasoning/tool/usage events) →
 * permission bridge (acceptEdits + approval card) → execution.succeeded →
 * turn.done → done promise resolution.
 */
import type { RuntimeEvent } from "@contracts/runtime";
import type { ProviderContext, TurnHandle } from "@contracts/provider";
import { OpencodeProvider } from "@main/providers/opencode-sdk/OpencodeProvider.js";

const FREE_MODEL = "opencode/minimax-m3.1-flash-free";
const BUDGET_MS = 240_000;

async function main() {
  const provider = new OpencodeProvider();
  const events: RuntimeEvent[] = [];
  const approvals: string[] = [];
  let providerSessionId: string | null = null;

  const ctx: ProviderContext = {
    emit: (e) => {
      events.push(e);
      if (e.type === "text.delta") process.stdout.write(e.text);
      if (e.type === "thinking") { /* streamed below in summary */ }
    },
    log: {
      info: (...a: unknown[]) => console.log("[info]", ...a),
      warn: (...a: unknown[]) => console.warn("[warn]", ...a),
      error: (...a: unknown[]) => console.error("[error]", ...a),
    },
    getPermissionMode: () => "acceptEdits",
    isToolAlwaysAllowed: () => false,
    requestApproval: async (r) => {
      approvals.push(`${r.toolName}: ${JSON.stringify(r.input)?.slice(0, 120)}`);
      console.log(`\n[approval card] ${r.toolName} ${JSON.stringify(r.input).slice(0, 160)} → ALLOW`);
      return { allow: true };
    },
    onProviderSessionId: (id) => {
      providerSessionId = id;
      console.log("[provider session id]", id);
    },
  };

  console.log("— startTurn (bash-forcing prompt, acceptEdits) —");
  let handle: TurnHandle;
  try {
    handle = await provider.startTurn(
      {
        sessionId: "probe-e2e-gui",
        prompt: "Use the bash tool to run exactly: echo mcode-probe, then tell me the output.",
        cwd: process.cwd(),
        model: FREE_MODEL,
        permissionMode: "acceptEdits",
        turnNumber: 1,
      },
      ctx,
    );
  } catch (err) {
    console.error("startTurn THREW:", err);
    process.exit(1);
  }

  const reason = await Promise.race([
    handle.done.then(() => "done" as const),
    new Promise<"timeout">((r) => setTimeout(() => r("timeout"), BUDGET_MS)),
  ]);

  console.log("\n\n===== SUMMARY =====");
  console.log("handle done:", reason, "| running after:", handle.isRunning());
  console.log("provider session id:", providerSessionId);
  console.log("approvals surfaced:", approvals.length ? approvals : "(none)");

  const counts = new Map<string, number>();
  for (const e of events) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  console.log("event counts:", JSON.stringify(Object.fromEntries([...counts.entries()].sort())));

  const textAll = events
    .filter((e): e is Extract<RuntimeEvent, { type: "text.delta" }> => e.type === "text.delta")
    .map((e) => e.text)
    .join("");
  console.log("assistant text:", JSON.stringify(textAll.slice(0, 300)));
  const thinking = events
    .filter((e): e is Extract<RuntimeEvent, { type: "thinking" }> => e.type === "thinking")
    .map((e) => e.text)
    .join("");
  console.log("thinking chars:", thinking.length);
  const tools = events.filter((e) => e.type === "tool.use" || e.type === "tool.result");
  for (const t of tools) {
    const tu = t as { type: string; toolName?: string; toolCallId: string; isError?: boolean };
    console.log(`  ${tu.type}: ${tu.toolName ?? ""} ${tu.toolCallId}${tu.isError ? " (error)" : ""}`);
  }
  const usage = events.find((e) => e.type === "token-usage.updated") as
    | { snapshot: { usedTokens: number; pct: number; outputTokens: number } }
    | undefined;
  console.log("usage snapshot:", usage ? `used=${usage.snapshot.usedTokens} pct=${usage.snapshot.pct} out=${usage.snapshot.outputTokens}` : "(none)");
  const bash = events.filter((e) => e.type === "bash-tasks.update") as Array<{ tasks: Array<{ status: string; output?: string }> }>;
  if (bash.length > 0) {
    const last = bash[bash.length - 1].tasks;
    console.log("bash roster:", JSON.stringify(last.map((t) => ({ s: t.status, out: (t.output ?? "").slice(0, 60) }))));
  }
  const doneEv = events.find((e) => e.type === "turn.done") as { reason: string } | undefined;
  console.log("turn.done reason:", doneEv?.reason ?? "(MISSING)");

  const pass =
    reason === "done" &&
    doneEv?.reason === "end_turn" &&
    textAll.length > 0 &&
    approvals.length > 0 &&
    !!usage;
  console.log(pass ? "\nE2E PROBE: PASS" : "\nE2E PROBE: FAIL");
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error("PROBE FAILED:", err);
  process.exit(1);
});
