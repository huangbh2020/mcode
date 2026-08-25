/**
 * SettingsSection — a functional category inside a settings panel.
 *
 * The middle level of the settings visual hierarchy (see PanelHeader):
 * a category label (the "功能分类标题") sits above a bordered Card that
 * contains the actual setting rows (the "功能标题" + controls). The label is
 * deliberately one size step up from the row titles (0.93em semibold content
 * vs 0.86em medium) — group vs row must be tellable apart at a glance.
 *
 * @example
 *   <SettingsSection title="提交记录生成" desc="配置生成提交信息的模型与提示词。">
 *     <SettingRow title="生成模型">…</SettingRow>
 *   </SettingsSection>
 */
import type { ComponentType, ReactNode } from "react";
import { cn } from "@renderer/lib/cn.js";
import { Card } from "@renderer/components/ui/index.js";
import type { TablerIconProps } from "@renderer/lib/icons.js";

export function SettingsSection({
  title,
  desc,
  icon: Icon,
  className,
  children,
}: {
  /** 分类标题 (rendered as a small muted eyebrow above the card). */
  title: string;
  desc?: ReactNode;
  icon?: ComponentType<TablerIconProps>;
  className?: string;
  /** Setting rows (SettingRow) — share `divide-y` hairlines inside the card. */
  children: ReactNode;
}) {
  return (
    <section className={cn("space-y-1.5", className)}>
      <div className="flex items-center gap-1.5 px-1">
        {Icon && <Icon size={15} className="shrink-0 text-content-muted" />}
        <h3 className="text-[0.9286em] font-semibold text-content">
          {title}
        </h3>
      </div>
      {desc && (
        <p className="px-1 text-[0.7857em] leading-relaxed text-content-subtle">
          {desc}
        </p>
      )}
      <Card className="divide-y divide-edge">{children}</Card>
    </section>
  );
}
