import { useRef, useState } from "react";
import { Menu } from "@base-ui/react/menu";
import { cn } from "@renderer/lib/cn.js";
import { IconCheck, IconChevronDown, IconDots } from "@renderer/lib/icons.js";
import { projectDisplayColor, projectInitial } from "@renderer/lib/projectAvatar.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useSuppressBrowserView } from "@renderer/hooks/useSuppressBrowserView.js";
import { useCursorAnchor } from "@renderer/hooks/useCursorAnchor.js";
import { RenameDialog, type RenameTarget } from "@renderer/components/layout/SidebarShared.js";
import { ProjectManageMenuPopup, type ManageMenuState } from "@renderer/components/layout/ProjectManageMenu.js";
import type { Project } from "@contracts/session";
import { useI18n } from "@renderer/lib/i18n/index.js";

/**
 * The composer's directory switcher — sits on the same quiet row as
 * WorktreeModeChip, LEFT of it (directory first, then environment). Shown
 * only in the NEW-SESSION stage for a LOCAL session: once the thread has
 * started, or runs in a worktree (worktreePath / env intent), the directory
 * is fixed and the chip disappears.
 *
 * Left-clicking a project re-aims the fresh session there (store's
 * moveSession; main side re-checks freshness, so a race with a first send
 * keeps the session where it was). The ⋯ icon revealed by hovering a row's
 * right edge opens the PROJECT MANAGE menu — rename / group membership
 * (leave, join known groups, create new) / avatar color — so the panel
 * doubles as a light project manager without a trip to the tree view.
 * (base-ui's event handling for right-clicks inside Menu.Item is
 * unreliable, hence an icon, not a context menu.)
 *
 * Hidden entirely when there's only one candidate project — nothing to
 * switch to (and the tree view already manages that lone project).
 */
