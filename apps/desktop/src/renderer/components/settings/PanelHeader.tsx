/**
 * PanelHeader — the page header of every settings page.
 *
 * Plan-A structure (prototypes/settings-redesign.html): the header is no
 * longer a `sticky` bar inside the scrolling body — `SettingsPage` renders a
 * fixed header slot above the single scroll container and publishes it via
 * `SettingsShellContext`, and this component portals its <header> into that
 * slot. The header therefore always spans the full page width (hairline
 * included) while the panels below scroll underneath it, with no sticky +
 * negative-margin tricks.
 *
 * Panels keep writing `<PanelHeader title=… icon=… action=…/>` unchanged; the
 * page icon and the one-line page description default to the values registered
 * by `SettingsPage` for the active nav item, so page identity lives in one
 * place (the nav registry) instead of being repeated per panel. A panel can
 * still override either explicitly.
 *
 * Visual hierarchy inside a settings page (plan A — two levels):
 *   1. PanelHeader     — page icon + title (+ description) + right action slot
 *   2. SettingsSection — card with its own header (icon + title + description)
 *   3. SettingRow      — setting row inside the card
 *
 * The right slot hosts panel actions (e.g. the shortcuts panel's "恢复全部默认"
 * or the usage panel's range presets); events from it still bubble through the
 * React tree, so portaling does not change their behaviour.
 */
import type { ComponentType, ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@renderer/lib/cn.js";
import type { TablerIconProps } from "@renderer/lib/icons.js";
import { useSettingsShell } from "./settingsShell.js";

export function PanelHeader({
  title,
  desc,
  icon: Icon,
  action,
  className,
}: {
  title: string;
  /** Subtitle under the title. Defaults to the nav item's description. */
  desc?: ReactNode;
  /** Page glyph inside the accent tile. Defaults to the nav item's icon. */
  icon?: ComponentType<TablerIconProps>;
  /** Right-aligned action slot (e.g. a "恢复默认" button). */
  action?: ReactNode;
  className?: string;
}) {
  const shell = useSettingsShell();
  const Glyph = Icon ?? shell?.pageIcon;
  const description = desc ?? shell?.pageDesc;

  const header = (
    <header
      className={cn(
        "flex items-center gap-3 border-b border-edge-panel bg-surface px-6 py-3.5",
        className,
      )}
    >
      {Glyph && (
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-accent/10 text-accent">
          <Glyph size={17} />
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <h2 className="truncate text-[1.1071em] font-semibold leading-tight text-content">
          {title}
        </h2>
        {description && (
          <p className="truncate text-[0.8571em] leading-snug text-content-subtle">
            {description}
          </p>
        )}
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </header>
  );

  // No shell above (bare use): render in place, the component stands alone.
  if (!shell) return header;
  // Inside the shell the slot owns the header's position; the ref callback that
  // fills it flushes before paint, so there is no visible first frame without it.
  return shell.headerSlot ? createPortal(header, shell.headerSlot) : null;
}
