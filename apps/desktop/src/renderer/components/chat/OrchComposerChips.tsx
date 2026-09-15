/**
 * 编排触发 chips(Composer 顶部条,SessionDirectoryChip 同级)。
 *
 * ① 「编排」按钮:打开向导(显式触发档);
 * ② 协调者开关:本会话下一轮注入编排 MCP 工具集(主 agent 当协调者);
 * ③ @@agent 目标簇:@@ 选择器挑中的角色 chips,含 移交/编排 模式切换
 *    与逐个移除 —— 发送时由 sendPrompt 的编排拦截消费。
 */
import { useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { isElectron } from "@renderer/lib/platform.js";
import { IconGitFork, IconX, IconUsers } from "@renderer/lib/icons.js";

export function OrchComposerChips({ sessionId }: { sessionId: string }) {
  const { t } = useI18n();
  // Desktop-only: the orchestration RPC surface is absent on the web/mobile
  // shim (api.orch throws webUnsupported), so the triggers must not render.
  if (!isElectron) return null;
  return <OrchComposerChipsInner sessionId={sessionId} t={t} />;
}

function OrchComposerChipsInner({ sessionId, t }: { sessionId: string; t: ReturnType<typeof useI18n>["t"] }) {
  const openOrchWizard = useSessionStore((s) => s.openOrchWizard);
  const coordinator = useSessionStore((s) => !!s.orchCoordinatorBySession[sessionId]);
  const setOrchCoordinator = useSessionStore((s) => s.setOrchCoordinator);
  const targets = useSessionStore((s) => s.orchTargetsBySession[sessionId] ?? EMPTY_TARGETS);
  const agents = useSessionStore((s) => s.orchAgents);
  const removeOrchTarget = useSessionStore((s) => s.removeOrchTarget);
  const setOrchTargetMode = useSessionStore((s) => s.setOrchTargetMode);
  const clearOrchTargets = useSessionStore((s) => s.clearOrchTargets);

  const agentOf = (id: string) => agents.find((a) => a.id === id);
  const mode = targets[0]?.mode ?? "handoff";

  return (
    <div className="flex min-w-0 items-center gap-1">
      {/* 编排向导入口(显式触发) */}
      <button
        type="button"
        onClick={() => openOrchWizard()}
        className="flex h-6 items-center gap-1 rounded-md border border-edge px-1.5 text-[11px] text-content-muted transition-colors hover:border-accent hover:text-accent"
        title={t("orch.composer.orchestrate")}
      >
        <IconGitFork size={12} />
        {t("orch.composer.orchestrate")}
      </button>

      {/* 协调者开关 */}
      <button
        type="button"
        onClick={() => setOrchCoordinator(sessionId, !coordinator)}
        title={coordinator ? t("orch.composer.coordinatorOn") : t("orch.composer.coordinatorOff")}
        className={cn(
          "flex h-6 items-center gap-1 rounded-md border px-1.5 text-[11px] transition-colors",
          coordinator
            ? "border-accent bg-accent/15 text-accent"
            : "border-edge text-content-muted hover:border-accent hover:text-accent",
        )}
      >
        <IconUsers size={12} />
        {coordinator ? t("orch.composer.coordinator") : t("orch.composer.orchestrate")}
      </button>

      {/* @@agent 目标簇 */}
      {targets.length > 0 && (
        <div
          className={cn(
            "flex min-w-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px]",
            mode === "orchestrate"
              ? "border-accent/50 bg-accent/10 text-accent"
              : "border-warning/50 bg-warning/10 text-warning",
          )}
        >
          {targets.map((x) => {
            const agent = agentOf(x.profileId);
            return (
              <span key={x.profileId} className="flex items-center gap-0.5">
                <span className="max-w-[120px] truncate">
                  {agent?.icon} {agent?.name ?? x.profileId}
                </span>
                <button
                  type="button"
                  onClick={() => removeOrchTarget(sessionId, x.profileId)}
                  className="rounded-full p-0.5 hover:bg-surface-hover"
                  aria-label="remove"
                >
                  <IconX size={10} />
                </button>
              </span>
            );
          })}
          {/* 模式切换:单目标默认移交,可切编排;多目标强制编排 */}
          <button
            type="button"
            disabled={targets.length > 1}
            onClick={() => setOrchTargetMode(sessionId, mode === "handoff" ? "orchestrate" : "handoff")}
            title={t(mode === "handoff" ? "orch.composer.mode.orchestrate" : "orch.composer.mode.handoff")}
            className="ml-0.5 rounded border border-edge px-1 text-[10px] disabled:opacity-50"
          >
            {t(mode === "handoff" ? "orch.composer.mode.handoff" : "orch.composer.mode.orchestrate")}
          </button>
          <button type="button" onClick={() => clearOrchTargets(sessionId)} className="rounded p-0.5 hover:bg-surface-hover" aria-label="clear">
            <IconX size={10} />
          </button>
        </div>
      )}
    </div>
  );
}

const EMPTY_TARGETS: { profileId: string; mode: "handoff" | "orchestrate" }[] = [];