export function SessionDirectoryChip({ sessionId }: { sessionId: string | null }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  // manageMenu is declared further down (before the early return); a ref
  // mirror here would trip TDZ — the suppression hook call sits next to it.
  const projects = useSessionStore((s) => s.projects);
  const projectColors = useSessionStore((s) => s.projectColors);
  const moveSession = useSessionStore((s) => s.moveSession);
  const activeProjectId = useSessionStore((s) => s.activeProjectId);
  const setProjectGroup = useSessionStore((s) => s.setProjectGroup);
  const renameProject = useSessionStore((s) => s.renameProject);
  const setProjectColor = useSessionStore((s) => s.setProjectColor);

  // This pane's session row (reference-stable selector, same shape as
  // WorktreeModeChip's).
  const session = useSessionStore((s) => {
    if (!sessionId) return undefined;
    if (s.activeSessionId === sessionId) {
      return s.sessions.find((x) => x.id === sessionId);
    }
    for (const list of Object.values(s.sessionsByProject)) {
      const hit = list?.find((x) => x.id === sessionId);
      if (hit) return hit;
    }
    return undefined;
  });

  // New-session stage + local environment only — worktree-bound or
  // worktree-intent sessions have their directory decided by the checkout.
  // Freshness requires the ROW to exist: a non-null sessionId whose row the
  // selector can't find is a side chat (side sessions live outside the main
  // list buckets) — its directory is bound to the parent, so no switcher.
  // (The old `!session ||` read the miss as "fresh" and rendered a switcher
  // whose rows were dead clicks inside the side-chat panel.)
  const isFresh = session != null && session.title === "New session";
  const isLocal = session ? !session.worktreePath && session.envMode !== "worktree" : true;
  const candidates = projects.filter((p) => !p.archived);
  const current = session
    ? candidates.find((p) => p.id === session.projectId)
    : candidates.find((p) => p.id === activeProjectId);

  // Known group names across non-archived projects (group picker in the
  // manage menu).
  const knownGroups: string[] = [];
  for (const p of candidates) if (p.group && !knownGroups.includes(p.group)) knownGroups.push(p.group);

  // ── Manage menu (⋯ icon on a project row) + its dialogs. ──
  const [manageMenu, setManageMenu] = useState<ManageMenuState | null>(null);
  const [renaming, setRenaming] = useState<RenameTarget | null>(null);
  // The manage menu closes the switcher before opening, so it must keep the
  // suppression alive on its own — with no popup ref it suppresses everywhere.
  useSuppressBrowserView(open || manageMenu !== null, popupRef);
  const manageAnchor = useCursorAnchor(manageMenu);
  const managed = manageMenu?.project ?? null;

  // Open the manage menu anchored at the trigger icon. Closing the
  // switcher popup first keeps a single menu on screen.
  const openManage = (p: Project, e: React.MouseEvent) => {
    e.stopPropagation();
    setOpen(false);
    setManageMenu({ project: p, x: e.clientX, y: e.clientY });
  };

  const menuItemClass = cn(
    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs outline-none select-none",
    "text-content-muted data-[highlighted]:bg-surface-muted",
  );

  // NOTE: every hook stays ABOVE this early return (same rule as
  // WorktreeModeChip) — no hooks after it.
  if (!isFresh || !isLocal || candidates.length < 2 || !current) {
    return (
      <>
        <ProjectManageMenuPopup
          manageMenu={manageMenu}
          anchor={manageAnchor}
          knownGroups={knownGroups}
          projectColors={projectColors}
          onClose={() => setManageMenu(null)}
          onRename={(p) => setRenaming({ id: p.id, title: p.name, kind: "project" })}
          onLeaveGroup={(p) => void setProjectGroup(p.id, null)}
          onJoinGroup={(p, g) => void setProjectGroup(p.id, g)}
          onNewGroup={(p) => setRenaming({ id: p.id, title: "", kind: "group" })}
          onSetColor={(p, hex) => void setProjectColor(p.id, hex)}
          menuItemClass={menuItemClass}
        />
        <RenameDialogHost
          renaming={renaming}
          onClose={() => setRenaming(null)}
          onProjectRename={(id, name) => void renameProject(id, name)}
          onGroupAssign={(projectId, group) => void setProjectGroup(projectId, group)}
        />
      </>
    );
  }

  return (
    <>
      <span className="inline-flex items-center">
        <Menu.Root open={open} onOpenChange={setOpen}>
          <Menu.Trigger
            className={cn(
              "inline-flex max-w-[220px] select-none items-center gap-1.5 rounded-md px-2 py-1 text-xs outline-none transition-colors duration-100",
              "text-content-muted hover:bg-surface-hover hover:text-content",
            )}
            title={t("chat.directory.chipTitle")}
          >
            <span
              className="flex h-3 w-3 shrink-0 items-center justify-center rounded-[3px] text-[7px] font-bold text-white"
              style={{ backgroundColor: projectDisplayColor(current, projectColors) }}
              aria-hidden
            >
              {projectInitial(current.name)}
            </span>
            <span className="truncate font-medium">{current.name}</span>
            <IconChevronDown size={12} className="shrink-0 opacity-60" />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner side="top" align="start" sideOffset={4}>
              <Menu.Popup
                ref={popupRef}
                className={cn(
                  "z-50 min-w-[200px] origin-bottom-left rounded-lg border border-edge bg-surface py-1 shadow-2xl",
                  "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
                  "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
                  "transition-[transform,opacity] duration-100",
                )}
              >
                {candidates.map((p) => {
                  const active = p.id === current.id;
                  return (
                    <Menu.Item
                      key={p.id}
                      onClick={() => {
                        if (session) void moveSession(session.id, p.id);
                      }}
                      className={cn(
                        "group flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs outline-none select-none",
                        "data-[highlighted]:bg-surface-muted",
                        active ? "text-accent" : "text-content-muted",
                      )}
                      title={t("chat.directory.rowHint")}
                    >
                      <span
                        className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded text-[8px] font-bold text-white"
                        style={{ backgroundColor: projectDisplayColor(p, projectColors) }}
                        aria-hidden
                      >
                        {projectInitial(p.name)}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{p.name}</span>
                      {p.group && !active && (
                        <span className="shrink-0 text-[9px] text-content-subtle/70">{p.group}</span>
                      )}
                      {active && <IconCheck size={13} className="shrink-0" />}
                      {/* Manage affordance — always faintly visible at the
                          row's right edge, full strength on row hover (a
                          hover-only reveal proved too hard to discover).
                          stopPropagation keeps the click from activating the
                          row's switch action; base-ui never sees it. */}
                      <button
                        type="button"
                        onClick={(e) => openManage(p, e)}
                        className={cn(
                          "-mr-1 flex h-4 w-4 shrink-0 items-center justify-center rounded text-content-subtle opacity-50 transition-opacity",
                          "hover:bg-surface-hover hover:text-content group-hover:opacity-100",
                        )}
                        title={t("chat.directory.manageIconTitle")}
                      >
                        <IconDots size={12} />
                      </button>
                    </Menu.Item>
                  );
                })}
                <div className="px-3 pb-1 pt-0.5 text-[9px] text-content-subtle/60">
                  {t("chat.directory.manageHint")}
                </div>
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      </span>

      <ProjectManageMenuPopup
        manageMenu={manageMenu}
        anchor={manageAnchor}
        knownGroups={knownGroups}
        projectColors={projectColors}
        onClose={() => setManageMenu(null)}
        onRename={(p) => setRenaming({ id: p.id, title: p.name, kind: "project" })}
        onLeaveGroup={(p) => void setProjectGroup(p.id, null)}
        onJoinGroup={(p, g) => void setProjectGroup(p.id, g)}
        onNewGroup={(p) => setRenaming({ id: p.id, title: "", kind: "group" })}
        onSetColor={(p, hex) => void setProjectColor(p.id, hex)}
        menuItemClass={menuItemClass}
      />
      <RenameDialogHost
        renaming={renaming}
        onClose={() => setRenaming(null)}
        onProjectRename={(id, name) => void renameProject(id, name)}
        onGroupAssign={(projectId, group) => void setProjectGroup(projectId, group)}
      />
    </>
  );
}

/* ── Rename / new-group dialog dispatch ── */

interface RenameDialogHostProps {
  renaming: RenameTarget | null;
  onClose: () => void;
  onProjectRename: (id: string, name: string) => void;
  onGroupAssign: (projectId: string, group: string) => void;
}

function RenameDialogHost({ renaming, onClose, onProjectRename, onGroupAssign }: RenameDialogHostProps) {
  return (
    <RenameDialog
      renaming={renaming}
      onClose={onClose}
      onSubmit={async (id, title, kind) => {
        if (kind === "project") onProjectRename(id, title);
        else if (kind === "group") onGroupAssign(id, title);
        onClose();
      }}
    />
  );
}
