/**
 * SettingsSection — a functional category inside a settings panel.
 *
 * Plan-A card (prototypes/settings-redesign.html): the section title and its
 * description live INSIDE the card as the card's own header (icon chip + title
 * + description, with an optional right-aligned meta slot), and the setting
 * rows follow below the hairline. That folds the old third hierarchy level
 * ("eyebrow above a card") into the card itself — same information, two levels
 * instead of three, and ~30px less vertical space per group.
 *
 * @example
 *   <SettingsSection title="提交记录生成" desc="配置生成提交信息的模型与提示词。">
 *     <SettingRow title="生成模型">…</SettingRow>
 *   </SettingsSection>
 */
import type { ComponentType, ReactNode } from "react";
import { cn } from "@renderer/lib/cn.js";
import type { TablerIconProps } from "@renderer/lib/icons.js";

export function SettingsSection({
  title,
  desc,
  icon: Icon,
  action,
  className,
  children,
}: {
  /** Card title (one size step up from the row titles inside). */
  title: string;
  desc?: ReactNode;
  /** Optional glyph for the 26px header tile. */
  icon?: ComponentType<TablerIconProps>;
  /** Optional right-aligned header slot (badge, count, button…). */
  action?: ReactNode;
  className?: string;
  /** Setting rows (SettingRow) — share the hairline separators below. */
  children: ReactNode;
}) {
  return (
    <section
      className={cn(
        "overflow-hidden rounded-xl border border-edge bg-surface shadow-[0_1px_2px_rgb(9_9_11/0.04)]",
        className,
      )}
    >
      <div className="flex items-start gap-2.5 px-3.5 pt-3.5">
        {Icon && (
          <span className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-lg bg-surface-muted text-content-muted">
            <Icon size={15} />
          </span>
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h3 className="text-[0.9643em] font-semibold leading-snug text-content">
            {title}
          </h3>
          {desc && (
            <p className="text-[0.8571em] leading-relaxed text-content-subtle">
              {desc}
            </p>
          )}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      <div className="mt-2.5 divide-y divide-edge">{children}</div>
    </section>
  );
}
