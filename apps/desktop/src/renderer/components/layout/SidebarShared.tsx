/**
 * Shared pieces between the two left-bar views (classic tree `LeftBar` and
 * session-first `StreamSidebar`): the rename dialog, the session context
 * menu (with its optional worktree action group), and the hover-revealed
 * icon button. Extracted verbatim from LeftBar.tsx when the second view
 * arrived — both views must keep row actions identical, so they live in
 * exactly one place.
 *
 * The worktree group (合并回 / 重命名 / 移除) renders only for rows bound
 * to an isolated checkout AND when the host supplies the callback — the
 * tree view wires them to its bar-level dialogs, the stream view to its
 * own; entries the host omits simply don't render.
 */
import { useEffect, useState } from "react";
import { Menu } from "@base-ui/react/menu";
import {
  IconCopy,
  IconFolder,
  IconGitFork,
  IconGitMerge,
  IconPencil,
  IconPin,
  IconPinnedFilled,
  IconTrash,
} from "@renderer/lib/icons.js";
import { cn } from "@renderer/lib/cn.js";
import { Button, Dialog, Input } from "@renderer/components/ui/index.js";
import { useCursorAnchor } from "@renderer/hooks/useCursorAnchor.js";
import type { Session } from "@contracts/session";
import { useI18n } from "@renderer/lib/i18n/index.js";

/* ── Hover-revealed inline icon button (archive / delete) ── */

export function HoverIconButton({
  onClick, title, danger, className, children,
}: {
  onClick: () => void;
  title: string;
  danger?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className={cn(
        "flex shrink-0 items-center rounded px-1 text-content-subtle opacity-0 transition-colors",
        "hover:bg-surface-hover group-hover:opacity-100",
        danger ? "hover:text-danger" : "hover:text-content",
        className,
      )}
      title={title}
    >
      {children}
    </button>
  );
}

/* ── Session right-click context menu ── */

export interface SessionContextMenuProps {
  ctxMenu: { session: Session; x: number; y: number } | null;
  onClose: () => void;
  onRename: (session: Session) => void;
  onCopyTitle: (session: Session) => void;
  onOpenFolder: (session: Session) => void;
  onTogglePin: (session: Session) => void;
  /** "New session in this worktree" — present only for materialized
   *  worktree sessions; spawns a sibling thread on the same checkout. */
  onNewWorktreeSession?: (session: Session) => void;
  /** Worktree action group (worktree-bound rows only, each entry gated on
   *  its callback): merge the directory back, rename its display name,
   *  remove it (guarded confirm). Hosts without a worktree row context
   *  (e.g. rows inside a tree-view worktree group, whose header already
   *  carries these) pass nothing and see none of them. */
  onMergeWorktree?: (session: Session) => void;
  onRenameWorktree?: (session: Session) => void;
  onRemoveWorktree?: (session: Session) => void;
}

