/**
 * Headless smoke for the PER-TURN MODEL RECORD (方案A process-card model badge).
 *
 * Two things are asserted against REAL code (no replicas):
 *  1. lib/modelAvatar.ts parsing — id → avatar letter + display name.
 *  2. The store's stamping chain — the send-time anchor
 *     (runningTurnModelBySession) is written into the turn opener's
 *     `turnMeta.model` when the turn is created, and a later model switch never
 *     rewrites an already-open turn.
 *
 * (2) drives the same entry point the IPC stream uses
 * (useSessionStore.getState().ingestEvent) with real text deltas, then waits for
 * the buffered flush — so the assertion covers flushDeltas' isNewTurn path.
 *
 * Run: scripts/model-anchor-smoke/run.sh
 */
import "../session-store-smoke/prelude.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { modelInitial, modelDisplayName, modelAvatarColor } from "@renderer/lib/modelAvatar.js";
import { turnTokenUsage, CUMULATIVE_USAGE_PROVIDER_IDS } from "@renderer/lib/turnTokens.js";
import type { ChatMessage } from "@renderer/stores/sessionStore.js";

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SID = "s1";

// ── 1. id → 头像字母 / 展示名 ─────────────────────────────────────────────
console.log("[1] model id parsing");
{
  const cases: [string | null | undefined, string | null, string | null][] = [
    ["deepseek-flash", "D", "deepseek-flash"],
    ["claude-sonnet-4-5", "C", "claude-sonnet-4-5"],
    // `[1m]` is an env-var decoration, not part of the name
    ["deepseek-flash[1m]", "D", "deepseek-flash"],
    // codex binds "<providerId>/<modelId>" — the prefix is the endpoint
    ["openai/gpt-5.6-sol", "G", "gpt-5.6-sol"],
    ["zhipu/glm-4.6", "G", "glm-4.6"],
    // first ALPHANUMERIC wins, not first character
    ["_sonnet", "S", "_sonnet"],
    ["-x", "X", "-x"],
    // nothing usable → no badge at all
    ["", null, null],
    [null, null, null],
    [undefined, null, null],
    ["///", null, null],
    ["   ", null, null],
    ["[1m]", null, null],
  ];
  for (const [input, wantInitial, wantName] of cases) {
    const gotInitial = modelInitial(input);
    const gotName = modelDisplayName(input);
    check(
      `${JSON.stringify(input) ?? "undefined"} → ${String(wantInitial)}/${String(wantName)}`,
      gotInitial === wantInitial && gotName === wantName,
      { gotInitial, gotName },
    );
  }
  check("same model → same color", modelAvatarColor("deepseek-flash") === modelAvatarColor("deepseek-flash"));
  const distinct = new Set(
    ["deepseek-flash", "claude-sonnet-4-5", "gpt-5.6-sol", "glm-4.6"].map(modelAvatarColor),
  ).size;
  check("different models use different colors", distinct >= 3, { distinct });
}

// ── 2. 发送锚点 → turnMeta.model ─────────────────────────────────────────
/** Reset the per-session turn state: no messages, running, anchors set. */
function openTurn(model: string | undefined, startedAt = 1000): void {
  useSessionStore.setState((s) => {
    const runningTurnStartedAt = { ...s.runningTurnStartedAt, [SID]: startedAt };
    const runningTurnModelBySession = { ...s.runningTurnModelBySession };
    if (model === undefined) delete runningTurnModelBySession[SID];
    else runningTurnModelBySession[SID] = model;
    return {
      messagesBySession: { ...s.messagesBySession, [SID]: [] },
      runningBySession: { ...s.runningBySession, [SID]: true },
      runningTurnStartedAt,
      runningTurnModelBySession,
    };
  });
}

const msgs = (): ChatMessage[] => useSessionStore.getState().messagesBySession[SID] ?? [];
/** The NEWEST turn's opener — the turn the assertion is about. (A plain
 *  `.find()` returned the OLDEST opener, which made the "new turn" case read
 *  the previous turn's meta.) */
const opener = (): ChatMessage | undefined => {
  const list = msgs();
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].role === "assistant" && list[i].turnMeta) return list[i];
  }
  return undefined;
};

async function delta(messageId: string, text: string): Promise<void> {
  useSessionStore.getState().ingestEvent({ type: "text.delta", sessionId: SID, messageId, text });
  // Text deltas land in a buffer and flush on a rAF-bound task (the prelude
  // maps requestAnimationFrame to a 16ms timer) — wait past that.
  await sleep(120);
}

