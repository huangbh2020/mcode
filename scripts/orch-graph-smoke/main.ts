/**
 * Headless smoke for the canvas drag-to-rewire pure-function layer
 * (renderer/lib/orchGraph.ts): drop verdicts per dragged-end role
 * (self/locked/cycle/depth/duplicate), commit plans for rewire/create/delete
 * (remove-before-add ordering), and semantic alignment with the backend's
 * validateTaskGraph gates. The module is pure — bundled directly, no stubs.
 */
import { dropVerdict, planEdgeDelete, planEdgeMove, taskEditable, MAX_DAG_DEPTH } from "@renderer/lib/orchGraph.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`ok - ${name}`);
  } else {
    failures++;
    console.error(`FAIL - ${name}`, detail === undefined ? "" : JSON.stringify(detail));
  }
}

interface T {
  id: string;
  deps: string[];
  status?: string;
}
/** Build TaskNode-shaped inputs (only the fields orchGraph reads). */
const mk = (rows: T[]) =>
  rows.map((r) => ({
    id: r.id,
    deps: r.deps,
    status: (r.status ?? "pending") as "pending",
    spec: r.id,
    artifacts: [],
    result: null,
    failureCount: 0,
    dispatches: [],
    worktreePath: null,
    reviewRound: 0,
    estTokens: 0,
    variantGroup: null,
    reviewOf: null,
    tags: [],
    runner: "agent" as const,
    profileId: null,
    customModelId: null,
    providerId: null,
    model: null,
    effort: null,
    permissionMode: null,
    terminalCommand: null,
  }));

/* ── graph under test:
 *   A → B → D
 *   A → C
 *   (E standalone)                                            */
const tasks = mk([
  { id: "A", deps: [] },
  { id: "B", deps: ["A"] },
  { id: "C", deps: ["A"] },
  { id: "D", deps: ["B"] },
  { id: "E", deps: [] },
]);

/* ── verdicts:downstream role(抓箭头端,最终边 target deps fixed)── */

check("self-drop rejected", !dropVerdict(tasks, "A", "B", "A", "downstream").ok);
check("self-drop reason", dropVerdict(tasks, "A", "B", "A", "downstream").reason === "self");

check("move D's arrowhead B→E ok (E deps B)", dropVerdict(tasks, "B", "D", "E", "downstream").ok === true);
check("dropping back onto the original end is allowed (no-op)", dropVerdict(tasks, "A", "B", "B", "downstream").ok === true);

const dup = dropVerdict(tasks, "A", "E", "B", "downstream");
check("existing edge reported as duplicate", !dup.ok && dup.reason === "duplicate", dup);

// cycle: make A depend on D (D already hangs under A via B).
const cyc = dropVerdict(tasks, "D", "E", "A", "downstream");
check("downstream drop closing a ring rejected as cycle", !cyc.ok && cyc.reason === "cycle", cyc);

// create-case cycle (dragged === fixed, from an out-port): existing edge
// C→A (A deps C); dragging A's out-port onto C closes C→A→C.
const withChain = mk([
  { id: "A", deps: [] },
  { id: "B", deps: ["A"] },
  { id: "D", deps: ["B"] },
]);
const createCyc = dropVerdict(
  mk([
    { id: "C", deps: [] },
    { id: "A", deps: ["C"] },
  ]),
  "A",
  "A",
  "C",
  "downstream",
);
check("create-drag cycle is caught (not skipped by dragged===fixed)", !createCyc.ok && createCyc.reason === "cycle", createCyc);
// sanity: a diamond (A→B→D plus direct A→D) is NOT a cycle — legal.
check("diamond dependency is not a cycle", dropVerdict(withChain, "A", "A", "D", "downstream").ok === true);

// locked: running target for a downstream drop.
const running = tasks.map((t) => (t.id === "E" ? { ...t, status: "running" as "running" } : t));
const lk = dropVerdict(running, "A", "B", "E", "downstream");
check("running target locked", !lk.ok && lk.reason === "locked", lk);
// locked: rewire mutates the dragged task too (strip its old dep).
const dragLocked = tasks.map((t) => (t.id === "B" ? { ...t, status: "completed" as "completed" } : t));
const lk2 = dropVerdict(dragLocked, "A", "B", "E", "downstream");
check("completed dragged end locks the rewire", !lk2.ok && lk2.reason === "locked", lk2);
// NOT locked: completed fixed end is untouched by a downstream rewire.
const fixedDone = tasks.map((t) => (t.id === "A" ? { ...t, status: "completed" as "completed" } : t));
check("completed fixed end does NOT lock a downstream rewire", dropVerdict(fixedDone, "A", "B", "E", "downstream").ok === true);