export function SessionContextMenu({
  ctxMenu, onClose, onRename, onCopyTitle, onOpenFolder, onTogglePin,
  onNewWorktreeSession, onMergeWorktree, onRenameWorktree, onRemoveWorktree,
}: SessionContextMenuProps) {
  const { t } = useI18n();
  // Virtual anchor pinned to the cursor coords so the popup opens where the
  // user right-clicked; frozen at the last coords during the exit transition.
  const anchor = useCursorAnchor(ctxMenu);

  const session = ctxMenu?.session;
  const isPinned = !!session?.pinnedAt;
  const isWorktree = !!session?.worktreePath;
  const itemClass = cn(
    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs outline-none select-none",
    "text-content-muted data-[highlighted]:bg-surface-muted",
  );

  return (
    <Menu.Root open={!!ctxMenu} onOpenChange={(open) => { if (!open) onClose(); }}>
      <Menu.Portal>
        <Menu.Positioner anchor={anchor} side="bottom" align="start">
          <Menu.Popup
            className={cn(
              "z-50 min-w-[180px] origin-top-left rounded-md border border-edge bg-surface py-1 shadow-2xl",
              "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
              "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
              "transition-[transform,opacity] duration-100",
            )}
          >
            <Menu.Item
              onClick={() => session && onTogglePin(session)}
              className={itemClass}
            >
              {isPinned ? (
                <IconPinnedFilled size={14} className="shrink-0 text-accent" />
              ) : (
                <IconPin size={14} className="shrink-0" />
              )}
              {isPinned ? t("layout.unpin") : t("layout.pin")}
            </Menu.Item>
            <Menu.Item
              onClick={() => session && onRename(session)}
              className={itemClass}
            >
              <IconPencil size={14} className="shrink-0" />
              {t("common.rename")}
            </Menu.Item>
            <Menu.Item
              onClick={() => session && onCopyTitle(session)}
              className={itemClass}
            >
              <IconCopy size={14} className="shrink-0" />
              {t("layout.copySessionTitle")}
            </Menu.Item>
            {session?.worktreePath && onNewWorktreeSession && (
              <Menu.Item
                onClick={() => onNewWorktreeSession(session)}
                className={itemClass}
              >
                <IconGitFork size={14} className="shrink-0" />
                {t("layout.newSessionInWorktree")}
              </Menu.Item>
            )}
            {/* Worktree action group — stream-view rows carry the checkout's
                identity inline, so the directory-level actions live on the
                row's menu (the tree view keeps them on the group header). */}
            {isWorktree && onMergeWorktree && (
              <Menu.Item
                onClick={() => session && onMergeWorktree(session)}
                className={itemClass}
              >
                <IconGitMerge size={14} className="shrink-0" />
                {t("layout.mergeWorktreeBack")}
              </Menu.Item>
            )}
            {isWorktree && onRenameWorktree && (
              <Menu.Item
                onClick={() => session && onRenameWorktree(session)}
                className={itemClass}
              >
                <IconPencil size={14} className="shrink-0" />
                {t("layout.renameWorktree")}
              </Menu.Item>
            )}
            {isWorktree && onRemoveWorktree && (
              <Menu.Item
                onClick={() => session && onRemoveWorktree(session)}
                className={cn(itemClass, "text-danger")}
              >
                <IconTrash size={14} className="shrink-0" />
                {t("chat.worktree.removeWt")}
              </Menu.Item>
            )}
            <Menu.Item
              onClick={() => session && onOpenFolder(session)}
              className={itemClass}
            >
              <IconFolder size={14} className="shrink-0" />
              {t("layout.openInFileManager")}
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/* ── Archived row (restore + hard-delete actions inline) ──
 * Renders inside the tree view's archived bin and the stream view's shelf
 * alike; root <li> works in both (the stream shelf wraps rows in a <ul>). */

export function ArchivedRow({
  icon, title, subtitle, onRestore, onDelete,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  return (
    <li
      className={cn(
        "flex items-center gap-1 rounded px-1 py-1 text-content-subtle [font-size:var(--right-panel-font-size)]",
        "hover:bg-surface-hover/60",
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">
        {title}
        {subtitle && (
          <span className="ml-1 text-content-subtle/70 [font-size:var(--rp-fs-sm)]">
            · {subtitle}
          </span>
        )}
      </span>
      <button
        onClick={(e) => { e.stopPropagation(); onRestore(); }}
        className={cn(
          "shrink-0 rounded px-1 text-content-subtle transition-colors [font-size:var(--rp-fs-sm)]",
          "hover:text-accent",
        )}
        title={t("layout.restoreToList")}
      >
        {t("layout.restore")}
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        className={cn(
          "shrink-0 rounded px-1 text-content-subtle transition-colors [font-size:var(--rp-fs-sm)]",
          "hover:text-danger",
        )}
        title={t("layout.deleteForever")}
      >
        {t("layout.deleteShort")}
      </button>
    </li>
  );
}

/* ── Rename dialog ── */

/** The rename target's kind drives the dialog copy and the dispatch target;
 *  ids are unique across tables so `id` alone disambiguates on submit —
 *  except kind "worktree", where `id` carries the RAW worktree path, and
 *  kind "group", where `id` carries the projectId being assigned to the new
 *  group (title is pre-filled empty; submit dispatches setProjectGroup). */
export type RenameTarget =
  | { id: string; title: string; kind: "session" | "project" | "worktree" | "group" };

interface RenameDialogProps {
  renaming: RenameTarget | null;
  onClose: () => void;
  onSubmit: (id: string, title: string, kind: "session" | "project" | "worktree" | "group") => Promise<void>;
}

export function RenameDialog({ renaming, onClose, onSubmit }: RenameDialogProps) {
  const { t } = useI18n();
  const [value, setValue] = useState("");

  // Seed the input whenever a new rename target is set.
  useEffect(() => {
    if (renaming) setValue(renaming.title);
  }, [renaming]);

  const trimmed = value.trim();
  const submit = () => {
    if (!renaming || !trimmed) return;
    void onSubmit(renaming.id, trimmed, renaming.kind);
  };

  const copy =
    renaming?.kind === "project"
      ? {
          title: t("layout.renameProject"),
          desc: t("layout.renameProjectDesc"),
          placeholder: t("layout.projectNamePlaceholder"),
        }
      : renaming?.kind === "worktree"
        ? {
            title: t("layout.renameWorktree"),
            desc: t("layout.renameWorktreeDesc"),
            placeholder: t("layout.worktreeNamePlaceholder"),
          }
        : renaming?.kind === "group"
          ? {
              title: t("layout.newGroup"),
              desc: t("layout.newGroupDesc"),
              placeholder: t("layout.groupNamePlaceholder"),
            }
          : {
              title: t("layout.renameThread"),
              desc: t("layout.renameThreadDesc"),
              placeholder: t("layout.threadTitlePlaceholder"),
            };

  return (
    <Dialog.Root open={!!renaming} onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Popup className="w-[420px] max-w-[90vw] p-4">
          <Dialog.Title>{copy.title}</Dialog.Title>
          <Dialog.Description className="mt-1">{copy.desc}</Dialog.Description>

          <div className="mt-4">
            <Input
              value={value}
              autoFocus
              placeholder={copy.placeholder}
              onChange={(e) => setValue((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); submit(); }
                if (e.key === "Escape") { e.preventDefault(); onClose(); }
              }}
              onFocus={(e) => (e.target as HTMLInputElement).select()}
            />
          </div>

          <div className="mt-4 flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" size="sm" onClick={submit} disabled={!trimmed}>
              {t("common.save")}
            </Button>
          </div>
          <Dialog.Close />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
