/**
 * Automation scheduler (v2「任务即会话」) — fires scheduled tasks by appending
 * one TURN to the task's own visible session (kind="automation"), entirely
 * inside the main process. The session was created together with the task
 * (automation.save); every fire is `bindSession → resolveSessionCwd →
 * sendTurn` into that same session, so the transcript accumulates across
 * runs — "history" is the session's turn list, "running" is its live turn.
 *
 * Scheduling model (unchanged from v1):
 *  - Poll: a 30s tick scans `listDue(now)` over the precomputed next_run_at
 *    index — one interval for every task, config changes land via the row.
 *  - Write-before-run: due tasks advance lastRunAt/nextRunAt in the same tick
 *    that dispatches, so a crash can't double-fire an occurrence.
 *  - Missed runs are SKIPPED (boot reconcile recomputes nextRunAt from now;
 *    past-due once-tasks auto-disable). Stale "running" task sessions left by
 *    a dead process are marked interrupted.
 *  - Overlap protection: a fire is skipped while the task session is still
 *    running/approving; the schedule keeps advancing, nothing queues.
 *  - Retention: after each terminal event, turns beyond keepRuns are deleted
 *    (MessageRepo.trimTurns — everything before the kept turns' first user
 *    message). In-flight turns are never evicted.
 *
 * Status tracking rides addObserver (never setObserver — that would evict
 * NotificationManager) with a taskSessionId→automationId map seeded from the
 * registry at start + on every task creation, so the hot chat path pays one
 * Map lookup per event.
 */
import { computeNextRun, RUN_HEADER_PREFIX, type Automation, type AutomationRunEntry, type AutomationRunStatus } from "@contracts/automation";
import type { Session } from "@contracts/session";
import type { RuntimeEvent } from "@contracts/runtime";
import { IPC } from "@contracts/ipc";
import { AutomationRepo, MessageRepo, ProjectRepo, SessionRepo } from "@main/store/repositories.js";
import { awaitDb } from "@main/store/db.js";
import { runtimeManager } from "@main/claude/RuntimeManager.js";
import { resolveSessionCwd } from "@main/lib/sessionCwd.js";
import { sendToRenderer } from "@main/window.js";
import { log } from "@main/lib/logger.js";

/** Tick cadence. Sub-minute schedules fire within 30s of their mark —
 *  precise enough for agent runs that take minutes themselves. */
const TICK_INTERVAL_MS = 30_000;
/** Delay before the first tick after boot — lets the window/DB settle. */
const FIRST_TICK_DELAY_MS = 20_000;

let initialized = false;
let timer: ReturnType<typeof setInterval> | null = null;
let detachObserver: (() => void) | null = null;
/** Task session id → owning task id, for the runtime-event observer. */
const watched = new Map<string, string>();
/** Task ids with a dispatch in flight — guards double-fire across ticks. */
const dispatching = new Set<string>();

function notifyRenderer(automationId: string): void {
  sendToRenderer(IPC.AUTOMATION_EVENT, { channel: IPC.AUTOMATION_EVENT, automationId });
}

/* ── Run ledger (Automation.runLog, newest last) ────────────────────────
 * One entry per fire, appended write-before-run in fireTask and settled in
 * place as the run's turn progresses. Terminal entries are frozen — a late
 * event for a previous run can never overwrite them. */

/** Flip the newest non-terminal entry to `status` (no-op when absent,
 *  already terminal, or already in that state — approval gates re-fire). */
function settleRun(automationId: string, status: AutomationRunStatus): void {
  const t = AutomationRepo.get(automationId);
  if (!t || t.runLog.length === 0) return;
  const last = t.runLog[t.runLog.length - 1];
  if (!last || last.status === status) return;
  if (last.status === "success" || last.status === "failed") return;
  const terminal = status === "success" || status === "failed";
  const settled: AutomationRunEntry = {
    ...last,
    status,
    ...(terminal ? { durationMs: Math.max(0, Date.now() - last.firedAt) } : {}),
  };
  AutomationRepo.update(automationId, {
    runLog: [...t.runLog.slice(0, -1), settled],
  });
}

/** "09-19 08:30" — locale-neutral run stamp for run-turn titles. */
function formatRunStamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Seed the watched map from the registry. Called at start and after every
 *  task creation (ipc → registerTaskSession) so status tracking covers
 *  tasks made without a restart. */
function seedWatched(): void {
  for (const t of AutomationRepo.list()) {
    if (t.taskSessionId) watched.set(t.taskSessionId, t.id);
  }
}

/** IPC-created tasks register their session here (start() seeds the rest). */
export function registerTaskSession(taskSessionId: string, automationId: string): void {
  if (taskSessionId) watched.set(taskSessionId, automationId);
}

/** Boot reconciliation: apply the missed-run policy and heal stale rows.
 *  Runs once after the DB is ready, before the first tick. */
