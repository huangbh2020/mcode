/**
 * LIVE probe for opencode conversation revision (reviseConversation): two
 * real turns on one session (free Zen model) → retract the FIRST GUI user
 * row via the provider's staged-revert path → assert the provider session's
 * projected user messages are GONE (boundary-inclusive hard delete on
 * commit) and the SAME session id still prompts afterwards (full revert
 * leaves the session alive — `cleared` is never needed).
 *
 * file-rollback suppression (`files: false`) is exercised implicitly: the
 * stage call must ACCEPT the body on the installed CLI (a shape drift would
 * throw here); positive "disk untouched" proof needs a file-writing turn and
 * lives in the manual E2E instead.
 *
 * Dev verification tool — needs a live CLI + network. NOT part of the
 * assertion smoke.
 */
import type { RuntimeEvent } from "@contracts/runtime";
import type { ProviderContext, ProviderReviseInput, TurnHandle } from "@contracts/provider";
import { OpencodeProvider } from "@main/providers/opencode-sdk/OpencodeProvider.js";
import { disposeOpenCodeServer, ensureOpenCodeServer } from "@main/providers/opencode-sdk/opencodeServerManager.js";
import { collectOpenCodeMcpConfig } from "@main/providers/opencode-sdk/opencodeMcp.js";

const FREE_MODEL_FALLBACK = "opencode/hy4-flash-free";
const BUDGET_MS = 240_000;
const GUI_SESSION = "probe-revert-gui";

/** First free model on the current model list (the free-model names rotate
 *  across CLI releases — probe-e2e's hard-coded pick went stale on 2.3.2). */
async function pickFreeModel(): Promise<string> {
  try {
    const server = await ensureOpenCodeServer(await collectOpenCodeMcpConfig(process.cwd()));
    const res = await server.fetch("/api/model");
    const body = (await res.json()) as { data?: Array<{ id?: string; providerID?: string; free?: boolean }> };
    const free = (body.data ?? []).find((m) => m.free && m.providerID && m.id);
    if (free) return `${free.providerID}/${free.id}`;
  } catch (err) {
    console.warn("[model pick]", (err as Error).message);
  }
  return FREE_MODEL_FALLBACK;
}

function makeCtx(sink: RuntimeEvent[]): ProviderContext {
  return {
    emit: (e) => sink.push(e),
    log: {
      info: (...a: unknown[]) => console.log("[info]", ...a),
      warn: (...a: unknown[]) => console.warn("[warn]", ...a),
      error: (...a: unknown[]) => console.error("[error]", ...a),
    },
    getPermissionMode: () => "default",
    isToolAlwaysAllowed: () => false,
    requestApproval: async () => ({ allow: false }),
    onProviderSessionId: () => {},
  };
}

async function runTurn(
  provider: OpencodeProvider,
  prompt: string,
  resumeProviderSessionId: string | null,
  turnNumber: number,
  model: string,
): Promise<{ ok: boolean; providerSessionId: string | null; reason: string }> {
  const events: RuntimeEvent[] = [];
  let providerSessionId: string | null = null;
  const ctx = makeCtx(events);
  ctx.onProviderSessionId = (id) => {
    providerSessionId = id;
  };
  const handle: TurnHandle = await provider.startTurn(
    {
      sessionId: GUI_SESSION,
      prompt,
      cwd: process.cwd(),
      model,
      permissionMode: "default",
      turnNumber,
      ...(resumeProviderSessionId ? { resumeProviderSessionId } : {}),
    },
    ctx,
  );
  const reason = await Promise.race([
    handle.done.then(() => "done" as const),
    new Promise<"timeout">((r) => setTimeout(() => r("timeout"), BUDGET_MS)),
  ]);
  for (const e of events) {
    if (e.type === "error") console.log("[turn error]", (e as { message?: string }).message);
  }
  const doneEv = events.find((e) => e.type === "turn.done") as { reason?: string } | undefined;
  return { ok: reason === "done" && doneEv?.reason === "end_turn", providerSessionId, reason: doneEv?.reason ?? reason };
}

/** User-message count of the provider session, via the same server handle
 *  the provider's revise path uses (same fingerprint → same server). */
