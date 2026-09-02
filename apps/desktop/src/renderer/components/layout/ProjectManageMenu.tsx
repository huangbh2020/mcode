/**
 * ProjectManageMenuPopup — the light project-manager menu shared by the
 * composer's directory switcher (SessionDirectoryChip) and the stream
 * sidebar's scope dropdown (StreamSidebar): rename / group membership
 * (leave, join known groups, create new) / avatar color — preset swatches
 * PLUS a native custom color picker (`<input type="color">`, Chromium's
 * shade/hue/HEX palette).
 *
 * Rendered as its own cursor-anchored Menu.Root so it can open from inside
 * another base-ui menu without nesting: the caller closes its own popup
 * first, then sets the `manageMenu` state this component renders from
 * (the pattern both call sites follow).
 */
import { Menu } from "@base-ui/react/menu";
import { cn } from "@renderer/lib/cn.js";
import {
  IconCheck,
  IconFolder,
  IconFolderMinus,
  IconPencil,
} from "@renderer/lib/icons.js";
import { PROJECT_COLOR_SWATCHES } from "@renderer/lib/projectAvatar.js";
import { useCursorAnchor } from "@renderer/hooks/useCursorAnchor.js";
import type { Project } from "@contracts/session";
import { useI18n } from "@renderer/lib/i18n/index.js";

export interface ManageMenuState {
  project: Project;
  x: number;
  y: number;
}

interface ProjectManageMenuPopupProps {
  manageMenu: ManageMenuState | null;
  anchor: ReturnType<typeof useCursorAnchor>;
  knownGroups: string[];
  projectColors: Record<string, string>;
  onClose: () => void;
  onRename: (p: Project) => void;
  onLeaveGroup: (p: Project) => void;
  onJoinGroup: (p: Project, group: string) => void;
  onNewGroup: (p: Project) => void;
  onSetColor: (p: Project, hex: string | null) => void;
  menuItemClass: string;
}

export function ProjectManageMenuPopup({
  manageMenu, anchor, knownGroups, projectColors,
  onClose, onRename, onLeaveGroup, onJoinGroup, onNewGroup, onSetColor,
  menuItemClass,
}: ProjectManageMenuPopupProps) {
  const { t } = useI18n();
  const project = manageMenu?.project ?? null;
  const customHex = project ? projectColors[project.id] ?? null : null;
  // `input[type=color]` demands a lowercase #rrggbb value; fall back to the
  // first swatch when the project is on its hash-derived default.
  const pickerHex = (customHex ?? PROJECT_COLOR_SWATCHES[0]).toLowerCase();
  const customOffPalette = customHex != null && !PROJECT_COLOR_SWATCHES.includes(customHex);
  return (
    <Menu.Root open={!!manageMenu} onOpenChange={(o) => { if (!o) onClose(); }}>
      <Menu.Portal>
        <Menu.Positioner anchor={anchor} side="bottom" align="start">
          <Menu.Popup
            className={cn(
              "z-50 min-w-[190px] origin-top-left rounded-md border border-edge bg-surface py-1 shadow-2xl",
              "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
              "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
              "transition-[transform,opacity] duration-100",
            )}
          >
            <Menu.Item className={menuItemClass} onClick={() => project && onRename(project)}>
              <IconPencil size={13} className="shrink-0" />
              {t("layout.renameProject")}
            </Menu.Item>
            {project?.group && (
              <Menu.Item className={menuItemClass} onClick={() => onLeaveGroup(project)}>
                <IconFolderMinus size={13} className="shrink-0" />
                {t("layout.removeFromGroup")}
              </Menu.Item>
            )}

            {/* Group membership — join a known group or create a new one. */}
            <div className="px-3 pb-0.5 pt-1.5 text-[9px] uppercase tracking-wide text-content-subtle">
              {t("layout.moveToGroup")}
            </div>
            {knownGroups.map((g) => (
              <Menu.Item
                key={g}
                className={menuItemClass}
                onClick={() => project && onJoinGroup(project, g)}
              >
                <IconFolder size={13} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate">{g}</span>
                {project?.group === g && <IconCheck size={12} className="shrink-0 text-accent" />}
              </Menu.Item>
            ))}
            <Menu.Item className={menuItemClass} onClick={() => project && onNewGroup(project)}>
              <IconFolder size={13} className="shrink-0 text-accent" />
              {t("layout.newGroupMenu")}
            </Menu.Item>

            {/* Avatar color — preset swatches + a custom palette picker.
                The picker opens Chromium's native palette; onChange applies
                live WITHOUT closing the menu (closing would unmount the
                input and kill the native dialog mid-pick). Dismiss with
                Escape / an outside click as usual. */}
            <div className="px-3 pb-0.5 pt-1.5 text-[9px] uppercase tracking-wide text-content-subtle">
              {t("layout.projectColor")}
            </div>
            <div className="flex flex-wrap items-center gap-1.5 px-3 py-1.5">
              {PROJECT_COLOR_SWATCHES.map((hex) => (
                <button
                  key={hex}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (project) onSetColor(project, hex);
                    onClose();
                  }}
                  title={hex}
                  className={cn(
                    "h-4 w-4 shrink-0 rounded-full transition-transform hover:scale-110",
                    customHex === hex && "ring-2 ring-accent ring-offset-1 ring-offset-surface",
                  )}
                  style={{ backgroundColor: hex }}
                  aria-label={hex}
                />
              ))}
              <label
                className={cn(
                  "relative h-4 w-4 shrink-0 cursor-pointer rounded-full transition-transform hover:scale-110",
                  customOffPalette && "ring-2 ring-accent ring-offset-1 ring-offset-surface",
                )}
                style={{
                  background:
                    "conic-gradient(from 0deg, #f87171, #fbbf24, #34d399, #38bdf8, #818cf8, #e879f9, #f87171)",
                }}
                title={t("layout.customColor")}
              >
                <input
                  type="color"
                  value={pickerHex}
                  onChange={(e) => {
                    if (project) onSetColor(project, e.target.value);
                  }}
                  className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                  aria-label={t("layout.customColor")}
                />
              </label>
            </div>
            <Menu.Item
              className={menuItemClass}
              onClick={() => {
                if (project) onSetColor(project, null);
                onClose();
              }}
            >
              {t("layout.resetColor")}
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
