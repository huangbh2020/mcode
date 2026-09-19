/**
 * 编排触发开关(Composer 顶部条,SessionDirectoryChip 同级)。
 *
 * 「自动编排」开关:开启后发送的想法在本会话内以编排规划者模式执行
 * (orchestration 标记 → main 注入规划者提示与 orch_submit_plan 工具 →
 * 会话内产出画布,历史照常累积,多轮调整天然携带上下文)。
 * 原 @@agent 目标簇已随 agent 角色域退役。
 */
import { useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { isElectron } from "@renderer/lib/platform.js";
import { IconClock, IconSparkles, IconX } from "@renderer/lib/icons.js";
import { ScheduleEditor } from "@renderer/components/automation/ScheduleEditor.js";
import { describeSchedule } from "@renderer/components/automation/automationFormat.js";
import type { AutomationSchedule } from "@contracts/automation";

export function OrchComposerChips({ sessionId }: { sessionId: string }) {
  const { t } = useI18n();
  // Desktop-only: the orchestration RPC surface is absent on the web/mobile
  // shim (api.orch throws webUnsupported), so the trigger must not render.
  if (!isElectron) return null;
  return <OrchComposerChipsInner sessionId={sessionId} t={t} />;
}

function OrchComposerChipsInner({ sessionId, t }: { sessionId: string; t: ReturnType<typeof useI18n>["t"] }) {
  const auto = useSessionStore((s) => !!s.orchAutoBySession[sessionId]);
  const setOrchAuto = useSessionStore((s) => s.setOrchAuto);

  return (
    <div className="flex min-w-0 items-center gap-1">
      <ScheduleChip sessionId={sessionId} />
      <button
        type="button"
        onClick={() => setOrchAuto(sessionId, !auto)}
        className={cn(
          "flex h-6 items-center gap-1.5 rounded-md border px-1.5 text-[11px] transition-colors",
          auto
            ? "border-accent bg-accent/15 text-accent"
            : "border-edge text-content-muted hover:border-accent hover:text-accent",
        )}
        title={t("orch.composer.autoOn")}
      >
        <IconSparkles size={12} />
        {t("orch.composer.auto")}
        <span
          className={cn(
            "relative h-2.5 w-5 rounded-full transition-colors",
            auto ? "bg-accent" : "bg-content-subtle/40",
          )}
        >
          <span
            className={cn(
              "absolute top-0.5 h-1.5 w-1.5 rounded-full bg-surface transition-all",
              auto ? "left-3" : "left-0.5",
            )}
          />
        </span>
      </button>
    </div>
  );
}


/* ── 「定时任务」按钮(自动编排右侧,v2 创建入口)──
 * 点击弹出定时配置弹层(ScheduleEditor,与调度器同源的下次运行预览);
 * 配置存 taskScheduleBySession,handleSend 拦截:有配置的发送 → 创建任务会话
 * (当前会话留回执),不进普通回合。 */
function ScheduleChip({ sessionId }: { sessionId: string }) {
  const { t } = useI18n();
  // 开合状态在 store(/schedule 内置命令、回执卡片都可远程拉起弹层)。
  const open = useSessionStore((s) => !!s.taskScheduleEditorOpenBySession[sessionId]);
  const setOpen = (v: boolean) => setTaskScheduleEditorOpen(sessionId, v);
  const setTaskScheduleEditorOpen = useSessionStore((s) => s.setTaskScheduleEditorOpen);
  const schedule = useSessionStore((s) => s.taskScheduleBySession[sessionId] ?? null);
  const setTaskSchedule = useSessionStore((s) => s.setTaskSchedule);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        title={schedule ? describeSchedule(schedule) : t("automation.sectionScheduleDesc")}
        className={cn(
          "flex h-6 items-center gap-1.5 rounded-md border px-1.5 text-[11px] transition-colors",
          schedule
            ? "border-accent bg-accent/15 font-semibold text-accent"
            : "border-dashed border-edge text-content-muted hover:border-accent hover:text-accent",
          open && "border-accent text-accent",
        )}
      >
        <IconClock size={12} />
        <span className="max-w-[110px] truncate">
          {schedule ? describeSchedule(schedule) : t("automation.composerBtn")}
        </span>
        {schedule && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              setTaskSchedule(sessionId, null);
            }}
            onMouseDown={(e) => e.preventDefault()}
            className="-mr-0.5 rounded-full p-0.5 hover:bg-accent/20"
            title={t("common.cancel")}
          >
            <IconX size={9} />
          </span>
        )}
      </button>
      {open && (
        <>
          <div
            className="fixed inset-0 z-[60]"
            onClick={() => setOpen(false)}
            onMouseDown={(e) => e.preventDefault()}
          />
          <div className="absolute bottom-full left-0 z-[65] mb-1.5 w-[330px] rounded-xl border border-panel-edge bg-surface p-3 shadow-2xl">
            <div className="mb-2 flex items-center gap-1.5 text-[12px] font-bold">
              <IconClock size={12} className="text-accent" />
              {t("automation.composerBtn")} · {t("automation.sectionSchedule")}
            </div>
            <ScheduleEditor
              schedule={schedule ?? { type: "daily", time: "09:00" }}
              onChange={(next) => setTaskSchedule(sessionId, next)}
            />
            <div className="mt-2 text-[10.5px] leading-relaxed text-content-subtle">
              {t("automation.sched.composerHint")}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