async function countUserMessages(sessionId: string): Promise<{ total: number; user: number; rows: string[] }> {
  const server = await ensureOpenCodeServer(await collectOpenCodeMcpConfig(process.cwd()));
  const rows: string[] = [];
  let user = 0;
  let cursor = "";
  for (;;) {
    const qs = new URLSearchParams();
    if (cursor) qs.set("cursor", cursor);
    const res = await server.fetch(
      `/api/session/${encodeURIComponent(sessionId)}/message${qs.size ? `?${qs.toString()}` : ""}`,
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`message list HTTP ${res.status}: ${detail.slice(0, 300)}`);
    }
    const body = (await res.json()) as { data?: Array<{ type?: string; id?: string }>; cursor?: { next?: string } };
    for (const m of body.data ?? []) {
      rows.push(`${m.type}:${m.id}`);
      if (m.type === "user") user += 1;
    }
    const next = typeof body.cursor?.next === "string" ? body.cursor.next : "";
    if (!next) break;
    cursor = next;
  }
  return { total: rows.length, user, rows };
}

async function main() {
  const provider = new OpencodeProvider();

  const boot = await ensureOpenCodeServer(await collectOpenCodeMcpConfig(process.cwd()));
  const modelRes = await boot.fetch("/api/model");
  const modelBody = (await modelRes.json()) as { data?: Array<{ id?: string; providerID?: string; free?: boolean }> };
  const models = modelBody.data ?? [];
  console.log("available models:", models.map((m) => `${m.providerID}/${m.id}${m.free ? " (free)" : ""}`).slice(0, 10).join(", "));
  const model = await pickFreeModel();
  console.log("using model:", model);

  console.log("— turn 1 —");
  const t1 = Date.now();
  const r1 = await runTurn(provider, "Reply with exactly: one.", null, 1, model);
  console.log("turn 1:", JSON.stringify(r1));
  const sid = r1.providerSessionId;
  if (!r1.ok || !sid) throw new Error(`turn 1 failed: ${JSON.stringify(r1)}`);

  console.log("— turn 2 (resume) —");
  const t2 = Date.now();
  const r2 = await runTurn(provider, "Reply with exactly: two.", sid, 2, model);
  console.log("turn 2:", JSON.stringify(r2));
  if (!r2.ok) throw new Error(`turn 2 failed: ${JSON.stringify(r2)}`);

  const before = await countUserMessages(sid);
  console.log("messages before revert:", before.total, "rows:", before.rows.join(" "));
  if (before.user !== 2) throw new Error(`expected 2 user messages before revert, got ${before.user}`);

  console.log("— reviseConversation (retract turn 1's GUI row) —");
  const guiUserRows = [
    { id: "g1", createdAt: t1, text: "Reply with exactly: one." },
    { id: "g2", createdAt: t2, text: "Reply with exactly: two." },
  ];
  const reviseInput: ProviderReviseInput = {
    sessionId: GUI_SESSION,
    providerSessionId: sid,
    cwd: process.cwd(),
    target: guiUserRows[0],
    guiUserRows,
    log: {
      info: (...a: unknown[]) => console.log("[revise info]", ...a),
      warn: (...a: unknown[]) => console.warn("[revise warn]", ...a),
      error: (...a: unknown[]) => console.error("[revise error]", ...a),
    },
  };
  const reviseResult = await provider.reviseConversation(reviseInput);
  console.log("revise result:", JSON.stringify(reviseResult));

  const after = await countUserMessages(sid);
  console.log("messages after revert:", after.total, "rows:", after.rows.join(" ") || "(empty)");
  if (after.user !== 0 || after.total !== 0) {
    throw new Error(`boundary-inclusive deletion violated: ${after.total} rows remain (${after.rows.join(" ")})`);
  }

  console.log("— turn 3 on the reverted session (resume; proves no `cleared` needed) —");
  const r3 = await runTurn(provider, "Reply with exactly: three.", sid, 3, model);
  console.log("turn 3:", JSON.stringify(r3));
  const after3 = await countUserMessages(sid);
  console.log("messages after turn 3:", after3.total, "user:", after3.user);

  const pass = r3.ok && after3.user === 1 && after3.total >= 2;
  console.log(pass ? "\nREVERT PROBE: PASS" : "\nREVERT PROBE: FAIL");
  process.exit(pass ? 0 : 1);
}

main()
  .catch((err) => {
    console.error("PROBE FAILED:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    // Kill the spawned server before exiting (Windows orphans otherwise pile up).
    disposeOpenCodeServer();
  });