function reconcileOnBoot(): void {
  for (const t of AutomationRepo.list()) {
    // A task session left "running"/"approving" by a dead process is not
    // running anymore — mark it so the history never shows phantom activity.
    if (t.taskSessionId) {
      const sess = SessionRepo.get(t.taskSessionId);
      if (sess && (sess.status === "running" || sess.status === "approving")) {
        SessionRepo.updateStatus(sess.id, "interrupted");
        if (t.lastStatus === "running" || t.lastStatus === "waiting-approval") {
          AutomationRepo.update(t.id, { lastStatus: "failed" });
        }
        settleRun(t.id, "failed");
        log.warn(`automation ${t.id}: run orphaned by shutdown — marked interrupted`);
      }
    }
    backfillRunLog(t);
    if (!t.enabled) continue;
    const next = computeNextRun(t.schedule, new Date());
    if (next === null) {
      // A once-task whose moment passed while we were closed — auto-disable
      // (the row and its history stay; the user re-enables with a new time).
      if (t.schedule.type === "once") {
        AutomationRepo.update(t.id, { enabled: false, nextRunAt: null });
        log.info(`automation ${t.id}: once schedule expired — disabled`);
      }
      continue;
    }
    if (t.nextRunAt !== next) AutomationRepo.update(t.id, { nextRunAt: next });
  }
}

/** Seed a task's ledger from its transcript (rows created before the ledger
 *  existed): every user message carrying the dated run header is one fire.
 *  Entries carry no status (unknowable retroactively); runs once per task —
 *  the write-back makes the empty check the "already done" guard. */
function backfillRunLog(t: Automation): void {
  if (!t.taskSessionId || t.runLog.length > 0) return;
  try {
    const anchors = MessageRepo.listRunAnchors(t.taskSessionId);
    if (anchors.length === 0) return;
    AutomationRepo.update(t.id, {
      runLog: anchors.map((firedAt) => ({ firedAt, manual: false })),
    });
    log.info(`automation ${t.id}: backfilled ${anchors.length} run ledger entries`);
  } catch (err) {
    log.warn(`automation run-log backfill failed (${t.id}): ${(err as Error).message}`);
  }
}

/** One scheduler pass. Fire-and-forget per task: a slow sendTurn (worktree
 *  resolution, model bind) must not delay the other due tasks. */
async function tick(): Promise<void> {
  await awaitDb();
  for (const t of AutomationRepo.listDue(Date.now())) {
    if (dispatching.has(t.id)) continue;
    void fireTask(t, { advanceSchedule: true }).catch((err) =>
      log.error(`automation tick dispatch failed (${t.id}): ${(err as Error).message}`),
    );
  }
}

/**
 * Dispatch one run of `task`: append one turn to the task's own session.
 * Returns the task session, or null when the trigger was skipped (overlap
 * guard / missing session / dispatch error).
 *
 * `advanceSchedule` is true for scheduled fires (advances lastRunAt +
 * nextRunAt, disables an exhausted once-task) and false for manual
 * "run now" (records the run, leaves the schedule untouched so the next
 * planned occurrence still happens on time).
 */
export async function fireTask(
  task: Automation,
  opts: { advanceSchedule: boolean },
): Promise<Session | null> {
  dispatching.add(task.id);
  try {
    const t = AutomationRepo.get(task.id);
    if (!t) return null; // deleted between tick and dispatch
    if (!t.taskSessionId) return null; // legacy/unsound row — nothing to run in

    // Overlap protection: the previous turn is still going (running or
    // blocked on an unattended approval). Skip this occurrence — nextRunAt
    // has already advanced, so nothing queues up behind it.
    const sess = SessionRepo.get(t.taskSessionId);
    if (!sess) return null;
    if (sess.status === "running" || sess.status === "approving") {
      log.info(`automation ${t.id}: previous run still in flight — trigger skipped`);
      return null;
    }
    const project = ProjectRepo.get(t.projectId);
    if (!project) {
      AutomationRepo.update(t.id, { lastStatus: "failed" });
      notifyRenderer(t.id);
      log.warn(`automation ${t.id}: project ${t.projectId} missing — run failed`);
      return null;
    }

    const now = Date.now();
    const patch: Partial<Automation> = {
      lastRunAt: now,
      lastStatus: "running",
      runLog: [...t.runLog, { firedAt: now, manual: !opts.advanceSchedule, status: "running" }],
    };
    if (opts.advanceSchedule) {
      const next = computeNextRun(t.schedule, new Date());
      patch.nextRunAt = next;
      // A once-task has fired its only shot — auto-disable, keep the row.
      if (next === null && t.schedule.type === "once") patch.enabled = false;
    }
    AutomationRepo.update(t.id, patch);
    notifyRenderer(t.id);

    // One fire = one turn: the run's prompt (with a dated run header so the
    // transcript reads as a sequence of dated runs).
    SessionRepo.updateStatus(sess.id, "running");
    // Re-apply the task's exec config onto the session row on EVERY fire —
    // sendTurn resolves the run's endpoint credentials from the SESSION row
    // (customModelId → apiConfig), so this is what makes「编辑任务」reach the
    // next run, and what repairs rows created before the config was passed
    // at creation (they read claude-sdk/default and failed "Not logged in"
    // on custom-endpoint setups).
    SessionRepo.updateSettings(sess.id, {
      providerId: t.providerId,
      model: t.model,
      effort: t.effort,
      permissionMode: t.permissionMode,
      customModelId: t.customModelId,
    });
    const cwd = await resolveSessionCwd(sess, project);
    const fresh = SessionRepo.get(sess.id) ?? sess;
    runtimeManager.bindSession(fresh);
    await runtimeManager.sendTurn(fresh, {
      prompt: composeRunPrompt(t, now),
      cwd,
      // "/"-menu skills ride the SDK skills allowlist — stream-json input
      // never re-parses the "/name" literals left in the prompt text.
      ...(t.skillNames.length > 0 ? { skills: t.skillNames } : {}),
    });
    log.info(`automation fired: task ${t.id} -> turn in ${sess.id}`);
    return sess;
  } catch (err) {
    const message = (err as Error).message;
    log.warn(`automation dispatch failed (${task.id}): ${message}`);
    AutomationRepo.update(task.id, { lastStatus: "failed" });
    settleRun(task.id, "failed");
    notifyRenderer(task.id);
    return null;
  } finally {
    dispatching.delete(task.id);
  }
}

