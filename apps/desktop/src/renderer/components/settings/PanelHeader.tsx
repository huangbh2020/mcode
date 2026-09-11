/**
 * PanelHeader — the sticky toolbar pinned at the top of every settings panel.
 *
 * This is the TOP of the visual hierarchy inside a settings page:
 *   1. PanelHeader  — 吸顶工具条:页面标题 + 右侧动作槽,随滚动钉在内容区顶部
 *   2. SettingsSection — 分组标题 (0.93em semibold) + 卡片
 *   3. SettingRow   — 卡片内的设置行
 *
 * There is deliberately NO page-level description line: the nav item the user
 * just clicked already names the page, so a repeated banner description only
 * pushed the first settings card below the fold. Anything worth saying lives
 * on the section or the row that needs it.
 *
 * `icon` renders an accent-tinted glyph next to the title; `action` is an
 * optional right-aligned slot (e.g. the shortcuts panel's "恢复全部默认"
 * button or the usage panel's range presets). The bar sticks to the top of
 * the scrolling center pane (`bg-surface` — same as the pane itself — plus a
 * hairline) so cards scroll underneath it; in full-height two-column panels
 * (Skills / custom models) the center pane doesn't scroll, so the bar simply
 * sits at the top.
 *
 * The `mt-5` supplies the initial top gap inside the center pane — the pane
 * itself must stay free of top padding, because Chromium anchors a sticky
 * child below the scroll container's padding-top, which would leave a
 * visible strip above the stuck bar (self-margin does NOT offset the stuck
 * position, so this is the safe way to space it).
 */
import type { ComponentType, ReactNode } from "react";
import { cn } from "@renderer/lib/cn.js";
import type { TablerIconProps } from "@renderer/lib/icons.js";

export function PanelHeader({
  title,
  icon: Icon,
  action,
  className,
}: {
  title: string;
  icon?: ComponentType<TablerIconProps>;
  /** Right-aligned action slot (e.g. a "恢复默认" button). */
  action?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        "sticky top-0 z-10 mb-1 mt-5 flex items-center justify-between gap-4",
        "border-b border-edge bg-surface py-2.5",
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        {Icon && <Icon size={16} className="shrink-0 text-accent" />}
        <h2 className="truncate text-[0.9286em] font-semibold leading-tight text-content">
          {title}
        </h2>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </header>
  );
}
