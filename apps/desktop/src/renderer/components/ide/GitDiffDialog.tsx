import { useCallback, useEffect, useMemo, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { api } from "@renderer/lib/api.js";
import { basename, joinPath } from "@renderer/lib/path.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { Dialog } from "@renderer/components/ui/index.js";
import {
  IconX,
  IconColumns3,
  IconSquare,
  IconMaximize,
  IconMinimize,
  IconFile,
  IconLoader2,
  IconChevronDown,
  IconChevronRight,
} from "@renderer/lib/icons.js";
import { DiffPane } from "./FileEditor.js";
import type { GitFileStatus, GitStatusResult } from "@contracts/ipc";

/**
 * Git diff dialog - the "dialog" open-mode for viewing git file diffs.
 *
 * A floating modal that hosts one or more read-only Monaco diff tabs. Each tab
 * is a `{ before, after? }` snapshot stashed by the Git panel (working-tree
 * click) or the history view (commit file click). Re-clicking the same file
 * refreshes its tab instead of duplicating it.
 *
 * Layout: a left sidebar mirrors the Git panel's **已暂存 / 更改** file lists
 * for the active tab's repo (navigation only — no close / delete). The right
 * column shows the active diff. A header toggle switches between "tabs" mode
 * (top tab strip + sidebar) and "single" mode (sidebar only, no tab strip).
 *
 * Closing the dialog (backdrop / Esc / close button) keeps the tabs alive in
 * the store; the Git panel toolbar shows a re-open button while any tab
 * remains. The actual diff rendering is delegated to {@link DiffPane} so the
 * Monaco dispose-order race handling stays in one place.
 *
 * Rendered once at the App level (portaled to <body>); it renders nothing when
 * closed or when there are no tabs.
 */
export function GitDiffDialog() {
  const open = useSessionStore((s) => s.gitDiffDialogOpen);
  const tabs = useSessionStore((s) => s.gitDiffDialogTabs);
  const activeId = useSessionStore((s) => s.gitDiffDialogActiveId);
  const viewMode = useSessionStore((s) => s.gitDiffDialogViewMode);
  const setOpen = useSessionStore((s) => s.setGitDiffDialogOpen);
  const closeTab = useSessionStore((s) => s.closeGitDiffDialogTab);
  const setActive = useSessionStore((s) => s.setGitDiffDialogActive);
  const setViewMode = useSessionStore((s) => s.setGitDiffDialogViewMode);
  const openGitDiffDialogTab = useSessionStore((s) => s.openGitDiffDialogTab);

  // The active tab to render. Falls back to the first tab if the stored active
  // id no longer matches any tab (defensive - should not normally happen).
  const activeTab = tabs.find((t) => t.id === activeId) ?? tabs[0] ?? null;
  const isTabsMode = viewMode === "tabs";

  // Repo whose working-tree status drives the left sidebar. Prefer the active
  // tab's repo; fall back to the first open tab.
  const sidebarRepoPath = activeTab?.repoPath ?? tabs[0]?.repoPath ?? null;

  const [status, setStatus] = useState<GitStatusResult | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  // Fullscreen is a transient view toggle — resets each time the dialog opens.
  const [fullscreen, setFullscreen] = useState(false);

  const refreshStatus = useCallback(async (repoPath: string) => {
    setStatusLoading(true);
    try {
      const { status: next } = await api.git.status({ repoPath });
      setStatus(next);
    } catch {
      setStatus(null);
    } finally {
      setStatusLoading(false);
    }
  }, []);

  // Reload staged/changes whenever the dialog opens or the active repo changes.
  useEffect(() => {
    if (!open || !sidebarRepoPath) {
      setStatus(null);
      return;
    }
    void refreshStatus(sidebarRepoPath);
  }, [open, sidebarRepoPath, refreshStatus]);

  const staged = useMemo(
    () => status?.files.filter((f) => f.index !== "unmodified" && f.index !== "untracked") ?? [],
    [status],
  );
  const unstaged = useMemo(
    () =>
      status?.files.filter((f) => f.workingTree !== "unmodified" || f.index === "untracked") ?? [],
    [status],
  );

  /** Open (or activate) a working-tree file's diff from the left sidebar. */
  const openWorkingFile = useCallback(
    async (file: GitFileStatus, stagedSide: boolean) => {
      if (!sidebarRepoPath) return;
      const absPath = joinPath(sidebarRepoPath, file.path);
      const tabId = `${absPath}::${stagedSide ? "staged" : "work"}`;

      // If the tab is already open, just activate it (content was snapshot at
      // open time; re-clicking the Git panel row refreshes — sidebar navigate
      // prefers snappy switch).
      const existing = useSessionStore.getState().gitDiffDialogTabs.find((t) => t.id === tabId);
      if (existing) {
        setActive(tabId);
        return;
      }

      let before = "";
      let after: string | undefined;
      try {
        const { patch } = await api.git.diff({
          repoPath: sidebarRepoPath,
          filePath: file.path,
          staged: stagedSide,
        });
        if (patch) {
          const parsed = parsePatchToBeforeAfter(patch);
          before = parsed.before;
          after = parsed.after;
        }
      } catch {
        // fall through with empty before
      }

      openGitDiffDialogTab({
        id: tabId,
        filePath: absPath,
        before,
        after: stagedSide ? (after ?? "") : after,
        title: basename(file.path),
        repoPath: sidebarRepoPath,
        source: "working",
        staged: stagedSide,
      });
    },
    [sidebarRepoPath, setActive, openGitDiffDialogTab],
  );

  return (
    <Dialog.Root open={open && tabs.length > 0} onOpenChange={(o) => setOpen(o)}>
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Popup
          className={cn(
            "flex flex-col p-0",
            fullscreen
              ? "left-0 top-10 h-[calc(100vh-2.5rem)] w-screen max-w-none translate-x-0 translate-y-0 rounded-none"
              : "h-[85vh] max-h-[900px] w-[90vw] max-w-[1400px]",
          )}
        >
          {/* Header: title + view-mode toggle (left) ... close (right) */}
          <div className="flex shrink-0 items-center justify-between border-b border-edge px-4 py-2.5">
            <div className="flex items-center gap-2">
              <Dialog.Title className="text-sm font-semibold text-content">查看差异</Dialog.Title>
              {/* View-mode toggle: tabs (tab strip + sidebar) vs single (sidebar only). */}
              <button
                type="button"
                onClick={() => setViewMode(isTabsMode ? "single" : "tabs")}
                title={isTabsMode ? "切换为单标签模式" : "切换为标签模式"}
                aria-label={isTabsMode ? "切换为单标签模式" : "切换为标签模式"}
                className={cn(
                  "flex items-center justify-center rounded p-1 transition-colors",
                  "text-content-subtle hover:bg-surface-hover hover:text-content",
                )}
              >
                {isTabsMode ? <IconSquare size={15} /> : <IconColumns3 size={15} />}
              </button>
              {/* Fullscreen toggle — expand the dialog to fill the work area. */}
              <button
                type="button"
                onClick={() => setFullscreen((v) => !v)}
                title={fullscreen ? "退出全屏" : "全屏显示"}
                aria-label={fullscreen ? "退出全屏" : "全屏显示"}
                className={cn(
                  "flex items-center justify-center rounded p-1 transition-colors",
                  "text-content-subtle hover:bg-surface-hover hover:text-content",
                )}
              >
                {fullscreen ? <IconMinimize size={15} /> : <IconMaximize size={15} />}
              </button>
            </div>
            <Dialog.Close />
          </div>

          {/* Body: left file-list sidebar + right diff column */}
          <div className="flex min-h-0 flex-1">
            {/* Left sidebar — mirrors Git panel 已暂存 / 更改. Navigation only;
                no close / delete controls. */}
            <div className="flex w-[220px] shrink-0 flex-col overflow-y-auto border-r border-edge bg-surface-muted/50 py-1.5">
              {!sidebarRepoPath ? (
                <div className="px-2.5 py-2 text-[11px] text-content-subtle">无仓库</div>
              ) : statusLoading && !status ? (
                <div className="flex items-center gap-1.5 px-2.5 py-2 text-[11px] text-content-subtle">
                  <IconLoader2 size={12} className="animate-spin" />
                  读取状态…
                </div>
              ) : staged.length === 0 && unstaged.length === 0 ? (
                <div className="px-2.5 py-2 text-[11px] text-content-subtle">
                  {activeTab?.source === "history"
                    ? "工作区干净（当前为历史提交差异）"
                    : "工作区干净"}
                </div>
              ) : (
                <>
                  {staged.length > 0 && (
                    <SidebarFileGroup
                      label="已暂存"
                      files={staged}
                      staged
                      activeTabId={activeTab?.id ?? null}
                      repoPath={sidebarRepoPath}
                      onSelect={(f) => void openWorkingFile(f, true)}
                    />
                  )}
                  {unstaged.length > 0 && (
                    <SidebarFileGroup
                      label="更改"
                      files={unstaged}
                      staged={false}
                      activeTabId={activeTab?.id ?? null}
                      repoPath={sidebarRepoPath}
                      onSelect={(f) => void openWorkingFile(f, false)}
                    />
                  )}
                </>
              )}
            </div>

            {/* Right column: optional tab strip + diff content */}
            <div className="flex min-w-0 flex-1 flex-col">
              {/* Tab strip - only in "tabs" mode. Hand-rolled, mirrors
                  SessionTabs' border-b-2 accent active style. Horizontally
                  scrollable when many tabs are open. */}
              {isTabsMode && (
                <div className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-edge bg-surface/40 px-2 pt-1.5">
                  {tabs.map((tab) => {
                    const isActive = tab.id === (activeTab?.id ?? activeId);
                    return (
                      <div
                        key={tab.id}
                        role="tab"
                        aria-selected={isActive}
                        onClick={() => setActive(tab.id)}
                        className={cn(
                          "group flex max-w-[220px] min-w-0 shrink-0 cursor-pointer select-none items-center gap-1.5 rounded-t-md border-b-2 px-2.5 py-1.5 text-[11px] transition-colors",
                          isActive
                            ? "border-accent bg-surface text-content"
                            : "border-transparent text-content-muted hover:bg-surface-muted/50 hover:text-content",
                        )}
                        title={tab.filePath}
                      >
                        <span className="truncate font-mono">
                          {tab.title}
                          {tab.source === "working" && tab.staged ? (
                            <span className="ml-1 text-content-subtle">·暂存</span>
                          ) : null}
                        </span>
                        <button
                          type="button"
                          aria-label="关闭标签"
                          onClick={(e) => {
                            e.stopPropagation();
                            closeTab(tab.id);
                          }}
                          onPointerDown={(e) => e.stopPropagation()}
                          className={cn(
                            "ml-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-content-subtle transition-opacity hover:bg-surface-hover hover:text-content",
                            isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                          )}
                        >
                          <IconX size={11} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Diff content - remounts per active tab via key so Monaco models
                  don't leak across files. DiffPane owns its own dispose ordering. */}
              <div className="min-h-0 flex-1">
                {activeTab ? (
                  <DiffPane
                    key={activeTab.id}
                    filePath={activeTab.filePath}
                    before={activeTab.before}
                    after={activeTab.after}
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-[11px] text-content-subtle">
                    无可显示的差异
                  </div>
                )}
              </div>
            </div>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* ───────────────────────── left sidebar groups ───────────────────────── */

function SidebarFileGroup({
  label,
  files,
  staged,
  activeTabId,
  repoPath,
  onSelect,
}: {
  label: string;
  files: GitFileStatus[];
  staged: boolean;
  activeTabId: string | null;
  repoPath: string;
  onSelect: (file: GitFileStatus) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div className="mb-1">
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className="flex w-full items-center gap-1 px-2.5 py-1 text-[10px] font-medium uppercase tracking-wide text-content-subtle"
      >
        {collapsed ? <IconChevronRight size={10} /> : <IconChevronDown size={10} />}
        {label} ({files.length})
      </button>
      {!collapsed && (
        <div>
          {files.map((f) => {
            const absPath = joinPath(repoPath, f.path);
            const tabId = `${absPath}::${staged ? "staged" : "work"}`;
            const isActive = activeTabId === tabId;
            const code = staged ? f.index : f.workingTree;
            return (
              <SidebarFileItem
                key={`${staged ? "s" : "u"}:${f.path}`}
                file={f}
                code={code}
                isActive={isActive}
                onSelect={() => onSelect(f)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

/** One row in the left file-list sidebar. Shows status letter + basename;
 *  active row is highlighted with the accent left bar. No close / delete. */
function SidebarFileItem({
  file,
  code,
  isActive,
  onSelect,
}: {
  file: GitFileStatus;
  code: GitFileStatus["index"];
  isActive: boolean;
  onSelect: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      title={file.path}
      className={cn(
        "group relative flex cursor-pointer select-none items-center gap-1.5 px-2.5 py-1.5 text-[11px] transition-colors",
        isActive
          ? "bg-surface-hover text-content"
          : "text-content-muted hover:bg-surface-hover/50 hover:text-content",
      )}
    >
      {isActive && (
        <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-accent" />
      )}
      <StatusCodeIcon code={code} />
      <IconFile size={13} className="shrink-0 text-content-subtle" />
      <span className="min-w-0 flex-1 truncate font-mono">{basename(file.path)}</span>
    </div>
  );
}

function StatusCodeIcon({ code }: { code: GitFileStatus["index"] }) {
  const label =
    code === "modified"
      ? "M"
      : code === "added"
        ? "A"
        : code === "deleted"
          ? "D"
          : code === "untracked"
            ? "?"
            : code === "renamed"
              ? "R"
              : code === "copied"
                ? "C"
                : "·";
  const color =
    code === "added" || code === "untracked"
      ? "text-accent"
      : code === "modified" || code === "renamed" || code === "copied"
        ? "text-warning"
        : code === "deleted"
          ? "text-danger"
          : "text-content-subtle";
  return (
    <span
      className={cn(
        "w-3 shrink-0 text-center font-mono text-[10px] font-bold",
        color,
      )}
      title={code}
    >
      {label}
    </span>
  );
}

/* ───────────────────────── patch parser ───────────────────────── */

/** Parse a unified diff patch into before/after text for line-based diffing. */
function parsePatchToBeforeAfter(patch: string): { before: string; after: string } {
  const beforeLines: string[] = [];
  const afterLines: string[] = [];
  const lines = patch.split("\n");
  let inHunk = false;
  for (const line of lines) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) {
      afterLines.push(line.slice(1));
    } else if (line.startsWith("-")) {
      beforeLines.push(line.slice(1));
    } else if (line.startsWith(" ")) {
      beforeLines.push(line.slice(1));
      afterLines.push(line.slice(1));
    } else if (line === "") {
      beforeLines.push("");
      afterLines.push("");
    }
  }
  return { before: beforeLines.join("\n"), after: afterLines.join("\n") };
}
