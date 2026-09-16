/**
 * Stubs for the planner-stream renderer smoke (see main.ts).
 *
 * Only @renderer/lib/api.js is aliased — everything else the sessionStore
 * pulls in at module init is pure TS (i18n dictionaries, contracts, lib
 * helpers) or type-only (monaco). The stub api resolves the orchestration
 * flow's two RPCs while letting the smoke drive ingestOrchEvent with
 * synthetic planner.delta events during the pending window.
 */

/** Resolvers the smoke sets per scenario (startOrchestrationFlow's RPCs). */
let resolvePropose: ((v: unknown) => void) | null = null;
let proposeCalls = 0;
let abortPlanCalls = 0;

export const api = {
  session: {
    upsertMessages: async () => {},
  },
  claude: {
    interrupt: async () => {},
  },
  orch: {
    proposePlan: async (_input: unknown) => {
      proposeCalls++;
      return await new Promise((resolve) => {
        resolvePropose = resolve;
      });
    },
    // 渲染端 interrupt() 在拆解期间会调用:真实通道中止 main 侧 planner
    // query;这里只记录调用次数(stop 场景断言用)。
    abortPlan: async (_input: unknown) => {
      abortPlanCalls++;
      return { ok: true };
    },
    createRun: async () => ({
      run: {
        id: "run_1",
        parentSessionId: "s1",
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
      },
    }),
    listRuns: async () => ({ runs: [] }),
  },
  setting: {
    get: async () => null,
    set: async () => ({}),
  },
};

/** Test hook: resolve the pending proposePlan RPC. */
export function settleProposePlan(tasks: unknown[]): void {
  if (!resolvePropose) throw new Error("proposePlan not pending");
  proposeCalls = 0;
  resolvePropose({ tasks });
  resolvePropose = null;
}

/** Test hook: resolve the pending proposePlan RPC with an error payload
 *  (main 侧 abort/超时后的返回形态 —— renderer 把 error 抛给编排流 catch)。 */
export function settleProposePlanError(error: string): void {
  if (!resolvePropose) throw new Error("proposePlan not pending");
  resolvePropose({ tasks: [], error });
  resolvePropose = null;
}

export function abortPlanCallCount(): number {
  return abortPlanCalls;
}

export function proposePending(): boolean {
  return resolvePropose !== null;
}

export function proposeCallCount(): number {
  return proposeCalls;
}

export const isElectron = true;
