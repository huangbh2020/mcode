/**
 * Headless smoke for the split-view (会话分屏) state machinery in the
 * renderer session store — the store-level half of the feature; the React
 * layout (SplitChatArea / SplitPaneCell / composer portal) is desktop-UI
 * and stays covered by manual regression.
 *
 * Covered:
 *
 * 1. addToSplit guard chain — first drag-in seeds the active session as
 *    pane 1; duplicate member degrades to a focus flip; a full 4-pane grid
 *    silently rejects; unknown ids no-op; membership persists to
 *    `ui.splitSessions` and members join openTabs.
 * 2. removeFromSplit focus handoff — removing the focused pane focuses the
 *    next (else previous) survivor; dropping below 2 collapses to the plain
 *    single view and persists [].
 * 3. setDisplayMode("tabs") clears the arrangement; addToSplit arriving
 *    from tabs mode switches to single first.
 * 4. openSessionFromSidebar — split member click = focus; non-member click
 *    REPLACES the focused pane's slot (VS Code active-group semantics).
 * 5. Unread gating — a question.ask for a split member is on-screen (no
 *    badge) even while unfocused; outside the split it badges.
 * 6. sendPrompt row-scoped slots — a send into a NON-active session ships
 *    that session's own row binding (model/effort/permissionMode/
 *    providerId), not the focused session's global composer slots. The
 *    drainPromptQueueIfIdle gate resolves the row too, and a row that
 *    can't resolve keeps its queue head (no drop, no model guard).
 * 7. parseSplitSessionIds hydration validation — dead ids drop, <2
 *    collapses, malformed blobs tolerate.
 *
 * Run: scripts/split-view-smoke/run.sh
 */
import "./prelude.js";
import { smokeSettings, sendTurnCalls } from "./prelude.js";
import {
  useSessionStore,
  parseSplitSessionIds,
  splitCapacityForWidth,
  splitColumnsForWidth,
  SPLIT_PANE_MIN_WIDTH,
  type QueuedPrompt,
} from "@renderer/stores/sessionStore.js";
import type { Session } from "@contracts/session";

const PROJECT = "p1";

let failures = 0;
let checks = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  checks++;
  if (cond) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures++;
  console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

let seq = 0;
function mkSession(id: string, over: Partial<Session> = {}): Session {
  return {
    id,
    projectId: PROJECT,
    providerId: "claude-sdk",
    claudeSessionId: null,
    kind: "chat",
    parentSessionId: null,
    title: id,
    status: "idle",
    model: "default",
    effort: "default",
    permissionMode: "default",
    customModelId: null,
    archived: false,
    pinnedAt: null,
    contextSnapshot: null,
    todos: null,
    subagents: null,
    planDraft: null,
    usageHistory: null,
    turnFiles: null,
    bookmarks: null,
    subagentTranscripts: null,
    createdAt: 1,
    updatedAt: 1 + seq++,
    ...over,
  };
}

/** Reset the slices the split machinery touches and seed five sessions with
 *  A active — mirroring the app invariant that the active session is in
 *  openTabs. */
function seed(sessions: Session[], active: string): void {
  useSessionStore.setState({
    displayMode: "single",
    splitSessionIds: [],
    splitGroupsBySession: {},
    splitAreaWidth: null,
    openTabs: [active],
    activeSessionId: active,
    sessionsByProject: { [PROJECT]: sessions },
    archivedSessionsByProject: {},
    pinnedSessions: [],
    streamSessions: [],
    orchWorkersById: {},
    unreadBySession: {},
    pendingQuestionBySession: {},
    promptQueueBySession: {},
    subagentsBySession: {},
    runningBySession: {},
    messagesBySession: {},
    historyLoadedBySession: {},
    providers: [],
    // Global composer slots — the FOCUSED session's binding.
    model: "g-model",
    customModelId: null,
    providerId: "gw-global",
    effort: "high",
    permissionMode: "acceptEdits",
  });
}

const A = mkSession("A", { model: "m-a", effort: "low", permissionMode: "plan", providerId: "pi-mock" });
const B = mkSession("B", { model: "m-b", effort: "medium", permissionMode: "default", providerId: "codex-mock" });
const C = mkSession("C");
const D = mkSession("D");
const E = mkSession("E");

