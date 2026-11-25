/**
 * Headless smoke for the composer's per-provider remembered-entry merge
 * policy (renderer/lib/composerMemory.ts):
 *
 *  - a "default" incoming binding NEVER downgrades the remembered
 *    (model, customModelId) pair — the regression behind "new sessions reset
 *    to 选择模型": the view slots are re-seeded by syncConfigFromSession from
 *    the visited row (placeholder "New session", unselected threads), and a
 *    provider hop / effort tweak / permission tweak used to snapshot that
 *    unselected binding over the standing pick;
 *  - a non-default incoming pick upgrades the binding as a PAIR (model and
 *    customModelId move together);
 *  - effort / permissionMode always take the incoming values (tweaking
 *    permission on an unselected thread is still worth remembering);
 *  - prev-less entries and prev-already-default entries fall back to the
 *    incoming binding.
 *
 * Pure function — bundled with esbuild and run in Node, no stubs needed.
 */
import { mergeRememberedEntry } from "@renderer/lib/composerMemory.js";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean): void {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`FAIL: ${name}`);
  }
}

function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/* The standing pick (what the user expects a new session to restore). */
const GOOD = {
  model: "GLM-5.3-Flash",
  customModelId: "cm_mssjq7s8_w2bkh7",
  effort: "high",
  permissionMode: "bypassPermissions",
} as const;

/* What the slots hold after syncConfigFromSession re-seeded them from a
 * placeholder "New session" row. */
const UNSELECTED = {
  model: "default",
  customModelId: null,
  effort: "high",
  permissionMode: "default",
} as const;

/* ── default incoming never downgrades the binding ── */
check(
  "merge: unselected binding preserves model+customModelId",
  eq(mergeRememberedEntry(GOOD, UNSELECTED), {
    model: GOOD.model,
    customModelId: GOOD.customModelId,
    effort: UNSELECTED.effort,
    permissionMode: UNSELECTED.permissionMode,
  }),
);
check(
  "merge: effort tweak on an unselected row keeps the binding",
  eq(mergeRememberedEntry(GOOD, { ...UNSELECTED, effort: "medium" }), {
    model: GOOD.model,
    customModelId: GOOD.customModelId,
    effort: "medium",
    permissionMode: UNSELECTED.permissionMode,
  }),
);
check(
  "merge: permission tweak on an unselected row keeps the binding",
  eq(mergeRememberedEntry(GOOD, { ...UNSELECTED, permissionMode: "acceptEdits" }), {
    model: GOOD.model,
    customModelId: GOOD.customModelId,
    effort: UNSELECTED.effort,
    permissionMode: "acceptEdits",
  }),
);

/* ── non-default incoming upgrades the binding as a pair ── */
check(
  "merge: real pick overwrites model+customModelId together",
  eq(mergeRememberedEntry(GOOD, { model: "glm-5.3", customModelId: "cm_other", effort: "low", permissionMode: "plan" }), {
    model: "glm-5.3",
    customModelId: "cm_other",
    effort: "low",
    permissionMode: "plan",
  }),
);
check(
  "merge: real pick on a prev-less entry lands as-is",
  eq(mergeRememberedEntry(undefined, { model: "glm-5.3", customModelId: "cm_other", effort: "low", permissionMode: "default" }), {
    model: "glm-5.3",
    customModelId: "cm_other",
    effort: "low",
    permissionMode: "default",
  }),
);

/* ── prev-less / prev-already-default entries take the incoming binding ── */
check(
  "merge: no prev, unselected incoming → default binding",
  eq(mergeRememberedEntry(undefined, UNSELECTED), {
    model: "default",
    customModelId: null,
    effort: UNSELECTED.effort,
    permissionMode: UNSELECTED.permissionMode,
  }),
);
check(
  "merge: prev already default, unselected incoming → stays default",
  eq(mergeRememberedEntry({ ...UNSELECTED, effort: "medium" }, UNSELECTED), {
    model: "default",
    customModelId: null,
    effort: UNSELECTED.effort,
    permissionMode: UNSELECTED.permissionMode,
  }),
);

/* ── non-optional slots carry older entries' missing fields fine ── */
check(
  "merge: prev without effort/permissionMode still preserves binding",
  eq(
    mergeRememberedEntry({ model: GOOD.model, customModelId: GOOD.customModelId }, UNSELECTED).model,
    GOOD.model,
  ),
);

console.log(`composer-memory smoke: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
