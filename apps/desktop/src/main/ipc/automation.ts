/**
 * IPC handlers for scheduled-task automation (v2「任务即会话」): CRUD over the
 * `automations` registry + manual run. The task's VISIBLE session is created
 * together with the task (kind="automation", broadcast like a normal session)
 * and every fire appends a turn to it — the scheduler owns the firing, this
 * file owns persistence + lifecycle.
 */
import { IPC } from "@contracts/ipc";
import {
  AutomationSaveSchema,
  AutomationSetEnabledSchema,
  AutomationParseIntentSchema,
  AutomationDeleteSchema,
  AutomationRestoreSchema,
} from "@contracts/ipc";
import { computeNextRun } from "@contracts/automation";
import type { AutomationSchedule } from "@contracts/automation";
import { uid } from "@main/utils.js";
import { AutomationRepo, SessionRepo } from "@main/store/repositories.js";
import { runtimeManager } from "@main/claude/RuntimeManager.js";
import { createOrReuseSession } from "@main/lib/sessionStart.js";
import { fireTask, registerTaskSession } from "@main/automation/AutomationScheduler.js";
import { parseScheduleIntent } from "@main/automation/intentParser.js";
import { sendToRenderer } from "@main/window.js";
import { broadcastSessionChanged, broadcastSessionDeleted } from "@main/lib/sessionSync.js";
import { generateSessionTitle } from "@main/ipc/titleGen.js";
import { log } from "@main/lib/logger.js";
import type { IpcMain } from "electron";

function notify(automationId: string | null): void {
  sendToRenderer(IPC.AUTOMATION_EVENT, { channel: IPC.AUTOMATION_EVENT, automationId });
}

/** Recompute the scan index for a task row. Disabled tasks carry NULL; a
 *  once-task whose moment already passed lands enabled=false + NULL (saving
 *  an expired one-shot reads as "auto-disable", matching the editor note). */
function nextRunAtFor(enabled: boolean, schedule: AutomationSchedule): number | null {
  if (!enabled) return null;
  return computeNextRun(schedule, new Date());
}

