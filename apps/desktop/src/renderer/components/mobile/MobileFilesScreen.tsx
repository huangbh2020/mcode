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
import { Markdown } from "@renderer/components/chat/Markdown.js";
import type { FileTreeEntry } from "@contracts/ipc";
import { IconFolder, IconFolderOpen, IconFile, IconChevronRight, IconArrowUp, IconLoader2, IconPhoto } from "@renderer/lib/icons.js";

/** File extension → shiki language id for the fenced-code renderer. */
const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  json: "json", md: "markdown", py: "python", go: "go", rs: "rust", java: "java", c: "c",
  h: "c", cpp: "cpp", hpp: "cpp", cs: "csharp", rb: "ruby", php: "php", sh: "bash",
  bash: "bash", yml: "yaml", yaml: "yaml", toml: "toml", html: "html", htm: "html",
  css: "css", scss: "scss", sql: "sql", xml: "xml", svg: "xml", vue: "vue", kt: "kotlin",
  swift: "swift", dockerfile: "docker", env: "ini", ini: "ini", txt: "text", log: "text",
};

/** Image extensions rendered inline via the binary-read path. */
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"]);

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  if (i <= 0) return "";
  return name.slice(i + 1).toLowerCase();
}

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

      {openFile && <FileViewer file={openFile} onClose={() => setOpenFile(null)} />}
    </ScreenShell>
  );
}

/** Full-screen read-only file viewer: images render inline; text files render
 *  through the shared Markdown fenced-code path (shiki highlighting). */
function FileViewer({ file, onClose }: { file: { name: string; path: string }; onClose: () => void }) {
  const [content, setContent] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const ext = extOf(file.name);

  useEffect(() => {
    let cancelled = false;
    setContent(null);
    setImageUrl(null);
    setFailed(false);
    if (IMAGE_EXT.has(ext)) {
      void api.file
        .readBinary({ filePath: file.path })
        .then((res) => {
          if (cancelled) return;
          if (res.dataUrl) setImageUrl(res.dataUrl);
          else setFailed(true);
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        });
    } else {
      void api.file
        .readFile({ filePath: file.path })
        .then((res) => {
          if (cancelled) return;
          // Empty content can be a legitimately empty file OR a binary/refused
          // read — both degrade to the same "no content" hint.
          setContent(res.content ?? "");
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [file.path, ext]);

  const lang = LANG_BY_EXT[ext] ?? "text";
  const markdown = content === null ? "" : `\`\`\`${lang}\n${content}\n\`\`\``;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-surface">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-edge px-2">
        <button
          type="button"
          onClick={onClose}
          className="flex h-8 items-center gap-1 rounded-lg px-2 text-xs text-content-muted hover:bg-surface-muted"
        >
          <IconArrowUp size={14} className="rotate-[-90deg]" />
          返回
        </button>
        <div className="min-w-0 flex-1 truncate text-center font-mono text-xs text-content">
          {file.name}
        </div>
        <span className="w-12" />
      </div>
      {imageUrl ? (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-black/30 p-4">
          <img src={imageUrl} alt={file.name} className="max-h-full max-w-full object-contain" />
        </div>
      ) : failed ? (
        <div className="flex flex-1 items-center justify-center gap-1.5 text-xs text-content-subtle">
          <IconPhoto size={14} /> 无法预览此文件
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
          <Markdown>{markdown}</Markdown>
        </div>
      )}
    </div>
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
