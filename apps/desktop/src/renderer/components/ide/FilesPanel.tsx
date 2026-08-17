import { useEffect, useMemo, useRef, useState } from "react";
import { EMPTY_TURN_FILES, useSessionStore } from "@renderer/stores/sessionStore.js";
import type { TurnFileEntry } from "@renderer/lib/turnFiles.js";
import { FileTree } from "./FileTree.js";
import { cn } from "@renderer/lib/cn.js";
import {
  IconFolder,
  IconFolderPlus,
  IconRefresh,
  IconSearch,
} from "@renderer/lib/icons.js";
import { useI18n } from "@renderer/lib/i18n/index.js";

/**
 * Files panel - the right-panel "Files" tab body.
 *
 * A pure file-tree navigator with a single search affordance: a header button
 * that opens the project-wide search dialog ({@link SearchDialog}), which
 * supports both file-name and file-content search. The search UI itself lives
 * in the modal (VS Code global-search style) so the tree gets the full panel
 * height when not searching.
 *
 * Clicking any file in the tree opens it in the CENTER pane's editor column
 * (via openFileInIde -> App.tsx), NOT here. This keeps the right panel as a
 * navigation surface and the center pane as the working surface, matching VS
 * Code's explorer/editor split.
 *
 * The tree is scoped to the active project's root path; if no project is
 * active, an empty state is shown.
 */
export function FilesPanel() {
  const { t } = useI18n();
  const activeProjectId = useSessionStore((s) => s.activeProjectId);
  const projects = useSessionStore((s) => s.projects);
  const setSearchDialogOpen = useSessionStore((s) => s.setSearchDialogOpen);

  // Bumped on refresh to remount <FileTree> and re-scan the filesystem.
  // Expanded-dir state lives in the session store, so the remount keeps the
  // current expansion while re-fetching every level (DirNode children start
  // null on a fresh mount and re-load).
  const [refreshNonce, setRefreshNonce] = useState(0);

  // Auto-refresh the tree when the agent finishes a turn that touched files.
  // The turn's Write/Edit may have CREATED files on disk that aren't in the
  // tree's cached listing yet (root entries are fetched on mount, dir children
  // only on first expand), so a remount re-scans every level. The `turn.files`
  // event fires once per turn and only when files.length > 0, so this bumps
  // the nonce at most once per turn — no refresh storm mid-stream.
  //
  // We track the last observed (sessionId, files) pair: a first observation
  // (mount, or a session switch) only seeds the tracker, and a refresh fires
  // only when the SAME active session's turnFiles reference changes — a fresh
  // turn.files payload, or the rewind that clears it. This avoids both a
  // spurious re-scan when switching sessions of the same project (a different
  // project already remounts via the projectPath key) and a missed refresh on
  // the first turn.files of a session that was empty when we started watching.
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const turnFiles = useSessionStore((s) =>
    activeSessionId ? (s.turnFilesBySession[activeSessionId] ?? EMPTY_TURN_FILES) : EMPTY_TURN_FILES,
  );
  const prevObserved = useRef<{ sessionId: string | null; files: TurnFileEntry[] | null | undefined }>({
    sessionId: null,
    files: undefined,
  });
  useEffect(() => {
    const prev = prevObserved.current;
    prevObserved.current = { sessionId: activeSessionId, files: turnFiles };
    if (prev.files === undefined) return; // first observation -> seed only
    if (prev.sessionId !== activeSessionId) return; // session switch -> seed only
    if (turnFiles !== prev.files) setRefreshNonce((n) => n + 1);
  }, [activeSessionId, turnFiles]);

  const activeProject = useMemo(() => {
    if (!activeProjectId) return null;
    return projects.find((p) => p.id === activeProjectId) ?? null;
  }, [activeProjectId, projects]);

  const projectPath = activeProject?.path ?? null;
  const projectName = activeProject?.name ?? null;

  if (!projectPath) {
    return <EmptyState />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Compact header: the active project's folder name on the left (mirrors
          the explorer header in VS Code), refresh + search buttons on the
          right. The tree gets the full panel height below. */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-edge px-2 py-1.5">
        <span
          className="flex min-w-0 flex-1 items-center gap-1 px-1 text-[12px] font-medium text-content-muted"
          title={projectPath}
        >
          <IconFolder size={13} className="shrink-0 text-content-subtle" />
          <span className="truncate">{projectName}</span>
        </span>
        <button
          type="button"
          onClick={() => setRefreshNonce((n) => n + 1)}
          title={t("ide.files.refreshDir")}
          aria-label={t("ide.files.refreshDir")}
          className={cn(
            "flex shrink-0 items-center justify-center rounded p-0.5 transition-colors",
            "text-content-subtle hover:bg-surface-hover hover:text-content",
          )}
        >
          <IconRefresh size={14} />
        </button>
        <button
          type="button"
          onClick={() => setSearchDialogOpen(true)}
          title={t("ide.files.searchFilesHint")}
          aria-label={t("ide.files.searchFiles")}
          className={cn(
            "flex shrink-0 items-center justify-center rounded p-0.5 transition-colors",
            "text-content-subtle hover:bg-surface-hover hover:text-content",
          )}
        >
          <IconSearch size={14} />
        </button>
      </div>

      {/* Body: the lazily-loaded directory tree, scoped to the active project.
          Keyed on projectPath so switching projects fully remounts (clears
          stale expanded state / cached children); refreshNonce remounts for a
          manual re-scan of the same project. */}
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        <FileTree key={`${projectPath}:${refreshNonce}`} projectPath={projectPath} />
      </div>
    </div>
  );
}

/** Empty state shown when no project is active. Points the user at the
 *  left-bar's add-project affordance. */
function EmptyState() {
  const { t } = useI18n();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-muted text-content-subtle">
        <IconFolderPlus size={20} />
      </div>
      <p className="text-xs font-medium text-content-muted">{t("ide.files.noProjectTitle")}</p>
      <p className="text-[11px] leading-relaxed text-content-subtle">
        {t("ide.files.noProjectDesc")}
      </p>
    </div>
  );
}
