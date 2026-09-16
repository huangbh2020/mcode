/**
 * Headless smoke for the auto-orchestration planner stream (renderer side).
 *
 * Drives the REAL sessionStore's startOrchestrationFlow against a stubbed
 * api: while the proposePlan RPC is pending, synthetic planner.delta events
 * are pushed through ingestOrchEvent — the same path production uses. Asserts
 * that the 「拆解中」placeholder message grows the streamed thinking/text
 * segments in arrival order (via the same deltaBuf machinery normal turns
 * use), that the static placeholder text is dropped on the first delta, that
 * the canvas replacement happens on settle, and that straggler deltas after
 * the flow ends never pollute the replaced message.
 *
 * Bundle with run.sh (esbuild; only @renderer/lib/api.js is aliased).
 */
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import type { OrchestratorEvent } from "@contracts/orchestration";
import { settleProposePlan, settleProposePlanError, abortPlanCallCount } from "./stubs.js";

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

const SID = "s1";
const HOST_ID = `orch_host_u_1`;

/** Seed the store the way sendPrompt's interception leaves it: user message
 *  already in the bucket + 「拆解中」placeholder (startOrchestrationFlow
 *  appends its own placeholder — we run the real action, no seeding needed
 *  beyond the session key existing). `model` seeds the composer's send-model
 *  anchor that the message header (turnMeta.model) is stamped from. */
useSessionStore.setState((s) => ({
  messagesBySession: { ...s.messagesBySession, [SID]: [] },
  activeSessionId: SID,
  model: "test-model",
}));

const delta = (seg: "text" | "thinking", text: string): OrchestratorEvent => ({
  kind: "planner.delta",
  sessionId: SID,
  seg,
  text,
});

// ── drive the real flow ──
const flow = useSessionStore.getState().startOrchestrationFlow(SID, "帮我调研并写一份方案");
// proposePlan is pending now; the placeholder bubble is in the bucket.
await sleep(0);

let list = useSessionStore.getState().messagesBySession[SID] ?? [];
check("flow registered: user msg + placeholder in bucket", list.length === 2, list.length);
const host = list.find((m) => m.id.startsWith("orch_host_"));
check("placeholder carries the static 拆解中 text block", host?.blocks.length === 1 && host.blocks[0].kind === "text", host?.blocks);

// ── 消息头(与普通回合同款):占位消息自带 turnMeta(模型 · 开始时间,
//    endedAt 未定 = 运行中),会话按「运行中」呈现(流式台账 + 停止键)。
const st0 = useSessionStore.getState();
check(
  "placeholder carries a live turnMeta header (model anchor, no endedAt)",
  !!host?.turnMeta &&
    host.turnMeta.endedAt === undefined &&
    host.turnMeta.model === "test-model" &&
    typeof host.turnMeta.startedAt === "number",
  host?.turnMeta,
);
check(
  "session flips to running during decomposition (ledger + stop button)",
  st0.runningBySession[SID] === true && st0.runningTurnStartedAt[SID] != null && st0.runningTurnModelBySession[SID] === "test-model",
  { running: st0.runningBySession[SID], startedAt: st0.runningTurnStartedAt[SID], model: st0.runningTurnModelBySession[SID] },
);

// ── stream synthetic planner deltas (order: thinking → text → text) ──
useSessionStore.getState().ingestOrchEvent(delta("thinking", "先想一下拆法;"));
useSessionStore.getState().ingestOrchEvent(delta("text", '{"tasks":['));
useSessionStore.getState().ingestOrchEvent(delta("text", '{"spec":"a"}]}'));

// First delta must have dropped the static text block synchronously.
list = useSessionStore.getState().messagesBySession[SID] ?? [];
const streaming = list.find((m) => m.id.startsWith("orch_host_"));
check("first delta cleared the static placeholder text", streaming?.blocks.length === 0, streaming?.blocks);

// Deltas are buffered (adaptive flush: rAF fallback = setTimeout in Node).
await sleep(60);
list = useSessionStore.getState().messagesBySession[SID] ?? [];
const grown = list.find((m) => m.id.startsWith("orch_host_"))!;
check(
  "streamed blocks landed in arrival order (thinking, then merged text)",
  grown.blocks.length === 2 &&
    grown.blocks[0].kind === "thinking" &&
    (grown.blocks[0] as { text: string }).text === "先想一下拆法;" &&
    grown.blocks[1].kind === "text" &&
    (grown.blocks[1] as { text: string }).text === '{"tasks":[{"spec":"a"}]}',
  grown.blocks,
);

// ── settle: the planner returns a proposal → placeholder replaced by canvas ──
settleProposePlan([{ spec: "do it", deps: [] }]);
await flow;
await sleep(0);

