/**
 * 编排触发开关(Composer 顶部条,SessionDirectoryChip 同级)。
 *
 * 「自动编排」开关:开启后发送的想法在本会话内以编排规划者模式执行
 * (orchestration 标记 → main 注入规划者提示与 orch_submit_plan 工具 →
 * 会话内产出画布,历史照常累积,多轮调整天然携带上下文)。
 * 原 @@agent 目标簇已随 agent 角色域退役。
 */
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { isElectron } from "@renderer/lib/platform.js";
import { IconSparkles } from "@renderer/lib/icons.js";

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