/* ── verdicts:upstream role(抓尾巴端,最终边 fixed deps target)── */

check("rewire B's upstream A→E ok", dropVerdict(tasks, "B", "A", "E", "upstream").ok === true);
// completed new upstream is fine (only fixed is written).
const doneTarget = tasks.map((t) => (t.id === "E" ? { ...t, status: "completed" as "completed" } : t));
check("completed target as new upstream allowed", dropVerdict(doneTarget, "B", "A", "E", "upstream").ok === true);
// but a completed fixed (the task being mutated) locks it.
const doneFixed = tasks.map((t) => (t.id === "B" ? { ...t, status: "completed" as "completed" } : t));
const lkUp = dropVerdict(doneFixed, "B", "A", "E", "upstream");
check("completed fixed locks the upstream rewire", !lkUp.ok && lkUp.reason === "locked", lkUp);
// cycle: rewire A's tail so that A depends on D (A⇝D already).
const cycUp = dropVerdict(tasks, "A", "C", "D", "upstream");
check("upstream drop closing a ring rejected as cycle", !cycUp.ok && cycUp.reason === "cycle", cycUp);
// duplicate: B already deps A and you drag the tail of some other edge onto A.
// Build: B deps [A, F], edge F→B tail dragged onto A.
const dupUp = dropVerdict(
  mk([{ id: "A", deps: [] }, { id: "F", deps: [] }, { id: "B", deps: ["A", "F"] }]),
  "B",
  "F",
  "A",
  "upstream",
);
check("upstream duplicate edge rejected", !dupUp.ok && dupUp.reason === "duplicate", dupUp);
check("upstream drop back onto original end is a no-op ok", dropVerdict(tasks, "B", "A", "A", "upstream").ok === true);
check("upstream self (fixed===target) rejected", dropVerdict(tasks, "A", "E", "A", "upstream").reason === "self");

/* ── depth ── */

check("MAX_DAG_DEPTH mirrors backend constant", MAX_DAG_DEPTH === 4);
// chain of 4: hanging E under D reaches exactly 4 — ok.
const deep = mk([
  { id: "A", deps: [] },
  { id: "B", deps: ["A"] },
  { id: "C", deps: ["B"] },
  { id: "D", deps: ["C"] },
  { id: "E", deps: [] },
]);
check("chain of 4 at the limit", dropVerdict(deep, "C", "D", "E", "downstream").ok === true);
// A→B→C→D is depth 4; E→D would make depth 5.
const over = mk([
  { id: "A", deps: [] },
  { id: "B", deps: ["A"] },
  { id: "C", deps: ["B"] },
  { id: "D", deps: ["C"] },
  { id: "E", deps: ["D"] },
  { id: "F", deps: [] },
]);
const d = dropVerdict(over, "D", "E", "F", "downstream");
check("depth 5 rejected", !d.ok && d.reason === "depth", d);
// same via upstream role.
const dUp = dropVerdict(over, "F", "E", "D", "upstream");
check("depth 5 rejected via upstream role", !dUp.ok && dUp.reason === "depth", dUp);

// editable statuses mirror OrchestratorService.updateTask's gate.
check("pending editable", taskEditable(mk([{ id: "x", deps: [] }])[0]));
check("failed editable", taskEditable({ ...mk([{ id: "x", deps: [] }])[0], status: "failed" }));
check("completed not editable", !taskEditable({ ...mk([{ id: "x", deps: [] }])[0], status: "completed" }));
check("running not editable", !taskEditable({ ...mk([{ id: "x", deps: [] }])[0], status: "running" }));

/* ── commit plans ── */

// downstream rewire: A→B becomes A→E — REMOVE first (intermediate never
// deepens), then ADD.
const rewire = planEdgeMove(tasks, "A", "B", "E", "downstream");
check(
  "downstream rewire: remove B's dep first, then add to E",
  rewire.mutations.length === 2 &&
    rewire.mutations[0].taskId === "B" && rewire.mutations[0].deps.length === 0 &&
    rewire.mutations[1].taskId === "E" && rewire.mutations[1].deps.join() === "A",
  rewire.mutations,
);
check(
  "rewire rollback restores both original dep lists",
  rewire.rollback.length === 2 &&
    rewire.rollback.some((r) => r.taskId === "E" && r.deps.length === 0) &&
    rewire.rollback.some((r) => r.taskId === "B" && r.deps.join() === "A"),
  rewire.rollback,
);

