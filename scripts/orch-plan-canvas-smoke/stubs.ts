/**
 * Stubs for the plan-canvas renderer smoke (see main.ts).
 *
 * Only @renderer/lib/api.js is aliased — everything else the sessionStore
 * pulls in at module init is pure TS (i18n dictionaries, contracts, lib
 * helpers) or type-only (monaco). The stub api records the flow's RPCs while
 * the smoke drives ingestOrchEvent with a synthetic plan.proposed event —
 * the same path production uses (main 的 orch_submit_plan handler 钳制建卡
 * 后推送).
 */

/** createRun calls captured by scenario assertions. */
let createRunCalls = 0;
let runSeq = 0;

export function makeRun(sessionId: string): Record<string, unknown> {
  runSeq += 1;
  return {
    id: `run_${runSeq}`,
    parentSessionId: sessionId,
    projectId: "p1",
    title: "t",
    goal: "demo goal",
    status: "planning",
    tasks: [{ id: "t1", spec: "do it", deps: [], status: "pending", artifacts: [], result: null, failureCount: 0, dispatches: [], worktreePath: null, reviewRound: 0, estTokens: 1 }],
    gates: [],
    budgetUsd: null,
    spentUsd: 0,
    concurrency: 4,
    worktreePolicy: "auto",
    heartbeat: {},
    templateId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export const api = {
  session: {
    upsertMessages: async () => {},
  },
  claude: {
    interrupt: async () => {},
  },
  orch: {
    // @agents 骨架流仍走 createRun RPC(会话内拆解的 run 由 main 的工具
    // handler 创建,渲染端只消费 plan.proposed,不调它)。
    createRun: async (input: { sessionId: string }) => {
      createRunCalls++;
      return { run: makeRun(input.sessionId) };
    },
    listRuns: async () => ({ runs: [] }),
  },
  setting: {
    get: async () => null,
    set: async () => ({}),
  },
};

export function createRunCallCount(): number {
  return createRunCalls;
}

export const isElectron = true;
