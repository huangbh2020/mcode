/**
 * MobileFilesScreen — read-only project file browser for the web (phone)
 * shell.
 *
 * The desktop IDE (FileTree + Monaco + LSP) is Electron-bound; the phone gets
 * a focused read-only view instead: browse directories with a breadcrumb,
 * view text files through the shared Markdown renderer (shiki highlighting
 * via a fenced code block — zero new syntax-highlighting deps), and images
 * through the shared binary-read path. All reads go through the same guarded
 * `file:*` RPC the desktop uses, so the project-root security boundary is
 * identical.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@renderer/lib/api.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { cn } from "@renderer/lib/cn.js";
import type { FileTreeEntry } from "@contracts/ipc";
import { FileViewerOverlay } from "./FileViewer.js";
import { IconFolder, IconFolderOpen, IconFile, IconChevronRight, IconArrowUp, IconLoader2 } from "@renderer/lib/icons.js";

/** Full-screen read-only file viewer: images render inline; text files render
 *  through the shared Markdown fenced-code path (shiki highlighting). */

export function MobileFilesScreen() {
  const activeProjectId = useSessionStore((s) => s.activeProjectId);
  const projects = useSessionStore((s) => s.projects);
  const project = useMemo(
    () => projects.find((p) => p.id === activeProjectId) ?? null,
    [projects, activeProjectId],
  );

  // Breadcrumb stack of {name, path} segments, index 0 = project root.
  const [stack, setStack] = useState<Array<{ name: string; path: string }>>([]);
  const [entries, setEntries] = useState<FileTreeEntry[] | null>(null);
  const [openFile, setOpenFile] = useState<{ name: string; path: string } | null>(null);

  // Re-root the breadcrumb whenever the project changes.
  useEffect(() => {
    setStack(project ? [{ name: project.name, path: project.path }] : []);
    setOpenFile(null);
  }, [project]);

  const current = stack[stack.length - 1];

  const load = useCallback(async (dir: { name: string; path: string }) => {
    if (!project) return;
    setEntries(null);
    try {
      // listDir's `projectPath` MUST be the persisted project root (main
      // cross-checks it against ProjectRepo); the folder to list goes in
      // `dirPath`, relative to that root. Stripping the root prefix from the
      // breadcrumb's absolute dir path yields that relative segment — same
      // trick the desktop FileTree uses (loadAndCompact). Passing a subfolder
      // as `projectPath` is rejected as an unknown root, so every level below
      // the first rendered empty.
      const root = project.path;
      const dirPath = dir.path.slice(root.length).replace(/^[\\/]/, "");
      const res = await api.file.listDir({ projectPath: root, dirPath });
      setEntries(res.entries);
    } catch (err) {
      console.warn("mobile files listDir failed:", err);
      setEntries([]);
    }
  }, [project]);

  useEffect(() => {
    if (current) void load(current);
  }, [current, load]);

  const descend = (e: FileTreeEntry) => {
    if (e.isDir) {
      setStack((prev) => [...prev, { name: e.name, path: e.path }]);
      setOpenFile(null);
    } else {
      setOpenFile({ name: e.name, path: e.path });
    }
  };

  const up = () => {
    setStack((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev));
    setOpenFile(null);
  };

  if (!project) {
    return (
      <ScreenShell title="文件">
        <div className="p-6 text-center text-xs text-content-subtle">请先选择一个项目</div>
      </ScreenShell>
    );
  }

  return (
    <ScreenShell title="文件">
      {/* Breadcrumb */}
      <div className="flex min-h-0 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-edge px-2 py-1.5 text-xs [scrollbar-width:none]">
        {stack.length > 1 && (
          <button
            type="button"
            onClick={up}
            className="flex h-6 shrink-0 items-center gap-0.5 rounded px-1 text-content-muted hover:bg-surface-muted"
            title="上一级"
          >
            <IconArrowUp size={13} />
          </button>
        )}
        {stack.map((seg, i) => (
          <span key={seg.path} className="flex shrink-0 items-center gap-0.5">
            {i > 0 && <IconChevronRight size={12} className="text-content-subtle" />}
            <button
              type="button"
              onClick={() => {
                setStack((prev) => prev.slice(0, i + 1));
                setOpenFile(null);
              }}
              className={cn(
                "max-w-[9rem] truncate rounded px-1 py-0.5",
                i === stack.length - 1
                  ? "font-medium text-content"
                  : "text-content-muted hover:bg-surface-muted",
              )}
            >
              {seg.name}
            </button>
          </span>
        ))}
      </div>

      {/* Entries */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {entries === null ? (
          <div className="flex h-full items-center justify-center text-content-subtle">
            <IconLoader2 size={16} className="animate-spin" />
          </div>
        ) : entries.length === 0 ? (
          <div className="p-6 text-center text-xs text-content-subtle">空目录</div>
        ) : (
          entries.map((e) => (
            <button
              key={e.path}
              type="button"
              onClick={() => descend(e)}
              className="flex w-full items-center gap-2 border-b border-edge/60 px-3 py-2.5 text-left hover:bg-surface-muted"
            >
              {e.isDir ? (
                <IconFolder size={16} className="shrink-0 text-content-muted" />
              ) : (
                <IconFile size={16} className="shrink-0 text-content-subtle" />
              )}
              <span className="min-w-0 truncate text-xs text-content">{e.name}</span>
            </button>
          ))
        )}
      </div>

      {openFile && (
        <FileViewerOverlay name={openFile.name} path={openFile.path} onClose={() => setOpenFile(null)} />
      )}
    </ScreenShell>
  );
}

/** Shared header for the full-screen mobile utility pages (files / git). */
function ScreenShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex h-full min-w-0 min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-edge px-3">
        <span className="text-sm font-medium text-content">{title}</span>
        <span className="flex-1" />
        <span className="flex items-center gap-1 text-[10px] text-content-subtle">
          <IconFolderOpen size={12} />
          只读浏览
        </span>
      </div>
      {children}
    </div>
  );
}