// upstream rewire: single ATOMIC mutation on the fixed/downstream task
// (B's deps A→E) — no intermediate state at all.
const rewireUp = planEdgeMove(tasks, "B", "A", "E", "upstream");
check(
  "upstream rewire: single atomic mutation on B (deps A→E)",
  rewireUp.mutations.length === 1 && rewireUp.mutations[0].taskId === "B" && rewireUp.mutations[0].deps.join() === "E",
  rewireUp.mutations,
);
check(
  "upstream rewire rollback restores B's original deps",
  rewireUp.rollback.length === 1 && rewireUp.rollback[0].taskId === "B" && rewireUp.rollback[0].deps.join() === "A",
  rewireUp.rollback,
);

// create from out-port: single add mutation.
const create = planEdgeMove(tasks, "A", "A", "E", "downstream");
check(
  "create plan: single add mutation",
  create.mutations.length === 1 && create.mutations[0].taskId === "E" && create.mutations[0].deps.join() === "A",
  create.mutations,
);
// create from in-port (role=upstream): fixed gains dep target.
const createIn = planEdgeMove(tasks, "E", "E", "A", "upstream");
check(
  "create via in-port: fixed gains dep on target",
  createIn.mutations.length === 1 && createIn.mutations[0].taskId === "E" && createIn.mutations[0].deps.join() === "A",
  createIn.mutations,
);

// drop back onto the original end: no-op.
check("no-op plan has zero mutations", planEdgeMove(tasks, "A", "B", "B", "downstream").mutations.length === 0);

// delete edge A→B.
const del = planEdgeDelete(tasks, "A", "B");
check(
  "delete plan strips B's dep on A with rollback",
  del.mutations.length === 1 && del.mutations[0].taskId === "B" && del.mutations[0].deps.length === 0 &&
    del.rollback.length === 1 && del.rollback[0].deps.join() === "A",
  del,
);
check("delete of missing edge is a no-op", planEdgeDelete(tasks, "E", "B").mutations.length === 0);

/* ── applied-result semantics: simulate the mutations and verify ── */

const applyAll = (base: ReturnType<typeof mk>, plan: { mutations: { taskId: string; deps: string[] }[] }) =>
  base.map((t) => {
    const m = plan.mutations.find((x) => x.taskId === t.id);
    return m ? { ...t, deps: m.deps } : t;
  });

// After downstream rewire A→B ⇒ A→E: A→E exists, A→B gone.
const after = applyAll(tasks, rewire);
check("applied downstream rewire: B lost dep A", after.find((t) => t.id === "B")!.deps.length === 0);
check("applied downstream rewire: E gained dep A", after.find((t) => t.id === "E")!.deps.join() === "A");

// After upstream rewire (B's dep A→E): only B changed.
const afterUp = applyAll(tasks, rewireUp);
check("applied upstream rewire: B deps A→E", afterUp.find((t) => t.id === "B")!.deps.join() === "E");
check("applied upstream rewire: A untouched", afterUp.find((t) => t.id === "A")!.deps.length === 0);

// Remove-before-add ordering keeps the intermediate depth-safe: chain
// A→B→C→D (depth 4) rewire B's arrowhead A→B to A→D would hit depth 5 in
// the FINAL state too, so construct a legal-but-order-sensitive case:
// A→B→C→D plus rewire C's arrowhead B→C to B→... hmm — an order-sensitive
// legal case: move B's arrowhead off A onto E where E already has deep deps.
const orderGraph = mk([
  { id: "A", deps: [] },
  { id: "X", deps: [] },
  { id: "Y", deps: ["X"] },
  { id: "Z", deps: ["Y"] }, // chain X→Y→Z = depth 3
  { id: "B", deps: ["A"] },
  { id: "C", deps: ["B"] },
]);
// Drag B's arrowhead from A onto Z ⇒ final: Z→B→C depth 3, A isolated.
// Add-first intermediate: B deps [A, Z] ⇒ A→B→C (2) and Z→B→C (3) — legal
// here; the ordering claim is exercised by construction in planEdgeMove.
const orderPlan = planEdgeMove(orderGraph, "A", "B", "Z", "downstream");
check(
  "order-sensitive rewire: remove precedes add",
  orderPlan.mutations.length === 2 &&
    orderPlan.mutations[0].taskId === "B" &&
    orderPlan.mutations[1].taskId === "Z",
  orderPlan.mutations,
);

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nall assertions passed");
process.exit(0);