/** sendPrompt fires sendTurn in the background — flush microtasks + one
 *  macrotask so the captured args land. */
async function flushTurns(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

async function main(): Promise<void> {
  /* ── 1. addToSplit guard chain ── */
  console.log("[1] addToSplit guards");
  seed([A, B, C, D, E], "A");
  const st = useSessionStore.getState();
  await st.addToSplit("B");
  eq("first drag-in seeds [active, dragged]", useSessionStore.getState().splitSessionIds, ["A", "B"]);
  check("new pane focused", useSessionStore.getState().activeSessionId === "B");
  check("members joined openTabs", useSessionStore.getState().openTabs.includes("A") && useSessionStore.getState().openTabs.includes("B"));
  eq("membership persisted", smokeSettings.get("ui.splitSessions"), '["A","B"]');
  await useSessionStore.getState().addToSplit("B");
  eq("duplicate member = focus only", useSessionStore.getState().splitSessionIds, ["A", "B"]);
  check("duplicate member focus flip", useSessionStore.getState().activeSessionId === "B");
  await useSessionStore.getState().addToSplit("no-such-session");
  eq("unknown id no-op", useSessionStore.getState().splitSessionIds, ["A", "B"]);
  await useSessionStore.getState().addToSplit("C");
  await useSessionStore.getState().addToSplit("D");
  eq("grows to 4", useSessionStore.getState().splitSessionIds, ["A", "B", "C", "D"]);
  await useSessionStore.getState().addToSplit("E");
  eq("full grid silently rejects", useSessionStore.getState().splitSessionIds, ["A", "B", "C", "D"]);

  /* ── 1b. width-adaptive capacity ── */
  console.log("[1b] width-adaptive capacity");
  eq("capacity: unknown width is optimistic 4", splitCapacityForWidth(null), 4);
  eq("capacity: below 2×min floors at 2", splitCapacityForWidth(SPLIT_PANE_MIN_WIDTH * 2 - 40), 2);
  eq("capacity: 2×min..3×min → 2", splitCapacityForWidth(SPLIT_PANE_MIN_WIDTH * 2 + 10), 2);
  eq("capacity: ≥3×min → 3", splitCapacityForWidth(SPLIT_PANE_MIN_WIDTH * 3 + 10), 3);
  eq("capacity: ≥4×min → 4", splitCapacityForWidth(SPLIT_PANE_MIN_WIDTH * 4 + 10), 4);
  eq("columns: unmeasured falls back to 2", splitColumnsForWidth(4, null), 2);
  eq("columns: N clamps to fit", splitColumnsForWidth(2, SPLIT_PANE_MIN_WIDTH * 4 + 10), 2);
  eq("columns: wide area fits all panes", splitColumnsForWidth(4, SPLIT_PANE_MIN_WIDTH * 4 + 10), 4);
  eq("columns: floor 1 at extreme narrowness", splitColumnsForWidth(2, SPLIT_PANE_MIN_WIDTH - 10), 1);
  // Narrow area (capacity 2) rejects the 3rd pane; widening re-admits it.
  seed([A, B, C, D], "A");
  useSessionStore.getState().setSplitAreaWidth(SPLIT_PANE_MIN_WIDTH * 2 + 10);
  await useSessionStore.getState().addToSplit("B");
  await useSessionStore.getState().addToSplit("C");
  eq("narrow area rejects the 3rd pane", useSessionStore.getState().splitSessionIds, ["A", "B"]);
  useSessionStore.getState().setSplitAreaWidth(SPLIT_PANE_MIN_WIDTH * 3 + 10);
  await useSessionStore.getState().addToSplit("C");
  eq("widening re-admits the pane", useSessionStore.getState().splitSessionIds, ["A", "B", "C"]);
  // Shrinking never evicts existing members — capacity only gates adds.
  useSessionStore.getState().setSplitAreaWidth(SPLIT_PANE_MIN_WIDTH * 2 + 10);
  eq("shrinking keeps existing members", useSessionStore.getState().splitSessionIds, ["A", "B", "C"]);
  // Tabs branch shares the same capacity guard.
  seed([A, B, C], "A");
  await useSessionStore.getState().setDisplayMode("tabs");
  useSessionStore.getState().setSplitAreaWidth(SPLIT_PANE_MIN_WIDTH * 2 + 10);
  await useSessionStore.getState().addToSplit("B");
  await useSessionStore.getState().addToSplit("C");
  eq("tabs branch honors the capacity", useSessionStore.getState().splitGroupsBySession["A"], ["A", "B"]);
  // Restore the post-[1] state ([A,B,C,D], D focused) for group [2]; seed
  // also resets the measured width (capacity back to the optimistic 4).
  seed([A, B, C, D], "A");
  await useSessionStore.getState().addToSplit("B");
  await useSessionStore.getState().addToSplit("C");
  await useSessionStore.getState().addToSplit("D");

  /* ── 2. removeFromSplit focus handoff + collapse ── */
  console.log("[2] removeFromSplit");
  // [A,B,C,D] with D focused (addToSplit left it active).
  await useSessionStore.getState().removeFromSplit("D");
  eq("remove focused keeps others", useSessionStore.getState().splitSessionIds, ["A", "B", "C"]);
  check("focus handed to next… previous survivor", useSessionStore.getState().activeSessionId === "C");
  await useSessionStore.getState().removeFromSplit("A");
  check("remove non-focused keeps focus", useSessionStore.getState().activeSessionId === "C");
  eq("list without A", useSessionStore.getState().splitSessionIds, ["B", "C"]);
  await useSessionStore.getState().removeFromSplit("C");
  eq("below 2 collapses to plain single", useSessionStore.getState().splitSessionIds, []);
  check("survivor becomes the single view", useSessionStore.getState().activeSessionId === "B");
  eq("collapse persisted", smokeSettings.get("ui.splitSessions"), "[]");
  // Now split=[] and B is active — the empty-grid state. Dragging the
  // FOCUSED session itself can't form a pair: the guard degrades to a
  // plain focus and the list stays empty (0-or-≥2 invariant).
  await useSessionStore.getState().addToSplit("B");
  eq("self-drag onto empty grid stays solo", useSessionStore.getState().splitSessionIds, []);
  check("self-drag still focuses", useSessionStore.getState().activeSessionId === "B");
  eq("self-drag persists nothing", smokeSettings.get("ui.splitSessions"), "[]");

  /* ── 2b. deleteSession removes the pane (applySessionDeletedState) ── */
  console.log("[2b] delete path");
  seed([A, B, C], "A");
  await useSessionStore.getState().addToSplit("B");
  await useSessionStore.getState().addToSplit("C");
  await useSessionStore.getState().selectSession("B");
  await useSessionStore.getState().deleteSession("A");
  eq("deleted non-focused pane leaves the grid", useSessionStore.getState().splitSessionIds, ["B", "C"]);
  check("focus untouched by non-focused delete", useSessionStore.getState().activeSessionId === "B");
  await useSessionStore.getState().deleteSession("B");
  eq("delete collapsing below 2 clears split", useSessionStore.getState().splitSessionIds, []);
  check("collapse lands focus on the survivor", useSessionStore.getState().activeSessionId === "C");
  eq("delete collapse persisted", smokeSettings.get("ui.splitSessions"), "[]");

  /* ── 3. tabs-mode per-tab split groups ── */
  console.log("[3] tabs-mode per-tab groups");
  seed([A, B, C, D, E], "A");
  await useSessionStore.getState().setDisplayMode("tabs");
  // Drag B onto the open tab A: A's content splits in place — B joins
  // A's group and is focused, but NEVER becomes a tab.
  await useSessionStore.getState().addToSplit("B");
  eq("drag seeds the tab's group", useSessionStore.getState().splitGroupsBySession["A"], ["A", "B"]);
  eq("dragged session did NOT become a tab", useSessionStore.getState().openTabs, ["A"]);
  check("dragged pane focused", useSessionStore.getState().activeSessionId === "B");
  check("mode still tabs", useSessionStore.getState().displayMode === "tabs");
  eq("tabs drags don't touch the single-mode blob", smokeSettings.get("ui.splitSessions"), "[]");
  await useSessionStore.getState().addToSplit("C");
  eq("grid grows inside the tab", useSessionStore.getState().splitGroupsBySession["A"], ["A", "B", "C"]);
  await useSessionStore.getState().addToSplit("D");
  eq("group reaches 4", useSessionStore.getState().splitGroupsBySession["A"], ["A", "B", "C", "D"]);
  await useSessionStore.getState().addToSplit("E");
  eq("full grid silently rejects", useSessionStore.getState().splitGroupsBySession["A"], ["A", "B", "C", "D"]);
  await useSessionStore.getState().addToSplit("B");
  eq("duplicate member = focus only", useSessionStore.getState().splitGroupsBySession["A"], ["A", "B", "C", "D"]);
  check("duplicate member focuses pane", useSessionStore.getState().activeSessionId === "B");
  // Clicking a plain session TAB switches the center away from the grid…
  await useSessionStore.getState().openTab("E");
  check("another tab owns the center now", useSessionStore.getState().activeSessionId === "E");
  eq("groups untouched by tab clicks", useSessionStore.getState().splitGroupsBySession["A"], ["A", "B", "C", "D"]);
  // …and clicking back to tab A re-enters ITS grid (focus lands on the root).
  await useSessionStore.getState().selectSession("A");
  check("returning to the tab re-enters its grid", useSessionStore.getState().activeSessionId === "A");
  // Pane close: removing the FOCUSED B hands focus to the next member.
  await useSessionStore.getState().selectSession("B");
  await useSessionStore.getState().removeFromSplit("B");
  eq("pane close shrinks the group", useSessionStore.getState().splitGroupsBySession["A"], ["A", "C", "D"]);
  check("focus handed to neighbor pane", useSessionStore.getState().activeSessionId === "C");
  // Closing the ROOT dissolves the group (tab reverts to its plain pane).
  await useSessionStore.getState().removeFromSplit("C");
  await useSessionStore.getState().selectSession("A");
  await useSessionStore.getState().removeFromSplit("A");
  check("root close dissolves the group", useSessionStore.getState().splitGroupsBySession["A"] === undefined);
  check("dissolve lands focus on the survivor", useSessionStore.getState().activeSessionId === "D");
  // Closing the tab itself removes its group with it.
  seed([A, B, C], "A");
  await useSessionStore.getState().setDisplayMode("tabs");
  await useSessionStore.getState().addToSplit("B");
  useSessionStore.getState().closeTab("A");
  check("tab close removes its group", useSessionStore.getState().splitGroupsBySession["A"] === undefined);
  // Deleting a member shrinks the owning group (delete path). A was closed
  // by the previous step — reopen it as a tab first.
  await useSessionStore.getState().openTab("A");
  await useSessionStore.getState().addToSplit("B");
  await useSessionStore.getState().addToSplit("C");
  await useSessionStore.getState().deleteSession("B");
  eq("member delete shrinks the group", useSessionStore.getState().splitGroupsBySession["A"], ["A", "C"]);

  /* ── 4. openSessionFromSidebar ── */
  console.log("[4] openSessionFromSidebar");
  seed([A, B, C], "A");
  await useSessionStore.getState().addToSplit("B");
  await useSessionStore.getState().openSessionFromSidebar("C");
  eq("non-member replaces focused slot", useSessionStore.getState().splitSessionIds, ["A", "C"]);
  check("replaced slot focused", useSessionStore.getState().activeSessionId === "C");
  eq("takeover persisted", smokeSettings.get("ui.splitSessions"), '["A","C"]');
  await useSessionStore.getState().openSessionFromSidebar("A");
  eq("member click keeps list", useSessionStore.getState().splitSessionIds, ["A", "C"]);
  check("member click focuses", useSessionStore.getState().activeSessionId === "A");
  await useSessionStore.getState().removeFromSplit("C");
  await useSessionStore.getState().openSessionFromSidebar("B");
  check("outside split = plain openTab", useSessionStore.getState().activeSessionId === "B");
  // Tabs mode: a sidebar CLICK still opens a tab (only the DRAG splits).
  seed([A, B, C], "A");
  await useSessionStore.getState().setDisplayMode("tabs");
  await useSessionStore.getState().addToSplit("B");
  await useSessionStore.getState().openSessionFromSidebar("C");
  eq("sidebar click opens a tab (no split)", useSessionStore.getState().openTabs.includes("C"), true);
  check("sidebar click focuses the tab", useSessionStore.getState().activeSessionId === "C");
  eq("existing group untouched by the click", useSessionStore.getState().splitGroupsBySession["A"], ["A", "B"]);
  // Tabs mode LOCATE: clicking a session that already lives inside a tab's
  // split grid navigates to the host tab + focuses that pane — no
  // duplicate tab.
  await useSessionStore.getState().selectSession("A");
  await useSessionStore.getState().openSessionFromSidebar("B");
  eq("located member adds no tab", useSessionStore.getState().openTabs.includes("B"), false);
  check("located member focused in its grid", useSessionStore.getState().activeSessionId === "B");
  eq("group untouched by the locate", useSessionStore.getState().splitGroupsBySession["A"], ["A", "B"]);
  // Clicking a session that IS an open tab still just focuses it.
  await useSessionStore.getState().openSessionFromSidebar("C");
  check("tab-root click focuses its tab", useSessionStore.getState().activeSessionId === "C");
  eq("no duplicate for tab roots", useSessionStore.getState().openTabs, ["A", "C"]);

  /* ── 5. unread gating via question.ask ── */
  console.log("[5] unread gating");
  seed([A, B, C], "A");
  await useSessionStore.getState().addToSplit("B");
  useSessionStore.getState().ingestEvent({
    type: "question.ask",
    sessionId: "B",
    requestId: "q1",
    questions: [{ header: "h", question: "q", multiSelect: false, options: [{ label: "x", value: "x" }] }],
  });
  check("unfocused split member is on-screen (no badge)", useSessionStore.getState().unreadBySession["B"] === undefined);
  // Collapse the split; the same event for the now-off-screen session badges.
  await useSessionStore.getState().removeFromSplit("B");
  useSessionStore.getState().ingestEvent({
    type: "question.ask",
    sessionId: "B",
    requestId: "q2",
    questions: [{ header: "h", question: "q", multiSelect: false, options: [{ label: "x", value: "x" }] }],
  });
  check("outside split the same event badges", useSessionStore.getState().unreadBySession["B"] === 1);
  // Tabs mode: while the member's tab GROUP owns the center it is on
  // screen; switching to another tab hides the grid and it badges again.
  seed([A, B, C], "A");
  await useSessionStore.getState().setDisplayMode("tabs");
  await useSessionStore.getState().addToSplit("B");
  useSessionStore.getState().ingestEvent({
    type: "question.ask",
    sessionId: "B",
    requestId: "q3",
    questions: [{ header: "h", question: "q", multiSelect: false, options: [{ label: "x", value: "x" }] }],
  });
  check("visible tabs-group member is on-screen", useSessionStore.getState().unreadBySession["B"] === undefined);
  await useSessionStore.getState().openTab("C");
  useSessionStore.getState().ingestEvent({
    type: "question.ask",
    sessionId: "B",
    requestId: "q4",
    questions: [{ header: "h", question: "q", multiSelect: false, options: [{ label: "x", value: "x" }] }],
  });
  check("hidden tabs-group member badges", useSessionStore.getState().unreadBySession["B"] === 1);
  // When a file open hands the center to the editor (centerTabFocus
  // "editor"), the grid yields and its members are off-screen again —
  // even though their tab is the focused one.
  await useSessionStore.getState().selectSession("A");
  useSessionStore.setState({ centerTabFocus: "editor" });
  useSessionStore.getState().ingestEvent({
    type: "question.ask",
    sessionId: "B",
    requestId: "q5",
    questions: [{ header: "h", question: "q", multiSelect: false, options: [{ label: "x", value: "x" }] }],
  });
  check("editor-owns-center hides the grid (member badges)", useSessionStore.getState().unreadBySession["B"] === 2);
  useSessionStore.setState({ centerTabFocus: "chat" });

  /* ── 6. sendPrompt row-scoped slots + drain gate ── */
  console.log("[6] sendPrompt row-scoped slots");
  seed([A, B, C], "A");
  sendTurnCalls.length = 0;
  // Active target: the global composer slots ship (existing behavior).
  await useSessionStore.getState().sendPrompt("hi-active");
  await flushTurns();
  eq("active send ships global slots", sendTurnCalls[0] && {
    sessionId: sendTurnCalls[0].sessionId,
    model: sendTurnCalls[0].model,
    effort: sendTurnCalls[0].effort,
    permissionMode: sendTurnCalls[0].permissionMode,
    providerId: sendTurnCalls[0].providerId,
  }, { sessionId: "A", model: "g-model", effort: "high", permissionMode: "acceptEdits", providerId: "gw-global" });
  // Non-active target (split pane / background drain): the ROW's own binding.
  await useSessionStore.getState().sendPrompt("hi-background", undefined, undefined, undefined, undefined, undefined, "B");
  await flushTurns();
  eq("non-active send ships the target row's binding", sendTurnCalls[1] && {
    sessionId: sendTurnCalls[1].sessionId,
    model: sendTurnCalls[1].model,
    effort: sendTurnCalls[1].effort,
    permissionMode: sendTurnCalls[1].permissionMode,
    providerId: sendTurnCalls[1].providerId,
  }, { sessionId: "B", model: "m-b", effort: "medium", permissionMode: "default", providerId: "codex-mock" });
  check("user message landed in B's bucket", (useSessionStore.getState().messagesBySession["B"] ?? []).some((m) => m.role === "user"));
  // Drain gate: B's queued head resolves through the ROW, not the globals.
  sendTurnCalls.length = 0;
  useSessionStore.setState({
    promptQueueBySession: { B: [{ id: "q1", prompt: "queued", displayText: "queued" } satisfies QueuedPrompt] },
    runningBySession: { B: false },
  });
  useSessionStore.getState().drainPromptQueueIfIdle("B");
  await flushTurns();
  eq("queue drain ships the row binding", sendTurnCalls[0] && {
    sessionId: sendTurnCalls[0].sessionId,
    model: sendTurnCalls[0].model,
    effort: sendTurnCalls[0].effort,
    providerId: sendTurnCalls[0].providerId,
  }, { sessionId: "B", model: "m-b", effort: "medium", providerId: "codex-mock" });
  eq("drained head dropped", useSessionStore.getState().promptQueueBySession["B"], []);
  // A row that cannot resolve (default model, nothing configured) keeps its
  // queue head — the item must not be lost to the model guard.
  useSessionStore.setState({
    promptQueueBySession: { C: [{ id: "q2", prompt: "queued-c", displayText: "queued-c" } satisfies QueuedPrompt] },
  });
  sendTurnCalls.length = 0;
  useSessionStore.getState().drainPromptQueueIfIdle("C");
  await flushTurns();
  eq("unresolvable row keeps queue head", useSessionStore.getState().promptQueueBySession["C"]?.length, 1);
  check("unresolvable row sends nothing", sendTurnCalls.length === 0);

  /* ── 7. parseSplitSessionIds hydration validation ── */
  console.log("[7] parseSplitSessionIds");
  const existsABC = (id: string) => id === "A" || id === "B" || id === "C";
  eq("dead ids drop, order kept", parseSplitSessionIds('["B","X","A"]', existsABC), ["B", "A"]);
  eq("remainder below 2 collapses", parseSplitSessionIds('["A","X"]', existsABC), []);
  eq("malformed JSON tolerated", parseSplitSessionIds("not-json", existsABC), []);
  eq("non-array tolerated", parseSplitSessionIds('"A"', existsABC), []);
  eq("non-string entries filtered", parseSplitSessionIds('["A","B",42,null]', existsABC), ["A", "B"]);
  eq("null tolerated", parseSplitSessionIds(null, existsABC), []);

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures > 0) process.exit(1);
}

void main();