console.log("\n[2] send anchor → turnMeta.model");
{
  openTurn("deepseek-flash");
  await delta("m1", "hi");
  check("opener records the model this turn was sent with", opener()?.turnMeta?.model === "deepseek-flash", opener()?.turnMeta);
  check("opener keeps the timing anchor too", opener()?.turnMeta?.startedAt === 1000, opener()?.turnMeta);
}

console.log("\n[3] a model switch mid-turn does NOT rewrite the open turn");
{
  // Same open turn (no endedAt) — switch the composer's anchor underneath.
  useSessionStore.setState((s) => ({
    runningTurnModelBySession: { ...s.runningTurnModelBySession, [SID]: "claude-sonnet-4-5" },
  }));
  await delta("m1", " more");
  check("still the model the turn started with", opener()?.turnMeta?.model === "deepseek-flash", opener()?.turnMeta);
}

console.log("\n[4] a NEW turn picks up the new model");
{
  // Close the open turn (what turn.done does), then start another.
  useSessionStore.setState((s) => ({
    messagesBySession: {
      ...s.messagesBySession,
      [SID]: msgs().map((m) =>
        m.turnMeta && m.turnMeta.endedAt === undefined
          ? { ...m, turnMeta: { ...m.turnMeta, endedAt: 2000 } }
          : m,
      ),
    },
  }));
  await delta("m2", "next turn");
  check(
    "second turn carries the second model",
    opener()?.turnMeta?.model === "claude-sonnet-4-5",
    msgs().map((m) => m.turnMeta),
  );
}

console.log("\n[5] no anchor (resumed / legacy turn) → model stays undefined");
{
  openTurn(undefined);
  await delta("m3", "no anchor");
  check("renders without a model badge", opener()?.turnMeta?.model === undefined, opener()?.turnMeta);
  check("timing still stamped", typeof opener()?.turnMeta?.startedAt === "number", opener()?.turnMeta);
}

// ── 6. 本轮 token 取数（含 Pi 的会话累计值归一）──────────────────────────
console.log("\n[6] per-turn tokens");
{
  // Claude/Codex 语义：记录本身就是本轮值
  const perTurn = [
    { endedAt: 1000, totalProcessedTokens: 100 },
    { endedAt: 2000, totalProcessedTokens: 250 },
  ];
  check("non-cumulative: raw per-turn value", turnTokenUsage(perTurn, 2000, false) === 250);
  check("non-cumulative: first turn", turnTokenUsage(perTurn, 1000, false) === 100);

  // Pi 语义：记录是会话累计值 → 取与上一条的差值
  const cum = [
    { endedAt: 1000, totalProcessedTokens: 100 },
    { endedAt: 2000, totalProcessedTokens: 250 },
    { endedAt: 3000, totalProcessedTokens: 400 },
  ];
  check("cumulative: delta vs previous record", turnTokenUsage(cum, 2000, true) === 150);
  check("cumulative: latest delta", turnTokenUsage(cum, 3000, true) === 150);
  check("cumulative: first record has no previous", turnTokenUsage(cum, 1000, true) === 100);

  // 乱序输入也要取「最近一条更早的记录」
  const shuffled = [
    { endedAt: 3000, totalProcessedTokens: 400 },
    { endedAt: 1000, totalProcessedTokens: 100 },
    { endedAt: 2000, totalProcessedTokens: 250 },
  ];
  check("cumulative: unsorted history", turnTokenUsage(shuffled, 3000, true) === 150);

  // 计数器回退（重连/重置）不产生负数
  check(
    "cumulative: counter reset clamps at 0",
    turnTokenUsage([{ endedAt: 1, totalProcessedTokens: 500 }, { endedAt: 2, totalProcessedTokens: 40 }], 2, true) === 0,
  );

  // 缺记录 / 缺字段 / 未结束
  check("no record for that turn", turnTokenUsage(perTurn, 9999, false) === null);
  check("turn not ended yet", turnTokenUsage(perTurn, undefined, false) === null);
  check("empty history", turnTokenUsage([], 1000, false) === null);
  check("missing counter field", turnTokenUsage([{ endedAt: 1 }], 1, false) === null);
  check("pi is the only cumulative provider", CUMULATIVE_USAGE_PROVIDER_IDS.has("pi-sdk") && CUMULATIVE_USAGE_PROVIDER_IDS.size === 1);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
