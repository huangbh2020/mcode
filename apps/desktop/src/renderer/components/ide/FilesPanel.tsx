import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { EMPTY_TURN_FILES, useSessionStore, selectActiveEnvPath } from "@renderer/stores/sessionStore.js";
import type { TurnFileEntry } from "@renderer/lib/turnFiles.js";
import { FileTree } from "./FileTree.js";
import { cn } from "@renderer/lib/cn.js";
import {
  IconFolder,
  IconFolderPlus,
  IconRefresh,
  IconSearch,
  IconLayoutSidebarRight,
  IconCode,
} from "@renderer/lib/icons.js";
import { Divider } from "@renderer/components/layout/Divider.js";
import { OpenTabsBar } from "./OpenTabsBar.js";
import { useI18n } from "@renderer/lib/i18n/index.js";

const EMPTY_OPEN_FILES: string[] = [];

const FileEditor = lazy(() =>
  import("./FileEditor.js").then((m) => ({ default: m.FileEditor })),
);


/**
 * Files panel - the right-panel "Files" tab body.
 *
 * In `single` displayMode with an active file open, this panel splits into two
 * columns:
 *  - Left column: file preview/editor (Monaco FileEditor), with path and close button;
 *  - Divider: draggable handle to resize split share (fileTreeSplitPct);
 *  - Right column: the directory FileTree for navigating and switching files.
 *
 * In tabs mode or when no file is active, it renders the classic single-column
 * file navigator.
 */
export function FilesPanel() {
  const { t } = useI18n();
  const activeProjectId = useSessionStore((s) => s.activeProjectId);
  const projects = useSessionStore((s) => s.projects);
  const setSearchDialogOpen = useSessionStore((s) => s.setSearchDialogOpen);
  const displayMode = useSessionStore((s) => s.displayMode);
  const tabsFilePreviewPlacement = useSessionStore((s) => s.tabsFilePreviewPlacement);
  const toggleTabsFilePreviewPlacement = useSessionStore((s) => s.toggleTabsFilePreviewPlacement);
  const activeFile = useSessionStore((s) =>
    activeProjectId ? s.ideActiveFileByProject[activeProjectId] ?? null : null,
  );
  const openFiles = useSessionStore((s) =>
    activeProjectId ? s.ideOpenFilesByProject[activeProjectId] ?? EMPTY_OPEN_FILES : EMPTY_OPEN_FILES,
  );
  const editorMode = useSessionStore((s) => s.ideEditorMode);
  const fileTreeSplitPct = useSessionStore((s) => s.fileTreeSplitPct);

  const adjustFileTreeSplitPct = useSessionStore((s) => s.adjustFileTreeSplitPct);
  const resetFileTreeSplitPct = useSessionStore((s) => s.resetFileTreeSplitPct);

  // Bumped on refresh to remount <FileTree> and re-scan the filesystem.
  const [refreshNonce, setRefreshNonce] = useState(0);

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
    if (prev.files === undefined) return;
    if (prev.sessionId !== activeSessionId) return;
    if (turnFiles !== prev.files) setRefreshNonce((n) => n + 1);
  }, [activeSessionId, turnFiles]);

  const activeProject = useMemo(() => {
    if (!activeProjectId) return null;
    return projects.find((p) => p.id === activeProjectId) ?? null;
  }, [activeProjectId, projects]);

  const envPath = useSessionStore(selectActiveEnvPath);
  const projectPath = envPath ?? activeProject?.path ?? null;
  const projectName = activeProject?.name ?? null;

  const containerRef = useRef<HTMLDivElement>(null);
  const handleSplitResize = (deltaPx: number) => {
    const el = containerRef.current;
    if (!el) return;
    const w = el.getBoundingClientRect().width;
    if (w <= 0) return;
    adjustFileTreeSplitPct((deltaPx / w) * 100);
  };

  if (!projectPath) {
    return <EmptyState />;
  }

  const isSplitLayout = displayMode === "single" || tabsFilePreviewPlacement === "sidebar";

  // Single-column tree content
  const treeColumn = (
    <div data-files-panel="true" className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
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
        {displayMode === "tabs" && (
          <button
            type="button"
            onClick={toggleTabsFilePreviewPlacement}
            title={
              tabsFilePreviewPlacement === "center"
                ? t("ide.files.placementCenterHint")
                : t("ide.files.placementSidebarHint")
            }
            aria-label={
              tabsFilePreviewPlacement === "center"
                ? t("ide.files.placementCenterHint")
                : t("ide.files.placementSidebarHint")
            }
            className={cn(
              "flex shrink-0 items-center justify-center rounded p-0.5 transition-colors",
              tabsFilePreviewPlacement === "sidebar"
                ? "bg-accent/15 text-accent hover:bg-accent/20"
                : "text-content-subtle hover:bg-surface-hover hover:text-content",
            )}
          >
            <IconLayoutSidebarRight size={14} />
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        <FileTree key={`${projectPath}:${refreshNonce}`} projectPath={projectPath} />
      </div>
    </div>
  );

  if (!isSplitLayout) {
    return treeColumn;
  }

  return (
    <div ref={containerRef} data-files-panel="true" className="flex h-full min-h-0 w-full overflow-hidden">
      {/* Left column: File Preview / Editor (or Empty Placeholder) */}
      <div
        className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-surface"
        style={{ flexGrow: 0, flexBasis: `${fileTreeSplitPct}%` }}
      >
        {/* Header: multi-tab strip in tabs mode (when tabs exist), or compact placeholder bar when no file is open */}
        {editorMode === "tabs" && openFiles.length > 0 ? (
          <OpenTabsBar />
        ) : !activeFile ? (
          <div className="flex h-8 shrink-0 items-center border-b border-edge bg-surface-muted/30 px-2.5">
            <span className="text-[11px] font-medium text-content-subtle/70 select-none">
              {t("ide.files.editorPlaceholder")}
            </span>
          </div>
        ) : null}

        {/* Editor body: active file editor or empty placeholder */}
        {activeFile ? (
          <div className="min-h-0 flex-1 overflow-hidden">
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center gap-1.5 text-[11px] text-content-subtle">
                  {t("layout.loadingEditor")}
                </div>
              }
            >
              <FileEditor filePath={activeFile} projectPath={projectPath} />
            </Suspense>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center select-none p-6 text-center text-content-subtle">
            <IconCode size={36} className="mb-2.5 text-content-subtle/25" />
            <div className="text-xs font-medium text-content-muted">{t("ide.files.noFileOpen")}</div>
            <div className="mt-1 text-[11px] text-content-subtle/70">{t("ide.files.noFileOpenHint")}</div>
          </div>
        )}
      </div>

      {/* Resizable Divider between file preview and tree */}
      <Divider
        orientation="vertical"
        onResize={handleSplitResize}
        onDoubleClick={resetFileTreeSplitPct}
      />

      {/* Right column: File Tree */}
      <div
        className="flex min-h-0 min-w-0 flex-col overflow-hidden border-l border-edge bg-surface"
        style={{ flexGrow: 0, flexBasis: `${100 - fileTreeSplitPct}%` }}
      >
        {treeColumn}
      </div>
    </div>
  );
}




/** Empty state shown when no project is active. Points the user at the
 *  left-bar's add-project affordance. */
function EmptyState() {
  const { t } = useI18n();
  return (
    <div data-files-panel="true" className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
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