/** Prompt for a run: task text first (with a dated run header), then one
 *  bare "@path" line per attached file — the exact representation the chat
 *  composer sends for file tags (composePromptWithTags' file branch). The
 *  model reads current file content via its tools at run time. */
function composeRunPrompt(t: Automation, now: number): string {
  const header = `${RUN_HEADER_PREFIX} ${formatRunStamp(now)}]`;
  const text = t.prompt.trim();
  const body = text ? `${header}\n\n${text}` : header;
  if (t.filePaths.length === 0) return body;
  return `${body}\n\n${t.filePaths.map((p) => `@${p}`).join("\n")}`;
}

/** Runtime-event observer: track the watched task session's lifecycle into
 *  the task's lastStatus. Non-automation sessions cost one Map lookup. */
function onRuntimeEvent(e: RuntimeEvent): void {
  const sessionId = (e as { sessionId?: string }).sessionId;
  if (!sessionId) return;
  const automationId = watched.get(sessionId);
  if (!automationId) return;

  if (
    e.type === "approval.request" ||
    e.type === "question.ask" ||
    e.type === "plan.approval_request"
  ) {
    // Blocked on the user. The OS notification already went out through the
    // NotificationManager (window unfocused); the task badge follows along.
    if (AutomationRepo.get(automationId)?.lastStatus !== "waiting-approval") {
      AutomationRepo.update(automationId, { lastStatus: "waiting-approval" });
      notifyRenderer(automationId);
    }
    settleRun(automationId, "waiting-approval");
    return;
  }

  if (e.type === "error") {
    AutomationRepo.update(automationId, { lastStatus: "failed" });
    settleRun(automationId, "failed");
    notifyRenderer(automationId);
    return;
  }

  if (e.type === "turn.done") {
    // reason=tool_use is the intermediate "main loop continues" boundary
    // (background subagents may still be running) — not terminal.
    if (e.reason === "tool_use") return;
    const ok = e.reason === "end_turn" || e.reason === "max_tokens";
    AutomationRepo.update(automationId, { lastStatus: ok ? "success" : "failed" });
    settleRun(automationId, ok ? "success" : "failed");
    notifyRenderer(automationId);
    pruneExpiredTurns(automationId);
  }
}

/** Retention sweep for one task: trim TURN history beyond keepRuns (a turn
 *  anchors on its user message — see MessageRepo.trimTurns). The run ledger
 *  trims to the same cap so entries can't outlive their transcript. */
function pruneExpiredTurns(automationId: string): void {
  try {
    const t = AutomationRepo.get(automationId);
    if (!t?.taskSessionId) return;
    const removed = MessageRepo.trimTurns(t.taskSessionId, t.keepRuns);
    if (t.runLog.length > t.keepRuns) {
      AutomationRepo.update(automationId, { runLog: t.runLog.slice(-t.keepRuns) });
    }
    if (removed > 0) log.info(`automation ${automationId}: trimmed ${removed} old message(s)`);
  } catch (err) {
    log.warn(`automation prune failed (${automationId}): ${(err as Error).message}`);
  }
}

async function start(): Promise<void> {
  await awaitDb();
  reconcileOnBoot();
  seedWatched();
  detachObserver = runtimeManager.addObserver(onRuntimeEvent);
  timer = setInterval(() => {
    void tick().catch((err) => log.error(`automation tick failed: ${(err as Error).message}`));
  }, TICK_INTERVAL_MS);
  log.info("automation scheduler started");
}

/** Wire the delayed first tick. Idempotent (mirrors initAutoArchiver). */
export function initAutomationScheduler(): void {
  if (initialized) return;
  initialized = true;
  setTimeout(() => {
    void start().catch((err) => log.error(`automation scheduler start failed: ${(err as Error).message}`));
  }, FIRST_TICK_DELAY_MS);
}

/** Shutdown: stop ticking, detach the observer. In-flight runs die with the
 *  process — reconcileOnBoot marks them interrupted on the next start. */
export function disposeAutomationScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
  detachObserver?.();
  detachObserver = null;
  watched.clear();
  dispatching.clear();
  initialized = false;
}