list = useSessionStore.getState().messagesBySession[SID] ?? [];
const replaced = list.find((m) => m.id.startsWith("orch_host_"));
check(
  "host keeps the streamed model output, canvas + summary appended after it",
  replaced?.blocks.length === 4 &&
    replaced.blocks[0].kind === "thinking" &&
    replaced.blocks[1].kind === "text" &&
    (replaced.blocks[1] as { text: string }).text === '{"tasks":[{"spec":"a"}]}' &&
    replaced.blocks[2].kind === "orch-canvas" &&
    replaced.blocks[3].kind === "text",
  replaced?.blocks.map((b) => b.kind),
);
// 收尾:头部翻成回执行(endedAt 定格「用时」),running 旗标与锚点释放。
const st1 = useSessionStore.getState();
check(
  "final header freezes the duration (endedAt set, model kept)",
  !!replaced?.turnMeta && replaced.turnMeta.endedAt !== undefined && replaced.turnMeta.model === "test-model",
  replaced?.turnMeta,
);
check(
  "running flag + send-time anchors released after the flow",
  st1.runningBySession[SID] === false &&
    st1.runningTurnStartedAt[SID] === undefined &&
    st1.runningTurnModelBySession[SID] === undefined &&
    st1.orchDecomposingBySession[SID] === undefined,
  { running: st1.runningBySession[SID], startedAt: st1.runningTurnStartedAt[SID], decomposing: st1.orchDecomposingBySession[SID] },
);

// ── straggler delta after the flow ends must NOT pollute the canvas message ──
useSessionStore.getState().ingestOrchEvent(delta("text", "STRAGGLER"));
await sleep(60);
list = useSessionStore.getState().messagesBySession[SID] ?? [];
const after = list.find((m) => m.id.startsWith("orch_host_"))!;
check("straggler delta dropped after flow teardown", after.blocks.length === 4, after.blocks.map((b) => b.kind));
check("no STRAGGLER text anywhere in the bucket", !JSON.stringify(list).includes("STRAGGLER"));

// ── 场景二:拆解期间点停止 → 真正中止 planner + 中性「已停止」卡片 ──
useSessionStore.setState((s) => ({
  messagesBySession: { ...s.messagesBySession, [SID]: [] },
  orchRunsBySession: { ...s.orchRunsBySession, [SID]: [] },
}));
const flow2 = useSessionStore.getState().startOrchestrationFlow(SID, "第二个目标");
await sleep(0);
useSessionStore.getState().ingestOrchEvent(delta("text", '{"partial":'));
await sleep(60);
check(
  "scenario 2: flow is decomposing again (deltas streaming)",
  useSessionStore.getState().orchDecomposingBySession[SID] === true,
  useSessionStore.getState().orchDecomposingBySession[SID],
);

// 用户点停止:interrupt() 应冻结头部 + 置停止旗标 + 调 abortPlan 中止 main
// 侧 planner query(修复前停止键只是摆设,planner 会继续跑到超时)。
await useSessionStore.getState().interrupt(SID);
check(
  "stop during decomposition aborts the planner query (orch.abortPlan)",
  abortPlanCallCount() === 1,
  abortPlanCallCount(),
);
check(
  "stop flag set + open turnMeta frozen by interrupt()",
  useSessionStore.getState().orchStoppedBySession[SID] === true,
  useSessionStore.getState().orchStoppedBySession,
);

// main 侧 query 被中止后,proposePlan RPC 以 error 形态返回(SDK abort 文案
// 已在 main 翻译成中文)。
settleProposePlanError("已停止自动拆解");
await flow2;
await sleep(0);

list = useSessionStore.getState().messagesBySession[SID] ?? [];
const stoppedHost = list.find((m) => m.id.startsWith("orch_host_"));
check(
  "stopped flow renders the neutral stopped card (streamed output kept, no error card)",
  stoppedHost?.blocks.length === 2 &&
    stoppedHost.blocks[0].kind === "text" &&
    (stoppedHost.blocks[0] as { text: string }).text === '{"partial":' &&
    stoppedHost.blocks[1].kind === "text" &&
    (stoppedHost.blocks[1] as { text: string }).text.includes("已停止自动拆解"),
  stoppedHost?.blocks.map((b) => b.kind),
);
const st2 = useSessionStore.getState();
check(
  "stop path releases flags (stopped/decomposing/running) after the flow",
  st2.orchStoppedBySession[SID] === undefined &&
    st2.orchDecomposingBySession[SID] === undefined &&
    st2.runningBySession[SID] === false,
  { stopped: st2.orchStoppedBySession[SID], decomposing: st2.orchDecomposingBySession[SID], running: st2.runningBySession[SID] },
);

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nall assertions passed");
process.exit(0);
