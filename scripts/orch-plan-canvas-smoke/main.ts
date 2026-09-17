/**
 * Headless smoke for the in-session decompose canvas wiring (renderer side).
 *
 * Scenario against the REAL sessionStore:
 *  plan.proposed reducer — main 的 orch_submit_plan handler 钳制建卡后推送
 *  {kind:"plan.proposed", run};canvas 块必须挂到当前回合最后一条
 *  assistant 消息(工具调用所在那条)上且幂等(重复事件不重复追加),
 *  run 进 orchRunsBySession;无 assistant 消息可挂时兜底自建画布消息。
 *
 * Bundle with run.sh (esbuild; only @renderer/lib/api.js is aliased).
 */
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import type { OrchestratorEvent } from "@contracts/orchestration";
import { makeRun } from "./stubs.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`ok - ${name}`);
  } else {
    failures++;
    console.error(`FAIL - ${name}`, detail === undefined ? "" : JSON.stringify(detail));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── 场景①:plan.proposed 挂画布(会话内拆解回合) ──
const SID = "s1";
useSessionStore.setState((s) => ({
  messagesBySession: {
    ...s.messagesBySession,
    [SID]: [
      { id: "u_1", sessionId: SID, role: "user", blocks: [{ kind: "text", text: "做个网站" }], createdAt: 1 },
      {
        id: "a_1",
        sessionId: SID,
        role: "assistant",
        blocks: [{ kind: "tool_use", toolCallId: "call1", toolName: "mcp__mcode-orchestrator__orch_submit_plan", input: { goal: "demo goal", tasks: [{ spec: "do it" }] }, status: "running" }],
        createdAt: 2,
        turnMeta: { startedAt: 2, model: "test-model" },
      },
    ],
  },
  activeSessionId: SID,
  model: "test-model",
}));

const run = makeRun(SID);
const proposed: OrchestratorEvent = { kind: "plan.proposed", sessionId: SID, run: run as never };
useSessionStore.getState().ingestOrchEvent(proposed);
await sleep(0);

let list = useSessionStore.getState().messagesBySession[SID] ?? [];
check("no new message row — canvas attaches to the tool-call message", list.length === 2, list.length);
const a1 = list.find((m) => m.id === "a_1");
const canvasBlocks = (a1?.blocks ?? []).filter((b) => b.kind === "orch-canvas");
check("canvas block appended to the last assistant message", canvasBlocks.length === 1, a1?.blocks);
const canvas = canvasBlocks[0] as { kind: "orch-canvas"; runId: string; goal: string } | undefined;
check("canvas anchors the proposed run", canvas?.runId === "run_1", canvas);
check("canvas carries the run goal", canvas?.goal === "demo goal", canvas);
check("tool_use block still precedes the canvas", a1?.blocks[0]?.kind === "tool_use", a1?.blocks.map((b) => b.kind));
check("run landed in the session bucket", (useSessionStore.getState().orchRunsBySession[SID] ?? []).some((r) => r.id === "run_1"));

// 幂等:同一 run 的重复事件(run.updated 先到/多端回放)不得二次追加。
useSessionStore.getState().ingestOrchEvent(proposed);
await sleep(0);
list = useSessionStore.getState().messagesBySession[SID] ?? [];
const a1Again = list.find((m) => m.id === "a_1");
check(
  "duplicate plan.proposed does not duplicate the canvas block",
  (a1Again?.blocks ?? []).filter((b) => b.kind === "orch-canvas").length === 1,
  a1Again?.blocks.map((b) => b.kind),
);

// ── 场景②:消息流里没有 assistant 消息(异常时序)→ 兜底自建画布消息。 ──
const SID2 = "s2";
useSessionStore.setState((s) => ({
  messagesBySession: { ...s.messagesBySession, [SID2]: [{ id: "u_2", sessionId: SID2, role: "user", blocks: [{ kind: "text", text: "x" }], createdAt: 3 }] },
}));
useSessionStore.getState().ingestOrchEvent({ kind: "plan.proposed", sessionId: SID2, run: makeRun(SID2) as never });
await sleep(0);
const list2 = useSessionStore.getState().messagesBySession[SID2] ?? [];
const synth = list2.find((m) => m.id.startsWith("orch_canvas_"));
check("fallback synthesized a canvas-only message", !!synth && synth.blocks.some((b) => b.kind === "orch-canvas"), list2.map((m) => m.id));

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nall assertions passed");