export function registerAutomationHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.AUTOMATION_LIST, () => {
    return { automations: AutomationRepo.list() };
  });

  ipcMain.handle(IPC.AUTOMATION_SAVE, (_evt, raw) => {
    const input = AutomationSaveSchema.parse(raw);
    const now = Date.now();
    let enabled = input.enabled;
    let next = nextRunAtFor(enabled, input.schedule);
    if (next === null && input.schedule.type === "once") enabled = false;

    if (input.id) {
      const updated = AutomationRepo.update(input.id, {
        projectId: input.projectId,
        title: input.title,
        prompt: input.prompt,
        skillNames: input.skillNames,
        filePaths: input.filePaths,
        providerId: input.providerId,
        model: input.model,
        customModelId: input.customModelId ?? null,
        effort: input.effort,
        permissionMode: input.permissionMode,
        schedule: input.schedule,
        enabled,
        keepRuns: input.keepRuns,
        nextRunAt: next,
      });
      if (!updated) throw new Error(`automation not found: ${input.id}`);
      notify(updated.id);
      log.info(`automation saved: ${updated.id} (${updated.title})`);
      return { automation: updated };
    }

    // Create: the task's OWN visible session comes first (it carries the
    // automationId so the session row links back to the task), then the
    // registry row points at it. Every later fire appends a turn to it.
    // The exec config MUST land on the session row — sendTurn resolves the
    // run's credentials (customModelId → apiConfig) from the SESSION, not
    // from the automation row; without this every run would use the default
    // credential discovery and fail "Not logged in" for custom-endpoint
    // setups.
    // 按照普通会话的命名规则推导初始标题：
    // 用户未显式提供自定义标题时，优先根据 prompt 前 40 字符截断命名；若无 prompt 则使用 "New session"
    const trimmedCustomTitle = input.title?.trim();
    const promptFallback = input.prompt?.trim()
      ? input.prompt.trim().slice(0, 40) + (input.prompt.trim().length > 40 ? "…" : "")
      : "";
    const isAutoDerived =
      !trimmedCustomTitle ||
      trimmedCustomTitle === promptFallback ||
      trimmedCustomTitle === "未命名任务" ||
      trimmedCustomTitle === "Untitled task";
    const initialTitle = (!isAutoDerived && trimmedCustomTitle) ? trimmedCustomTitle : (promptFallback || "New session");

    const id = uid("auto_");
    const { session } = createOrReuseSession(
      {
        projectId: input.projectId,
        title: initialTitle,
        kind: "automation",
        automationId: id,
        parentSessionId: input.parentSessionId,
        providerId: input.providerId,
        model: input.model,
        customModelId: input.customModelId ?? null,
        effort: input.effort,
        permissionMode: input.permissionMode,
      },
      "desktop",
    );
    AutomationRepo.create({
      id,
      projectId: input.projectId,
      title: initialTitle,
      taskSessionId: session.id,
      parentSessionId: input.parentSessionId ?? null,
      prompt: input.prompt,
      skillNames: input.skillNames,
      filePaths: input.filePaths,
      providerId: input.providerId ?? "claude-sdk",
      model: input.model ?? "default",
      customModelId: input.customModelId ?? null,
      effort: input.effort,
      permissionMode: input.permissionMode,
      schedule: input.schedule,
      enabled,
      keepRuns: input.keepRuns,
      lastRunAt: null,
      nextRunAt: next,
      lastStatus: null,
      runLog: [],
      lastSessionId: session.id,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    registerTaskSession(session.id, id);
    const created = AutomationRepo.get(id)!;
    notify(null);
    log.info(`automation created: ${id} (${created.title}) -> session ${session.id}`);

    // 若属于自动派生标题，且有有效 prompt，按照普通会话机制在后台异步生成智能标题
    if (isAutoDerived && input.prompt?.trim()) {
      void generateSessionTitle(session, input.prompt).catch((err) =>
        log.warn(`title generation failed for automation ${id}: ${(err as Error).message}`),
      );
    }

    return { automation: created };
  });

  ipcMain.handle(IPC.AUTOMATION_DELETE, (_evt, raw) => {
    const input = AutomationDeleteSchema.parse(raw);
    const task = AutomationRepo.get(input.id);
    if (!task) return { permanent: false };

    // v2: 如果该任务已经打上已删除标识，或者显式指定了 permanent: true，执行彻底硬删除
    const isPermanent = !!input.permanent || task.deletedAt != null;
    if (isPermanent) {
      if (task.taskSessionId) {
        runtimeManager.dispose(task.taskSessionId);
        SessionRepo.setArchived(task.taskSessionId, true);
        const row = SessionRepo.get(task.taskSessionId);
        if (row) broadcastSessionChanged(row);
        SessionRepo.delete(task.taskSessionId);
        broadcastSessionDeleted(task.taskSessionId);
      }
      AutomationRepo.delete(input.id);
      notify(null);
      log.info(`automation hard-deleted: ${input.id} (task session and history removed)`);
      return { permanent: true };
    }

    // 否则执行软删除：打标记，停用任务，保留实例会话与记录
    const updated = AutomationRepo.softDelete(input.id);
    notify(input.id);
    log.info(`automation soft-deleted: ${input.id} (${task.title})`);
    return { permanent: false, automation: updated ?? undefined };
  });

  ipcMain.handle(IPC.AUTOMATION_RESTORE, (_evt, raw) => {
    const input = AutomationRestoreSchema.parse(raw);
    const current = AutomationRepo.get(input.id);
    if (!current) throw new Error(`automation not found: ${input.id}`);
    const next = nextRunAtFor(true, current.schedule);
    const updated = AutomationRepo.restore(input.id, next);
    notify(input.id);
    log.info(`automation restored: ${input.id} (${current.title})`);
    return { automation: updated! };
  });

  ipcMain.handle(IPC.AUTOMATION_SET_ENABLED, (_evt, raw) => {
    const input = AutomationSetEnabledSchema.parse(raw);
    const current = AutomationRepo.get(input.id);
    if (!current) throw new Error(`automation not found: ${input.id}`);
    const next = nextRunAtFor(input.enabled, current.schedule);
    const updated = AutomationRepo.update(input.id, { enabled: input.enabled, nextRunAt: next });
    notify(input.id);
    return { automation: updated! };
  });

  ipcMain.handle(IPC.AUTOMATION_PARSE_INTENT, async (_evt, raw) => {
    const input = AutomationParseIntentSchema.parse(raw);
    return { intent: await parseScheduleIntent(input.text) };
  });

  ipcMain.handle(IPC.AUTOMATION_RUN_NOW, async (_evt, raw) => {
    const { id } = raw as { id: string };
    const task = AutomationRepo.get(id);
    if (!task) throw new Error(`automation not found: ${id}`);
    // Manual run: record the run, don't advance the schedule (the next
    // planned occurrence must still fire on time). null = overlap-guarded.
    const session = await fireTask(task, { advanceSchedule: false });
    return { session };
  });
}
